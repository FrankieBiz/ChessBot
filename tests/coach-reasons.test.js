import assert from "node:assert/strict";
import { test } from "node:test";
import { describeError, describeLoss, explainError } from "../coach-reasons.js";

const explain = (input) => describeError(explainError({ phase: "middlegame", color: "w", ...input }), {
  san: input.san, bestSan: input.bestSan, color: input.color ?? "w",
});

test("losses cancel equal pieces and name the exchange", () => {
  assert.deepEqual(describeLoss(["n"], ["p"]), { phrase: "your knight for a pawn", noun: "a piece for a pawn", left: ["n"] });
  assert.equal(describeLoss(["r"], ["b"]).noun, "the exchange");
  assert.equal(describeLoss(["p", "p"], []).noun, "two pawns");
  assert.equal(describeLoss(["b"], ["n"]), null);
  assert.equal(describeLoss(["n", "p"], ["p"]).phrase, "your knight");
});

test("an undefended pawn that the reply wins is named with its square", () => {
  const result = explain({
    fenBefore: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    fenAfter: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/P4N2/1PPP1PPP/RNBQK2R b KQkq - 0 4",
    playedUci: "a2a3", playedPv: ["a2a3", "f6e4", "d1e2", "d7d5"], bestPv: ["e1g1"], san: "a3", bestSan: "O-O",
  });
  assert.equal(result.title, "a3 loses a pawn");
  assert.equal(result.tag, "Hanging Piece");
  assert.match(result.text, /^Black wins a pawn: Nxe4 takes the pawn on e4, which was undefended\./);
  assert.match(result.text, /Stockfish prefers O-O, which castles your king\.$/);
});

test("a piece attacked more often than it is defended is counted", () => {
  const result = explain({
    fenBefore: "6k1/8/5n2/3p4/4N3/3P4/7P/6K1 w - - 0 1", fenAfter: "6k1/8/5n2/3p4/4N3/3P3P/8/6K1 b - - 0 1",
    playedUci: "h2h3", playedPv: ["h2h3", "d5e4", "d3e4", "f6e4"], bestPv: ["g1f2", "d5e4"], san: "h3", bestSan: "Kf2",
  });
  assert.equal(result.title, "h3 loses a piece");
  assert.match(result.text, /^Black wins your knight: dxe4 takes the knight on e4, which was attacked twice and defended once\./);
});

test("checks in the reply line show king danger", () => {
  const result = explain({
    fenBefore: "3q2k1/8/8/8/8/8/P7/7K w - - 0 1", fenAfter: "3q2k1/8/8/8/8/P7/8/7K b - - 0 1",
    playedUci: "a2a3", playedPv: ["a2a3", "d8d1", "h1h2", "d1d6", "h2h3"], bestPv: ["a2a4"], san: "a3", bestSan: "a4",
  });
  assert.equal(result.title, "a3 exposes your king");
  assert.equal(result.tag, "King Exposed");
  assert.match(result.text, /2 checks, starting with Qd1\+ and then Qd6\+\./);
});

test("a promoting pawn in the reply line is named", () => {
  const result = explain({
    fenBefore: "6k1/8/8/8/8/1p6/8/6K1 w - - 0 1", fenAfter: "6k1/8/8/8/8/1p6/5K2/8 b - - 1 1",
    playedUci: "g1f2", playedPv: ["g1f2", "b3b2", "f2e2", "b2b1q"], bestPv: ["g1f1"], san: "Kf2", bestSan: "Kf1",
  });
  assert.equal(result.title, "Kf2 lets Black's pawn run");
  assert.match(result.text, /^Black's pawn promotes on b1 in Stockfish's line\./);
});

test("a king move that gives up castling is stated, with the castling alternative", () => {
  const result = explain({
    fenBefore: "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", fenAfter: "r3k2r/8/8/8/8/8/8/R4K1R b kq - 1 1",
    playedUci: "e1f1", playedPv: ["e1f1", "e8g8"], bestPv: ["e1g1", "e8g8"], san: "Kf1", bestSan: "O-O",
  });
  assert.equal(result.title, "Kf1 gives up castling");
  assert.equal(result.text, "Kf1 moves your king and gives up castling. Stockfish prefers O-O, which castles your king.");
});

