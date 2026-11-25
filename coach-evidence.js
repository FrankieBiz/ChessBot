import { parseUciMove, replayVariation } from "./variation.js";

const COACHED_GRADES = new Set(["inaccuracy", "mistake", "miss", "blunder"]);
const PIECES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

/** A verified reply on the board after the played move, with at most three continuation moves. */
export function coachEvidence(position, review) {
  if (!position?.move || position.terminal || !COACHED_GRADES.has(review?.classification?.key) ||
      !Array.isArray(review.playedPv)) return null;
  const [played, ...continuation] = review.playedPv;
  if (played !== position.move.uci || !continuation.length) return null;

  const game = replayVariation(position);
  const side = game.turn() === "w" ? "White" : "Black";
  const line = [];
  let first = null;
  for (const uci of continuation.slice(0, 3)) {
    const input = parseUciMove(uci);
    if (!input) break;
    let reply;
    try {
      reply = game.move(input);
    } catch {
      break;
    }
    line.push(uci);
    if (first) continue;
    const captureSquare = reply.isEnPassant() ? reply.to[0] + reply.from[1] : reply.to;
    const kingSquare = game.isCheck()
      ? game.findPiece({ type: "k", color: game.turn() })[0]
      : null;
    let text = `${side} can reply ${reply.san}, bringing the ${PIECES[reply.piece]} to ${reply.to}.`;
    if (game.isCheckmate()) text = `${side} has checkmate with ${reply.san}.`;
    else if (reply.captured) text = `${side}'s ${reply.san} captures the ${PIECES[reply.captured]} on ${captureSquare}.`;
    else if (kingSquare) text = `${side} can check the king on ${kingSquare} with ${reply.san}.`;
    first = { from: reply.from, to: reply.to, square: kingSquare ?? captureSquare, san: reply.san, text };
  }
  return first ? { ...first, line } : null;
}
