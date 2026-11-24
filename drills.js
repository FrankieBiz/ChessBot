// Pure rules for retrying a reviewed decision.
import { moverMateDistance } from "./tactics.js";

/** An alternative solves an ordinary drill when it loses at most this many expected-score points. */
export const DRILL_ACCEPT_LOSS = 3;

/**
 * Judge one drill attempt.
 *
 * Verdicts: "best" (the engine move or any checkmate that matches it), "alternative" (another move
 * that meets the drill's standard), "game-move" (the move from the game), "rejected", or "unknown"
 * (no engine comparison is available for a move that needs one).
 *
 * A missed-mate drill accepts only a move that keeps a forced mate at least as short as the one
 * that was available. Every other drill accepts a move within DRILL_ACCEPT_LOSS expected-score points.
 */
export function judgeDrillAttempt({ attemptUci, gameUci, review, color, deliversMate = false, comparison = null }) {
  if (attemptUci === gameUci) return { verdict: "game-move" };
  if (attemptUci === review.bestMoveUci) return { verdict: "best" };
  if (deliversMate) return { verdict: "alternative", mate: 1, loss: 0 };
  if (!comparison?.root || !comparison?.played) return { verdict: "unknown" };

  const sign = color === "w" ? 1 : -1;
  const loss = Math.max(0, (comparison.root.winWhite - comparison.played.winWhite) * sign);
  const mate = moverMateDistance(comparison.played.eval, color);
  const target = review.missedMate?.drill ? review.missedMate.available : null;
  if (target) {
    return mate !== null && mate > 0 && mate <= target
      ? { verdict: "alternative", mate, loss }
      : { verdict: "rejected", reason: "needs-mate", mate, loss, target };
  }
  return loss <= DRILL_ACCEPT_LOSS
    ? { verdict: "alternative", mate, loss }
    : { verdict: "rejected", reason: "loses", mate, loss };
}

/** Prompt shown when a drill opens. */
export function drillPrompt({ playedSan, review }) {
  const missed = review.missedMate?.drill ? review.missedMate : null;
  if (missed) {
    const goal = missed.available === 1 ? "a checkmate in 1" : `a forced mate in ${missed.available}`;
    return `In the game you played ${playedSan}, but there was ${goal}. Find it!`;
  }
  return `In the game you played ${playedSan} (${review.classification.label}). Drag a piece on the board to find a stronger move!`;
}

/** Feedback for a rejected or unverified attempt. */
export function drillRejection({ attemptSan, judgement, review }) {
  if (judgement.reason === "needs-mate") {
    const goal = judgement.target === 1 ? "a mate in 1" : `a forced mate in ${judgement.target}`;
    const result = judgement.mate > 0 ? `${attemptSan} mates in ${judgement.mate}` : `${attemptSan} doesn't force mate`;
    return `${result}, but there is ${goal} here. Look at every check first!`;
  }
  if (judgement.reason === "loses") {
    return `Not quite — ${attemptSan} still loses ${judgement.loss.toFixed(1)} points of expected score. Try again!`;
  }
  if (judgement.verdict === "game-move") {
    return review.missedMate?.drill
      ? `That's the ${attemptSan} you played in the game. It doesn't finish the game — look for checks.`
      : `That's the ${attemptSan} you played in the game (-${review.winLoss.toFixed(0)} points of expected score). Try a stronger idea!`;
  }
  return `Not quite — ${attemptSan} isn't the best move here. Try again or click Hint.`;
}

/** Hint text for the current drill, given the best move's origin square. */
export function drillHint({ review, fromSquare }) {
  const missed = review.missedMate?.drill ? review.missedMate : null;
  if (missed) {
    const goal = missed.available === 1 ? "There's a checkmate in 1." : `There's a forced mate in ${missed.available}.`;
    return `Hint: ${goal} It starts with the piece on ${fromSquare}.`;
  }
  return `Hint: Look closely at moving the piece on ${fromSquare}.`;
}
