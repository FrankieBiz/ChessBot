import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeDecision, compareRootMoves, deepCheckDecision, parseReviewGame, scoreDecision } from '../analysis.js';
import { StockfishEngine, cpToWinProbability, summarizeLines, winLossToAccuracy } from '../engine.js';

// Grades now use the same Lichess win-probability curve as accuracy, so derive winWhite from cp.
const line = (uci, _winWhite, cp, depth = 14, continuation = []) => ({
  pv: [uci, ...continuation], winWhite: cpToWinProbability(cp), eval: { type: 'cp', value: cp }, depth,
});

test('PGN replay honors Black-to-move setup positions and actual mate', () => {
  const pgn = '[SetUp "1"]\n[FEN "8/8/8/8/8/5kq1/8/7K b - - 0 19"]\n[Result "0-1"]\n\n19... Qg2# 0-1';
  const { positions } = parseReviewGame(pgn);
  assert.match(positions[0].fen, / b /);
  assert.equal(positions[1].move.uci, 'g3g2');
  assert.deepEqual(positions[1].terminal.wdl, { win: 0, draw: 0, loss: 1000 });
});

test('a claimable repetition retains its history without ending an ongoing game', () => {
  const { positions } = parseReviewGame('1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 5. e4 *');
  assert.equal(positions[8].terminal, null);
  assert.equal(positions[8].searchOptions.history.length, 8);
});

test('outside the top two, the root comparison searches both leaders and the played move together', async () => {
  const { positions } = parseReviewGame('1. a3 *');
  const root = summarizeLines([line('e2e4', 61, 55), line('d2d4', 58, 45)], 'w');
  const engine = { analyzePosition(fen, depth, options) {
    assert.equal(fen, positions[0].fen);
    assert.equal(depth, 14);
    assert.deepEqual(options.searchMoves, ['e2e4', 'd2d4', 'a2a3']);
    assert.equal(options.multiPv, 3);
    return summarizeLines([line('e2e4', 64, 250), line('d2d4', 60, 180), line('a2a3', 52, 50)], 'w');
  } };
  const result = await compareRootMoves(engine, positions[0], 'a2a3', 14, root);
  const scored = scoreDecision(positions[0], positions[1], result, 0);
  assert.ok(Math.abs(scored.winLoss - 16.92) < 0.02);
  assert.equal(scored.cpLoss, 200);
  assert.equal(scored.classification.key, 'mistake');
});

test('the top move scores 100 even when a separate next-position search would swing', () => {
  const { positions } = parseReviewGame('1. e4 *');
  const best = line('e2e4', 62, 65);
  const root = summarizeLines([best, line('d2d4', 51, 6)], 'w');
  const scored = scoreDecision(positions[0], positions[1], { root, played: best }, 0);
  assert.equal(scored.accuracy, 100);
  assert.equal(scored.cpLoss, 0);
});

test('move grades share the Lichess curve with move accuracy, not Stockfish WDL', () => {
  const { positions } = parseReviewGame('1. a3 *');
  // The same decision reads as a 30.7-point WDL loss but a 10.0-point Lichess loss.
  const best = { pv: ['e2e4'], eval: { type: 'cp', value: 110 }, winWhite: 80.65, depth: 16 };
  const played = { pv: ['a2a3'], eval: { type: 'cp', value: 0 }, winWhite: 50, depth: 16 };
  const root = summarizeLines([best, played], 'w');
  const review = scoreDecision(positions[0], positions[1], { root, played }, 0);
  assert.equal(review.classification.key, 'inaccuracy');
  assert.ok(Math.abs(review.winLoss - 9.989528148674822) < 1e-9);
  assert.equal(review.accuracy, winLossToAccuracy(review.winLoss));
  assert.ok(review.accuracy > 60, `expected a 10-point loss to keep useful accuracy, got ${review.accuracy}`);
  // The human-choice model keeps its own WDL-calibrated loss for its trained coefficients.
  assert.ok(Math.abs(review.modelWinLoss - 30.65) < 1e-9);
});

