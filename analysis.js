import { Chess, DEFAULT_POSITION } from "./vendor/chess.js/chess.js";
import {
  GRADE_LOSS_LIMITS,
  IncompleteStockfishSearch,
  PIECE_VALUES,
  classifyMove,
  computeMaterialBalanceFromFen,
  computeMoveCpLoss,
  evalToWinWhite,
  winLossToAccuracy,
} from "./engine.js";
import { parseClockSeconds, parseTimeControl, practicalImpact } from "./practical-model.js";
import { estimateDifficulty, readLichessRatings } from "./difficulty-model.js";
import { detectMissedMate } from "./tactics.js";

const moverScore = (whiteScore, color) => color === "w" ? whiteScore : 100 - whiteScore;

/**
 * Extra search for one reviewed decision. Depths are added to the review depth.
 *
 * broadPass chooses when the third, broader pass runs after the confirming pass:
 * - "grade-at-risk" (default): the grade changed, Great/Brilliant praise did not hold, or a
 *   same-grade loss moved by more than PASS_AGREEMENT_LOSS points toward a severity line
 *   (Inaccuracy/Mistake at 10, Mistake/Blunder at 20) far enough to reach it at the same rate.
 * - "grade-change": only the first two conditions.
 * - "unstable": the v3.3 rule, which reran every same-grade loss that moved by more than 2.5 points.
 * - "never" and "always" exist for the search benchmark.
 * research/search-policy-2026-11.json has the comparison that chose the default.
 */
export const SEARCH_POLICY = {
  confirmDepth: 2,
  broadDepth: 4,
  broadWidth: 3,
  broadPass: "grade-at-risk",
};
const PASS_AGREEMENT_LOSS = 2.5;
const SEVERITY_LIMITS = [GRADE_LOSS_LIMITS.inaccuracy, GRADE_LOSS_LIMITS.mistake];
const DEEP_CHECK_PASSES = [1_500_000, 3_000_000];
const DEEP_CHECK_MAX_DEPTH = 26;

export function terminalPosition(game, last = false, result) {
  const mate = game.isCheckmate();
  const draw = game.isStalemate() || game.isInsufficientMaterial() ||
    (last && result === "1/2-1/2" && game.isDraw());
  if (!mate && !draw) return null;
  const winner = mate ? (game.turn() === "b" ? 1 : -1) : 0;
  return {
    checkmate: mate,
    eval: { type: mate ? "mate" : "cp", value: winner },
    winWhite: 50 + winner * 50,
    wdl: { win: winner > 0 ? 1000 : 0, draw: draw ? 1000 : 0, loss: winner < 0 ? 1000 : 0 },
    pv: [], secondPv: [], lines: [], bestMove: null, depth: 0,
  };
}

export function parseReviewGame(pgn, archiveTimeControl) {
  const parser = new Chess();
  // chess.js expects one comment per move. Keep braces in line comments as text.
  const withBraceComments = pgn.replace(/"(?:\\.|[^"\\])*"|\{[^{}]*\}|;[^\r\n]*|^%[^\r\n]*/gm, (token) => {
    if (token.startsWith(";")) return `{${token.slice(1).replace(/[{}]/g, " ")}}`;
    return token.startsWith("%") ? "" : token;
  });
  // Lichess can emit adjacent draw-offer and clock comments for a single move.
  const combined = withBraceComments.replace(/"(?:\\.|[^"\\])*"|\{[^{}]*\}(?:\s*\{[^{}]*\})+/g,
    (block) => block.startsWith("{") ? block.replace(/\}\s*\{/g, " ") : block);
  parser.loadPgn(combined);
  const headers = parser.getHeaders();
  const history = parser.history({ verbose: true });
  if (!history.length) throw new Error("No legal chess moves found in this PGN.");

  const initialFen = history[0].before;
  const game = new Chess(initialFen);
  const tag = headers.TimeControl;
  const rawTimeControl = tag && tag !== "?" ? tag : archiveTimeControl;
  const timeControl = parseTimeControl(rawTimeControl);
  const practicalSupported = initialFen === DEFAULT_POSITION && (!rawTimeControl || timeControl) &&
    headers.WhiteTitle !== "BOT" && headers.BlackTitle !== "BOT";
  const comments = practicalSupported && timeControl
    ? new Map(parser.getComments().map(({ fen, comment }) => [fen, comment]))
    : new Map();
  const clocks = { w: null, b: null };
  const lichessRatings = readLichessRatings(headers);
  const played = [];
  const positions = [];
  for (let ply = 0; ply <= history.length; ply++) {
    let move = null;
    if (ply > 0) {
      const { from, to, san, color, piece, captured, promotion } = game.move(history[ply - 1]);
      const uci = `${from}${to}${promotion || ""}`;
      move = { from, to, san, uci, color, piece, captured, promotion,
        number: Number(positions[ply - 1].fen.split(" ")[5]),
      };
      played.push(uci);
    }
    const fen = game.fen();
    if (move && timeControl) clocks[move.color] = parseClockSeconds(comments.get(fen));
    positions.push({
      ply, fen, move,
      ...describePosition(game, fen),
      lichessRatings,
      searchOptions: { initialFen, history: played.slice() },
      terminal: terminalPosition(game, ply === history.length, headers.Result),
      practicalContext: practicalSupported ? {
        ply, timeControl, whiteSeconds: clocks.w, blackSeconds: clocks.b,
      } : null,
    });
  }
  return { headers, positions };
}

