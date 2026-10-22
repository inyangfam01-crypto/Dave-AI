import { listSkills, type Skill } from "@dave/skills";

/**
 * THE STRATEGY DRAWER (trading mode "auto" -- no single skill locked in): when the trader has not
 * activated a strategy, the tick used to run on its plain default judgment, and every strategy
 * card sat inert in the skills store -- the one place the tick couldn't reach. The tick's one
 * model call FORCES toolChoice to the decision tool (and it can never follow an index up with a
 * skill_view fetch -- the same lesson safeTickKnowledgeIndex documents for knowledge), so a
 * name-only catalogue here would be strictly useless: "a strategy exists" while withholding both
 * what it requires and whether the setup in front of the model qualifies.
 *
 * So the drawer carries the cards themselves. Every non-permanent skill is a strategy card: the
 * two built-ins (APA, structure targets), anything Dave wrote for himself, anything installed
 * from GitHub or a .jsonl upload. The permanent skills are the tool-usage manual and the internal
 * tool references -- reference material, not strategies; the active-skill block already covers
 * them when one matters. Prompt size is real but bounded: the cards are capped per card and in
 * total (the two built-in cards together are ~11k of a suite block that budgets 160k), and a card
 * that doesn't fit is named and described rather than silently dropped.
 *
 * Deliberately NOT a nudge to trade more: the drawer only changes WHAT the decision may be based
 * on, never whether the confidence threshold, the risk-reward floor or the no-setup SKILL rules
 * still apply. Locked mode (trading-skills) is untouched -- that block stays exactly as it is.
 */

/** One card longer than this is shortened for the drawer (the built-in APA card is ~8.6k today). */
export const STRATEGY_CARD_CHAR_CAP = 12_000;
/** Total room for card bodies -- roughly three megacards plus the two built-ins. */
export const STRATEGY_DRAWER_CHAR_BUDGET = 32_000;

function isStrategyCard(s: Skill): boolean {
  // permanent = the tool-usage manual + internal tool docs (both seeded permanent: true) --
  // reference manuals for operating tools, never a trading strategy.
  if (s.permanent) return false;
  return Boolean(s.content?.trim());
}

/** A card's body for the drawer: the full text when it fits the per-card cap, else an honest cut. */
function cardBody(content: string): string {
  if (content.length <= STRATEGY_CARD_CHAR_CAP) return content;
  return `${content.slice(0, STRATEGY_CARD_CHAR_CAP)}\n[card cut off here to fit the drawer -- follow only what is shown above; never improvise the missing parts]`;
}

/**
 * The drawer block for this tick's context, or null when there is nothing to draw from (every
 * strategy locked in, no cards, or the registry unreadable). Reading the real card contents every
 * tick is the point -- Dave edits his skills, installs new ones, and the next tick must see it.
 */
export function strategyDrawerLine(userId: string): string | null {
  let cards: Skill[];
  try {
    cards = listSkills(userId).filter(isStrategyCard);
  } catch (err) {
    console.error(`[strategy-drawer] could not load skills for ${userId} -- continuing without it:`, err);
    return null;
  }
  if (cards.length === 0) return null;
  // Oldest first: the built-ins were seeded first, so they keep their place ahead of whatever
  // else is installed when the total budget runs out.
  cards.sort((a, b) => a.createdAt - b.createdAt);

  const sections: string[] = [];
  const overflow: string[] = [];
  let budget = STRATEGY_DRAWER_CHAR_BUDGET;
  for (const s of cards) {
    const description = s.description?.trim() ? `\nWhat it's for: ${s.description.trim()}` : "";
    const body = cardBody(s.content.trim());
    if (body.length + description.length > budget) {
      overflow.push(`- ${s.name}${description}`);
      continue;
    }
    budget -= body.length + description.length;
    sections.push(`--- ${s.name} ---${description}\n${body}`);
  }

  const overflowText = overflow.length
    ? `\n\nCards too big to fit what's left of the drawer this tick (shown by name only):\n${overflow.join("\n")}\nDon't run these blind -- ask the trader to lock one in (Trading Mode) if it looks right for this pair.`
    : "";

  return [
    "STRATEGY DRAWER -- no single strategy is locked in, so you are choosing from the drawer this tick.",
    "Every card below is a strategy you carry. Read the market data in front of you, pick the ONE card whose setup genuinely fits what you can see on this pair, and follow it the way a locked skill is followed: enter only when every condition it requires is present; if any condition is missing, SKIP, name the missing condition, and mark the level or set a reminder for it. Name the card you chose in your reason.",
    "A card can only run on data that is actually in front of you: if it names timeframes whose read is missing or marked stale in this scan, you cannot follow that card honestly -- don't run it.",
    "If no card genuinely fits the setup, make your own judgment as usual -- never bend a card to justify an entry. This does not change whether you trade; it only changes what your decision may be based on.",
    '',
    sections.join("\n\n") + overflowText,
  ].join("\n");
}
