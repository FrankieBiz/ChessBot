import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeDecisionQuality } from '../decision-quality.js';

test('decision quality is the root-mean-square downside of discretionary moves', () => {
  assert.equal(computeDecisionQuality([]), null);
  assert.equal(computeDecisionQuality([{ forced: true, winLoss: 0 }]), null);
  assert.deepEqual(computeDecisionQuality([
    { winLoss: 0 }, { forced: true, winLoss: 0 }, { winLoss: 30 }, { winLoss: 40 },
  ]), { score: 71.1, biggestLoss: 40, decisions: 3 });
  assert.deepEqual(computeDecisionQuality([{ winLoss: 100 }]),
    { score: 0, biggestLoss: 100, decisions: 1 });
});
