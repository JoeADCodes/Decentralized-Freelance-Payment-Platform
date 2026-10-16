/**
 * Route-level tests for `GET /api/users` — the public directory (issue #68).
 *
 * The database is mocked, so the subject is the route's own contract: which
 * filters it sends, how it joins the reputation aggregate onto each row, the
 * ordering it returns, and that a bad query is a 400 rather than a silently
 * ignored parameter.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

const h = vi.hoisted(() => ({
  user: { findMany: vi.fn() },
  rating: { groupBy: vi.fn() },
}));

vi.mock("../db", () => ({ prisma: { user: h.user, rating: h.rating } }));

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  const { directoryRouter } = await import("../routes/directory");
  const { errorHandler } = await import("../middleware/errorHandler");

  const app = express();
  app.use(express.json());
  app.use("/api/users", directoryRouter);
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
  h.user.findMany.mockReset();
  h.rating.groupBy.mockReset();
  h.rating.groupBy.mockResolvedValue([]);
});

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    stellarAddress: "GADA00000000000000000000000000000000000000000000000000ADA",
    displayName: "Ada",
    bio: "Soroban contracts",
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    _count: { jobsAsFreelancer: 3, jobsAsClient: 1 },
    ...overrides,
  };
}

type DirectoryResponse = {
  users: Array<Record<string, unknown>>;
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  sort: string;
  order: string;
};

async function getDirectory(query = ""): Promise<{ status: number; body: DirectoryResponse }> {
  const res = await fetch(`${baseUrl}/api/users${query}`);
  return { status: res.status, body: (await res.json()) as DirectoryResponse };
}

describe("GET /api/users", () => {
  it("lists users with their reputation and job counts", async () => {
    h.user.findMany.mockResolvedValue([user()]);
    h.rating.groupBy.mockResolvedValue([
      { rateeId: "user-1", _avg: { score: 4.5 }, _count: { score: 2 } },
    ]);

    const { status, body } = await getDirectory();

    expect(status).toBe(200);
    expect(body).toMatchObject({ page: 1, limit: 20, total: 1, hasMore: false });
    expect(body.users[0]).toMatchObject({
      id: "user-1",
      displayName: "Ada",
      averageScore: 4.5,
      totalRatings: 2,
      jobsAsFreelancer: 3,
      jobsAsClient: 1,
    });
    // The reputation join is one grouped query, not one per row.
    expect(h.rating.groupBy).toHaveBeenCalledTimes(1);
    expect(h.rating.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ["rateeId"] }),
    );
  });

  it("reports an unrated user as 0 rather than dropping them", async () => {
    h.user.findMany.mockResolvedValue([user({ id: "user-2", displayName: "Nobody" })]);
    h.rating.groupBy.mockResolvedValue([]);

    const { body } = await getDirectory();

    expect(body.users).toHaveLength(1);
    expect(body.users[0]).toMatchObject({ averageScore: 0, totalRatings: 0 });
  });

  it("orders by reputation by default and honours ?sort=name", async () => {
    h.user.findMany.mockResolvedValue([
      user({ id: "user-1", displayName: "Ada" }),
      user({ id: "user-2", displayName: "Bob" }),
    ]);
    h.rating.groupBy.mockResolvedValue([
      { rateeId: "user-2", _avg: { score: 5 }, _count: { score: 3 } },
      { rateeId: "user-1", _avg: { score: 2 }, _count: { score: 1 } },
    ]);

    const ranked = await getDirectory();
    expect(ranked.body.users.map((u) => u.id)).toEqual(["user-2", "user-1"]);
    expect(ranked.body.sort).toBe("reputation");

    const byName = await getDirectory("?sort=name&order=asc");
    expect(byName.body.users.map((u) => u.id)).toEqual(["user-1", "user-2"]);
    expect(byName.body).toMatchObject({ sort: "name", order: "asc" });
  });

  it("pages the directory and says whether more remain", async () => {
    h.user.findMany.mockResolvedValue([
      user({ id: "user-1", displayName: "Ada" }),
      user({ id: "user-2", displayName: "Bob" }),
      user({ id: "user-3", displayName: "Cleo" }),
    ]);

    const first = await getDirectory("?limit=2&page=1");
    expect(first.body).toMatchObject({ page: 1, limit: 2, total: 3, hasMore: true });
    expect(first.body.users.map((u) => u.id)).toEqual(["user-1", "user-2"]);

    const second = await getDirectory("?limit=2&page=2");
    expect(second.body).toMatchObject({ page: 2, total: 3, hasMore: false });
    expect(second.body.users.map((u) => u.id)).toEqual(["user-3"]);
  });

  it("searches names, bios and addresses case-insensitively", async () => {
    h.user.findMany.mockResolvedValue([]);

    await getDirectory("?q=ada");

    expect(h.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { displayName: { contains: "ada", mode: "insensitive" } },
            { bio: { contains: "ada", mode: "insensitive" } },
            { stellarAddress: { startsWith: "ada" } },
          ],
        },
      }),
    );
  });

  it("sends no where clause when there is no search term", async () => {
    h.user.findMany.mockResolvedValue([]);

    await getDirectory();
    await getDirectory("?q=");

    // `contains: ""` matches every row, so a blank query must not become a filter.
    for (const call of h.user.findMany.mock.calls) {
      expect(call[0].where).toEqual({});
    }
  });

  it("rejects an unknown sort or an out-of-range page size", async () => {
    const badSort = await getDirectory("?sort=score");
    expect(badSort.status).toBe(400);
    expect(h.user.findMany).not.toHaveBeenCalled();

    const tooBig = await getDirectory("?limit=101");
    expect(tooBig.status).toBe(400);

    const badPage = await getDirectory("?page=0");
    expect(badPage.status).toBe(400);
  });

  it("returns an empty page for a directory nobody is in", async () => {
    h.user.findMany.mockResolvedValue([]);

    const { status, body } = await getDirectory();

    expect(status).toBe(200);
    expect(body.users).toEqual([]);
    expect(body).toMatchObject({ total: 0, hasMore: false });
  });
});
