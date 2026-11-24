import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeDecision, compareRootMoves, parseReviewGame, scoreDecision } from '../analysis.js';
import { summarizeLines } from '../engine.js';

const line = (uci, winWhite, cp, depth = 14, continuation = []) => ({
  pv: [uci, ...continuation], winWhite, eval: { type: 'cp', value: cp }, depth,
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
    return summarizeLines([line('e2e4', 64, 70), line('d2d4', 60, 52), line('a2a3', 52, 15)], 'w');
  } };
  const result = await compareRootMoves(engine, positions[0], 'a2a3', 14, root);
  const scored = scoreDecision(positions[0], positions[1], result, 0);
  assert.equal(scored.winLoss, 12);
  assert.equal(scored.cpLoss, 55);
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
  assert.equal(result.winLoss, 11);
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

test('rechecks moves close to a grade threshold and resolves a grade that moved between depths', async () => {
  const { positions } = parseReviewGame('1. a3 *');
  const first = summarizeLines([line('e2e4', 55, 70), line('a2a3', 52.2, 65)], 'w');
  const second = summarizeLines([line('e2e4', 55, 70, 16), line('a2a3', 51.6, 62, 16)], 'w');
  const third = summarizeLines([line('e2e4', 55, 70, 18), line('a2a3', 51.5, 60, 18),
    line('d2d4', 50, 56, 18)], 'w');
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
  const first = summarizeLines([line('e2e4', 67, 130), line('d2d4', 41, -55)], 'w');
  const second = summarizeLines([line('e2e4', 61, 95, 16), line('d2d4', 57, 78, 16)], 'w');
  const third = summarizeLines([line('e2e4', 61, 95, 18), line('d2d4', 59, 86, 18),
    line('c2c4', 57, 76, 18)], 'w');
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
  const first = summarizeLines([line('e2e4', 64, 150), line('a2a3', 51, 15)], 'w');
  const second = summarizeLines([line('e2e4', 66, 155, 16), line('a2a3', 53, 25, 16)], 'w');
  const third = summarizeLines([line('e2e4', 66.2, 156, 18), line('a2a3', 53, 25, 18),
    line('c2c4', 51, 15, 18)], 'w');
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
