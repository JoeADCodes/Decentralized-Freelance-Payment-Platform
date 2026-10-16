/**
 * notifications.ts
 *
 * The per-user notification feed (issue #66). Rows are written by the indexer as
 * it applies contract events; these routes read them and mark them read.
 *
 * Routes:
 *   GET  /api/notifications             — the caller's feed + unread count
 *   POST /api/notifications/:id/read    — mark one as read (recipient only)
 *   POST /api/notifications/read-all    — mark every unread one as read
 *
 * Authorization: all three require the wallet JWT. Unlike the job list, a feed
 * is personal — the read state in particular — so the caller is identified by
 * the token and there is no address parameter to spoof. `requireAuth` puts the
 * verified address on `res.locals.stellarAddress`.
 */

import { Router } from "express";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";

export const notificationsRouter = Router();

/** Newest first, and never unbounded — a feed is read from the top. */
const FEED_LIMIT = 50;

/** The shape the client renders; `escrowId` as a string for JSON safety. */
function serialize(row: {
  id: string;
  type: string;
  title: string;
  body: string | null;
  escrowId: bigint | null;
  jobId: string | null;
  readAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    escrowId: row.escrowId === null ? null : row.escrowId.toString(),
    jobId: row.jobId,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

// GET /api/notifications
//
// The unread count is returned alongside the page because the feed needs both
// (a badge and a "mark all as read"), and deriving it from a truncated list
// would undercount.
notificationsRouter.get("/", requireAuth, async (_req, res, next) => {
  try {
    const address = res.locals.stellarAddress as string;

    const [notifications, unread] = await Promise.all([
      prisma.notification.findMany({
        where: { address },
        orderBy: { createdAt: "desc" },
        take: FEED_LIMIT,
      }),
      prisma.notification.count({ where: { address, readAt: null } }),
    ]);

    res.json({ unread, notifications: notifications.map(serialize) });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/read-all
//
// Declared before `/:id/read` for readability; the two cannot collide because
// this path has one segment and that one has two.
notificationsRouter.post("/read-all", requireAuth, async (_req, res, next) => {
  try {
    const address = res.locals.stellarAddress as string;

    const result = await prisma.notification.updateMany({
      where: { address, readAt: null },
      data: { readAt: new Date() },
    });

    res.json({ updated: result.count });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/:id/read
//
// Only the recipient may mark a row read, and the check is on the row's own
// address rather than on anything the caller sent. Marking an already-read row
// again keeps the original timestamp so "when did I see this" does not drift.
notificationsRouter.post("/:id/read", requireAuth, async (req, res, next) => {
  try {
    const address = res.locals.stellarAddress as string;

    const notification = await prisma.notification.findUnique({
      where: { id: req.params.id },
    });
    if (!notification) throw new AppError(404, "Notification not found");
    if (notification.address !== address) {
      throw new AppError(403, "This notification belongs to another account");
    }

    const updated =
      notification.readAt === null
        ? await prisma.notification.update({
            where: { id: notification.id },
            data: { readAt: new Date() },
          })
        : notification;

    res.json(serialize(updated));
  } catch (err) {
    next(err);
  }
});
