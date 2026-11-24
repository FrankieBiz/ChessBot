/** Summarize the size of expected-score losses across genuine choices. */
export function computeDecisionQuality(reviews) {
  let decisions = 0;
  let squaredLoss = 0;
  let biggestLoss = 0;
  for (const review of reviews) {
    if (review.forced || !Number.isFinite(review.winLoss)) continue;
    const loss = Math.max(0, Math.min(100, review.winLoss));
    decisions++;
    squaredLoss += loss ** 2;
    biggestLoss = Math.max(biggestLoss, loss);
  }
  if (!decisions) return null;
  return {
    score: Math.round((100 - Math.sqrt(squaredLoss / decisions)) * 10) / 10,
    biggestLoss,
    decisions,
  };
}
