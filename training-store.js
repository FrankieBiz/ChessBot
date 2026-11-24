// Saved practice data. Each game and each puzzle has its own storage key, so the review page and a
// Practice page can save at the same time without overwriting each other's records.
// Storage is bounded: at most MAX_GAMES games, plus at most MAX_ORPHAN_PUZZLES unmastered puzzles whose
// game was pruned (mastered orphans are removed), which stays well inside Chrome's 10 MB quota.
export const TRAINING_VERSION = 1;
export const MAX_GAMES = 300;
export const MAX_ORPHAN_PUZZLES = 500;

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

// True when the stored version is absent or a number this build understands.
const isWritableVersion = (stored) => stored === undefined || stored === null
  || (typeof stored === "number" && Number.isFinite(stored) && stored <= TRAINING_VERSION);

/** All saved practice data. `writable` is false when a newer version of ChessBot wrote it. */
export async function loadTraining(area) {
  const all = await area.get(null);
  const version = all[VERSION_KEY] ?? TRAINING_VERSION;
  const games = new Map();
  const puzzles = new Map();
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(GAME_PREFIX)) {
      if (value && typeof value === "object" && typeof value.gameKey === "string") games.set(value.gameKey, value);
    } else if (key.startsWith(PUZZLE_PREFIX)) {
      if (value && typeof value === "object" && typeof value.id === "string"
        && value.schedule && typeof value.schedule === "object") puzzles.set(value.id, value);
    }
  }
  return { version, writable: isWritableVersion(all[VERSION_KEY]), games, puzzles, settings: { ...(all[SETTINGS_KEY] ?? {}) } };
}

async function assertWritable(area) {
  const stored = (await area.get(VERSION_KEY))[VERSION_KEY];
  if (!isWritableVersion(stored)) throw new TrainingVersionError();
}

/** Save one reviewed game and its puzzles, delete puzzles that no longer qualify, then prune old games. */
export async function saveReview(area, { game, puzzles, removedIds = [] }) {
  await assertWritable(area);
  const entries = { [VERSION_KEY]: TRAINING_VERSION, [gameStorageKey(game.gameKey)]: game };
  for (const puzzle of puzzles) entries[puzzleStorageKey(puzzle.id)] = puzzle;
  await area.set(entries);
  if (removedIds.length) await area.remove(removedIds.map(puzzleStorageKey));
  try {
    await pruneGames(area);
  } catch {
    // Pruning is best-effort; the review itself is saved.
  }
}

/**
 * Save one puzzle's schedule (a newer re-review's analysis is kept). Throws TrainingVersionError if newer data is stored. Returns false without writing when
 * the puzzle's key no longer exists (a re-review removed it), otherwise writes the schedule and returns true.
 */
export async function savePuzzle(area, puzzle) {
  const key = puzzleStorageKey(puzzle.id);
  const stored = await area.get([VERSION_KEY, key]);
  if (!isWritableVersion(stored[VERSION_KEY])) throw new TrainingVersionError();
  if (!(key in stored)) return false;
  await area.set({ [key]: { ...stored[key], schedule: puzzle.schedule } });
  return true;
}

export async function saveSettings(area, settings) {
  await assertWritable(area);
  await area.set({ [SETTINGS_KEY]: settings });
}

/**
 * Keep at most `limit` games (the oldest are dropped; a game without `reviewedAt` counts as oldest). Puzzles
 * whose game is not kept are orphans: mastered orphans are removed, and at most `orphanLimit` unmastered
 * orphans stay (oldest by `createdAt`, then `id`, go first). Returns the dropped game keys.
 */
export async function pruneGames(area, limit = MAX_GAMES, orphanLimit = MAX_ORPHAN_PUZZLES) {
  const { games, puzzles } = await loadTraining(area);
  const sorted = [...games.values()].sort((a, b) => (a.reviewedAt ?? 0) - (b.reviewedAt ?? 0));
  const dropped = sorted.slice(0, Math.max(0, games.size - limit)).map((game) => game.gameKey);
  const keptKeys = new Set(sorted.map((game) => game.gameKey).filter((key) => !dropped.includes(key)));
  const keys = dropped.map(gameStorageKey);
  const unmastered = [];
  for (const puzzle of puzzles.values()) {
    if (keptKeys.has(puzzle.gameKey)) continue;
    if (puzzle.schedule.mastered) keys.push(puzzleStorageKey(puzzle.id));
    else unmastered.push(puzzle);
  }
  unmastered.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const puzzle of unmastered.slice(0, Math.max(0, unmastered.length - orphanLimit))) keys.push(puzzleStorageKey(puzzle.id));
  if (keys.length) await area.remove(keys);
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
      // A quota error partway through can leave some keys written (only used outside the extension).
      for (const [key, value] of Object.entries(entries)) storage.setItem(key, JSON.stringify(value));
    },
    async remove(keys) {
      for (const key of [].concat(keys)) storage.removeItem(key);
    },
  };
}
