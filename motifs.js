// Names the tactic in a verified engine line: fork, pin, skewer, discovered attack, and so on.
// Every claim is checked on the board with chess.js, and a tactic is named only when the line
// wins material or mates, so the coach never describes a pattern the line doesn't use.
import { Chess } from "./vendor/chess.js/chess.js";
import { parseUciMove } from "./variation.js";

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const PIECE_NAME = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const MAX_LINE = 10;
// A tactic must win at least this much material (in pawns) unless it mates.
const MIN_GAIN = 2;
// The win must come within this many plies after the tactic's move, plus any exchange still running.
const PAYOFF_PLIES = 5;
// Mates up to this many plies into the line (mate in 3) are named as the line's tactic.
const MATE_PLIES = 4;
const ROOK_RAYS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_RAYS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

const fileOf = (square) => square.charCodeAt(0) - 97;
const rankOf = (square) => Number(square[1]) - 1;
const squareAt = (file, rank) => file >= 0 && file < 8 && rank >= 0 && rank < 8
  ? String.fromCharCode(97 + file) + (rank + 1) : null;
const other = (color) => (color === "w" ? "b" : "w");

function material(game, color) {
  let total = 0;
  for (const row of game.board()) {
    for (const piece of row) {
      if (piece) total += (piece.color === color ? 1 : -1) * VALUE[piece.type];
    }
  }
  return total;
}

function piecesOf(game, color) {
  return game.board().flat().filter((piece) => piece?.color === color);
}

/** Enemy pieces that the piece on `square` attacks. */
function attackedBy(game, square) {
  const attacker = game.get(square);
  if (!attacker) return [];
  return piecesOf(game, other(attacker.color))
    .filter((target) => game.attackers(target.square, attacker.color).includes(square));
}

function rays(type) {
  if (type === "b") return BISHOP_RAYS;
  if (type === "r") return ROOK_RAYS;
  return type === "q" ? [...ROOK_RAYS, ...BISHOP_RAYS] : [];
}

/** The first two pieces met along a ray from `square`. */
function lineFrom(game, square, [df, dr]) {
  const met = [];
  let file = fileOf(square) + df;
  let rank = rankOf(square) + dr;
  for (let next = squareAt(file, rank); next && met.length < 2; next = squareAt(file += df, rank += dr)) {
    const piece = game.get(next);
    if (piece) met.push({ ...piece, square: next });
  }
  return met;
}

/**
 * Lines where a slider of `color` hits an enemy piece with another enemy piece behind it.
 * A pin has the more valuable piece (or king) behind; a skewer has it in front.
 */
function sliderLines(game, color) {
  const found = [];
  for (const slider of piecesOf(game, color)) {
    for (const ray of rays(slider.type)) {
      const [front, back] = lineFrom(game, slider.square, ray);
      if (!front || !back || front.color === color || back.color === color) continue;
      if (front.type === "k") found.push({ kind: "skewer", slider, front, back });
      else if (back.type === "k" || VALUE[back.type] > VALUE[front.type]) found.push({ kind: "pin", slider, front, back });
      else if (VALUE[front.type] >= 5 && VALUE[front.type] > VALUE[back.type]) found.push({ kind: "skewer", slider, front, back });
    }
  }
  return found;
}

const lineKey = ({ kind, slider, front, back }) => `${kind}:${slider.square}:${front.square}:${back.square}`;
const valuable = (target, attackerType, game) => target.type === "k" ||
  VALUE[target.type] > VALUE[attackerType] ||
  (VALUE[target.type] >= 3 && !game.attackers(target.square, target.color).length);

function play(game, uci) {
  const input = parseUciMove(uci);
  if (!input) return null;
  try {
    return game.move(input);
  } catch {
    return null;
  }
}

function backRankMate(game) {
  const loser = game.turn();
  const [king] = game.findPiece({ type: "k", color: loser });
  const home = loser === "w" ? 0 : 7;
  if (!king || rankOf(king) !== home) return false;
  const checkers = game.attackers(king, other(loser)).map((square) => game.get(square));
  return checkers.length === 1 && (checkers[0].type === "r" || checkers[0].type === "q") &&
    game.attackers(king, other(loser)).every((square) => rankOf(square) === home);
}

