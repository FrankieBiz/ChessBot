// Rescore a time- and rating-stratified Lichess holdout with the browser review pipeline.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { analyzeDecision, analyzeGamePosition, parseReviewGame, scoreDecision } from "../analysis.js";
import { difficultyFeatures } from "../difficulty-model.js";
import { StockfishEngine } from "../engine.js";
import { StockfishCliWorker } from "./lib/stockfish-cli.mjs";

const { values: args } = parseArgs({ options: {
  archive: { type: "string" },
  workers: { type: "string", default: "4" },
  "per-band": { type: "string", default: "80" },
  stockfish: { type: "string", default: fileURLToPath(new URL("../node_modules/stockfish/bin/stockfish-19-single.js", import.meta.url)) },
} });
const workers = Number(args.workers);
const perBand = Number(args["per-band"]);
if (!args.archive || ![workers, perBand].every((value) => Number.isInteger(value) && value > 0)) {
  throw new Error("Usage: node scripts/collect-performance-decisions.mjs --archive 2026-10.pgn.zst [--workers 4] [--per-band 80]");
}

const hash = (text) => createHash("sha256").update(text).digest().readUInt32BE(0);
const speeds = ["bullet", "blitz", "rapid"];
const ratingBand = (rating) => rating < 1400 ? 0 : rating < 1800 ? 1 : rating < 2200 ? 2 : 3;
const source = spawn("zstd", ["-dc", args.archive], { stdio: ["ignore", "pipe", "pipe"] });
let errors = "";
source.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
const completion = new Promise((resolve, reject) => {
  source.on("error", reject);
  source.on("close", resolve);
});

const candidates = new Map();
let headers = {};
let moves = [];
function flush() {
  const timeClass = headers.Event?.match(/^Rated (Bullet|Blitz|Rapid) game$/)?.[1].toLowerCase();
  const id = headers.Site;
  if (id && timeClass && moves.length && ["Normal", "Time forfeit"].includes(headers.Termination) &&
      headers.WhiteTitle !== "BOT" && headers.BlackTitle !== "BOT") {
    const color = hash(`${id}#side`) % 2 ? "w" : "b";
    const username = headers[color === "w" ? "White" : "Black"]?.toLowerCase();
    const rating = Number(headers[color === "w" ? "WhiteElo" : "BlackElo"]);
    const opponent = Number(headers[color === "w" ? "BlackElo" : "WhiteElo"]);
    const order = hash(`${id}#performance-2026-11`);
    if (username && [rating, opponent].every((value) => Number.isInteger(value) && value >= 800 && value <= 2600)) {
      const stratum = `${timeClass}/${ratingBand(rating)}`;
      const rows = candidates.get(stratum) ?? [];
      if (rows.length < perBand * 4 || order < rows.at(-1).order) {
        rows.push({ id, color, rating, timeClass, username, order, headers, moves });
        rows.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        if (rows.length > perBand * 4) rows.pop();
        candidates.set(stratum, rows);
      }
    }
  }
  headers = {};
  moves = [];
}

for await (const raw of createInterface({ input: source.stdout, crlfDelay: Infinity })) {
  const line = raw.trim();
  if (line.startsWith('[Event "')) flush();
  const match = line.match(/^\[(\w+) "(.*)"\]$/);
  // Keep complete PGN header lines for replay while reading values used to sample.
  if (match) {
    headers.pgn ??= {};
    headers.pgn[match[1]] = line;
    headers[match[1]] = match[2];
  } else if (line) moves.push(line);
}
if (await completion && !/premature end/i.test(errors)) throw new Error(errors);

const jobs = [];
const seenPlayers = new Set();
for (const [key, rows] of [...candidates].sort()) {
  let accepted = 0;
  for (const row of rows) {
    if (seenPlayers.has(row.username)) continue;
    let positions;
    try {
      ({ positions } = parseReviewGame(`${Object.values(row.headers.pgn).join("\n")}\n\n${row.moves.join(" ")}`));
    } catch {
      continue;
    }
    const eligible = positions.slice(8, 121).filter(({ ply, legalMoves, terminal, practicalContext }) => {
      return positions[ply + 1]?.move?.color === row.color && !terminal && legalMoves >= 2 &&
        practicalContext?.timeControl && Number.isFinite(practicalContext.whiteSeconds) &&
        Number.isFinite(practicalContext.blackSeconds);
    });
    if (!eligible.length) continue;
    const before = eligible[hash(`${row.id}#performance-ply`) % eligible.length];
    jobs.push({ row, before, after: positions[before.ply + 1] });
    seenPlayers.add(row.username);
    if (++accepted === perBand) break;
  }
  console.error(`${key}: ${accepted} sampled decisions`);
}
if (jobs.length === 0 || !speeds.every((speed) => jobs.some(({ row }) => row.timeClass === speed))) {
  throw new Error("The archive did not provide all three time classes.");
}

globalThis.Worker = StockfishCliWorker;
let next = 0;
let completed = 0;
const results = new Array(jobs.length);
await Promise.all(Array.from({ length: workers }, async () => {
  const engine = new StockfishEngine(args.stockfish);
  try {
    while (next < jobs.length) {
      const index = next++;
      const { row, before, after } = jobs[index];
      await engine.startNewGame();
      try {
        const initial = await analyzeGamePosition(engine, before, 16);
        if (initial.lines.length < 2) continue;
        const rated = difficultyFeatures(before, initial.eval, row.color);
        if (rated?.model !== "lichessRating") continue;
        const comparison = await analyzeDecision(engine, before, after, 16, initial);
        const review = scoreDecision(before, after, comparison, 0);
        const loss = review.winLoss;
        results[index] = { id: row.id, timeClass: row.timeClass, rating: row.rating,
          color: row.color, ply: before.ply, target: { sound: loss <= 5, winLoss: loss }, cohort: { rated },
          depth: review.depth, confidence: review.searchConfidence };
      } catch (error) {
        console.error(`Decision skipped: ${error.message}`);
      } finally {
        if (++completed % 50 === 0) console.error(`${completed}/${jobs.length} searched`);
      }
    }
  } finally {
    engine.terminate();
  }
}));
for (const row of results) if (row) console.log(JSON.stringify(row));
