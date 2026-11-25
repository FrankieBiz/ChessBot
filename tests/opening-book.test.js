import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReviewGame } from '../analysis.js';
import { bookForReview, findBookMoves } from '../opening-book.js';

const reviewBook = (pgn) => findBookMoves(parseReviewGame(pgn).positions);

test('the book covers a familiar opening including moves between named positions', () => {
  const book = reviewBook('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *');

  assert.equal(book.length, 10);
  assert.equal(book[0], null);
  assert.ok(book.slice(1).every(Boolean));
  assert.deepEqual(book[5], { eco: 'C60', name: 'Ruy Lopez' });
  assert.deepEqual(book[7], { eco: 'C70', name: 'Ruy Lopez: Morphy Defense' });
  assert.equal(book[9].eco, 'C78');
});

test('a move must be recorded from the position even when it reaches a named opening', () => {
  const canonical = parseReviewGame('1. g3 e5 2. Nf3 *').positions;
  const unlisted = parseReviewGame('1. Nf3 e5 2. g3 *').positions;

  assert.equal(canonical[3].fen.split(' ', 4).join(' '), unlisted[3].fen.split(' ', 4).join(' '));
  assert.deepEqual(findBookMoves(canonical)[3], { eco: 'A00', name: 'Hungarian Opening: Reversed Alekhine' });
  assert.equal(findBookMoves(unlisted)[3], null);
});

test('a game can return to the book when an unlisted move transposes', () => {
  const book = reviewBook('1. Nc3 c5 2. Nf3 Nc6 3. e4 e5 4. Bc4 *');

  assert.equal(book[5], null);
  assert.deepEqual(book[6], { eco: 'B30', name: 'Sicilian Defense: Closed, Anti-Sveshnikov Variation' });
  assert.deepEqual(book[7], book[6]);
});

test('a frequent continuation from high-rated games fills a gap in the named lines', () => {
  const book = reviewBook('1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 e6 *');

  assert.match(book[8]?.name ?? '', /Sicilian Defense/);
});

test('named moves can stay in book past the game-derived ply limit', () => {
  const delayedSicilian = (count) => {
    const shuffles = Array.from({ length: count }, (_, index) =>
      `${2 * index + 1}. Na3 Na6 ${2 * index + 2}. Nb1 Nb8`).join(' ');
    const start = count * 2 + 1;
    return reviewBook(`${shuffles} ${start}. e4 c5 ${start + 1}. Nf3 Nc6 ${start + 2}. d4 cxd4 ${start + 3}. Nxd4 e6 *`);
  };

  assert.ok(delayedSicilian(4)[24]);
  const late = delayedSicilian(5);
  assert.ok(late[27]);
  assert.equal(late[28], null);
});

test('setup positions do not receive book classifications', () => {
  const original = parseReviewGame('1. e4 e5 2. Nf3 Nc6 *').positions;
  const setup = `[SetUp "1"]\n[FEN "${original[2].fen}"]\n\n2. Nf3 Nc6 *`;

  assert.ok(findBookMoves(original)[3]);
  assert.deepEqual(reviewBook(setup), [null, null, null]);
});

test('repeated positions do not start an additional set of book moves', () => {
  const book = reviewBook('1. Nf3 Nf6 2. Ng1 Ng8 3. e4 e5 *');

  assert.ok(book[1]);
  assert.equal(book[5], null);
  assert.ok(book[6]);
});

test('moves beyond the deepest book line are unlisted', () => {
  const repeated = Array.from({ length: 10 }, (_, index) =>
    `${2 * index + 1}. Nf3 Nf6 ${2 * index + 2}. Ng1 Ng8`).join(' ');
  const book = reviewBook(`${repeated} 21. e4 e5 *`);

  assert.ok(book[1]);
  assert.equal(book[42], null);
});

const match = { eco: 'B00', name: "King's Pawn Game" };
const goodReview = { classification: { key: 'good' }, winLoss: 4, accuracy: 85, searchConfidence: 'single' };

test('sound book moves retain their engine grade and measured scores', () => {
  for (const searchConfidence of ['single', 'stable']) {
    for (const key of ['best', 'excellent', 'good']) {
      const review = Object.freeze({ ...goodReview, classification: Object.freeze({ key }), searchConfidence });

      assert.equal(bookForReview(match, review), match);
      assert.equal(review.classification.key, key);
      assert.equal(review.winLoss, 4);
      assert.equal(review.accuracy, 85);
    }
  }
});

test('the Book label does not obscure errors or special praise', () => {
  for (const key of ['inaccuracy', 'mistake', 'miss', 'blunder', 'great', 'brilliant']) {
    assert.equal(bookForReview(match, { ...goodReview, classification: { key } }), null, key);
  }
});

test('Book requires a discretionary move and a reliable search without a missed mate', () => {
  assert.equal(bookForReview(null, goodReview), null);
  assert.equal(bookForReview(match, { ...goodReview, forced: true }), null);
  assert.equal(bookForReview(match, { ...goodReview, missedMate: { kind: 'slower', drill: false } }), null);
  assert.equal(bookForReview(match, { ...goodReview, searchConfidence: 'borderline' }), null);
  assert.equal(bookForReview(match, { ...goodReview, searchConfidence: undefined }), null);
});
