import { describe, expect, it } from "vitest";
import {
  directoryPage,
  directoryQuerySchema,
  sortDirectoryEntries,
  type DirectoryEntry,
} from "../lib/directory";

// Two addresses that differ only in their first characters, so the tie-break on
// address is easy to read. Only their order matters here; the route is what
// validates that an address is a real strkey.
const FIRST_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const SECOND_ADDRESS = "GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B";

/** A directory row with sensible defaults, overridden per test. */
function entry(overrides: Partial<DirectoryEntry> & { id: string }): DirectoryEntry {
  return {
    stellarAddress: `G${overrides.id.toUpperCase().padEnd(55, "A")}`,
    displayName: null,
    bio: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    averageScore: 0,
    totalRatings: 0,
    jobsAsFreelancer: 0,
    jobsAsClient: 0,
    ...overrides,
  };
}

const ada = entry({
  id: "ada",
  stellarAddress: SECOND_ADDRESS,
  displayName: "Ada",
  averageScore: 4.5,
  totalRatings: 2,
  createdAt: new Date("2026-01-02T00:00:00.000Z"),
});
const bob = entry({
  id: "bob",
  stellarAddress: FIRST_ADDRESS,
  displayName: "bob",
  averageScore: 5,
  totalRatings: 1,
  createdAt: new Date("2026-01-03T00:00:00.000Z"),
});
const carol = entry({
  id: "carol",
  displayName: "carol",
  averageScore: 4.5,
  totalRatings: 9,
  jobsAsFreelancer: 4,
  createdAt: new Date("2026-01-04T00:00:00.000Z"),
});
const nobody = entry({ id: "nobody" });

describe("sortDirectoryEntries", () => {
  it("sorts by reputation, highest first, by default", () => {
    // Bob's single 5 beats Ada's 4.5; nobody unrated ranks last.
    expect(sortDirectoryEntries([ada, bob, nobody], "reputation", "desc").map((e) => e.id)).toEqual(
      ["bob", "ada", "nobody"],
    );
  });

  it("gives the order only to the primary key", () => {
    expect(sortDirectoryEntries([ada, bob, nobody], "reputation", "asc").map((e) => e.id)).toEqual(
      // Ties are still broken by rating count, not reversed with the key.
      ["nobody", "ada", "bob"],
    );
  });

  it("breaks a reputation tie on how many ratings it is over", () => {
    // Same 4.5 average: carol's nine ratings are the stronger signal.
    expect(
      sortDirectoryEntries([ada, carol], "reputation", "desc").map((e) => e.id),
    ).toEqual(["carol", "ada"]);
  });

  it("sorts by rating count, job count and join date", () => {
    const all = [ada, bob, carol, nobody];
    expect(sortDirectoryEntries(all, "ratings", "desc").map((e) => e.id)[0]).toBe("carol");
    expect(sortDirectoryEntries(all, "jobs", "desc").map((e) => e.id)[0]).toBe("carol");
    expect(sortDirectoryEntries(all, "joined", "desc").map((e) => e.id)[0]).toBe("carol");
    expect(sortDirectoryEntries(all, "joined", "asc").map((e) => e.id)[0]).toBe("nobody");
  });

  it("sorts by display name case-insensitively, falling back to the address", () => {
    // `bob` is lowercase; a naive comparison would sort it after `Ada`.
    expect(sortDirectoryEntries([ada, bob], "name", "asc").map((e) => e.id)).toEqual(["ada", "bob"]);
    // A user with no display name is ordered by its address, which is a total
    // order: it falls after a name starting before `g`, and before one after it.
    const unnamed = entry({
      id: "unnamed",
      displayName: null,
      stellarAddress: FIRST_ADDRESS,
    });
    const zoe = entry({ id: "zoe", displayName: "Zoe", stellarAddress: SECOND_ADDRESS });
    expect(
      sortDirectoryEntries([zoe, unnamed], "name", "asc").map((e) => e.id),
    ).toEqual([unnamed.id, zoe.id]);
    expect(
      sortDirectoryEntries([zoe, unnamed], "name", "asc")[0].stellarAddress,
    ).toBe(FIRST_ADDRESS);
  });

  it("is deterministic for rows that are equal on every key", () => {
    // Identical rows must not swap between requests, or a paginated listing can
    // show the same user twice and drop another.
    const first = entry({ id: "first", stellarAddress: SECOND_ADDRESS });
    const second = entry({ id: "second", stellarAddress: FIRST_ADDRESS });

    const once = sortDirectoryEntries([first, second], "reputation", "desc").map((e) => e.id);
    const again = sortDirectoryEntries([second, first], "reputation", "desc").map((e) => e.id);

    expect(once).toEqual(again);
    expect(once).toEqual(["second", "first"]); // FIRST_ADDRESS sorts first
  });

  it("does not mutate the array it was given", () => {
    const input = [ada, bob];
    sortDirectoryEntries(input, "reputation", "desc");
    expect(input.map((e) => e.id)).toEqual(["ada", "bob"]);
  });
});

describe("directoryPage", () => {
  const sorted = [ada, bob, carol, nobody];

  it("slices the requested page and reports the whole total", () => {
    expect(directoryPage(sorted, 1, 2)).toMatchObject({
      page: 1,
      limit: 2,
      total: 4,
      hasMore: true,
    });
    expect(directoryPage(sorted, 1, 2).rows.map((e) => e.id)).toEqual(["ada", "bob"]);
    expect(directoryPage(sorted, 2, 2).rows.map((e) => e.id)).toEqual(["carol", "nobody"]);
    expect(directoryPage(sorted, 2, 2).hasMore).toBe(false);
  });

  it("returns an empty page past the end rather than the last one", () => {
    expect(directoryPage(sorted, 5, 2).rows).toEqual([]);
    expect(directoryPage(sorted, 5, 2).hasMore).toBe(false);
  });

  it("handles an empty directory", () => {
    expect(directoryPage([], 1, 20)).toMatchObject({ rows: [], total: 0, hasMore: false });
  });
});

describe("directoryQuerySchema", () => {
  it("defaults to the ranked page a visitor sees first", () => {
    expect(directoryQuerySchema.parse({})).toEqual({
      sort: "reputation",
      order: "desc",
      page: 1,
      limit: 20,
    });
  });

  it("coerces the numeric query values", () => {
    expect(directoryQuerySchema.parse({ page: "3", limit: "50" })).toMatchObject({
      page: 3,
      limit: 50,
    });
  });

  it("rejects an unknown sort instead of silently ignoring it", () => {
    expect(directoryQuerySchema.safeParse({ sort: "score" }).success).toBe(false);
    expect(directoryQuerySchema.safeParse({ order: "sideways" }).success).toBe(false);
  });

  it("rejects a page size beyond the cap and non-positive pages", () => {
    expect(directoryQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(directoryQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(directoryQuerySchema.safeParse({ page: "0" }).success).toBe(false);
    expect(directoryQuerySchema.safeParse({ page: "abc" }).success).toBe(false);
  });

  it("trims a search term and treats a blank one as absent", () => {
    expect(directoryQuerySchema.parse({ q: " ada " }).q).toBe("ada");
    // `q=""` must not become a `contains: ""` filter, which matches everyone.
    expect(directoryQuerySchema.parse({ q: "" }).q).toBe("");
  });
});
