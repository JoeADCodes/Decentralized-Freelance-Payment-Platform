/**
 * indexer.ts
 *
 * Polls Soroban RPC for contract events emitted by the escrow, dispute, and
 * reputation contracts, then syncs state into PostgreSQL.
 *
 * This keeps the DB in sync without requiring the frontend to call /sync
 * endpoints manually after every transaction.
 *
 * The first poll does not start at ledger 1 — the RPC only retains a rolling
 * window of history, so a fresh cursor starts just behind the chain tip (see
 * `resolveStartLedger`).
 *
 * Events handled (see docs/EVENTS.md):
 *   escrow     — created, funded, milestones_updated, milestone_released,
 *                dispute_opened, resolved, refunded
 *   dispute    — raised, approved, dispute_resolved
 *   reputation — rated
 *
 * Almost every event carries its `escrow_id` in `topic[1]` rather than in the
 * data map; `decodeEventFields` merges the two so a handler always sees it (see
 * the doc comment on its `EVENT_TOPIC_FIELDS`).
 *
 * Dispute record semantics (see docs/DISPUTES.md):
 *   - `dispute_opened` only marks the job DISPUTED. There is no Dispute row yet:
 *     the on-chain dispute has no id or reason until `dispute.raise`, so the row
 *     is created when `raised` is indexed. A job is therefore DISPUTED with an
 *     empty `disputes[]` between the two transactions — by design.
 *   - `refunded` is terminal, so it also closes any open dispute for the escrow
 *     (RAISED/UNDER_REVIEW → REFUNDED). Without that, a refunded job would keep
 *     reporting a live dispute forever, because no later event touches it.
 *   - `resolved` sets both the job (COMPLETED) and its dispute (RESOLVED);
 *     `REFUNDED` and `RESOLVED` are the two terminal dispute states.
 *
 * Contributor Notes:
 * - The cursor (last scanned ledger) is persisted in IndexerCursor, so the
 *   indexer resumes after a restart and does not reprocess applied ledgers.
 * - Unknown events are ignored; a failed event is logged and recorded in
 *   IndexerDeadLetter so it cannot block the rest of the batch *or* vanish.
 *   Because the cursor still advances, a dead letter is a permanent record of
 *   state that is missing from the DB — query it after the fact:
 *     SELECT * FROM "IndexerDeadLetter" ORDER BY "lastSeenAt" DESC;
 *   Re-run the affected event by hand once the bug is fixed, then delete the row.
 */

import { SorobanRpc } from "@stellar/stellar-sdk";
import type { DisputeStatus, JobStatus } from "@prisma/client";
import { config } from "./config";
import { prisma } from "./db";
import {
  KNOWN_EVENTS,
  decodeEventFields,
  decodeEventName,
  type ContractEventLike,
} from "./lib/events";

const CURSOR_ID = "main";
const EVENT_PAGE_LIMIT = 100;

/** Longest error message persisted to IndexerDeadLetter.error. */
const MAX_ERROR_LENGTH = 500;

/**
 * Soroban RPC only serves a rolling window of ledgers (~7 days; the testnet RPC
 * reports roughly 120,960), so `startLedger` outside it is rejected outright
 * with `startLedger must be within the ledger range`. Two cases have to be kept
 * inside the window: a fresh cursor of 0, and a cursor older than the window
 * (the indexer was down for longer than the RPC retains history).
 */
const RPC_LEDGER_WINDOW = 120_960;

/**
 * Where a fresh indexer starts. It cannot backfill from genesis, so it begins
 * just behind the chain tip and picks up events emitted before its first boot.
 */
const FIRST_RUN_LOOKBACK_LEDGERS = 100;

const CONTRACT_IDS = [
  config.ESCROW_CONTRACT_ID,
  config.DISPUTE_CONTRACT_ID,
  config.REPUTATION_CONTRACT_ID,
].filter(Boolean);

