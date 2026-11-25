import { DEFAULT_POSITION } from "./vendor/chess.js/chess.js";
import { BOOK_MAX_PLY, BOOK_POSITIONS, GAME_BOOK_MAX_PLY } from "./opening-book-data.js";

const BOOK_GRADES = new Set(["best", "excellent", "good"]);
const UNNAMED_OPENING = { eco: null, name: null };
const positionKey = (fen) => fen.split(" ", 4).join(" ");

/** Match the played move to a recorded continuation from the exact position. */
export function findBookMoves(positions) {
  const matches = Array(positions.length).fill(null);
  if (positions[0]?.searchOptions?.initialFen !== DEFAULT_POSITION) return matches;

  let before = positionKey(positions[0].fen);
  let opening = UNNAMED_OPENING;
  const seen = new Set();
  for (let ply = 1; ply < positions.length && ply <= BOOK_MAX_PLY; ply++) {
    const { fen, move } = positions[ply];
    const after = positionKey(fen);
    const repeated = seen.has(before) || seen.has(after);
    opening = BOOK_POSITIONS[after]?.[0] ?? opening;
    const known = BOOK_POSITIONS[before];
    const namedMove = known?.[1].includes(move.uci);
    const commonMove = ply <= GAME_BOOK_MAX_PLY && known?.[2]?.includes(move.uci);
    if (!repeated && (namedMove || commonMove)) {
      matches[ply] = { ...opening };
    }
    seen.add(before);
    before = after;
  }
  return matches;
}

/** Show opening theory for sound moves while keeping the original engine grade and scores. */
export function bookForReview(match, review) {
  if (!match || review.forced || review.missedMate || !BOOK_GRADES.has(review.classification.key)) return null;
  return review.searchConfidence === "single" || review.searchConfidence === "stable" ? match : null;
}
