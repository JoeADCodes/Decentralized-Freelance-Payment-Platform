/**
 * api.ts
 *
 * Minimal client for the backend REST API. Only the endpoints the frontend
 * needs; `VITE_API_URL` configures the base URL (default localhost:3000).
 *
 * Contributor Notes:
 * - The backend indexer is still a stub, so jobs appear here only once created
 *   through the API — that is expected for now.
 * - `totalAmountUsdc`/`escrowId` come from Prisma and may serialize as strings.
 */

/*
 * Vite inlines `VITE_*` at build time, so an **empty** value is meaningful and
 * different from an unset one:
 *
 *  - unset  → `http://localhost:3000`, the local development backend;
 *  - `""`   → every request is same-origin (`/api/jobs`), which is how the
 *             containerised app reaches the API: nginx (frontend/nginx.conf)
 *             proxies `/api/` to the `backend` service, a name that only
 *             resolves inside the compose network (issue #55);
 *  - a URL  → used as-is, e.g. the hosted backend origin on Vercel.
 */
export const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export interface JobListQuery {
  status?: string;
  client?: string;
  freelancer?: string;
  page?: number;
  limit?: number;
}

/** Build the `/api/jobs` query string, omitting empty filters. */
export function buildJobsQuery(query: JobListQuery = {}): string {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.client) params.set("client", query.client);
  if (query.freelancer) params.set("freelancer", query.freelancer);
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export interface JobApi {
  id: string;
  /** On-chain escrow id, present only once the job has been funded on-chain. */
  escrowId: string | number | null;
  title: string;
  status: string;
  /** Asset symbol the job pays in (see lib/assets.ts). */
  asset?: string;
  totalAmountUsdc: string | number;
  client?: { stellarAddress: string; displayName?: string | null } | null;
  freelancer?: { stellarAddress: string } | null;
}

/** Fetch a page of jobs. Throws on a non-2xx response. */
export async function fetchJobs(
  query: JobListQuery = {},
  signal?: AbortSignal,
): Promise<JobApi[]> {
  const res = await fetch(`${API_BASE_URL}/api/jobs${buildJobsQuery(query)}`, {
    signal,
  });
  if (!res.ok) throw new Error(`Could not load jobs (HTTP ${res.status})`);
  return (await res.json()) as JobApi[];
}

// ---------------------------------------------------------------------------
// Authenticated writes
// ---------------------------------------------------------------------------

export interface CreateJobMilestoneInput {
  description?: string;
  /**
   * Whole units of the job asset. A decimal string is exact and preferred; a
   * number is accepted but is already a binary float by the time it arrives.
   */
  amountUsdc: number | string;
  deadline?: string;
}

export interface CreateJobInput {
  title: string;
  description: string;
  /** Asset symbol the job pays in; the backend stores it on the job. */
  asset: string;
  milestones: CreateJobMilestoneInput[];
  expiresAt?: string;
}

/**
 * Complete the wallet challenge-response flow and return a bearer token.
 * `signMessage` signs the challenge nonce per SEP-53 (see Freighter).
 */
export async function authenticate(
  address: string,
  signMessage: (message: string) => Promise<string>,
): Promise<string> {
  const challengeRes = await fetch(
    `${API_BASE_URL}/api/users/challenge?address=${encodeURIComponent(address)}`,
  );
  if (!challengeRes.ok) {
    throw new Error(`Could not get an auth challenge (HTTP ${challengeRes.status})`);
  }
  const { nonce } = (await challengeRes.json()) as { nonce: string };

  const signature = await signMessage(nonce);
  const authRes = await fetch(`${API_BASE_URL}/api/users/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, signature, nonce }),
  });
  if (!authRes.ok) throw new Error(`Authentication failed (HTTP ${authRes.status})`);
  const { token } = (await authRes.json()) as { token: string };
  return token;
}

/** Create the off-chain job record (requires a token from `authenticate`). */
export async function createJob(input: CreateJobInput, token: string): Promise<JobApi> {
  const res = await fetch(`${API_BASE_URL}/api/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Could not save the job (HTTP ${res.status})`);
  return (await res.json()) as JobApi;
}

/** Attach the on-chain escrow id to an existing job record. */
export async function linkEscrowId(
  jobId: string,
  escrowId: number,
  token: string,
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/escrow/sync/${jobId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ escrowId }),
  });
  if (!res.ok) throw new Error(`Could not link the escrow (HTTP ${res.status})`);
}

export interface SubmitRatingInput {
  /** Off-chain job id — the API keys the rating on this, not the escrow id. */
  jobId: string;
  rateeAddress: string;
  score: number;
  comment?: string;
}

export interface SubmittedRating {
  id: string;
  jobId: string;
  score: number;
  comment: string | null;
}

/**
 * Record a rating off-chain and receive the server-built `reputation.submit`
 * transaction.
 *
 * The server keys the row on `(rater, job)` — the same key the indexer uses for
 * the `rated` event — so the two converge instead of duplicating.
 *
 * The returned `xdr` is not used by the app: the rating is submitted through
 * `useEscrow.submitRating`, which encodes the arguments itself (`scU32` score),
 * so the on-chain call is correct regardless of the API's builder. This client
 * is for the off-chain record (the contract stores no comment) and for
 * API-first integrators.
 */
export async function submitRating(
  input: SubmitRatingInput,
  token: string,
): Promise<{ rating: SubmittedRating; xdr: string }> {
  const res = await fetch(`${API_BASE_URL}/api/reputation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Could not record the rating (HTTP ${res.status})`);
  return (await res.json()) as { rating: SubmittedRating; xdr: string };
}

export interface DisputeApi {
  id: string;
  jobId: string;
  /** Set once `dispute.raise` has confirmed (see `linkDisputeId`). */
  onChainId: string | number | null;
  status: string;
  reason: string;
}

/**
 * Record a dispute off-chain and receive the server-built `escrow.open_dispute`
 * transaction.
 *
 * The row is written before either transaction runs because the `raised` event
 * carries no reason: this row is the only place the reason the panel reads is
 * kept. Keyed on the job, so calling it twice (both parties may) returns the
 * same dispute instead of a second one.
 *
 * As with `submitRating`, the returned `xdr` is not what the app submits —
 * `useEscrow.openDispute` encodes `open_dispute` itself, so the on-chain call
 * does not depend on the API's builder. This is the off-chain record, and what
 * API-first integrators follow.
 */
export async function createDispute(
  input: { jobId: string; reason: string },
  token: string,
): Promise<{ dispute: DisputeApi; xdr: string }> {
  const res = await fetch(`${API_BASE_URL}/api/disputes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Could not record the dispute (HTTP ${res.status})`);
  return (await res.json()) as { dispute: DisputeApi; xdr: string };
}

/**
 * Attach the on-chain dispute id that `dispute.raise` returned to the row.
 *
 * Without this the id only arrives when the indexer next sees the `raised`
 * event, and `POST /api/disputes/:id/resolve` refuses until then. The indexer
 * writes the same field on the same row, so this is a head start, not a second
 * source of truth.
 */
export async function linkDisputeId(
  disputeId: string,
  onChainId: number | bigint,
  token: string,
): Promise<DisputeApi> {
  const res = await fetch(`${API_BASE_URL}/api/disputes/${disputeId}/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ onChainId: Number(onChainId) }),
  });
  if (!res.ok) throw new Error(`Could not record the dispute id (HTTP ${res.status})`);
  return (await res.json()) as DisputeApi;
}
