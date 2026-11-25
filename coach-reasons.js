// Concrete reasons for an error, each checked on the board or in Stockfish's line.
// A reason says what the move allows, what the better move does, or what the move changes
// in the position. Nothing here guesses at plans; every sentence states a verifiable fact.
import { Chess } from "./vendor/chess.js/chess.js";
import { parseUciMove } from "./variation.js";

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const NAME = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const SIDE = { w: "White", b: "Black" };
// Plies after the move whose material the reasons count, plus any exchange still running.
const WINDOW = 6;
// A longer look along the line, used when the short window shows nothing.
const LONG_WINDOW = 12;
// Losses this large are blunders; their explanation must come from the line, not a side detail.
const BLUNDER_LOSS = 20;
const HOME_SQUARES = { w: ["b1", "g1", "c1", "f1"], b: ["b8", "g8", "c8", "f8"] };
const CENTER = new Set(["d4", "e4", "d5", "e5"]);
const other = (color) => (color === "w" ? "b" : "w");
const fileOf = (square) => square[0];
const rankOf = (square) => Number(square[1]);

function load(fen) {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

function material(game, color) {
  let total = 0;
  for (const piece of game.board().flat()) if (piece) total += (piece.color === color ? 1 : -1) * VALUE[piece.type];
  return total;
}

/** Play UCI moves from `fen`, stopping at the first illegal one. */
function replay(fen, line, limit = line.length) {
  const game = load(fen);
  const moves = [];
  if (!game) return { game, moves };
  for (const uci of line.slice(0, limit)) {
    const input = parseUciMove(uci);
    let move = null;
    try {
      move = input && game.move(input);
    } catch {
      move = null;
    }
    if (!move) break;
    moves.push(move);
  }
  return { game, moves };
}

/** Where a window of the line ends, extended only while an exchange is in progress. */
function windowEnd(moves, start, plies = WINDOW) {
  let end = Math.min(moves.length, start + plies);
  while (end > 0 && end < moves.length && moves[end - 1].captured && moves[end].captured) end++;
  return end;
}

function piecesWord(types) {
  const counts = {};
  for (const type of types) counts[type] = (counts[type] ?? 0) + 1;
  const words = Object.entries(counts).sort(([a], [b]) => VALUE[b] - VALUE[a]).map(([type, count]) =>
    count === 1 ? `${type === "p" ? "a" : "your"} ${NAME[type]}` : `${count === 2 ? "two" : count} ${NAME[type]}s`);
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0];
}

/**
 * What one side gives up and gets back, with equal pieces cancelled.
 * Returns { phrase, noun } from the losing side's view, or null when nothing is lost.
 */
export function describeLoss(lost, won) {
  const left = [...lost];
  const got = [...won];
  for (const type of [...got]) {
    // Knights and bishops count as equal trades.
    const match = left.findIndex((piece) => piece === type || (VALUE[piece] === 3 && VALUE[type] === 3));
    if (match >= 0) {
      left.splice(match, 1);
      got.splice(got.indexOf(type), 1);
    }
  }
  const net = left.reduce((sum, type) => sum + VALUE[type], 0) - got.reduce((sum, type) => sum + VALUE[type], 0);
  if (net < 1 || !left.length) return null;
  if (left.length === 1 && left[0] === "r" && got.length === 1 && VALUE[got[0]] === 3) {
    return { phrase: "the exchange (your rook for a minor piece)", noun: "the exchange", left };
  }
  const returned = got.length ? ` for ${piecesWord(got).replace(/\byour /g, "a ")}` : "";
  const phrase = `${piecesWord(left)}${returned}`;
  const base = left.length === 1
    ? left[0] === "p" ? "a pawn" : left[0] === "q" ? "the queen" : VALUE[left[0]] === 3 ? "a piece" : "a rook"
    : left.every((type) => type === "p") ? `${left.length === 2 ? "two" : left.length} pawns` : null;
  return { phrase, noun: base ? `${base}${returned}` : "material", left };
}