const rpcServer = new SorobanRpc.Server(config.SOROBAN_RPC_URL, { allowHttp: false });

/** Minimal surface of `SorobanRpc.Server` the indexer needs (for testing). */
export interface SorobanEventSource {
  getEvents(request: {
    startLedger: number;
    filters: SorobanRpc.Api.EventFilter[];
    limit?: number;
  }): Promise<{ events: ContractEventLike[]; latestLedger: number }>;
  /**
   * Chain tip, used to keep `startLedger` inside the RPC's retention window.
   * Optional so tests and other callers can supply just `getEvents`.
   */
  getLatestLedger?(): Promise<number>;
}

/** Persisted indexer cursor. */
export interface CursorStore {
  get(): Promise<number>;
  set(ledger: number): Promise<void>;
}

export function startIndexer() {
  if (CONTRACT_IDS.length === 0) {
    console.warn("[indexer] No contract IDs configured — skipping.");
    return;
  }
  console.log("[indexer] Starting, polling every", config.INDEXER_POLL_INTERVAL_MS, "ms");
  void poll();
  setInterval(() => void poll(), config.INDEXER_POLL_INTERVAL_MS);
}

async function poll() {
  try {
    const row = await prisma.indexerCursor.upsert({
      where: { id: CURSOR_ID },
      create: { id: CURSOR_ID, lastLedger: 0 },
      update: {},
    });

    const cursor: CursorStore = {
      get: async () => row.lastLedger,
      set: async (ledger) => {
        await prisma.indexerCursor.update({
          where: { id: CURSOR_ID },
          data: { lastLedger: ledger },
        });
      },
    };

    const source: SorobanEventSource = {
      getEvents: (request) => rpcServer.getEvents(request),
      getLatestLedger: async () => (await rpcServer.getLatestLedger()).sequence,
    };

    await processContractEvents(source, cursor, CONTRACT_IDS);
  } catch (err) {
    console.error("[indexer] Poll error:", err);
  }
}

/**
 * Pick the ledger to scan from.
 *
 * A cursor of 0 means "never run": starting at ledger 1 makes the RPC reject
 * every poll because the ledger is older than it retains, which is exactly the
 * failure that leaves a fresh deployment with an indexer that logs forever and
 * never syncs.
 */
export async function resolveStartLedger(
  source: SorobanEventSource,
  cursorLedger: number,
): Promise<number> {
  const latest = await chainTip(source);
  if (latest === null) return cursorLedger + 1; // no tip available; trust the cursor

  if (cursorLedger === 0) {
    return Math.max(1, latest - FIRST_RUN_LOOKBACK_LEDGERS);
  }

  const earliest = latest - RPC_LEDGER_WINDOW + 1;
  const start = cursorLedger + 1;
  if (start < earliest) {
    console.warn(
      `[indexer] cursor at ledger ${cursorLedger} is older than the RPC window; ` +
        `skipping to ${earliest}. Events between the two are no longer retrievable.`,
    );
    return earliest;
  }
  return start;
}

/** Chain tip, or null when the source cannot report one or the call fails. */
async function chainTip(source: SorobanEventSource): Promise<number | null> {
  if (!source.getLatestLedger) return null;
  try {
    return await source.getLatestLedger();
  } catch (err) {
    // Falling back to the cursor beats skipping a poll entirely.
    console.error("[indexer] could not read the chain tip", err);
    return null;
  }
}

/**
 * Fetch and process events for the given contracts, then advance the cursor.
 *
 * `dispatch` and `onError` are injectable so the cursor/decoding/dead-letter
 * logic is testable without a chain or database.
 */
