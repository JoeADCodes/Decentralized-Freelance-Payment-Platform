/**
 * Route-level tests for `/api/notifications` (issue #66).
 *
 * The feed is read state, so the subject here is who may read and change it:
 * every route resolves the caller from the wallet JWT and never from a parameter,
 * and a row may only be marked read by the address it was written for. The
 * indexer's own writing is covered in `notifications.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { SignJWT } from "jose";

const OWNER = Keypair.random().publicKey();
const STRANGER = Keypair.random().publicKey();

const h = vi.hoisted(() => ({
  notification: {
    findMany: vi.fn(),
    count: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("../db", () => ({ prisma: { notification: h.notification } }));

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  const { notificationsRouter } = await import("../routes/notifications");
  const { errorHandler } = await import("../middleware/errorHandler");

  const app = express();
  app.use(express.json());
  app.use("/api/notifications", notificationsRouter);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  for (const fn of Object.values(h.notification)) fn.mockReset();
});

/** A bearer token the `requireAuth` middleware accepts for `address`. */
async function tokenFor(address: string): Promise<string> {
  return new SignJWT({ sub: address })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

function request(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, init);
}

const CREATED = new Date("2026-01-07T10:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-7:GOWNER",
    address: OWNER,
    type: "funded",
    title: "Escrow funded",
    body: "2.5 USDC is now held in escrow — work can start.",
    escrowId: 7n,
    jobId: "job-1",
    readAt: null,
    createdAt: CREATED,
    ...overrides,
  };
}

describe("GET /api/notifications", () => {
  it("returns the caller's feed and unread count, with the escrow id as a string", async () => {
    h.notification.findMany.mockResolvedValue([row()]);
    h.notification.count.mockResolvedValue(1);

    const res = await request("/api/notifications", {
      headers: { authorization: `Bearer ${await tokenFor(OWNER)}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { unread: number; notifications: Array<Record<string, unknown>> };
    expect(body.unread).toBe(1);
    // A bigint id would make JSON.stringify throw, so it is serialized.
    expect(body.notifications[0].escrowId).toBe("7");
    expect(body.notifications[0]).toMatchObject({
      id: "evt-7:GOWNER",
      type: "funded",
      title: "Escrow funded",
      jobId: "job-1",
      readAt: null,
    });

    // The feed is scoped to the token's address, newest first and bounded.
    expect(h.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { address: OWNER },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    );
    // The unread count is queried separately so a truncated feed does not undercount.
    expect(h.notification.count).toHaveBeenCalledWith({ where: { address: OWNER, readAt: null } });
  });

  it("refuses a request without a token", async () => {
    const res = await request("/api/notifications");
    expect(res.status).toBe(401);
    expect(h.notification.findMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/notifications/:id/read", () => {
  it("marks the caller's own row read", async () => {
    h.notification.findUnique.mockResolvedValue(row());
    const readAt = new Date("2026-01-07T11:00:00.000Z");
    h.notification.update.mockResolvedValue(row({ readAt }));

    const res = await request("/api/notifications/evt-7:GOWNER/read", {
      method: "POST",
      headers: { authorization: `Bearer ${await tokenFor(OWNER)}` },
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { readAt: string }).readAt).toBe(readAt.toISOString());
    expect(h.notification.update).toHaveBeenCalledWith({
      where: { id: "evt-7:GOWNER" },
      data: { readAt: expect.any(Date) },
    });
  });

  it("does not let another account mark a row read", async () => {
    h.notification.findUnique.mockResolvedValue(row());

    const res = await request("/api/notifications/evt-7:GOWNER/read", {
      method: "POST",
      headers: { authorization: `Bearer ${await tokenFor(STRANGER)}` },
    });

    expect(res.status).toBe(403);
    expect(h.notification.update).not.toHaveBeenCalled();
  });

  it("404s for a row that does not exist", async () => {
    h.notification.findUnique.mockResolvedValue(null);

    const res = await request("/api/notifications/nope/read", {
      method: "POST",
      headers: { authorization: `Bearer ${await tokenFor(OWNER)}` },
    });

    expect(res.status).toBe(404);
  });

  it("keeps the original timestamp when the row is already read", async () => {
    const alreadyRead = new Date("2026-01-07T11:00:00.000Z");
    h.notification.findUnique.mockResolvedValue(row({ readAt: alreadyRead }));

    const res = await request("/api/notifications/evt-7:GOWNER/read", {
      method: "POST",
      headers: { authorization: `Bearer ${await tokenFor(OWNER)}` },
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { readAt: string }).readAt).toBe(alreadyRead.toISOString());
    expect(h.notification.update).not.toHaveBeenCalled();
  });
});

describe("POST /api/notifications/read-all", () => {
  it("marks every unread row of the caller and reports the count", async () => {
    h.notification.updateMany.mockResolvedValue({ count: 3 });

    const res = await request("/api/notifications/read-all", {
      method: "POST",
      headers: { authorization: `Bearer ${await tokenFor(OWNER)}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 3 });
    expect(h.notification.updateMany).toHaveBeenCalledWith({
      where: { address: OWNER, readAt: null },
      data: { readAt: expect.any(Date) },
    });
  });

  it("is not shadowed by the /:id/read route", async () => {
    h.notification.updateMany.mockResolvedValue({ count: 0 });

    const res = await request("/api/notifications/read-all", {
      method: "POST",
      headers: { authorization: `Bearer ${await tokenFor(OWNER)}` },
    });

    // A `/:id/read` match would have looked the segment "read-all" up as a row.
    expect(res.status).toBe(200);
    expect(h.notification.findUnique).not.toHaveBeenCalled();
  });
});
