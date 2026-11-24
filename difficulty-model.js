import { DIFFICULTY_COEFFICIENTS } from "./difficulty-data.js";

const clamp = (x, low, high) => Math.max(low, Math.min(high, x));

export function readLichessRatings(headers) {
  try {
    const site = new URL(headers.Site);
    if (site.protocol !== "https:" || site.hostname !== "lichess.org") return null;
  } catch {
    return null;
  }
  const ratings = { w: Number(headers.WhiteElo), b: Number(headers.BlackElo) };
  return Object.values(ratings).every((rating) => Number.isInteger(rating) && rating >= 800 && rating <= 2600)
    ? ratings : null;
}

/** Cohort-model inputs, or null when the position is outside the trained domain. */
export function difficultyFeatures(position, evaluation, mover) {
  const { practicalContext, legalMoves, captureCount, inCheck, material, lichessRatings } = position;
  if (!practicalContext || !Number.isInteger(legalMoves) || legalMoves < 2 || evaluation?.type !== "cp" ||
      ![evaluation.value, captureCount, material].every(Number.isFinite) || typeof inCheck !== "boolean") return null;
  const { ply, timeControl, whiteSeconds, blackSeconds } = practicalContext;
  if (ply < 8 || ply > 120) return null;

  const ownCp = clamp(evaluation.value / 100, -10, 10) * (mover === "w" ? 1 : -1);
  const features = [
    1, ownCp / 5, Math.abs(ownCp) / 5, (ply - 40) / 40,
    Math.log2(legalMoves) / 5, captureCount / legalMoves, Number(inCheck), material / 62,
  ];
  let model = "position";
  const hasClocks = timeControl && Number.isFinite(whiteSeconds) && Number.isFinite(blackSeconds);
  if (hasClocks) {
    const { base, increment } = timeControl;
    const white = clamp(whiteSeconds, 0, 3600) + increment + 5;
    const black = clamp(blackSeconds, 0, 3600) + increment + 5;
    const [own, opponent] = mover === "w" ? [white, black] : [black, white];
    features.push(
      clamp(Math.log2(own / 60), -3, 3),
      clamp(Math.log2(own / opponent), -3, 3),
      Math.log2((base + 40 * increment) / 300),
    );
    if (DIFFICULTY_COEFFICIENTS.clock) model = "clock";
    if (lichessRatings && DIFFICULTY_COEFFICIENTS.lichessRating) {
      const opponentColor = mover === "w" ? "b" : "w";
      features.push((lichessRatings[mover] - 1500) / 600, (lichessRatings[opponentColor] - 1500) / 600);
      model = "lichessRating";
    }
  }
  return { features, model };
}

export function estimateDifficulty(position, evaluation, mover) {
  const input = difficultyFeatures(position, evaluation, mover);
  if (!input) return null;
  const { features, model } = input;
  const logit = DIFFICULTY_COEFFICIENTS[model].reduce((sum, weight, index) => sum + weight * features[index], 0);
  return { chance: 100 / (1 + Math.exp(-logit)), model };
}
