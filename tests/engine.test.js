import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyMove, computeProGameAccuracy, parseUciInfoLine, StockfishEngine } from '../engine.js';

const move = {
  playedUci: 'e2e4', bestMoveUci: 'e2e4', winBefore: 61, winAfter: 61,
  secondScore: 42, legalMoves: 2, plyIndex: 10, confirmed: true,
};

test('WDL is converted to White perspective and retains draw value', () => {
  const line = parseUciInfoLine('info depth 14 multipv 3 score cp 28 wdl 160 800 40 pv e7e5', 'b');
  assert.equal(line.multipv, 3);
  assert.deepEqual(line.eval, { type: 'cp', value: -28 });
  assert.deepEqual(line.wdl, { win: 40, draw: 800, loss: 160 });
  assert.equal(line.winWhite, 44);
  assert.equal(parseUciInfoLine('info depth 14 score cp 28 lowerbound pv e7e5'), null);
});

test('a forced move cannot earn a Great or Brilliant label', () => {
  assert.equal(classifyMove({ ...move, legalMoves: 1, isSacrifice: true }).key, 'best');
});

test('only-move praise requires a confirmed comparison that crosses a meaningful threshold', () => {
  assert.equal(classifyMove(move).key, 'great');
  assert.equal(classifyMove({ ...move, confirmed: false }).key, 'best');
  assert.equal(classifyMove({ ...move, winBefore: 98, winAfter: 98, secondScore: 75 }).key, 'best');
});

test('a missed opportunity is a Miss at the Mistake boundary', () => {
  assert.equal(classifyMove({ ...move, playedUci: 'a2a3', winBefore: 75, winAfter: 55, prevOpponentWinLoss: 28 }).key, 'miss');
});

test('a loss beyond the Mistake boundary is a Blunder after an opponent error', () => {
  const missedOpportunity = { ...move, playedUci: 'a2a3', winBefore: 75, prevOpponentWinLoss: 28 };
  assert.equal(classifyMove({ ...missedOpportunity, winAfter: 54.9 }).key, 'blunder');
  assert.equal(classifyMove({ ...missedOpportunity, winAfter: 35 }).key, 'blunder');
});

test('a WDL loss on a grade boundary stays in that grade', () => {
  for (const [winAfter, key] of [[61.15, 'excellent'], [59.15, 'good'], [54.15, 'inaccuracy']]) {
    assert.equal(classifyMove({ ...move, playedUci: 'a2a3', winBefore: 64.15, winAfter }).key, key);
  }
  assert.equal(classifyMove({ ...move, playedUci: 'a2a3', winBefore: 50.2, winAfter: 30.2 }).key, 'mistake');
});

test('volatility uses full opening windows and a zero counts as 1% in the harmonic mean', () => {
  // Weighted mean 0, harmonic mean 1 / (1 / max(1, 0)) = 1, as in Lichess.
  assert.equal(computeProGameAccuracy([50, 20], [{ ply: 1, accuracy: 0 }]), 0.5);
  const timeline = [50, 50, 90, ...Array(28).fill(90)];
  assert.equal(computeProGameAccuracy(timeline, [{ ply: 1, accuracy: 80 }, { ply: 2, accuracy: 40 }]), 56.7);
});

test('one zero-accuracy move does not wipe out the harmonic half of a game', () => {
  const timeline = Array.from({ length: 60 }, (_, i) => 50 + 30 * Math.sin(i / 6));
  const moves = (worst) => Array.from({ length: 25 }, (_, k) => ({ ply: 2 + 2 * k, accuracy: k === 12 ? worst : 90 }));
  const zero = computeProGameAccuracy(timeline, moves(0));
  // Anything below 1% is treated as 1%, so a near-zero move and a zero move score the same.
  assert.equal(zero, computeProGameAccuracy(timeline, moves(1)));
  assert.equal(computeProGameAccuracy(timeline, moves(0.07)), zero);
  // The harmonic half is 25 / (24 / 90 + 1) ≈ 19.7 rather than 0, so one zero no longer caps the game at 50%.
  assert.equal(zero, 53);
});

