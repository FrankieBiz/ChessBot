// Fetch a validation sample of rated Chess.com games through the public API.
// Players come from a public club's recently active members. Each contributes at most
// --per-player games from one month. Requests are serial, as the API asks of bulk clients.
// Output rows feed scripts/collect-human-moves.mjs --chesscom.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({ options: {
  club: { type: "string", default: "chess-com-developer-community" },
  month: { type: "string", default: "2026/10" },
  out: { type: "string" },
  games: { type: "string", default: "1500" },
  "per-player": { type: "string", default: "2" },
} });
if (!args.out || !/^\d{4}\/\d{2}$/.test(args.month)) {
  console.error("Usage: node scripts/fetch-chesscom-games.mjs --out games.jsonl [--club id] [--month 2026/10] [--games 1500] [--per-player 2]");
  process.exit(2);
}
const target = Number(args.games);
const perPlayer = Number(args["per-player"]);
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const order = (value) => createHash("sha256").update(value).digest("hex");

async function api(path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`https://api.chess.com/pub/${path}`, {
      headers: { "User-Agent": "chess-review-research/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
      continue;
    }
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  }
  throw new Error(`${path}: rate limited`);
}

const seen = new Set(existsSync(args.out)
  ? readFileSync(args.out, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).url) : []);
const members = await api(`club/${encodeURIComponent(args.club)}/members`);
const usernames = [...new Set([...(members?.weekly ?? []), ...(members?.monthly ?? [])].map(({ username }) => username))]
  .sort((a, b) => order(a).localeCompare(order(b)));
console.error(`${usernames.length} recently active members`);

let written = seen.size;
for (const username of usernames) {
  if (written >= target) break;
  const archive = await api(`player/${encodeURIComponent(username)}/games/${args.month}`).catch((error) => {
    console.error(error.message);
    return null;
  });
  const games = (archive?.games ?? [])
    .filter((game) => game.rated && game.rules === "chess" && ["bullet", "blitz", "rapid"].includes(game.time_class) &&
      (!game.initial_setup || game.initial_setup === START) && game.pgn && !seen.has(game.url) &&
      Number.isInteger(game.white?.rating) && Number.isInteger(game.black?.rating))
    .sort((a, b) => order(a.url).localeCompare(order(b.url)))
    .slice(0, perPlayer);
  for (const game of games) {
    seen.add(game.url);
    appendFileSync(args.out, JSON.stringify({
      url: game.url, timeClass: game.time_class, timeControl: game.time_control,
      ratings: { w: game.white.rating, b: game.black.rating }, pgn: game.pgn,
    }) + "\n");
    written++;
  }
  if (written % 100 < perPlayer) console.error(`${written}/${target} games`);
  await new Promise((resolve) => setTimeout(resolve, 150));
}
console.error(`done: ${written} games in ${args.out}`);
