import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Chess } from "chess.js";
import { moveUci, positionKey, scanArchive } from "./lib/opening-archive.mjs";
import { sampleOpeningExamples } from "./lib/opening-examples.mjs";

const [archiveDirectory, holdoutPath] = process.argv.slice(2);
if (!archiveDirectory) throw new Error("Usage: node scripts/build-opening-book.mjs <archive-directory> [holdout.pgn.zst]");

const archives = [
  ["2026-01", 268435455, "24ee4e7dfc3e6b0f279a5f9a74f2499327e2586198d40546bd1c531ba214c12c"],
  ["2026-02", 67108863, "902c59f9bc30d26805b531c9556835e1f3d043646b731ec999f5d8418b86cd08"],
  ["2026-03", 268435455, "84046f4262b6a7f83634d721823d4da9696ac3882b48ad3b8bb5930e6b66562c"],
  ["2026-04", 268435455, "3ecfca45f9929fa430db118bef454542ec308a158a1e0de7eb9d48ea59cd677b"],
  ["2026-05", 67108863, "ce7210a74da6653433b988087ad311c4bbd1ada198d84234ed141874425e4898"],
  ["2026-06", 268435455, "399d79b546e045fa3e6706efddd723202c6b00a4c335398e5526c73114abff4d"],
  ["2026-08", 67108863, "b922312677735f0752dcfadebe895f1f8a5443922e942780b48f4c67cee0683e"],
  ["2026-09", 268435455, "4811bfe278a5110a323fec5eb6e427738807c36c6981dfb9b0b506670dff5050"],
];
const openingRevision = "48a8c0e733facfdc9a3723fe882e51ec28014074";
const catalogSource = "https://github.com/lichess-org/chess-openings";
const ratingsSource = "https://database.lichess.org/#standard_games";
const baselineRevision = "bcc32d8eacce90d2112ef4de441e906be8d01ad9";
const holdoutRange = [70160138, 137269001];
const holdoutHash = "6399409e7f8eaa22688151eefd78704dc5b378590c60eeac8847549e11166013";
const limits = { maxPly: 26, minRating: 2100 };
const bookLimits = { minGames: 20, minShare: 0.05, minMonthGames: 5, minMonths: 2 };
const explorerLimits = { minPositionGames: 20, minMoveGames: 5, maxChoices: 8 };
const exampleLimits = { month: "2026-02", minGames: 100, maxPositions: 100, maxChoices: 3, plies: 6 };
const gamesPlayed = ([whiteWins, draws, blackWins]) => whiteWins + draws + blackWins;

const positions = new Map();
let maxPly = 0;
let lineCount = 0;

function positionFor(fen) {
  const key = positionKey(fen);
  if (!positions.has(key)) positions.set(key, { opening: null, moves: new Set() });
  return positions.get(key);
}

const volumes = await Promise.all([..."abcde"].map(async (volume) => {
  const response = await fetch(`https://raw.githubusercontent.com/lichess-org/chess-openings/${openingRevision}/${volume}.tsv`);
  if (!response.ok) throw new Error(`Could not fetch opening volume ${volume}: HTTP ${response.status}`);
  return response.text();
}));
for (const volume of volumes) {
  const [header, ...rows] = volume.trimEnd().split(/\r?\n/);
  if (header !== "eco\tname\tpgn" || !rows.length) throw new Error("Unexpected opening TSV format.");
  for (const row of rows) {
    const [eco, name, pgn] = row.split("\t");
    const game = new Chess();
    game.loadPgn(pgn);
    const moves = game.history({ verbose: true });
    for (const move of moves) positionFor(move.before).moves.add(moveUci(move));
    positionFor(game.fen()).opening ??= { eco, name };
    maxPly = Math.max(maxPly, moves.length);
    lineCount++;
  }
}

async function readSample([month, lastByte, sha256], merge) {
  const workerData = { path: join(archiveDirectory, `${month}.pgn.zst`), sha256, ...limits };
  const worker = new Worker(new URL("./lib/opening-archive.mjs", import.meta.url), { workerData });
  const [{ games, skipped, positions }] = await once(worker, "message");
  merge(positions);
  return { month, range: [0, lastByte], sha256, games, skipped };
}

const counts = new Map();
function mergeSample(sample) {
  for (const [fen, moves] of sample) {
    if (!counts.has(fen)) counts.set(fen, new Map());
    const combined = counts.get(fen);
    for (const [uci, result] of moves) {
      if (!combined.has(uci)) combined.set(uci, [0, 0, 0, 0]);
      const running = combined.get(uci);
      for (let i = 0; i < result.length; i++) running[i] += result[i];
      if (gamesPlayed(result) >= bookLimits.minMonthGames) running[3]++;
    }
  }
}

const samples = [];
const workers = Math.max(1, Math.min(4, availableParallelism() - 1));
for (let start = 0; start < archives.length; start += workers) {
  const batch = await Promise.all(archives.slice(start, start + workers).map((archive) => readSample(archive, mergeSample)));
  samples.push(...batch);
  for (const { month, games, skipped } of batch) console.log(`${month}: ${games} games, ${skipped} skipped.`);
}

