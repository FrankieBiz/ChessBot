import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OUTCOMES, REVIEW_INTERVALS, addDays, advanceQueue, applyResult, buildSession, currentId, dueCount, isDue, isRepeat, localDate, newSchedule, puzzleId, puzzlePosition, puzzleReview, puzzlesFromDecisions, resetPuzzle, startQueue,
} from "../deck.js";
import { decision, puzzle } from "./fixtures/training.js";

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

const fresh = () => ({ id: "g:5", schedule: newSchedule("2026-11-01") });

test("each first-try pass moves a puzzle up the ladder until it is mastered", () => {
  let p = fresh();
  let day = "2026-11-02";
  const dues = [];
  for (let i = 0; i < 4; i++) {
    p = applyResult(p, OUTCOMES.pass, day);
    dues.push(p.schedule.due);
    day = p.schedule.due;
  }
  assert.deepEqual(dues, ["2026-11-05", "2026-11-12", "2026-12-03", "2027-02-01"]);
  assert.equal(p.schedule.step, 4);
  p = applyResult(p, OUTCOMES.pass, day);
  assert.equal(p.schedule.mastered, true);
  assert.equal(p.schedule.due, null);
  assert.equal(p.schedule.attempts, 5);
  assert.equal(p.schedule.lastReviewed, "2027-02-01");
  assert.equal(isDue(p, "2030-01-01"), false);
});

test("a fail sends the puzzle back to one day and counts a lapse", () => {
  let p = applyResult(fresh(), OUTCOMES.pass, "2026-11-02");
  p = applyResult(p, OUTCOMES.fail, "2026-11-05");
  assert.deepEqual(p.schedule, {
    step: 0, due: "2026-11-06", mastered: false, attempts: 2, lapses: 1, lastResult: "fail", lastReviewed: "2026-11-05",
  });
});

test("an unverified result leaves the puzzle untouched", () => {
  const p = fresh();
  assert.equal(applyResult(p, OUTCOMES.unverified, "2026-11-02"), p);
});

test("an unknown result is a programming error", () => {
  assert.throws(() => applyResult(fresh(), "maybe", "2026-11-02"), /Unknown outcome/);
});

test("practice before the due date never moves a puzzle forward, but a fail still resets it", () => {
  const p = { id: "g:5", schedule: { ...newSchedule("2026-11-01"), step: 2, due: "2026-11-20" } };
  const passed = applyResult(p, OUTCOMES.pass, "2026-11-10", { early: true });
  assert.equal(passed.schedule.step, 2);
  assert.equal(passed.schedule.due, "2026-11-20");
  assert.equal(passed.schedule.attempts, 1);
  const failed = applyResult(p, OUTCOMES.fail, "2026-11-10", { early: true });
  assert.equal(failed.schedule.step, 0);
  assert.equal(failed.schedule.due, "2026-11-11");
});

test("a puzzle is due on or after its date until it is mastered, and a reset brings it back tomorrow", () => {
  const p = fresh();
  assert.equal(isDue(p, "2026-11-01"), false);
  assert.equal(isDue(p, "2026-11-02"), true);
  assert.equal(isDue(p, "2026-11-30"), true);
  const mastered = { ...p, schedule: { ...p.schedule, step: 4, mastered: true, due: null } };
  const reset = resetPuzzle(mastered, "2026-12-01");
  assert.equal(reset.schedule.mastered, false);
  assert.equal(reset.schedule.step, 0);
  assert.equal(reset.schedule.due, "2026-12-02");
});

const ids = (puzzles) => puzzles.map((p) => p.id);

test("today's session takes due puzzles, most overdue first, up to the daily cap", () => {
  const puzzles = [
    puzzle("a", { due: "2026-11-24", gameKey: "g1" }),
    puzzle("b", { due: "2026-11-22", gameKey: "g2" }),
    puzzle("c", { due: "2026-11-25", gameKey: "g3" }),
    puzzle("d", { mastered: true, gameKey: "g4" }),
    puzzle("e", { due: "2026-11-23", gameKey: "g5" }),
  ];
  assert.deepEqual(ids(buildSession(puzzles, { today: "2026-11-24" })), ["b", "e", "a"]);
  assert.deepEqual(ids(buildSession(puzzles, { today: "2026-11-24", cap: 2 })), ["b", "e"]);
  assert.equal(dueCount(puzzles, "2026-11-24"), 3);
});

test("puzzles already practiced today count toward the daily cap", () => {
  const puzzles = [
    puzzle("a", { gameKey: "g1" }),
    puzzle("b", { gameKey: "g2" }),
    puzzle("done", { due: "2026-11-27", lastReviewed: "2026-11-24", gameKey: "g3" }),
  ];
  assert.deepEqual(ids(buildSession(puzzles, { today: "2026-11-24", cap: 2 })), ["a"]);
});

test("the session avoids repeating a game first and a theme second", () => {
  const puzzles = [
    puzzle("a1", { gameKey: "A", theme: "hanging", createdAt: "2026-11-01" }),
    puzzle("a2", { gameKey: "A", theme: "hanging", createdAt: "2026-11-02" }),
    puzzle("b1", { gameKey: "B", theme: "hanging", createdAt: "2026-11-03" }),
    puzzle("c1", { gameKey: "C", theme: "missed-mate", createdAt: "2026-11-04" }),
  ];
  assert.deepEqual(ids(buildSession(puzzles, { today: "2026-11-24" })), ["a1", "c1", "a2", "b1"]);
});

test("theme practice puts due puzzles first, includes ones not yet due, and skips mastered ones", () => {
  const puzzles = [
    puzzle("later", { due: "2026-12-01", gameKey: "g1" }),
    puzzle("due", { due: "2026-11-20", gameKey: "g2" }),
    puzzle("other", { due: "2026-11-20", theme: "missed-mate", gameKey: "g3" }),
    puzzle("done", { mastered: true, gameKey: "g4" }),
  ];
  const session = buildSession(puzzles, { today: "2026-11-24", filter: (p) => p.theme === "hanging" });
  assert.deepEqual(ids(session), ["due", "later"]);
});

test("a failed puzzle comes back once at the end of the session", () => {
  let queue = startQueue([puzzle("a"), puzzle("b")]);
  assert.equal(currentId(queue), "a");
  assert.equal(isRepeat(queue), false);
  queue = advanceQueue(queue, OUTCOMES.fail);
  assert.equal(currentId(queue), "b");
  queue = advanceQueue(queue, OUTCOMES.pass);
  assert.equal(currentId(queue), "a");
  assert.equal(isRepeat(queue), true);
  queue = advanceQueue(queue, OUTCOMES.fail);
  assert.equal(currentId(queue), null);
});
