/**
 * disputes.ts
 *
 * Raising a dispute is two transactions on two contracts, and the order matters:
 *
 *   1. `escrow.open_dispute(escrow_id, initiator)`   — freezes the escrow.
 *   2. `dispute.raise(escrow_id, escrow_contract, raised_by, reason)` — tells the
 *      dispute contract about it and returns the dispute id the panel rules on.
 *
 * `escrow.open_dispute` alone leaves the escrow frozen with no dispute id, so
 * nothing can arbitrate it. The off-chain row is written before either runs
 * (there is no on-chain place to keep a `reason`), and the on-chain id is
 * attached to it afterwards — by the client through `/:id/sync`, or by the
 * indexer when it sees the `raised` event. Both write to the same row, keyed on
 * the job (see the `Dispute` model).
 *
 * Routes:
 *   POST /api/disputes              — record the dispute (intent), build open_dispute
 *   GET  /api/disputes/:id          — dispute detail
 *   POST /api/disputes/:id/raise    — build dispute.raise (either party)
 *   POST /api/disputes/:id/sync     — record the on-chain dispute id
 *   POST /api/disputes/:id/resolve  — arbitrator resolves (builds arbitrate tx)
 *
 * Authorization: `/:id/resolve` may only be called by an address listed in
 * `ARBITRATOR_ADDRESSES`. The on-chain dispute contract is still the final
 * authority (it checks panel membership inside `arbitrate`), but the route also
 * writes DB state before the transaction is confirmed, so it must not be
 * reachable by a non-arbitrator.
 *
 * The escrow contract is the authority on every precondition the chain can
 * check — that the escrow is `Disputed`, that the raiser is a party, that the
 * panel approved the split — so those failures come back from simulation, which
 * `buildTx` translates with the right contract's error map. The off-chain checks
 * here are cheap early rejections, not the security boundary.
 */

import { Router } from "express";
import { z } from "zod";
import {
  Contract,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  xdr,
} from "@stellar/stellar-sdk";
import type { Dispute, Job, User } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db";
import { buildArbitrateArgs, buildOpenDisputeArgs, buildRaiseArgs } from "../lib/scval";
import {
  DISPUTE_ERROR_MESSAGES,
  ESCROW_ERROR_MESSAGES,
  friendlyContractError,
} from "../lib/contractErrors";
import { isListed, parseList } from "../lib/access";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/errorHandler";

export const disputesRouter = Router();

const server = new SorobanRpc.Server(config.SOROBAN_RPC_URL);
const networkPassphrase =
  config.STELLAR_NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

/**
 * Build an unsigned transaction for the caller to sign.
 *
 * `messages` is the error map of the contract being called: a contract error is
 * a caller mistake (wrong state, not a party), not an internal failure, so it is
 * answered as a named 400 rather than a raw host string.
 */
// `xdr.Operation` (not `any`) is what `Contract.call(...)` returns and what
// `addOperation` accepts, so a wrong call site fails to compile (issue #54).
async function buildTx(
  sourceAddress: string,
  operation: xdr.Operation,
  messages: Record<number, string>,
): Promise<string> {
  const account = await server.getAccount(sourceAddress);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(operation)
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if ("error" in sim) throw new AppError(400, friendlyContractError(sim.error, messages));
  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}

/** A dispute row plus the parties a route has to authorize against. */
type DisputeWithParties = Dispute & { job: Job & { client: User; freelancer: User | null } };

/** Either party to the job may dispute it; nobody else may even build the tx. */
function assertParticipant(dispute: DisputeWithParties, address: string): void {
  const { client, freelancer } = dispute.job;
  if (client.stellarAddress !== address && freelancer?.stellarAddress !== address) {
    throw new AppError(403, "Not a participant of this job");
  }
}

/** Load a dispute with its parties, or fail with a 404. */
async function loadDispute(id: string): Promise<DisputeWithParties> {
  const dispute = await prisma.dispute.findUnique({
    where: { id },
    include: { job: { include: { client: true, freelancer: true } } },
  });
  if (!dispute) throw new AppError(404, "Dispute not found");
  return dispute;
}

// POST /api/disputes
//
// Records the dispute and returns the `escrow.open_dispute` transaction. The row
// is written first and without an on-chain id — it is the only place the reason
// is kept (`Raised` carries no reason), and it is what `handleRaised` and
// `/:id/sync` attach the on-chain id to later.
//
// Idempotent per job: both parties can reach this route and only one row may
// exist (the contract refuses a second `raise` for the same escrow), so the
// first caller's reason wins and the second call is a no-op that returns the
// same dispute.
const raiseSchema = z.object({
  jobId: z.string(),
  reason: z.string().min(10).max(1000),
});

