import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateDifficulty, readLichessRatings } from '../difficulty-model.js';

const position = {
  legalMoves: 25, captureCount: 3, inCheck: false, material: 39,
  practicalContext: { ply: 42, timeControl: { base: 180, increment: 2 }, whiteSeconds: 25, blackSeconds: 19 },
};

test('uses only ratings on the trained platform and within the supported rating range', () => {
  const headers = { Site: 'https://lichess.org/abcdefgh', WhiteElo: '1400', BlackElo: '1680' };
  assert.deepEqual(readLichessRatings(headers), { w: 1400, b: 1680 });
  assert.equal(readLichessRatings({ ...headers, Site: 'https://chess.com/game/123' }), null);
  assert.equal(readLichessRatings({ ...headers, Site: 'https://lichess.org.example/game/123' }), null);
  assert.equal(readLichessRatings({ ...headers, BlackElo: '600' }), null);
});

test('interprets the evaluation from the mover perspective and skips forced or mating positions', () => {
  const white = estimateDifficulty(position, { type: 'cp', value: 45 }, 'w');
  const flipped = { ...position, practicalContext: {
    ...position.practicalContext, whiteSeconds: 19, blackSeconds: 25,
  } };
  const black = estimateDifficulty(flipped, { type: 'cp', value: -45 }, 'b');
  assert.deepEqual(white, black);
  assert.ok(white.chance > 0 && white.chance < 100);
  assert.equal(estimateDifficulty({ ...position, legalMoves: 1 }, { type: 'cp', value: 0 }, 'w'), null);
  assert.equal(estimateDifficulty(position, { type: 'mate', value: -2 }, 'w'), null);
  assert.equal(estimateDifficulty({ ...position, practicalContext: null }, { type: 'cp', value: 0 }, 'w'), null);
});

test('works on clean PGNs with missing clocks and keeps the result on the trained scale', () => {
  const noClocks = { ...position, practicalContext: { ply: 25 } };
  const result = estimateDifficulty(noClocks, { type: 'cp', value: 0 }, 'w');
  assert.equal(result.model, 'position');
  assert.ok(result.chance > 0 && result.chance < 100);
});
