import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReviewGame } from '../analysis.js';
import { summarizeLines } from '../engine.js';
import {
  HUMAN_MOVE_FEATURES, HUMAN_MOVE_SEARCH_DEPTH, RATING_FEATURES, SOUND_MOVE_LOSS, candidateCpScores, candidateScores, forecastHumanMoves, humanContext, moveFeatureRows,
} from '../human-move-model.js';
import { replayVariation } from '../variation.js';

const feature = (row, name) => row.features[HUMAN_MOVE_FEATURES.indexOf(name)];

// 1. e4 d5: White can recapture-free capture on d5, and Black's last move landed there.
const { positions } = parseReviewGame('1. e4 d5 *');
const before = positions[2];
const game = replayVariation(before);
const legal = game.moves({ verbose: true }).map((move) => move.lan);
const searchFor = (scoresByMove) => summarizeLines(legal.map((uci) => ({
  pv: [uci], winWhite: scoresByMove[uci] ?? 40, eval: { type: 'cp', value: 0 }, depth: 12,
})).sort((a, b) => b.winWhite - a.winWhite), 'w');

test('every legal move gets a row with its loss from the best searched move', () => {
  const scores = candidateScores(searchFor({ e4d5: 55, b1c3: 52 }), 'w');
  const rows = moveFeatureRows(game, scores, humanContext(), before.move.to);
  assert.equal(rows.length, legal.length);
  assert.equal(rows.find(({ uci }) => uci === 'e4d5').loss, 0);
  assert.equal(rows.find(({ uci }) => uci === 'b1c3').loss, 3);
  assert.equal(rows.find(({ uci }) => uci === 'a2a3').loss, 15);
  assert.equal(game.fen(), before.fen, 'the position is restored');
});

test('board features describe captures, recaptures, piece type, and hanging pieces', () => {
  const rows = moveFeatureRows(game, candidateScores(searchFor({}), 'w'), humanContext(), before.move.to);
  const exd5 = rows.find(({ uci }) => uci === 'e4d5');
  assert.equal(feature(exd5, 'capture'), 1);
  assert.equal(feature(exd5, 'recapture'), 1);
  assert.equal(feature(exd5, 'capturedValue'), 1 / 9);
  const qg4 = rows.find(({ uci }) => uci === 'd1g4');
  assert.equal(feature(qg4, 'queen'), 1);
  assert.equal(feature(qg4, 'enPrise'), 1, 'Bc8 attacks g4 and nothing defends the queen there');
  assert.equal(feature(rows.find(({ uci }) => uci === 'd1h5'), 'enPrise'), 0);
  assert.equal(feature(rows.find(({ uci }) => uci === 'f1b5'), 'check'), 1);
});

test('the context only uses ratings and clocks inside the supported range', () => {
  assert.deepEqual(humanContext({ rating: 2100, clockSeconds: 175 }), { rating: 1, ratingKnown: true, pressure: 0 });
  assert.equal(humanContext({ rating: 700 }).ratingKnown, false);
  assert.equal(humanContext({ rating: 3000 }).rating, 0);
  assert.equal(humanContext({ clockSeconds: null }).pressure, 0);
  const rows = moveFeatureRows(game, candidateScores(searchFor({}), 'w'), humanContext(), before.move.to);
  for (const name of RATING_FEATURES) assert.ok(rows.every((row) => feature(row, name) === 0));
});

test('a tempting move can show its loss on the graded Lichess curve', () => {
  const cpSearch = summarizeLines(legal.map((uci) => ({
    pv: [uci], winWhite: 50, eval: { type: 'cp', value: uci === 'e4d5' ? 100 : 0 }, depth: 12,
  })).sort((a, b) => b.winWhite - a.winWhite), 'w');
  const rows = moveFeatureRows(game, candidateScores(cpSearch, 'w'), humanContext(), before.move.to,
    candidateCpScores(cpSearch, 'w'));
  assert.equal(rows.find(({ uci }) => uci === 'e4d5').cpLoss, 0);
  assert.ok(rows.find(({ uci }) => uci === 'a2a3').cpLoss > 9);
  assert.ok(rows.every(({ cpLoss }) => Number.isFinite(cpLoss) && cpLoss >= 0));
});

test('the forecast normalizes move probabilities and names the likeliest unsound move', () => {
  const weights = HUMAN_MOVE_FEATURES.map((name) => ({ loss: -2, capture: 1.5 }[name] ?? 0));
  const model = {
    features: HUMAN_MOVE_FEATURES, searchDepth: HUMAN_MOVE_SEARCH_DEPTH, unrated: { weights, calibration: [0, 1] }, rated: null,
  };
  const rows = moveFeatureRows(game, candidateScores(searchFor({ e4d5: 55, b1c3: 54, d1h5: 45 }), 'w'),
    humanContext(), before.move.to);
  const forecast = forecastHumanMoves(rows, { ratingKnown: true }, model);
  assert.equal(forecast.variant, 'unrated');
  assert.ok(Math.abs(forecast.moves.reduce((sum, move) => sum + move.probability, 0) - 1) < 1e-9);
  assert.equal(forecast.moves[0].uci, 'e4d5');
  const sound = forecast.moves.filter((move) => move.loss <= SOUND_MOVE_LOSS).reduce((sum, move) => sum + move.probability, 0);
  assert.ok(Math.abs(forecast.soundChance - 100 * sound) < 1e-6);
  assert.ok(forecast.tempting.loss > SOUND_MOVE_LOSS);
  assert.equal(forecastHumanMoves(rows, { ratingKnown: false }, null), null);
  assert.equal(forecastHumanMoves(rows, { ratingKnown: false }, { ...model, features: ['loss'] }), null);
  assert.equal(forecastHumanMoves(rows, { ratingKnown: false }, { ...model, searchDepth: 12 }), null);
});

test('the shipped coefficients match the feature code and give sensible forecasts', async () => {
  const { HUMAN_MOVE_MODEL } = await import('../human-move-data.js');
  assert.deepEqual(HUMAN_MOVE_MODEL.features, HUMAN_MOVE_FEATURES);
  assert.equal(HUMAN_MOVE_MODEL.searchDepth, HUMAN_MOVE_SEARCH_DEPTH);
  for (const variant of ['rated', 'unrated']) {
    assert.equal(HUMAN_MOVE_MODEL[variant].weights.length, HUMAN_MOVE_FEATURES.length);
    assert.ok(HUMAN_MOVE_MODEL[variant].calibration.every(Number.isFinite));
  }
  for (const name of RATING_FEATURES) {
    assert.equal(HUMAN_MOVE_MODEL.unrated.weights[HUMAN_MOVE_FEATURES.indexOf(name)], 0);
  }
  // A free pawn recapture is the natural move; hanging the queen on g4 is not.
  const rows = moveFeatureRows(game, candidateScores(searchFor({ e4d5: 55, b1c3: 53, d1g4: 20 }), 'w'),
    humanContext({ rating: 1500, clockSeconds: 170 }), before.move.to);
  const forecast = forecastHumanMoves(rows, { ratingKnown: true });
  assert.equal(forecast.variant, 'rated');
  assert.equal(forecast.moves[0].uci, 'e4d5');
  const queen = forecast.moves.find(({ uci }) => uci === 'd1g4');
  assert.ok(queen.probability < 0.01);
  assert.ok(forecast.soundChance > 0 && forecast.soundChance < 100);
});
