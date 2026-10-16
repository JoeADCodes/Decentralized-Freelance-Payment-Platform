import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authenticate,
  buildDirectoryQuery,
  buildJobsQuery,
  createDispute,
  createJob,
  fetchDirectory,
  fetchNotifications,
  linkDisputeId,
  markAllNotificationsRead,
  markNotificationRead,
  submitRating,
} from "./api";

describe("buildJobsQuery", () => {
  it("omits empty filters", () => {
    expect(buildJobsQuery()).toBe("");
    expect(buildJobsQuery({ status: "", client: "", freelancer: "" })).toBe("");
  });

  it("encodes the status filter", () => {
    expect(buildJobsQuery({ status: "ACTIVE" })).toBe("?status=ACTIVE");
  });

  it("encodes pagination and all filters together", () => {
    const qs = buildJobsQuery({
      status: "COMPLETED",
      client: "GABCD",
      freelancer: "GEFGH",
      page: 2,
      limit: 10,
    });
    const params = new URLSearchParams(qs);
    expect(params.get("status")).toBe("COMPLETED");
    expect(params.get("client")).toBe("GABCD");
    expect(params.get("freelancer")).toBe("GEFGH");
    expect(params.get("page")).toBe("2");
    expect(params.get("limit")).toBe("10");
    expect(qs.startsWith("?")).toBe(true);
  });
});

describe("buildDirectoryQuery", () => {
  it("omits empty values and encodes the rest", () => {
    expect(buildDirectoryQuery()).toBe("");
    expect(buildDirectoryQuery({ q: "", sort: undefined })).toBe("");
    expect(
      buildDirectoryQuery({ q: "ada lovelace", sort: "ratings", order: "asc", page: 2, limit: 20 }),
    ).toBe("?q=ada+lovelace&sort=ratings&order=asc&page=2&limit=20");
  });
});

describe("fetchDirectory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the public directory with no token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          users: [
            {
              id: "u1",
              stellarAddress: "GADA",
              displayName: "Ada",
              bio: null,
              createdAt: "2026-01-02T00:00:00.000Z",
              averageScore: 4.5,
              totalRatings: 2,
              jobsAsFreelancer: 3,
              jobsAsClient: 1,
            },
          ],
          page: 1,
          limit: 20,
          total: 1,
          hasMore: false,
          sort: "reputation",
          order: "desc",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchDirectory({ q: "ada", sort: "name" });

    expect(result.users[0]).toMatchObject({ averageScore: 4.5, totalRatings: 2 });
    expect(result.total).toBe(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/users?q=ada&sort=name");
    // The directory is public — no Authorization header is sent.
    expect(init.headers).toBeUndefined();
  });

  it("throws with the status when the API rejects the query", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "bad sort" }), { status: 400 })),
    );

    await expect(fetchDirectory({ sort: "nope" as never })).rejects.toThrow(/HTTP 400/);
  });
});

describe("notification feed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the caller's feed with the bearer token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ unread: 1, notifications: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const feed = await fetchNotifications("jwt-1");

    expect(feed.unread).toBe(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/notifications");
    // The address comes from the token; there is no parameter in the URL to spoof.
    expect(url).not.toContain("?");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-1");
  });

  it("marks one row read by its id", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: "evt-7:GVIEWER", readAt: "2026-01-07T11:00:00.000Z" }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const row = await markNotificationRead("evt-7:GVIEWER", "jwt-1");

    expect(row.readAt).toBe("2026-01-07T11:00:00.000Z");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // The id is a composite key, so it is percent-encoded on the way out.
    expect(url).toContain("/api/notifications/evt-7%3AGVIEWER/read");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-1");
  });

  it("marks every unread row read and reports how many changed", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ updated: 3 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await markAllNotificationsRead("jwt-1")).toBe(3);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/notifications/read-all");
    expect(init.method).toBe("POST");
  });

  it("throws with the status when a read cannot be recorded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })),
    );

    await expect(markNotificationRead("evt-7:GOTHER", "jwt-1")).rejects.toThrow(/HTTP 403/);
  });
});

describe("authenticate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs the challenge nonce and returns the token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ nonce: "nonce-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "jwt-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const signMessage = vi.fn(async () => "sig-base64");

    const token = await authenticate("GCLIENT", signMessage);

    expect(token).toBe("jwt-1");
    expect(signMessage).toHaveBeenCalledWith("nonce-1");
    expect(fetchMock.mock.calls[0][0]).toContain("/api/users/challenge?address=GCLIENT");
    const authBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(authBody).toEqual({
      address: "GCLIENT",
      signature: "sig-base64",
      nonce: "nonce-1",
    });
  });
});

describe("createJob", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the job with the chosen asset and a bearer token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "job-1" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const job = await createJob(
      {
        title: "Redesign",
        description: "A longer description",
        asset: "XLM",
        milestones: [{ amountUsdc: 1.5 }],
      },
      "jwt-1",
    );

    expect(job.id).toBe("job-1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/jobs");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-1");
    expect(JSON.parse(init.body as string).asset).toBe("XLM");
  });
});

describe("submitRating", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the rating with a bearer token and returns the row + xdr", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          rating: { id: "rating-1", jobId: "job-1", score: 5, comment: "great work" },
          xdr: "AAAA",
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await submitRating(
      { jobId: "job-1", rateeAddress: "GRATEE", score: 5, comment: "great work" },
      "jwt-1",
    );

    expect(res.rating.id).toBe("rating-1");
    expect(res.xdr).toBe("AAAA");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/reputation");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-1");
    expect(JSON.parse(init.body as string)).toEqual({
      jobId: "job-1",
      rateeAddress: "GRATEE",
      score: 5,
      comment: "great work",
    });
  });

  it("throws with the status when the API rejects the rating", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 400 })),
    );

    await expect(
      submitRating({ jobId: "job-1", rateeAddress: "GRATEE", score: 5 }, "jwt-1"),
    ).rejects.toThrow(/HTTP 400/);
  });
});

describe("createDispute", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the job id and the reason with a bearer token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          dispute: { id: "dispute-1", jobId: "job-1", onChainId: null, status: "RAISED", reason: "late" },
          xdr: "AAAA",
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await createDispute({ jobId: "job-1", reason: "late" }, "jwt-1");

    // The row exists before the chain knows about the dispute, so its id is what
    // `linkDisputeId` has to carry forward.
    expect(res.dispute.id).toBe("dispute-1");
    expect(res.dispute.onChainId).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/disputes");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-1");
    expect(JSON.parse(init.body as string)).toEqual({ jobId: "job-1", reason: "late" });
  });

  it("throws with the status when the API refuses to record it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 403 })),
    );

    await expect(createDispute({ jobId: "job-1", reason: "late" }, "jwt-1")).rejects.toThrow(
      /HTTP 403/,
    );
  });
});

describe("linkDisputeId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the on-chain id returned by dispute.raise as a number", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: "dispute-1", jobId: "job-1", onChainId: "3", status: "RAISED", reason: "late" }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    // The contract returns a bigint; the route validates an integer, and the
    // column is a BigInt, so it must not be sent as a string.
    const updated = await linkDisputeId("dispute-1", 3n, "jwt-1");

    expect(updated.onChainId).toBe("3");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/disputes/dispute-1/sync");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ onChainId: 3 });
  });

  it("throws with the status when the id cannot be recorded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 403 })),
    );

    await expect(linkDisputeId("dispute-1", 3n, "jwt-1")).rejects.toThrow(/HTTP 403/);
  });
});
