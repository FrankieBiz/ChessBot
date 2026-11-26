import assert from "node:assert/strict";
import { test } from "node:test";
import { PEER_PERFORMANCE } from "../performance-data.js";
import { ACCURACY_MODEL_VERSION } from "../engine.js";
import { comparePersonalPerformance, peerDecisionPrediction, peerPerformance } from "../performance.js";

const review = (gameKey, accuracy, options = {}) => ({
  gameKey, gameId: 1000, pgn: '[White "BlitzFan"]\n[Black "Opponent"]\n\n1. e4 e5 *',
  color: "w", depth: 16, date: "2026-11-24", reviewedAt: 1, timeClass: "blitz", decisions: 24,
  result: 1, accuracy, accuracyVersion: ACCURACY_MODEL_VERSION, ...options,
});
const history = [61, 90, 76, 90, 83].map((accuracy, index) => review(`earlier-${index}`, accuracy));

test("personal performance uses the game median and counts earlier decisions", () => {
  const current = review("current", 89);
  const games = [current, ...history, ...history];
  assert.deepEqual(comparePersonalPerformance({ current, history: games }), {
    currentAccuracy: 89, medianAccuracy: 83, difference: 6, games: 5, decisions: 120,
    currentDecisions: 24, timeClass: "blitz", pool: "chess.com",
  });
});

test("personal performance requires a matching player, time class, pool, and target depth", () => {
  const current = review("current", 89);
  const unrelated = [
    review("wrong-player", 100, { color: "b" }),
    review("wrong-speed", 100, { timeClass: "rapid" }),
    review("wrong-depth", 100, { depth: 14 }),
    review("unknown-rating-pool", 100, { gameId: null, timeControl: "300+0" }),
    review("stale", 100, { date: "2025-11-24" }),
    review("later-game", 100, { date: "2026-11-25" }),
    review("short", 100, { decisions: 11 }),
  ];
  assert.equal(comparePersonalPerformance({ current, history: [...history.slice(0, 4), ...unrelated] }), null);
  const alternateSide = review("side-swapped", 83, {
    color: "b", pgn: '[White "Opponent"]\n[Black "blitzfan"]\n\n1. e4 e5 *',
  });
  const comparable = [...history.slice(0, 4), alternateSide, ...unrelated];
  assert.equal(comparePersonalPerformance({ current, history: comparable }).medianAccuracy, 83);
  assert.equal(comparePersonalPerformance({ current: { ...current, decisions: 11 }, history }), null);
});

test("dated legacy offline reviews compare at the exact clock with a named player", () => {
  const asOffline = ({ gameId, date, ...game }) => ({
    ...game, pgn: '[White "BlitzFan"]\n[Black "Opponent"]\n[TimeControl "300+0"]\n\n1. e4 e5 *',
    timeClass: "Custom PGN", reviewedAt: Date.parse(date),
  });
  const current = asOffline(review("current", 89));
  const previous = history.map(asOffline);
  assert.equal(comparePersonalPerformance({ current, history: previous }).timeClass, "5 min");
  const mismatched = previous.map((game) => ({ ...game, pgn: game.pgn.replace("300+0", "180+2") }));
  assert.equal(comparePersonalPerformance({ current, history: mismatched }), null);
  assert.equal(comparePersonalPerformance({ current: { ...current, pgn: "1. e4 e5 *" }, history: previous }), null);
});

test("a personal baseline is limited to the 20 most recent eligible reviews", () => {
  const current = review("current", 89, { reviewedAt: 300 });
  const games = Array.from({ length: 21 }, (_, index) => review(`game-${index}`, index ? 80 : 100, { reviewedAt: index }));
  const baseline = comparePersonalPerformance({ current, history: games });
  assert.equal(baseline.games, 20);
  assert.equal(baseline.decisions, 480);
  assert.equal(baseline.medianAccuracy, 80);
});

test("unfinished reviews and older accuracy scales cannot enter the personal comparison", () => {
  const current = review("current", 89);
  const shortHistory = history.slice(0, 4);
  const unfinished = review("unfinished", 100, { result: null });
  const legacy = review("legacy", 100, { accuracyVersion: 1 });
  const legacyDraw = review("draw", 83, { result: undefined, pgn: `[Result "1/2-1/2"]\n${current.pgn}` });
  assert.equal(comparePersonalPerformance({ current, history: [...shortHistory, unfinished] }), null);
  assert.equal(comparePersonalPerformance({ current, history: [...shortHistory, legacy] }), null);
  assert.equal(comparePersonalPerformance({ current, history: [...shortHistory, legacyDraw] }).games, 5);
  assert.equal(comparePersonalPerformance({ current: unfinished, history }), null);
});

