import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseClockSeconds, parseTimeControl, practicalImpact, trainingPriority } from '../practical-model.js';

const evalCp = (value) => ({ type: 'cp', value });
const timing = { base: 180, increment: 2 };
const position = { ply: 40, timeControl: timing, whiteSeconds: 70, blackSeconds: 12 };

test('clocks and time controls respect the supported data format and domain', () => {
  assert.equal(parseClockSeconds('note [%clk 0:02:18.55]'), 138.55);
  assert.equal(parseClockSeconds('[%clk 0:67:10]'), null);
  assert.equal(parseClockSeconds('[%clk 0:00:00]'), 0);
  assert.equal(parseClockSeconds('no recorded clock'), null);
  assert.deepEqual(parseTimeControl('180+2'), timing);
  assert.deepEqual(parseTimeControl('600'), { base: 600, increment: 0 });
  assert.equal(parseTimeControl('1/86400'), null);
  assert.equal(parseTimeControl('1800+0'), null);
  assert.equal(parseTimeControl('0+1'), null);
});

test('the move comparison is monotone, equal for ties, and symmetric by side', () => {
  const white = practicalImpact(evalCp(140), evalCp(40), position, 'w');
  const black = practicalImpact(evalCp(-140), evalCp(-40), {
    ...position, whiteSeconds: 12, blackSeconds: 70,
  }, 'b');
  assert.equal(white.model, 'clock');
  assert.ok(white.loss > 0);
  assert.ok(Math.abs(white.loss - black.loss) < 1e-10);
  assert.equal(practicalImpact(evalCp(70), evalCp(70), position, 'w').loss, 0);
  assert.equal(practicalImpact(evalCp(40), evalCp(70), position, 'w').loss, 0);
});

test('missing clocks use the fitted position-only curve and unsupported positions have no estimate', () => {
  const fallback = practicalImpact(evalCp(100), evalCp(0), { ply: 40 }, 'w');
  const clock = practicalImpact(evalCp(100), evalCp(0), position, 'w');
  assert.equal(fallback.model, 'position');
  assert.ok(Math.abs(fallback.loss - 6.1951666512) < 0.01);
  assert.notEqual(fallback.loss, clock.loss);
  assert.equal(practicalImpact(evalCp(100), evalCp(0), { ...position, ply: 7 }, 'w'), null);
  assert.equal(practicalImpact(evalCp(100), evalCp(0), { ...position, ply: 121 }, 'w'), null);
  assert.equal(practicalImpact({ type: 'mate', value: 2 }, evalCp(0), position, 'w'), null);
});

test('training priority keeps a large engine loss visible while surfacing practical losses', () => {
  assert.equal(trainingPriority({ winLoss: 24, practicalImpact: { loss: 10 } }), 24);
  assert.equal(trainingPriority({ winLoss: 4, practicalImpact: { loss: 12 } }), 12);
  assert.equal(trainingPriority({ winLoss: 9, practicalImpact: null }), 9);
});
