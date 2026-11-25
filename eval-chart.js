// Geometry and data for the review charts. Pure functions; review.js draws the result.

/** The first ply of the middlegame and of the endgame, or null when the game never reaches them. */
export function phaseDivisions(positions) {
  const first = (phase) => {
    const ply = positions.findIndex((position, index) => index > 0 && position.phase === phase);
    return ply > 0 ? ply : null;
  };
  const endgame = first("endgame");
  const middlegame = first("middlegame");
  return { middlegame: middlegame !== null && (endgame === null || middlegame < endgame) ? middlegame : null, endgame };
}

/**
 * Seconds spent on each move, from the clock after it and the same side's clock before it.
 * Returns an array indexed by ply (index 0 is null), or null when the game has no clock data.
 */
export function moveTimes(positions) {
  const control = positions.find((position) => position.practicalContext?.timeControl)?.practicalContext.timeControl;
  if (!control) return null;
  const clock = { w: control.base, b: control.base };
  const times = [null];
  let known = 0;
  for (let ply = 1; ply < positions.length; ply++) {
    const { move, practicalContext } = positions[ply];
    const after = practicalContext?.[move.color === "w" ? "whiteSeconds" : "blackSeconds"];
    if (!Number.isFinite(after) || !Number.isFinite(clock[move.color])) {
      times.push(null);
      clock[move.color] = Number.isFinite(after) ? after : null;
      continue;
    }
    times.push(Math.max(0, clock[move.color] + control.increment - after));
    clock[move.color] = after;
    known++;
  }
  return known ? times : null;
}

/** Points for an advantage chart of `count` plies: White's expected score maps to height. */
export function advantagePoints(winWhite, count, width, height) {
  const step = count > 1 ? width / (count - 1) : 0;
  return Array.from({ length: count }, (_, ply) => {
    const win = Number.isFinite(winWhite[ply]) ? Math.max(0, Math.min(100, winWhite[ply])) : 50;
    return { ply, x: ply * step, y: height - (win / 100) * height, known: Number.isFinite(winWhite[ply]) };
  });
}

/** The closed area between the line and the center, for filling above (White) and below (Black) with clips. */
export function areaPath(points, centerY) {
  if (!points.length) return "";
  const line = points.map(({ x, y }) => `L${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  return `M${points[0].x.toFixed(2)},${centerY} ${line} L${points.at(-1).x.toFixed(2)},${centerY} Z`;
}

export function linePath(points) {
  return points.map(({ x, y }, index) => `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
}

/** The ply nearest a horizontal position on a chart of `count` plies. */
export function plyAt(ratio, count) {
  return Math.round(Math.max(0, Math.min(1, ratio)) * Math.max(0, count - 1));
}

/** "12. Nf3" or "12... Nf3" for the move that produced `position`. */
export function moveLabel(position) {
  if (!position?.move) return "Start";
  const { number, color, san } = position.move;
  return `${number}${color === "w" ? "." : "..."} ${san}`;
}

/** 7 s, 42 s, 1:05, or 12:30 for a number of seconds. */
export function formatSeconds(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1).replace(/\.0$/, "") : Math.round(seconds)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
