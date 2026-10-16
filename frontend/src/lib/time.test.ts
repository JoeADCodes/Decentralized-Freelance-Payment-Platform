import { describe, expect, it } from "vitest";
import { formatDeadline, formatRelativeTime, formatRemaining, secondsUntil } from "./time";

describe("secondsUntil", () => {
  it("counts down to the deadline in whole seconds", () => {
    expect(secondsUntil(1_700_000_000n, 1_699_999_940)).toBe(60);
  });

  it("floors at zero once the deadline has passed", () => {
    // The contract allows reclaim only strictly after the deadline, so a
    // non-positive countdown is the UI's signal that the action is live.
    expect(secondsUntil(1_700_000_000n, 1_700_000_000)).toBe(0);
    expect(secondsUntil(1_700_000_000n, 1_700_000_001)).toBe(0);
  });
});

describe("formatRemaining", () => {
  it("picks the two most significant units", () => {
    expect(formatRemaining(2 * 86_400 + 3 * 3_600)).toBe("2d 3h");
    expect(formatRemaining(3 * 3_600 + 4 * 60)).toBe("3h 4m");
    expect(formatRemaining(4 * 60 + 5)).toBe("4m 5s");
    expect(formatRemaining(12)).toBe("12s");
    expect(formatRemaining(0)).toBe("0s");
  });
});

describe("formatDeadline", () => {
  it("renders the deadline as a wall-clock time", () => {
    // `toLocaleString` output is locale/zone dependent, so assert on the year.
    expect(formatDeadline(1_700_000_000n)).toMatch(/2023/);
  });
});

// The notification feed reads as "how long ago", so every step of the label is
// pinned here: a number that drifts into the wrong unit is a wrong claim about
// when something happened (issue #66).
describe("formatRelativeTime", () => {
  const now = Date.parse("2026-01-07T12:00:00.000Z");
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it("describes the smallest unit that fits", () => {
    expect(formatRelativeTime(ago(0), now)).toBe("just now");
    expect(formatRelativeTime(ago(59), now)).toBe("just now");
    expect(formatRelativeTime(ago(60), now)).toBe("1m ago");
    expect(formatRelativeTime(ago(59 * 60), now)).toBe("59m ago");
    expect(formatRelativeTime(ago(3_600), now)).toBe("1h ago");
    expect(formatRelativeTime(ago(23 * 3_600), now)).toBe("23h ago");
    expect(formatRelativeTime(ago(86_400), now)).toBe("1d ago");
    expect(formatRelativeTime(ago(6 * 86_400), now)).toBe("6d ago");
  });

  it("falls back to a date once the news is old", () => {
    // `toLocaleDateString` output is locale/zone dependent, so as in
    // `formatDeadline` the assertion is on the year, not the layout.
    expect(formatRelativeTime(ago(30 * 86_400), now)).toContain("2025");
    expect(formatRelativeTime(ago(30 * 86_400), now)).not.toContain("ago");
  });

  it("reads a future timestamp as now rather than a negative age", () => {
    // Server and browser clocks differ by seconds in practice.
    expect(formatRelativeTime(ago(-10), now)).toBe("just now");
  });

  it("returns nothing for a value that is not a date", () => {
    expect(formatRelativeTime("not a date", now)).toBe("");
  });
});