test("peer predictions require a rated clock context and complete initial engine comparison", () => {
  assert.equal(peerDecisionPrediction({}, { lines: [{}, {}] }, "w"), null);
  assert.equal(peerDecisionPrediction({ lichessRatings: { w: 1650, b: 1680 } }, { lines: [{}] }, "w"), null);
});

test("the peer summary refuses casual, other-pool, and short reviews", () => {
  const input = { positions: [], moveReviews: [], color: "w", depth: 16 };
  assert.equal(peerPerformance({ ...input, headers: { Site: "https://www.chess.com/game/live/12345", Event: "Rated Blitz game" } }), null);
  assert.equal(peerPerformance({ ...input, headers: { Site: "https://lichess.org/AbCd1234", Event: "Casual Blitz game" } }), null);
  assert.equal(peerPerformance({ ...input, headers: { Site: "https://lichess.org/AbCd1234", Event: "Rated Blitz game" } }), null);
});

test("no peer band ships until the benchmark supports one", () => {
  for (const model of Object.values(PEER_PERFORMANCE)) {
    assert.ok(model.ratingBands.length > 0 && model.weights.length > 0);
  }
});

test("a supported peer summary sums pre-move probabilities for the chosen side", () => {
  const timeClass = "blitz";
  const models = { blitz: { ratingBands: [[1400, 1799]], weights: [0.4, ...Array(12).fill(0.05)] } };
  const rating = 1650;
  const bases = { bullet: 60, blitz: 300, rapid: 600 };
  const before = {
    lichessRatings: { w: rating, b: 1600 }, legalMoves: 26, captureCount: 3, material: 58, inCheck: false,
    practicalContext: { timeControl: { base: bases[timeClass], increment: 0 }, whiteSeconds: 55, blackSeconds: 50, ply: 16 },
  };
  const root = { lines: [{}, {}], eval: { type: "cp", value: 34 } };
  const prediction = peerDecisionPrediction(before, root, "w", models);
  assert.ok(prediction.chance > 0 && prediction.chance < 1);
  assert.equal(peerDecisionPrediction(before, { ...root, lines: [{}] }, "w", models), null);
  assert.equal(peerDecisionPrediction({ ...before, lichessRatings: { w: 2000, b: 1600 } }, root, "w", models), null);
  const eligible = Array.from({ length: 12 }, (_, index) => ({
    peerDifficulty: prediction, winLoss: index ? 5 : 5.05, forced: false,
  }));
  const positions = [{}, ...eligible.map(() => ({ move: { color: "w" } })), { move: { color: "b" } }, { move: { color: "w" } }];
  const moveReviews = [null, ...eligible, { ...eligible[0], winLoss: 10 }, { ...eligible[0], forced: true }];
  const headers = { Site: "https://lichess.org/AbCd1234", WhiteElo: String(rating), BlackElo: "1600",
    Event: `Rated ${timeClass[0].toUpperCase()}${timeClass.slice(1)} game`, Result: "1-0" };
  const input = { positions, moveReviews, headers, color: "w", depth: 16, models };
  const comparison = peerPerformance(input);
  assert.equal(comparison.observedSound, 11);
  assert.equal(comparison.decisions, 12);
  assert.ok(Math.abs(comparison.expectedSound - prediction.chance * 12) < 1e-10);
  assert.equal(peerPerformance({ ...input, color: "b" }), null);
  assert.equal(peerPerformance({ ...input, depth: 18 }), null);
  assert.equal(peerPerformance({ ...input, headers: { ...headers, Event: `Casual ${timeClass} game` } }), null);
  assert.equal(peerPerformance({ ...input, headers: { ...headers, WhiteElo: "2700" } }), null);
  assert.equal(peerPerformance({ ...input, headers: { ...headers, Result: "*" } }), null);
  assert.equal(peerPerformance({ ...input, moveReviews: moveReviews.slice(0, 11) }), null);
});
