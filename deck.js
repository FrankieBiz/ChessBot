// Spaced review of the user's own mistakes. Pure functions: no storage, clock, or DOM access.

/** Days until each review. Passing the last review masters the puzzle. */
export const REVIEW_INTERVALS = [1, 3, 7, 21, 60];
export const DEFAULT_DAILY_CAP = 20;
/** Grades that become puzzles. These match the review page's Mistakes tab. */
export const PUZZLE_GRADES = new Set(["mistake", "miss", "blunder"]);
const STORED_PV_PLIES = 8;

const pad = (value) => String(value).padStart(2, "0");

/** A local calendar date as YYYY-MM-DD. */
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Calendar arithmetic on YYYY-MM-DD strings, unaffected by time zones and daylight saving. */
export function addDays(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export const puzzleId = (gameKey, ply) => `${gameKey}:${ply}`;

export function newSchedule(today) {
  return {
    step: 0, due: addDays(today, REVIEW_INTERVALS[0]), mastered: false,
    attempts: 0, lapses: 0, lastResult: null, lastReviewed: null,
  };
}

const storedLine = ({ pv, eval: evaluation, winWhite }) => ({ pv: pv.slice(0, STORED_PV_PLIES), eval: evaluation, winWhite });

/**
 * Puzzles for one reviewed game, merged with that game's existing puzzles. Existing puzzles keep
 * their schedule and creation date. Returns the puzzles to save and the IDs of puzzles to delete.
 */
export function puzzlesFromDecisions({ gameKey, color, opponent, gameDate, decisions, today, existing = [] }) {
  const previous = new Map(existing.map((puzzle) => [puzzle.id, puzzle]));
  const puzzles = decisions
    .filter((decision) => PUZZLE_GRADES.has(decision.review.classification.key))
    .map((decision) => {
      const { ply, review, root } = decision;
      const id = puzzleId(gameKey, ply);
      const kept = previous.get(id);
      return {
        id, gameKey, ply, color, opponent, gameDate,
        fen: decision.fen,
        initialFen: decision.searchOptions.initialFen,
        history: decision.searchOptions.history.slice(),
        gameMove: { uci: decision.move.uci, san: decision.move.san },
        best: {
          uci: review.bestMoveUci,
          san: review.bestSan ?? "",
          pv: root.pv.slice(0, STORED_PV_PLIES),
          lineSan: review.pvSan ?? "",
        },
        grade: review.classification.key,
        gradeLabel: review.classification.label,
        winLoss: review.winLoss,
        missedMate: review.missedMate ?? null,
        depth: review.depth,
        root: { eval: root.eval, winWhite: root.winWhite, lines: root.lines.map(storedLine) },
        theme: decision.theme,
        phase: decision.phase,
        lowClock: decision.lowClock,
        findChance: decision.findChance,
        schedule: kept?.schedule ?? newSchedule(today),
        createdAt: kept?.createdAt ?? today,
      };
    });
  const current = new Set(puzzles.map((puzzle) => puzzle.id));
  const removedIds = existing.map((puzzle) => puzzle.id).filter((id) => !current.has(id));
  return { puzzles, removedIds };
}

/** The review fields that judgeDrillAttempt, drillPrompt, drillRejection, drillSuccess, and drillHint read. */
export function puzzleReview(puzzle) {
  return {
    bestMoveUci: puzzle.best.uci,
    bestSan: puzzle.best.san,
    winLoss: puzzle.winLoss,
    missedMate: puzzle.missedMate,
    classification: { key: puzzle.grade, label: puzzle.gradeLabel },
  };
}

/** The position object compareRootMoves expects, with the game history for repetition rules. */
export function puzzlePosition(puzzle) {
  return { fen: puzzle.fen, searchOptions: { initialFen: puzzle.initialFen, history: puzzle.history } };
}