test('uses the pair of recorded clocks at the resulting position and clears missing clocks', () => {
  const pgn = '[TimeControl "180+2"]\n\n1. e4 {[%clk 0:02:58.5]} e5 {[%clk 0:02:59]} ' +
    '2. Nf3 {[%clk 0:02:53]} Nc6 {[%clk 0:02:55]} 3. Bb5 {[%clk 0:02:51]} a6 {[%clk 0:02:53]} ' +
    '4. Ba4 {[%clk 0:02:48]} Nf6 {Black offers draw} {[%clk 0:02:50.5]} 5. O-O Be7 {[%clk 0:02:42]} *';
  const { positions } = parseReviewGame(pgn);
  assert.deepEqual(positions[8].practicalContext, {
    ply: 8, timeControl: { base: 180, increment: 2 }, whiteSeconds: 168, blackSeconds: 170.5,
  });
  assert.equal(positions[9].practicalContext.whiteSeconds, null);
  assert.equal(positions[10].practicalContext.whiteSeconds, null);
});

test('uses the archive time control when the PGN has no tag', () => {
  const { positions } = parseReviewGame('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *', '300+0');
  assert.deepEqual(positions[8].practicalContext.timeControl, { base: 300, increment: 0 });
});

test('leaves practical points out of the engine accuracy calculation', () => {
  const { positions } = parseReviewGame('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *');
  const best = line('e1g1', 62, 100);
  const played = line('e1f1', 51, 0);
  const root = summarizeLines([best, played], 'w');
  const result = scoreDecision(positions[8], positions[9], { root, played }, 0);
  assert.ok(Math.abs(result.winLoss - 9.1025897192) < 1e-9);
  assert.equal(result.cpLoss, 100);
  assert.ok(result.practicalImpact?.loss > 0);
  assert.equal(result.accuracy,
    scoreDecision(positions[8], { ...positions[9], practicalContext: null }, { root, played }, 0).accuracy);
});

test('retains a valid baseline when a practical-loss recheck cannot compare all candidates', async () => {
  const { positions } = parseReviewGame('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *');
  const before = positions[8];
  const after = positions[9];
  const baseline = summarizeLines([line('e1f1', 100, 850), line('e1g1', 99.8, 600)], 'w');
  const deeperRoot = summarizeLines([line('e1f1', 100, 840, 16), line('b1c3', 99.9, 620, 16)], 'w');
  let calls = 0;
  const engine = { analyzePosition(fen, depth, options) {
    calls++;
    assert.equal(depth, 16);
    return deeperRoot;
  } };
  const comparison = await analyzeDecision(engine, before, after, 14, baseline);
  assert.equal(calls, 2);
  assert.equal(comparison.root, baseline);
  assert.equal(comparison.confirmed, undefined);
});

test('recovers a capped baseline comparison by scoring the best and played moves together', async () => {
  const { positions: [before, after] } = parseReviewGame('1. a3 *');
  const best = line('e2e4', 60, 80);
  const played = line('a2a3', 59, 75);
  const root = summarizeLines([best, line('d2d4', 60, 80)], 'w');
  const searches = [];
  const engine = { analyzePosition(fen, depth, { searchMoves }) {
    searches.push([depth, searchMoves]);
    if (searches.length === 2) return summarizeLines([best, played], 'w');
    return summarizeLines([best], 'w');
  } };
  const comparison = await analyzeDecision(engine, before, after, 14, root);
  assert.deepEqual(searches, [
    [14, ['e2e4', 'd2d4', 'a2a3']], [14, ['e2e4', 'a2a3']], [16, undefined],
  ]);
  assert.deepEqual(comparison.played, played);
  assert.equal(comparison.root.depth, 14);
  assert.equal(comparison.searchConfidence, 'borderline');
});

test('keeps the complete baseline when the deeper shortlist contains only the played move', async () => {
  const { positions: [before, after] } = parseReviewGame('1. a3 *');
  const baseline = summarizeLines([line('e2e4', 63, 110), line('a2a3', 51, 10)], 'w');
  const incomplete = summarizeLines([line('a2a3', 56, 50, 16)], 'w');
  const engine = { analyzePosition() { return incomplete; } };
  const result = await analyzeDecision(engine, before, after, 14, baseline);
  assert.equal(result.root, baseline);
  assert.equal(result.passes.length, 1);
  assert.equal(result.searchConfidence, 'borderline');
});

