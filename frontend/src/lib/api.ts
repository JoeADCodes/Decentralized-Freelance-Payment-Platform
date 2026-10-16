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

// ---------------------------------------------------------------------------
// Directory (issue #68)
// ---------------------------------------------------------------------------

/** One entry of the public directory, as `GET /api/users` serializes it. */
export interface DirectoryUser {
  id: string;
  stellarAddress: string;
  displayName: string | null;
  bio: string | null;
  createdAt: string;
  /** Mean rating, `0` for an address nobody has rated. */
  averageScore: number;
  /** How many ratings the average is over. */
  totalRatings: number;
  jobsAsFreelancer: number;
  jobsAsClient: number;
}

export interface DirectoryResult {
  users: DirectoryUser[];
  page: number;
  limit: number;
  /** The whole filtered directory, not just this page. */
  total: number;
  hasMore: boolean;
  sort: string;
  order: string;
}

/** Sort keys the API accepts; the page maps these to labels. */
export const DIRECTORY_SORTS = ["reputation", "ratings", "jobs", "name", "joined"] as const;
export type DirectorySort = (typeof DIRECTORY_SORTS)[number];

export interface DirectoryQuery {
  q?: string;
  sort?: DirectorySort;
  order?: "asc" | "desc";
  page?: number;
  limit?: number;
}

/** Build the `/api/users` query string, omitting empty values. */
export function buildDirectoryQuery(query: DirectoryQuery = {}): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.sort) params.set("sort", query.sort);
  if (query.order) params.set("order", query.order);
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Browse the directory. Public — no token, and no address parameter. */
export async function fetchDirectory(
  query: DirectoryQuery = {},
  signal?: AbortSignal,
): Promise<DirectoryResult> {
  const res = await fetch(`${API_BASE_URL}/api/users${buildDirectoryQuery(query)}`, { signal });
  if (!res.ok) throw new Error(`Could not load the directory (HTTP ${res.status})`);
  return (await res.json()) as DirectoryResult;
}

// ---------------------------------------------------------------------------
// Notification feed (issue #66)
// ---------------------------------------------------------------------------

/**
 * One row of the caller's feed, as `GET /api/notifications` serializes it.
 *
 * `escrowId` arrives as a string (a Prisma `BigInt` cannot be JSON numbers) and
 * is only used for the link to the job, so it is not parsed back.
 */
export interface NotificationApi {
  id: string;
  /** Indexed event name (`funded`, `milestone_released`, …) — docs/EVENTS.md. */
  type: string;
  title: string;
  body: string | null;
  escrowId: string | null;
  jobId: string | null;
  /** ISO timestamp once read, `null` while unread. */
  readAt: string | null;
  createdAt: string;
}

export interface NotificationFeed {
  /** Total unread rows of the caller, not just the ones in this page. */
  unread: number;
  notifications: NotificationApi[];
}

/**
 * Fetch the caller's feed. The address comes from the token, so there is no
 * parameter to pass — a feed is personal and cannot be requested for someone else.
 */
export async function fetchNotifications(
  token: string,
  signal?: AbortSignal,
): Promise<NotificationFeed> {
  const res = await fetch(`${API_BASE_URL}/api/notifications`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok) throw new Error(`Could not load notifications (HTTP ${res.status})`);
  return (await res.json()) as NotificationFeed;
}

/** Mark one row read. Only the recipient may; the API answers 403 otherwise. */
export async function markNotificationRead(
  id: string,
  token: string,
): Promise<NotificationApi> {
  const res = await fetch(`${API_BASE_URL}/api/notifications/${encodeURIComponent(id)}/read`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Could not mark the notification read (HTTP ${res.status})`);
  return (await res.json()) as NotificationApi;
}

/** Mark every unread row read, returning how many changed. */
export async function markAllNotificationsRead(token: string): Promise<number> {
  const res = await fetch(`${API_BASE_URL}/api/notifications/read-all`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Could not mark the notifications read (HTTP ${res.status})`);
  const { updated } = (await res.json()) as { updated: number };
  return updated;
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
