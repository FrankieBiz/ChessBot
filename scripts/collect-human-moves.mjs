// Build move-level training and evaluation rows for the human choice model.
//
// Each sampled decision gets an all-moves Stockfish search at HUMAN_MOVE_SEARCH_DEPTH and one
// feature row per legal move from human-move-model.js, the module the extension itself uses.
// With --deep, the decision also gets the extension's depth-16 comparison of the played move,
// which supplies the sound-move target and the cohort model's prediction for the same position.
//
// Inputs: --lichess archive.pgn.zst (rated Lichess games) or --chesscom games.jsonl
// (rows written by scripts/fetch-chesscom-games.mjs). Output rows are appended, so runs resume.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { StockfishCliWorker } from "./lib/stockfish-cli.mjs";

globalThis.Worker = StockfishCliWorker;
const rootDir = fileURLToPath(new URL("../", import.meta.url));
const { analyzeGamePosition, compareRootMoves, parseReviewGame, scoreDecision } = await import(join(rootDir, "analysis.js"));
const { StockfishEngine } = await import(join(rootDir, "engine.js"));
const { difficultyFeatures, estimateDifficulty } = await import(join(rootDir, "difficulty-model.js"));
const { HUMAN_MOVE_SEARCH_DEPTH, candidateScores, humanContext, moveFeatureRows } =
  await import(join(rootDir, "human-move-model.js"));
const { replayVariation } = await import(join(rootDir, "variation.js"));

const { values: args } = parseArgs({ options: {
  lichess: { type: "string" },
  chesscom: { type: "string" },
  out: { type: "string" },
  count: { type: "string", default: "1000" },
  workers: { type: "string", default: "4" },
  deep: { type: "boolean", default: false },
  "review-depth": { type: "string", default: "16" },
  // Rows from an earlier run whose deep targets can be kept when only the all-moves search changes.
  reuse: { type: "string" },
  "search-depth": { type: "string" },
  stockfish: { type: "string", default: join(rootDir, "node_modules", "stockfish", "bin", "stockfish-19-single.js") },
} });
if (!args.out || Boolean(args.lichess) === Boolean(args.chesscom)) {
  console.error("Usage: node scripts/collect-human-moves.mjs (--lichess month.pgn.zst | --chesscom games.jsonl) --out rows.jsonl\n" +
    "       [--count 1000] [--workers 4] [--deep] [--review-depth 16] [--reuse earlier-rows.jsonl]");
  process.exit(2);
}
const count = Number(args.count);
const workers = Number(args.workers);
const reviewDepth = Number(args["review-depth"]);
// Overrides the extension's all-moves depth only for experiments; the trainer records the depth used.
const searchDepth = Number(args["search-depth"] ?? HUMAN_MOVE_SEARCH_DEPTH);
const sha = (value) => createHash("sha256").update(value).digest();

async function* lichessGames(path) {
  const child = spawn("zstd", ["-dc", path], { stdio: ["ignore", "pipe", "ignore"] });
  let headers = {};
  let moves = [];
  const flush = function* () {
    if (moves.length) yield { headers, movetext: moves.join(" ") };
    headers = {};
    moves = [];
  };
  for await (const raw of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    const line = raw.trim();
    if (line.startsWith('[Event "')) yield* flush();
    const header = line.match(/^\[(\w+) "(.*)"\]$/);
    if (header) headers[header[1]] = header[2];
    else if (line) moves.push(line);
  }
  yield* flush();
  child.kill();
}

function lichessDecisionSource(headers) {
  const event = headers.Event?.match(/^Rated (Bullet|Blitz|Rapid) game$/);
  if (!event || !["Normal", "Time forfeit"].includes(headers.Termination) || !headers.Site) return null;
  if (headers.WhiteTitle === "BOT" || headers.BlackTitle === "BOT") return null;
  const ratings = { w: Number(headers.WhiteElo), b: Number(headers.BlackElo) };
  if (!Object.values(ratings).every((rating) => Number.isInteger(rating) && rating >= 800 && rating <= 2600)) return null;
  return { id: headers.Site, platform: "lichess", timeClass: event[1].toLowerCase(), ratings, timeControl: headers.TimeControl };
}