test('a recheck with no exact result retains the baseline and keeps the Stockfish worker', async () => {
  const { positions: [before, after] } = parseReviewGame('1. a3 *');
  const baseline = summarizeLines([line('e2e4', 63, 110), line('a2a3', 51, 10)], 'w');
  const engine = new StockfishEngine('stockfish.js');
  let goCount = 0;
  let terminated = false;
  const worker = {
    postMessage(command) {
      if (!command.startsWith('go ')) return;
      const message = ++goCount === 1
        ? 'info depth 16 score cp 52 lowerbound pv e2e4' : 'info depth 14 score cp 40 pv e2e4';
      queueMicrotask(() => {
        engine.request.onLine(message);
        engine.request.onLine('bestmove e2e4');
      });
    },
    terminate() { terminated = true; },
  };
  engine.worker = worker;
  engine.ready = true;
  try {
    const result = await analyzeDecision(engine, before, after, 14, baseline);
    assert.equal(result.root, baseline);
    assert.equal(result.searchConfidence, 'borderline');
    assert.equal(engine.worker, worker);
    assert.equal(terminated, false);
    assert.equal((await engine.analyzePosition(before.fen, 14, { multiPv: 1 })).bestMove, 'e2e4');
  } finally {
    engine.terminate();
  }
});

test('marks a grade borderline when a required broad search cannot finish', async () => {
  const { positions: [before, after] } = parseReviewGame('1. a3 *');
  const first = summarizeLines([line('e2e4', 65.4, 200), line('a2a3', 50, 0)], 'w');
  const second = summarizeLines([line('e2e4', 62.1, 150, 16), line('a2a3', 50, 0, 16)], 'w');
  const searches = [];
  const engine = { analyzePosition(fen, depth) {
    searches.push(depth);
    return second;
  } };
  const result = await analyzeDecision(engine, before, after, 14, first);
  assert.deepEqual(searches, [16, 18]);
  assert.equal(result.root, second);
  assert.equal(result.searchConfidence, 'borderline');
});

test('rechecks moves close to a grade threshold and resolves a grade that moved between depths', async () => {
  const { positions } = parseReviewGame('1. a3 *');
  const first = summarizeLines([line('e2e4', 55, 250), line('a2a3', 52.2, 120)], 'w');
  const second = summarizeLines([line('e2e4', 55, 250, 16), line('a2a3', 51.6, 170, 16)], 'w');
  const third = summarizeLines([line('e2e4', 55, 250, 18), line('a2a3', 51.5, 170, 18),
    line('d2d4', 50, 160, 18)], 'w');
  const searches = [];
  const engine = { analyzePosition(fen, depth, opts) {
    searches.push([depth, opts.multiPv]);
    return searches.length === 1 ? second : third;
  } };
  const result = await analyzeDecision(engine, positions[0], positions[1], 14, first);
  assert.deepEqual(searches, [[16, 2], [18, 3]]);
  assert.equal(result.root.depth, 18);
  assert.equal(result.searchConfidence, 'stable');
});

test('does not confirm special praise when the winning gap disappears at the next depth', async () => {
  const { positions } = parseReviewGame('1. e4 *');
  const first = summarizeLines([line('e2e4', 67, 250), line('d2d4', 41, -200)], 'w');
  const second = summarizeLines([line('e2e4', 61, 250, 16), line('d2d4', 57, 200, 16)], 'w');
  const third = summarizeLines([line('e2e4', 61, 250, 18), line('d2d4', 59, 200, 18),
    line('c2c4', 57, 180, 18)], 'w');
  let calls = 0;
  const engine = { analyzePosition() { return calls++ === 0 ? second : third; } };
  const comparison = await analyzeDecision(engine, positions[0], positions[1], 14, first);
  const result = scoreDecision(positions[0], positions[1], comparison, 0);
  assert.equal(calls, 2);
  assert.equal(result.classification.key, 'best');
  assert.equal(comparison.confirmed, false);
});

