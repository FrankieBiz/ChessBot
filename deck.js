// Spaced review of the user's own mistakes. Pure functions: no storage or DOM access. Only localDate() reads the clock, and only when called without a date.

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
  existing = existing.filter((puzzle) => puzzle.gameKey === gameKey);
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

export const OUTCOMES = Object.freeze({ pass: "pass", fail: "fail", unverified: "unverified" });

export const isDue = (puzzle, today) => !puzzle.schedule.mastered && puzzle.schedule.due <= today;

/**
 * The puzzle after one session result. Practice before the due date is early: a pass then leaves the
 * step and due date as they were, while a fail still resets them, and neither sets `lastReviewed`.
 * Only results on due puzzles set `lastReviewed`, which buildSession counts toward the daily cap.
 * An unverified result (Stockfish couldn't check the move) changes nothing.
 */
export function applyResult(puzzle, outcome, today) {
  if (outcome === OUTCOMES.unverified) return puzzle;
  if (outcome !== OUTCOMES.pass && outcome !== OUTCOMES.fail) throw new Error(`Unknown outcome: ${outcome}`);
  const early = !isDue(puzzle, today);
  const current = puzzle.schedule;
  const schedule = {
    ...current, attempts: current.attempts + 1, lastResult: outcome, lastReviewed: early ? current.lastReviewed : today,
  };
  if (outcome === OUTCOMES.fail) {
    Object.assign(schedule, {
      step: 0, due: addDays(today, REVIEW_INTERVALS[0]), mastered: false, lapses: current.lapses + 1,
    });
  } else if (!early) {
    if (current.step >= REVIEW_INTERVALS.length - 1) {
      Object.assign(schedule, { mastered: true, due: null });
    } else {
      const step = current.step + 1;
      Object.assign(schedule, { step, due: addDays(today, REVIEW_INTERVALS[step]) });
    }
  }
  return { ...puzzle, schedule };
}

/** Bring a puzzle, including a mastered one, back to the first step, due tomorrow. */
export function resetPuzzle(puzzle, today) {
  return {
    ...puzzle,
    schedule: { ...puzzle.schedule, step: 0, due: addDays(today, REVIEW_INTERVALS[0]), mastered: false },
  };
}

export const dueCount = (puzzles, today) => puzzles.filter((puzzle) => isDue(puzzle, today)).length;

const byDue = (a, b) => (a.schedule.due ?? "").localeCompare(b.schedule.due ?? "") ||
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** Reorder so consecutive puzzles avoid the same game first and the same theme second, when possible. */
export function interleave(puzzles) {
  const remaining = puzzles.slice();
  const ordered = [];
  while (remaining.length) {
    const last = ordered.at(-1);
    let index = 0;
    if (last) {
      const candidates = [
        remaining.findIndex((p) => p.gameKey !== last.gameKey && p.theme !== last.theme),
        remaining.findIndex((p) => p.gameKey !== last.gameKey),
        remaining.findIndex((p) => p.theme !== last.theme),
      ];
      index = candidates.find((candidate) => candidate >= 0) ?? 0;
    }
    ordered.push(...remaining.splice(index, 1));
  }
  return ordered;
}

/**
 * Today's puzzles: due ones, most overdue first, up to the daily cap minus puzzles already practiced
 * today. With `filter`, a theme-practice set instead: matching puzzles that aren't mastered, due ones
 * first, up to the cap.
 */
export function buildSession(puzzles, { today, cap = DEFAULT_DAILY_CAP, filter = null }) {
  const open = puzzles.filter((puzzle) => !puzzle.schedule.mastered);
  if (filter) {
    const matching = open.filter(filter)
      .sort((a, b) => Number(isDue(b, today)) - Number(isDue(a, today)) || byDue(a, b));
    return interleave(matching.slice(0, cap));
  }
  const practicedToday = puzzles.filter((puzzle) => puzzle.schedule.lastReviewed === today).length;
  const room = Math.max(0, cap - practicedToday);
  return interleave(open.filter((puzzle) => isDue(puzzle, today)).sort(byDue).slice(0, room));
}

/** A session queue. A failed puzzle comes back once at the end, and that repeat never changes its schedule. */
export function startQueue(puzzles) {
  return { ids: puzzles.map((puzzle) => puzzle.id), index: 0, firstPass: puzzles.length, requeued: [] };
}

export const currentId = (queue) => queue.ids[queue.index] ?? null;
export const isRepeat = (queue) => queue.index >= queue.firstPass && queue.index < queue.ids.length;

export function advanceQueue(queue, outcome) {
  const id = currentId(queue);
  const requeue = Boolean(id) && outcome === OUTCOMES.fail && !isRepeat(queue) && !queue.requeued.includes(id);
  return {
    ...queue,
    index: queue.index + 1,
    ids: requeue ? [...queue.ids, id] : queue.ids,
    requeued: requeue ? [...queue.requeued, id] : queue.requeued,
  };
}
