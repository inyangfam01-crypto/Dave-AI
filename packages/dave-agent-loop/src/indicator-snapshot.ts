/**
 * The INDICATOR SNAPSHOT: the honest numbers from the "all" suite's indicator endpoints
 * (momentum / volatility / trend -- shapes confirmed against DaveEA.mq5's C_Momentum,
 * C_Volatility, C_Trend), distilled to one plain line per timeframe. Two real reasons this
 * exists instead of trusting the raw JSON to speak for itself:
 *   - under the SUITE_PROMPT_BUDGET drop order the big prose endpoints (news, patterns...)
 *     squeeze the compact ones, and a model reading 100k+ chars habitually under-reads the
 *     quiet numbers inside them -- RSI is 51 vs 49 decides trades and deserves its own line;
 *   - it is appended OUTSIDE the suite, so it survives any future drop-order change.
 * No new EA calls -- everything here was already fetched this cycle. A missing/failed field
 * is simply omitted, never invented.
 */
export interface SuiteSnapshotRow {
  tf: string;
  data: Record<string, unknown> | null;
}

const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const txt = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const digits = (n: number) => (Number.isInteger(n) ? String(n) : String(+n.toPrecision(5)));

function indicatorLine(tf: string, data: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const mom = rec(data.momentum);
  const vol = rec(data.volatility);
  const trd = rec(data.trend);

  const rsi = mom ? rec(mom.rsi) : null;
  const rsiVal = rsi ? num(rsi.value) : undefined;
  if (rsiVal !== undefined) {
    // Plain words beside the raw number: 50 is neutral even indoors (turbo-charged reading of the
    // momentum endpoint's own "RSI >55 / <45" summary convention).
    const side = rsiVal >= 70 ? " -- overbought zone" : rsiVal <= 30 ? " -- oversold zone" : rsiVal > 55 ? " -- bullish side" : rsiVal < 45 ? " -- bearish side" : " -- neutral";
    parts.push(`RSI ${digits(rsiVal)}${side}`);
    const higher = rsi ? rec(rsi.higher_tf) : null;
    const hr = higher ? num(higher.rsi) : undefined;
    const htf = higher ? txt(higher.tf) : undefined;
    if (hr !== undefined) parts.push(`higher-tf (${htf ?? "?"}) RSI ${digits(hr)}`);
  }

  const macd = mom ? rec(mom.macd) : null;
  if (macd) {
    const hist = num(macd.histogram);
    const growing = bool(macd.histogram_growing);
    if (hist !== undefined) parts.push(`MACD histogram ${hist > 0 ? "+" : ""}${digits(hist)}${growing !== undefined ? (growing ? " and growing" : " and shrinking") : ""}`);
    const cross = rec(macd.last_cross);
    const crossDir = cross ? txt(cross.dir) : undefined;
    const crossAgo = cross ? num(cross.bars_ago) : undefined;
    if (crossDir !== undefined) parts.push(`last cross ${crossDir}${crossAgo !== undefined ? ` ${crossAgo} bars ago` : ""}`);
  }

  const stoch = mom ? rec(mom.stochastic) : null;
  const stK = stoch ? num(stoch.k) : undefined;
  if (stK !== undefined) parts.push(`stoch K ${digits(stK)}`);

  const z = mom ? num(mom.zscore_20) : undefined;
  if (z !== undefined) parts.push(`z-score ${z > 0 ? "+" : ""}${digits(z)}`);

  const div = mom ? rec(mom.divergence_latest) : null;
  const divType = div ? txt(div.type) : undefined;
  if (divType) parts.push(`${divType} DIVERGENCE`);

  const atr = vol ? rec(vol.atr) : null;
  const atrVal = atr ? num(atr.value) : undefined;
  if (atrVal !== undefined) {
    const pctl = num(atr.percentile_200);
    parts.push(`ATR ${digits(atrVal)}${pctl !== undefined ? ` (${Math.round(pctl)}th percentile of last 200 bars)` : ""}`);
  }
  const bb = vol ? rec(vol.bollinger) : null;
  const pbb = bb ? num(bb.percent_b) : undefined;
  if (pbb !== undefined) parts.push(`BB %B ${digits(pbb)}`);
  const squeeze = vol ? rec(vol.squeeze) : undefined;
  const sqOn = squeeze ? bool(squeeze.on) : undefined;
  const sqLen = squeeze ? num(squeeze.length_bars) : undefined;
  if (sqOn) parts.push(`SQUEEZE on (Bollinger inside Keltner${sqLen !== undefined ? `, ${sqLen} bars so far` : ""})`);

  const ema200 = trd ? rec(trd.ema200) : null;
  const vsEm = ema200 ? txt(ema200.price) : undefined;
  if (vsEm) parts.push(`price ${vsEm} EMA200`);
  const adx = trd ? rec(trd.adx) : null;
  const adxVal = adx ? num(adx.adx) : undefined;
  if (adxVal !== undefined) {
    const di = txt(adx.di_on_top);
    const rising = num(adx.plus_di) !== undefined ? bool(adx.rising) : undefined;
    parts.push(`ADX ${digits(adxVal)}${di !== undefined ? (di === "plus" ? " (uptrend force on top)" : " (downtrend force on top)") : ""}${rising !== undefined ? (rising ? ", rising" : ", falling") : ""}`);
  }
  const st = trd ? rec(trd.supertrend) : null;
  const stDir = st ? txt(st.dir) : undefined;
  if (stDir) parts.push(`supertrend ${stDir}`);
  // Ichimoku lives in the trend endpoint too (DaveEA C_Trend): where price is against the cloud
  // and which way the conversion line sits -- named on purpose, the trader asked for it explicitly.
  const ich = trd ? rec(trd.ichimoku) : null;
  if (ich) {
    const vs = txt(ich.price_vs_cloud);
    const colour = txt(ich.cloud_colour);
    const tk = txt(ich.tenkan_vs_kijun);
    if (vs) parts.push(`Ichimoku ${vs} cloud${colour ? ` (${colour})` : ""}${tk ? `, ${tk}` : ""}`);
  }

  return parts.length ? `${tf}: ${parts.join(" | ")}` : undefined;
}

/** One line per timeframe that returned a real suite, highest-first. */
export function describeIndicatorSnapshot(rows: SuiteSnapshotRow[]): string | null {
  const lines = rows
    .map((r) => (r.data ? indicatorLine(r.tf.toUpperCase(), r.data) : undefined))
    .filter((l): l is string => !!l);
  return lines.length ? `INDICATOR SNAPSHOT (the raw numbers from the suite's indicator endpoints, one line per timeframe):\n${lines.join("\n")}` : null;
}
