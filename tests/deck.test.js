import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REVIEW_INTERVALS, addDays, localDate, newSchedule, puzzleId, puzzlePosition, puzzleReview, puzzlesFromDecisions,
} from "../deck.js";
import { decision } from "./fixtures/training.js";

const base = { gameKey: "g", color: "w", opponent: "Rival", gameDate: "2026-11-23" };

test("local dates are calendar dates across month, year, and leap-day boundaries", () => {
  assert.equal(localDate(new Date(2026, 10, 24, 23, 59)), "2026-11-24");
  assert.equal(localDate(new Date(2027, 0, 5, 0, 1)), "2027-01-05");
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-11-24", 60), "2027-01-23");
});

test("a new puzzle first comes due the next day", () => {
  assert.deepEqual(REVIEW_INTERVALS, [1, 3, 7, 21, 60]);
  assert.deepEqual(newSchedule("2026-11-24"), {
    step: 0, due: "2026-11-25", mastered: false, attempts: 0, lapses: 0, lastResult: null, lastReviewed: null,
  });
});

test("only Mistakes, Misses, and Blunders become puzzles", () => {
  const decisions = [
    decision({ ply: 3, grade: "good" }),
    decision({ ply: 5, grade: "mistake" }),
    decision({ ply: 7, grade: "miss", theme: "missed-mate" }),
    decision({ ply: 9, grade: "blunder" }),
  ];
  const { puzzles, removedIds } = puzzlesFromDecisions({ ...base, gameKey: "chesscom:1", decisions, today: "2026-11-24" });
  assert.deepEqual(puzzles.map((p) => p.id), ["chesscom:1:5", "chesscom:1:7", "chesscom:1:9"]);
  assert.deepEqual(removedIds, []);

  const [first] = puzzles;
  assert.equal(first.id, puzzleId("chesscom:1", 5));
  assert.equal(first.color, "w");
  assert.equal(first.opponent, "Rival");
  assert.equal(first.gameDate, "2026-11-23");
  assert.deepEqual(first.gameMove, { uci: "a2a3", san: "a3" });
  assert.deepEqual(first.best, {
    uci: "f1b5", san: "Bb5", pv: ["f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7", "f1e1", "b7b5"],
    lineSan: "Bb5 a6 Ba4 Nf6 O-O Be7",
  });
  assert.deepEqual(first.history, ["e2e4", "e7e5", "g1f3", "b8c6"]);
  assert.equal(first.root.winWhite, 55);
  assert.equal(first.root.lines[0].pv.length, 8);
  assert.deepEqual(first.root.lines[1], { pv: ["f1c4", "g8f6"], eval: { type: "cp", value: 40 }, winWhite: 54 });
  assert.equal(first.grade, "mistake");
  assert.equal(first.gradeLabel, "Mistake");
  assert.equal(first.depth, 16);
  assert.equal(first.theme, "hanging");
  assert.equal(first.schedule.due, "2026-11-25");
  assert.equal(first.createdAt, "2026-11-24");
});

test("reviewing a game again keeps schedules, drops puzzles that no longer qualify, and adds new ones", () => {
  const first = puzzlesFromDecisions({ ...base, decisions: [decision({ ply: 5 }), decision({ ply: 9 })], today: "2026-11-01" });
  const practiced = first.puzzles.map((p) => ({ ...p, schedule: { ...p.schedule, step: 2, due: "2026-11-20" } }));
  const again = puzzlesFromDecisions({
    ...base, today: "2026-11-24", existing: practiced,
    decisions: [decision({ ply: 5, grade: "blunder" }), decision({ ply: 9, grade: "good" }), decision({ ply: 11 })],
  });
  assert.deepEqual(again.puzzles.map((p) => p.id), ["g:5", "g:11"]);
  assert.equal(again.puzzles[0].grade, "blunder");
  assert.equal(again.puzzles[0].schedule.step, 2);
  assert.equal(again.puzzles[0].createdAt, "2026-11-01");
  assert.equal(again.puzzles[1].schedule.due, "2026-11-25");
  assert.deepEqual(again.removedIds, ["g:9"]);
});

test("a puzzle supplies what the drill rules and the Stockfish comparison read", () => {
  const [p] = puzzlesFromDecisions({ ...base, decisions: [decision()], today: "2026-11-01" }).puzzles;
  assert.deepEqual(puzzleReview(p), {
    bestMoveUci: "f1b5", bestSan: "Bb5", winLoss: 12, missedMate: null,
    classification: { key: "mistake", label: "Mistake" },
  });
  assert.deepEqual(puzzlePosition(p), {
    fen: p.fen, searchOptions: { initialFen: p.initialFen, history: ["e2e4", "e7e5", "g1f3", "b8c6"] },
  });
});