test('an equally evaluated alternative earns Best without sole-move praise', () => {
  const { positions } = parseReviewGame('1. d4 *');
  const best = line('e2e4', 54, 32);
  const played = line('d2d4', 54, 32);
  const root = summarizeLines([best, played], 'w');
  const review = scoreDecision(positions[0], positions[1], { root, played, confirmed: true }, 0);
  assert.equal(review.classification.key, 'best');
  assert.equal(review.accuracy, 100);
});

test('checks a Miss with the same opponent move context used by the final grade', async () => {
  const { positions } = parseReviewGame('1. a3 *');
  const first = summarizeLines([line('e2e4', 64, 160), line('a2a3', 51, 40)], 'w');
  const second = summarizeLines([line('e2e4', 66, 180, 16), line('a2a3', 53, 40, 16)], 'w');
  const third = summarizeLines([line('e2e4', 66.2, 185, 18), line('a2a3', 53, 40, 18),
    line('c2c4', 51, 35, 18)], 'w');
  let searches = 0;
  const engine = { analyzePosition() { return searches++ === 0 ? second : third; } };
  const result = await analyzeDecision(engine, positions[0], positions[1], 14, first, 20);
  assert.equal(searches, 2);
  assert.equal(result.searchConfidence, 'stable');
  assert.equal(scoreDecision(positions[0], positions[1], result, 20).classification.key, 'miss');
});

test('keeps clock annotations and later moves after a PGN line comment with braces', () => {
  const pgn = '[TimeControl "300"]\n\n1. e4 ; note {literal braces}\n{[%clk 0:04:59]} e5 2. Nf3 Nc6 *';
  const { positions } = parseReviewGame(pgn);
  assert.equal(positions.length, 5);
  assert.equal(positions[1].practicalContext.whiteSeconds, 299);
});

test('the broad pass runs when the label is at risk and skips stable same-grade drift', async () => {
  const { needsBroaderSearch } = await import('../analysis.js');
  const pass = (key, winLoss) => ({ key, winLoss });
  // The grade changed between depths.
  assert.equal(needsBroaderSearch(pass('mistake', 29), pass('blunder', 31)), true);
  // Praise must hold its loss as well as its label.
  assert.equal(needsBroaderSearch(pass('great', 0), pass('great', 3)), true);
  assert.equal(needsBroaderSearch(pass('great', 0), pass('great', 1)), false);
  // A blunder drifting deeper into blunder territory, or an inaccuracy moving inside its band, is settled.
  assert.equal(needsBroaderSearch(pass('blunder', 35), pass('blunder', 40)), false);
  assert.equal(needsBroaderSearch(pass('inaccuracy', 9.8), pass('inaccuracy', 7.2)), false);
  // A mistake sliding toward the Inaccuracy line at the same rate would reach it.
  assert.equal(needsBroaderSearch(pass('mistake', 15.4), pass('mistake', 12.1)), true);
  assert.equal(needsBroaderSearch(pass('mistake', 15.4), pass('mistake', 12.1), 'grade-change'), false);
  // Small movements never trigger it, and the benchmark modes keep their meaning.
  assert.equal(needsBroaderSearch(pass('mistake', 12), pass('mistake', 10.5)), false);
  assert.equal(needsBroaderSearch(pass('blunder', 35), pass('blunder', 40), 'unstable'), true);
  assert.equal(needsBroaderSearch(pass('mistake', 29), pass('blunder', 31), 'never'), false);
});

