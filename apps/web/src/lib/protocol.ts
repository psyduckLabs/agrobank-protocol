// Espejo 1:1 de contracts/agrobank-protocol/src/lib.rs (i128 → bigint, USDC con 7 decimales).

export const DAY = 17_280; // DAY_IN_LEDGERS
export const ZERO = BigInt(0);
export const BPS_DENOM = BigInt(10_000);
export const ACTIVE_RATE_BPS = 1_800;
export const PASSIVE_RATE_BPS = 1_200;
export const MIN_COLLATERAL_RATIO_BPS = BigInt(13_000);
export const LEDGERS_PER_YEAR = BigInt(365 * DAY); // 6.307.200
export const ACC_PRECISION = BigInt("1000000000000"); // 1e12

/** USDC → unidades i128 (7 decimales). */
export const toU = (x: number): bigint => BigInt(Math.round(x * 1e7));
/** Unidades i128 → USDC (solo para mostrar). */
export const fromU = (u: bigint): number => Number(u) / 1e7;

/** interest_for(): principal × rate_bps × term_ledgers / (10_000 × LEDGERS_PER_YEAR), floor. */
export const interestFor = (pU: bigint, bps: number, term: number): bigint =>
  (pU * BigInt(bps) * BigInt(Math.max(term, 0))) / (BPS_DENOM * LEDGERS_PER_YEAR);

export interface Split {
  total: bigint;
  inv: bigint;
  spread: bigint;
}

/** split_interest(): tesorería por resta, sin polvo perdido. */
export function splitInterest(pU: bigint, term: number): Split {
  const total = interestFor(pU, ACTIVE_RATE_BPS, term);
  const inv = interestFor(pU, PASSIVE_RATE_BPS, term);
  return { total, inv, spread: total - inv };
}

/** meets_collateral_ratio(): aritmética entera. */
export const meetsRatio = (value: number, principal: number): boolean =>
  toU(value) * BPS_DENOM >= toU(principal) * MIN_COLLATERAL_RATIO_BPS;

export interface Position {
  shares: bigint;
  rewardDebt: bigint;
  pending: bigint;
}

/** settle_investor(): pasa a pending todo lo devengado desde el último movimiento. */
export function settle(p: Position, acc: bigint): Position {
  const gross = (p.shares * acc) / ACC_PRECISION;
  return { ...p, pending: p.pending + (gross - p.rewardDebt), rewardDebt: gross };
}
