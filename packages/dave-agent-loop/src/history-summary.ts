/**
 * Market HISTORY computed from OLD candles -- what the fresh M15/M5 suite (and even APA's
 * situational ~21-candle slices) never sees, across every stretch the trader actually works in:
 * which week or month the price sits in, the old swing levels price has come back to and RESPECTED,
 * the multi-day direction story -- AND the intraday M15/M5 picture measured in HOURS, not days
 * (when the last 24h high/low was made, whether the last 12h is coiling or expanding). Plain code
 * facts, one text block, the same rule the APA block follows: the model gets facts to read a
 * strategy against, not a narrative.
 *
 * Fed from the same candle fetches the APA read already makes each scan (see autonomous-tick's
 * apaSets) -- those now request deeper history (W1 260 / D1 150 / H4 180 / M15 96 / M5 144 bars),
 * so this block costs no extra EA round trip.
 */
import { swings, type Bar } from "./apa-structure.js";

/** Bars per timeframe named like the read needs: D1/W1 for the day-week-month story, M15/M5 for
 *  the intraday hours story. */
export interface HistoryTfBars {
  tf: string;
  bars: Bar[];
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const pct = (n: number) => `${Math.round(n)}%`;
const fmt = (n: number) => +n.toPrecision(8);
const daysAgo = (t: number, now: number) => Math.max(1, Math.round((now - t) / DAY_MS));
/** "7h ago" inside the last day, "3d ago" beyond it -- the trader works in hours, not bar counts. */
const hoursAgo = (t: number, now: number): string => {
  const h = Math.max(1, Math.round((now - t) / HOUR_MS));
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};
/** Where price sits inside a range, 0 (at the low) .. 100 (at the high). */
const inRange = (val: number, lo: number, hi: number): number | null =>
  hi > lo ? Math.round(((val - lo) / (hi - lo)) * 100) : null;

function extrema(bars: Bar[]): { high: Bar; low: Bar } {
  let high = bars[0];
  let low = bars[0];
  for (const b of bars) {
    if (b.h > high.h) high = b;
    if (b.l < low.l) low = b;
  }
  return { high, low };
}

function iso(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** A swing-level read over OLD candles: groups swing prices within tolerance, then splits them into
 *  levels price came back to and did NOT close through (still respected) and levels that DID get
 *  closed through (broken). Levels the fresh suite can't report, because they are 2+ weeks old. */
function oldLevels(bars: Bar[], k = 2): { held: { level: number; touches: number; side: "high" | "low"; lastTouchAt: number }[]; broken: { level: number; side: "high" | "low"; brokeAt: number }[] } {
  const list = swings(bars, k);
  const avgRange = bars.slice(-60).reduce((a, b) => a + (b.h - b.l), 0) / Math.min(60, bars.length);
  const tol = avgRange * 0.25;
  const held: { level: number; touches: number; side: "high" | "low"; lastTouchAt: number }[] = [];
  const broken: { level: number; side: "high" | "low"; brokeAt: number }[] = [];
  for (const kind of ["high", "low"] as const) {
    const group = list.filter((s) => s.kind === kind);
    const used = new Set<number>();
    for (let a = 0; a < group.length; a++) {
      if (used.has(a)) continue;
      const hits = group.filter((x, b) => b >= a && Math.abs(x.price - group[a].price) <= tol);
      if (hits.length < 2) continue;
      hits.forEach((x) => used.add(group.indexOf(x)));
      const level = hits.reduce((t, x) => t + x.price, 0) / hits.length;
      const lastTouchAt = Math.max(...hits.map((x) => x.i));
      const brokeThrough = bars.slice(lastTouchAt + 1).some((b) => (kind === "high" ? b.c > level + tol : b.c < level - tol));
      if (!brokeThrough) held.push({ level, touches: hits.length, side: kind, lastTouchAt });
      else {
        const brokeAt = bars.findIndex((b, i) => i > lastTouchAt && (kind === "high" ? b.c > level + tol : b.c < level - tol));
        broken.push({ level, side: kind, brokeAt });
      }
    }
  }
  return { held, broken };
}

/**
 * One block (or null when neither D1 nor W1 history is available). `ref` is the live price; a real
 * 0 (market closed, no quote) falls back to the newest close so distances still mean something.
 */
export function describeMarketHistory(byTf: HistoryTfBars[], ref: number): string | null {
  const d1 = byTf.find((x) => x.tf === "D1")?.bars ?? [];
  const w1 = byTf.find((x) => x.tf === "W1")?.bars ?? [];
  const m15 = byTf.find((x) => x.tf === "M15")?.bars ?? [];
  const m5 = byTf.find((x) => x.tf === "M5")?.bars ?? [];
  if (!d1.length && !w1.length && !m15.length && !m5.length) return null;
  const price = ref > 0 ? ref : ((d1[d1.length - 1] ?? w1[w1.length - 1] ?? m15[m15.length - 1] ?? m5[m5.length - 1])?.c ?? 0);
  if (!price) return null;
  const now = Math.max(d1[d1.length - 1]?.t ?? 0, w1[w1.length - 1]?.t ?? 0, m15[m15.length - 1]?.t ?? 0, m5[m5.length - 1]?.t ?? 0);
  const lines: string[] = [];

  if (d1.length >= 20) {
    const range = Math.ceil((now - d1[0].t) / DAY_MS);
    lines.push(`daily candles on hand: ${d1.length} (~${range} days back to ${iso(d1[0].t)})`);
    for (const [label, n] of [["month", 21], ["quarter", 63], ["year", 252]] as const) {
      if (d1.length < n) continue;
      const { high, low } = extrema(d1.slice(-n));
      const pos = inRange(price, low.l, high.h);
      lines.push(
        `${label} high ${fmt(high.h)} (${daysAgo(high.t, now)}d ago) / low ${fmt(low.l)} (${daysAgo(low.t, now)}d ago)${
          pos !== null ? ` -- price is ${pct(pos)} up this ${label === "month" ? "monthly" : label} range` : ""
        }`
      );
    }
    // The direction story: the last two daily swing highs and lows, the same plain facts APA votes on.
    if (d1.length >= 40) {
      const list = swings(d1, 2);
      const highs = list.filter((s) => s.kind === "high").slice(-2);
      const lows = list.filter((s) => s.kind === "low").slice(-2);
      if (highs.length === 2 && lows.length === 2) {
        const dir = highs[1].price > highs[0].price && lows[1].price > lows[0].price ? "HIGHER HIGHS and HIGHER LOWS (uptrend)"
          : highs[1].price < highs[0].price && lows[1].price < lows[0].price ? "LOWER HIGHS and LOWER LOWS (downtrend)"
          : "no consistent sequence (range)";
        lines.push(`daily structure over the last ~${Math.round((now - list[Math.max(0, list.length - 4)].t) / DAY_MS)}d: ${dir}`);
      }
    }
    // Old levels price has respected, nearest to price first.
    const { held, broken } = oldLevels(d1);
    const heldSorted = held.sort((a, b) => Math.abs(a.level - price) - Math.abs(b.level - price));
    const above = heldSorted.filter((l) => l.level > price).slice(0, 2);
    const below = heldSorted.filter((l) => l.level <= price).slice(-2).reverse();
    for (const [word, levels] of [["ceilings above that have held", above], ["floors below that have held", below]] as const) {
      if (levels.length) {
        lines.push(
          `old ${word}: ${levels.map((l) => `${fmt(l.level)} (touched ${l.touches}x, last ${daysAgo(d1[l.lastTouchAt].t, now)}d ago, still respected)`).join("; ")}`
        );
      }
    }
    // Broken levels become the other kind of wall: an old ceiling broken upward is a floor now.
    const brokenSorted = broken.sort((a, b) => b.brokeAt - a.brokeAt).slice(0, 2);
    if (brokenSorted.length) {
      lines.push(
        `old levels that BROKE: ${brokenSorted
          .map((l) => `${fmt(l.level)} ${l.side === "high" ? "ceiling closed above" : "floor closed below"} ${daysAgo(d1[l.brokeAt].t, now)}d ago`)
          .join("; ")}`
      );
    }
    // Net change snapshot: what the last week / month of daily candles actually did.
    const c20 = d1[d1.length - 21]?.c;
    const c60 = d1[d1.length - 61]?.c;
    if (c20) lines.push(`net move: ${fmt((price - c20) / c20 * 100)}% over the last 20 daily candles${c60 ? `, ${fmt((price - c60) / c60 * 100)}% over 60` : ""}`);
  }

  // Intraday story, measured in HOURS (the trader's own words: the old data "must not be yesterday
  // -- it can be so-so hours ago too"). What the fresh M15 candles never say on their own: when the
  // last day's high/low actually happened, where the M5 is coiling, which intraday walls held.
  if (m15.length >= 20) {
    const spanH = Math.round((now - m15[0].t) / HOUR_MS);
    const { high, low } = extrema(m15);
    const pos = inRange(price, low.l, high.h);
    lines.push(
      `intraday (M15): last ${spanH}h of candles -- high ${fmt(high.h)} made ${hoursAgo(high.t, now)} / low ${fmt(low.l)} made ${hoursAgo(low.t, now)}` +
        `${pos !== null ? `, price now ${pct(pos)} through that range` : ""}` +
        `${m15[0].c > 0 ? `, net ${fmt((price - m15[0].c) / m15[0].c * 100)}% over those hours` : ""}`
    );
    const walls = oldLevels(m15);
    const nearest = (side: ">" | "<") =>
      walls.held.filter((l) => (side === ">" ? l.level > price : l.level <= price)).sort((a, b) => Math.abs(a.level - price) - Math.abs(b.level - price))[0];
    const above = nearest(">");
    const below = nearest("<");
    if (above || below) {
      const say = (l: (typeof walls.held)[number]) => `${fmt(l.level)} (tested ${l.touches}x, last ${hoursAgo(m15[l.lastTouchAt].t, now)})`;
      lines.push(`intraday walls still respected: above ${above ? say(above) : "none"}${above && below ? "; " : ""}${below ? `below ${say(below)}` : ""}`);
    }
  }
  if (m5.length >= 24) {
    const spanH = Math.round((now - m5[0].t) / HOUR_MS);
    const { high, low } = extrema(m5);
    const pos = inRange(price, low.l, high.h);
    let coil = "";
    if (m5.length >= 144) {
      const recent = m5.slice(-72);
      const prior = m5.slice(-144, -72);
      const rr = Math.max(...recent.map((b) => b.h)) - Math.min(...recent.map((b) => b.l));
      const pr = Math.max(...prior.map((b) => b.h)) - Math.min(...prior.map((b) => b.l));
      coil = pr > 0
        ? rr < pr * 0.7 ? ` -- the last 6h (${fmt(rr)} range) is COILING quieter than the 6h before (${fmt(pr)})` : rr > pr * 1.4 ? ` -- the last 6h (${fmt(rr)} range) is EXPANDING vs the 6h before (${fmt(pr)})` : ` -- moving at a similar pace to the prior 6h`
        : "";
    }
    lines.push(
      `intraday (M5): last ${spanH}h -- high ${fmt(high.h)} made ${hoursAgo(high.t, now)} / low ${fmt(low.l)} made ${hoursAgo(low.t, now)}` +
        `${pos !== null ? `, price ${pct(pos)} through it` : ""}${coil}`
    );
  }

  if (w1.length >= 10) {
    const week = w1[w1.length - 1];
    const pos = inRange(price, week.l, week.h);
    const prevHigh = Math.max(...w1.slice(-5, -1).map((b) => b.h));
    const prevLow = Math.min(...w1.slice(-5, -1).map((b) => b.l));
    const y = extrema(w1.slice(-52));
    lines.push(
      `weekly: current week (started ${iso(week.t)}) high ${fmt(week.h)} low ${fmt(week.l)}${pos !== null ? `, price ${pct(pos)} through it` : ""}; ` +
        `prior 4 weeks high ${fmt(prevHigh)} / low ${fmt(prevLow)}${week.h > prevHigh ? " -- this week is EXPANDING above their range" : week.l < prevLow ? " -- this week is EXPANDING below their range" : ", inside it"}; ` +
        `52-week high ${fmt(y.high.h)} (${daysAgo(y.high.t, now)}d ago) / low ${fmt(y.low.l)} (${daysAgo(y.low.t, now)}d ago)`
    );
  }

  return lines.length ? `MARKET HISTORY (older candles -- facts to read the setup against; if one specific old stretch must be read candle-by-candle, you may demand it ONCE with REQUEST_PAST_CANDLES before deciding):\n${lines.map((l) => `- ${l}`).join("\n")}` : null;
}
