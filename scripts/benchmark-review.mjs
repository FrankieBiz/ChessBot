import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const defaultEngine = join(rootDir, "node_modules", "stockfish", "bin", "stockfish-19-single.js");
const severeGrades = new Set(["mistake", "miss", "blunder"]);
const cacheVersion = 1;

const { values: args } = parseArgs({ options: {
  input: { type: "string" },
  baseline: { type: "string" },
  candidate: { type: "string" },
  cache: { type: "string" },
  stockfish: { type: "string", default: defaultEngine },
  count: { type: "string", default: "72" },
  workers: { type: "string", default: "4" },
  depth: { type: "string", default: "16" },
  "reference-depth": { type: "string", default: "22" },
  help: { type: "boolean" },
} });

if (args.help || !args.input || !args.baseline || !args.cache) {
  console.log(
    "Usage: node scripts/benchmark-review.mjs --input holdout.jsonl --baseline v3.2.0-dir --cache cache-dir\n" +
    "       [--candidate project-dir] [--count 72] [--workers 4] [--depth 16] [--reference-depth 22]\n" +
    "       [--stockfish node_modules/stockfish/bin/stockfish-19-single.js]\n" +
    "Holdout rows are JSON objects with Lichess movetext and a calibration row whose second value is completed plies.\n" +
    "The cache stores per-position results. Add --candidate to compare updated review source against the same reference.",
  );
  process.exit(args.help ? 0 : 2);
}

