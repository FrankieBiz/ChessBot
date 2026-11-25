import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Chess, DEFAULT_POSITION } from '../vendor/chess.js/chess.js';
import { OPENING_EXPLORER_SAMPLE, openingChoices } from '../opening-explorer.js';

test('the explorer returns ranked legal choices with absolute sample results', () => {
  const choices = openingChoices(DEFAULT_POSITION, 1);
  const game = new Chess();

  assert.ok(choices.length >= 4);
  assert.equal(choices[0].uci, 'e2e4');
  assert.equal(choices[0].san, 'e4');
  assert.ok(OPENING_EXPLORER_SAMPLE.games >= 75_000);
  assert.ok(choices.reduce((total, choice) => total + choice.games, 0) <= OPENING_EXPLORER_SAMPLE.games);
  for (const [index, choice] of choices.entries()) {
    assert.ok(choice.games >= 5);
    assert.equal(choice.games, choice.whiteWins + choice.draws + choice.blackWins);
    assert.ok(!index || choice.games <= choices[index - 1].games);
    assert.equal(game.move(choice.uci).san, choice.san);
    game.undo();
  }
});

test('the explorer shares transposed positions and ignores FEN move clocks', () => {
  const game = new Chess();
  game.loadPgn('1. Nf3 d5 2. d4 Nf6');
  const alternate = new Chess();
  alternate.loadPgn('1. d4 Nf6 2. Nf3 d5');

  assert.notEqual(game.fen(), alternate.fen());
  const choices = openingChoices(game.fen(), 5);
  assert.ok(choices.length > 0);
  assert.deepEqual(choices, openingChoices(alternate.fen(), 5));
});

test('well-supported choices can include a playable local example and its public game', () => {
  const [choice] = openingChoices(DEFAULT_POSITION, 1);
  assert.match(choice.exampleUrl ?? '', /^https:\/\/lichess\.org\/[A-Za-z0-9]{8}$/);
  assert.equal(choice.exampleMoves?.[0], choice.uci);
  assert.equal(choice.exampleMoves.length, 6);

  const game = new Chess();
  for (const uci of choice.exampleMoves) assert.ok(game.move(uci));
});

test('the explorer handles unknown positions and unsupported plies', () => {
  assert.deepEqual(openingChoices(DEFAULT_POSITION, 0), []);
  assert.deepEqual(openingChoices(DEFAULT_POSITION, OPENING_EXPLORER_SAMPLE.maxPly + 1), []);
  assert.deepEqual(openingChoices('not a FEN', 1), []);
  assert.deepEqual(openingChoices('8/8/8/4k3/8/8/8/4K3 w - - 0 1', 1), []);
});