/** Classify the tactic that `move` (already played on `game`) carries out. */
function classify(before, game, move) {
  const mover = move.color;
  if (game.isCheckmate()) {
    return { kind: backRankMate(game) ? "back-rank mate" : "checkmate", attacker: move.to, targets: [] };
  }
  const [king] = game.findPiece({ type: "k", color: other(mover) });
  const checkers = game.isCheck() ? game.attackers(king, mover) : [];
  if (checkers.length >= 2) {
    return { kind: "double check", attacker: move.to, targets: [{ square: king, type: "k" }], checkers };
  }

  // A discovered attack: another piece's line opens because this one moved.
  const opened = [];
  for (const slider of piecesOf(game, mover)) {
    const earlier = before.get(slider.square);
    // Skip pieces that moved this turn, including a castling rook.
    if (!rays(slider.type).length || earlier?.type !== slider.type || earlier.color !== mover) continue;
    for (const target of attackedBy(game, slider.square)) {
      const wasAttacked = before.attackers(target.square, mover).includes(slider.square);
      if (!wasAttacked && before.get(target.square)?.type === target.type && valuable(target, slider.type, game)) {
        opened.push({ slider, target });
      }
    }
  }
  const discovered = opened.find(({ target }) => target.type === "k") ?? opened[0];
  if (discovered) {
    return {
      kind: discovered.target.type === "k" ? "discovered check" : "discovered attack",
      attacker: discovered.slider.square,
      targets: [discovered.target, ...attackedBy(game, move.to).filter((t) => valuable(t, move.piece, game))]
        .filter((t, index, all) => all.findIndex((u) => u.square === t.square) === index),
    };
  }

  const targets = attackedBy(game, move.to).filter((target) => valuable(target, move.piece, game))
    .sort((a, b) => (b.type === "k") - (a.type === "k") || VALUE[b.type] - VALUE[a.type]);
  if (targets.length >= 2) return { kind: "fork", attacker: move.to, targets };

  // Only the moved piece pins or skewers; a line opened by moving away is a discovered attack.
  const existing = new Set(sliderLines(before, mover).map(lineKey));
  const created = sliderLines(game, mover)
    .filter((line) => line.slider.square === move.to && !existing.has(lineKey(line)));
  const line = created.find(({ kind }) => kind === "skewer") ?? created.find(({ kind }) => kind === "pin");
  if (line) return { kind: line.kind, attacker: line.slider.square, targets: [line.front, line.back] };

  if (move.captured && !game.attackers(move.to, other(mover)).length) {
    return { kind: "free capture", attacker: move.to, targets: [{ square: move.to, type: move.captured }] };
  }
  return null;
}

/**
 * Name the tactic that `line` (UCI moves from `fen`) carries out for the side to move.
 * Checks the first move and, after a forcing first move, the mover's next one.
 * The line must then win one of the attacked pieces, and the material within PAYOFF_PLIES of the
 * tactic must be at least MIN_GAIN ahead of `baselineFen` (or mate). Pass the position before the
 * current exchange as `baselineFen`, so that winning back material just lost doesn't count.
 */
