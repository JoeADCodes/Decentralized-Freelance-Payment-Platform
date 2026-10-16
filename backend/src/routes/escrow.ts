/**
 * escrow.ts
 *
 * These endpoints build unsigned Stellar transactions that the frontend
 * signs with Freighter and submits directly to the network.
 * The backend never holds private keys.
 *
 * POST /api/escrow/build/create            — build escrow.create() tx
 * POST /api/escrow/build/fund              — build escrow.fund() tx
 * POST /api/escrow/build/release           — build escrow.release_milestone() tx
 * POST /api/escrow/build/reclaim           — build escrow.reclaim_expired() tx
 * POST /api/escrow/build/reclaim-dispute   — build escrow.reclaim_after_dispute_timeout() tx
 * POST /api/escrow/build/update-milestones — build escrow.update_milestones() tx
 * PUT  /api/escrow/:escrowId/milestones    — record a confirmed milestone edit
 * POST /api/escrow/sync/:jobId             — sync on-chain escrow ID to DB job record
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
import { config } from "../config";
import { buildCreateArgs, buildUpdateMilestonesArgs } from "../lib/escrowArgs";
import {
  buildFundArgs,
  buildReclaimArgs,
  buildReclaimDisputeArgs,
  buildReleaseMilestoneArgs,
} from "../lib/scval";
import { formatAmount, getAsset, sumAmounts, toBaseUnits, UnknownAssetError } from "../lib/assets";
import { friendlyContractError } from "../lib/contractErrors";
import { isValidStellarAddress } from "../lib/stellarAddress";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/errorHandler";

export const escrowRouter = Router();

const server = new SorobanRpc.Server(config.SOROBAN_RPC_URL);
const networkPassphrase =
  config.STELLAR_NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

// `xdr.Operation`, not `any`: it is exactly what `Contract.call(...)` returns and
// what `TransactionBuilder.addOperation` accepts, so a mistake in the call site
// is caught by the compiler instead of at simulation time (issue #54).
async function buildTx(sourceAddress: string, operation: xdr.Operation): Promise<string> {
  const account = await server.getAccount(sourceAddress);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(operation)
    .setTimeout(30)
    .build();
  const simResult = await server.simulateTransaction(tx);
  // A contract rejection (`Error(Contract, #N)`) is a caller mistake, not an
  // internal failure — answer with the named error rather than a host string.
  if ("error" in simResult) throw new AppError(400, friendlyContractError(simResult.error));
  return SorobanRpc.assembleTransaction(tx, simResult).build().toXDR();
}

/** Resolve a job's asset, turning an unknown symbol into a 400. */
function assetForJob(assetSymbol: string) {
  try {
    return getAsset(assetSymbol);
  } catch (err) {
    if (err instanceof UnknownAssetError) throw new AppError(400, err.message);
    throw err;
  }
}

/**
 * Load the job behind an escrow id and check the caller may edit its milestones.
 *
 * The ownership check is a cheap, readable early rejection. The *state* check is
 * deliberately left to the contract: the chain is the authority and the mirrored
 * `Job.status` can lag behind it, so a funded escrow fails simulation with
 * `InvalidStatus`, which `friendlyContractError` reports as a 4xx message.
 */
async function loadEditableJob(escrowId: bigint, address: string) {
  const job = await prisma.job.findUnique({
    where: { escrowId },
    include: { client: true },
  });
  if (!job) throw new AppError(404, "No job is linked to that escrow id");
  if (job.client.stellarAddress !== address) {
    throw new AppError(403, "Only the client can edit milestones");
  }
  return job;
}

// POST /api/escrow/build/create
const buildCreateSchema = z.object({
  jobId: z.string(),
  freelancerAddress: z.string().refine(isValidStellarAddress, "Invalid Stellar address"),
  expiryTimestamp: z.number().int().positive(),
});

