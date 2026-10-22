import type { TradeExecutor } from "@dave/trading";
import { getRiskSettings } from "@dave/trading";
import { getTradeLifecycle } from "@dave/feedback";
import type { DaveDatabase } from "@dave/db";

/**
 * The SOFTWARE STOP for SL-off mode (the trader's live setup: SL_MODE "off" -- the broker holds no
 * stop on any Dave trade, so before this nothing ever capped a loss; a trade could bleed its whole
 * balance). The decision tool now REQUIRES the model to name its INVALIDATION price at entry, and
 * autonomous-tick writes that price into the trade journal's reasoning. This makes it real:
 *
 *   - the trade-monitor sweep (every 30s) reads each SL-off position's journal back,
 *   - when price reaches or crosses the recorded invalidation, the position is CLOSED AT MARKET,
 *     exactly like a broker stop would fill it -- the planned risk then genuinely exists, in
 *     dollars, without ever touching a broker-side stop (which SlOffGuard would strip anyway),
 *   - failures to close retry on the next sweep on purpose: a stop that failed once is still a
 *     stop, not an idea.
 *
 * Copy-trades are untouched (their channel SL lives at the broker, so they always carry one), and
 * trades the trader opened by hand have no journal invalidation to enforce -- they skip, as before.
 */

/** The string autonomous-tick writes for every SL-off entry: "INVALIDATION 213963 (SL is off ...)". */
const INVALIDATION_RE = /INVALIDATION\s+(-?\d+(?:\.\d+)?)/i;

/** The INVALIDATION price a trade's journal holds: scanned across ALL of the trade's entries (the
 *  placement log is not guaranteed to be the newest one, and the DB query's row order is not
 *  guaranteed), the most recent one by createdAt wins. A later, deliberate re-log replaces an
 *  earlier invalidation; multiple entries without one leave `undefined` -- an unrecorded level is
 *  not enforced, it just isn't a stop. */
export function planInvalidation(entries: { createdAt: number; reasoning?: string[] }[] | undefined): number | undefined {
  let found: { at: number; price: number } | undefined;
  for (const e of entries ?? []) {
    if (!e.reasoning?.length) continue;
    for (let i = e.reasoning.length - 1; i >= 0; i--) {
      const m = INVALIDATION_RE.exec(e.reasoning[i]);
      if (!m) continue;
      const price = Number(m[1]);
      // One match per entry is enough: the reasoning was written in a single batch.
      if (Number.isFinite(price) && price > 0 && (found === undefined || e.createdAt >= found.at)) found = { at: e.createdAt, price };
      break;
    }
  }
  return found?.price;
}

/** One live position, shaped exactly like the EA snapshot's EaPosition (fields read only). */
export interface VirtualStopPosition {
  ticket: string;
  symbol: string;
  type: string;
  openPrice: number;
  sl?: number;
  currentPrice?: number;
  pnl?: number;
}

export interface VirtualStopDeps {
  userId: string;
  db: DaveDatabase;
  executor: TradeExecutor;
  notify: (text: string, about?: { symbol: string }) => Promise<void>;
}

/** Closes at market every SL-off position whose price has reached its recorded decision
 *  invalidation. Returns the messages to send (the monitor sweep delivers them in its batch);
 *  the one message it sends itself is the failed-close emergency alert. Never throws. */

// Close attempts repeat every sweep on purpose. The "close FAILED" alert must not: a broker
// refusing closes for a while (market closed, feed hiccup) would otherwise fire a Telegram
// message every 30s for the same ticket -- so the alert itself cools down per ticket, while the
// retry keeps running. Entries are pruned for tickets no longer on the board.
const FAILED_ALERT_COOLDOWN_MS = 5 * 60_000;
const lastFailedAlert = new Map<string, number>();

export async function enforceVirtualStops(deps: VirtualStopDeps, positions: VirtualStopPosition[]): Promise<string[]> {
  // Fresh every call: flipping SL settings takes effect on the next sweep with no restart, like
  // every other setting here. Copy trades keep their broker-side stop, and anything that already
  // carries one is the broker's business -- only genuinely stop-less trades are software-stopped.
  if (getRiskSettings(deps.userId).slMode !== "off") return [];
  const liveTickets = new Set(positions.map((p) => p.ticket));
  for (const t of lastFailedAlert.keys()) if (!liveTickets.has(t)) lastFailedAlert.delete(t);
  const messages: string[] = [];
  for (const p of positions) {
    if (p.sl !== undefined && p.sl !== 0) continue;
    if (!p.currentPrice) continue;
    let planSl: number | undefined;
    try {
      planSl = planInvalidation(getTradeLifecycle(deps.db, deps.userId, { ticket: p.ticket }));
    } catch {
      planSl = undefined;
    }
    if (!planSl) continue;
    const buy = p.type === "buy";
    const hit = buy ? p.currentPrice <= planSl : p.currentPrice >= planSl;
    if (!hit) continue;
    // The software stop is firing: close the WHOLE position (a partial close here would leave the
    // remaining risk running past the very level the plan called wrong).
    try {
      await deps.executor.closePosition(p.ticket);
    } catch (err) {
      // A failed close must not silence the stop: it retries on the next sweep (the monitor calls
      // this every 30s), while the trader is told about it -- once per cooldown, not once per
      // sweep, or a market-closed hour would bury the chat in the same alert.
      console.error(`[virtual-stop] ${deps.userId}: closing #${p.ticket} (${p.symbol}) at the invalidation failed -- ${err instanceof Error ? err.message : String(err)}`);
      if (Date.now() - (lastFailedAlert.get(p.ticket) ?? 0) >= FAILED_ALERT_COOLDOWN_MS) {
        lastFailedAlert.set(p.ticket, Date.now());
        await deps
          .notify(
            `🚨 VIRTUAL STOP OPEN: ${p.symbol} ${p.type.toUpperCase()} (ticket ${p.ticket}) reached its recorded invalidation ${planSl} (now ${p.currentPrice}, P/L ${p.pnl ?? "?"}), ` +
              `but the close FAILED (${err instanceof Error ? err.message : String(err)}). I'll retry every sweep -- close it by hand if you don't want to wait.`,
            { symbol: p.symbol }
          )
          .catch(() => undefined);
      }
      continue;
    }
    lastFailedAlert.delete(p.ticket);
    console.log(`[virtual-stop] ${deps.userId}: #${p.ticket} (${p.symbol} ${p.type}) closed at market -- price reached the recorded invalidation ${planSl}`);
    // Returned, not sent here: the monitor sweep delivers these in its own message batch (a sweep
    // that hit several software stops sends one message, not one per trade).
    messages.push(
      `🛑 VIRTUAL STOP HIT: ${p.symbol} ${p.type.toUpperCase()} (ticket ${p.ticket}) closed at market -- price reached the invalidation the decision recorded at entry (${planSl}).\n` +
        `Broker SL is off in your settings, so this is the software stop doing the stop's job. The P/L books on the next MT5 report.`
    );
  }
  return messages;
}
