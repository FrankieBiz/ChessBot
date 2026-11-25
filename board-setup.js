// The chessboard both extension pages use: pieces, arrows, markers, and the promotion picker.
import { Chessboard, COLOR, FEN } from "./vendor/cm-chessboard/src/Chessboard.js";
import { Arrows } from "./vendor/cm-chessboard/src/extensions/arrows/Arrows.js";
import { Markers } from "./vendor/cm-chessboard/src/extensions/markers/Markers.js";
import {
  PromotionDialog,
  PROMOTION_DIALOG_RESULT_TYPE,
} from "./vendor/cm-chessboard/src/extensions/promotion-dialog/PromotionDialog.js";
import { promotionChoices } from "./variation.js";

/** A board with ChessBot's pieces, arrows, markers, and promotion picker. */
export function createBoard(element, { orientation = "w", position = FEN.start, coordinates = true } = {}) {
  return new Chessboard(element, {
    position,
    orientation: orientation === "b" ? COLOR.black : COLOR.white,
    assetsUrl: "./vendor/cm-chessboard/assets/",
    style: {
      cssClass: "default",
      showCoordinates: coordinates,
      pieces: { file: "pieces/staunty.svg" },
      animationDuration: 180,
    },
    extensions: [{ class: Arrows }, { class: Markers }, { class: PromotionDialog }],
  });
}

/**
 * Open the piece picker when a drag is a promotion. `onChoice` receives the move, or null when the
 * picker is closed. It is not called when `isCurrent` reports that the board has moved on.
 * Returns false when the drag is not a promotion, so the caller can commit it directly.
 */
export function requestPromotion(board, game, from, to, onChoice, isCurrent = () => true) {
  if (!promotionChoices(game, from, to).length) return false;
  const color = game.turn() === "w" ? COLOR.white : COLOR.black;
  board.showPromotionDialog(to, color, (result) => {
    if (!isCurrent()) return;
    onChoice(result.type === PROMOTION_DIALOG_RESULT_TYPE.pieceSelected
      ? { from, to, promotion: result.piece.charAt(1) }
      : null);
  });
  return true;
}
