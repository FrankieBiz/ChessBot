import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReviewGame } from "../analysis.js";
import { coachEvidence } from "../coach-evidence.js";

function evidence(pgn, playedPv, grade = "blunder") {
  const position = parseReviewGame(pgn).positions.at(-1);
  return coachEvidence(position, { classification: { key: grade }, playedPv });
}

test("a mating reply highlights the king and keeps the legal line", () => {
  const hint = evidence("1. f3 e5 2. g4 *", ["g2g4", "d8h4"]);
  assert.deepEqual(hint, {
    from: "d8", to: "h4", square: "e1", san: "Qh4#", line: ["d8h4"],
    text: "Black has checkmate with Qh4#.",
  });
});

test("uses the actual capture square and stops at an invalid continuation", () => {
  const hint = evidence("1. e4 a6 2. e5 d5 *", ["d7d5", "e5d6", "a8a8", "d6d7"]);
  assert.equal(hint.square, "d5");
  assert.match(hint.text, /captures the pawn on d5/);
  assert.deepEqual(hint.line, ["e5d6"]);
});

test("a quiet reply describes the piece and destination without claiming a tactic", () => {
  const hint = evidence("1. f3 *", ["f2f3", "e7e5", "g1h3"]);
  assert.equal(hint.square, "e5");
  assert.equal(hint.text, "Black can reply e5, bringing the pawn to e5.");
  assert.deepEqual(hint.line, ["e7e5", "g1h3"]);
});

test("ignores a different game move, illegal reply, and a sound grade", () => {
  const game = "1. f3 e5 2. g4 *";
  assert.equal(evidence(game, ["h2h4", "d8h4"]), null);
  assert.equal(evidence(game, ["g2g4", "e5e8"]), null);
  assert.equal(evidence(game, ["g2g4", "d8h4"], "best"), null);
});
