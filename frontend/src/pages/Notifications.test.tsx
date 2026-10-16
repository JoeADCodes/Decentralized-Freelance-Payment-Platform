/**
 * Notifications.test.tsx
 *
 * The feed is read state, so the cases that matter are: it only appears after
 * the wallet has been authenticated, it shows what the indexer wrote, and read
 * state changes only ever go through the API with the caller's own token.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  authenticate: vi.fn(),
  fetchNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, ...h };
});

const h2 = vi.hoisted(() => ({
  wallet: {
    publicKey: "GVIEWER" as string | null,
    connect: vi.fn(async () => "GVIEWER"),
    connecting: false,
    signMessage: vi.fn(async () => "sig"),
  },
}));
vi.mock("../hooks/wallet-context", () => ({ useWallet: () => h2.wallet }));
// The page only uses `Link`, which needs a Router context the test has no use for.
vi.mock("react-router-dom", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

import Notifications from "./Notifications";

const NOW = "2026-01-07T10:00:00.000Z";

/**
 * The unread summary mixes elements (`<code>` + `<strong>`), so neither a plain
 * text nor a single-node match finds it — compare its whole text instead.
 */
function badge(text: string) {
  return screen.getByText((_content, el) => el?.textContent === text);
}

function notification(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-7:GVIEWER",
    type: "funded",
    title: "Escrow funded",
    body: "2.5 USDC is now held in escrow — work can start.",
    escrowId: "7",
    jobId: "job-1",
    readAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  for (const fn of Object.values(h2.wallet)) {
    if (typeof fn === "function") (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  h2.wallet.publicKey = "GVIEWER";
  h2.wallet.connecting = false;
  h.authenticate.mockResolvedValue("jwt-1");
  h.fetchNotifications.mockResolvedValue({ unread: 1, notifications: [notification()] });
  h.markNotificationRead.mockResolvedValue(notification({ readAt: NOW }));
  h.markAllNotificationsRead.mockResolvedValue(1);
  h2.wallet.connect.mockResolvedValue("GVIEWER");
  h2.wallet.signMessage.mockResolvedValue("sig");
});

afterEach(() => cleanup());

describe("Notifications", () => {
  it("authenticates the wallet before fetching the feed", async () => {
    render(<Notifications />);

    expect(await screen.findByText("Escrow funded")).toBeTruthy();
    expect(h.authenticate).toHaveBeenCalledWith("GVIEWER", h2.wallet.signMessage);
    expect(h.fetchNotifications).toHaveBeenCalledWith("jwt-1", expect.anything());
    expect(badge("For GVIEWER · 1 unread")).toBeTruthy();
  });

  it("shows what the indexer wrote for each event", async () => {
    h.fetchNotifications.mockResolvedValue({
      unread: 2,
      notifications: [
        notification(),
        notification({
          id: "evt-9:GVIEWER",
          type: "milestone_released",
          title: "Milestone 1 released",
          body: "Milestone 1 · 1.5 USDC released to the freelancer.",
        }),
      ],
    });

    render(<Notifications />);

    expect(await screen.findByText("Escrow funded")).toBeTruthy();
    expect(screen.getByText("Milestone 1 released")).toBeTruthy();
    expect(screen.getByText(/released to the freelancer/)).toBeTruthy();
    // Every row links to the job it is about.
    expect(screen.getAllByRole("link")[0].getAttribute("href")).toBe("/jobs/7");
  });

  it("offers to connect a wallet instead of fetching a feed for nobody", async () => {
    h2.wallet.publicKey = null;
    render(<Notifications />);

    expect(await screen.findByText(/Connect your Freighter wallet/)).toBeTruthy();
    expect(h.fetchNotifications).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Connect your Freighter wallet/ }));
    await waitFor(() => expect(h2.wallet.connect).toHaveBeenCalled());
  });

  it("marks one row read and never shows it as unread again", async () => {
    render(<Notifications />);
    await screen.findByText("Escrow funded");

    fireEvent.click(screen.getByRole("button", { name: "Mark as read" }));

    await waitFor(() =>
      expect(h.markNotificationRead).toHaveBeenCalledWith("evt-7:GVIEWER", "jwt-1"),
    );
    // The row flips in place and the badge drops, without a second fetch.
    expect(await screen.findByText("Read")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark as read" })).toBeNull();
    expect(h.fetchNotifications).toHaveBeenCalledTimes(1);
  });

  it("marks every row read at once", async () => {
    render(<Notifications />);
    await screen.findByText("Escrow funded");

    // The next read of the feed returns what the server now thinks.
    h.markAllNotificationsRead.mockResolvedValue(1);
    h.fetchNotifications.mockResolvedValue({
      unread: 0,
      notifications: [notification({ readAt: NOW })],
    });

    fireEvent.click(screen.getByRole("button", { name: "Mark all as read" }));

    await waitFor(() => expect(h.markAllNotificationsRead).toHaveBeenCalledWith("jwt-1"));
    // The badge is re-derived from a fresh feed rather than guessed at locally.
    await waitFor(() => expect(h.fetchNotifications).toHaveBeenCalledTimes(2));
    expect(badge("For GVIEWER · Nothing unread")).toBeTruthy();
  });

  it("says so when the feed is empty", async () => {
    h.fetchNotifications.mockResolvedValue({ unread: 0, notifications: [] });

    render(<Notifications />);

    expect(await screen.findByText("No notifications yet.")).toBeTruthy();
  });

  it("reports a failed read instead of silently clearing the badge", async () => {
    h.markNotificationRead.mockRejectedValue(
      new Error("Could not mark the notification read (HTTP 403)"),
    );

    render(<Notifications />);
    await screen.findByText("Escrow funded");
    fireEvent.click(screen.getByRole("button", { name: "Mark as read" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not mark the notification read (HTTP 403)",
    );
    // The row is still unread: the local update only happens after a success.
    expect(screen.getByRole("button", { name: "Mark as read" })).toBeTruthy();
  });

  it("surfaces an authentication failure rather than an empty feed", async () => {
    h.authenticate.mockRejectedValue(new Error("Authentication failed (HTTP 401)"));

    render(<Notifications />);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Authentication failed (HTTP 401)",
    );
    expect(h.fetchNotifications).not.toHaveBeenCalled();
    expect(screen.queryByText("No notifications yet.")).toBeNull();
  });

  it("reports a failed feed load", async () => {
    h.fetchNotifications.mockRejectedValue(new Error("Could not load notifications (HTTP 500)"));

    render(<Notifications />);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not load notifications (HTTP 500)",
    );
    expect(screen.queryByText("No notifications yet.")).toBeNull();
  });
});
