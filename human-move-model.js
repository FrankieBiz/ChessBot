// Move-level human choice model.
// A softmax over every legal move predicts which move a player is likely to choose. Stockfish's
// score for each move supplies the cost, and simple board features supply how tempting it looks.
// The same feature code runs in the browser and in scripts/collect-human-moves.mjs, which builds
// the training rows, so the fitted coefficients always see the features they were trained on.
import { HUMAN_MOVE_MODEL } from "./human-move-data.js";

/**
 * All-moves search depth. The engine's node budget for this depth is about 0.36 million nodes.
 * Depth 12 rated some traps, such as 4. Nxe5 in the Blackburne–Shilling line, as the best move.
 */
export const HUMAN_MOVE_SEARCH_DEPTH = 14;
/** A move is sound when it loses at most this many expected-score points, the Good grade boundary. */
export const SOUND_MOVE_LOSS = 5;

const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const clamp = (x, low, high) => Math.max(low, Math.min(high, x));

export const HUMAN_MOVE_FEATURES = [
  "loss", "sqrtLoss", "best", "lossRating", "sqrtLossRating", "lossClock",
  "capture", "capturedValue", "recapture", "check", "queenPromotion", "underpromotion", "castle",
  "knight", "bishop", "rook", "queen", "king", "escapesAttack", "enPrise", "retreat", "distance",
  "pawnPush", "captureRating", "checkRating",
];
/** Features that need a rating. The unrated model has zero weight on them. */
export const RATING_FEATURES = ["lossRating", "sqrtLossRating", "captureRating", "checkRating"];

/** Mover expected score (0–100) for each searched move. */
export function candidateScores(search, color) {
  const scores = new Map();
  for (const line of search?.lines ?? []) {
    if (!line?.pv?.[0] || !Number.isFinite(line.winWhite)) continue;
    scores.set(line.pv[0], color === "w" ? line.winWhite : 100 - line.winWhite);
  }
  return scores;
}

/**
 * Player context. Ratings use the trained Lichess scale and are ignored when unknown.
 * The clock term is centered on three minutes left and is zero when the clock is unknown.
 */
export function humanContext({ rating = null, clockSeconds = null } = {}) {
  const ratingKnown = Number.isFinite(rating) && rating >= 800 && rating <= 2600;
  const clockKnown = Number.isFinite(clockSeconds) && clockSeconds >= 0;
  return {
    rating: ratingKnown ? clamp((rating - 1500) / 600, -1.2, 1.8) : 0,
    ratingKnown,
    pressure: clockKnown ? clamp(Math.log2(180 / (clockSeconds + 5)), -3, 5) : 0,
  };
}

function cheapestAttacker(game, square, color) {
  let cheapest = Infinity;
  for (const from of game.attackers(square, color)) {
    const type = game.get(from)?.type;
    cheapest = Math.min(cheapest, type === "k" ? 100 : VALUES[type]);
  }
  return cheapest;
}

/**
 * One feature row per legal move. `game` is a chess.js position (it is restored before returning),
 * `scores` comes from candidateScores, and `lastMoveTo` is the square of the opponent's last move.
 */
export function moveFeatureRows(game, scores, context, lastMoveTo = null) {
  const color = game.turn();
  const opponent = color === "w" ? "b" : "w";
  const forward = color === "w" ? 1 : -1;
  const legal = game.moves({ verbose: true });
  const known = legal.map((move) => scores.get(move.lan)).filter(Number.isFinite);
  if (!known.length) return [];
  const best = Math.max(...known);
  const worst = Math.min(...known);
  const { rating, pressure } = context;

  return legal.map((move) => {
    const score = scores.get(move.lan) ?? worst;
    const loss = clamp(best - score, 0, 100);
    const piece = move.piece;
    const capture = Boolean(move.captured);
    const check = move.san.includes("+") || move.san.includes("#");
    const castle = move.flags.includes("k") || move.flags.includes("q");
    const movedValue = VALUES[move.promotion ?? piece];
    const escapesAttack = piece !== "k" && piece !== "p" && game.isAttacked(move.from, opponent);
    game.move(move);
    let enPrise = false;
    if (piece !== "k" && game.isAttacked(move.to, opponent)) {
      const defended = game.attackers(move.to, color).length > 0;
      enPrise = !defended || cheapestAttacker(game, move.to, opponent) < movedValue;
    }
    game.undo();
    const rankDelta = (Number(move.to[1]) - Number(move.from[1])) * forward;
    const fileDelta = move.to.charCodeAt(0) - move.from.charCodeAt(0);
    const row = {
      loss: loss / 10,
      sqrtLoss: Math.sqrt(loss) / 3,
      best: loss <= 0.5 ? 1 : 0,
      lossRating: loss / 10 * rating,
      sqrtLossRating: Math.sqrt(loss) / 3 * rating,
      lossClock: loss / 10 * pressure,
      capture: Number(capture),
      capturedValue: capture ? VALUES[move.captured] / 9 : 0,
      recapture: Number(capture && move.to === lastMoveTo),
      check: Number(check),
      queenPromotion: Number(move.promotion === "q"),
      underpromotion: Number(Boolean(move.promotion) && move.promotion !== "q"),
      castle: Number(castle),
      knight: Number(piece === "n"),
      bishop: Number(piece === "b"),
      rook: Number(piece === "r"),
      queen: Number(piece === "q"),
      king: Number(piece === "k" && !castle),
      escapesAttack: Number(escapesAttack),
      enPrise: Number(enPrise),
      retreat: Number(rankDelta < 0),
      distance: Math.max(Math.abs(rankDelta), Math.abs(fileDelta)) / 7,
      pawnPush: Number(piece === "p" && !capture),
      captureRating: Number(capture) * rating,
      checkRating: Number(check) * rating,
    };
    return { uci: move.lan, san: move.san, loss, features: HUMAN_MOVE_FEATURES.map((name) => row[name]) };
  });
}

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * Move probabilities and their consequences.
 * soundChance is the calibrated chance of a move within SOUND_MOVE_LOSS, and tempting is the
 * likeliest unsound move.
 */
export function forecastHumanMoves(rows, { ratingKnown }, model = HUMAN_MOVE_MODEL) {
  // Coefficients trained on other features or another search depth would misread the inputs.
  if (model?.features?.join() !== HUMAN_MOVE_FEATURES.join() || model.searchDepth !== HUMAN_MOVE_SEARCH_DEPTH ||
      rows.length < 2) return null;
  const variant = ratingKnown && model.rated ? "rated" : "unrated";
  const { weights, calibration } = model[variant];
  const logits = rows.map(({ features }) => features.reduce((sum, value, index) => sum + value * weights[index], 0));
  const top = Math.max(...logits);
  const exps = logits.map((value) => Math.exp(value - top));
  const total = exps.reduce((sum, value) => sum + value, 0);
  const moves = rows.map((row, index) => ({ uci: row.uci, san: row.san, loss: row.loss, probability: exps[index] / total }))
    .sort((a, b) => b.probability - a.probability);
  const rawSound = clamp(moves.reduce((sum, move) => sum + (move.loss <= SOUND_MOVE_LOSS ? move.probability : 0), 0),
    1e-4, 1 - 1e-4);
  const [intercept, slope] = calibration;
  return {
    variant,
    moves,
    soundChance: 100 * sigmoid(intercept + slope * logit(rawSound)),
    expectedLoss: moves.reduce((sum, move) => sum + move.probability * move.loss, 0),
    tempting: moves.find((move) => move.loss > SOUND_MOVE_LOSS) ?? null,
  };
}