escrowRouter.post("/build/create", requireAuth, validate(buildCreateSchema), async (req, res, next) => {
  try {
    const { jobId, freelancerAddress, expiryTimestamp } = req.body as z.infer<typeof buildCreateSchema>;

    const job = await prisma.job.findUnique({ where: { id: jobId }, include: { milestones: true, client: true } });
    if (!job) throw new AppError(404, "Job not found");
    if (job.client.stellarAddress !== res.locals.stellarAddress) throw new AppError(403, "Forbidden");

    // Pay in the asset the job is configured for, validated against the registry.
    const asset = assetForJob(job.asset);
    const tokenContractId = config[asset.configKey];
    if (!tokenContractId) {
      throw new AppError(400, `No contract configured for asset ${asset.symbol}`);
    }

    const contract = new Contract(config.ESCROW_CONTRACT_ID);
    const args = buildCreateArgs({
      client: res.locals.stellarAddress,
      freelancer: freelancerAddress,
      token: tokenContractId,
      milestones: job.milestones.map((m) => ({
        amount: toBaseUnits(m.amountUsdc.toString(), asset.decimals),
        deadline: BigInt(
          m.deadline ? Math.floor(m.deadline.getTime() / 1000) : expiryTimestamp,
        ),
      })),
      expiry: BigInt(expiryTimestamp),
    });

    const xdr = await buildTx(
      res.locals.stellarAddress,
      contract.call("create", ...args),
    );

    res.json({ xdr });
  } catch (err) {
    next(err);
  }
});

/** A milestone being edited, in whole units (the UI's unit), deadline optional. */
const editableMilestoneSchema = z.object({
  description: z.string().max(200).optional(),
  amountUsdc: z.number().positive(),
  deadline: z.string().datetime().optional(),
});

// POST /api/escrow/build/update-milestones
//
// `escrow.update_milestones(escrow_id, milestones)` replaces the whole breakdown
// while the escrow is still unfunded. The route takes whole-unit amounts and
// encodes them exactly like `build/create`, so both paths produce identical
// arguments for the same edit.
const updateMilestonesSchema = z.object({
  escrowId: z.number().int().nonnegative(),
  milestones: z.array(editableMilestoneSchema).min(1),
});

escrowRouter.post(
  "/build/update-milestones",
  requireAuth,
  validate(updateMilestonesSchema),
  async (req, res, next) => {
    try {
      const { escrowId, milestones } = req.body as z.infer<typeof updateMilestonesSchema>;
      const job = await loadEditableJob(BigInt(escrowId), res.locals.stellarAddress);
      const asset = assetForJob(job.asset);

      const contract = new Contract(config.ESCROW_CONTRACT_ID);
      const args = buildUpdateMilestonesArgs({
        escrowId: BigInt(escrowId),
        milestones: milestones.map((m) => ({
          amount: toBaseUnits(m.amountUsdc, asset.decimals),
          deadline: BigInt(m.deadline ? Math.floor(new Date(m.deadline).getTime() / 1000) : 0),
        })),
      });

      const xdr = await buildTx(
        res.locals.stellarAddress,
        contract.call("update_milestones", ...args),
      );

      res.json({ xdr });
    } catch (err) {
      next(err);
    }
  },
);

// PUT /api/escrow/:escrowId/milestones — record an edit the chain has accepted.
//
// The `milestones_updated` event carries only `count` and `total_amount`, so the
// per-milestone rows cannot be rebuilt server-side from the event. The client
// that submitted the edit therefore sends the new breakdown here once the
// transaction confirms, the same way `sync/:jobId` links an escrow id after
// `create`/`fund`. The indexer still reconciles the total from the event
// (`handleMilestonesUpdated` in indexer.ts), so an edit that is never recorded
// still cannot leave a stale total behind.
const recordMilestonesSchema = z.object({
  milestones: z.array(editableMilestoneSchema).min(1),
});

