import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { analyzeDecision, analyzeGamePosition, deepCheckDecision, parseReviewGame, scoreDecision } from "../analysis.js";
import { StockfishEngine } from "../engine.js";
import { StockfishCliWorker } from "./lib/stockfish-cli.mjs";

const { values: args } = parseArgs({ options: {
  archive: { type: "string" },
  stockfish: { type: "string", default: "node_modules/stockfish/bin/stockfish-19-single.js" },
  "reference-stockfish": { type: "string" },
  "reference-depth": { type: "string", default: "22" },
  workers: { type: "string", default: "4" },
  help: { type: "boolean" },
} });
if (args.help || !args.archive) {
  console.log("Usage: node scripts/benchmark-deep-check.mjs --archive rated.pgn.zst " +
    "[--stockfish stockfish.js] [--reference-stockfish native-uci] [--reference-depth 22] [--workers 4]");
  process.exit(args.help ? 0 : 2);
}

const speeds = ["Bullet", "Blitz", "Rapid"];
const phases = ["opening", "middlegame", "endgame"];
const difficultyBands = ["easy", "moderate", "difficult", "unavailable"];
const severe = new Set(["mistake", "miss", "blunder"]);
const stockfishPath = resolve(args.stockfish);
const referencePath = args["reference-stockfish"] ? resolve(args["reference-stockfish"]) : stockfishPath;
const referenceDepth = Number(args["reference-depth"]);
const workers = Number(args.workers);
const reviewDepth = 16;
if (!Number.isInteger(referenceDepth) || referenceDepth <= reviewDepth || !Number.isInteger(workers) || workers < 1) {
  throw new Error("Use a reference depth greater than 16 and at least one worker.");
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function sampleGames(archive) {
  const process = spawn("zstd", ["-dc", archive], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise((done, fail) => {
    process.once("error", fail);
    process.once("close", done);
  });
  let decompressionError = "";
  process.stderr.on("data", (chunk) => { decompressionError += chunk; });
  const games = new Map();
  let speed;
  let pgn = [];
  function considerGame() {
    if (!speed || games.has(speed)) return;
    const { headers, positions } = parseReviewGame(pgn.join("\n"));
    const plies = positions.length - 1;
    if (plies < 24 || plies > 38 || headers.Result === "*") return;
    const reviewable = positions.slice(0, -1).filter(({ legalMoves }) => legalMoves > 1);
    if (phases.some((phase) => reviewable.filter((position) => position.phase === phase).length < 2)) return;
    games.set(speed, { speed, headers, positions });
  }

  for await (const line of createInterface({ input: process.stdout, crlfDelay: Infinity })) {
    if (line.startsWith('[Event "')) {
      considerGame();
      if (games.size === speeds.length) break;
      speed = line.match(/^\[Event "Rated (Bullet|Blitz|Rapid) game"\]$/)?.[1];
      pgn = [];
    }
    if (speed) pgn.push(line);
  }
  process.kill();
  await exit;
  if (games.size !== speeds.length) throw new Error(`Found only ${games.size} eligible games. ${decompressionError}`);
  return speeds.map((key) => games.get(key));
}

class ReferenceEngine extends StockfishEngine {
  waitForOutput(timeout, ...args) {
    return super.waitForOutput(Math.max(timeout, 240_000), ...args);
  }
}
globalThis.Worker = StockfishCliWorker;

const totalNodes = (engine) => engine.worker.searches.reduce((sum, { nodes }) => sum + nodes, 0);

function reviewRow(review, nodes) {
  return { grade: review.classification.key, loss: review.winLoss, depth: review.depth,
    confidence: review.searchConfidence ?? null, nodes };
}

async function reviewGame({ speed, positions, headers }) {
  const engine = new StockfishEngine(stockfishPath);
  try {
    await engine.startNewGame();
    let root = await analyzeGamePosition(engine, positions[0], reviewDepth);
    let opponentLoss = 0;
    const decisions = [];
    for (let ply = 1; ply < positions.length; ply++) {
      const before = positions[ply - 1];
      const after = positions[ply];
      engine.worker.searches = [];
      const next = await analyzeGamePosition(engine, after, reviewDepth);
      const comparison = await analyzeDecision(engine, before, after, reviewDepth, root, opponentLoss);
      const review = scoreDecision(before, after, comparison, opponentLoss);
      root = next;
      if (before.legalMoves > 1) {
        const chance = review.difficulty?.chance;
        const difficulty = chance === undefined ? "unavailable" : chance >= 70 ? "easy" : chance >= 40 ? "moderate" : "difficult";
        decisions.push({ site: headers.Site, speed, before, after, opponentLoss, difficulty,
          quick: reviewRow(review, totalNodes(engine)) });
      }
      opponentLoss = review.winLoss;
    }
    console.error(`Reviewed ${speed} ${headers.Site} through all ${positions.length - 1} plies`);
    return { decisions, nodes: decisions.reduce((sum, row) => sum + row.quick.nodes, 0) };
  } finally {
    engine.terminate();
  }
}

function fullBatch(root, depth, width) {
  return root.depth === depth && root.lines.length === width && root.lines.every((line) => line.depth === depth);
}

async function referenceComparison(engine, before, after) {
  const { searchOptions, fen, legalMoves } = before;
  const width = Math.min(3, legalMoves);
  await engine.startNewGame();
  engine.worker.reference = true;
  engine.worker.searches = [];
  let root = await engine.analyzePosition(fen, referenceDepth, { ...searchOptions, multiPv: width });
  if (!fullBatch(root, referenceDepth, width)) throw new Error(`Incomplete reference discovery at ${fen}`);
  const move = after.move.uci;
  const direct = root.lines.find(({ pv }) => pv[0] === move);
  if (direct) return { root, played: direct, confirmed: true };

  const searchMoves = [...root.lines.map(({ pv }) => pv[0]), move];
  await engine.startNewGame();
  root = await engine.analyzePosition(fen, referenceDepth, { ...searchOptions, multiPv: searchMoves.length, searchMoves });
  const played = root.lines.find(({ pv }) => pv[0] === move);
  if (!played || !fullBatch(root, referenceDepth, searchMoves.length)) throw new Error(`Incomplete reference match at ${fen}`);
  return { root, played, confirmed: true };
}

async function auditDecisions(decisions) {
  const audited = [];
  let next = 0;
  const sessions = Array.from({ length: Math.min(workers, decisions.length) }, async () => {
    const deep = new StockfishEngine(stockfishPath);
    const reference = new ReferenceEngine(referencePath);
    try {
      while (next < decisions.length) {
        const { before, after, quick, opponentLoss, difficulty, site, speed } = decisions[next++];
        await deep.startNewGame();
        deep.worker.searches = [];
        const checked = await deepCheckDecision(deep, before, after, quick.depth, opponentLoss);
        const checkNodes = totalNodes(deep);
        const target = await referenceComparison(reference, before, after);
        audited.push({ site, speed, ply: after.ply, move: after.move.uci, phase: before.phase, difficulty, quick,
          deep: checked ? reviewRow(scoreDecision(before, after, checked, opponentLoss), checkNodes) : null,
          checkNodes, reference: reviewRow(scoreDecision(before, after, target, opponentLoss), totalNodes(reference)) });
        if (audited.length % 6 === 0) console.error(`Audited ${audited.length}/${decisions.length} decisions`);
      }
    } finally {
      deep.terminate();
      reference.terminate();
    }
  });
  const finished = await Promise.allSettled(sessions);
  const failed = finished.find(({ status }) => status === "rejected");
  if (failed) throw failed.reason;
  return audited.sort((a, b) => speeds.indexOf(a.speed) - speeds.indexOf(b.speed) || a.ply - b.ply);
}

function summarize(rows) {
  const sum = (get) => rows.reduce((total, row) => total + get(row), 0);
  const gradeMatches = (kind) => sum((row) => Number((row[kind] ?? row.quick).grade === row.reference.grade));
  const severeMatches = (kind) => sum((row) => Number(severe.has((row[kind] ?? row.quick).grade) === severe.has(row.reference.grade)));
  const meanLossError = (kind) => rows.length ? sum((row) => Math.abs((row[kind] ?? row.quick).loss - row.reference.loss)) / rows.length : null;
  return {
    decisions: rows.length,
    deeper: sum(({ deep }) => Number(Boolean(deep))),
    stable: sum(({ deep }) => Number(deep?.confidence === "stable")),
    single: sum(({ deep }) => Number(deep?.confidence === "single")),
    borderline: sum(({ deep }) => Number(deep?.confidence === "borderline")),
    matchedReferenceDepth: sum(({ deep }) => Number(Boolean(deep && deep.depth >= referenceDepth))),
    exactGradeMatches: { quick: gradeMatches("quick"), checked: gradeMatches("deep") },
    severeGradeMatches: { quick: severeMatches("quick"), checked: severeMatches("deep") },
    meanAbsoluteLossError: { quick: meanLossError("quick"), checked: meanLossError("deep") },
    meanCheckNodes: rows.length ? sum(({ checkNodes }) => checkNodes) / rows.length : null,
    meanQuickNodes: rows.length ? sum(({ quick }) => quick.nodes) / rows.length : null,
    maxCheckNodes: rows.length ? Math.max(...rows.map(({ checkNodes }) => checkNodes)) : null,
  };
}

const segment = (rows, key, values) => Object.fromEntries(values.map((value) => [value, summarize(rows.filter((row) => row[key] === value))]));
const games = await sampleGames(args.archive);
const quick = await Promise.all(games.map(reviewGame));
const decisions = await auditDecisions(quick.flatMap(({ decisions }) => decisions));
const stockfish = { engine: await digest(stockfishPath) };
if (stockfishPath.endsWith(".js")) stockfish.wasm = await digest(stockfishPath.replace(/\.js$/, ".wasm"));
console.log(JSON.stringify({
  archive: await digest(args.archive), stockfish, reference: await digest(referencePath), reviewDepth, referenceDepth,
  games: games.map(({ headers, positions, speed }) => ({ site: headers.Site, plies: positions.length - 1, speed,
    clock: headers.TimeControl, result: headers.Result, termination: headers.Termination })),
  all: summarize(decisions), returned: summarize(decisions.filter(({ deep }) => deep)),
  phase: segment(decisions, "phase", phases), speed: segment(decisions, "speed", speeds),
  difficulty: segment(decisions, "difficulty", difficultyBands), decisions,
}, null, 2));