export function findTactic(fen, line, { baselineFen = fen } = {}) {
  let game;
  let baseline;
  try {
    game = new Chess(fen);
    baseline = new Chess(baselineFen);
  } catch {
    return null;
  }
  const mover = game.turn();
  const start = material(baseline, mover);
  const moves = [];
  let tactic = null;
  for (const [index, uci] of line.slice(0, MAX_LINE).entries()) {
    const before = new Chess(game.fen());
    const move = play(game, uci);
    if (!move) break;
    moves.push(move);
    if (move.color === mover && index <= 2 && !tactic) {
      const found = classify(before, game, move);
      // A capture that nothing can take back is a tactic only as the line's first move.
      if (found && !(found.kind === "free capture" && index > 0)) tactic = { ...found, ply: index, move };
      // Only a forcing first move (check or capture) leads into the tactic on the next turn.
      else if (index === 0 && !move.san.includes("+") && !move.captured) break;
    }
    if (game.isCheckmate()) break;
  }
  // A short forced mate is the point of the line, whatever the first move looks like.
  const mateAt = moves.length - 1;
  if (game.isCheckmate() && game.turn() !== mover && mateAt <= MATE_PLIES) {
    tactic = { kind: backRankMate(game) ? "back-rank mate" : "checkmate", attacker: moves[mateAt].to, targets: [],
      ply: mateAt, move: moves[mateAt] };
  }
  if (!tactic) return null;

  // Finish any exchange still running at the end of the window.
  let end = tactic.ply + PAYOFF_PLIES + 1;
  while (end < moves.length && moves[end - 1].captured && moves[end].captured) end++;
  const payoff = moves.slice(tactic.ply, end);
  const settled = replayTo(fen, moves, tactic.ply + payoff.length);
  const mates = settled.isCheckmate() && settled.turn() !== mover;
  const gain = material(settled, mover) - start;
  if (!mates && (gain < MIN_GAIN || !winsTarget(tactic, payoff))) return null;

  return {
    kind: tactic.kind,
    ply: tactic.ply,
    san: tactic.move.san,
    from: tactic.move.from,
    to: tactic.move.to,
    piece: tactic.move.piece,
    attacker: tactic.attacker,
    attackerPiece: replayTo(fen, moves, tactic.ply + 1).get(tactic.attacker)?.type ?? tactic.move.piece,
    targets: tactic.targets.map(({ square, type }) => ({ square, piece: type })),
    lead: moves.slice(0, tactic.ply).map(({ san }) => san),
    checkers: tactic.checkers ?? [],
    gain,
    promotes: payoff.some(({ color, promotion }) => color === mover && promotion),
    mates,
  };
}

/** Whether the mover captures one of the attacked pieces, following each piece if it moves. */
function winsTarget(tactic, payoff) {
  const [move, ...rest] = payoff;
  if (tactic.kind === "free capture") return true;
  const mover = move.color;
  const tracked = new Set(tactic.targets.filter(({ type }) => type !== "k").map(({ square }) => square));
  // A double check wins by force; any capture it leads to counts.
  if (tactic.kind === "double check") return rest.some(({ color, captured }) => color === mover && captured);
  for (const next of rest) {
    if (next.color === mover) {
      if (next.captured && tracked.has(next.to)) return true;
    } else if (tracked.has(next.from)) {
      tracked.delete(next.from);
      tracked.add(next.to);
    }
  }
  return false;
}

/** Arrows for the board, in the position right after the tactic's move. Empty when the tactic comes later in the line. */
export function tacticArrows(tactic) {
  if (!tactic || tactic.ply > 0) return [];
  const { kind, attacker, to, targets } = tactic;
  if (kind === "fork") return targets.map(({ square }) => [to, square]);
  if (kind === "pin" || kind === "skewer") return [[attacker, targets[1].square]];
  if (kind === "discovered check" || kind === "discovered attack") {
    const [first, ...rest] = targets;
    return [[attacker, first.square], ...rest.map(({ square }) => [to, square])];
  }
  if (kind === "double check") return tactic.checkers.map((square) => [square, targets[0].square]);
  return [];
}

const ERROR_GRADES = new Set(["inaccuracy", "mistake", "miss", "blunder"]);
const PRAISED_GRADES = new Set(["brilliant", "great", "best", "excellent"]);

/**
 * The tactics behind one reviewed move: the one the opponent can play after an error, the one
 * the player missed, and the one a strong move carries out. Each comes from Stockfish's own line.
 */
export function reviewTactics({
  fenEarlier, fenBefore, fenAfter, playedUci, grade, playedPv = [], bestPv = [],
}) {
  const playedLine = playedPv[0] === playedUci;
  // Material is measured from before the exchange in progress: the opponent's last move for the
  // player's own tactics, and the played move for the opponent's reply.
  const own = { baselineFen: fenEarlier ?? fenBefore };
  if (ERROR_GRADES.has(grade)) {
    return {
      allowed: playedLine ? findTactic(fenAfter, playedPv.slice(1), { baselineFen: fenBefore }) : null,
      missed: bestPv[0] && bestPv[0] !== playedUci ? findTactic(fenBefore, bestPv, own) : null,
      found: null,
    };
  }
  return {
    allowed: null, missed: null,
    found: PRAISED_GRADES.has(grade) && playedLine ? findTactic(fenBefore, playedPv, own) : null,
  };
}

