// Tactical lessons that the expected-score loss alone can hide.

/** Longest forced mate that still counts as a teachable miss when it is lost or delayed. */
export const MISSED_MATE_MAX_LENGTH = 3;
/** Training priority given to a missed mate, on the same 0–100 expected-score scale as losses. */
export const MISSED_MATE_PRIORITY = 20;

/**
 * Mate distance from the mover's side: n > 0 when the mover forces mate in n moves,
 * n < 0 when the mover is mated in |n|, null for a centipawn score.
 */
export function moverMateDistance(evaluation, color) {
  if (evaluation?.type !== "mate" || !Number.isFinite(evaluation.value) || evaluation.value === 0) return null;
  return color === "w" ? evaluation.value : -evaluation.value;
}

/**
 * A missed mate is a lesson even when the position stays won and no expected score is lost.
 * Both evaluations must come from the same root comparison (or the played move's terminal result).
 *
 * - immediate: mate in 1 was available and the played move did not mate.
 * - lost: a short forced mate was available and the played move no longer forces mate.
 * - slower: a short forced mate was available and the played move delays it by at least two moves.
 *
 * Immediate and lost misses become drills. Slower mates are reported without a drill.
 */
export function detectMissedMate(bestEval, playedEval, color) {
  const available = moverMateDistance(bestEval, color);
  if (!available || available < 1 || available > MISSED_MATE_MAX_LENGTH) return null;
  const played = moverMateDistance(playedEval, color);
  const keepsMate = played !== null && played > 0;
  if (keepsMate && played <= available) return null;

  let kind;
  if (available === 1) kind = "immediate";
  else if (!keepsMate) kind = "lost";
  else if (played - available >= 2) kind = "slower";
  else return null;
  return { available, played: keepsMate ? played : null, kind, drill: kind !== "slower" };
}