test('worker searches are serialized and MultiPV candidates share the same completed depth', async () => {
  const originalWorker = globalThis.Worker;
  const commands = [];
  class TestWorker {
    postMessage(command) {
      commands.push(command);
      const emit = (data) => this.onmessage?.({ data });
      if (command === 'uci') queueMicrotask(() => emit('uciok'));
      if (command === 'isready') queueMicrotask(() => emit('readyok'));
      if (command.startsWith('go ')) queueMicrotask(() => {
        emit('info depth 8 multipv 1 score cp 30 wdl 100 900 0 pv e2e4');
        emit('info depth 8 multipv 2 score cp 20 wdl 50 950 0 pv d2d4');
        emit('info depth 9 multipv 1 score cp 40 wdl 120 880 0 pv e2e4');
        emit('info depth 8 multipv 2 score cp 10 wdl 30 960 10 pv c2c4');
        emit('bestmove e2e4');
      });
    }
    terminate() {}
  }
  globalThis.Worker = TestWorker;
  const engine = new StockfishEngine('stockfish.js');
  try {
    await engine.startNewGame();
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const [first, second] = await Promise.all([
      engine.analyzePosition(fen, 9),
      engine.analyzePosition(fen, 9, { initialFen: fen, history: ['g1f3', 'g8f6', 'f3g1', 'f6g8'] }),
    ]);
    assert.equal(first.depth, 8);
    assert.deepEqual(first.lines.map((line) => line.pv[0]), ['e2e4', 'd2d4']);
    assert.equal(second.depth, 8);
    assert.equal(commands.filter((command) => command === 'uci').length, 1);
    assert.ok(commands.includes('setoption name UCI_ShowWDL value true'));
    assert.ok(commands.indexOf('ucinewgame') < commands.findIndex((command) => command.startsWith('position fen')));
    assert.ok(commands.includes('ucinewgame'));
    assert.ok(commands.includes(`position fen ${fen} moves g1f3 g8f6 f3g1 f6g8`));
    assert.equal(commands.filter((command) => command === 'go depth 9 nodes 63640').length, 2);
  } finally {
    engine.terminate();
    globalThis.Worker = originalWorker;
  }
});

test('the deepest complete batch can have a different leader than a later partial batch', async () => {
  const engine = new StockfishEngine('stockfish.js');
  engine.worker = { postMessage() {}, terminate() {} };
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const search = engine.search(fen, 10);
  try {
    for (const message of [
      'info depth 8 multipv 1 score cp 30 pv e2e4',
      'info depth 8 multipv 2 score cp 20 pv d2d4',
      'info depth 9 multipv 1 score cp 35 pv d2d4',
      'info depth 9 multipv 2 score cp 22 pv e2e4',
      'info depth 10 multipv 1 score cp 40 pv e2e4',
      'bestmove e2e4',
    ]) engine.request.onLine(message);
    const result = await search;
    assert.equal(result.depth, 9);
    assert.deepEqual(result.lines.map(({ pv }) => pv[0]), ['d2d4', 'e2e4']);
  } finally {
    engine.terminate();
  }
});

test('an explicit node limit reaches UCI and invalid budgets are rejected', async () => {
  const engine = new StockfishEngine('stockfish.js');
  const commands = [];
  engine.worker = { postMessage: (command) => commands.push(command), terminate() {} };
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  for (const nodes of [0, 4_000_001, 'bad']) {
    assert.throws(() => engine.search(fen, 20, { nodes }), RangeError);
  }
  const search = engine.search(fen, 20, { multiPv: 1, nodes: 1_250_000 });
  try {
    engine.request.onLine('info depth 10 score cp 40 pv e2e4');
    engine.request.onLine('bestmove e2e4');
    await search;
    assert.equal(commands.at(-1), 'go depth 20 nodes 1250000');
  } finally {
    engine.terminate();
  }
});

test('a slow search that keeps reporting finishes, and a silent one times out', async (t) => {
  const originalWorker = globalThis.Worker;
  let silent = false;
  let worker;
  class SlowWorker {
    constructor() { worker = this; }
    postMessage(command) {
      const emit = (data) => this.onmessage?.({ data });
      if (command === 'uci') queueMicrotask(() => emit('uciok'));
      if (command === 'isready') queueMicrotask(() => emit('readyok'));
    }
    terminate() {}
  }
  globalThis.Worker = SlowWorker;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const engine = new StockfishEngine('stockfish.js');
  try {
    await engine.init();
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const emit = (data) => worker.onmessage?.({ data });
    // Output every 30 seconds keeps a 90-second search alive.
    const slow = engine.analyzePosition(fen, 9, { multiPv: 1 });
    await new Promise((resolve) => queueMicrotask(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    for (let second = 30; second <= 90; second += 30) {
      t.mock.timers.tick(30_000);
      emit(`info depth ${second / 10} multipv 1 score cp 30 wdl 100 900 0 pv e2e4`);
    }
    emit('bestmove e2e4');
    assert.equal((await slow).depth, 9);

    silent = true;
    const stuck = engine.analyzePosition(fen, 9, { multiPv: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(45_000);
    await assert.rejects(stuck, /timed out/);
    assert.ok(silent);
  } finally {
    engine.terminate();
    globalThis.Worker = originalWorker;
  }
});
