// A reviewed game as PGN, with the review written into it the way Lichess exports computer analysis:
// an evaluation and clock time after every move, move grades as NAGs, and after each mistake a
// comment naming the better move followed by Stockfish's line as a variation.

/** Standard NAGs: $1 good (!), $2 mistake (?), $3 brilliant (!!), $4 blunder (??), $6 dubious (?!). */
export const GRADE_NAG = { brilliant: 3, great: 1, inaccuracy: 6, mistake: 2, miss: 2, blunder: 4 };
const GRADE_WORD = { inaccuracy: "Inaccuracy", mistake: "Mistake", miss: "Miss", blunder: "Blunder" };
const SEVEN_TAGS = ["Event", "Site", "Date", "Round", "White", "Black", "Result"];

/** "Mistake. g4 was best." for the grades that get a comment, otherwise "". */
export function mistakeComment(grade, bestSan) {
  const word = GRADE_WORD[grade];
  if (!word) return "";
  return bestSan ? `${word}. ${bestSan} was best.` : `${word}.`;
}

/** [%eval 0.52] or [%eval #-3], from White's side. Empty for a finished game or no evaluation. */
export function evalTag(evaluation) {
  if (!evaluation || !Number.isFinite(evaluation.value)) return "";
  if (evaluation.type === "mate") return evaluation.value ? `[%eval #${evaluation.value}]` : "";
  return `[%eval ${(evaluation.value / 100).toFixed(2)}]`;
}

/** [%clk 0:02:58], with tenths when the clock had them. */
export function clockTag(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const tenths = Math.round(seconds * 10);
  const whole = Math.floor(tenths / 10);
  const h = Math.floor(whole / 3600);
  const m = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
  const s = String(whole % 60).padStart(2, "0");
  return `[%clk ${h}:${m}:${s}${tenths % 10 ? `.${tenths % 10}` : ""}]`;
}

/** "(+0.52 → −3.20)": the evaluation before and after a move, as Lichess writes it in a comment. */
export function swingText(before, after) {
  const value = (evaluation) => {
    if (!evaluation) return "?";
    if (evaluation.type === "mate") return evaluation.value ? `#${evaluation.value}` : "#";
    return (evaluation.value / 100).toFixed(2);
  };
  return `(${value(before)} → ${value(after)})`;
}

const escapeTag = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
// A brace ends a PGN comment, so it can't appear inside one.
const escapeComment = (text) => text.replace(/[{}]/g, "");

/**
 * The game as PGN text.
 * `headers`: the original tags; the Seven Tag Roster comes first, then the rest in their order.
 * `moves`: one entry per move, in order: { san, color, number, nag?, eval?, clock?, comment?, variation? },
 *   where `variation` is the better line from the position before the move, as lineSteps returns it.
 */
export function annotatedPgn({ headers = {}, moves = [], annotator = "" }) {
  const tags = { ...headers };
  const result = tags.Result || "*";
  if (annotator) tags.Annotator = annotator;
  let rest = Object.keys(tags).filter((key) => !SEVEN_TAGS.includes(key));
  // A game from a set-up position needs SetUp "1" before its FEN, or strict readers ignore the FEN.
  if (tags.FEN && !tags.SetUp) {
    tags.SetUp = "1";
    rest = rest.filter((key) => key !== "SetUp");
    rest.splice(rest.indexOf("FEN"), 0, "SetUp");
  }
  const keys = [...SEVEN_TAGS, ...rest];
  const header = keys.map((key) => `[${key} "${escapeTag(tags[key] ?? (key === "Result" ? result : "?"))}"]`);

  const tokens = [];
  let needsNumber = true;
  for (const move of moves) {
    if (move.color === "w") tokens.push(`${move.number}.`);
    else if (needsNumber) tokens.push(`${move.number}...`);
    tokens.push(move.san + (move.nag ? ` $${move.nag}` : ""));
    const comment = [evalTag(move.eval), clockTag(move.clock), move.comment ? escapeComment(move.comment) : ""]
      .filter(Boolean).join(" ");
    if (comment) tokens.push(`{ ${comment} }`);
    if (move.variation?.length) {
      tokens.push(`( ${move.variation.map(({ number, san }) => (number ? `${number} ${san}` : san)).join(" ")} )`);
    }
    // After a comment or variation, Black's next move needs its number again.
    needsNumber = Boolean(comment || move.variation?.length);
  }
  tokens.push(result);
  return `${header.join("\n")}\n\n${tokens.join(" ")}\n`;
}

/** A file name such as "ChessBot_vmpc_vs_adamsoyadam_2026.10.01.pgn". */
export function pgnFileName(headers = {}) {
  const clean = (value) => String(value || "").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  const parts = ["ChessBot", clean(headers.White) || "White", "vs", clean(headers.Black) || "Black"];
  if (headers.Date && !String(headers.Date).includes("?")) parts.push(clean(headers.Date));
  return `${parts.join("_")}.pgn`;
}
