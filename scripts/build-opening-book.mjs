import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Chess, DEFAULT_POSITION } from "chess.js";

const [archiveDirectory, holdoutPath] = process.argv.slice(2);
if (!archiveDirectory) throw new Error("Usage: node scripts/build-opening-book.mjs <archive-directory> [holdout.pgn.zst]");

const archives = [
  ["2026-02", "902c59f9bc30d26805b531c9556835e1f3d043646b731ec999f5d8418b86cd08"],
  ["2026-05", "ce7210a74da6653433b988087ad311c4bbd1ada198d84234ed141874425e4898"],
  ["2026-08", "b922312677735f0752dcfadebe895f1f8a5443922e942780b48f4c67cee0683e"],
];
const sampleMaxPly = 20;
const minRating = 2100;
const minGames = 20;
const minShare = 0.05;
const minGamesPerMonth = 5;
const minMonths = 2;
const gameResult = /^(?:1-0|0-1|1\/2-1\/2)$/;
const positionKey = (fen) => fen.split(" ", 4).join(" ");
const moveUci = ({ from, to, promotion }) => `${from}${to}${promotion ?? ""}`;

function eligible(headers) {
  return /^Rated (Blitz|Rapid|Classical) game$/.test(headers.Event) &&
    [headers.WhiteElo, headers.BlackElo].every((rating) => Number(rating) >= minRating) &&
    ![headers.WhiteTitle, headers.BlackTitle].includes("BOT") &&
    (!headers.FEN || headers.FEN === DEFAULT_POSITION) &&
    (!headers.Variant || headers.Variant === "Standard");
}

function openingMoves(text) {
  const tokens = text.replace(/\{[^}]*\}/g, " ").replace(/\d+\.(?:\.\.)?/g, " ").trim().split(/\s+/);
  const game = new Chess();
  const seen = new Set();
  const played = [];
  let before = positionKey(DEFAULT_POSITION);
  for (const san of tokens.slice(0, sampleMaxPly)) {
    if (gameResult.test(san)) break;
    const move = game.move(san);
    const after = positionKey(move.after);
    played.push({ before, uci: moveUci(move), repeated: seen.has(before) || seen.has(after) });
    seen.add(before);
    before = after;
  }
  return played;
}