test('Deep Check reranks the played move at the discovery depth and flags a changed grade', async () => {
  const { positions: [before, after] } = parseReviewGame('1. a3 *');
  const searches = [];
  const engine = { analyzePosition(fen, depth, { multiPv, nodes, searchMoves }) {
    searches.push({ depth, multiPv, nodes, searchMoves });
    if (!searchMoves) return summarizeLines([
      line('e2e4', 70, 155, depth - 1), line('d2d4', 62, 110, depth - 1),
      line('c2c4', 59, 90, depth - 1),
    ], 'w');
    const played = line('a2a3', depth === 17 ? 48 : 53, depth === 17 ? 25 : 60, depth);
    return summarizeLines([
      line('e2e4', 69, 154, depth), line('d2d4', 63, 110, depth), line('c2c4', 59, 90, depth), played,
    ], 'w');
  } };
  const comparison = await deepCheckDecision(engine, before, after, 16, 0);
  assert.deepEqual(searches.map(({ depth, multiPv }) => [depth, multiPv]), [[18, 3], [17, 4], [20, 3], [19, 4]]);
  assert.equal(searches.reduce((sum, { nodes }) => sum + nodes, 0), 9_000_000);
  assert.deepEqual(searches[1].searchMoves, ['e2e4', 'd2d4', 'c2c4', 'a2a3']);
  assert.deepEqual(comparison.passes.map(({ depth, key }) => ({ depth, key })), [
    { depth: 17, key: 'mistake' }, { depth: 19, key: 'inaccuracy' },
  ]);
  assert.ok(Math.abs(comparison.passes[0].winLoss - 11.5083200775) < 1e-9);
  assert.ok(Math.abs(comparison.passes[1].winLoss - 8.307231593) < 1e-9);
  assert.equal(comparison.searchConfidence, 'borderline');
  assert.equal(scoreDecision(before, after, comparison, 0).depth, 19);
});

test('Deep Check declines truncated, mixed-depth, and non-deeper evidence', async () => {
  const { positions: [before, after] } = parseReviewGame('1. a3 *');
  const incomplete = summarizeLines([line('a2a3', 60, 90, 20)], 'w');
  const mixed = summarizeLines([
    line('e2e4', 70, 150, 21), line('a2a3', 60, 90, 20), line('d2d4', 55, 45, 21),
  ], 'w');
  const shallower = summarizeLines([
    line('e2e4', 70, 150, 16), line('a2a3', 60, 90, 16), line('d2d4', 55, 45, 16),
  ], 'w');
  for (const root of [incomplete, mixed, shallower]) {
    const engine = { analyzePosition() { return root; } };
    assert.equal(await deepCheckDecision(engine, before, after, 16, 0), null);
  }
});

test('Deep Check accepts a single complete mating comparison and skips a forced move', async () => {
  const pgn = '[SetUp "1"]\n[FEN "8/8/8/8/8/5kq1/8/7K b - - 0 19"]\n[Result "0-1"]\n\n19... Qg2# 0-1';
  const { positions: [before, after] } = parseReviewGame(pgn);
  const mate = { ...line('g3g2', 0, 0, 21), eval: { type: 'mate', value: -1 } };
  const full = summarizeLines([mate, line('g3h3', 2, -480, 21), line('g3g1', 9, -260, 21)], 'b');
  let searches = 0;
  const engine = { analyzePosition() { return searches++ === 0 ? full : summarizeLines([mate], 'b'); } };
  const comparison = await deepCheckDecision(engine, before, after, 20, 0);
  assert.equal(comparison.searchConfidence, 'single');
  assert.equal(comparison.confirmed, false);
  assert.deepEqual(scoreDecision(before, after, comparison, 0).playedEval, { type: 'mate', value: -1 });
  const forcedPgn = '[SetUp "1"]\n[FEN "7k/8/8/8/8/8/6q1/7K w - - 0 1"]\n\n1. Kxg2 1/2-1/2';
  const { positions: [forcedBefore, forcedAfter] } = parseReviewGame(forcedPgn);
  assert.equal(forcedBefore.legalMoves, 1);
  assert.equal(await deepCheckDecision(engine, forcedBefore, forcedAfter, 20, 0), null);
  assert.equal(searches, 2);
});

test('Deep Check corroborates praise from two distinct deeper depths', async () => {
  const { positions: [before, after] } = parseReviewGame('1. e4 *');
  const engine = { analyzePosition(fen, depth) {
    return summarizeLines([
      line('e2e4', 68, 155, depth), line('d2d4', 42, -100, depth), line('c2c4', 40, -120, depth),
    ], 'w');
  } };
  const comparison = await deepCheckDecision(engine, before, after, 12);
  assert.deepEqual(comparison.passes.map(({ depth }) => depth), [18, 20]);
  assert.equal(comparison.searchConfidence, 'stable');
  assert.equal(scoreDecision(before, after, comparison, 0).classification.key, 'great');
});
