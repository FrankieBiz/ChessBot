import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { THEMES, gameDate, isLowClock, themeForTag, themeLabel, userResult } from "../weakness.js";
import { parseReviewGame } from "../analysis.js";
import { gameAccuracy, summarizeGame, userDecisions } from "../weakness.js";
import { decision } from "./fixtures/training.js";

test("coach tags map to report rows, and unknown tags fall back to No single tactic", () => {
  assert.equal(themeForTag("Hanging Piece"), "hanging");
  assert.equal(themeForTag("Engine Capture"), "allowed-tactic");
  assert.equal(themeForTag("Missed Defense"), "allowed-mate");
  assert.equal(themeForTag("Missed Tactic"), "missed-material");
  assert.equal(themeForTag("Missed Mate"), "missed-mate");
  assert.equal(themeForTag("Missed Refutation"), "missed-refutation");
  assert.equal(themeForTag("Missed Check"), "missed-forcing");
  assert.equal(themeForTag("Promotion"), "missed-forcing");
  assert.equal(themeForTag("Critical Error"), "positional");
  assert.equal(themeForTag("Positional Slip"), "positional");
  assert.equal(themeForTag("Something New"), "positional");
  assert.equal(themeForTag(null), "positional");
  assert.equal(themeLabel("hanging"), "Left a piece hanging");
});

test("every coach tag for a Mistake, Miss, or Blunder has a report row", async () => {
  const source = await readFile(new URL("../coach.js", import.meta.url), "utf8");
  const tags = new Set();
  for (const [, expression] of source.matchAll(/\btag:\s*([^,\n]+)/g)) {
    // Strings at the start or after ? and : are results; strings after === are comparisons.
    for (const [, tag] of expression.matchAll(/(?:^|[?:]\s*)"([^"]+)"/g)) tags.add(tag);
  }
  const praiseTags = ["Checkmate", "Forced Move", "Tactical Sacrifice", "Critical Move", "Equally Strong",
    "King Safety", "Tactical Precision", "Top Engine Move", "Strong Move", "Solid Play"];
  const mapped = new Set(THEMES.flatMap((theme) => theme.tags));
  assert.deepEqual([...tags].filter((tag) => !praiseTags.includes(tag) && !mapped.has(tag)), []);
  for (const tag of mapped) assert.ok(tags.has(tag), `${tag} is not a tag in coach.js`);
});

test("a clock is low under 10% of the base time or 15 seconds, whichever is larger", () => {
  assert.equal(isLowClock(17.9, 180), true);
  assert.equal(isLowClock(18, 180), false);
  assert.equal(isLowClock(14.9, 60), true);
  assert.equal(isLowClock(15, 60), false);
  assert.equal(isLowClock(59, 600), true);
  assert.equal(isLowClock(null, 180), null);
  assert.equal(isLowClock(30, undefined), null);
});

test("results are scored from the user's side", () => {
  assert.equal(userResult("1-0", "w"), 1);
  assert.equal(userResult("1-0", "b"), 0);
  assert.equal(userResult("0-1", "b"), 1);
  assert.equal(userResult("1/2-1/2", "w"), 0.5);
  assert.equal(userResult("*", "w"), null);
  assert.equal(userResult(undefined, "b"), null);
});

test("a game's date comes from the Chess.com end time, then PGN headers, then the review date", () => {
  const endTime = Math.floor(new Date(2026, 10, 20, 12, 0).getTime() / 1000);
  assert.equal(gameDate({ endTime, headers: { Date: "2001.01.01" } }, "2026-11-24"), "2026-11-20");
  assert.equal(gameDate({ headers: { UTCDate: "2026.11.19", Date: "2026.11.18" } }, "2026-11-24"), "2026-11-19");
  assert.equal(gameDate({ headers: { Date: "2026.11.18" } }, "2026-11-24"), "2026-11-18");
  assert.equal(gameDate({ headers: { Date: "????.??.??" } }, "2026-11-24"), "2026-11-24");
  assert.equal(gameDate({}, "2026-11-24"), "2026-11-24");
});

const CLOCK_PGN = `[Event "Clock test"]
[TimeControl "180"]
[Result "*"]

1. e4 {[%clk 0:02:59]} e5 {[%clk 0:02:58]} 2. Nf3 {[%clk 0:00:10]} Nc6 {[%clk 0:02:50]} 3. Bc4 {[%clk 0:00:09]} *`;

