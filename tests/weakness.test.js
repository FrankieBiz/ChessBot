import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { THEMES, gameDate, isLowClock, themeForTag, themeLabel, userResult } from "../weakness.js";
import { parseReviewGame } from "../analysis.js";
import { computeGameInsights } from "../coach.js";
import { computeProGameAccuracy, evalToWinWhite } from "../engine.js";
import { pgnSideFor, confirmedSide, gameAccuracy, reportFilter, summarizeGame, userDecisions, weaknessReport } from "../weakness.js";
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
  // Tactic tags come from motifs.js labels: the label when allowed, "Missed …" when missed.
  const { TACTIC_LABEL } = await import("../motifs.js");
  for (const [kind, label] of Object.entries(TACTIC_LABEL)) {
    tags.add(label);
    if (kind !== "free capture" && !kind.endsWith("mate")) tags.add(`Missed ${label}`);
  }
  tags.add("Missed Free Piece");
  const { REASON_TAGS } = await import("../coach-reasons.js");
  for (const tag of REASON_TAGS) tags.add(tag);
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
  const source = clockReview();
  source.moveReviews = source.moveReviews.map((review, ply) => {
    if (!review) return review;
    if (ply % 2 === 0) return { ...review, accuracy: 10 };
    return ply === 3 ? { ...review, forced: true, accuracy: 0 } : { ...review, accuracy: 90 };
  });
  const { positions, evals, moveReviews } = source;
  const winTimeline = evals.map((e) => evalToWinWhite(e.eval));
  const userMoves = [1, 5].map((ply) => ({ ply, accuracy: 90 }));
  const result = gameAccuracy({ ...source, playedColor: "w" });
  assert.equal(result.accuracy, computeProGameAccuracy(winTimeline, userMoves));
  assert.deepEqual(result.phaseAccuracy, computeGameInsights({ positions, winTimeline, moveReviews, playedColor: "w" }));
  const withForced = computeProGameAccuracy(winTimeline, [{ ply: 1, accuracy: 90 }, { ply: 3, accuracy: 0 }, { ply: 5, accuracy: 90 }]);
  assert.notEqual(result.accuracy, withForced);
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

function game(i, overrides = {}) {
  return {
    gameKey: `g${i}`, reviewedAt: 1000 + i, date: "2026-11-01", color: "w", result: 1, timeClass: "blitz",
    opponent: "", depth: 16, decisions: 20, phaseMoves: { opening: 5, middlegame: 10, endgame: 5 },
    phaseAccuracy: { opening: 90, middlegame: 80, endgame: 70 }, accuracy: 80, clock: null,
    maxExpectedScore: 60, mistakes: [], ...overrides,
  };
}
const mistake = (theme, extra = {}) => ({ ply: 9, theme, phase: "middlegame", lowClock: null, findChance: null, ...extra });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test("the report waits for five reviewed games", () => {
  assert.deepEqual(weaknessReport([0, 1, 2, 3].map((i) => game(i))), { ready: false, games: 4, needed: 5 });
});

test("the report covers the 50 most recently reviewed games", () => {
  const games = Array.from({ length: 55 }, (_, i) => game(i));
  games[0].mistakes = [mistake("hanging"), mistake("hanging"), mistake("hanging")];
  const report = weaknessReport(games);
  assert.equal(report.games, 50);
  assert.equal(report.moves, 1000);
  assert.equal(report.mistakes, 0);
});

test("mistake types are ranked, rare ones go under Less common, and main focus needs five cases", () => {
  const positional = Array.from({ length: 5 }, () => mistake("positional"));
  const games = [
    game(0, { mistakes: [mistake("hanging"), mistake("hanging"), ...positional] }),
    game(1, { mistakes: [mistake("hanging")] }),
    game(2, { mistakes: [mistake("hanging"), mistake("allowed-tactic")] }),
    game(3, { mistakes: [mistake("allowed-tactic")] }),
    game(4),
  ];
  const { themes, moves } = weaknessReport(games);
  assert.equal(moves, 100);
  assert.deepEqual(themes.common.map((row) => [row.id, row.count, row.games]), [["positional", 5, 1], ["hanging", 4, 3]]);
  assert.equal(themes.common[0].label, "No single tactic");
  close(themes.common[0].per100, 5);
  assert.deepEqual(themes.lessCommon.map((row) => [row.id, row.count]), [["allowed-tactic", 2]]);
  assert.equal(themes.focus, "positional");

  games[0].mistakes.pop();
  const tied = weaknessReport(games).themes;
  assert.deepEqual(tied.common.map((row) => row.id), ["hanging", "positional"]);
  assert.equal(tied.focus, null);
});

test("the easy share counts mistakes where at least 70% find a sound move and skips unknown estimates", () => {
  const games = [0, 1, 2, 3, 4].map((i) => game(i));
  games[0].mistakes = [80, 70, 69.9, null].map((findChance) => mistake("hanging", { findChance }));
  assert.deepEqual(weaknessReport(games).easy, { easy: 2, rated: 3, unrated: 1 });
});

test("phase and overall accuracy are weighted by the user's moves", () => {
  const games = [
    game(0, {
      accuracy: 60, phaseMoves: { opening: 10, middlegame: 10, endgame: 0 },
      phaseAccuracy: { opening: 90, middlegame: 70, endgame: null },
    }),
    ...[1, 2, 3, 4].map((i) => game(i)),
  ];
  const { phases, overall } = weaknessReport(games);
  assert.equal(phases.opening.games, 5);
  close(phases.opening.accuracy, 90);
  close(phases.middlegame.accuracy, 78);
  assert.equal(phases.endgame.games, 4);
  close(phases.endgame.accuracy, 70);
  close(overall, 76);
});