async function* decisions() {
  if (args.lichess) {
    for await (const { headers, movetext } of lichessGames(args.lichess)) {
      const source = lichessDecisionSource(headers);
      // Use half of the eligible games so consecutive games from one player are less common.
      if (source && sha(source.id)[0] % 2 === 0) yield { ...source, pgn: `[TimeControl "${headers.TimeControl}"]\n\n${movetext}` };
    }
  } else {
    for await (const line of createInterface({ input: createReadStream(args.chesscom), crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const game = JSON.parse(line);
      yield { id: game.url, platform: "chess.com", timeClass: game.timeClass, ratings: game.ratings,
        timeControl: game.timeControl, pgn: game.pgn };
    }
  }
}

function pickDecision(source) {
  let positions;
  try {
    ({ positions } = parseReviewGame(source.pgn, source.timeControl));
  } catch {
    return null;
  }
  const eligible = [];
  for (let ply = 8; ply <= Math.min(120, positions.length - 2); ply++) {
    const before = positions[ply];
    if (!before.terminal && before.legalMoves >= 2 && before.practicalContext) eligible.push(ply);
  }
  if (!eligible.length) return null;
  const ply = eligible[sha(`${source.id}#ply`).readUInt32BE(0) % eligible.length];
  return { source, before: positions[ply], after: positions[ply + 1] };
}

const reused = new Map(args.reuse
  ? readFileSync(args.reuse, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => row.target).map((row) => [row.id, row]) : []);
const done = new Set(existsSync(args.out)
  ? readFileSync(args.out, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).id) : []);

async function evaluate(engine, { source, before, after }) {
  await engine.worker.clearHash();
  const color = after.move.color;
  const { whiteSeconds, blackSeconds } = before.practicalContext;
  const clockSeconds = color === "w" ? whiteSeconds : blackSeconds;
  const rating = source.ratings?.[color] ?? null;
  const row = {
    id: source.id, platform: source.platform, timeClass: source.timeClass, ply: before.ply, color,
    rating, opponentRating: source.ratings?.[color === "w" ? "b" : "w"] ?? null, clockSeconds,
    played: after.move.uci, legalMoves: before.legalMoves,
  };
  const previous = reused.get(source.id);
  if (args.deep && previous?.ply === before.ply && previous.played === after.move.uci) {
    row.target = previous.target;
    row.cohort = previous.cohort;
  } else if (args.deep) {
    const root = await analyzeGamePosition(engine, before, reviewDepth);
    const comparison = await compareRootMoves(engine, before, after.move.uci, reviewDepth, root);
    const review = scoreDecision(before, after, comparison, 0);
    const lichessPosition = source.platform === "lichess" ? { ...before, lichessRatings: source.ratings } : before;
    const loss = Number.isFinite(review.modelWinLoss) ? review.modelWinLoss : review.winLoss;
    row.target = { winLoss: loss, sound: loss <= 5, grade: review.classification.key };
    row.cohort = {
      shipped: estimateDifficulty(lichessPosition, root.eval, color),
      position: difficultyFeatures({ ...before, lichessRatings: null }, root.eval, color),
      rated: difficultyFeatures(lichessPosition, root.eval, color),
    };
  }
  // The all-moves search starts cold, as in the extension. The deep comparison above searched the
  // played move on its own, and its table entries would otherwise leak the target into the features.
  await engine.worker.clearHash();
  const search = await engine.analyzePosition(before.fen, searchDepth, {
    ...before.searchOptions, multiPv: before.legalMoves,
  });
  if (search.lines.length !== before.legalMoves) return null;
  const game = replayVariation(before);
  // Rating features are computed on the Lichess scale. The trainer zeroes them for the unrated model.
  const context = humanContext({ rating: source.platform === "lichess" ? rating : null, clockSeconds });
  const moves = moveFeatureRows(game, candidateScores(search, color), context, before.move?.to ?? null);
  const label = moves.findIndex(({ uci }) => uci === after.move.uci);
  if (label < 0) return null;
  return { ...row, searchDepth, ratingFeature: context.rating, label,
    moves: moves.map(({ uci, loss, features }) => ({ uci, loss, features })) };
}

const source = decisions();
let written = done.size;
let pending = 0;
async function next() {
  while (written + pending < count) {
    const { value, done: exhausted } = await source.next();
    if (exhausted) return null;
    if (done.has(value.id)) continue;
    const decision = pickDecision(value);
    if (decision) {
      pending++;
      return decision;
    }
  }
  return null;
}

const started = performance.now();
await Promise.all(Array.from({ length: workers }, async () => {
  const engine = new StockfishEngine(args.stockfish);
  await engine.init();
  try {
    for (let decision = await next(); decision; decision = await next()) {
      const row = await evaluate(engine, decision).catch((error) => {
        console.error(`skip ${decision.source.id}: ${error.message}`);
        return null;
      });
      pending--;
      if (!row) continue;
      appendFileSync(args.out, JSON.stringify(row) + "\n");
      if (++written % 100 === 0) {
        console.error(`${written}/${count} decisions · ${((performance.now() - started) / 1000).toFixed(0)} s`);
      }
    }
  } finally {
    engine.terminate();
  }
}));
console.error(`done: ${written} decisions in ${args.out}`);
// The archive reader may still be open after the last sample. Stop it with the run.
process.exit(0);
