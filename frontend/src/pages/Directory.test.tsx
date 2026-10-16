/**
 * Directory.test.tsx
 *
 * The directory is public, so nothing here needs a wallet: the subject is the
 * list itself — the reputation shown, that each entry links to the existing
 * Profile page, and that the sort/search controls reach the API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ fetchDirectory: vi.fn() }));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, fetchDirectory: h.fetchDirectory };
});

vi.mock("react-router-dom", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

import Directory from "./Directory";

const ADA = "GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B";
const NOBODY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

const ada = {
  id: "user-1",
  stellarAddress: ADA,
  displayName: "Ada",
  bio: "Soroban contracts",
  createdAt: "2026-01-02T00:00:00.000Z",
  averageScore: 4.5,
  totalRatings: 2,
  jobsAsFreelancer: 3,
  jobsAsClient: 1,
};

const nobody = {
  ...ada,
  id: "user-2",
  stellarAddress: NOBODY,
  displayName: null,
  bio: null,
  averageScore: 0,
  totalRatings: 0,
  jobsAsFreelancer: 0,
  jobsAsClient: 0,
};

function result(users: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    users,
    page: 1,
    limit: 20,
    total: users.length,
    hasMore: false,
    sort: "reputation",
    order: "desc",
    ...overrides,
  };
}

/** The arguments of the most recent `fetchDirectory` call. */
function lastDirectoryQuery(): Record<string, unknown> {
  const calls = h.fetchDirectory.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  h.fetchDirectory.mockReset();
  h.fetchDirectory.mockResolvedValue(result([ada, nobody]));
});

afterEach(() => cleanup());

describe("Directory", () => {
  it("lists every user with their reputation", async () => {
    render(<Directory />);

    expect(await screen.findByText("Ada")).toBeTruthy();
    expect(screen.getByText(/4\.50 \/ 5 from 2 rating\(s\)/)).toBeTruthy();
    // An unrated user is shown as such rather than hidden.
    expect(screen.getByText("Anonymous freelancer")).toBeTruthy();
    expect(screen.getByText(/^Not rated yet/)).toBeTruthy();
    expect(screen.getByText(/^2 freelancers/)).toBeTruthy();
  });

  it("links each entry to the existing Profile page", async () => {
    render(<Directory />);

    const links = await screen.findAllByRole("link", { name: "View profile" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `/profile/${ADA}`,
      `/profile/${NOBODY}`,
    ]);
  });

  it("asks the API for the highest reputation first by default", async () => {
    render(<Directory />);
    await waitFor(() => expect(h.fetchDirectory).toHaveBeenCalled());

    expect(h.fetchDirectory.mock.calls[0][0]).toEqual({
      q: undefined,
      sort: "reputation",
      order: "desc",
      page: 1,
      limit: 20,
    });
  });

  it("re-queries when the sort key changes", async () => {
    render(<Directory />);
    await waitFor(() => expect(h.fetchDirectory).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "jobs" } });

    await waitFor(() =>
      expect(lastDirectoryQuery()).toMatchObject({ sort: "jobs" }),
    );
  });

  it("searches on submit, not on every keystroke", async () => {
    render(<Directory />);
    await waitFor(() => expect(h.fetchDirectory).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Search the directory"), {
      target: { value: "ada" },
    });
    // Typing alone must not issue a request against the public endpoint.
    expect(h.fetchDirectory).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => expect(lastDirectoryQuery()).toMatchObject({ q: "ada" }));
  });

  it("says so when a search matches nobody", async () => {
    h.fetchDirectory.mockResolvedValue(result([]));
    render(<Directory />);

    fireEvent.change(screen.getByLabelText("Search the directory"), {
      target: { value: "nobody" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText(/No freelancers match “nobody”/)).toBeTruthy();
  });

  it("reports a failed load instead of an empty directory", async () => {
    h.fetchDirectory.mockRejectedValue(new Error("Could not load the directory (HTTP 500)"));
    render(<Directory />);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not load the directory (HTTP 500)",
    );
  });

  it("loads the next page when more remain", async () => {
    // Two distinct pages, so appending them produces a list of two users.
    h.fetchDirectory.mockResolvedValueOnce(result([ada], { total: 2, hasMore: true }));
    h.fetchDirectory.mockResolvedValueOnce(result([nobody], { page: 2, total: 2 }));
    render(<Directory />);

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));

    await waitFor(() => expect(lastDirectoryQuery()).toMatchObject({ page: 2 }));
    expect(await screen.findByText("Anonymous freelancer")).toBeTruthy();
  });
});
