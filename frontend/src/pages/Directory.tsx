/**
 * Directory.tsx
 *
 * Public freelancer directory (issue #68). Before this page the only way to see
 * someone's reputation was to already have their address — so the page is a
 * searchable, sortable list of users that links each one to the Profile page
 * that already existed.
 *
 * The score shown is the API's `averageScore` over `totalRatings`; an address
 * nobody has rated is listed as such rather than hidden, because "no history
 * yet" is what a client needs to see to make the judgement themselves.
 *
 * Search is submitted rather than fired per keystroke: the endpoint is public
 * and unauthenticated, and a request per character would be a load amplifier for
 * no benefit on a list this size.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import AddressField from "../components/AddressField";
import { fetchDirectory, DIRECTORY_SORTS } from "../lib/api";
import type { DirectoryResult, DirectorySort } from "../lib/api";

const PAGE_SIZE = 20;

/** What each sort key is called on screen. */
const SORT_LABELS: Record<DirectorySort, string> = {
  reputation: "Reputation",
  ratings: "Number of ratings",
  jobs: "Jobs",
  name: "Name",
  joined: "Newest",
};

export default function Directory() {
  const [sort, setSort] = useState<DirectorySort>("reputation");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");

  const [result, setResult] = useState<DirectoryResult | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (pageToLoad: number, append: boolean, signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchDirectory(
          { q: query || undefined, sort, order, page: pageToLoad, limit: PAGE_SIZE },
          signal,
        );
        setResult((previous) =>
          append && previous
            ? { ...data, users: [...previous.users, ...data.users] }
            : data,
        );
        setPage(pageToLoad);
      } catch (e) {
        // A superseded request is not a failure to report.
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [query, sort, order],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(1, false, controller.signal);
    return () => controller.abort();
  }, [load]);

  const users = result?.users ?? [];

  return (
    <Layout>
      <h1>Freelancers</h1>
      <p className="muted">
        Everyone on the platform, ranked by their on-chain reputation. Open a
        profile to see how the score was earned.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(search.trim());
        }}
      >
        <label>
          Search{" "}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="name, bio or address"
            aria-label="Search the directory"
          />
        </label>{" "}
        <button type="submit">Search</button>{" "}
        <label>
          Sort by{" "}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as DirectorySort)}
          >
            {DIRECTORY_SORTS.map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          Order{" "}
          <select value={order} onChange={(e) => setOrder(e.target.value as "asc" | "desc")}>
            <option value="desc">High to low</option>
            <option value="asc">Low to high</option>
          </select>
        </label>
      </form>

      {error && (
        <p role="alert" className="alert alert-error">
          {error}
        </p>
      )}

      {loading && users.length === 0 && <p>Loading freelancers…</p>}

      {!loading && !error && users.length === 0 && (
        <p className="muted">
          {query
            ? `No freelancers match “${query}”.`
            : "Nobody has joined the directory yet."}
        </p>
      )}

      {result && users.length > 0 && (
        <>
          <p className="muted">
            {result.total} {result.total === 1 ? "freelancer" : "freelancers"}
            {query ? ` matching “${query}”` : ""} · page {result.page}
          </p>
          <ul className="directory-list">
            {users.map((user) => (
              <li key={user.id}>
                <strong>
                  {user.displayName?.trim() ? user.displayName : "Anonymous freelancer"}
                </strong>{" "}
                <AddressField
                  address={user.stellarAddress}
                  label={`Address for ${user.displayName ?? "freelancer"}`}
                  truncate
                />
                <p className="muted">
                  {user.totalRatings > 0
                    ? `★ ${user.averageScore.toFixed(2)} / 5 from ${user.totalRatings} rating(s)`
                    : "Not rated yet"}
                  {" · "}
                  {user.jobsAsFreelancer} job(s) as freelancer · {user.jobsAsClient} as client
                </p>
                {user.bio?.trim() && <p>{user.bio}</p>}
                <Link to={`/profile/${user.stellarAddress}`}>View profile</Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {result?.hasMore && (
        <button disabled={loading} onClick={() => void load(page + 1, true)}>
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </Layout>
  );
}
