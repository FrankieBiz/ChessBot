// Arrows and circles a player draws on the board, the way Lichess and Chess.com do it.
// Geometry is in square units: the board is 8 × 8 with (0, 0) at the top-left corner.

export const SHAPE_COLORS = ["green", "red", "blue", "yellow"];

/** Lichess's brushes: a plain right-drag is green, Shift (or Ctrl) red, Alt (or Cmd) blue, both yellow. */
export function shapeColor({ shiftKey = false, ctrlKey = false, altKey = false, metaKey = false } = {}) {
  const red = shiftKey || ctrlKey;
  const blue = altKey || metaKey;
  return SHAPE_COLORS[(red ? 1 : 0) + (blue ? 2 : 0)];
}

/** A circle when `from` equals `to`, otherwise an arrow. */
export function makeShape(from, to, color) {
  return from === to ? { from, color } : { from, to, color };
}

/**
 * Add a shape. Drawing the same arrow or circle again in the same color removes it; in another color
 * it replaces the old one.
 */
export function toggleShape(shapes, shape) {
  const same = (other) => other.from === shape.from && (other.to ?? null) === (shape.to ?? null);
  const existing = shapes.find(same);
  const rest = shapes.filter((other) => !same(other));
  return existing?.color === shape.color ? rest : [...rest, shape];
}

/** The center of a square, in square units, as the board is shown. */
export function squareCenter(square, orientation = "w") {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const col = orientation === "w" ? file : 7 - file;
  const row = orientation === "w" ? 7 - rank : rank;
  return { x: col + 0.5, y: row + 0.5 };
}

/** The square under a point given as fractions (0–1) of the board's width and height. */
export function squareAt(fx, fy, orientation = "w") {
  if (!(fx >= 0 && fx < 1 && fy >= 0 && fy < 1)) return null;
  const col = Math.floor(fx * 8);
  const row = Math.floor(fy * 8);
  const file = orientation === "w" ? col : 7 - col;
  const rank = orientation === "w" ? 7 - row : row;
  return `${String.fromCharCode(97 + file)}${rank + 1}`;
}

/**
 * The shaft of an arrow, from the middle of `from` to just short of the middle of `to`, so the
 * arrowhead (drawn as a marker at the end) points at the center of the target square.
 */
export function arrowLine(from, to, orientation = "w", headLength = 0.34) {
  const start = squareCenter(from, orientation);
  const end = squareCenter(to, orientation);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const keep = Math.max(0, length - headLength) / length;
  return { x1: start.x, y1: start.y, x2: start.x + dx * keep, y2: start.y + dy * keep };
}
