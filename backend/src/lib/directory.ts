/**
 * directory.ts
 *
 * Ordering and paging for the public freelancer directory (issue #68).
 *
 * Kept out of the route so the sort is unit-testable without a database: the
 * route's job is to load rows and hand them here, and every ordering rule —
 * including how ties break — lives in one place.
 *
 * Why the sort is not a SQL `ORDER BY`: the reputation score is an average over
 * another table, which Prisma's `orderBy` cannot express, so the route would have
 * to fall back to hand-written SQL and commit itself to column names. The
 * ordering is therefore applied here, over rows the route has already loaded.
 */

import { z } from "zod";

/** Sort keys the directory offers, in the order the UI shows them. */
export const DIRECTORY_SORTS = ["reputation", "ratings", "jobs", "name", "joined"] as const;
export type DirectorySort = (typeof DIRECTORY_SORTS)[number];

export type DirectoryOrder = "asc" | "desc";

export const DEFAULT_DIRECTORY_LIMIT = 20;
export const MAX_DIRECTORY_LIMIT = 100;

/**
 * `GET /api/users` query. Values arrive as strings, so the numeric ones are
 * coerced and range-checked here rather than in the handler: `?limit=9999` is a
 * caller mistake worth a 400, not a silently clamped page.
 */
export const directoryQuerySchema = z.object({
  /** Free text matched against display name, bio and address. */
  q: z.string().trim().max(100).optional(),
  sort: z.enum(DIRECTORY_SORTS).default("reputation"),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_DIRECTORY_LIMIT, `limit must be at most ${MAX_DIRECTORY_LIMIT}`)
    .default(DEFAULT_DIRECTORY_LIMIT),
});

export type DirectoryQuery = z.infer<typeof directoryQuerySchema>;

/** The fields a directory row is ordered by, plus what is displayed. */
export interface DirectoryEntry {
  id: string;
  stellarAddress: string;
  displayName: string | null;
  bio?: string | null;
  createdAt: Date;
  /** Mean rating, 0 for an address nobody has rated. */
  averageScore: number;
  /** How many ratings the average is over — the confidence behind the score. */
  totalRatings: number;
  jobsAsFreelancer: number;
  jobsAsClient: number;
}

/** The value the primary sort key compares. */
function primaryKey(entry: DirectoryEntry, sort: DirectorySort): number | string {
  switch (sort) {
    case "reputation":
      return entry.averageScore;
    case "ratings":
      return entry.totalRatings;
    case "jobs":
      return entry.jobsAsFreelancer + entry.jobsAsClient;
    case "joined":
      return entry.createdAt.getTime();
    case "name":
      // An entry without a display name falls back to its address, so a name
      // sort is total instead of leaving unnamed users in one lump.
      return (entry.displayName ?? entry.stellarAddress).toLowerCase();
  }
}

/**
 * Order the directory by the requested key.
 *
 * The requested `order` applies to the primary key only. Ties are always broken
 * the same way — most ratings first, then the higher score, then the newer
 * account — and finally by address, so the same page of results is returned for
 * the same query no matter what order the database handed the rows over in. A
 * directory that reshuffles equal rows between requests would page inconsistently
 * (the same user twice, or not at all).
 */
export function sortDirectoryEntries(
  entries: DirectoryEntry[],
  sort: DirectorySort,
  order: DirectoryOrder,
): DirectoryEntry[] {
  const direction = order === "asc" ? 1 : -1;

  return [...entries].sort((a, b) => {
    const left = primaryKey(a, sort);
    const right = primaryKey(b, sort);
    if (left !== right) {
      const comparison = typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right));
      return comparison * direction;
    }

    // Fixed tie-breakers: an address nobody has rated (0/0) is never promoted
    // above one with ratings just because the caller asked for descending.
    if (a.totalRatings !== b.totalRatings) return b.totalRatings - a.totalRatings;
    if (a.averageScore !== b.averageScore) return b.averageScore - a.averageScore;
    const joined = b.createdAt.getTime() - a.createdAt.getTime();
    if (joined !== 0) return joined;
    return a.stellarAddress.localeCompare(b.stellarAddress);
  });
}

/** One page of an already-sorted directory. */
export interface DirectoryPage<T> {
  rows: T[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

/**
 * Slice a page out of the sorted directory.
 *
 * `total` is the whole (filtered) directory rather than the page, because a
 * paginated list needs to say how many entries exist to page through — the
 * endpoint is public and paging is the only way to see them all.
 */
export function directoryPage<T>(sorted: T[], page: number, limit: number): DirectoryPage<T> {
  const start = (page - 1) * limit;
  const rows = sorted.slice(start, start + limit);
  return { rows, page, limit, total: sorted.length, hasMore: start + rows.length < sorted.length };
}