test("a pawn move in front of the castled king is stated as a fact", () => {
  const result = explain({
    fenBefore: "6k1/8/8/8/8/8/5PPP/6K1 w - - 0 1", fenAfter: "6k1/8/8/8/6P1/8/5P1P/6K1 b - - 0 1",
    playedUci: "g2g4", playedPv: ["g2g4", "g8f7"], bestPv: ["g1f1"], san: "g4", bestSan: "Kf1",
  });
  assert.equal(result.title, "g4 loosens your king's cover");
  assert.equal(result.text, "g4 moves a pawn in front of your castled king on g1.");
});

test("an early queen move names the undeveloped pieces and the developing move", () => {
  const result = explain({
    fenBefore: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    fenAfter: "rnbqkbnr/pppp1ppp/8/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 1 2",
    playedUci: "d1h5", playedPv: ["d1h5", "b8c6"], bestPv: ["g1f3", "b8c6"], san: "Qh5", bestSan: "Nf3", phase: "opening",
  });
  assert.equal(result.title, "Qh5 brings the queen out early");
  assert.equal(result.tag, "Early Queen");
  assert.equal(result.text, "Qh5 brings the queen out while 4 minor pieces are still at home. " +
    "Stockfish prefers Nf3, which develops your knight.");
});

test("a retreat that cuts a piece's moves is measured", () => {
  const result = explain({
    fenBefore: "6k1/8/8/8/8/5N2/8/K7 w - - 0 1", fenAfter: "6k1/8/8/8/8/8/8/K5N1 b - - 1 1",
    playedUci: "f3g1", playedPv: ["f3g1", "g8f7"], bestPv: ["f3e5"], san: "Ng1", bestSan: "Ne5",
  });
  assert.equal(result.title, "Ng1 pulls your knight back");
  assert.match(result.text, /^Ng1 pulls your knight back to g1, where it has 3 moves instead of 8\./);
});

test("not taking back a piece the opponent just captured is named", () => {
  const result = explain({
    fenEarlier: "6k1/8/1n6/3P4/4P3/8/7P/K7 b - - 0 1", previousUci: "b6d5", previousCaptured: "p",
    fenBefore: "6k1/8/8/3n4/4P3/8/7P/K7 w - - 0 2", fenAfter: "6k1/8/8/3n4/4P3/7P/8/K7 b - - 0 2",
    playedUci: "h2h3", playedPv: ["h2h3", "d5f4"], bestPv: ["e4d5", "g8f7"], san: "h3", bestSan: "exd5",
  });
  assert.equal(result.title, "h3 doesn't take back");
  assert.equal(result.tag, "Missed Recapture");
  assert.equal(result.text, "exd5 takes back on d5.");
});

test("material the best line would have won is named", () => {
  const result = explain({
    fenBefore: "6k1/8/8/3n4/8/8/8/3RK3 w - - 0 1", fenAfter: "6k1/8/8/3n4/8/8/4K3/3R4 b - - 1 1",
    playedUci: "e1e2", playedPv: ["e1e2", "d5f4", "e2f3", "f4d5"], bestPv: ["d1d5", "g8f7"], san: "Ke2", bestSan: "Rxd5",
  });
  assert.equal(result.title, "Ke2 misses winning a piece");
  assert.equal(result.text, "Rxd5 wins a knight in Stockfish's line.");
});

test("nothing is said when no reason can be verified", () => {
  assert.equal(explain({
    fenBefore: "6k1/8/8/8/8/8/8/K7 w - - 0 1", fenAfter: "6k1/8/8/8/8/8/K7/8 b - - 1 1",
    playedUci: "a1a2", playedPv: ["a1a2", "g8f7"], bestPv: ["a1b2"], san: "Ka2", bestSan: "Kb2",
  }), null);
  assert.equal(explainError({ fenBefore: "x", fenAfter: "y", playedUci: "a1a2", playedPv: [] }), null);
});

