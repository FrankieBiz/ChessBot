import assert from "node:assert/strict";
import { test } from "node:test";
import { findTactic } from "../motifs.js";

const squares = (tactic) => tactic.targets.map(({ square, piece }) => `${piece}${square}`).sort();

test("a knight check that also attacks the queen is a fork", () => {
  const tactic = findTactic("2q3k1/8/8/3N4/8/8/8/6K1 w - - 0 1", ["d5e7", "g8f8", "e7c8"]);
  assert.equal(tactic.kind, "fork");
  assert.equal(tactic.san, "Ne7+");
  assert.equal(tactic.attacker, "e7");
  assert.equal(tactic.attackerPiece, "n");
  assert.deepEqual(squares(tactic), ["kg8", "qc8"]);
  assert.equal(tactic.gain, 9);
  assert.deepEqual(tactic.lead, []);
});

test("a check with the queen behind the king on the same line is a skewer", () => {
  const tactic = findTactic("6q1/8/4k3/8/8/8/7K/5B2 w - - 0 1", ["f1c4", "e6e5", "c4g8"]);
  assert.equal(tactic.kind, "skewer");
  assert.equal(tactic.attacker, "c4");
  assert.deepEqual(squares(tactic), ["ke6", "qg8"]);
});

test("a rook that pins the queen to the king is a pin", () => {
  const tactic = findTactic("4k3/8/8/4q3/8/8/5K2/R7 w - - 0 1", ["a1e1", "e5e1", "f2e1", "e8d7"]);
  assert.equal(tactic.kind, "pin");
  assert.deepEqual(squares(tactic), ["ke8", "qe5"]);
  assert.equal(tactic.gain, 4);
});

test("a knight move that uncovers a bishop check and hits the queen is a discovered check", () => {
  const tactic = findTactic("8/7k/4q3/8/8/3N4/8/1B4K1 w - - 0 1", ["d3f4", "h7h8", "f4e6"]);
  assert.equal(tactic.kind, "discovered check");
  assert.equal(tactic.attacker, "b1");
  assert.equal(tactic.attackerPiece, "b");
  assert.deepEqual(squares(tactic), ["kh7", "qe6"]);
});

test("a knight check together with a discovered bishop check is a double check", () => {
  const tactic = findTactic("8/5q1k/8/8/4N3/8/8/1B4K1 w - - 0 1", ["e4g5", "h7g8", "g5f7", "g8f7"]);
  assert.equal(tactic.kind, "double check");
  assert.equal(tactic.gain, 6);
});

test("a rook mate on the eighth rank behind the pawns is a back-rank mate", () => {
  const tactic = findTactic("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", ["a1a8"]);
  assert.equal(tactic.kind, "back-rank mate");
  assert.equal(tactic.mates, true);
});

test("taking an undefended piece is a free capture", () => {
  const tactic = findTactic("4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1", ["d1d5", "e8e7"]);
  assert.equal(tactic.kind, "free capture");
  assert.deepEqual(squares(tactic), ["nd5"]);
  assert.equal(tactic.gain, 3);
});

test("a fork that the line shows winning nothing is not named", () => {
  // The queen on e8 takes the knight at once.
  assert.equal(findTactic("2r1q1k1/8/8/3N4/8/8/8/6K1 w - - 0 1", ["d5e7", "e8e7"]), null);
});

test("a forcing first move can lead into the tactic", () => {
  const tactic = findTactic("4k3/5p1q/8/8/2B5/5N2/8/6K1 w - - 0 1",
    ["c4f7", "e8f7", "f3g5", "f7g8", "g5h7", "g8h7"]);
  assert.equal(tactic.kind, "fork");
  assert.equal(tactic.san, "Ng5+");
  assert.deepEqual(tactic.lead, ["Bxf7+", "Kxf7"]);
  assert.deepEqual(squares(tactic), ["kf7", "qh7"]);
  assert.equal(tactic.gain, 4);
});

test("a quiet move that wins material later is not credited to a tactic", () => {
  assert.equal(findTactic("4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1", ["e1e2", "e8e7", "d1d5"]), null);
});

test("illegal or empty lines give no tactic", () => {
  assert.equal(findTactic("4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1", []), null);
  assert.equal(findTactic("4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1", ["a1a2"]), null);
  assert.equal(findTactic("not a fen", ["e2e4"]), null);
});

