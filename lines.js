// Engine lines as moves a player can step through, and the position used to show a threat.
import { Chess } from "./vendor/chess.js/chess.js";
import { cpToWinProbability } from "./engine.js";
import { PIECE_NAME, tacticName } from "./motifs.js";
import { parseUciMove } from "./variation.js";

const SIDE = { w: "White", b: "Black" };
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
// A threat is serious when ignoring it would cost the side to move this much expected score (0–100),
// or this many centipawns. Expected score barely moves in a decided game, where material still matters.
const SERIOUS_THREAT = 10;
const SERIOUS_THREAT_CP = 150;
// An exchange that wins this much material (in pawns) is a threat whatever the evaluation says.
const MATERIAL_THREAT = 2;

/**
 * The moves of an engine line from `fen`: each with its SAN, the position after it, the move number a
 * scoresheet prints ("12." before White's moves, "12..." when the line starts with Black), and a
 * label that always has the number ("12... Nf6").
 * Stops at the first illegal move.
 */
export function lineSteps(fen, uciMoves, max = 6) {
  if (!fen || !Array.isArray(uciMoves)) return [];
  let game;
  try {
    game = new Chess(fen);
  } catch {
    return [];
  }
  const steps = [];
  for (const uci of uciMoves.slice(0, max)) {
    const parsed = parseUciMove(uci);
    if (!parsed) break;
    const white = game.turn() === "w";
    const number = game.moveNumber();
    let move;
    try {
      move = game.move(parsed);
    } catch {
      break;
    }
    steps.push({
      uci, san: move.san, fen: game.fen(), from: move.from, to: move.to,
      number: white ? `${number}.` : steps.length ? "" : `${number}...`,
      label: `${number}${white ? "." : "..."} ${move.san}`,
    });
  }
  return steps;
}

/** "13. g4 c6 14. gxf5" */
export function lineText(steps) {
  return steps.map(({ number, san }) => (number ? `${number} ${san}` : san)).join(" ");
}

/**
 * The same position with the other side to move, for asking what that side threatens. Null when the
 * side to move is in check (passing would leave its king in check), the game is over, or the FEN is invalid.
 */
export function threatFen(fen) {
  let game;
  try {
    game = new Chess(fen);
  } catch {
    return null;
  }
  if (game.inCheck() || game.isGameOver()) return null;
  const [board, turn, castling, , halfmoves, fullmoves] = fen.split(" ");
  const next = turn === "w" ? "b" : "w";
  const number = Number(fullmoves) + (turn === "b" ? 1 : 0);
  const passed = `${board} ${next} ${castling} - ${Number(halfmoves) + 1} ${number}`;
  try {
    new Chess(passed);
  } catch {
    return null;
  }
  return passed;
}

/** White's material minus Black's, in pawns, from a FEN's piece placement. */
function materialBalance(fen) {
  let balance = 0;
  for (const char of fen.split(" ")[0]) {
    const value = VALUE[char.toLowerCase()];
    if (value) balance += char === char.toLowerCase() ? -value : value;
  }
  return balance;
}

/**
 * Material (in pawns) the side to move in `fen` is sure to win when a line starts with a capture: the
 * smallest gain after any of the other side's replies, so a recapture counts even when the line delays it.
 * Zero when the line doesn't start with a capture.
 */
export function captureGain(fen, steps) {
  if (!steps[0]?.san.includes("x")) return 0;
  const sign = fen.split(" ")[1] === "w" ? 1 : -1;
  const start = materialBalance(fen);
  const replies = steps.filter((_, index) => index % 2 === 1);
  return Math.min(...(replies.length ? replies : steps.slice(0, 1)).map((step) => sign * (materialBalance(step.fen) - start)));
}

/** Expected score (0–100) for `color` from a White-side evaluation. */
function scoreFor(evaluation, color) {
  let white;
  if (evaluation.type === "mate") white = evaluation.value > 0 ? 100 : evaluation.value < 0 ? 0 : 50;
  else white = cpToWinProbability(evaluation.value);
  return color === "w" ? white : 100 - white;
}

/**
 * What the side that just moved threatens, in one sentence. `threatEval` is Stockfish's evaluation of
 * the passed position and `currentEval` the evaluation of the real one, both from White's side; either
 * may be missing. `tactic` is the tactic findTactic names in the threat line, if any, and `gain` the
 * material (in pawns) the line's opening exchange wins.
 * Only a mate, a named tactic, or a check or capture is called a threat. A quiet move that only gains
 * because the other side passed is a lost tempo, not a threat, so it is described as such. In a game
 * that is already decided the evaluation hardly moves, so an exchange that wins material still counts.
 */
export function describeThreat({ attacker, steps, threatEval, currentEval, tactic, gain = 0 }) {
  const side = SIDE[attacker];
  const defender = attacker === "w" ? "b" : "w";
  const first = steps[0]?.san;
  if (!first) return { headline: `${side} has no move to threaten with.`, serious: false };
  const mateValue = threatEval?.type === "mate" ? threatEval.value : 0;
  if (mateValue && (mateValue > 0) === (attacker === "w")) {
    const moves = Math.abs(mateValue);
    return { headline: `${side} threatens mate${moves > 1 ? ` in ${moves}` : ""}, starting with ${first}.`, serious: true };
  }
  const loss = threatEval && currentEval ? scoreFor(currentEval, defender) - scoreFor(threatEval, defender) : null;
  const sign = defender === "w" ? 1 : -1;
  const cpLoss = threatEval?.type === "cp" && currentEval?.type === "cp" ? sign * (currentEval.value - threatEval.value) : 0;
  if (loss !== null && loss < SERIOUS_THREAT && cpLoss < SERIOUS_THREAT_CP && gain < MATERIAL_THREAT) {
    return { headline: `No serious threat. ${side}'s best try would be ${first}.`, serious: false };
  }
  if (tactic?.kind === "free capture") {
    const [target] = tactic.targets;
    return { headline: `${side} threatens ${tactic.san}, winning the undefended ${PIECE_NAME[target.piece]} on ${target.square}.`, serious: true };
  }
  if (tactic) {
    const name = tacticName(tactic);
    const article = /^[aeiou]/.test(name) ? "an" : "a";
    return { headline: `${side} threatens ${article} ${name} with ${[...tactic.lead, tactic.san].join(" ")}.`, serious: true };
  }
  if (gain >= MATERIAL_THREAT) {
    return { headline: `${side} threatens ${first}, winning ${gain} point${gain === 1 ? "" : "s"} of material.`, serious: true };
  }
  if (/[x+#]/.test(first)) return { headline: `${side} threatens ${first}.`, serious: loss !== null };
  return { headline: `No direct threat. If ${SIDE[defender]} passed, ${side} would play ${first}.`, serious: false };
}
