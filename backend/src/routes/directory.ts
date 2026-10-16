/**
 * directory.ts
 *
 * GET /api/users — the public directory of platform users with their reputation
 * (issue #68). Clients could previously only reach a profile by knowing an
 * address, so there was no way to find anyone.
 *
 *   ?q=<text>      match display name, bio or address
 *   ?sort=reputation|ratings|jobs|name|joined   (default reputation)
 *   ?order=asc|desc                             (default desc)
 *   ?page=<n>&limit=<n>                         (default 1 / 20, max 100)
 *
 * Public and unauthenticated: it only exposes what `GET /api/users/:address`
 * already returns — the address, the optional display name and bio, and public
 * job/rating counts. No email, no token, nothing private.
 *
 * Ordering and paging live in `lib/directory.ts`; this route only loads the rows
 * and joins the reputation aggregate onto them.
 */

import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { AppError } from "../middleware/errorHandler";
import {
  directoryPage,
  directoryQuerySchema,
  sortDirectoryEntries,
  type DirectoryEntry,
} from "../lib/directory";

export const directoryRouter = Router();

/**
 * The aggregate the reputation column shows.
 *
 * `Rating` mirrors what the indexer has seen from `reputation.submit`, so this
 * is the same numbers `GET /api/reputation/:address` reports for one address —
 * read in a single grouped query instead of one per row.
 */
interface RatingAggregate {
  rateeId: string;
  averageScore: number;
  totalRatings: number;
}

/** Rows the route loads before ordering (see the note in lib/directory.ts). */
function toEntry(
  user: {
    id: string;
    stellarAddress: string;
    displayName: string | null;
    bio: string | null;
    createdAt: Date;
    _count: { jobsAsFreelancer: number; jobsAsClient: number };
  },
  reputation: RatingAggregate | undefined,
): DirectoryEntry {
  return {
    id: user.id,
    stellarAddress: user.stellarAddress,
    displayName: user.displayName,
    bio: user.bio,
    createdAt: user.createdAt,
    averageScore: reputation?.averageScore ?? 0,
    totalRatings: reputation?.totalRatings ?? 0,
    jobsAsFreelancer: user._count.jobsAsFreelancer,
    jobsAsClient: user._count.jobsAsClient,
  };
}

// GET /api/users
directoryRouter.get("/", async (req, res, next) => {
  try {
    const parsed = directoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues.map((i) => i.message).join(", "));
    }
    const { q, sort, order, page, limit } = parsed.data;

    // A search term matches a name, a bio or an address. `contains` on the
    // address lets a client paste the start of a key it already has; addresses
    // are uppercase base32, so they need no case folding.
    const where: Prisma.UserWhereInput = q
      ? {
          OR: [
            { displayName: { contains: q, mode: "insensitive" } },
            { bio: { contains: q, mode: "insensitive" } },
            { stellarAddress: { startsWith: q } },
          ],
        }
      : {};

    const [users, aggregates] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          stellarAddress: true,
          displayName: true,
          bio: true,
          createdAt: true,
          _count: { select: { jobsAsFreelancer: true, jobsAsClient: true } },
        },
      }),
      // Grouped over every rating rather than filtered to the users above: the
      // join is a Map lookup, and a second query per user would be the classic
      // N+1.
      prisma.rating.groupBy({
        by: ["rateeId"],
        _avg: { score: true },
        _count: { score: true },
      }),
    ]);

    const reputation = new Map<string, RatingAggregate>(
      (aggregates as unknown as Array<{
        rateeId: string;
        _avg: { score: number | null };
        _count: { score: number };
      }>).map((row) => [
        row.rateeId,
        { rateeId: row.rateeId, averageScore: row._avg.score ?? 0, totalRatings: row._count.score },
      ]),
    );

    const entries = users.map((user) => toEntry(user, reputation.get(user.id)));
    const sorted = sortDirectoryEntries(entries, sort, order);
    const { rows, total, hasMore } = directoryPage(sorted, page, limit);

    res.json({ users: rows, page, limit, total, hasMore, sort, order });
  } catch (err) {
    next(err);
  }
});
