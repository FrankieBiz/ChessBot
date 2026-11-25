import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess } from "../vendor/chess.js/chess.js";
import { annotatedPgn, clockTag, evalTag, GRADE_NAG, mistakeComment, pgnFileName, swingText } from "../annotated-pgn.js";

test("tags follow Lichess's computer-analysis format", () => {
  assert.equal(evalTag({ type: "cp", value: 52 }), "[%eval 0.52]");
  assert.equal(evalTag({ type: "cp", value: -320 }), "[%eval -3.20]");
  assert.equal(evalTag({ type: "mate", value: -3 }), "[%eval #-3]");
  assert.equal(evalTag({ type: "mate", value: 0 }), "");
  assert.equal(evalTag(null), "");
  assert.equal(clockTag(178), "[%clk 0:02:58]");
  assert.equal(clockTag(3725.3), "[%clk 1:02:05.3]");
  assert.equal(clockTag(null), "");
  assert.equal(swingText({ type: "cp", value: 52 }, { type: "mate", value: -2 }), "(0.52 → #-2)");
  assert.equal(mistakeComment("blunder", "g4"), "Blunder. g4 was best.");
  assert.equal(mistakeComment("miss", ""), "Miss.");
  assert.equal(mistakeComment("good", "g4"), "");
  assert.equal(GRADE_NAG.inaccuracy, 6);
});

test("the movetext numbers Black's move again after a comment or variation", () => {
  const pgn = annotatedPgn({
    headers: { White: "vmpc", Black: "adam \"the\" rook", Result: "0-1", TimeControl: "180+2" },
    annotator: "ChessBot 3.8.0",
    moves: [
      { san: "e4", color: "w", number: 1 },
      { san: "f6", color: "b", number: 1, nag: 6, eval: { type: "cp", value: 80 }, comment: "Inaccuracy. e5 was best.",
        variation: [{ number: "1...", san: "e5" }, { number: "2.", san: "Nf3" }] },
      { san: "d4", color: "w", number: 2, clock: 178 },
      { san: "g5", color: "b", number: 2, nag: 4, eval: { type: "mate", value: 1 } },
      { san: "Qh5#", color: "w", number: 3 },
    ],
  });
  const [header, movetext] = pgn.split("\n\n");
  assert.deepEqual(header.split("\n"), [
    '[Event "?"]', '[Site "?"]', '[Date "?"]', '[Round "?"]', '[White "vmpc"]', '[Black "adam \\"the\\" rook"]',
    '[Result "0-1"]', '[TimeControl "180+2"]', '[Annotator "ChessBot 3.8.0"]',
  ]);
  assert.equal(movetext.trim(),
    "1. e4 f6 $6 { [%eval 0.80] Inaccuracy. e5 was best. } ( 1... e5 2. Nf3 ) " +
    "2. d4 { [%clk 0:02:58] } 2... g5 $4 { [%eval #1] } 3. Qh5# 0-1");
});

test("the export loads back into chess.js with the same moves", () => {
  const pgn = annotatedPgn({
    headers: { Result: "1-0" },
    moves: [
      { san: "e4", color: "w", number: 1, eval: { type: "cp", value: 30 }, clock: 60 },
      { san: "e5", color: "b", number: 1, nag: 2, comment: "(0.30 → 1.10) Mistake {sic}. c5 was best.",
        variation: [{ number: "1...", san: "c5" }] },
      { san: "Qh5", color: "w", number: 2 },
    ],
  });
  const game = new Chess();
  game.loadPgn(pgn);
  assert.deepEqual(game.history(), ["e4", "e5", "Qh5"]);
  assert.ok(!pgn.includes("{sic}"), "braces inside a comment would end it early");
});

test("a game from a set-up position gets SetUp before its FEN", () => {
  const fen = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1";
  const pgn = annotatedPgn({ headers: { Result: "*", FEN: fen, Termination: "Normal" }, moves: [{ san: "e4", color: "w", number: 1 }] });
  const tags = pgn.split("\n\n")[0].split("\n");
  assert.deepEqual(tags.slice(7), ['[SetUp "1"]', `[FEN "${fen}"]`, '[Termination "Normal"]']);
  const game = new Chess();
  game.loadPgn(pgn);
  assert.deepEqual(game.history(), ["e4"]);
});

test("file names are safe and name the players", () => {
  assert.equal(pgnFileName({ White: "vmpc", Black: "adam soyadam", Date: "2026.10.01" }), "ChessBot_vmpc_vs_adam_soyadam_2026.10.01.pgn");
  assert.equal(pgnFileName({ Date: "????.??.??" }), "ChessBot_White_vs_Black.pgn");
});
