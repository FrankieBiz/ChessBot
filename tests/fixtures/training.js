// Shared builders for the practice deck and weakness report tests.
export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const LABELS = { best: "Best", good: "Good", inaccuracy: "Inaccuracy", mistake: "Mistake", miss: "Miss", blunder: "Blunder" };
const MISTAKES = new Set(["mistake", "miss", "blunder"]);

/** One user decision, shaped like weakness.userDecisions output. */
export function decision({ ply = 5, grade = "mistake", theme = "hanging", phase = "middlegame", lowClock = null,
  findChance = 60, expectedBefore = 55 } = {}) {
  const line = (pv, winWhite) => ({ multipv: 1, depth: 16, pv, eval: { type: "cp", value: 40 }, winWhite });
  const bestLine = line(["f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7", "f1e1", "b7b5", "a4b3"], 55);
  return {
    ply,
    fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
    searchOptions: { initialFen: START_FEN, history: ["e2e4", "e7e5", "g1f3", "b8c6"] },
    phase,
    move: { uci: "a2a3", san: "a3" },
    review: {
      classification: { key: grade, label: LABELS[grade] },
      winLoss: 12,
      bestMoveUci: "f1b5",
      bestSan: "Bb5",
      pvSan: "Bb5 a6 Ba4 Nf6 O-O Be7",
      missedMate: null,
      depth: 16,
    },
    root: { ...bestLine, lines: [bestLine, line(["f1c4", "g8f6"], 54)] },
    theme: MISTAKES.has(grade) ? theme : null,
    lowClock,
    findChance,
    expectedBefore,
  };
}

/** A minimal saved puzzle: the fields sessions and filters read. */
export function puzzle(id, { gameKey = "g1", theme = "hanging", phase = "middlegame", due = "2026-11-24", step = 0,
  mastered = false, createdAt = "2026-11-20", lastReviewed = null, lowClock = null, findChance = null } = {}) {
  return {
    id, gameKey, theme, phase, lowClock, findChance, createdAt,
    schedule: { step, due: mastered ? null : due, mastered, attempts: 0, lapses: 0, lastResult: null, lastReviewed },
  };
}