const explorer = new Map();
let supplementalCount = 0;
for (const [fen, choices] of counts) {
  const moves = [...choices].map(([uci, result]) => ({ uci, result, games: gamesPlayed(result) }));
  const total = moves.reduce((sum, { games }) => sum + games, 0);
  for (const { uci, result, games } of moves) {
    if (games < bookLimits.minGames || games / total < bookLimits.minShare || result[3] < bookLimits.minMonths) continue;
    if (positions.get(fen)?.moves.has(uci)) continue;
    const position = positionFor(fen);
    (position.supplemental ??= []).push(uci);
    supplementalCount++;
  }
  if (total >= explorerLimits.minPositionGames) {
    const ranked = moves
      .filter(({ games }) => games >= explorerLimits.minMoveGames)
      .sort((a, b) => b.games - a.games || (a.uci < b.uci ? -1 : 1))
      .slice(0, explorerLimits.maxChoices)
      .map(({ uci, result }) => [uci, ...result.slice(0, 3)]);
    if (ranked.length) explorer.set(fen, ranked);
  }
}

const [, , exampleSha256] = archives.find(([month]) => month === exampleLimits.month);
const examples = await sampleOpeningExamples(explorer, {
  path: join(archiveDirectory, `${exampleLimits.month}.pgn.zst`), sha256: exampleSha256, ...limits,
}, exampleLimits);

function renderEntries(table, value) {
  return [...table.keys()].sort().map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(value(table.get(key)))},`);
}

async function writeData(name, lines) {
  const output = new URL(`../${name}.js`, import.meta.url);
  const temporary = new URL(`../${name}.${process.pid}.tmp`, import.meta.url);
  const text = `${lines.join("\n")}\n`;
  try {
    await writeFile(temporary, text);
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}

const sample = {
  source: "Lichess rated games",
  sourceUrl: ratingsSource,
  license: "CC0-1.0",
  firstMonth: archives[0][0],
  lastMonth: archives.at(-1)[0],
  months: archives.map(([month]) => month),
  minRating: limits.minRating,
  games: samples.reduce((sum, { games }) => sum + games, 0),
  maxPly: limits.maxPly,
  minMoveGames: explorerLimits.minMoveGames,
  examples,
};
const edgeCount = [...positions.values()].reduce((sum, { moves }) => sum + moves.size, 0);
const commonHeader = [
  "// Generated by node scripts/build-opening-book.mjs <archive-directory>.",
  `// Rated games: ${ratingsSource} (CC0 1.0).`,
  ...samples.map(({ month, range, sha256 }) => `// ${month}, bytes ${range.join("-")}, SHA-256 ${sha256}`),
];
await writeData("opening-book-data", [
  ...commonHeader,
  `// Named lines: ${catalogSource}/tree/${openingRevision} (CC0 1.0).`,
  `// ${lineCount} named lines, ${edgeCount} named pairs, ${supplementalCount} game-derived pairs.`,
  "// Values are [opening, named-line UCI continuations, optional game-derived UCI continuations].",
  `export const BOOK_MAX_PLY = ${maxPly};`,
  `export const GAME_BOOK_MAX_PLY = ${limits.maxPly};`,
  "export const BOOK_POSITIONS = {",
  ...renderEntries(positions, ({ opening, moves, supplemental }) => {
    const fields = [opening, [...moves].sort()];
    if (supplemental) fields.push(supplemental.sort());
    return fields;
  }),
  "};",
]);
await writeData("opening-explorer-data", [
  ...commonHeader,
  "// Rows are [UCI, White wins, draws, Black wins, optional [Lichess game ID, ...UCI moves]].",
  `export const OPENING_EXPLORER_SAMPLE = ${JSON.stringify(sample, null, 2)};`,
  "export const EXPLORER_POSITIONS = {",
  ...renderEntries(explorer, (choices) => choices),
  "};",
]);

const report = {
  namedCatalog: { source: catalogSource, revision: openingRevision, lines: lineCount, edges: edgeCount, maxPly },
  sample, samples, bookLimits, explorerLimits, exampleLimits,
  supplementalEdges: supplementalCount,
  explorerPositions: explorer.size,
  explorerChoices: [...explorer.values()].reduce((sum, choices) => sum + choices.length, 0),
};

if (holdoutPath) {
  const baselineData = execFileSync("git", ["show", `${baselineRevision}:opening-book-data.js`]);
  const baseline = await import(`data:text/javascript;base64,${baselineData.toString("base64")}`);
  const byPly = Array.from({ length: limits.maxPly }, () => ({ total: 0, v36: 0, expanded: 0, explorer: 0 }));
  const holdout = await scanArchive({ path: holdoutPath, sha256: holdoutHash, ...limits }, (moves) => {
    for (const [index, { before, uci, repeated }] of moves.entries()) {
      const row = byPly[index];
      row.total++;
      if (repeated) continue;
      const old = baseline.BOOK_POSITIONS[before];
      if (old?.[1].includes(uci) || (index < baseline.GAME_BOOK_MAX_PLY && old?.[2]?.includes(uci))) row.v36++;
      const position = positions.get(before);
      if (position?.moves.has(uci) || position?.supplemental?.includes(uci)) row.expanded++;
      if (explorer.get(before)?.length) row.explorer++;
    }
  });
  report.holdout = { month: "2026-10", baselineRevision, range: holdoutRange, sha256: holdoutHash, ...holdout, byPly };
}
console.log(JSON.stringify(report, null, 2));
