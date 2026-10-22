import type { AnalysisSource } from "@dave/trading";
import { getTickState } from "./autonomous-tick-state.js";

/**
 * The CHEAP PRE-SCREEN (the dead-pair walk): the round-robin used to pay the full cost for every
 * slot -- the whole multi-timeframe suite with deep candles, then a full model call -- even for a
 * pair the model JUST skipped and where price has not moved since. That is how hours of the loop
 * burned on scanners that could not see anything new. Now a plain `price` endpoint call (one quick
 * round trip, not a suite) is compared against the numbers the model actually decided on last:
 *
 *   - the last real decision on this symbol was a SKIP, made within the recency window, and
 *   - the symbol's ATR is known, and
 *   - price has moved less than a small fraction of that ATR since -- i.e. nothing new at all,
 *
 * -> the whole expensive read is skipped, the cursor advances, and the tick walks on to the next
 * pair using the SAME budget the ticket used to spend on one symbol.
 *
 * Never applied to an alert-focus scan (the trader's own alert started it -- look at the pair,
 * now) or a requested-next-symbol override (Dave asked for it himself -- deciding again). A baseline
 * the tick can't produce (no suite price, no ATR) simply never skips. A decisive scan (BUY, SELL,
 * MODIFY, DELETE_TICKET, ASK...) removes the SKIP state, so the pair is never pre-screened past a
 * scan where the model acted.
 */

/** How long after the recorded SKIP the cheap skip is still allowed at all. Past this the model's
 *  look is too old to lean on -- let it see fresh data again. */
const MAX_AGE_MS = 45 * 60_000;

/** A move smaller than this fraction of the pair's ATR is a twitch, not a change of picture. */
const MOVE_FRACTION_OF_ATR = 0.15;

interface ScanBaseline {
  /** The suite fetch the model's last look was built on. */
  ts: number;
  /** The suite's own price reference at that moment (what "the market" was to the model). */
  price: number;
  /** The shortest-timeframe ATR known from the same suite -- the pair's own stride. */
  atr: number;
}

// In-memory on purpose: a fresh process has no baselines and simply scans normally until it has
// looked at each pair once -- nothing to migrate, nothing to persist. The DECISION half of the
// precondition (was the model's last look here a SKIP, and when) comes from the persistent tick
// state's per-symbol mirror, so it survives restarts.
const baselines = new Map<string, Map<string, ScanBaseline>>();

function storeFor(userId: string): Map<string, ScanBaseline> {
  let m = baselines.get(userId);
  if (!m) {
    m = new Map();
    baselines.set(userId, m);
  }
  return m;
}

function upper(symbol: string): string {
  return symbol.toUpperCase();
}

/** The pair's ATR from one "all" suite node -- `volatility.atr` is object-shaped
 *  ({ value, percentile_200 }, per DaveEA's C_Volatility) and the older tick path assumed a plain
 *  number, so accept both honestly. */
export function suiteNodeAtr(node: unknown): number | undefined {
  if (node === null || typeof node !== "object") return undefined;
  const vol = (node as Record<string, unknown>).volatility;
  if (vol === null || typeof vol !== "object") return undefined;
  const atr = (vol as Record<string, unknown>).atr;
  if (typeof atr === "number" && Number.isFinite(atr) && atr > 0) return atr;
  if (atr !== null && typeof atr === "object") {
    const value = (atr as Record<string, unknown>).value;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function positive(x: number | undefined): number | undefined {
  return x !== undefined && Number.isFinite(x) && x > 0 ? x : undefined;
}

/**
 * Anchors the baseline: what the tick's suite genuinely showed the model just before it decides.
 * Called once per completed suite fetch, not per exit -- the numbers, not the outcome, are what
 * the walk compares against. A missing number leaves it empty rather than guessed.
 */
export function noteScanData(userId: string, symbol: string, price: number, atr: number | undefined): void {
  storeFor(userId).set(upper(symbol), {
    ts: Date.now(),
    price: positive(price) ?? 0,
    atr: positive(atr) ?? 0,
  });
}

/** The tick's ATR for the pre-screen: M15 (the intraday engine's own stride) when it was received,
 *  else the fallback timeframe's -- never invented. */
export function shortestKnownAtr(rawMergedSuite: Record<string, unknown>, fallbackTf: string | undefined): number | undefined {
  return (
    suiteNodeAtr(rawMergedSuite.M15) ??
    (fallbackTf ? suiteNodeAtr(rawMergedSuite[fallbackTf]) : undefined) ??
    Object.values(rawMergedSuite).map(suiteNodeAtr).find((x): x is number => x !== undefined)
  );
}

/** One small, bounded live-price round trip. Serves the cheap pre-screen (is anything fresh since
 *  the model's last SKIP?) and the execution-time re-check (is the plan's entry still real right
 *  before the order fires?) -- both are "don't pay for a stale picture" decisions, so they share
 *  the same honest shape: undefined on a failed or slow EA (8s), never a guessed number. */
export async function cheapLiveQuote(analysis: AnalysisSource, symbol: string): Promise<{ bid?: number; ask?: number; close?: number; spread_pips?: number } | undefined> {
  try {
    return await Promise.race([
      analysis.get<{ bid?: number; ask?: number; close?: number; spread_pips?: number }>("price", symbol),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 8_000).unref()),
    ]);
  } catch {
    return undefined;
  }
}

/** The single price a decision normally speaks in: mid when both sides are real, else the one
 *  side it has. */
function quotePrice(q: { bid?: number; ask?: number; close?: number } | undefined): number | undefined {
  return q ? (q.bid !== undefined && q.ask !== undefined ? (q.bid + q.ask) / 2 : (q.bid ?? q.ask ?? q.close)) : undefined;
}

/** Runs the cheap check for one symbol. Resolves to skip=false unless every precondition genuinely
 *  holds -- a slow EA, an unknown ATR, an old look or a decisive last action all mean "pay for the
 *  real read". */
export async function preScreenCheck(userId: string, analysis: AnalysisSource, symbol: string): Promise<{ skip: boolean; why: string }> {
  // The decision half: the model's LAST real look at this exact pair, from the persistent
  // per-symbol mirror (survives restarts, survives many ticks on other pairs). Only a SKIP arms
  // the walk, and its timestamp is the look's recency anchor -- the moment the model actually
  // judged this pair.
  const last = getTickState(userId).lastDecisionBySymbol?.[upper(symbol)];
  if (!last || last.action !== "SKIP") return { skip: false, why: "" };
  const age = Date.now() - last.ts;
  if (age > MAX_AGE_MS) return { skip: false, why: "" };
  // The data half: the suite the model was looking at. A tick icon that never fetched real data
  // leaves no usable baseline here.
  const base = storeFor(userId).get(upper(symbol));
  if (!base || !(base.price > 0) || !(base.atr > 0)) return { skip: false, why: "" };
  const price = positive(quotePrice(await cheapLiveQuote(analysis, symbol)));
  if (!price) return { skip: false, why: "" };
  const moved = Math.abs(price - base.price);
  if (moved >= MOVE_FRACTION_OF_ATR * base.atr) return { skip: false, why: "" };
  const movedPct = Math.round((moved / base.atr) * 100);
  return {
    skip: true,
    why: `nothing fresh: price ${price} has only moved ${movedPct}% of ATR (${base.atr}) vs ${base.price} since the model skipped it ${Math.round(age / 60_000)} min ago`,
  };
}