test("tactics read from the reviewed player's side", async () => {
  const { describeTactic, tacticName } = await import("../motifs.js");
  const fork = findTactic("2q3k1/8/8/3N4/8/8/8/6K1 w - - 0 1", ["d5e7", "g8f8", "e7c8"]);
  assert.equal(tacticName(fork), "knight fork");
  assert.equal(describeTactic(fork, { owner: "opponent", color: "w" }),
    "White has a knight fork. Ne7+ attacks your king on g8 and your queen on c8. " +
    "In Stockfish's line, White wins 9 points of material.");
  assert.equal(describeTactic(fork, { owner: "player", color: "w", missed: true }),
    "You missed a knight fork. Ne7+ attacks the king on g8 and the queen on c8. " +
    "In Stockfish's line, you would win 9 points of material.");
  assert.match(describeTactic(fork, { owner: "player", color: "w" }), /^This is a knight fork\. Ne7\+ attacks the king/);

  const lead = findTactic("4k3/5p1q/8/8/2B5/5N2/8/6K1 w - - 0 1", ["c4f7", "e8f7", "f3g5", "f7g8", "g5h7", "g8h7"]);
  assert.match(describeTactic(lead, { owner: "player", color: "w" }), /^This is a knight fork\. After Bxf7\+ Kxf7, Ng5\+ attacks the king on f7 and the queen on h7\./);

  const discovered = findTactic("8/7k/4q3/8/8/3N4/8/1B4K1 w - - 0 1", ["d3f4", "h7h8", "f4e6"]);
  assert.match(describeTactic(discovered, { owner: "opponent", color: "w" }),
    /Nf4\+ uncovers the bishop on b1, which gives check, while the moved piece hits your queen on e6\./);

  const mate = findTactic("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", ["a1a8"]);
  assert.equal(describeTactic(mate, { owner: "opponent", color: "w" }),
    "White has a back-rank mate. Ra8# mates on the back rank: the king is trapped behind its own pawns.");

  const capture = findTactic("4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1", ["d1d5", "e8e7"]);
  assert.match(describeTactic(capture, { owner: "opponent", color: "w" }), /Rxd5 takes your undefended knight on d5\./);
});

test("a short forced mate names the mate, not the first move's pattern", async () => {
  const { describeTactic } = await import("../motifs.js");
  // Re8+ also attacks the rook on d8, but the point is the back-rank mate after Rxe8.
  const tactic = findTactic("3r2k1/5ppp/8/8/8/8/4R3/4R1K1 w - - 0 1", ["e2e8", "d8e8", "e1e8"]);
  assert.equal(tactic.kind, "back-rank mate");
  assert.deepEqual(tactic.lead, ["Re8+", "Rxe8"]);
  assert.equal(describeTactic(tactic, { owner: "player", color: "w" }),
    "This forces a back-rank mate. After Re8+ Rxe8, Rxe8# mates on the back rank: the king is trapped behind its own pawns.");
});

test("a recapture is not a tactic once the exchange baseline is known", () => {
  // Black just took a knight on f3; gxf3 only wins it back.
  const before = "r1bqkb1r/pppp1ppp/5n2/4p3/4P3/5n2/PPPP1PPP/RNBQKB1R w KQkq - 0 1";
  const earlier = "r1bqkb1r/pppp1ppp/5n2/4p3/3nP3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 0 1";
  assert.equal(findTactic(before, ["g2f3", "d7d6"]).kind, "free capture");
  assert.equal(findTactic(before, ["g2f3", "d7d6"], { baselineFen: earlier }), null);
});

test("a pin the line never cashes in is not named", () => {
  // Bb5 pins the knight, but the line just develops.
  assert.equal(findTactic("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1",
    ["f1b5", "g8f6", "e1g1", "f8e7"]), null);
});

test("the material count waits for an exchange in progress to finish", () => {
  // 16...Rfe8?? 17.Bxf7+ Kh8 18.Bxe8 Rxe8 19.Rf8+ Rxf8 20.Bxf8 from a club game.
  const fen = "r3r1k1/pp3ppp/3B4/6N1/2Bn2b1/P1n5/P5PP/R4RK1 w - - 2 17";
  const tactic = findTactic(fen, ["c4f7", "g8h8", "f7e8", "a8e8", "f1f8", "e8f8", "d6f8", "h7h6"], { baselineFen: fen });
  assert.equal(tactic?.kind, "fork");
  assert.deepEqual(squares(tactic), ["kg8", "re8"]);
  assert.equal(tactic.gain, 3);
});

test("a promotion's material is named in the outcome", async () => {
  const { describeTactic } = await import("../motifs.js");
  const tactic = findTactic("7r/1P6/8/4k3/8/8/8/4K3 w - - 0 1", ["b7b8q", "e5f5", "b8h8"]);
  assert.equal(tactic.kind, "fork");
  assert.equal(tactic.promotes, true);
  assert.match(describeTactic(tactic, { owner: "player", color: "w" }), /you win 13 points of material, counting the promotion\.$/);
});