escrowRouter.put(
  "/:escrowId/milestones",
  requireAuth,
  validate(recordMilestonesSchema),
  async (req, res, next) => {
    try {
      const escrowIdText = req.params.escrowId;
      if (!/^\d+$/.test(escrowIdText)) throw new AppError(400, "Invalid escrow id");

      const escrowId = BigInt(escrowIdText);
      const { milestones } = req.body as z.infer<typeof recordMilestonesSchema>;
      const job = await loadEditableJob(escrowId, res.locals.stellarAddress);
      const asset = assetForJob(job.asset); // reject an asset the registry does not know

      // Sum in base units (see POST /api/jobs): a float total would store
      // 0.1 + 0.2 = 0.30000000000000004 in the DECIMAL(65,30) column.
      const totalAmountUsdc = formatAmount(
        sumAmounts(milestones.map((m) => m.amountUsdc), asset.decimals),
        asset.decimals,
      );

      // The edit replaces the breakdown, so the mirror has to replace its rows
      // too — otherwise a shorter list leaves orphaned milestones behind.
      const updated = await prisma.$transaction(async (tx) => {
        await tx.milestone.deleteMany({ where: { jobId: job.id } });
        await tx.milestone.createMany({
          data: milestones.map((m, i) => ({
            jobId: job.id,
            index: i,
            amountUsdc: formatAmount(
              toBaseUnits(m.amountUsdc, asset.decimals),
              asset.decimals,
            ),
            description: m.description ?? `Milestone ${i + 1}`,
            deadline: m.deadline ? new Date(m.deadline) : null,
          })),
        });
        return tx.job.update({
          where: { id: job.id },
          data: { totalAmountUsdc },
          include: { milestones: { orderBy: { index: "asc" } } },
        });
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/escrow/build/fund
escrowRouter.post("/build/fund", requireAuth, validate(z.object({ escrowId: z.number() })), async (req, res, next) => {
  try {
    const contract = new Contract(config.ESCROW_CONTRACT_ID);
    const xdr = await buildTx(
      res.locals.stellarAddress,
      contract.call("fund", ...buildFundArgs(req.body.escrowId)),
    );
    res.json({ xdr });
  } catch (err) {
    next(err);
  }
});

// POST /api/escrow/build/release
const releaseSchema = z.object({ escrowId: z.number(), milestoneIndex: z.number().int().min(0) });

escrowRouter.post("/build/release", requireAuth, validate(releaseSchema), async (req, res, next) => {
  try {
    const { escrowId, milestoneIndex } = req.body as z.infer<typeof releaseSchema>;
    const contract = new Contract(config.ESCROW_CONTRACT_ID);
    const xdr = await buildTx(
      res.locals.stellarAddress,
      contract.call(
        "release_milestone",
        ...buildReleaseMilestoneArgs(escrowId, milestoneIndex),
      ),
    );
    res.json({ xdr });
  } catch (err) {
    next(err);
  }
});

// POST /api/escrow/build/reclaim
escrowRouter.post("/build/reclaim", requireAuth, validate(z.object({ escrowId: z.number() })), async (req, res, next) => {
  try {
    const contract = new Contract(config.ESCROW_CONTRACT_ID);
    const xdr = await buildTx(
      res.locals.stellarAddress,
      contract.call("reclaim_expired", ...buildReclaimArgs(req.body.escrowId)),
    );
    res.json({ xdr });
  } catch (err) {
    next(err);
  }
});

// POST /api/escrow/build/reclaim-dispute
//
// The timelock escape hatch for a panel that never rules:
// `escrow.reclaim_after_dispute_timeout`. The contract is the authority on all
// three preconditions — the caller is the client (client auth), the escrow is
// still `Disputed`, and the dispute deadline has passed — so the route only
// encodes the `u64` argument. Before the deadline the simulation fails with
// `DisputeTimeoutNotReached`, which `friendlyContractError` reports as a 400.
escrowRouter.post(
  "/build/reclaim-dispute",
  requireAuth,
  validate(z.object({ escrowId: z.number() })),
  async (req, res, next) => {
    try {
      const contract = new Contract(config.ESCROW_CONTRACT_ID);
      const xdr = await buildTx(
        res.locals.stellarAddress,
        contract.call(
          "reclaim_after_dispute_timeout",
          ...buildReclaimDisputeArgs(req.body.escrowId),
        ),
      );
      res.json({ xdr });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/escrow/sync/:jobId — called by frontend after tx confirmed
const syncSchema = z.object({ escrowId: z.number() });

escrowRouter.post("/sync/:jobId", requireAuth, validate(syncSchema), async (req, res, next) => {
  try {
    const job = await prisma.job.update({
      where: { id: req.params.jobId },
      data: { escrowId: BigInt(req.body.escrowId), status: "FUNDED" },
    });
    res.json(job);
  } catch (err) {
    next(err);
  }
});