function describePosition(game, fen) {
  const [placement, , , , , fullMove] = fen.split(" ");
  const pieces = placement.toLowerCase().match(/[nbrq]/g) ?? [];
  const material = pieces.reduce((sum, piece) => sum + PIECE_VALUES[piece], 0);
  const endgame = material <= 22 || (!pieces.includes("q") && material <= 28);
  const opening = !endgame && Number(fullMove) <= 10 && material >= 48;
  const moves = game.moves();
  return {
    phase: endgame ? "endgame" : opening ? "opening" : "middlegame",
    material,
    legalMoves: moves.length,
    captureCount: moves.filter((san) => san.includes("x")).length,
    inCheck: game.isCheck(),
  };
}

export function analyzeGamePosition(engine, position, depth, multiPv = 2, nodes) {
  if (position.terminal) return Promise.resolve(position.terminal);
  return engine.analyzePosition(position.fen, depth, {
    ...position.searchOptions, multiPv: Math.min(position.legalMoves, multiPv), nodes,
  });
}

class IncompleteMoveComparison extends Error {}

async function searchRootMoves(engine, position, playedUci, depth, searchMoves, nodes) {
  try {
    const root = await engine.analyzePosition(position.fen, depth, {
      ...position.searchOptions, multiPv: searchMoves.length, searchMoves, nodes,
    });
    const played = root.lines.find((line) => line.pv[0] === playedUci);
    return root.lines.length === searchMoves.length && played ? { root, played } : null;
  } catch (error) {
    if (error instanceof IncompleteStockfishSearch) return null;
    throw error;
  }
}

export async function compareRootMoves(engine, position, playedUci, depth, root, { allowNarrowerSearch = false, nodes } = {}) {
  const played = root.lines.find((line) => line.pv[0] === playedUci);
  if (played) return { root, played };

  const searchMoves = [...new Set([...root.lines.map((line) => line.pv[0]), playedUci])];
  const comparison = await searchRootMoves(engine, position, playedUci, depth, searchMoves, nodes);
  if (comparison) return comparison;

  if (allowNarrowerSearch && searchMoves.length > 2) {
    const narrower = await searchRootMoves(engine, position, playedUci, depth, [root.bestMove, playedUci], nodes);
    if (narrower) return { ...narrower, incomplete: true };
  }
  throw new IncompleteMoveComparison("Stockfish did not finish comparing the played move with its alternatives.");
}

function sacrificeInLine(before, after, played) {
  const { move } = after;
  const reply = played.pv[1];
  if (PIECE_VALUES[move.piece] < 3 || !reply || reply.slice(2, 4) !== move.to) return false;

  const game = new Chess(before.fen);
  try {
    for (const uci of played.pv.slice(0, 5)) game.move(uci);
  } catch {
    return false;
  }
  const sign = move.color === "w" ? 1 : -1;
  return sign * (computeMaterialBalanceFromFen(before.fen) - computeMaterialBalanceFromFen(game.fen())) >= 2;
}

function estimateImpact(before, after, root, played) {
  if (before.legalMoves < 2 || after.terminal) return null;
  return practicalImpact(root.eval, played.eval, after.practicalContext, after.move.color);
}

