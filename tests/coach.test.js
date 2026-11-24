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
