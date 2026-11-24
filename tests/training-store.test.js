import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_GAMES, TRAINING_VERSION, TrainingVersionError, gameKeyFor, loadTraining, pruneGames, savePuzzle, saveReview,
  saveSettings, webStorageArea,
} from "../training-store.js";

class MemoryArea {
  constructor(initial = {}) {
    this.data = structuredClone(initial);
  }

  async get(keys) {
    if (keys === null) return structuredClone(this.data);
    const list = [].concat(keys).filter((key) => key in this.data);
    return structuredClone(Object.fromEntries(list.map((key) => [key, this.data[key]])));
  }

  async set(entries) {
    Object.assign(this.data, structuredClone(entries));
  }

  async remove(keys) {
    for (const key of [].concat(keys)) delete this.data[key];
  }
}

const gameRecord = (gameKey, reviewedAt) => ({ gameKey, reviewedAt, pgn: "1. e4 *" });
const savedPuzzle = (id, gameKey, mastered = false) => ({
  id, gameKey, schedule: { step: 0, due: mastered ? null : "2026-11-25", mastered },
});

test("a reviewed game and each of its puzzles are stored under their own keys", async () => {
  const area = new MemoryArea({ boardTheme: "slate" });
  await saveReview(area, { game: gameRecord("g1", 1), puzzles: [savedPuzzle("g1:5", "g1"), savedPuzzle("g1:9", "g1")] });
  assert.deepEqual(Object.keys(area.data).sort(), [
    "boardTheme", "training:card:g1:5", "training:card:g1:9", "training:game:g1", "training:version",
  ]);
  const data = await loadTraining(area);
  assert.equal(data.version, TRAINING_VERSION);
  assert.equal(data.writable, true);
  assert.deepEqual([...data.games.keys()], ["g1"]);
  assert.deepEqual([...data.puzzles.keys()].sort(), ["g1:5", "g1:9"]);
  assert.deepEqual(data.settings, {});
});

test("saving a game again deletes puzzles that no longer qualify", async () => {
  const area = new MemoryArea();
  await saveReview(area, { game: gameRecord("g1", 1), puzzles: [savedPuzzle("g1:5", "g1"), savedPuzzle("g1:9", "g1")] });
  await saveReview(area, { game: gameRecord("g1", 1), puzzles: [savedPuzzle("g1:5", "g1")], removedIds: ["g1:9"] });
  assert.deepEqual([...(await loadTraining(area)).puzzles.keys()], ["g1:5"]);
});

test("two pages saving different puzzles from stale copies keep both changes", async () => {
  const area = new MemoryArea();
  await saveReview(area, { game: gameRecord("g1", 1), puzzles: [savedPuzzle("g1:5", "g1"), savedPuzzle("g1:9", "g1")] });
  const reviewTab = await loadTraining(area);
  const practiceTab = await loadTraining(area);
  await savePuzzle(area, { ...practiceTab.puzzles.get("g1:5"), schedule: { step: 1, due: "2026-11-28", mastered: false } });
  await savePuzzle(area, { ...reviewTab.puzzles.get("g1:9"), schedule: { step: 2, due: "2026-12-01", mastered: false } });
  const { puzzles } = await loadTraining(area);
  assert.equal(puzzles.get("g1:5").schedule.step, 1);
  assert.equal(puzzles.get("g1:9").schedule.step, 2);
});

test("data written by a newer version is read-only", async () => {
  const area = new MemoryArea({ "training:version": TRAINING_VERSION + 1 });
  assert.equal((await loadTraining(area)).writable, false);
  await assert.rejects(saveReview(area, { game: gameRecord("g1", 1), puzzles: [] }), TrainingVersionError);
  await assert.rejects(savePuzzle(area, savedPuzzle("g1:5", "g1")), TrainingVersionError);
  assert.deepEqual(Object.keys(area.data), ["training:version"]);
});

test("pruning drops the oldest games and their mastered puzzles but keeps unmastered ones", async () => {
  const area = new MemoryArea({
    "training:game:old": gameRecord("old", 1),
    "training:game:mid": gameRecord("mid", 2),
    "training:game:new": gameRecord("new", 3),
    "training:card:old:5": savedPuzzle("old:5", "old", true),
    "training:card:old:9": savedPuzzle("old:9", "old", false),
    "training:card:mid:5": savedPuzzle("mid:5", "mid", true),
  });
  assert.deepEqual(await pruneGames(area, 2), ["old"]);
  const { games, puzzles } = await loadTraining(area);
  assert.deepEqual([...games.keys()].sort(), ["mid", "new"]);
  assert.deepEqual([...puzzles.keys()].sort(), ["mid:5", "old:9"]);
});

test(`saving a review keeps at most ${MAX_GAMES} games`, async () => {
  const entries = {};
  for (let i = 0; i < MAX_GAMES; i++) entries[`training:game:g${i}`] = gameRecord(`g${i}`, i + 1);
  const area = new MemoryArea(entries);
  await saveReview(area, { game: gameRecord("latest", MAX_GAMES + 1), puzzles: [] });
  const { games } = await loadTraining(area);
  assert.equal(games.size, MAX_GAMES);
  assert.equal(games.has("g0"), false);
  assert.equal(games.has("latest"), true);
});

test("a game is identified by its Chess.com ID or by a fingerprint of its moves", async () => {
  const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  assert.equal(await gameKeyFor({ gameId: "123456789", initialFen: start, history: ["e2e4"] }), "chesscom:123456789");
  const pasted = await gameKeyFor({ gameId: "manual-1", initialFen: start, history: ["e2e4", "e7e5"] });
  assert.match(pasted, /^pgn:[0-9a-f]{16}$/);
  assert.equal(await gameKeyFor({ gameId: "manual-2", initialFen: start, history: ["e2e4", "e7e5"] }), pasted);
  assert.notEqual(await gameKeyFor({ gameId: null, initialFen: start, history: ["d2d4", "e7e5"] }), pasted);
});

test("settings are saved under their own key", async () => {
  const area = new MemoryArea();
  await saveSettings(area, { dailyCap: 30 });
  assert.deepEqual((await loadTraining(area)).settings, { dailyCap: 30 });
});

test("pages opened outside the extension keep the same data in Web Storage", async () => {
  const backing = new Map([["unrelated", "not json"]]);
  const storage = {
    get length() { return backing.size; },
    key: (index) => [...backing.keys()][index] ?? null,
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => backing.set(key, String(value)),
    removeItem: (key) => backing.delete(key),
  };
  const area = webStorageArea(storage);
  await saveReview(area, { game: gameRecord("g1", 1), puzzles: [savedPuzzle("g1:5", "g1")] });
  const data = await loadTraining(area);
  assert.equal(data.games.get("g1").pgn, "1. e4 *");
  assert.deepEqual([...data.puzzles.keys()], ["g1:5"]);
  assert.deepEqual(await area.get("training:version"), { "training:version": TRAINING_VERSION });
  await area.remove("training:card:g1:5");
  assert.equal(backing.has("training:card:g1:5"), false);
});
