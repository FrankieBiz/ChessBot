import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { Chess, DEFAULT_POSITION } from "chess.js";

const resultIndex = new Map([["1-0", 0], ["1/2-1/2", 1], ["0-1", 2]]);
export const positionKey = (fen) => fen.split(" ", 4).join(" ");
export const moveUci = ({ from, to, promotion }) => `${from}${to}${promotion ?? ""}`;

function eligible(headers, minRating) {
  return /^Rated (Blitz|Rapid|Classical) game$/.test(headers.Event) &&
    [headers.WhiteElo, headers.BlackElo].every((rating) => Number(rating) >= minRating) &&
    ![headers.WhiteTitle, headers.BlackTitle].includes("BOT") &&
    (!headers.FEN || headers.FEN === DEFAULT_POSITION) &&
    (!headers.Variant || headers.Variant === "Standard");
}

function openingMoves(text, maxPly) {
  const game = new Chess();
  const seen = new Set();
  const played = [];
  let before = positionKey(DEFAULT_POSITION);
  for (const [san] of text.matchAll(/\{[^}]*\}|\d+\.(?:\.\.)?|[^\s]+/g)) {
    if (san.startsWith("{") || san.endsWith(".")) continue;
    if (resultIndex.has(san)) break;
    const move = game.move(san);
    const after = positionKey(move.after);
    played.push({ before, uci: moveUci(move), repeated: seen.has(before) || seen.has(after) });
    if (played.length === maxPly) break;
    seen.add(before);
    before = after;
  }
  return played;
}

export async function scanArchive({ path, sha256, minRating, maxPly }, accept) {
  const archivePath = await realpath(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
  if (hash.digest("hex") !== sha256) throw new Error(`SHA-256 mismatch for ${path}.`);

  const reader = spawn("zstd", ["-dc", "--", archivePath], { stdio: ["ignore", "pipe", "pipe"] });
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
    if (!line.startsWith("1. ") || !eligible(headers, minRating)) continue;
    let moves;
    const result = line.match(/ (1-0|1\/2-1\/2|0-1)$/)?.[1];
    try {
      if (result) moves = openingMoves(line, maxPly);
    } catch {
      // A malformed game is not used in the sample.
    }
    if (!moves?.length) {
      skipped++;
      continue;
    }
    accept(moves, resultIndex.get(result), headers);
    games++;
  }
  const [code] = await exited;
  // A verified byte range may end partway through the last zstd frame.
  if (code !== 0 && !(code === 1 && errors.trimEnd().endsWith(": premature end"))) {
    throw new Error(`Could not decompress ${path}: ${errors.trim()}`);
  }
  return { games, skipped };
}

if (!isMainThread) {
  const positions = new Map();
  const sample = await scanArchive(workerData, (moves, result) => {
    for (const { before, uci, repeated } of moves) {
      if (repeated) continue;
      if (!positions.has(before)) positions.set(before, new Map());
      const choices = positions.get(before);
      if (!choices.has(uci)) choices.set(uci, [0, 0, 0]);
      choices.get(uci)[result]++;
    }
  });
  parentPort.postMessage({ ...sample, positions });
}
