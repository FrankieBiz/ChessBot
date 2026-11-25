import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advantagePoints, areaPath, formatSeconds, linePath, moveLabel, moveTimes, phaseDivisions, plyAt,
} from "../eval-chart.js";

const position = (phase, move = null, practicalContext = null) => ({ phase, move, practicalContext });

test("phase divisions mark the first middlegame and endgame plies", () => {
  const positions = ["opening", "opening", "middlegame", "middlegame", "endgame", "endgame"].map((phase) => position(phase));
  assert.deepEqual(phaseDivisions(positions), { middlegame: 2, endgame: 4 });
  assert.deepEqual(phaseDivisions(positions.slice(0, 2)), { middlegame: null, endgame: null });
  // A game that goes straight to an endgame has no middlegame line.
  assert.deepEqual(phaseDivisions(["opening", "endgame", "middlegame"].map((phase) => position(phase))),
    { middlegame: null, endgame: 1 });
});

test("move times come from each side's clock before and after, plus the increment", () => {
  const control = { base: 180, increment: 2 };
  const at = (color, white, black) => position("opening", { color }, { timeControl: control, whiteSeconds: white, blackSeconds: black });
  const positions = [
    { phase: "opening", move: null, practicalContext: { timeControl: control, whiteSeconds: null, blackSeconds: null } },
    at("w", 178, null), at("b", 178, 175), at("w", 170, 175), at("b", 170, 176),
  ];
  assert.deepEqual(moveTimes(positions), [null, 4, 7, 10, 1]);
});

test("a game without clocks has no move times", () => {
  assert.equal(moveTimes([position("opening"), position("opening", { color: "w" })]), null);
  const control = { base: 60, increment: 0 };
  const noComments = [position("opening", null, { timeControl: control }),
    position("opening", { color: "w" }, { timeControl: control, whiteSeconds: null, blackSeconds: null })];
  assert.equal(moveTimes(noComments), null);
});

test("advantage points put an even game in the middle and clamp the extremes", () => {
  const points = advantagePoints([50, 100, 0, null, 150], 5, 400, 100);
  assert.deepEqual(points.map(({ x, y }) => [x, y]), [[0, 50], [100, 0], [200, 100], [300, 50], [400, 0]]);
  assert.equal(points[3].known, false);
});

test("the area runs from the center along the line and back", () => {
  const points = advantagePoints([50, 80], 2, 10, 100);
  assert.equal(areaPath(points, 50), "M0.00,50 L0.00,50.00 L10.00,20.00 L10.00,50 Z");
  assert.equal(linePath(points), "M0.00,50.00 L10.00,20.00");
});

test("chart positions map to the nearest ply", () => {
  assert.equal(plyAt(0, 41), 0);
  assert.equal(plyAt(0.51, 41), 20);
  assert.equal(plyAt(1.4, 41), 40);
  assert.equal(plyAt(-1, 41), 0);
});

test("labels and times read like a scoresheet", () => {
  assert.equal(moveLabel({ move: { number: 12, color: "b", san: "Nf3" } }), "12... Nf3");
  assert.equal(moveLabel({ move: { number: 3, color: "w", san: "Bb5" } }), "3. Bb5");
  assert.equal(moveLabel({ move: null }), "Start");
  assert.equal(formatSeconds(4), "4 s");
  assert.equal(formatSeconds(4.25), "4.3 s");
  assert.equal(formatSeconds(42.4), "42 s");
  assert.equal(formatSeconds(65), "1:05");
  assert.equal(formatSeconds(null), "--");
});
