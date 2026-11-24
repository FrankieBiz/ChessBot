import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Chess } from '../vendor/chess.js/chess.js';
import { parseReviewGame } from '../analysis.js';
import { describeVariation, parseUciMove, promotionChoices, replayVariation } from '../variation.js';

test('an explored line keeps the game history and recognizes a threefold repetition', () => {
  const { positions } = parseReviewGame('1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 *');
  const base = positions[6];
  const explored = describeVariation(base, ['f3g1', 'f6g8']);
  assert.equal(explored.repetition, true);
  assert.equal(explored.terminal, null);
  assert.deepEqual(explored.searchOptions.history,
    ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']);
  // The FEN alone cannot see the earlier occurrences.
  assert.equal(new Chess(explored.fen).isThreefoldRepetition(), false);
  assert.equal(describeVariation(base, ['f3g1']).repetition, false);
});

test('the board offers every promotion piece and the chosen piece is kept', () => {
  const { positions } = parseReviewGame('[SetUp "1"]\n[FEN "8/1P6/8/8/8/8/5K2/7k w - - 0 1"]\n\n1. Kf3 *');
  const game = replayVariation(positions[0]);
  assert.deepEqual(promotionChoices(game, 'b7', 'b8').sort(), ['b', 'n', 'q', 'r']);
  assert.deepEqual(promotionChoices(game, 'f2', 'f3'), []);
  const rook = describeVariation(positions[0], ['b7b8r']);
  assert.equal(rook.fen.split(' ')[0], '1R6/8/8/8/8/8/5K2/7k');
  assert.equal(rook.terminal, null);
  const queen = describeVariation(positions[0], ['b7b8q']);
  assert.equal(queen.terminal.checkmate, false);
  assert.deepEqual(queen.terminal.wdl, { win: 0, draw: 1000, loss: 0 });
});

test('UCI moves are validated before they reach chess.js', () => {
  assert.deepEqual(parseUciMove('b7b8r'), { from: 'b7', to: 'b8', promotion: 'r' });
  assert.deepEqual(parseUciMove('e2e4'), { from: 'e2', to: 'e4' });
  assert.equal(parseUciMove('e2e9'), null);
  assert.equal(parseUciMove('b7b8k'), null);
  assert.throws(() => describeVariation(parseReviewGame('1. e4 *').positions[0], ['e2e5']));
});
