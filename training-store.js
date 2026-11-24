// Saved practice data. Each game and each puzzle has its own storage key, so the review page and a
// Practice page can save at the same time without overwriting each other's records.
export const TRAINING_VERSION = 1;
export const MAX_GAMES = 500;

const VERSION_KEY = "training:version";
const GAME_PREFIX = "training:game:";
const PUZZLE_PREFIX = "training:card:";
const SETTINGS_KEY = "practice:settings";

export const gameStorageKey = (gameKey) => `${GAME_PREFIX}${gameKey}`;
export const puzzleStorageKey = (id) => `${PUZZLE_PREFIX}${id}`;

export class TrainingVersionError extends Error {
  constructor() {
    super("Saved practice data is from a newer version of ChessBot.");
    this.name = "TrainingVersionError";
  }
}

/** All saved practice data. `writable` is false when a newer version of ChessBot wrote it. */
export async function loadTraining(area) {
  const all = await area.get(null);
  const version = Number(all[VERSION_KEY] ?? TRAINING_VERSION);
  const games = new Map();
  const puzzles = new Map();
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(GAME_PREFIX)) games.set(value.gameKey, value);
    else if (key.startsWith(PUZZLE_PREFIX)) puzzles.set(value.id, value);
  }
  return { version, writable: version <= TRAINING_VERSION, games, puzzles, settings: { ...(all[SETTINGS_KEY] ?? {}) } };
}

async function assertWritable(area) {
  const stored = (await area.get(VERSION_KEY))[VERSION_KEY];
  if (Number(stored ?? TRAINING_VERSION) > TRAINING_VERSION) throw new TrainingVersionError();
}

/** Save one reviewed game and its puzzles, delete puzzles that no longer qualify, then prune old games. */
export async function saveReview(area, { game, puzzles, removedIds = [] }) {
  await assertWritable(area);
  const entries = { [VERSION_KEY]: TRAINING_VERSION, [gameStorageKey(game.gameKey)]: game };
  for (const puzzle of puzzles) entries[puzzleStorageKey(puzzle.id)] = puzzle;
  await area.set(entries);
  if (removedIds.length) await area.remove(removedIds.map(puzzleStorageKey));
  await pruneGames(area);
}

export async function savePuzzle(area, puzzle) {
  await assertWritable(area);
  await area.set({ [puzzleStorageKey(puzzle.id)]: puzzle });
}

export async function saveSettings(area, settings) {
  await area.set({ [SETTINGS_KEY]: settings });
}

/** Above `limit` games, remove the oldest games and their mastered puzzles. Unmastered puzzles stay. */
export async function pruneGames(area, limit = MAX_GAMES) {
  const { games, puzzles } = await loadTraining(area);
  if (games.size <= limit) return [];
  const dropped = [...games.values()].sort((a, b) => a.reviewedAt - b.reviewedAt)
    .slice(0, games.size - limit).map((game) => game.gameKey);
  const droppedSet = new Set(dropped);
  const keys = dropped.map(gameStorageKey);
  for (const puzzle of puzzles.values()) {
    if (droppedSet.has(puzzle.gameKey) && puzzle.schedule.mastered) keys.push(puzzleStorageKey(puzzle.id));
  }
  await area.remove(keys);
  return dropped;
}

/**
 * A stable game identity: `chesscom:<id>` for Chess.com games, otherwise `pgn:` and the first 16 hex
 * characters of SHA-256 over the starting FEN and the UCI moves, so headers and comments don't matter.
 */
export async function gameKeyFor({ gameId, initialFen, history }) {
  if (/^\d+$/.test(String(gameId ?? ""))) return `chesscom:${gameId}`;
  const bytes = new TextEncoder().encode(`${initialFen} ${history.join(" ")}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `pgn:${hex.slice(0, 16)}`;
}

/** A `storage.local` stand-in over Web Storage, for pages opened outside the extension. */
export function webStorageArea(storage) {
  const read = (key) => {
    const raw = storage.getItem(key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  return {
    async get(keys) {
      const list = keys === null || keys === undefined
        ? Array.from({ length: storage.length }, (_, index) => storage.key(index))
        : [].concat(keys);
      const result = {};
      for (const key of list) {
        const value = read(key);
        if (value !== undefined) result[key] = value;
      }
      return result;
    },
    async set(entries) {
      for (const [key, value] of Object.entries(entries)) storage.setItem(key, JSON.stringify(value));
    },
    async remove(keys) {
      for (const key of [].concat(keys)) storage.removeItem(key);
    },
  };
}