test("low-clock rates use only games with clocks", () => {
  const games = [
    game(0, {
      clock: { lowDecisions: 4, otherDecisions: 16 },
      mistakes: [mistake("hanging", { lowClock: true }), mistake("hanging", { lowClock: true }),
        mistake("hanging", { lowClock: false })],
    }),
    game(1, { clock: { lowDecisions: 2, otherDecisions: 18 }, mistakes: [mistake("hanging", { lowClock: false })] }),
    game(2, { mistakes: [mistake("hanging")] }),
    game(3),
    game(4),
  ];
  const { clock } = weaknessReport(games);
  assert.equal(clock.games, 2);
  assert.equal(clock.lowMoves, 6);
  assert.equal(clock.otherMoves, 34);
  assert.equal(clock.lowMistakes, 2);
  assert.equal(clock.otherMistakes, 2);
  close(clock.lowRate, 200 / 6);
  close(clock.otherRate, 200 / 34);
  assert.equal(weaknessReport([0, 1, 2, 3, 4].map((i) => game(i))).clock, null);
});

test("unconverted wins need an expected score of 85 or more and a known result", () => {
  const games = [
    game(0, { maxExpectedScore: 85, result: 0.5 }),
    game(1, { maxExpectedScore: 84.9, result: 0 }),
    game(2, { maxExpectedScore: 95, result: 1 }),
    game(3, { maxExpectedScore: 90, result: null }),
    game(4, { maxExpectedScore: 99, result: 0 }),
  ];
  const { conversion } = weaknessReport(games);
  assert.equal(conversion.winning, 3);
  assert.equal(conversion.unconverted, 2);
  assert.deepEqual(conversion.gameKeys.sort(), ["g0", "g4"]);
});

test("report filters select the matching puzzles", () => {
  const p = { gameKey: "g4", theme: "hanging", phase: "endgame", lowClock: true, findChance: 70 };
  assert.equal(reportFilter("theme", "hanging")(p), true);
  assert.equal(reportFilter("theme", "positional")(p), false);
  assert.equal(reportFilter("phase", "endgame")(p), true);
  assert.equal(reportFilter("lowClock")(p), true);
  assert.equal(reportFilter("lowClock")({ ...p, lowClock: null }), false);
  assert.equal(reportFilter("easy")(p), true);
  assert.equal(reportFilter("easy")({ ...p, findChance: null }), false);
  assert.equal(reportFilter("unconverted", ["g4"])(p), true);
  assert.equal(reportFilter("unconverted", ["g1"])(p), false);
  assert.throws(() => reportFilter("rating"), /Unknown report filter/);
});

test("a tie at the top has no main focus", () => {
  const games = [0, 1, 2, 3, 4].map((i) => game(i));
  games[0].mistakes = [...Array(6).fill(0).map(() => mistake("positional")), ...Array(6).fill(0).map(() => mistake("hanging"))];
  const { themes } = weaknessReport(games);
  assert.equal(themes.focus, null);
  assert.deepEqual(themes.common.map((row) => row.id).sort(), ["hanging", "positional"]);
});

test("a mistake type needs three cases to leave Less common", () => {
  const games = [0, 1, 2, 3, 4].map((i) => game(i));
  games[0].mistakes = [mistake("allowed-tactic"), mistake("allowed-tactic"), mistake("missed-mate")];
  games[1].mistakes = [mistake("allowed-tactic"), mistake("missed-mate")];
  const { themes } = weaknessReport(games);
  assert.deepEqual(themes.common.map((row) => row.id), ["allowed-tactic"]);
  assert.deepEqual(themes.lessCommon.map((row) => row.id), ["missed-mate"]);
});

test("a side chosen in Load PGN or reopened from Practice is trusted", () => {
  const meta = { colorConfirmed: true, playedColor: "b", white: { username: "x" }, black: { username: "y" } };
  assert.equal(confirmedSide(meta, "someone"), "b");
});

test("a Chess.com game counts only when the signed-in account or saved username plays in it", () => {
  const white = { username: "alice" };
  const black = { username: "bob" };
  assert.equal(confirmedSide({ accountUsername: "Alice", white: { username: "zed" }, black: { username: "alice" } }), "b");
  assert.equal(confirmedSide({ white, black }, " ALICE "), "w");
  assert.equal(confirmedSide({ accountUsername: "carol", white, black }), null);
  assert.equal(confirmedSide({ accountUsername: "carol", white, black }, "alice"), "w");
  assert.equal(confirmedSide({ white, black }), null);
});

test("unchecking Save my mistakes for practice keeps the game out even when the PGN names the user", () => {
  const names = { white: { username: "alice" }, black: { username: "bob" } };
  assert.equal(confirmedSide({ colorConfirmed: false, playedColor: "b", ...names }, "alice"), null);
  assert.equal(confirmedSide({ colorConfirmed: undefined, playedColor: "b", ...names }, "alice"), "w");
});

test("pgnSideFor reads the White and Black tags", () => {
  const pgn = '[Event "x"]\n[White "Alice"]\n[Black "Bob"]\n\n1. e4 *';
  assert.equal(pgnSideFor(pgn, ["alice"]), "w");
  assert.equal(pgnSideFor(pgn, ["", null, " BOB "]), "b");
  assert.equal(pgnSideFor("1. e4 *", ["alice"]), null);
  assert.equal(pgnSideFor(pgn, []), null);
});