/** The pieces of `color` captured in `moves`. */
function lostBy(moves, color) {
  return moves.filter((move) => move.color !== color && move.captured).map((move) => move.captured);
}

/** Count attackers and defenders of `square` just before `move` is played on `game`. */
function defenseOf(fen, square, attacker) {
  const game = load(fen);
  if (!game) return null;
  return { attackers: game.attackers(square, attacker).length, defenders: game.attackers(square, other(attacker)).length };
}

/** The material the opponent wins in Stockfish's line after the played move, with its key capture. */
function materialLoss({ fenBefore, playedPv, color }, plies = WINDOW) {
  const { moves } = replay(fenBefore, playedPv, 1 + plies + 6);
  if (moves.length < 2) return null;
  const end = windowEnd(moves, 1, plies);
  const window = moves.slice(0, end);
  const loss = describeLoss(lostBy(window, color), lostBy(window, other(color)));
  if (!loss) return null;
  // The capture that decides the material: one of the lost pieces, preferring a capture that isn't a recapture.
  const deciding = window.map((move, index) => ({ move, index })).slice(1)
    .filter(({ move }) => move.color !== color && loss.left.includes(move.captured));
  const key = (deciding.find(({ move, index }) => window[index - 1]?.to !== move.to || !window[index - 1]?.captured) ??
    deciding[0])?.move;
  if (!key) return null;
  const index = window.indexOf(key);
  const before = replay(fenBefore, playedPv, index).game.fen();
  const square = key.isEnPassant() ? key.to[0] + key.from[1] : key.to;
  const defense = defenseOf(before, square, other(color));
  let why = "";
  if (defense?.defenders === 0) why = ", which was undefended";
  else if (defense && defense.attackers > defense.defenders) {
    why = `, which was attacked ${times(defense.attackers)} and defended ${times(defense.defenders)}`;
  }
  return {
    kind: "material", loss, key: { san: key.san, square, piece: key.captured, lead: window.slice(1, index).map(({ san }) => san) },
    underDefended: Boolean(why), why, later: plies > WINDOW,
  };
}

const times = (count) => (count === 1 ? "once" : count === 2 ? "twice" : `${count} times`);

