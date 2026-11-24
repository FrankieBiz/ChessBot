// Cross-game weakness report. Pure functions: no storage, clock, or DOM access.
import { localDate } from "./deck.js";

/** The report appears once this many games are reviewed. */
export const REPORT_MIN_GAMES = 5;
/** The report covers this many of the most recently reviewed games. */
export const REPORT_WINDOW = 50;
/** A mistake type with fewer cases goes under Less common. */
export const ROW_MIN_CASES = 3;
/** The top mistake type is labeled Your main focus only with at least this many cases. */
export const FOCUS_MIN_CASES = 5;
/** A mistake counts as easy when at least this share (percent) of players find a sound move. */
export const EASY_FIND_CHANCE = 70;
/** An expected score (0–100) at or above this is a winning position. */
export const WINNING_SCORE = 85;
/** A clock is low under the larger of these: seconds, or a share of the base time. */
export const LOW_CLOCK_FLOOR = 15;
export const LOW_CLOCK_SHARE = 0.1;
export const PHASES = ["opening", "middlegame", "endgame"];

/** Report rows, in tie-break order. Each Mistake, Miss, or Blunder gets one row from its coach tag. */
export const THEMES = [
  { id: "hanging", label: "Left a piece hanging", tags: ["Hanging Piece"] },
  { id: "allowed-tactic", label: "Allowed a tactic", tags: ["Engine Capture"] },
  { id: "allowed-mate", label: "Allowed checkmate", tags: ["Missed Defense"] },
  { id: "missed-material", label: "Missed winning material", tags: ["Missed Tactic"] },
  { id: "missed-mate", label: "Missed checkmate", tags: ["Missed Mate"] },
  { id: "missed-refutation", label: "Didn't punish a mistake", tags: ["Missed Refutation"] },
  { id: "missed-forcing", label: "Missed a check or promotion", tags: ["Missed Check", "Promotion"] },
  { id: "positional", label: "No single tactic", tags: ["Critical Error", "Positional Slip"] },
];
const THEME_BY_TAG = new Map(THEMES.flatMap((theme) => theme.tags.map((tag) => [tag, theme.id])));

export const themeForTag = (tag) => THEME_BY_TAG.get(tag) ?? "positional";
export const themeLabel = (id) => THEMES.find((theme) => theme.id === id)?.label ?? id;

/** True when the clock is low, false when it isn't, and null without a clock or base time. */
export function isLowClock(seconds, baseSeconds) {
  if (!Number.isFinite(seconds) || !Number.isFinite(baseSeconds)) return null;
  return seconds < Math.max(LOW_CLOCK_FLOOR, LOW_CLOCK_SHARE * baseSeconds);
}

/** The user's score from a PGN result tag: 1, 0.5, or 0, or null when unknown. */
export function userResult(resultTag, color) {
  if (resultTag === "1/2-1/2") return 0.5;
  if (resultTag === "1-0") return color === "w" ? 1 : 0;
  if (resultTag === "0-1") return color === "b" ? 1 : 0;
  return null;
}

/** The game's date: the Chess.com end time, then the PGN date headers, then `today`. */
export function gameDate({ endTime, headers = {} }, today) {
  if (Number.isFinite(endTime) && endTime > 0) return localDate(new Date(endTime * 1000));
  const tag = [headers.UTCDate, headers.Date].find((value) => /^\d{4}\.\d{2}\.\d{2}$/.test(value ?? ""));
  return tag ? tag.replaceAll(".", "-") : today;
}
