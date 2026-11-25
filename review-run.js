import { analyzeGamePosition, finishDecision, quickDecision } from "./analysis.js";

const DEFAULT_ANALYSIS = { analyzeGamePosition, quickDecision, finishDecision };

/**
 * Review a game on an EnginePool in two phases. The quick phase searches every position and compares
 * every move at the review depth. The deeper checks that quickDecision asks for run after it.
 * Each task starts with an empty hash table, so results don't depend on which engine ran it, and a
 * deeper check gives the same result as checking the move in one uninterrupted run.
 * Deeper passes use no previous-move loss; the caller scores Miss against the final results.
 *
 * Callbacks receive ply numbers: onRoot(index, root) for positions[index], and onQuick(ply, quick) and
 * onFinal(ply, comparison) for the move that produced positions[ply].
 */
export async function runReview({
  positions, depth, pool, onRoot, onQuick, onFinal, isCancelled = () => false, analysis = DEFAULT_ANALYSIS,
}) {
  const last = positions.length - 1;
  const deeper = [];
  const fresh = async (engine) => {
    await engine.startNewGame();
    return !isCancelled();
  };

  // A failure ends the review; mark every task handled so the others don't report unhandled rejections.
  const track = (list, task) => {
    task.catch(() => {});
    list.push(task);
  };
  const quickTasks = [];
  positions.forEach((before, index) => track(quickTasks, pool.run(async (engine) => {
    if (isCancelled() || !await fresh(engine)) return;
    const root = await analysis.analyzeGamePosition(engine, before, depth);
    if (isCancelled()) return;
    onRoot?.(index, root);
    if (index === last) return;

    const after = positions[index + 1];
    const quick = await analysis.quickDecision(engine, before, after, depth, root);
    if (isCancelled()) return;
    onQuick?.(index + 1, quick);
    if (!quick.needsRefinement) {
      onFinal?.(index + 1, quick.comparison);
      return;
    }
    track(deeper, pool.run(async (next) => {
      if (isCancelled() || !await fresh(next)) return;
      // Single-threaded Stockfish is deterministic from an empty hash. Repeating the quick searches
      // rebuilds the hash they left, so the deeper passes match one uninterrupted check of this move.
      const replayRoot = await analysis.analyzeGamePosition(next, before, depth);
      const replay = await analysis.quickDecision(next, before, after, depth, replayRoot);
      if (isCancelled()) return;
      const comparison = await analysis.finishDecision(next, before, after, depth, replay);
      if (!isCancelled()) onFinal?.(index + 1, comparison);
    }));
  })));
  await Promise.all(quickTasks);
  // Every quick task has queued its deeper check by now.
  await Promise.all(deeper);
}
