import { Chess } from "./vendor/chess.js/chess.js";
import { EXPLORER_POSITIONS, OPENING_EXPLORER_SAMPLE } from "./opening-explorer-data.js";
import { moveToUci } from "./variation.js";

export { OPENING_EXPLORER_SAMPLE };

/** The most frequent legal continuations for an opening position. Ply is the next move, starting at 1. */
export function openingChoices(fen, ply) {
  if (typeof fen !== "string" || !Number.isInteger(ply) || ply < 1 || ply > OPENING_EXPLORER_SAMPLE.maxPly) return [];
  let game;
  try {
    game = new Chess(fen);
  } catch {
    return [];
  }
  const position = game.fen().split(" ", 4).join(" ");
  const sampled = EXPLORER_POSITIONS[position];
  if (!sampled?.length) return [];

  const legal = new Map(game.moves({ verbose: true }).map((move) => [moveToUci(move), move.san]));
  return sampled.flatMap(([uci, whiteWins, draws, blackWins, example]) => {
    const san = legal.get(uci);
    if (!san) return [];
    const choice = { uci, san, games: whiteWins + draws + blackWins, whiteWins, draws, blackWins };
    if (example) {
      const [gameId, ...exampleMoves] = example;
      choice.exampleMoves = exampleMoves;
      choice.exampleUrl = `https://lichess.org/${gameId}`;
    }
    return [choice];
  });
}
