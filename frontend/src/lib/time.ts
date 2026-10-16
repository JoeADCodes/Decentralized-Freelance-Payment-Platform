/**
 * time.ts
 *
 * Formatting helpers for the dispute timelock. The contract stores deadline and
 * ledger time as unix seconds (`u64`), so these work in seconds rather than
 * milliseconds and never assume a timezone beyond the viewer's locale.
 *
 * Kept out of the page components so they stay pure and testable, and so the
 * files that render them export only components (react-refresh).
 */

/** Whole seconds from `now` (unix seconds) until `deadline`, floored at zero. */
export function secondsUntil(deadline: bigint, now: number): number {
  const diff = Number(deadline) - now;
  return diff > 0 ? diff : 0;
}

/** A coarse countdown, e.g. `2d 3h` / `3h 4m` / `12s`. */
export function formatRemaining(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const secs = seconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/** The deadline as a local wall-clock time, so a client knows when to return. */
export function formatDeadline(deadline: bigint): string {
  return new Date(Number(deadline) * 1000).toLocaleString();
}

/**
 * A short "how long ago" label for a past timestamp, e.g. `just now`, `5m ago`,
 * `3h ago`, `2d ago`.
 *
 * The notification feed is read top-down and news is only interesting while it
 * is fresh, so it shows age rather than a wall-clock time. `nowMs` is passed in
 * rather than read from the clock so the wording is testable.
 *
 * Anything older than a week falls back to the local date, which says more than
 * `63d ago` does. A timestamp in the future (a clock difference between the
 * server and the browser) reads as `just now` rather than a negative age.
 */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";

  const seconds = Math.floor((nowMs - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}