function replayTo(fen, moves, count) {
  const game = new Chess(fen);
  for (const move of moves.slice(0, count)) game.move(move.san);
  return game;
}

export const TACTIC_LABEL = {
  fork: "Fork", pin: "Pin", skewer: "Skewer", "discovered check": "Discovered Check",
  "discovered attack": "Discovered Attack", "double check": "Double Check", "back-rank mate": "Back-Rank Mate",
  checkmate: "Checkmate", "free capture": "Hanging Piece",
};

const SIDE = { w: "White", b: "Black" };
const points = (gain) => `${gain} ${gain === 1 ? "point" : "points"} of material`;
const list = (items) => items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "";

/** The tactic's name with its piece, as in "knight fork" or "bishop skewer". */
export function tacticName(tactic) {
  const piece = PIECE_NAME[tactic.attackerPiece];
  if (["fork", "pin", "skewer"].includes(tactic.kind) && piece) return `${piece} ${tactic.kind}`;
  if (tactic.kind === "free capture") return "free capture";
  return tactic.kind;
}

/**
 * Explain a tactic from the reviewed player's side. `owner` is "player" when the reviewed player
 * plays it (found or missed) and "opponent" when the opponent plays it against them.
 * `color` is the color of the side that plays the tactic.
 */
export function describeTactic(tactic, { owner, color, missed = false }) {
  const yours = owner === "opponent" ? "your " : "the ";
  const piece = (target) => `${yours}${PIECE_NAME[target.piece]} on ${target.square}`;
  const [front, back] = tactic.targets;
  const move = tactic.san;
  let core;
  switch (tactic.kind) {
    case "fork":
      core = `${move} attacks ${list(tactic.targets.map(piece))}.`;
      break;
    case "pin":
      core = `${move} pins ${piece(front)} to ${piece(back)}.`;
      break;
    case "skewer":
      core = `${move} attacks ${piece(front)}; once it moves, ${piece(back)} behind it is lost.`;
      break;
    case "discovered check":
    case "discovered attack": {
      const [first, ...rest] = tactic.targets;
      core = `${move} uncovers the ${PIECE_NAME[tactic.attackerPiece]} on ${tactic.attacker}, which ` +
        `${first.piece === "k" ? "gives check" : `attacks ${piece(first)}`}` +
        `${rest.length ? `, while the moved piece hits ${list(rest.map(piece))}` : ""}.`;
      break;
    }
    case "double check":
      core = `${move} checks with two pieces at once, so the king has to move.`;
      break;
    case "back-rank mate":
      core = `${move} mates on the back rank: the king is trapped behind its own pawns.`;
      break;
    case "checkmate":
      core = `${move} ends the game.`;
      break;
    default:
      core = `${move} takes ${owner === "opponent" ? "your" : "the"} undefended ${PIECE_NAME[front.piece]} on ${front.square}.`;
  }
  const name = tacticName(tactic);
  const article = tactic.kind === "checkmate" ? "" : /^[aeiou]/.test(name) ? "an " : "a ";
  // A mate a few moves ahead is forced, not immediate.
  const verb = tactic.mates && tactic.lead.length ? "forces" : null;
  const opening = owner === "opponent" ? `${SIDE[color]} ${verb ?? "has"} ${article}${name}. `
    : missed ? `You missed ${article}${name}. ` : `This ${verb ?? "is"} ${article}${name}. `;
  const lead = tactic.lead.length ? `After ${tactic.lead.join(" ")}, ` : "";
  const outcome = tactic.mates ? ""
    : ` In Stockfish's line, ${owner === "opponent" ? `${SIDE[color]} wins` : missed ? "you would win" : "you win"} ` +
      `${points(tactic.gain)}${tactic.promotes ? ", counting the promotion" : ""}.`;
  return `${opening}${lead}${core}${outcome}`;
}