async function scanArchive(path, accept) {
  const reader = spawn("zstd", ["-dc", "--", path], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(reader, "close");
  let errors = "";
  reader.stderr.on("data", (chunk) => { errors += chunk; });
  let headers = {};
  let games = 0;
  let skipped = 0;
  for await (const line of createInterface({ input: reader.stdout })) {
    if (line.startsWith("[Event ")) headers = {};
    if (line.startsWith("[")) {
      const header = line.match(/^\[(\w+) "(.*)"\]$/);
      if (header) headers[header[1]] = header[2];
      continue;
    }
    if (!line.startsWith("1. ") || !eligible(headers)) continue;
    let moves;
    try {
      if (gameResult.test(line.split(" ").at(-1))) moves = openingMoves(line);
    } catch {
      // A malformed game is not used in the sample.
    }
    if (!moves?.length) {
      skipped++;
      continue;
    }
    accept(moves);
    games++;
  }
  const [code] = await exited;
  // A verified byte range may end partway through the last zstd frame.
  if (code !== 0 && !(code === 1 && errors.trimEnd().endsWith(": premature end"))) {
    throw new Error(`Could not decompress ${path}: ${errors.trim()}`);
  }
  return { games, skipped };
}

const revision = "48a8c0e733facfdc9a3723fe882e51ec28014074";
const source = "https://github.com/lichess-org/chess-openings";
const raw = `https://raw.githubusercontent.com/lichess-org/chess-openings/${revision}`;
const volumes = await Promise.all([..."abcde"].map(async (volume) => {
  const response = await fetch(`${raw}/${volume}.tsv`);
  if (!response.ok) throw new Error(`Could not fetch opening volume ${volume}: HTTP ${response.status}`);
  return response.text();
}));

const positions = new Map();
let maxPly = 0;
let lineCount = 0;

function positionFor(fen) {
  const key = positionKey(fen);
  if (!positions.has(key)) positions.set(key, { opening: null, moves: new Set() });
  return positions.get(key);
}

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

const counts = new Map();
let gameCount = 0;
for (const [monthIndex, [month, digest]] of archives.entries()) {
  const path = join(archiveDirectory, `${month}.pgn.zst`);
  const actualDigest = createHash("sha256").update(await readFile(path)).digest("hex");
  if (actualDigest !== digest) throw new Error(`SHA-256 mismatch for ${path}. Use bytes 0–67108863 of the Lichess export.`);
  const sample = await scanArchive(path, (moves) => {
    for (const { before, uci, repeated } of moves) {
      if (repeated) continue;
      if (!counts.has(before)) counts.set(before, { total: 0, moves: new Map() });
      const position = counts.get(before);
      position.total++;
      if (!position.moves.has(uci)) position.moves.set(uci, Array(archives.length).fill(0));
      position.moves.get(uci)[monthIndex]++;
    }
  });
  gameCount += sample.games;
  console.log(`${month}: ${sample.games} games, ${sample.skipped} skipped.`);
}

let supplementalCount = 0;
for (const [fen, { total, moves }] of counts) {
  for (const [uci, monthly] of moves) {
    const occurrences = monthly.reduce((sum, count) => sum + count, 0);
    const months = monthly.filter((count) => count >= minGamesPerMonth).length;
    if (occurrences < minGames || occurrences / total < minShare || months < minMonths) continue;
    if (positions.get(fen)?.moves.has(uci)) continue;
    const position = positionFor(fen);
    (position.supplemental ??= []).push(uci);
    supplementalCount++;
  }
}

const entries = [...positions.keys()].sort().map((key) => {
  const { opening, moves, supplemental } = positions.get(key);
  const fields = [opening, [...moves].sort()];
  if (supplemental) fields.push(supplemental.sort());
  return `  ${JSON.stringify(key)}: ${JSON.stringify(fields)},`;
});
const edgeCount = [...positions.values()].reduce((sum, { moves }) => sum + moves.size, 0);
const data = [
  "// Generated by node scripts/build-opening-book.mjs <archive-directory>.",
  `// Source: Lichess chess-openings, ${source}/tree/${revision}`,
  "// Public domain dedication: CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/",
  `// ${lineCount} named lines, ${edgeCount} position-move pairs.`,
  `// ${supplementalCount} additional position-move pairs from ${gameCount} rated Lichess games.`,
  "// Source: https://database.lichess.org/#standard_games (CC0), first 64 MiB of each archive.",
  ...archives.map(([month, digest]) => `// ${month} SHA-256 ${digest}`),
  "// Values are [opening, named-line UCI continuations, optional game-derived UCI continuations].",
  `export const BOOK_MAX_PLY = ${maxPly};`,
  `export const GAME_BOOK_MAX_PLY = ${sampleMaxPly};`,
  "export const BOOK_POSITIONS = {",
  ...entries,
  "};",
  "",
].join("\n");

const outputPath = new URL("../opening-book-data.js", import.meta.url);
const temporaryPath = new URL(`../opening-book-data.${process.pid}.tmp`, import.meta.url);
try {
  await writeFile(temporaryPath, data);
  await rename(temporaryPath, outputPath);
} finally {
  await rm(temporaryPath, { force: true });
}
console.log(`Built opening-book-data.js with ${edgeCount} named-line moves and ${supplementalCount} game-derived moves.`);

if (holdoutPath) {
  const byPly = Array.from({ length: sampleMaxPly }, () => ({ total: 0, named: 0, combined: 0 }));
  const holdout = await scanArchive(holdoutPath, (moves) => {
    for (const [index, { before, uci, repeated }] of moves.entries()) {
      const row = byPly[index];
      row.total++;
      if (repeated) continue;
      const position = positions.get(before);
      if (position?.moves.has(uci)) {
        row.named++;
        row.combined++;
      } else if (position?.supplemental?.includes(uci)) row.combined++;
    }
  });
  console.log(JSON.stringify({ holdout, byPly }, null, 2));
}
