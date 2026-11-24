import { Chess, DEFAULT_POSITION } from "./vendor/chess.js/chess.js";
import {
  GRADE_LOSS_LIMITS,
  PIECE_VALUES,
  classifyMove,
  computeMaterialBalanceFromFen,
  computeMoveCpLoss,
  evalToWinWhite,
  winLossToAccuracy,
} from "./engine.js";
import { parseClockSeconds, parseTimeControl, practicalImpact } from "./practical-model.js";
import { estimateDifficulty, readLichessRatings } from "./difficulty-model.js";

const moverScore = (whiteScore, color) => color === "w" ? whiteScore : 100 - whiteScore;

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

export function analyzeGamePosition(engine, position, depth, multiPv = 2) {
  if (position.terminal) return Promise.resolve(position.terminal);
  return engine.analyzePosition(position.fen, depth, {
    ...position.searchOptions, multiPv: Math.min(position.legalMoves, multiPv),
  });
}

class IncompleteMoveComparison extends Error {}

export async function compareRootMoves(engine, position, playedUci, depth, root) {
  const played = root.lines.find((line) => line.pv[0] === playedUci);
  if (played) return { root, played };

  const searchMoves = [...new Set([...root.lines.map((line) => line.pv[0]), playedUci])];
  const compared = await engine.analyzePosition(position.fen, depth, {
    ...position.searchOptions, multiPv: searchMoves.length, searchMoves,
  });
  const comparedPlayed = compared.lines.find((line) => line.pv[0] === playedUci);
  if (compared.lines.length !== searchMoves.length || !comparedPlayed) {
    throw new IncompleteMoveComparison("Stockfish did not finish comparing the played move with its alternatives.");
  }
  return { root: compared, played: comparedPlayed };
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
    },
  };
}

function signal(before, after, comparison, prevOpponentWinLoss) {
  const { grade } = gradeInputs(before, after, comparison);
  return { ...classifyMove({ ...grade, confirmed: true, prevOpponentWinLoss }), sacrifice: grade.isSacrifice };
}

function agreesAtDepth(previous, current) {
  return previous.key === current.key && Math.abs(previous.winLoss - current.winLoss) <= 2.5;
}

async function refineDecision(engine, before, after, depth, width, fallback) {
  const root = await analyzeGamePosition(engine, before, depth, width);
  try {
    const comparison = await compareRootMoves(engine, before, after.move.uci, depth, root);
    return comparison.root.depth > fallback.root.depth ? comparison : null;
  } catch (error) {
    if (error instanceof IncompleteMoveComparison) return null;
    throw error;
  }
}

export async function analyzeDecision(engine, before, after, depth, initialRoot, prevOpponentWinLoss = 0) {
  const root = initialRoot ?? await analyzeGamePosition(engine, before, depth);
  const baseline = await compareRootMoves(engine, before, after.move.uci, depth, root);
  if (before.legalMoves < 2) return { ...baseline, searchConfidence: "forced" };

  let previous = signal(before, after, baseline, prevOpponentWinLoss);
  const practicalLoss = estimateImpact(before, after, baseline.root, baseline.played)?.loss ?? 0;
  const nearBoundary = Object.values(GRADE_LOSS_LIMITS).some((cutoff) => Math.abs(previous.winLoss - cutoff) <= 1);
  const praise = previous.key === "brilliant" || previous.key === "great";
  if (Math.max(previous.winLoss, practicalLoss) < 5 && baseline.root.pvGap < 10 && !nearBoundary && !praise && !previous.sacrifice) {
    return { ...baseline, searchConfidence: "single" };
  }

  let result = await refineDecision(engine, before, after, depth + 2, 2, baseline);
  if (!result) return { ...baseline, searchConfidence: "borderline" };

  let current = signal(before, after, result, prevOpponentWinLoss);
  if (!agreesAtDepth(previous, current)) {
    const broader = await refineDecision(engine, before, after, depth + 4, 3, result);
    if (broader) {
      previous = current;
      result = broader;
      current = signal(before, after, result, prevOpponentWinLoss);
    }
  }
  const stable = agreesAtDepth(previous, current);
  const distinction = current.key === "brilliant" || current.key === "great";
  return {
    ...result,
    confirmed: stable && distinction && result.root.lines.length >= 2,
    searchConfidence: stable ? "stable" : "borderline",
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
    depth: root.depth,
    searchConfidence,
  };
}