function gradeInputs(before, after, { root, played }) {
  const { move } = after;
  const forced = before.legalMoves === 1;
  const playedEval = forced ? root : after.terminal ?? played;
  return {
    playedEval,
    forced,
    grade: {
      playedUci: move.uci,
      bestMoveUci: root.bestMove,
      winBefore: moverScore(root.winWhite, move.color),
      winAfter: moverScore(playedEval.winWhite, move.color),
      legalMoves: before.legalMoves,
      secondScore: Number.isFinite(root.secondWinWhite) ? moverScore(root.secondWinWhite, move.color) : null,
      equivalentBest: root.eval.type === playedEval.eval.type && root.eval.value === playedEval.eval.value,
      isSacrifice: !forced && sacrificeInLine(before, after, played),
      missedMate: forced ? null : detectMissedMate(root.eval, playedEval.eval, move.color),
    },
  };
}

function signal(before, after, comparison, prevOpponentWinLoss) {
  const { grade } = gradeInputs(before, after, comparison);
  return { ...classifyMove({ ...grade, confirmed: true, prevOpponentWinLoss }), sacrifice: grade.isSacrifice };
}

function agreesAtDepth(previous, current) {
  return previous.key === current.key && Math.abs(previous.winLoss - current.winLoss) <= PASS_AGREEMENT_LOSS;
}

const isPraise = ({ key }) => key === "brilliant" || key === "great";
const comparisonDepth = ({ root, played }) => Math.min(root.depth, played.depth);
const describePass = (comparison, { key, winLoss }) => ({
  depth: comparisonDepth(comparison), key, winLoss,
});

export function needsBroaderSearch(previous, current, mode = SEARCH_POLICY.broadPass) {
  if (mode === "never") return false;
  if (mode === "always") return true;
  if (mode === "unstable") return !agreesAtDepth(previous, current);
  if (previous.key !== current.key) return true;
  if (isPraise(previous) || isPraise(current)) return !agreesAtDepth(previous, current);
  if (mode === "grade-change") return false;
  // Same grade, but the loss is moving fast enough to cross a severity line at the next depth.
  const shift = current.winLoss - previous.winLoss;
  if (Math.abs(shift) <= PASS_AGREEMENT_LOSS) return false;
  const [low, high] = [current.winLoss, current.winLoss + shift].sort((a, b) => a - b);
  return SEVERITY_LIMITS.some((limit) => low <= limit && limit <= high);
}

async function refineDecision(engine, before, after, depth, width, minimumDepth, nodes) {
  try {
    const root = await analyzeGamePosition(engine, before, depth, width, nodes);
    if (root.lines.length < Math.min(before.legalMoves, width) ||
        root.lines.some((line) => line.depth !== root.depth)) return null;
    // Deep Check uses the actual discovery depth when the node budget cut the search short.
    if (nodes !== undefined && root.depth <= minimumDepth) return null;
    const target = nodes === undefined ? depth : root.depth;
    const comparison = await compareRootMoves(engine, before, after.move.uci, target, root, { nodes });
    return comparisonDepth(comparison) > minimumDepth &&
      comparison.root.lines.every((line) => line.depth === comparison.root.depth) ? comparison : null;
  } catch (error) {
    if (error instanceof IncompleteMoveComparison || error instanceof IncompleteStockfishSearch) return null;
    throw error;
  }
}

/**
 * Compare the played move at the review depth. The result says whether deeper passes could change the grade.
 * Returns { comparison, needsRefinement }; finishDecision runs those passes later.
 */
export async function quickDecision(engine, before, after, depth, initialRoot, prevOpponentWinLoss = 0) {
  const root = initialRoot ?? await analyzeGamePosition(engine, before, depth);
  const baseline = await compareRootMoves(engine, before, after.move.uci, depth, root, { allowNarrowerSearch: true });
  if (before.legalMoves < 2) return { comparison: { ...baseline, searchConfidence: "forced" }, needsRefinement: false };
  const completeBaseline = root.lines.length >= 2 && !baseline.incomplete;

  const previous = signal(before, after, baseline, prevOpponentWinLoss);
  // Each completed pass, for the search-confidence display and the policy benchmark.
  const passes = [describePass(baseline, previous)];
  const practicalLoss = estimateImpact(before, after, baseline.root, baseline.played)?.loss ?? 0;
  const nearBoundary = Object.values(GRADE_LOSS_LIMITS).some((cutoff) => Math.abs(previous.winLoss - cutoff) <= 1);
  const praise = previous.key === "brilliant" || previous.key === "great";
  if (completeBaseline && Math.max(previous.winLoss, practicalLoss) < 5 && baseline.root.pvGap < 10 &&
      !nearBoundary && !praise && !previous.sacrifice) {
    return { comparison: { ...baseline, passes, searchConfidence: "single" }, needsRefinement: false };
  }
  return { comparison: { ...baseline, passes, searchConfidence: "pending" }, needsRefinement: true, completeBaseline };
}

