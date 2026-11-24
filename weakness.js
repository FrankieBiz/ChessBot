// Cross-game weakness report. Pure functions: no storage, clock, or DOM access.
import { Chess } from "./vendor/chess.js/chess.js";
import { computeGameInsights, generateLocalCoachInsight } from "./coach.js";
import { PUZZLE_GRADES, localDate } from "./deck.js";
import { computeProGameAccuracy, evalToWinWhite } from "./engine.js";

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

const sideScore = (winWhite, color) => (Number.isFinite(winWhite) ? (color === "w" ? winWhite : 100 - winWhite) : null);

/**
 * The user's non-forced decisions from a finished review: the position before the move, the review,
 * the root evaluation, and the fields the deck and the report need.
 */
export function userDecisions({ positions, evals, moveReviews, playedColor }) {
  const clockKey = playedColor === "w" ? "whiteSeconds" : "blackSeconds";
  const decisions = [];
  for (let ply = 1; ply < positions.length; ply++) {
    const before = positions[ply - 1];
    const after = positions[ply];
    const review = moveReviews[ply];
    const root = evals[ply - 1];
    if (!after.move || after.move.color !== playedColor || !review || review.forced || !root) continue;

    const mistake = PUZZLE_GRADES.has(review.classification.key);
    const tag = mistake ? generateLocalCoachInsight({
      ChessClass: Chess,
      fenBefore: before.fen,
      fenAfter: after.fen,
      move: after.move,
      evalBefore: root,
      evalAfter: { eval: review.playedEval, bestMove: review.playedPv?.[1] },
      review,
    }).tag : null;
    const context = before.practicalContext;
    decisions.push({
      ply,
      fen: before.fen,
      searchOptions: before.searchOptions,
      phase: before.phase,
      move: { uci: after.move.uci, san: after.move.san },
      review,
      root,
      theme: mistake ? themeForTag(tag) : null,
      lowClock: isLowClock(context?.[clockKey], context?.timeControl?.base),
      findChance: Number.isFinite(review.difficulty?.chance) ? review.difficulty.chance : null,
      expectedBefore: sideScore(root.winWhite, playedColor),
    });
  }
  return decisions;
}

/** Overall and phase accuracy for the user's side, computed the way the review page shows them. */
export function gameAccuracy({ positions, evals, moveReviews, playedColor }) {
  const winTimeline = evals.map((evaluation) => (evaluation ? evalToWinWhite(evaluation.eval) : null));
  const moves = [];
  for (let ply = 1; ply < positions.length; ply++) {
    const review = moveReviews[ply];
    if (review && !review.forced && positions[ply].move?.color === playedColor) {
      moves.push({ ply, accuracy: review.accuracy });
    }
  }
  return {
    accuracy: computeProGameAccuracy(winTimeline, moves),
    phaseAccuracy: computeGameInsights({ positions, winTimeline, moveReviews, playedColor }),
  };
}

/** The stored summary of one reviewed game. */
export function summarizeGame({ gameKey, reviewedAt, date, color, result, timeClass, opponent, depth, decisions,
  accuracy, phaseAccuracy }) {
  const lowDecisions = decisions.filter((d) => d.lowClock === true).length;
  const otherDecisions = decisions.filter((d) => d.lowClock === false).length;
  const scores = decisions.map((d) => d.expectedBefore).filter(Number.isFinite);
  return {
    gameKey, reviewedAt, date, color, result,
    timeClass: timeClass || "",
    opponent: opponent || "",
    depth,
    decisions: decisions.length,
    phaseMoves: Object.fromEntries(PHASES.map((phase) => [phase, decisions.filter((d) => d.phase === phase).length])),
    phaseAccuracy: Object.fromEntries(PHASES.map((phase) => [phase, phaseAccuracy?.[phase] ?? null])),
    accuracy: accuracy ?? null,
    clock: lowDecisions + otherDecisions ? { lowDecisions, otherDecisions } : null,
    maxExpectedScore: scores.length ? Math.max(...scores) : null,
    mistakes: decisions.filter((d) => d.theme)
      .map(({ ply, theme, phase, lowClock, findChance }) => ({ ply, theme, phase, lowClock, findChance })),
  };
}

const per100 = (count, moves) => (moves ? (count / moves) * 100 : null);

function weightedMean(pairs) {
  let total = 0;
  let weight = 0;
  for (const [value, count] of pairs) {
    if (Number.isFinite(value) && count > 0) {
      total += value * count;
      weight += count;
    }
  }
  return weight ? total / weight : null;
}