function integerOption(name) {
  const value = Number(args[name]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

const count = integerOption("count");
const workers = integerOption("workers");
const depth = integerOption("depth");
const referenceDepth = integerOption("reference-depth");
if (referenceDepth <= depth) throw new Error("--reference-depth must be higher than --depth");
const enginePath = resolve(args.stockfish);
const cacheDir = resolve(args.cache);
await mkdir(cacheDir, { recursive: true });

const hash = (value) => createHash("sha256").update(value).digest("hex");

async function hashFile(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function loadImplementation(directory) {
  const path = resolve(directory);
  const files = (await readdir(path)).filter((name) => name.endsWith(".js")).sort();
  files.push("vendor/chess.js/chess.js");
  const source = hash(JSON.stringify(await Promise.all(files.map(async (name) => [
    name, await hashFile(join(path, name)),
  ]))));
  const moduleUrl = (name) => pathToFileURL(join(path, name)).href;
  const [analysis, transport] = await Promise.all([
    import(moduleUrl("analysis.js")), import(moduleUrl("engine.js")),
  ]);
  return { analysis, transport, source };
}

class StockfishCliWorker {
  constructor(path) {
    this.process = spawn(process.execPath, [path], { stdio: ["pipe", "pipe", "pipe"] });
    this.searches = [];
    this.reference = false;
    this.pendingBarrier = null;
    this.closed = false;
    let stderr = "";
    this.process.stderr.on("data", (data) => { stderr = (stderr + data).slice(-4000); });
    this.process.on("error", (error) => this.fail(error));
    this.process.stdin.on("error", (error) => this.fail(error));
    this.process.on("close", (code, signal) => {
      this.fail(new Error(`Stockfish exited (${code ?? signal})${stderr ? `\n${stderr}` : ""}`));
    });
    createInterface({ input: this.process.stdout }).on("line", (data) => {
      if (data === "readyok") this.pendingBarrier?.resolve();
      const nodes = data.match(/\bnodes (\d+)/)?.[1];
      const search = this.searches.at(-1);
      if (nodes && search) search.nodes = Math.max(search.nodes, Number(nodes));
      this.onmessage?.({ data });
    });
  }

  fail(error) {
    if (this.closed) return;
    this.pendingBarrier?.reject(error);
    this.onerror?.(error);
  }

  postMessage(command) {
    if (command.startsWith("go ")) {
      if (this.reference) command = command.replace(/\s+nodes \d+\b/, "");
      this.searches.push({ command, nodes: 0 });
    }
    this.process.stdin.write(command + "\n");
  }

  async clearHash() {
    let timer;
    try {
      await new Promise((resolve, reject) => {
        this.pendingBarrier = { resolve, reject };
        timer = setTimeout(() => reject(new Error("Stockfish hash reset timed out")), 30_000);
        this.postMessage("ucinewgame");
        this.postMessage("isready");
      });
    } finally {
      clearTimeout(timer);
      this.pendingBarrier = null;
    }
  }

  terminate() {
    this.closed = true;
    this.pendingBarrier?.reject(new Error("Stockfish terminated"));
    this.process.kill();
  }
}

globalThis.Worker = StockfishCliWorker;

async function loadPositions(path, parseReviewGame) {
  const records = [];
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    records.push({ ...record, id: hash(JSON.stringify(record)) });
  }
  // Smaller samples use a deterministic prefix of the same holdout.
  records.sort((a, b) => a.id.localeCompare(b.id));

  const positions = [];
  const seen = new Set();
  let excluded = 0;
  for (const { id, movetext, row } of records) {
    if (seen.has(id)) continue;
    seen.add(id);
    const { positions: game } = parseReviewGame(movetext, `${row[2]}+${row[3]}`);
    const before = game[row[1]];
    const after = game[row[1] + 1];
    if (!before || !after?.move || before.terminal || before.legalMoves < 2) {
      excluded++;
      continue;
    }
    positions.push({ id, before, after });
    if (positions.length === count) break;
  }
  if (positions.length < count) {
    throw new Error(`Requested ${count} positions, found ${positions.length} eligible in ${records.length} input rows`);
  }
  return { positions, records: records.length, excluded };
}

async function readCache(path) {
  const entries = new Map();
  let input;
  try {
    input = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return entries;
    throw error;
  }
  for (const line of input.split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    entries.set(entry.id, entry);
  }
  return entries;
}

function asResult(position, comparison, review, searches, start) {
  return {
    id: position.id,
    fen: position.before.fen,
    playedMove: position.after.move.uci,
    grade: review.classification.key,
    winLoss: review.winLoss,
    cpLoss: review.cpLoss,
    rootDepth: comparison.root.depth,
    playedDepth: comparison.played.depth,
    bestMove: comparison.root.bestMove,
    rootEval: comparison.root.eval,
    playedEval: comparison.played.eval,
    confidence: comparison.searchConfidence ?? review.searchConfidence ?? null,
    elapsedMs: performance.now() - start,
    searches,
  };
}

async function reviewPosition(engine, { before, after }, analysis) {
  const initialRoot = await analysis.analyzeGamePosition(engine, before, depth);
  return analysis.analyzeDecision(engine, before, after, depth, initialRoot);
}

async function referencePosition(engine, { before, after }) {
  const { searchOptions, fen, legalMoves } = before;
  const playedUci = after.move.uci;
  const width = Math.min(3, legalMoves);
  const discovery = await engine.analyzePosition(fen, referenceDepth, {
    ...searchOptions, multiPv: width,
  });
  if (discovery.lines.length !== width) throw new Error("Stockfish did not finish the reference shortlist");
  const discoveryPlayed = discovery.lines.find(({ pv }) => pv[0] === playedUci);
  if (discoveryPlayed) return { root: discovery, played: discoveryPlayed, confirmed: true };
  // Search all compared moves from the same position at a common depth.
  const searchMoves = [...discovery.lines.map(({ pv }) => pv[0]), playedUci];
  await engine.worker.clearHash();
  const root = await engine.analyzePosition(fen, referenceDepth, {
    ...searchOptions, multiPv: searchMoves.length, searchMoves,
  });
  const played = root.lines.find(({ pv }) => pv[0] === playedUci);
  if (!played || root.lines.length !== searchMoves.length) {
    throw new Error("Stockfish did not return a matched reference score for every shortlisted move");
  }
  return { root, played, confirmed: true };
}

async function collect(label, implementation, positions) {
  const reference = label === "reference";
  const searchDepth = reference ? referenceDepth : depth;
  const key = hash(JSON.stringify([cacheVersion, engineId, implementation.source, searchDepth, reference, workers]));
  const path = join(cacheDir, `${label}-${key}.jsonl`);
  const entries = await readCache(path);
  const missing = positions.filter(({ id }) => !entries.has(id));
  const { analysis, transport } = implementation;
  const { StockfishEngine } = transport;
  class ReferenceEngine extends StockfishEngine {
    waitForOutput(timeout, ...args) {
      return super.waitForOutput(Math.max(timeout, 240_000), ...args);
    }
  }
  console.error(`${label}: ${positions.length - missing.length}/${positions.length} cached at ${path}`);
  let next = 0;
  let completed = positions.length - missing.length;
  const sessions = Array.from({ length: Math.min(workers, missing.length) }, async () => {
    const engine = reference ? new ReferenceEngine(enginePath) : new StockfishEngine(enginePath);
    try {
      await engine.init();
      engine.worker.reference = reference;
      while (next < missing.length) {
        const position = missing[next++];
        await engine.worker.clearHash();
        engine.worker.searches = [];
        const start = performance.now();
        const comparison = reference
          ? await referencePosition(engine, position)
          : await reviewPosition(engine, position, analysis);
        // Isolated decisions have no previous reviewed move. Mistake, Miss, and Blunder share the severe group.
        const review = analysis.scoreDecision(position.before, position.after, comparison, 0);
        const entry = asResult(position, comparison, review, engine.worker.searches, start);
        appendFileSync(path, JSON.stringify(entry) + "\n");
        entries.set(position.id, entry);
        completed++;
        if (completed % 6 === 0 || completed === positions.length) {
          console.error(`${label}: ${completed}/${positions.length}`);
        }
      }
    } finally {
      engine.terminate();
    }
  });
  const settled = await Promise.allSettled(sessions);
  const failed = settled.find(({ status }) => status === "rejected");
  if (failed) throw failed.reason;
  return { rows: positions.map(({ id }) => entries.get(id)), source: implementation.source, path };
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

function quantile(values, fraction) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

function summarize(result, reference, targetDepth) {
  const { rows, source, path } = result;
  const severe = (row) => severeGrades.has(row.grade);
  const differences = rows.map((row, index) => {
    const target = reference.rows[index];
    return {
      gradeAgreement: row.grade === target.grade,
      severeAgreement: severe(row) === severe(target),
      falseSevere: severe(row) && !severe(target),
      missedSevere: !severe(row) && severe(target),
      error: Math.abs(row.winLoss - target.winLoss),
      cpError: Math.abs(row.cpLoss - target.cpLoss),
    };
  });
  const searchConfidence = {};
  for (const { confidence } of rows) {
    if (confidence) searchConfidence[confidence] = (searchConfidence[confidence] ?? 0) + 1;
  }
  return {
    source,
    cache: path,
    count: rows.length,
    targetDepth,
    medianDepth: quantile(rows.map(({ rootDepth, playedDepth }) => Math.min(rootDepth, playedDepth)), 0.5),
    completedAtTargetDepth: rows.filter(({ rootDepth, playedDepth }) =>
      Math.min(rootDepth, playedDepth) >= targetDepth).length,
    meanWinLoss: mean(rows.map(({ winLoss }) => winLoss)),
    meanAbsoluteWinLossError: mean(differences.map(({ error }) => error)),
    meanAbsoluteCpLossError: mean(differences.map(({ cpError }) => cpError)),
    severeGrades: rows.filter(severe).length,
    exactGradeMatches: differences.filter(({ gradeAgreement }) => gradeAgreement).length,
    severeGradeMatches: differences.filter(({ severeAgreement }) => severeAgreement).length,
    falseSevere: differences.filter(({ falseSevere }) => falseSevere).length,
    missedSevere: differences.filter(({ missedSevere }) => missedSevere).length,
    meanElapsedMs: mean(rows.map(({ elapsedMs }) => elapsedMs)),
    medianElapsedMs: quantile(rows.map(({ elapsedMs }) => elapsedMs), 0.5),
    p90ElapsedMs: quantile(rows.map(({ elapsedMs }) => elapsedMs), 0.9),
    meanNodes: mean(rows.map(({ searches }) => searches.reduce((sum, search) => sum + search.nodes, 0))),
    meanSearches: mean(rows.map(({ searches }) => searches.length)),
    searchConfidence,
  };
}

function pairedComparison(baseline, candidate, reference) {
  const errorChanges = candidate.rows.map((row, index) => {
    const target = reference.rows[index].winLoss;
    return Math.abs(row.winLoss - target) - Math.abs(baseline.rows[index].winLoss - target);
  });
  const change = mean(errorChanges);
  const standardError = errorChanges.length > 1
    ? Math.sqrt(errorChanges.reduce((sum, value) => sum + (value - change) ** 2, 0) /
      (errorChanges.length * (errorChanges.length - 1)))
    : null;
  return {
    meanAbsoluteWinLossErrorChange: change,
    approximate95PercentInterval: standardError === null
      ? null
      : [change - 1.96 * standardError, change + 1.96 * standardError],
    positionsImproved: errorChanges.filter((value) => value < 0).length,
    positionsUnchanged: errorChanges.filter((value) => value === 0).length,
    positionsWorsened: errorChanges.filter((value) => value > 0).length,
  };
}

const [baseline, engineScriptHash, engineWasmHash] = await Promise.all([
  loadImplementation(args.baseline),
  hashFile(enginePath),
  hashFile(enginePath.replace(/\.js$/, ".wasm")),
]);
const engineId = hash(JSON.stringify([engineScriptHash, engineWasmHash]));
const { positions, records, excluded } = await loadPositions(args.input, baseline.analysis.parseReviewGame);
const baselineResult = await collect("baseline", baseline, positions);
const referenceResult = await collect("reference", baseline, positions);
const result = {
  engine: engineId,
  input: await hashFile(args.input),
  inputRecords: records,
  excludedFromSamplePrefix: excluded,
  sample: hash(JSON.stringify(positions.map(({ id }) => id))),
  workers,
  baseline: summarize(baselineResult, referenceResult, depth),
  reference: summarize(referenceResult, referenceResult, referenceDepth),
};
if (args.candidate) {
  const candidate = await loadImplementation(args.candidate);
  const candidateResult = await collect("candidate", candidate, positions);
  result.candidate = summarize(candidateResult, referenceResult, depth);
  result.paired = pairedComparison(baselineResult, candidateResult, referenceResult);
}
console.log(JSON.stringify(result, null, 2));