test("a capture later in the line is not blamed on the move unless it is a blunder", () => {
  // The pawn on e5 falls only after several quiet moves.
  const input = {
    fenBefore: "6k1/8/8/4p3/8/8/3B4/K7 b - - 0 1", fenAfter: "6k1/8/8/4p3/8/8/3B4/K7 w - - 0 1",
  };
  const line = ["g8f7", "d2c3", "f7e6", "a1b2", "e6d5", "b2c2", "d5e4", "c3e5"];
  const quiet = explainError({ ...input, fenAfter: "8/5k2/8/4p3/8/8/3B4/K7 w - - 1 2", playedUci: "g8f7", playedPv: line,
    bestPv: ["g8g7"], color: "b", phase: "endgame", winLoss: 8 });
  assert.equal(quiet.consequence, null);
  const blunder = explainError({ ...input, fenAfter: "8/5k2/8/4p3/8/8/3B4/K7 w - - 1 2", playedUci: "g8f7", playedPv: line,
    bestPv: ["g8g7"], color: "b", phase: "endgame", winLoss: 30 });
  assert.equal(blunder.consequence.later, true);
  assert.match(describeError(blunder, { san: "Kf7", bestSan: "Kg7", color: "b" }).text,
    /^Further along Stockfish's line, White wins a pawn: after Bc3 Ke6 Kb2 Kd5 Kc2 Ke4, Bxe5 takes the pawn on e5/);
});

test("a capture by the better move is described as a capture", () => {
  const result = explain({
    // The king on c7 takes back, so Rxb8 only trades.
    fenBefore: "1r6/2k5/8/8/8/8/8/1R4K1 w - - 0 1", fenAfter: "1r6/2k5/8/8/8/8/8/R5K1 b - - 1 1",
    playedUci: "b1a1", playedPv: ["b1a1", "c7c6"], bestPv: ["b1b8", "c7b8"], san: "Ra1", bestSan: "Rxb8", winLoss: 8,
  });
  assert.match(result?.text ?? "", /Stockfish prefers Rxb8, which takes the rook on b8\./);
});

test("a queen trade in the opening is not an early queen move", () => {
  const result = explainError({
    fenBefore: "rnb1kbnr/ppppqppp/8/3P4/5p2/8/PPPPQ1PP/RNB1KBNR w KQkq - 1 5",
    fenAfter: "rnb1kbnr/ppppQppp/8/3P4/5p2/8/PPPP2PP/RNB1KBNR b KQkq - 0 5",
    playedUci: "e2e7", playedPv: ["e2e7", "f8e7"], bestPv: ["d2d4"], color: "w", phase: "opening", winLoss: 8,
  });
  assert.notEqual(result.fact?.kind, "queen");
});

test("the deciding capture skips an even recapture", () => {
  // ...axb5 is taken back by axb5, and then bxc6 wins the pawn that decides the material.
  const reasons = explainError({
    fenBefore: "6k1/8/p1p5/1P6/P7/8/8/6K1 b - - 0 1", fenAfter: "6k1/8/2p5/1p6/P7/8/8/6K1 w - - 0 2",
    playedUci: "a6b5", playedPv: ["a6b5", "a4b5", "g8f7", "b5c6"], bestPv: ["c6b5"], color: "b", phase: "endgame", winLoss: 8,
  });
  assert.equal(reasons.consequence.key.san, "bxc6");
  assert.deepEqual(reasons.consequence.key.lead, ["axb5", "Kf7"]);
});

test("the better line's gain ignores an unrelated capture by the opponent's last move", () => {
  // ...Nxa4 took a pawn; Rd7+ then wins the h8 rook without losing anything.
  const result = explain({
    fenEarlier: "7r/6k1/1n6/8/P7/8/8/3RK3 b - - 0 1", previousUci: "b6a4", previousCaptured: "p",
    fenBefore: "7r/6k1/8/8/n7/8/8/3RK3 w - - 0 1", fenAfter: "7r/6k1/8/8/n7/8/4K3/3R4 b - - 1 1",
    playedUci: "e1e2", playedPv: ["e1e2", "a4b6"], bestPv: ["d1d7", "g7g6", "d7d8", "g6f5", "d8h8"],
    san: "Ke2", bestSan: "Rd7+", winLoss: 8,
  });
  assert.equal(result.title, "Ke2 misses winning a rook");
  assert.equal(result.text, "Rd7+ wins a rook in Stockfish's line.");
});

test("recovering a piece the opponent just took is not a gain", () => {
  // ...Nxd5 took a pawn; both exd5 and cxd5 take the knight back, so cxd5 wins nothing extra.
  const reasons = explainError({
    fenEarlier: "6k1/8/1n6/3P4/2P1P3/8/8/K7 b - - 0 1", previousUci: "b6d5", previousCaptured: "p",
    fenBefore: "6k1/8/8/3n4/2P1P3/8/8/K7 w - - 0 2", fenAfter: "6k1/8/8/3P4/2P5/8/8/K7 b - - 0 2",
    playedUci: "e4d5", playedPv: ["e4d5", "g8f7"], bestPv: ["c4d5", "g8f7"], color: "w", phase: "endgame", winLoss: 8,
  });
  assert.equal(reasons.better, null);
});

