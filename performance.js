import { difficultyFeatures, readLichessRatings } from "./difficulty-model.js";
import { GRADE_LOSS_LIMITS } from "./engine.js";
import { PEER_PERFORMANCE } from "./performance-data.js";

const MIN_DECISIONS = 12;
const MIN_PRIOR_GAMES = 5;
const MAX_PRIOR_GAMES = 20;
const BASELINE_AGE = 180 * 86_400_000;
const REVIEW_DEPTH = 16;
const KNOWN_SPEEDS = new Set(["ultrabullet", "bullet", "blitz", "rapid", "classical", "daily", "correspondence"]);
const UNKNOWN_PLAYERS = new Set(["?", "-", "white", "black", "player", "anonymous", "unknown"]);
const FINAL_RESULTS = new Set(["1-0", "0-1", "1/2-1/2"]);
const LICHESS_GAME = /^https:\/\/lichess\.org\/[a-zA-Z0-9]{8}(?:\/)?$/;

function headerTags(pgn) {
  const headers = {};
  for (const raw of (typeof pgn === "string" ? pgn : "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const tag = line.match(/^\[(White|Black|TimeControl|Site|Event|Result)\s+"((?:\\.|[^"\\])*)"\]$/);
    if (tag) headers[tag[1]] = tag[2].replace(/\\(["\\])/g, "$1");
    else if (!line.startsWith("[")) break;
  }
  return headers;
}

function recordedControl(value) {
  const parts = typeof value === "string" && value.trim().match(/^(\d+)(?:\+(\d+))?$/);
  if (!parts) return null;
  const base = Number(parts[1]);
  const increment = Number(parts[2] ?? 0);
  return [base, increment].every(Number.isSafeInteger) && base + increment > 0 ? { base, increment } : null;
}

function lichessSpeed({ base, increment }) {
  const seconds = base + 40 * increment;
  if (seconds < 30) return "ultrabullet";
  if (seconds < 180) return "bullet";
  if (seconds < 480) return "blitz";
  return seconds < 1500 ? "rapid" : "classical";
}

function siteHost(site) {
  try {
    return new URL(site).hostname.toLowerCase();
  } catch {
    return site;
  }
}

function playedAt(game) {
  const date = game.date;
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const stamp = Date.parse(date);
    if (Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === date) return stamp;
  }
  return Number.isFinite(game.reviewedAt) ? game.reviewedAt : null;
}

function personalProfile(game) {
  if (!game?.gameKey || (game.color !== "w" && game.color !== "b") ||
      !Number.isInteger(game.depth) || game.depth < 1 || !Number.isInteger(game.decisions) || game.decisions < MIN_DECISIONS ||
      !Number.isFinite(game.accuracy) || game.accuracy < 0 || game.accuracy > 100) return null;

  const headers = headerTags(game.pgn);
  if (![0, 0.5, 1].includes(game.result) && !FINAL_RESULTS.has(headers.Result)) return null;
  const player = headers[game.color === "w" ? "White" : "Black"]?.trim().toLowerCase();
  const date = playedAt(game);
  if (!player || UNKNOWN_PLAYERS.has(player) || date === null) return null;

  const site = headers.Site?.trim().toLowerCase() ?? "";
  const host = siteHost(site);
  const onChessCom = /^\d+$/.test(String(game.gameId ?? "")) || host === "chess.com" || host === "www.chess.com";
  const pool = onChessCom ? "chess.com" : LICHESS_GAME.test(site) ? "lichess" : "offline";
  const clock = recordedControl(game.timeControl) ?? recordedControl(headers.TimeControl);
  const declaredSpeed = typeof game.timeClass === "string" ? game.timeClass.trim().toLowerCase() : null;
  let timeClass = KNOWN_SPEEDS.has(declaredSpeed) ? declaredSpeed : null;
  if (pool === "lichess" && !timeClass) {
    const eventSpeed = headers.Event?.match(/^(?:Rated|Casual) (\w+) game$/)?.[1].toLowerCase();
    timeClass = KNOWN_SPEEDS.has(eventSpeed) ? eventSpeed : clock ? lichessSpeed(clock) : null;
  }

  if (pool === "offline" && clock) {
    const { base, increment } = clock;
    const initial = base % 60 === 0 ? `${base / 60} min` : `${base} sec`;
    timeClass = increment ? `${initial} + ${increment} sec` : initial;
  } else if (pool === "offline") {
    return null;
  }
  return timeClass ? { player, pool, timeClass, date, source: pool === "offline" ? site : pool } : null;
}

/** Compare the game to the player's recent same-pool and same-clock-depth review history. */
export function comparePersonalPerformance({ current, history = [] }) {
  const profile = personalProfile(current);
  if (!profile) return null;

  const games = [...history].filter((game) => game?.gameKey !== current.gameKey && game?.depth === current.depth)
    .map((game) => ({ game, profile: personalProfile(game) }))
    .filter(({ profile: other }) => other && other.player === profile.player && other.source === profile.source &&
      other.pool === profile.pool && other.timeClass === profile.timeClass && other.date <= profile.date &&
      profile.date - other.date <= BASELINE_AGE)
    .sort((a, b) => b.profile.date - a.profile.date || (b.game.reviewedAt ?? 0) - (a.game.reviewedAt ?? 0));
  const seen = new Set();
  const baseline = [];
  for (const { game } of games) {
    if (seen.has(game.gameKey)) continue;
    seen.add(game.gameKey);
    baseline.push(game);
    if (baseline.length === MAX_PRIOR_GAMES) break;
  }
  if (baseline.length < MIN_PRIOR_GAMES) return null;

  const accuracies = baseline.map(({ accuracy }) => accuracy).sort((a, b) => a - b);
  const medianAccuracy = (accuracies[Math.floor((accuracies.length - 1) / 2)] + accuracies[Math.floor(accuracies.length / 2)]) / 2;
  return {
    currentAccuracy: current.accuracy, medianAccuracy, difference: current.accuracy - medianAccuracy,
    games: baseline.length, decisions: baseline.reduce((sum, game) => sum + game.decisions, 0),
    currentDecisions: current.decisions, timeClass: profile.timeClass, pool: profile.pool,
  };
}

function supportsRating(model, rating) {
  return model?.ratingBands.some(([min, max]) => rating >= min && rating <= max);
}

/** Predict from the initial unrestricted root before Stockfish searches the selected move. */
export function peerDecisionPrediction(before, initialRoot, color) {
  const clock = before?.practicalContext?.timeControl;
  const rating = before?.lichessRatings?.[color];
  if (!clock || !Number.isInteger(rating) || before.terminal || (initialRoot?.lines?.length ?? 0) < 2) return null;
  const timeClass = lichessSpeed(clock);
  const model = PEER_PERFORMANCE[timeClass];
  if (!supportsRating(model, rating)) return null;
  const data = difficultyFeatures(before, initialRoot.eval, color);
  if (data?.model !== "lichessRating") return null;
  const logit = model.weights.reduce((sum, weight, index) => sum + weight * data.features[index], 0);
  return { chance: 1 / (1 + Math.exp(-logit)), rating, timeClass };
}

/** Sum observed and expected sound decisions for a finished review in a tested Lichess group. */
export function peerPerformance({ positions, moveReviews, color, headers, depth }) {
  if (depth !== REVIEW_DEPTH || (color !== "w" && color !== "b") ||
      !LICHESS_GAME.test(headers?.Site ?? "") || !FINAL_RESULTS.has(headers.Result) ||
      (headers.Variant && headers.Variant !== "Standard") || headers.WhiteTitle === "BOT" || headers.BlackTitle === "BOT") return null;
  const timeClass = headers.Event?.match(/^Rated (Bullet|Blitz|Rapid) game$/)?.[1].toLowerCase();
  const rating = readLichessRatings(headers)?.[color];
  if (!supportsRating(PEER_PERFORMANCE[timeClass], rating)) return null;

  let observedSound = 0;
  let expectedSound = 0;
  let decisions = 0;
  for (let ply = 1; ply < positions.length; ply++) {
    if (positions[ply].move?.color !== color) continue;
    const review = moveReviews[ply];
    if (!review) return null;
    const { peerDifficulty: prediction, winLoss, forced } = review;
    if (forced || prediction?.rating !== rating || prediction?.timeClass !== timeClass ||
        !Number.isFinite(prediction.chance) || prediction.chance < 0 || prediction.chance > 1 || !Number.isFinite(winLoss)) continue;
    decisions++;
    expectedSound += prediction.chance;
    if (winLoss <= GRADE_LOSS_LIMITS.good) observedSound++;
  }
  return decisions >= MIN_DECISIONS ? { observedSound, expectedSound, decisions, rating, timeClass, pool: "lichess" } : null;
}
