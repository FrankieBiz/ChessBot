// Times full-game reviews: one engine move by move, against the pooled two-phase review.
// With --check, also confirms that every pooled result equals checking that move on its own.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { StockfishCliWorker } from "./lib/stockfish-cli.mjs";

globalThis.Worker = StockfishCliWorker;
const rootDir = fileURLToPath(new URL("../", import.meta.url));
const { StockfishEngine } = await import("../engine.js");
const analysis = await import("../analysis.js");
const { EnginePool } = await import("../engine-pool.js");
const { runReview } = await import("../review-run.js");

const { values: args } = parseArgs({ options: {
  pgn: { type: "string" },
  engines: { type: "string", default: "4" },
  depth: { type: "string", default: "16" },
  stockfish: { type: "string", default: join(rootDir, "node_modules", "stockfish", "bin", "stockfish-19-single.js") },
  check: { type: "boolean" },
  "skip-sequential": { type: "boolean" },
  help: { type: "boolean" },
} });
if (args.help || !args.pgn) {
  console.log("Usage: node scripts/benchmark-review-speed.mjs --pgn games.pgn [--engines 4] [--depth 16]\n" +
    "       [--stockfish path] [--check] [--skip-sequential]\n" +
    "Games in the file are separated by blank lines before each [Event tag. Prints one JSON line per game.");
  process.exit(args.help ? 0 : 2);
}
const engines = Number(args.engines);
const depth = Number(args.depth);
const games = (await readFile(args.pgn, "utf8")).split(/\n\s*\n(?=\[Event )/).filter((pgn) => pgn.trim());
const seconds = (ms) => Number((ms / 1000).toFixed(1));
const newEngine = () => new StockfishEngine(args.stockfish);
const summary = (comparison, before, after) => {
  const review = analysis.scoreDecision(before, after, comparison, 0);
  return [review.classification.key, review.winLoss, comparison.searchConfidence].join(" ");
};

// The single-engine review that ChessBot 3.7 ran: one search table for the whole game.
async function sequential(positions) {
  const engine = newEngine();
  try {
    await engine.startNewGame();
    const roots = [];
    const start = performance.now();
    for (let index = 0; index < positions.length; index++) {
      roots[index] = await analysis.analyzeGamePosition(engine, positions[index], depth);
      if (index) await analysis.analyzeDecision(engine, positions[index - 1], positions[index], depth, roots[index - 1]);
    }
    return performance.now() - start;
  } finally {
    engine.terminate();
  }
}

for (const [game, pgn] of games.entries()) {
  const { positions } = analysis.parseReviewGame(pgn);
  const row = { game, plies: positions.length - 1, engines, depth };
  if (!args["skip-sequential"]) row.oneEngineSeconds = seconds(await sequential(positions));

  const pool = new EnginePool(newEngine, engines);
  const finals = [];
  let quick = 0;
  const start = performance.now();
  await runReview({
    positions, depth, pool,
    onQuick: () => {
      if (++quick === positions.length - 1) row.quickPassSeconds = seconds(performance.now() - start);
    },
    onFinal: (ply, comparison) => { finals[ply] = comparison; },
  });
  row.pooledSeconds = seconds(performance.now() - start);

  if (args.check) {
    // Each move from a cleared table: its position search, then every pass in one run.
    const separate = await Promise.all(positions.slice(1).map((after, index) => pool.run(async (engine) => {
      const before = positions[index];
      await engine.startNewGame();
      const root = await analysis.analyzeGamePosition(engine, before, depth);
      return analysis.analyzeDecision(engine, before, after, depth, root);
    })));
    row.identicalMoves = separate.filter((comparison, index) =>
      summary(comparison, positions[index], positions[index + 1]) ===
      summary(finals[index + 1], positions[index], positions[index + 1])).length;
  }
  pool.abort();
  console.log(JSON.stringify(row));
}