/** Checks the opponent gives in Stockfish's line. */
function kingPressure({ fenBefore, playedPv, color }) {
  const { moves } = replay(fenBefore, playedPv, 1 + WINDOW);
  const checks = moves.slice(1).filter((move) => move.color !== color && /[+#]/.test(move.san));
  return checks.length >= 2 ? { kind: "king", checks: checks.map(({ san }) => san) } : null;
}

function isPassed(game, square, color) {
  const file = fileOf(square).charCodeAt(0);
  const rank = rankOf(square);
  for (const piece of game.board().flat()) {
    if (!piece || piece.type !== "p" || piece.color === color) continue;
    const ahead = color === "w" ? rankOf(piece.square) > rank : rankOf(piece.square) < rank;
    if (ahead && Math.abs(fileOf(piece.square).charCodeAt(0) - file) <= 1) return false;
  }
  return true;
}

/** An opponent pawn that Stockfish's line pushes at least twice as a passed pawn, or promotes. */
function runningPawn({ fenBefore, playedPv, color }) {
  const { moves } = replay(fenBefore, playedPv, 1 + WINDOW + 2);
  const pushes = new Map();
  let game = load(fenBefore);
  for (const move of moves) {
    game.move(move.san);
    if (move.color === color || move.piece !== "p") continue;
    if (move.promotion) return { kind: "passer", square: move.to, promotes: true };
    const count = (pushes.get(move.from) ?? 0) + 1;
    pushes.delete(move.from);
    pushes.set(move.to, count);
    if (count >= 2 && isPassed(game, move.to, move.color)) return { kind: "passer", square: move.to, promotes: false };
  }
  return null;
}

/**
 * Material the player's best line wins. Taking back the piece the opponent just captured recovers
 * material rather than winning it, so that one recapture is left out of the count.
 */
function missedGain({ fenBefore, previousUci, previousCaptured, bestPv, color }) {
  const { moves } = replay(fenBefore, bestPv, WINDOW + 6);
  if (!moves.length) return null;
  const window = moves.slice(0, windowEnd(moves, 1));
  const target = previousCaptured && previousUci ? previousUci.slice(2, 4) : null;
  const recapture = target ? window.findIndex((move) => move.color === color && move.captured && move.to === target) : -1;
  const counted = window.filter((_, index) => index !== recapture);
  const gain = describeLoss(lostBy(counted, other(color)), lostBy(counted, color));
  return gain ? { kind: "gain", gain } : null;
}

/** The best move takes back a piece the opponent just captured, and the played move doesn't. */
function missedRecapture({ previousUci, previousCaptured, bestPv, playedUci }) {
  if (!previousUci || !previousCaptured || !bestPv[0]) return null;
  const target = previousUci.slice(2, 4);
  if (bestPv[0].slice(2, 4) !== target || playedUci.slice(2, 4) === target) return null;
  return { kind: "recapture", square: target };
}

function castled(game, color) {
  const [king] = game.findPiece({ type: "k", color });
  return king && (color === "w" ? ["g1", "h1", "c1", "b1"] : ["g8", "h8", "c8", "b8"]).includes(king) ? king : null;
}

/** Facts about the played move itself. */
function playedFacts({ fenBefore, fenAfter, playedUci, color, phase }) {
  const before = load(fenBefore);
  const after = load(fenAfter);
  if (!before || !after) return null;
  const input = parseUciMove(playedUci);
  const moved = before.get(input?.from);
  if (!moved) return null;
  const rightsBefore = before.getCastlingRights(color);
  const rightsAfter = after.getCastlingRights(color);
  const isCastle = moved.type === "k" && Math.abs(input.from.charCodeAt(0) - input.to.charCodeAt(0)) === 2;
  if (moved.type === "k" && !isCastle && (rightsBefore.k || rightsBefore.q) && !rightsAfter.k && !rightsAfter.q) {
    return { kind: "castling" };
  }
  const king = castled(before, color);
  const shieldFiles = king && (["g", "h"].includes(fileOf(king)) ? ["f", "g", "h"] : ["a", "b", "c"]);
  const homeRank = color === "w" ? 2 : 7;
  if (moved.type === "p" && king && shieldFiles.includes(fileOf(input.from)) && rankOf(input.from) === homeRank) {
    return { kind: "shield", king };
  }
  const home = HOME_SQUARES[color].filter((square) => before.get(square)?.color === color &&
    VALUE[before.get(square).type] === 3);
  // Only the queen's first move counts, not a queen that is already out or a queen trade.
  if (moved.type === "q" && phase === "opening" && home.length && input.from === (color === "w" ? "d1" : "d8")) {
    return { kind: "queen", home: home.length };
  }
  if (["n", "b", "r", "q"].includes(moved.type)) {
    const towardHome = color === "w" ? rankOf(input.to) < rankOf(input.from) : rankOf(input.to) > rankOf(input.from);
    const reach = (fen, square) => {
      const parts = fen.split(" ");
      parts[1] = color;
      parts[3] = "-";
      const game = load(parts.join(" "));
      return game ? game.moves({ square, verbose: true }).length : null;
    };
    const was = reach(fenBefore, input.from);
    const now = reach(fenAfter, input.to);
    if (towardHome && was !== null && now !== null && was - now >= 3) {
      return { kind: "passive", piece: moved.type, square: input.to, was, now };
    }
  }
  return null;
}

/** What the best move does, stated as board facts. */
function bestFacts({ fenBefore, bestUci, color, phase }) {
  const game = load(fenBefore);
  const input = parseUciMove(bestUci ?? "");
  if (!game || !input) return null;
  const moved = game.get(input.from);
  let move;
  try {
    move = game.move(input);
  } catch {
    return null;
  }
  if (!moved || !move) return null;
  if (move.isKingsideCastle() || move.isQueensideCastle()) return { san: move.san, does: "castles your king" };
  if (move.captured) return { san: move.san, does: `takes the ${NAME[move.captured]} on ${move.to}` };
  if (phase === "opening" && VALUE[moved.type] === 3 && HOME_SQUARES[color].includes(input.from)) {
    return { san: move.san, does: `develops your ${NAME[moved.type]}` };
  }
  if (moved.type === "r") {
    const file = fileOf(input.to);
    const pawns = game.board().flat().filter((piece) => piece?.type === "p" && fileOf(piece.square) === file);
    if (!pawns.length) return { san: move.san, does: `puts your rook on the open ${file}-file` };
    if (!pawns.some((piece) => piece.color === color)) return { san: move.san, does: `puts your rook on the half-open ${file}-file` };
  }
  if (moved.type === "p" && !move.captured && isPassed(game, input.to, color)) {
    return { san: move.san, does: `pushes your passed pawn to ${input.to}` };
  }
  const attacked = game.board().flat().filter((piece) => piece && piece.color !== color && piece.type !== "k" &&
    game.attackers(piece.square, color).includes(input.to) &&
    (VALUE[piece.type] > VALUE[moved.type] || !game.attackers(piece.square, other(color)).length));
  if (attacked.length && !move.captured) {
    const [target] = attacked.sort((a, b) => VALUE[b.type] - VALUE[a.type]);
    return { san: move.san, does: `attacks the ${NAME[target.type]} on ${target.square}` };
  }
  if (moved.type === "n" && CENTER.has(input.to)) return { san: move.san, does: `brings your knight to ${input.to} in the center` };
  if (/\+$/.test(move.san)) return { san: move.san, does: "gives check" };
  return null;
}

function lineSan(fen, line, count) {
  return replay(fen, line, count).moves.map(({ san }) => san).join(" ");
}

/**
 * Reasons for an error. Inputs are FENs, UCI lines, the player's color and the game phase.
 * Returns { consequence, better, fact, bestLine } with null for anything that couldn't be verified.
 */
export function explainError({
  fenEarlier, fenBefore, fenAfter, previousUci, previousCaptured, playedUci, playedPv = [], bestPv = [], color, phase,
  winLoss = 0,
}) {
  if (!fenBefore || !fenAfter || playedPv[0] !== playedUci || (color !== "w" && color !== "b")) return null;
  const context = { fenEarlier, fenBefore, fenAfter, previousUci, previousCaptured, playedUci, playedPv, bestPv, color, phase };
  const bestDiffers = bestPv[0] && bestPv[0] !== playedUci;
  const blunder = winLoss >= BLUNDER_LOSS;
  return {
    blunder,
    consequence: materialLoss(context) ?? kingPressure(context) ?? runningPawn(context) ??
      (blunder ? materialLoss(context, LONG_WINDOW) : null),
    better: bestDiffers ? missedRecapture(context) ?? missedGain(context) : null,
    bestFact: bestDiffers ? bestFacts({ fenBefore, bestUci: bestPv[0], color, phase }) : null,
    fact: playedFacts(context),
    bestLine: bestDiffers ? lineSan(fenBefore, bestPv, 4) : "",
  };
}

/** Every tag describeError can return, for the weakness report's theme table. */
export const REASON_TAGS = [
  "Hanging Piece", "Lost Material", "King Exposed", "Passed Pawn", "Castling Rights", "King Shield", "Early Queen",
  "Passive Piece", "Missed Recapture", "Missed Tactic",
];

/**
 * Turn reasons into the coach card's title, text and tag. `san` is the played move, `bestSan` the best one.
 * Returns null when no reason could be verified, so the caller keeps its general wording.
 */
export function describeError(reasons, { san, bestSan, color }) {
  if (!reasons) return null;
  const opponent = SIDE[other(color)];
  const { consequence, better, bestFact, fact } = reasons;
  const sentences = [];
  let title = null;
  let tag = null;

  if (consequence?.kind === "material") {
    const { loss, key, why, later } = consequence;
    if (later) {
      // A loss further along the line: name the line's capture, without claiming it is immediate.
      const lead = key.lead.length && key.lead.length <= 6 ? `after ${key.lead.join(" ")}, ` : "";
      sentences.push(`Further along Stockfish's line, ${opponent} wins ${loss.phrase}: ${lead}${key.san} takes the ` +
        `${NAME[key.piece]} on ${key.square}${why}.`);
    } else {
      const lead = key.lead.length ? `after ${key.lead.join(" ")}, ` : "";
      sentences.push(`${opponent} wins ${loss.phrase}: ${lead}${key.san} takes the ${NAME[key.piece]} on ${key.square}${why}.`);
    }
    title = `${san} loses ${loss.noun}`;
    tag = consequence.underDefended ? "Hanging Piece" : "Lost Material";
  } else if (consequence?.kind === "king") {
    const [first, ...rest] = consequence.checks;
    sentences.push(`Your king comes under fire: Stockfish's line gives ${consequence.checks.length} checks, ` +
      `starting with ${first}${rest.length ? ` and then ${rest[0]}` : ""}.`);
    title = `${san} exposes your king`;
    tag = "King Exposed";
  } else if (consequence?.kind === "passer") {
    sentences.push(consequence.promotes
      ? `${opponent}'s pawn promotes on ${consequence.square} in Stockfish's line.`
      : `${opponent}'s passed pawn runs to ${consequence.square} in Stockfish's line.`);
    title = `${san} lets ${opponent}'s pawn run`;
    tag = "Passed Pawn";
  }

  if (!consequence && fact) {
    const facts = {
      castling: [`${san} moves your king and gives up castling.`, `${san} gives up castling`, "Castling Rights"],
      shield: [`${san} moves a pawn in front of your castled king on ${fact.king}.`, `${san} loosens your king's cover`, "King Shield"],
      queen: [`${san} brings the queen out while ${fact.home === 1 ? "a minor piece is" : `${fact.home} minor pieces are`} still at home.`,
        `${san} brings the queen out early`, "Early Queen"],
      passive: [`${san} pulls your ${NAME[fact.piece]} back to ${fact.square}, where it has ${fact.now} moves instead of ${fact.was}.`,
        `${san} pulls your ${NAME[fact.piece]} back`, "Passive Piece"],
    }[fact.kind];
    sentences.push(facts[0]);
    title = facts[1];
    tag = facts[2];
  }

  if (better?.kind === "recapture") {
    sentences.push(`${bestSan} takes back on ${better.square}.`);
    title ??= `${san} doesn't take back`;
    tag ??= "Missed Recapture";
  } else if (better?.kind === "gain") {
    sentences.push(`${bestSan} wins ${better.gain.phrase.replace(/\byour /g, "a ")} in Stockfish's line.`);
    title ??= `${san} misses winning ${better.gain.noun === "the queen" ? "the queen" : better.gain.noun}`;
    tag ??= "Missed Tactic";
  } else if (bestFact && (!reasons.blunder || consequence)) {
    // What the better move does is a fact, not the cause; a blunder's cause has to come from the line.
    sentences.push(`Stockfish prefers ${bestFact.san}, which ${bestFact.does}.`);
  }

  if (!sentences.length) return null;
  // Sentences start with a side, "Your", "Stockfish", or a move in algebraic notation, which keeps its case.
  return { title, text: sentences.join(" "), tag };
}
