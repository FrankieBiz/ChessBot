import assert from "node:assert/strict";
import { test } from "node:test";
import { captureGain, describeThreat, lineSteps, lineText, threatFen } from "../lines.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

test("line steps carry SAN, the position after each move, and scoresheet numbers", () => {
  const steps = lineSteps(START, ["e2e4", "e7e5", "g1f3", "b8c6"]);
  assert.deepEqual(steps.map(({ number, san }) => [number, san]), [["1.", "e4"], ["", "e5"], ["2.", "Nf3"], ["", "Nc6"]]);
  assert.equal(steps[0].fen, "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
  assert.deepEqual([steps[2].from, steps[2].to], ["g1", "f3"]);
  assert.equal(lineText(steps), "1. e4 e5 2. Nf3 Nc6");
  assert.deepEqual(steps.map(({ label }) => label), ["1. e4", "1... e5", "2. Nf3", "2... Nc6"]);
});

test("a line that starts with Black's move gets an ellipsis number", () => {
  const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
  assert.equal(lineText(lineSteps(fen, ["c7c5", "g1f3", "d7d6"])), "1... c5 2. Nf3 d6");
});

test("line steps stop at an illegal move or the limit, and handle promotions", () => {
  assert.equal(lineSteps(START, ["e2e4", "e2e4", "d7d5"]).length, 1);
  assert.equal(lineSteps(START, ["e2e4", "e7e5", "g1f3"], 2).length, 2);
  assert.deepEqual(lineSteps("bad fen", ["e2e4"]), []);
  assert.deepEqual(lineSteps(START, null), []);
  const promotion = lineSteps("8/P6k/8/8/8/8/8/K7 w - - 0 1", ["a7a8n"]);
  assert.equal(promotion[0].san, "a8=N");
});

test("the threat position gives the other side the move and clears en passant", () => {
  const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
  assert.equal(threatFen(afterE4), "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2");
  assert.equal(threatFen(START), "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 1 1");
});

test("there is no threat position when the side to move is in check or the game is over", () => {
  assert.equal(threatFen("4k3/8/8/8/8/8/4q3/4K3 w - - 0 1"), null);
  assert.equal(threatFen("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"), null);
  assert.equal(threatFen("not a fen"), null);
});

const step = (san) => ({ san });

test("a mate threat is named with its length", () => {
  const threat = describeThreat({ attacker: "b", steps: [step("Qxf2+")], threatEval: { type: "mate", value: -2 } });
  assert.deepEqual(threat, { headline: "Black threatens mate in 2, starting with Qxf2+.", serious: true });
  assert.equal(describeThreat({ attacker: "w", steps: [step("Qh7#")], threatEval: { type: "mate", value: 1 } }).headline,
    "White threatens mate, starting with Qh7#.");
});

test("a threat that costs little is not called serious", () => {
  const threat = describeThreat({
    attacker: "w", steps: [step("Nf5")], threatEval: { type: "cp", value: 60 }, currentEval: { type: "cp", value: 40 },
  });
  assert.deepEqual(threat, { headline: "No serious threat. White's best try would be Nf5.", serious: false });
});

test("a serious threat names the tactic in its line", () => {
  const tactic = { kind: "fork", attackerPiece: "n", san: "Nc2+", lead: [] };
  const threat = describeThreat({
    attacker: "b", steps: [step("Nc2+")], threatEval: { type: "cp", value: -400 }, currentEval: { type: "cp", value: 30 }, tactic,
  });
  assert.deepEqual(threat, { headline: "Black threatens a knight fork with Nc2+.", serious: true });
  const free = describeThreat({
    attacker: "b", steps: [step("Qxb4")], threatEval: { type: "cp", value: -820 }, currentEval: { type: "cp", value: 0 },
    tactic: { kind: "free capture", san: "Qxb4", lead: [], targets: [{ square: "b4", piece: "r" }] },
  });
  assert.deepEqual(free, { headline: "Black threatens Qxb4, winning the undefended rook on b4.", serious: true });
  const plain = describeThreat({
    attacker: "b", steps: [step("Bxh2")], threatEval: { type: "cp", value: -300 }, currentEval: { type: "cp", value: 0 },
  });
  assert.deepEqual(plain, { headline: "Black threatens Bxh2.", serious: true });
});

test("a threat to win material counts in a game that is already decided", () => {
  // White is lost either way, so expected score hardly changes, but the threat still wins four pawns.
  const threat = describeThreat({
    attacker: "b", steps: [step("Rxb1")], threatEval: { type: "cp", value: -940 }, currentEval: { type: "cp", value: -540 },
  });
  assert.deepEqual(threat, { headline: "Black threatens Rxb1.", serious: true });
  const small = describeThreat({
    attacker: "b", steps: [step("a5")], threatEval: { type: "cp", value: -980 }, currentEval: { type: "cp", value: -900 },
  });
  assert.equal(small.serious, false);
});

test("a quiet move that gains only because the other side passed is not called a threat", () => {
  const quiet = describeThreat({
    attacker: "w", steps: [step("Ke2")], threatEval: { type: "cp", value: -60 }, currentEval: { type: "cp", value: -230 },
  });
  assert.deepEqual(quiet, { headline: "No direct threat. If Black passed, White would play Ke2.", serious: false });
});

test("the material a capture wins counts every recapture, even a delayed one", () => {
  // The position after 35...Rxb4 of a real game, with Black to move again: Rxb1 Nxb1 wins the queen for a rook.
  const passed = "2R5/3rqk2/2p1p3/3pPp2/1rnP1bn1/2N2N2/2P1K1P1/1Q4B1 b - - 1 36";
  const steps = lineSteps(passed, ["b4b1", "c3b1", "e7b4", "g2g3"]);
  assert.equal(captureGain(passed, steps), 4);
  // Stockfish's line can put off the recapture: Rxb1 g3 Bh6 Rh8 Qb4 Nxb1 still wins only four.
  assert.equal(captureGain(passed, lineSteps(passed, ["b4b1", "g2g3", "f4h6", "c8h8", "e7b4", "c3b1"])), 4);
  assert.equal(captureGain(passed, lineSteps(passed, ["b4b1", "c3b1", "e7b4", "g2g3", "b4b1", "g3f4"])), 4);
  assert.equal(captureGain(START, lineSteps(START, ["e2e4"])), 0);
  const threat = describeThreat({
    attacker: "b", steps, threatEval: { type: "cp", value: -850 }, currentEval: { type: "cp", value: -760 }, gain: 4,
  });
  assert.deepEqual(threat, { headline: "Black threatens Rxb1, winning 4 points of material.", serious: true });
});

test("without the current evaluation a threat is shown but not judged", () => {
  const threat = describeThreat({ attacker: "w", steps: [step("Bxf7+")], threatEval: { type: "cp", value: 50 } });
  assert.deepEqual(threat, { headline: "White threatens Bxf7+.", serious: false });
});
