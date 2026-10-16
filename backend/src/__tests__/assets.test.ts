import { describe, it, expect } from "vitest";
import {
  formatAmount,
  formatBaseUnitsForAsset,
  getAsset,
  sumAmounts,
  toBaseUnits,
  UnknownAssetError,
} from "../lib/assets";

describe("asset registry", () => {
  it("converts amounts using each asset's decimals", () => {
    expect(toBaseUnits("1.5", getAsset("USDC").decimals)).toBe(15_000_000n);
    expect(toBaseUnits("0.1", getAsset("XLM").decimals)).toBe(1_000_000n);
    // Trailing precision is padded to the asset's scale.
    expect(toBaseUnits(2, getAsset("USDC").decimals)).toBe(20_000_000n);
  });

  it("looks up assets case-insensitively", () => {
    expect(getAsset("usdc").symbol).toBe("USDC");
    expect(getAsset(" Xlm ").symbol).toBe("XLM");
  });

  it("rejects an unknown asset", () => {
    expect(() => getAsset("DOGE")).toThrow(UnknownAssetError);
  });
});

describe("exact money arithmetic", () => {
  const decimals = getAsset("USDC").decimals;

  it("sums decimal amounts in base units instead of floats", () => {
    // The bug this guards: IEEE-754 addition is not exact.
    expect(0.1 + 0.1 + 0.1).not.toBe(0.3);
    expect([0.1, 0.1, 0.1].reduce((sum, n) => sum + n, 0)).toBe(0.30000000000000004);

    // Three 0.1 milestones sum to exactly 0.3, not 0.30000000000000004.
    expect(sumAmounts([0.1, 0.1, 0.1], decimals)).toBe(3_000_000n);
    expect(formatAmount(sumAmounts([0.1, 0.1, 0.1], decimals), decimals)).toBe("0.3");
  });

  it("handles the 0.1 + 0.2 case and mixed number/string inputs", () => {
    expect(formatAmount(sumAmounts([0.1, 0.2], decimals), decimals)).toBe("0.3");
    // A decimal string is exact on arrival; a number is already a binary float.
    expect(formatAmount(sumAmounts(["0.1", "0.2"], decimals), decimals)).toBe("0.3");
    expect(formatAmount(sumAmounts([1, "0.5"], decimals), decimals)).toBe("1.5");
  });

  it("formats base units without trailing zeros", () => {
    expect(formatAmount(3_000_000n, 7)).toBe("0.3");
    expect(formatAmount(20_000_000n, 7)).toBe("2");
    expect(formatAmount(0n, 7)).toBe("0");
    expect(formatAmount(123_456_789n, 7)).toBe("12.3456789");
  });
});

// Contract events carry amounts in base units; a notification body has to show a
// human whole units (issue #66).
describe("formatBaseUnitsForAsset", () => {
  it("converts base units using the asset's decimals", () => {
    expect(formatBaseUnitsForAsset(25_000_000n, "USDC")).toBe("2.5");
    expect(formatBaseUnitsForAsset(25_000_000, "usdc")).toBe("2.5");
    expect(formatBaseUnitsForAsset("15000000", "XLM")).toBe("1.5");
  });

  it("falls back to the raw value when the asset is unknown or missing", () => {
    // Guessing decimal places for an unrecognised symbol would print a wrong
    // amount, which is worse than printing the base units it actually got.
    expect(formatBaseUnitsForAsset(25_000_000n, "DOGE")).toBe("25000000");
    expect(formatBaseUnitsForAsset(25_000_000n, null)).toBe("25000000");
    expect(formatBaseUnitsForAsset(25_000_000n, undefined)).toBe("25000000");
  });

  it("falls back rather than throwing on a non-numeric amount", () => {
    expect(formatBaseUnitsForAsset("not-a-number" as unknown as bigint, "USDC")).toBe(
      "not-a-number",
    );
  });
});
