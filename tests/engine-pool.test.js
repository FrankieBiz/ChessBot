import assert from "node:assert/strict";
import { test } from "node:test";
import { EnginePool, enginePoolSize } from "../engine-pool.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeEngine(name, { failsToStart = false } = {}) {
  return {
    name, ready: false, terminated: false, aborted: false,
    async init() {
      if (failsToStart) throw new Error("out of memory");
      this.ready = true;
    },
    terminate() { this.terminated = true; this.ready = false; },
    abort() { this.aborted = true; this.ready = false; },
  };
}

test("the pool uses half the cores, at most four, and fewer engines on low-memory devices", () => {
  assert.equal(enginePoolSize({ cores: 8 }), 4);
  assert.equal(enginePoolSize({ cores: 16 }), 4);
  assert.equal(enginePoolSize({ cores: 6 }), 3);
  assert.equal(enginePoolSize({ cores: 2 }), 1);
  assert.equal(enginePoolSize({}), 1);
  assert.equal(enginePoolSize({ cores: 8, memoryGB: 8 }), 4);
  assert.equal(enginePoolSize({ cores: 8, memoryGB: 4 }), 2);
  assert.equal(enginePoolSize({ cores: 8, memoryGB: 2 }), 1);
});

test("tasks start in queue order and never share an engine", async () => {
  let made = 0;
  const pool = new EnginePool(() => fakeEngine(`extra-${++made}`), 3, fakeEngine("primary"));
  const started = [];
  const busy = new Set();
  let most = 0;
  const results = await Promise.all(Array.from({ length: 7 }, (_, index) => pool.run(async (engine) => {
    assert.ok(!busy.has(engine), "an engine ran two tasks at once");
    busy.add(engine);
    most = Math.max(most, busy.size);
    started.push(index);
    await tick();
    busy.delete(engine);
    return index * 2;
  })));
  assert.deepEqual(results, [0, 2, 4, 6, 8, 10, 12]);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(most, 3);
});

test("close frees the extra engines and keeps the primary one", () => {
  const primary = fakeEngine("primary");
  const pool = new EnginePool(() => fakeEngine("extra"), 3, primary);
  const [, ...extras] = pool.engines;
  pool.close();
  assert.ok(extras.every(({ terminated }) => terminated));
  assert.equal(primary.terminated, false);
  assert.equal(primary.aborted, false);
});

test("abort stops every engine and rejects tasks still waiting", async () => {
  const primary = fakeEngine("primary");
  const pool = new EnginePool(() => fakeEngine("extra"), 1, primary);
  let release;
  const running = pool.run(() => new Promise((resolve) => { release = resolve; }));
  const waiting = pool.run(async () => "never");
  await tick();
  pool.abort();
  release("done");
  assert.equal(await running, "done");
  await assert.rejects(waiting, /cancelled/);
  assert.equal(primary.aborted, true);
  await assert.rejects(pool.run(async () => 1), /cancelled/);
});

test("an extra engine that cannot start leaves the pool and its task runs elsewhere", async () => {
  const broken = fakeEngine("broken", { failsToStart: true });
  const pool = new EnginePool(() => broken, 2, fakeEngine("primary"));
  const ran = [];
  const results = await Promise.all([1, 2].map((value) => pool.run(async (engine) => {
    ran.push(engine.name);
    await tick();
    return value;
  })));
  assert.deepEqual(results, [1, 2]);
  assert.deepEqual(ran, ["primary", "primary"]);
  assert.equal(pool.size, 1);
  assert.equal(broken.terminated, true);
});

test("a task error from a working engine reaches the caller", async () => {
  const pool = new EnginePool(() => fakeEngine("extra"), 2, fakeEngine("primary"));
  await assert.rejects(pool.run(async () => { throw new Error("search failed"); }), /search failed/);
  assert.equal(await pool.run(async () => "still works"), "still works");
});

test("a task whose engine fails after starting is not run again", async () => {
  const pool = new EnginePool(() => fakeEngine("extra"), 2, fakeEngine("primary"));
  let attempts = 0;
  const crash = pool.run(async (engine) => {
    attempts++;
    engine.terminate();
    throw new Error("worker crashed");
  });
  await assert.rejects(crash, /worker crashed/);
  assert.equal(attempts, 1);
});

test("a primary engine that cannot start rejects its task", async () => {
  const pool = new EnginePool(() => fakeEngine("extra"), 1, fakeEngine("primary", { failsToStart: true }));
  await assert.rejects(pool.run(async () => "never"), /out of memory/);
});


test("a priority task goes ahead of waiting review tasks, behind earlier priority tasks", async () => {
  const pool = new EnginePool(() => fakeEngine("extra"), 1, fakeEngine("primary"));
  const order = [];
  let release;
  const first = pool.run(() => new Promise((resolve) => { release = resolve; }));
  const queued = [
    pool.run(async () => order.push("review 1")),
    pool.run(async () => order.push("review 2")),
    pool.run(async () => order.push("player 1"), { priority: true }),
    pool.run(async () => order.push("player 2"), { priority: true }),
  ];
  await tick();
  release();
  await Promise.all([first, ...queued]);
  assert.deepEqual(order, ["player 1", "player 2", "review 1", "review 2"]);
});