/** The weakness report over the most recently reviewed games, or `{ ready: false }` until there are enough. */
export function weaknessReport(summaries) {
  const games = [...summaries].sort((a, b) => b.reviewedAt - a.reviewedAt).slice(0, REPORT_WINDOW);
  if (games.length < REPORT_MIN_GAMES) return { ready: false, games: games.length, needed: REPORT_MIN_GAMES };

  const moves = games.reduce((sum, game) => sum + game.decisions, 0);
  const mistakes = games.flatMap((game) => game.mistakes.map((m) => ({ ...m, gameKey: game.gameKey })));

  const rows = THEMES.map((theme, order) => {
    const cases = mistakes.filter((m) => m.theme === theme.id);
    return {
      id: theme.id, label: theme.label, order, count: cases.length,
      games: new Set(cases.map((m) => m.gameKey)).size, per100: per100(cases.length, moves),
    };
  }).filter((row) => row.count > 0).sort((a, b) => b.count - a.count || a.order - b.order);
  const common = rows.filter((row) => row.count >= ROW_MIN_CASES);
  const lessCommon = rows.filter((row) => row.count < ROW_MIN_CASES);
  const focus = common[0]?.count >= FOCUS_MIN_CASES && !(rows[1]?.count >= common[0].count) ? common[0].id : null;

  const rated = mistakes.filter((m) => Number.isFinite(m.findChance));
  const easy = {
    easy: rated.filter((m) => m.findChance >= EASY_FIND_CHANCE).length,
    rated: rated.length,
    unrated: mistakes.length - rated.length,
  };

  const phases = Object.fromEntries(PHASES.map((phase) => {
    const reached = games.filter((g) => g.phaseMoves[phase] > 0 && Number.isFinite(g.phaseAccuracy[phase]));
    return [phase, {
      games: reached.length,
      accuracy: weightedMean(reached.map((g) => [g.phaseAccuracy[phase], g.phaseMoves[phase]])),
    }];
  }));
  const overall = weightedMean(games.map((g) => [g.accuracy, g.decisions]));

  const timed = games.filter((g) => g.clock);
  let clock = null;
  if (timed.length) {
    const timedKeys = new Set(timed.map((g) => g.gameKey));
    const timedMistakes = mistakes.filter((m) => timedKeys.has(m.gameKey));
    const lowMoves = timed.reduce((sum, g) => sum + g.clock.lowDecisions, 0);
    const otherMoves = timed.reduce((sum, g) => sum + g.clock.otherDecisions, 0);
    const lowMistakes = timedMistakes.filter((m) => m.lowClock === true).length;
    const otherMistakes = timedMistakes.filter((m) => m.lowClock === false).length;
    clock = {
      games: timed.length, lowMoves, otherMoves, lowMistakes, otherMistakes,
      lowRate: per100(lowMistakes, lowMoves), otherRate: per100(otherMistakes, otherMoves),
    };
  }

  const winning = games.filter((g) => Number.isFinite(g.result) && Number.isFinite(g.maxExpectedScore) &&
    g.maxExpectedScore >= WINNING_SCORE);
  const unconverted = winning.filter((g) => g.result < 1);
  const conversion = { winning: winning.length, unconverted: unconverted.length, gameKeys: unconverted.map((g) => g.gameKey) };

  return {
    ready: true, games: games.length, moves, mistakes: mistakes.length,
    themes: { common, lessCommon, focus }, easy, phases, overall, clock, conversion,
  };
}

/** A puzzle predicate for a report row's Practice button. */
export function reportFilter(kind, value) {
  switch (kind) {
    case "theme": return (puzzle) => puzzle.theme === value;
    case "phase": return (puzzle) => puzzle.phase === value;
    case "lowClock": return (puzzle) => puzzle.lowClock === true;
    case "easy": return (puzzle) => Number.isFinite(puzzle.findChance) && puzzle.findChance >= EASY_FIND_CHANCE;
    case "unconverted": {
      const keys = new Set(value);
      return (puzzle) => keys.has(puzzle.gameKey);
    }
    default: throw new Error(`Unknown report filter: ${kind}`);
  }
}

/**
 * The user's side when it is known: chosen in Load PGN, reopened from the Practice page, or the signed-in
 * Chess.com account (or the username saved in Settings) matching one of the players. Null otherwise,
 * including an explicit opt-out (`colorConfirmed: false`) from Load PGN.
 */
export function confirmedSide({ colorConfirmed, playedColor, accountUsername, white, black }, fallbackUsername = null) {
  if (colorConfirmed === false) return null;
  if (colorConfirmed) return playedColor ?? null;
  const players = { w: white?.username?.toLowerCase(), b: black?.username?.toLowerCase() };
  for (const name of [accountUsername, fallbackUsername]) {
    const user = typeof name === "string" ? name.trim().toLowerCase() : "";
    if (!user) continue;
    if (players.w === user) return "w";
    if (players.b === user) return "b";
  }
  return null;
}
