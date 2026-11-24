// Board positions that keep the full move history, so repetitions stay visible to chess.js and Stockfish.
import { Chess } from "./vendor/chess.js/chess.js";
import { terminalPosition } from "./analysis.js";

export function parseUciMove(uci) {
  if (typeof uci !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) };
}

export const moveToUci = ({ from, to, promotion }) => `${from}${to}${promotion || ""}`;

/** Replay a game from its start so chess.js keeps the history it needs for repetition rules. */
export function replayGame(initialFen, history = []) {
  const game = new Chess(initialFen);
  for (const uci of history) {
    const move = parseUciMove(uci);
    if (!move) throw new Error(`Invalid move in history: ${uci}`);
    game.move(move);
  }
  return game;
}

/** The game at a reviewed position followed by explored moves. */
export function replayVariation(basePosition, variationUci = []) {
  const { initialFen, history } = basePosition.searchOptions;
  return replayGame(initialFen, [...history, ...variationUci]);
}

/** The analysis input for an explored position, with the game history ahead of the variation. */
export function describeVariation(basePosition, variationUci = []) {
  const game = replayVariation(basePosition, variationUci);
  const { initialFen, history } = basePosition.searchOptions;
  return {
    fen: game.fen(),
    legalMoves: game.moves().length,
    terminal: terminalPosition(game),
    searchOptions: { initialFen, history: [...history, ...variationUci] },
    repetition: game.isThreefoldRepetition(),
    fiftyMoves: game.isDrawByFiftyMoves(),
  };
}

/** Legal promotions for a drag from one square to another. Empty when the drag is not a promotion. */
export function promotionChoices(game, from, to) {
  return game.moves({ square: from, verbose: true })
    .filter((move) => move.to === to && move.promotion)
    .map((move) => move.promotion);
}
