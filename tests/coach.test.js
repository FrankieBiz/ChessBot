import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateLocalCoachInsight } from '../coach.js';
import { CLASSIFICATIONS } from '../engine.js';

test('the coach acknowledges checkmate regardless of the move grade', () => {
  const insight = generateLocalCoachInsight({
    move: { san: 'Qxf7#', color: 'w' },
    review: { classification: CLASSIFICATIONS.great, pvGap: 40 },
  });
  assert.match(insight.title, /Checkmate/);
  assert.equal(insight.tag, 'Checkmate');
});

test('mentions a missed mate in one when expected-score saturation gives a high grade', () => {
  const insight = generateLocalCoachInsight({
    move: { san: 'Qh5', color: 'w' },
    evalBefore: { eval: { type: 'mate', value: 1 } },
    evalAfter: { eval: { type: 'cp', value: 980 } },
    review: { classification: CLASSIFICATIONS.excellent, bestSan: 'Qxf7#' },
  });
  assert.match(insight.text, /checkmate in 1/);
  assert.match(insight.text, /Qxf7#/);
});

test('an error that allows a fork names it with the attacked squares', async () => {
  const { reviewTactics } = await import('../motifs.js');
  // Black's Qc8?? walks into Ne7+.
  const tactics = reviewTactics({
    fenBefore: '3q2k1/8/8/3N4/8/8/8/6K1 b - - 0 1', fenAfter: '2q3k1/8/8/3N4/8/8/8/6K1 w - - 1 2',
    playedUci: 'd8c8', grade: 'blunder', playedPv: ['d8c8', 'd5e7', 'g8f8', 'e7c8'], bestPv: ['d8d5'],
  });
  const insight = generateLocalCoachInsight({
    move: { san: 'Qc8', color: 'b' },
    review: { classification: CLASSIFICATIONS.blunder, winLoss: 60, bestSan: 'Qxd5', tactics },
  });
  assert.equal(insight.title, 'Qc8 allows a knight fork');
  assert.equal(insight.tag, 'Fork');
  assert.match(insight.text, /White has a knight fork\. Ne7\+ attacks your king on g8 and your queen on c8\./);
  assert.match(insight.text, /You missed a free capture\. Qxd5 takes the undefended knight on d5\./);
});

test('a best move that carries out a tactic is explained by the tactic', async () => {
  const { reviewTactics } = await import('../motifs.js');
  const tactics = reviewTactics({
    fenBefore: '2q3k1/8/8/3N4/8/8/8/6K1 w - - 0 1', fenAfter: '2q3k1/4N3/8/8/8/8/8/6K1 b - - 1 1',
    playedUci: 'd5e7', grade: 'best', playedPv: ['d5e7', 'g8f8', 'e7c8'],
  });
  const insight = generateLocalCoachInsight({
    move: { san: 'Ne7+', color: 'w' },
    review: { classification: CLASSIFICATIONS.best, bestSan: 'Ne7+', tactics },
  });
  assert.equal(insight.title, 'Ne7+ is the best move');
  assert.match(insight.text, /^This is a knight fork\. Ne7\+ attacks the king on g8 and the queen on c8\. In Stockfish's line, you win 9 points of material\.$/);
});

test('every tag a tactic can produce on an error maps to a weakness theme', async () => {
  const { TACTIC_LABEL } = await import('../motifs.js');
  const { themeForTag } = await import('../weakness.js');
  for (const [kind, label] of Object.entries(TACTIC_LABEL)) {
    const allowed = { 'free capture': 'hanging', 'back-rank mate': 'allowed-mate', checkmate: 'allowed-mate' }[kind] ?? 'allowed-tactic';
    assert.equal(themeForTag(label), allowed, label);
    const missedTag = kind === 'free capture' ? 'Missed Free Piece' : kind.endsWith('mate') ? 'Missed Mate' : `Missed ${label}`;
    assert.equal(themeForTag(missedTag), kind.endsWith('mate') ? 'missed-mate' : 'missed-material', missedTag);
  }
});

test('a Miss that skipped a tactic keeps the missed-refutation tag', async () => {
  const { reviewTactics } = await import('../motifs.js');
  const tactics = reviewTactics({
    fenBefore: '2q3k1/8/8/3N4/8/8/8/6K1 w - - 0 1', fenAfter: '2q3k1/8/8/8/8/4N3/8/6K1 b - - 1 1',
    playedUci: 'd5e3', grade: 'miss', playedPv: ['d5e3'], bestPv: ['d5e7', 'g8f8', 'e7c8'],
  });
  const insight = generateLocalCoachInsight({
    move: { san: 'Ne3', color: 'w' },
    review: { classification: CLASSIFICATIONS.miss, winLoss: 15, bestSan: 'Ne7+', tactics },
  });
  assert.equal(insight.title, 'Ne3 missed a knight fork');
  assert.equal(insight.tag, 'Missed Refutation');
});