export async function processContractEvents(
  source: SorobanEventSource,
  cursor: CursorStore,
  contractIds: string[],
  dispatch: (event: ContractEventLike) => Promise<void> = dispatchEvent,
  onError: (event: ContractEventLike, error: unknown) => Promise<void> = recordDeadLetter,
): Promise<number> {
  const lastLedger = await cursor.get();
  if (contractIds.length === 0) return lastLedger;

  const filters = contractIds.map((contractId) => ({
    type: "contract" as const,
    contractIds: [contractId],
  }));

  const startLedger = await resolveStartLedger(source, lastLedger);

  const res = await source.getEvents({
    startLedger,
    filters,
    limit: EVENT_PAGE_LIMIT,
  });

  for (const event of res.events) {
    try {
      await dispatch(event);
    } catch (err) {
      // One bad event must not block the rest of the batch.
      console.error(`[indexer] failed to process event ${event.id ?? "?"}`, err);
      // Recording the failure must never take the poller down with it.
      try {
        await onError(event, err);
      } catch (storeErr) {
        console.error("[indexer] could not record the failed event", storeErr);
      }
    }
  }

  // Advance only after every event in the batch has been attempted.
  const next = Math.max(lastLedger, res.latestLedger);
  await cursor.set(next);
  return next;
}

// ---------------------------------------------------------------------------
// Dead letters
// ---------------------------------------------------------------------------

/** Stable key for an event: RPC ids are stable, so a rewind re-uses the row. */
function deadLetterKey(event: ContractEventLike): string {
  return event.id ?? `ledger-${event.ledger}-${decodeEventName(event) ?? "unknown"}`;
}

/**
 * Persist an event the indexer could not apply. The cursor still advances, so
 * this row is the only trace that a state change was skipped.
 */
export async function recordDeadLetter(
  event: ContractEventLike,
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_ERROR_LENGTH,
  );
  const id = deadLetterKey(event);

  await prisma.indexerDeadLetter.upsert({
    where: { id },
    create: {
      id,
      ledger: event.ledger,
      eventName: decodeEventName(event),
      contractId: (event as { contractId?: string }).contractId ?? null,
      error: message,
    },
    update: {
      attempts: { increment: 1 },
      error: message,
    },
  });
}

// ---------------------------------------------------------------------------
// Dispatch + handlers
// ---------------------------------------------------------------------------

/**
 * Each event's `#[topic]` data fields, in `topic[1..]` order (docs/EVENTS.md).
 *
 * `created` and `funded` are deliberately absent: their topic is the client
 * address and their `escrow_id` is an ordinary data field. Every other event
 * carries `escrow_id` (or, for `approved`, `dispute_id`) in `topic[1]`, so
 * decoding only the value map left those handlers with no id to look the row up
 * by — `handleDisputeOpened`, `handleRaised`, `handleRefunded`,
 * `handleMilestoneReleased`, `handleResolved` and `handleRated` all returned
 * without doing anything, so the mirror silently stopped tracking the chain
 * after funding.
 */
export const EVENT_TOPIC_FIELDS: Record<string, string[]> = {
  milestone_released: ["escrow_id"],
  milestones_updated: ["escrow_id"],
  dispute_opened: ["escrow_id"],
  resolved: ["escrow_id"],
  refunded: ["escrow_id"],
  raised: ["escrow_id"],
  dispute_resolved: ["escrow_id"],
  approved: ["dispute_id"],
  rated: ["escrow_id"],
};

async function dispatchEvent(event: ContractEventLike): Promise<void> {
  const name = decodeEventName(event);
  if (!name || !KNOWN_EVENTS.has(name)) return; // unknown events are ignored

  const data = decodeEventFields(event, EVENT_TOPIC_FIELDS[name] ?? []);
  switch (name) {
    case "created":
      await handleCreated(data);
      break;
    case "funded":
      await handleFunded(data);
      break;
    case "milestone_released":
      await handleMilestoneReleased(data);
      break;
    case "dispute_opened":
      await handleDisputeOpened(disputeStores(), data);
      break;
    case "resolved":
    case "dispute_resolved":
      await handleResolved(data);
      break;
    case "refunded":
      await handleRefunded(disputeStores(), data);
      break;
    case "raised":
      await handleRaised(disputeStores(), data);
      break;
    case "rated":
      await handleRated(data);
      break;
    default:
      // milestones_updated / approved do not change indexed job state.
      break;
  }
}

function asBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

function asNumber(value: unknown): number | null {
  const big = asBigInt(value);
  return big === null ? null : Number(big);
}

function asAddress(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function handleCreated(data: Record<string, unknown>): Promise<void> {
  const escrowId = asBigInt(data.escrow_id);
  if (escrowId === null) return;
  await prisma.job.updateMany({ where: { escrowId }, data: { status: "CREATED" } });
}

async function handleFunded(data: Record<string, unknown>): Promise<void> {
  const escrowId = asBigInt(data.escrow_id);
  if (escrowId === null) return;
  await prisma.job.updateMany({ where: { escrowId }, data: { status: "ACTIVE" } });
}

async function handleMilestoneReleased(data: Record<string, unknown>): Promise<void> {
  const escrowId = asBigInt(data.escrow_id);
  const index = asNumber(data.index);
  if (escrowId === null || index === null) return;

  const job = await prisma.job.findUnique({
    where: { escrowId },
    include: { milestones: true },
  });
  if (!job) return;

  const milestone = job.milestones.find((m) => m.index === index);
  if (!milestone) return;

  await prisma.milestone.update({
    where: { id: milestone.id },
    data: { status: "RELEASED", releasedAt: new Date() },
  });

  const allReleased = job.milestones.every(
    (m) => m.id === milestone.id || m.status === "RELEASED",
  );
  if (allReleased) {
    await prisma.job.update({ where: { id: job.id }, data: { status: "COMPLETED" } });
  }
}

// ---------------------------------------------------------------------------
// Dispute lifecycle
// ---------------------------------------------------------------------------

/**
 * The slice of `prisma` the dispute-lifecycle handlers touch, kept structural so
 * the event sequence is unit-testable with an in-memory store instead of a
 * database (the same approach as `RatedStores`).
 */
export interface DisputeLifecycleStores {
  job: {
    findUnique(args: { where: { escrowId: bigint } }): Promise<{ id: string } | null>;
    updateMany(args: {
      where: { escrowId: bigint };
      data: { status: JobStatus };
    }): Promise<unknown>;
  };
  dispute: {
    upsert(args: {
      where: { jobId: string };
      create: {
        onChainId: bigint;
        jobId: string;
        raisedByAddress: string;
        reason: string;
      };
      update: { onChainId: bigint; raisedByAddress: string };
    }): Promise<unknown>;
    updateMany(args: {
      where: { job: { escrowId: bigint }; status: { in: DisputeStatus[] } };
      data: { status: DisputeStatus; resolvedAt: Date };
    }): Promise<unknown>;
  };
}

/** The store the dispute handlers write through (see `DisputeLifecycleStores`). */
function disputeStores(): DisputeLifecycleStores {
  return prisma as unknown as DisputeLifecycleStores;
}

/** Dispute statuses that are still open — exactly the ones a refund has to close. */
const OPEN_DISPUTE_STATUSES: DisputeStatus[] = ["RAISED", "UNDER_REVIEW"];

/**
 * `dispute_opened` (escrow.open_dispute) only marks the job DISPUTED.
 *
 * It deliberately creates no Dispute row: the on-chain dispute has no id or
 * reason until `dispute.raise`, so there is nothing to record yet. The row is
 * created when `raised` is indexed below, which is why a job can be DISPUTED
 * with an empty `disputes[]` between the two transactions (docs/DISPUTES.md).
 */
export async function handleDisputeOpened(
  db: DisputeLifecycleStores,
  data: Record<string, unknown>,
): Promise<void> {
  const escrowId = asBigInt(data.escrow_id);
  if (escrowId === null) return;
  await db.job.updateMany({ where: { escrowId }, data: { status: "DISPUTED" } });
}

async function handleResolved(data: Record<string, unknown>): Promise<void> {
  const escrowId = asBigInt(data.escrow_id);
  if (escrowId === null) return;
  await prisma.job.updateMany({ where: { escrowId }, data: { status: "COMPLETED" } });
  await prisma.dispute.updateMany({
    where: { job: { escrowId } },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
}

/**
 * `refunded` is emitted by both `reclaim_expired` (Active → Refunded) and
 * `reclaim_after_dispute_timeout` (Disputed → Refunded).
 *
 * The escrow is now terminal, so no later event will ever close the dispute it
 * was tied to. Left alone, the row keeps status RAISED/UNDER_REVIEW with
 * `resolvedAt` null forever and every "open disputes" view reports a job whose
 * funds already went back to the client. So the refund also closes the open
 * disputes for that escrow: status REFUNDED (not RESOLVED, which means a panel
 * ruled) with `resolvedAt` stamped. `reclaim_expired` runs from Active and so
 * matches no dispute — that is expected.
 */
export async function handleRefunded(
  db: DisputeLifecycleStores,
  data: Record<string, unknown>,
): Promise<void> {
  const escrowId = asBigInt(data.escrow_id);
  if (escrowId === null) return;

  await db.job.updateMany({ where: { escrowId }, data: { status: "REFUNDED" } });

  await db.dispute.updateMany({
    where: { job: { escrowId }, status: { in: OPEN_DISPUTE_STATUSES } },
    data: { status: "REFUNDED", resolvedAt: new Date() },
  });
}

/**
 * `raised` (dispute.raise) attaches the on-chain dispute id to the job's
 * dispute, creating the row if the API never recorded one.
 *
 * Upserted on `jobId`, not on `onChainId`: `POST /api/disputes` writes the row
 * (with the reason) before the contract has minted an id, so a row already
 * exists for the job and its `onChainId` is still null. Keying on `onChainId`
 * alone — as this handler used to — matches nothing and inserts a second row,
 * leaving the job with one dispute holding the reason and another holding the
 * id. One row per job is also a database constraint now (`Dispute.jobId` is
 * unique), which is the same invariant `dispute.raise` enforces on-chain
 * (`AlreadyRaised` for a second raise on the same escrow).
 *
 * The event wins for the two fields it carries: `raised_by` is the address the
 * contract validated as a party, while the row's `raisedByAddress` is merely
 * whoever called `POST /api/disputes`, and the two differ when one party records
 * the dispute and the other raises it. `reason` is not in the event, so the
 * stored one is left untouched — it is the only copy.
 *
 * Idempotent: re-running it for the same event re-writes the same values, so a
 * cursor rewind cannot duplicate or corrupt the row.
 */
export async function handleRaised(
  db: DisputeLifecycleStores,
  data: Record<string, unknown>,
): Promise<void> {
  const escrowId = asBigInt(data.escrow_id);
  const disputeId = asBigInt(data.dispute_id);
  if (escrowId === null || disputeId === null) return;

  const job = await db.job.findUnique({ where: { escrowId } });
  if (!job) return;

  await db.dispute.upsert({
    where: { jobId: job.id },
    create: {
      onChainId: disputeId,
      jobId: job.id,
      raisedByAddress: String(data.raised_by ?? ""),
      reason: "",
    },
    update: {
      onChainId: disputeId,
      raisedByAddress: String(data.raised_by ?? ""),
    },
  });
}

// ---------------------------------------------------------------------------
// Rated events
// ---------------------------------------------------------------------------

/**
 * The slice of `prisma` `applyRatedEvent` touches, kept structural so the
 * handler is unit-testable with an in-memory store instead of a database
 * (the same approach as `AuthNonceStore` in lib/authNonce.ts).
 */
export interface RatedStores {
  job: {
    findUnique(args: { where: { escrowId: bigint } }): Promise<{ id: string } | null>;
  };
  user: {
    upsert(args: {
      where: { stellarAddress: string };
      create: { stellarAddress: string };
      update: Record<string, never>;
    }): Promise<{ id: string }>;
  };
  rating: {
    upsert(args: {
      where: { raterId_jobId: { raterId: string; jobId: string } };
      create: { jobId: string; raterId: string; rateeId: string; score: number };
      update: { rateeId: string; score: number };
    }): Promise<unknown>;
  };
}

/** A decoded `rated` event, or `null` when a field is missing/malformed. */
interface RatedEvent {
  escrowId: bigint;
  rater: string;
  ratee: string;
  score: number;
}

function parseRatedEvent(data: Record<string, unknown>): RatedEvent | null {
  const escrowId = asBigInt(data.escrow_id);
  const rater = asAddress(data.rater);
  const ratee = asAddress(data.ratee);
  const score = asNumber(data.score);
  if (escrowId === null || rater === null || ratee === null || score === null) return null;
  return { escrowId, rater, ratee, score };
}

/** What `applyRatedEvent` did, so callers (and tests) can tell them apart. */
export type RatedOutcome =
  | { status: "applied"; jobId: string; score: number }
  | { status: "skipped"; reason: "malformed" | "unknown-job" };

/**
 * Persist a `rated` event as a single Rating row.
 *
 * `reputation.submit` is the only way a rating is created, and a client can
 * bypass this API entirely (`stellar contract invoke`, `scripts/demo_testnet.sh`),
 * so for those ratings the event is the only record we get. The row is keyed by
 * `(rater, job)` — the same key `POST /api/reputation` uses — so a row that the
 * API wrote before the transaction landed is updated in place rather than
 * duplicated, and the on-chain score (authoritative) overwrites the placeholder
 * while the off-chain `comment` is preserved.
 *
 * A rating event whose escrow has no off-chain Job row is skipped: `Rating.jobId`
 * is required, and inventing a job from a rating would put fabricated data in
 * the listing. The event is logged so it can be reconciled by hand.
 */
export async function applyRatedEvent(
  db: RatedStores,
  data: Record<string, unknown>,
): Promise<RatedOutcome> {
  const event = parseRatedEvent(data);
  if (!event) return { status: "skipped", reason: "malformed" };

  const job = await db.job.findUnique({ where: { escrowId: event.escrowId } });
  if (!job) return { status: "skipped", reason: "unknown-job" };

  // An on-chain rater/ratee may never have authenticated against this API, so
  // materialise the user rows rather than dropping the rating on the floor.
  const [rater, ratee] = await Promise.all([
    db.user.upsert({
      where: { stellarAddress: event.rater },
      create: { stellarAddress: event.rater },
      update: {},
    }),
    db.user.upsert({
      where: { stellarAddress: event.ratee },
      create: { stellarAddress: event.ratee },
      update: {},
    }),
  ]);

  await db.rating.upsert({
    where: { raterId_jobId: { raterId: rater.id, jobId: job.id } },
    create: {
      jobId: job.id,
      raterId: rater.id,
      rateeId: ratee.id,
      score: event.score,
    },
    // On-chain score wins; keep any comment the API stored.
    update: { rateeId: ratee.id, score: event.score },
  });

  return { status: "applied", jobId: job.id, score: event.score };
}

async function handleRated(data: Record<string, unknown>): Promise<void> {
  const outcome = await applyRatedEvent(prisma as unknown as RatedStores, data);

  if (outcome.status === "applied") {
    console.log("[indexer] rated job", outcome.jobId, "score", outcome.score);
    return;
  }

  if (outcome.reason === "unknown-job") {
    console.warn(
      `[indexer] rated event for escrow ${String(data.escrow_id)} has no job record; ` +
        "the rating cannot be stored until the job exists (see POST /api/escrow/sync/:jobId).",
    );
    return;
  }

  console.warn("[indexer] ignored a malformed rated event", data);
}