function clockReview() {
  const { positions } = parseReviewGame(CLOCK_PGN);
  const line = (winWhite) => ({ multipv: 1, depth: 16, eval: { type: "cp", value: 30 }, winWhite, pv: ["d2d4"] });
  const evals = positions.map((_, i) => ({ ...line(50 + i), lines: [line(50 + i)] }));
  const review = (key, extra = {}) => ({
    classification: { key, label: key }, forced: false, accuracy: 90, winLoss: 0, bestMoveUci: "d2d4",
    bestSan: "d4", pvSan: "d4", missedMate: null, depth: 16, difficulty: null,
    playedEval: { type: "cp", value: 20 }, playedPv: ["e2e4"], ...extra,
  });
  const moveReviews = [
    null,
    review("best"),
    review("best"),
    // 2. Nf3: a quiet mistake, so the coach tags it Positional Slip.
    review("mistake", { playedEval: { type: "cp", value: -150 }, playedPv: ["g1f3", "d7d5"],
      difficulty: { chance: 72.4, model: "position" } }),
    review("best"),
    // 3. Bc4: allows mate in 1, so the coach tags it Missed Defense.
    review("blunder", { bestMoveUci: "f1b5", playedEval: { type: "mate", value: -1 }, playedPv: ["f1c4", "d8h4"] }),
  ];
  return { positions, evals, moveReviews };
}

test("user decisions carry the position, theme, clock, find chance, and expected score", () => {
  const source = clockReview();
  const decisions = userDecisions({ ...source, playedColor: "w" });
  assert.deepEqual(decisions.map((d) => d.ply), [1, 3, 5]);
  assert.deepEqual(decisions.map((d) => d.theme), [null, "positional", "allowed-mate"]);
  assert.deepEqual(decisions.map((d) => d.lowClock), [null, false, true]);
  assert.deepEqual(decisions.map((d) => d.findChance), [null, 72.4, null]);
  assert.deepEqual(decisions.map((d) => d.expectedBefore), [50, 52, 54]);
  assert.deepEqual(decisions[1].move, { uci: "g1f3", san: "Nf3" });
  assert.equal(decisions[1].fen, source.positions[2].fen);
  assert.deepEqual(decisions[1].searchOptions, source.positions[2].searchOptions);
  assert.equal(decisions[1].phase, source.positions[2].phase);
  assert.equal(decisions[1].root, source.evals[2]);
  assert.equal(decisions[1].review, source.moveReviews[3]);
});

test("Black's decisions use Black's clock and expected score, and forced moves are skipped", () => {
  const source = clockReview();
  const black = userDecisions({ ...source, playedColor: "b" });
  assert.deepEqual(black.map((d) => d.ply), [2, 4]);
  assert.deepEqual(black.map((d) => d.lowClock), [null, false]);
  assert.deepEqual(black.map((d) => d.expectedBefore), [49, 47]);

  source.moveReviews[3] = { ...source.moveReviews[3], forced: true };
  assert.deepEqual(userDecisions({ ...source, playedColor: "w" }).map((d) => d.ply), [1, 5]);
});

test("game accuracy matches the review page's overall and phase scores", () => {
  const { accuracy, phaseAccuracy } = gameAccuracy({ ...clockReview(), playedColor: "w" });
  assert.equal(typeof accuracy, "number");
  assert.deepEqual(Object.keys(phaseAccuracy).sort(), ["endgame", "middlegame", "opening"]);
});

test("a game summary keeps counts, clock totals, the best expected score, and each mistake", () => {
  const decisions = [
    decision({ ply: 3, grade: "good", phase: "opening", lowClock: false, expectedBefore: 52 }),
    decision({ ply: 5, grade: "mistake", theme: "hanging", lowClock: true, findChance: 75, expectedBefore: 88 }),
    decision({ ply: 7, grade: "blunder", theme: "allowed-mate", lowClock: null, findChance: null, expectedBefore: null }),
  ];
  const summary = summarizeGame({
    gameKey: "g", reviewedAt: 5, date: "2026-11-23", color: "w", result: 0.5, timeClass: "blitz",
    opponent: "Rival", depth: 16, decisions, accuracy: 81.5,
    phaseAccuracy: { opening: 95, middlegame: 70, endgame: null },
  });
  assert.deepEqual(summary, {
    gameKey: "g", reviewedAt: 5, date: "2026-11-23", color: "w", result: 0.5, timeClass: "blitz",
    opponent: "Rival", depth: 16, decisions: 3, phaseMoves: { opening: 1, middlegame: 2, endgame: 0 },
    phaseAccuracy: { opening: 95, middlegame: 70, endgame: null }, accuracy: 81.5,
    clock: { lowDecisions: 1, otherDecisions: 1 }, maxExpectedScore: 88,
    mistakes: [
      { ply: 5, theme: "hanging", phase: "middlegame", lowClock: true, findChance: 75 },
      { ply: 7, theme: "allowed-mate", phase: "middlegame", lowClock: null, findChance: null },
    ],
  });
});

test("a game without clocks or scores has null clock totals and expected score", () => {
  const summary = summarizeGame({
    gameKey: "g", reviewedAt: 1, date: "2026-11-23", color: "b", result: null, decisions: [],
    accuracy: null, phaseAccuracy: {},
  });
  assert.equal(summary.clock, null);
  assert.equal(summary.maxExpectedScore, null);
  assert.deepEqual(summary.phaseAccuracy, { opening: null, middlegame: null, endgame: null });
  assert.equal(summary.timeClass, "");
  assert.equal(summary.opponent, "");
});
