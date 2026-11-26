import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drillHint, drillPrompt, drillRejection, drillSuccess, judgeDrillAttempt } from '../drills.js';

const mateReview = {
  bestMoveUci: 'b7b8r', bestSan: 'b8=R', winLoss: 50, classification: { label: 'Blunder' },
  missedMate: { available: 2, played: null, kind: 'lost', drill: true },
};
const plainReview = {
  bestMoveUci: 'e2e4', bestSan: 'e4', winLoss: 14, classification: { label: 'Mistake' }, missedMate: null,
};
const compared = (rootWin, playedWin, playedEval) => ({
  root: { winWhite: rootWin }, played: { winWhite: playedWin, eval: playedEval },
});

test('the engine move and the game move are recognized without a search', () => {
  const base = { gameUci: 'b7b8q', review: mateReview, color: 'w' };
  assert.equal(judgeDrillAttempt({ ...base, attemptUci: 'b7b8r' }).verdict, 'best');
  assert.equal(judgeDrillAttempt({ ...base, attemptUci: 'b7b8q' }).verdict, 'game-move');
  assert.equal(judgeDrillAttempt({ ...base, attemptUci: 'f2f3' }).verdict, 'unknown');
});

test('a missed-mate drill accepts only a mate at least as short as the one available', () => {
  const base = { gameUci: 'b7b8q', review: mateReview, color: 'w' };
  const slower = judgeDrillAttempt({ ...base, attemptUci: 'f2f3', comparison: compared(100, 100, { type: 'mate', value: 4 }) });
  assert.deepEqual(slower, { verdict: 'rejected', reason: 'needs-mate', mate: 4, loss: 0, target: 2 });
  const equal = judgeDrillAttempt({ ...base, attemptUci: 'f2g3', comparison: compared(100, 100, { type: 'mate', value: 2 }) });
  assert.equal(equal.verdict, 'alternative');
  assert.equal(judgeDrillAttempt({ ...base, attemptUci: 'f2g3', deliversMate: true }).verdict, 'alternative');
});

test('an ordinary drill accepts a move within three expected-score points, from either side', () => {
  const base = { gameUci: 'a2a3', review: plainReview };
  assert.equal(judgeDrillAttempt({ ...base, color: 'w', attemptUci: 'd2d4', comparison: compared(60, 58, { type: 'cp', value: 40 }) }).verdict, 'alternative');
  assert.equal(judgeDrillAttempt({ ...base, color: 'w', attemptUci: 'c2c4', comparison: compared(60, 52, { type: 'cp', value: 10 }) }).reason, 'loses');
  assert.equal(judgeDrillAttempt({ ...base, color: 'b', attemptUci: 'd7d5', comparison: compared(40, 42, { type: 'cp', value: -30 }) }).verdict, 'alternative');
});

test('an unverified drill attempt says Stockfish could not check it', () => {
  assert.equal(
    drillRejection({ attemptSan: 'Nf3', review: plainReview, judgement: { verdict: 'unknown' } }),
    "Couldn't check Nf3 with Stockfish. Try another move.");
});

test('mate drills say what to look for', () => {
  assert.match(drillPrompt({ playedSan: 'b8=Q', review: mateReview }), /forced mate in 2/);
  assert.match(drillPrompt({ playedSan: 'a3', review: plainReview }), /\(Mistake\)/);
  assert.match(drillHint({ review: mateReview, fromSquare: 'b7' }), /forced mate in 2.*b7/);
  const rejection = drillRejection({
    attemptSan: 'Kf3', review: mateReview,
    judgement: { verdict: 'rejected', reason: 'needs-mate', mate: 4, loss: 0, target: 2 },
  });
  assert.equal(rejection, 'Kf3 mates in 4, but there is a forced mate in 2 here. Look at every check first!');
});

test('solved drills name the move, and alternatives name the engine move', () => {
  assert.equal(
    drillSuccess({ attemptSan: 'Rd8#', judgement: { verdict: 'alternative', mate: 1 }, review: mateReview, deliversMate: true }),
    'Checkmate! Rd8# ends the game.');
  assert.equal(
    drillSuccess({ attemptSan: 'e4', judgement: { verdict: 'best' }, review: plainReview }),
    "Great find! e4 is Stockfish's top move.");
  assert.equal(
    drillSuccess({ attemptSan: 'Rb8', judgement: { verdict: 'alternative', mate: 2 }, review: mateReview }),
    "Nice! Rb8 also forces mate in 2 (Stockfish's line starts b8=R).");
  assert.equal(
    drillSuccess({ attemptSan: 'd4', judgement: { verdict: 'alternative', mate: null }, review: plainReview }),
    'Nice! d4 is also strong (top engine move was e4).');
});
