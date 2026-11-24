import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReviewGame, scoreDecision } from '../analysis.js';
import { generateLocalCoachInsight } from '../coach.js';
import { classifyMove, summarizeLines } from '../engine.js';
import { trainingPriority } from '../practical-model.js';
import { detectMissedMate, moverMateDistance, MISSED_MATE_PRIORITY } from '../tactics.js';

const mate = (value) => ({ type: 'mate', value });
const cp = (value) => ({ type: 'cp', value });
const line = (uci, evaluation, winWhite, depth = 16) => ({ pv: [uci], eval: evaluation, winWhite, depth });

test('mate distances are read from the mover side', () => {
  assert.equal(moverMateDistance(mate(2), 'w'), 2);
  assert.equal(moverMateDistance(mate(-2), 'b'), 2);
  assert.equal(moverMateDistance(mate(3), 'b'), -3);
  assert.equal(moverMateDistance(cp(900), 'w'), null);
});

test('a delayed mate in 1 is an immediate miss even though the position stays won', () => {
  assert.deepEqual(detectMissedMate(mate(1), mate(3), 'w'),
    { available: 1, played: 3, kind: 'immediate', drill: true });
  assert.deepEqual(detectMissedMate(mate(-1), cp(-950), 'b'),
    { available: 1, played: null, kind: 'immediate', drill: true });
});

test('short forced mates that disappear become drills, and slower mates are reported without one', () => {
  assert.equal(detectMissedMate(mate(2), cp(800), 'w').kind, 'lost');
  assert.deepEqual(detectMissedMate(mate(2), mate(4), 'w'),
    { available: 2, played: 4, kind: 'slower', drill: false });
  assert.equal(detectMissedMate(mate(2), mate(3), 'w'), null);
  assert.equal(detectMissedMate(mate(1), mate(1), 'w'), null);
  assert.equal(detectMissedMate(mate(5), cp(600), 'w'), null);
  assert.equal(detectMissedMate(mate(-2), cp(0), 'w'), null);
});

test('a drill-worthy missed mate is graded Miss but larger losses keep their severity', () => {
  const base = { playedUci: 'd1d5', bestMoveUci: 'd1d8', winBefore: 100, legalMoves: 20, secondScore: 100 };
  const missed = detectMissedMate(mate(1), mate(3), 'w');
  assert.equal(classifyMove({ ...base, winAfter: 100, missedMate: missed }).key, 'miss');
  assert.equal(classifyMove({ ...base, winAfter: 100 }).key, 'excellent');
  assert.equal(classifyMove({ ...base, winAfter: 50, missedMate: missed }).key, 'blunder');
  const slower = detectMissedMate(mate(2), mate(4), 'w');
  assert.equal(classifyMove({ ...base, winAfter: 100, missedMate: slower }).key, 'excellent');
});

test('the reviewed game routes a missed back-rank mate into practice without changing accuracy', () => {
  const pgn = '[SetUp "1"]\n[FEN "6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1"]\n\n1. Qd5 *';
  const { positions } = parseReviewGame(pgn);
  const best = line('d1d8', mate(1), 100);
  const played = line('d1d5', mate(3), 100);
  const root = summarizeLines([best, played], 'w');
  const review = scoreDecision(positions[0], positions[1], { root, played }, 0);
  assert.equal(review.classification.key, 'miss');
  assert.equal(review.accuracy, 100);
  assert.equal(review.winLoss, 0);
  assert.deepEqual(review.missedMate, { available: 1, played: 3, kind: 'immediate', drill: true });
  assert.equal(trainingPriority(review), MISSED_MATE_PRIORITY);
});

test('a stalemating queen promotion is a blunder that still asks for the mate', () => {
  const pgn = '[SetUp "1"]\n[FEN "8/1P6/8/8/8/8/5K2/7k w - - 0 1"]\n[Result "1/2-1/2"]\n\n1. b8=Q 1/2-1/2';
  const { positions } = parseReviewGame(pgn);
  assert.equal(positions[1].terminal.checkmate, false);
  const root = summarizeLines([line('b7b8r', mate(2), 100), line('f2f3', mate(4), 100)], 'w');
  const played = line('b7b8q', cp(0), 50);
  const review = scoreDecision(positions[0], positions[1], { root, played }, 0);
  assert.equal(review.classification.key, 'blunder');
  assert.equal(review.missedMate.kind, 'lost');
  assert.equal(trainingPriority(review), 50);
});

test('the coach names the missed mate and the move that delivered it', () => {
  const insight = generateLocalCoachInsight({
    move: { san: 'Qd5', color: 'w' },
    evalBefore: { eval: mate(1) },
    evalAfter: { eval: mate(3) },
    review: {
      classification: { key: 'miss' }, bestSan: 'Qd8#', winLoss: 0,
      missedMate: { available: 1, played: 3, kind: 'immediate', drill: true },
    },
  });
  assert.equal(insight.title, 'Qd5 missed mate in 1');
  assert.match(insight.text, /Qd8# was checkmate on the spot/);
  assert.match(insight.text, /takes 3 moves instead of 1/);
  assert.equal(insight.tag, 'Missed Mate');
});

test('a move that misses a mate and allows one mentions both', () => {
  const insight = generateLocalCoachInsight({
    move: { san: 'Qd5', color: 'w' },
    evalBefore: { eval: mate(2) },
    evalAfter: { eval: mate(-1) },
    review: {
      classification: { key: 'blunder' }, bestSan: 'Qd8+', winLoss: 100,
      missedMate: { available: 2, played: null, kind: 'lost', drill: true },
    },
  });
  assert.equal(insight.title, 'Qd5 allows checkmate in 1');
  assert.match(insight.text, /You had a forced mate in 2 with Qd8\+ instead/);
  assert.equal(insight.tag, 'Missed Mate');
});