disputesRouter.post("/", requireAuth, validate(raiseSchema), async (req, res, next) => {
  try {
    const { jobId, reason } = req.body as z.infer<typeof raiseSchema>;

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: { client: true, freelancer: true },
    });
    if (!job) throw new AppError(404, "Job not found");
    if (!job.escrowId) throw new AppError(400, "Job has no on-chain escrow yet");

    const addr = res.locals.stellarAddress;
    const isParticipant =
      job.client.stellarAddress === addr || job.freelancer?.stellarAddress === addr;
    if (!isParticipant) throw new AppError(403, "Not a participant of this job");

    // Build escrow.open_dispute tx for the client to sign. The frontend builds
    // its own (it holds the wallet), but API-first consumers need it here.
    const escrowContract = new Contract(config.ESCROW_CONTRACT_ID);
    const xdr = await buildTx(
      addr,
      escrowContract.call("open_dispute", ...buildOpenDisputeArgs(job.escrowId, addr)),
      ESCROW_ERROR_MESSAGES,
    );

    // Persist dispute record
    const dispute = await prisma.dispute.upsert({
      where: { jobId },
      create: { jobId, raisedByAddress: addr, reason },
      update: {},
    });

    res.status(201).json({ dispute, xdr });
  } catch (err) {
    next(err);
  }
});

// GET /api/disputes/:id
disputesRouter.get("/:id", async (req, res, next) => {
  try {
    const dispute = await prisma.dispute.findUnique({
      where: { id: req.params.id },
      include: { job: true },
    });
    if (!dispute) throw new AppError(404, "Dispute not found");
    res.json(dispute);
  } catch (err) {
    next(err);
  }
});

// POST /api/disputes/:id/raise
//
// Step 2 of the sequence: build `dispute.raise` for the caller to sign once
// `open_dispute` has confirmed. The reason comes from the stored row, so the
// string the panel reads and the string the contract received cannot drift.
disputesRouter.post("/:id/raise", requireAuth, async (req, res, next) => {
  try {
    const addr = res.locals.stellarAddress;
    const dispute = await loadDispute(req.params.id);
    assertParticipant(dispute, addr);

    if (!dispute.job.escrowId) throw new AppError(400, "Job has no on-chain escrow yet");
    if (dispute.onChainId) throw new AppError(409, "This dispute already exists on-chain");

    const disputeContract = new Contract(config.DISPUTE_CONTRACT_ID);
    const xdr = await buildTx(
      addr,
      disputeContract.call(
        "raise",
        ...buildRaiseArgs(
          dispute.job.escrowId,
          config.ESCROW_CONTRACT_ID,
          addr,
          dispute.reason,
        ),
      ),
      DISPUTE_ERROR_MESSAGES,
    );

    res.json({ xdr });
  } catch (err) {
    next(err);
  }
});

// POST /api/disputes/:id/sync
//
// Called after `dispute.raise` confirms, with the id the contract returned.
// The indexer reaches the same conclusion from the `raised` event, so this is
// not the only writer — it just makes the id available to `/:id/resolve`
// immediately instead of whenever the next poll lands.
const syncSchema = z.object({
  onChainId: z.number().int().nonnegative(),
});

disputesRouter.post("/:id/sync", requireAuth, validate(syncSchema), async (req, res, next) => {
  try {
    const addr = res.locals.stellarAddress;
    const dispute = await loadDispute(req.params.id);
    assertParticipant(dispute, addr);

    const { onChainId } = req.body as z.infer<typeof syncSchema>;

    const updated = await prisma.dispute.update({
      where: { id: dispute.id },
      data: { onChainId: BigInt(onChainId) },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /api/disputes/:id/resolve  (arbitrator only)
const resolveSchema = z.object({
  clientShare: z.number().min(0),
  freelancerShare: z.number().min(0),
});

disputesRouter.post("/:id/resolve", requireAuth, validate(resolveSchema), async (req, res, next) => {
  try {
    const { clientShare, freelancerShare } = req.body as z.infer<typeof resolveSchema>;

    // Fail closed: an unconfigured allowlist grants nobody access.
    const arbitrators = parseList(config.ARBITRATOR_ADDRESSES);
    if (arbitrators.length === 0) {
      throw new AppError(
        503,
        "Dispute resolution is unavailable: no ARBITRATOR_ADDRESSES configured",
      );
    }
    if (!isListed(res.locals.stellarAddress, arbitrators)) {
      throw new AppError(403, "Only a configured arbitrator can resolve a dispute");
    }

    const dispute = await prisma.dispute.findUnique({
      where: { id: req.params.id },
      include: { job: true },
    });
    if (!dispute) throw new AppError(404, "Dispute not found");
    // Set by `/:id/sync` or by the indexer's `raised` handler. Until then the
    // contract has no dispute to arbitrate.
    if (!dispute.onChainId) {
      throw new AppError(
        409,
        "Dispute is not on-chain yet: call POST /api/disputes/:id/raise, submit it, then POST /:id/sync",
      );
    }

    // Build dispute.arbitrate tx
    const disputeContract = new Contract(config.DISPUTE_CONTRACT_ID);
    const xdr = await buildTx(
      res.locals.stellarAddress,
      disputeContract.call(
        "arbitrate",
        ...buildArbitrateArgs(
          dispute.onChainId,
          BigInt(Math.round(clientShare * 1e7)),
          BigInt(Math.round(freelancerShare * 1e7)),
        ),
      ),
      DISPUTE_ERROR_MESSAGES,
    );

    // Update DB (final status set by indexer after tx confirmed)
    await prisma.dispute.update({
      where: { id: req.params.id },
      data: { status: "UNDER_REVIEW", clientShare, freelancerShare },
    });

    res.json({ xdr });
  } catch (err) {
    next(err);
  }
});
