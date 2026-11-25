import assert from "node:assert/strict";
import { test } from "node:test";
import { EnginePool } from "../engine-pool.js";
import { runReview } from "../review-run.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeEngine(log) {
  return {
    ready: true,
    async startNewGame() { log.push("new game"); },
    terminate() {}, abort() {},
  };
}

// Even plies need deeper passes.
function fakeAnalysis(log) {
  return {
    async analyzeGamePosition(engine, position) {
      log.push(`root ${position.index}`);
      await tick();
      return { index: position.index };
    },
    async quickDecision(engine, before, after, depth, root) {
      assert.equal(root.index, before.index);
      log.push(`quick ${after.index}`);
      const needsRefinement = after.index % 2 === 0;
      return { comparison: { ply: after.index, deep: false }, needsRefinement };
    },
    async finishDecision(engine, before, after, depth, quick) {
      log.push(`deep ${after.index}`);
      await tick();
      return { ...quick.comparison, deep: true };
    },
  };
}

const positions = Array.from({ length: 5 }, (_, index) => ({ index }));

test("every position gets a root, every move a quick result, then the deeper checks run", async () => {
  const log = [];
  const roots = [];
  const quick = [];
  const finals = new Map();
  const pool = new EnginePool(() => fakeEngine(log), 1, fakeEngine(log));
  await runReview({
    positions, depth: 16, pool, analysis: fakeAnalysis(log),
    onRoot: (index, root) => roots.push([index, root.index]),
    onQuick: (ply, result) => quick.push([ply, result.needsRefinement]),
    onFinal: (ply, comparison) => {
      assert.ok(!finals.has(ply), `ply ${ply} finished twice`);
      finals.set(ply, comparison.deep);
    },
  });
  assert.deepEqual(roots, [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]);
  assert.deepEqual(quick, [[1, false], [2, true], [3, false], [4, true]]);
  assert.deepEqual([...finals].sort(([a], [b]) => a - b), [[1, false], [2, true], [3, false], [4, true]]);
  const steps = log.filter((line) => line !== "new game");
  const firstDeep = steps.findIndex((line) => line.startsWith("deep"));
  // The whole quick phase, then the deeper check for ply 2 repeats its quick searches before going deeper.
  assert.deepEqual(steps.slice(0, firstDeep + 1), [
    "root 0", "quick 1", "root 1", "quick 2", "root 2", "quick 3", "root 3", "quick 4", "root 4",
    "root 1", "quick 2", "deep 2",
  ]);
  // Each of the 5 quick tasks and 2 deeper tasks starts with an empty hash table.
  assert.equal(log.filter((line) => line === "new game").length, 7);
});

test("a cancelled review stops scheduling work", async () => {
  const log = [];
  let cancelled = false;
  const finals = [];
  const pool = new EnginePool(() => fakeEngine(log), 1, fakeEngine(log));
  await runReview({
    positions, depth: 16, pool, analysis: fakeAnalysis(log), isCancelled: () => cancelled,
    onRoot: () => { cancelled = true; },
    onFinal: (ply) => finals.push(ply),
  });
  assert.deepEqual(finals, []);
  assert.ok(!log.includes("root 1"));
});

test("a failed search rejects the review", async () => {
  const log = [];
  const analysis = { ...fakeAnalysis(log), async quickDecision() { throw new Error("no comparison"); } };
  const pool = new EnginePool(() => fakeEngine(log), 2, fakeEngine(log));
  await assert.rejects(runReview({ positions, depth: 16, pool, analysis }), /no comparison/);
});
