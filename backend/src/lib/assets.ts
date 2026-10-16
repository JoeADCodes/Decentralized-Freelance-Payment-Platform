/**
 * assets.ts
 *
 * Data-driven registry of the Stellar Asset Contracts (SACs) a job can be paid
 * in. Mirrors `frontend/src/lib/assets.ts`; the contract id is read from config
 * via `configKey`, so adding a new asset is a config entry plus a line here.
 *
 * Kept free of any `config` import so the conversion/registry logic is unit
 * testable without environment variables.
 */

export interface AssetInfo {
  symbol: string;
  /** Number of decimal places the asset uses (USDC and XLM both use 7). */
  decimals: number;
  /** Config key holding the SAC contract id. */
  configKey: "USDC_CONTRACT_ID" | "XLM_CONTRACT_ID";
}

export const ASSETS: Record<string, AssetInfo> = {
  USDC: { symbol: "USDC", decimals: 7, configKey: "USDC_CONTRACT_ID" },
  XLM: { symbol: "XLM", decimals: 7, configKey: "XLM_CONTRACT_ID" },
};

export class UnknownAssetError extends Error {
  constructor(symbol: string) {
    super(`Unknown asset: ${symbol}`);
    this.name = "UnknownAssetError";
  }
}

/** Look up an asset by symbol (case-insensitive). Throws if unknown. */
export function getAsset(symbol: string): AssetInfo {
  const key = symbol.trim().toUpperCase();
  const asset = ASSETS[key];
  if (!asset) throw new UnknownAssetError(symbol);
  return asset;
}

/** Convert a decimal amount (e.g. from Prisma) into integer base units. */
export function toBaseUnits(amount: number | string, decimals: number): bigint {
  const value = typeof amount === "number" ? amount.toFixed(decimals) : amount;
  const negative = value.trim().startsWith("-");
  const [whole = "0", frac = ""] = value.trim().replace("-", "").split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const raw = BigInt(`${whole || "0"}${padded}`);
  return negative ? -raw : raw;
}

/**
 * Sum decimal amounts exactly, returning the total in the asset's integer base
 * units.
 *
 * Money must never be added as JavaScript numbers: `0.1 + 0.2` is
 * `0.30000000000000004`, and because `Job.totalAmountUsdc` is a `DECIMAL(65,30)`
 * column that error is stored verbatim and returned to every client. Converting
 * each amount to base units first — an exact `bigint` — makes the sum exact.
 */
export function sumAmounts(amounts: Array<number | string>, decimals: number): bigint {
  return amounts.reduce<bigint>((total, amount) => total + toBaseUnits(amount, decimals), 0n);
}

/**
 * Render an integer base-unit amount as whole units for an asset symbol.
 *
 * Contract events carry amounts in base units (stroops) because that is what
 * they emit; a human reads whole units. An unregistered symbol falls back to the
 * raw value rather than guessing decimal places.
 */
export function formatBaseUnitsForAsset(
  base: string | number | bigint,
  symbol: string | null | undefined,
): string {
  if (!symbol) return String(base);
  let decimals: number;
  try {
    decimals = getAsset(symbol).decimals;
  } catch {
    return String(base);
  }
  try {
    return formatAmount(typeof base === "bigint" ? base : BigInt(base), decimals);
  } catch {
    return String(base);
  }
}

/**
 * Render integer base units as a plain decimal string — the exact form to store
 * in a Prisma `Decimal` column or return to a client. `3000000` at 7 decimals
 * becomes `"0.3"`; trailing fractional zeros are trimmed.
 */
export function formatAmount(base: bigint, decimals: number): string {
  const negative = base < 0n;
  const digits = (negative ? -base : base).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction =
    decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