/** Run the deeper passes that quickDecision asked for. A finished quick result comes back unchanged. */
export async function finishDecision(engine, before, after, depth, quick, prevOpponentWinLoss = 0,
  policy = SEARCH_POLICY) {
  if (!quick.needsRefinement) return quick.comparison;
  const { passes: quickPasses, searchConfidence: _pending, ...baseline } = quick.comparison;
  const passes = [...quickPasses];
  let previous = signal(before, after, baseline, prevOpponentWinLoss);

  let result = await refineDecision(engine, before, after, depth + policy.confirmDepth, 2, comparisonDepth(baseline));
  if (!result) return { ...baseline, passes, searchConfidence: "borderline" };

  let completePrevious = quick.completeBaseline;
  let current = signal(before, after, result, prevOpponentWinLoss);
  passes.push(describePass(result, current));
  if (needsBroaderSearch(previous, current, policy.broadPass)) {
    const broader = await refineDecision(engine, before, after, depth + policy.broadDepth, policy.broadWidth,
      comparisonDepth(result));
    if (!broader) return { ...result, passes, searchConfidence: "borderline" };
    completePrevious = true;
    previous = current;
    result = broader;
    current = signal(before, after, result, prevOpponentWinLoss);
    passes.push(describePass(result, current));
  }
  // Praise needs the loss to hold as well; other grades need only the label to hold.
  const agrees = agreesAtDepth(previous, current);
  const stable = completePrevious && (policy.broadPass === "unstable" || isPraise(current)
    ? agrees : previous.key === current.key);
  return {
    ...result,
    passes,
    confirmed: completePrevious && agrees && isPraise(current) && result.root.lines.length >= 2,
    searchConfidence: stable ? "stable" : "borderline",
  };
}

export async function analyzeDecision(engine, before, after, depth, initialRoot, prevOpponentWinLoss = 0,
  policy = SEARCH_POLICY) {
  const quick = await quickDecision(engine, before, after, depth, initialRoot, prevOpponentWinLoss);
  return finishDecision(engine, before, after, depth, quick, prevOpponentWinLoss, policy);
}

/** Run an optional deeper check starting from the original comparison's actual depth. */
export async function deepCheckDecision(engine, before, after, reviewDepth, prevOpponentWinLoss = 0) {
  if (before.terminal || before.legalMoves < 2 || !after.move) return null;

  const passes = [];
  const firstTarget = Math.max(18, reviewDepth + 2);
  let result = null;
  for (const [index, nodes] of DEEP_CHECK_PASSES.entries()) {
    const minimumDepth = result ? comparisonDepth(result) : reviewDepth;
    const target = Math.min(DEEP_CHECK_MAX_DEPTH, firstTarget + index * 2);
    if (target <= minimumDepth) break;
    const comparison = await refineDecision(engine, before, after, target, 3, minimumDepth, nodes);
    if (!comparison) continue;
    result = comparison;
    passes.push(describePass(result, signal(before, after, result, prevOpponentWinLoss)));
  }
  if (!result) return null;

  const [first, second] = passes;
  const corroborated = Boolean(second && agreesAtDepth(first, second));
  return {
    ...result,
    passes,
    confirmed: corroborated && isPraise(second),
    searchConfidence: corroborated ? "stable" : second ? "borderline" : "single",
  };
}

export function scoreDecision(before, after, comparison, prevOpponentWinLoss) {
  const { root, played, confirmed, searchConfidence } = comparison;
  const { playedEval, forced, grade } = gradeInputs(before, after, comparison);
  const classification = classifyMove({ ...grade, confirmed, prevOpponentWinLoss });
  const { color } = after.move;
  const accuracyLoss = moverScore(evalToWinWhite(root.eval), color) -
    moverScore(evalToWinWhite(playedEval.eval), color);
  return {
    classification,
    forced,
    accuracy: winLossToAccuracy(accuracyLoss),
    cpLoss: computeMoveCpLoss(root.eval, playedEval.eval, color),
    practicalImpact: estimateImpact(before, after, root, played),
    difficulty: estimateDifficulty(before, root.eval, color),
    winBefore: grade.winBefore,
    winAfter: grade.winAfter,
    winLoss: classification.winLoss,
    pvGap: root.pvGap,
    bestMoveUci: root.bestMove,
    playedPv: played.pv,
    playedEval: playedEval.eval,
    missedMate: grade.missedMate,
    depth: comparisonDepth(comparison),
    searchConfidence,
  };
}
