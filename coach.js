import { PIECE_VALUES, computeGameAccuracy, formatEval } from "./engine.js";
import { PIECE_NAME, TACTIC_LABEL, describeTactic, tacticName } from "./motifs.js";
import { describeError } from "./coach-reasons.js";

const PIECE_NAMES = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

const STARTING_COUNTS = { p: 8, n: 2, b: 2, r: 2, q: 1 };

const UNICODE_PIECES = {
  w: { q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
  b: { q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" },
};

export function computeCapturedAndMaterial(fen) {
  const placement = (fen || "").split(" ")[0] || "";
  const present = {
    w: { p: 0, n: 0, b: 0, r: 0, q: 0 },
    b: { p: 0, n: 0, b: 0, r: 0, q: 0 },
  };

  for (const ch of placement) {
    const lower = ch.toLowerCase();
    if (!(lower in STARTING_COUNTS)) continue;
    if (ch === lower) present.b[lower]++;
    else present.w[lower]++;
  }

  const order = ["q", "r", "b", "n", "p"];
  const capturedByWhite = [];
  const capturedByBlack = [];

  // A promoted pawn is still on the board as another piece, so do not report it as captured.
  const promoted = (color) => order.slice(0, 4)
    .reduce((sum, piece) => sum + Math.max(0, present[color][piece] - STARTING_COUNTS[piece]), 0);
  const promotedWhite = promoted("w");
  const promotedBlack = promoted("b");

  for (const piece of order) {
    if (piece === "p") {
      const missingBlack = Math.max(0, STARTING_COUNTS.p - present.b.p - promotedBlack);
      const missingWhite = Math.max(0, STARTING_COUNTS.p - present.w.p - promotedWhite);
      for (let i = 0; i < missingBlack; i++) capturedByWhite.push(UNICODE_PIECES.b[piece]);
      for (let i = 0; i < missingWhite; i++) capturedByBlack.push(UNICODE_PIECES.w[piece]);
      continue;
    }
    const missingBlack = Math.max(0, STARTING_COUNTS[piece] - present.b[piece]);
    for (let i = 0; i < missingBlack; i++) capturedByWhite.push(UNICODE_PIECES.b[piece]);
    const missingWhite = Math.max(0, STARTING_COUNTS[piece] - present.w[piece]);
    for (let i = 0; i < missingWhite; i++) capturedByBlack.push(UNICODE_PIECES.w[piece]);
  }

  let whiteMat = 0;
  let blackMat = 0;
  for (const piece of order) {
    whiteMat += present.w[piece] * PIECE_VALUES[piece];
    blackMat += present.b[piece] * PIECE_VALUES[piece];
  }

  return {
    capturedByWhite,
    capturedByBlack,
    whiteLead: whiteMat - blackMat,
  };
}

export function generateLocalCoachInsight({
  ChessClass,
  fenBefore,
  fenAfter,
  move,
  evalBefore,
  evalAfter,
  review,
}) {
  if (!move || !review) {
    return {
      title: "Ready to review",
      text: "Step through the game with Next or your arrow keys to see move-by-move coaching.",
      tag: null,
    };
  }

  const cls = review.classification;
  const isWhite = move.color === "w";
  const oppLabel = isWhite ? "Black" : "White";
  const bestSan = review.bestSan || "";
  const tactics = review.tactics ?? {};
  const opponentColor = isWhite ? "b" : "w";

  const inspectUci = (fen, uci) => {
    if (!ChessClass || !fen || !uci || uci.length < 4) return null;
    try {
      const sim = new ChessClass(fen);
      return sim.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length >= 5 ? uci[4].toLowerCase() : "q",
      });
    } catch {
      return null;
    }
  };

  const beforeEvalObj = evalBefore?.eval;
  const afterEvalObj = evalAfter?.eval;
  const moverHadMate =
    beforeEvalObj?.type === "mate" &&
    ((isWhite && beforeEvalObj.value > 0) || (!isWhite && beforeEvalObj.value < 0));
  const moverStillHasMate =
    afterEvalObj?.type === "mate" &&
    ((isWhite && afterEvalObj.value > 0) || (!isWhite && afterEvalObj.value < 0));
  const oppNowHasMate =
    afterEvalObj?.type === "mate" &&
    ((isWhite && afterEvalObj.value < 0) || (!isWhite && afterEvalObj.value > 0));
  const oppAlreadyHadMate =
    beforeEvalObj?.type === "mate" &&
    ((isWhite && beforeEvalObj.value < 0) || (!isWhite && beforeEvalObj.value > 0));

  if (move.san.endsWith("#")) {
    return {
      title: `${move.san} — Checkmate`,
      text: `${move.san} ends the game. ${oppLabel} has no legal way to get out of check.`,
      tag: "Checkmate",
    };
  }

  if (review.forced) {
    return { title: `${move.san} was forced`, text: "This was the only legal move.", tag: "Forced Move" };
  }

  if (oppNowHasMate && !oppAlreadyHadMate) {
    const mateIn = Math.abs(afterEvalObj.value);
    const reply = inspectUci(fenAfter, evalAfter?.bestMove);
    const replyHint = reply ? ` starting with ${reply.san}` : "";
    const ownMate = review.missedMate?.drill
      ? `You had a forced mate in ${review.missedMate.available} with ${bestSan || "the top engine move"} instead.`
      : bestSan ? `Compare that with the engine line after ${bestSan}.` : "";
    return {
      title: `${move.san} allows checkmate in ${mateIn}`,
      text: `This leaves your king vulnerable—${oppLabel} can now force checkmate in ${mateIn}${replyHint}. ${ownMate}`,
      tag: review.missedMate?.drill ? "Missed Mate" : "Missed Defense",
    };
  }

  const missedMate = review.missedMate;
  if (missedMate) {
    const best = bestSan || "the top engine move";
    const { available, played, kind } = missedMate;
    const outcome = played
      ? `${move.san} still forces mate, but it takes ${played} moves instead of ${available}`
      : `After ${move.san}, Stockfish no longer finds a forced mate`;
    const lesson = kind === "immediate"
      ? `${best} was checkmate on the spot. ${outcome}. Before any other move, check every check, capture, and threat for an immediate mate.`
      : `${best} started a forced checkmate in ${available}. ${outcome}. Calculating forcing moves first would have finished the game.`;
    return {
      title: kind === "immediate" ? `${move.san} missed mate in 1` : `${move.san} missed a forced mate in ${available}`,
      text: kind === "slower" ? `${best} forced mate in ${available}. ${outcome}, so the win is still there.` : lesson,
      tag: "Missed Mate",
    };
  }

  if (moverHadMate && (!moverStillHasMate || Math.abs(beforeEvalObj.value) === 1)) {
    const mateIn = Math.abs(beforeEvalObj.value);
    return {
      title: `${move.san} missed a forced checkmate`,
      text: `You had a forced checkmate in ${mateIn} with ${bestSan || "the top engine move"}. ${moverStillHasMate ? `The played move leaves mate in ${Math.abs(afterEvalObj.value)}.` : "The engine no longer shows a forced mate after the played move."}`,
      tag: "Missed Mate",
    };
  }

  // A named tactic from Stockfish's line explains a strong move better than the generic praise.
  const praiseTitle = {
    brilliant: `${move.san} is Brilliant!`, great: `${move.san} is a Great move!`,
    best: `${move.san} is the best move`, excellent: `${move.san} is an excellent move`,
  }[cls.key];
  if (praiseTitle && tactics.found) {
    return {
      title: praiseTitle,
      text: describeTactic(tactics.found, { owner: "player", color: move.color }),
      tag: TACTIC_LABEL[tactics.found.kind],
    };
  }

  // 1. Brilliant (!!)
  if (cls.key === "brilliant") {
    return {
      title: `${move.san} is Brilliant!`,
      text: "You sacrificed material to seize the initiative and keep a strong advantage. That's the kind of forcing calculation that wins games.",
      tag: "Tactical Sacrifice",
    };
  }

  // 2. Great (!) — Only Move found (MultiPV 2 gap >= 10%)
  if (cls.key === "great") {
    const gapText = review.pvGap >= 10 ? ` (${review.pvGap.toFixed(0)} expected-score points ahead of the next engine line)` : "";
    return {
      title: `${move.san} is a Great move!`,
      text: `You found a critical move in a sharp position${gapText}.`,
      tag: "Critical Move",
    };
  }

  // 3. Best / Excellent / Good
  if (cls.key === "best") {
    if (bestSan && bestSan !== move.san) {
      return {
        title: `${move.san} matches the best evaluation`,
        text: `Stockfish gives ${move.san} and ${bestSan} equivalent evaluations.`,
        tag: "Equally Strong",
      };
    }
    if (move.san === "O-O" || move.san === "O-O-O") {
      return {
        title: `${move.san} is the best move`,
        text: "Great king safety—tucking your king away and connecting your rooks sets up a solid middlegame.",
        tag: "King Safety",
      };
    }
    if (move.captured) {
      const capName = PIECE_NAMES[move.captured] || "piece";
      return {
        title: `${move.san} is the best move`,
        text: `Sharp capture—taking the ${capName} on ${move.to} was Stockfish's top choice in this position.`,
        tag: "Tactical Precision",
      };
    }
    return {
      title: `${move.san} is the best move`,
      text: "You found Stockfish's top choice, keeping maximum pressure and control of the position.",
      tag: "Top Engine Move",
    };
  }

  if (cls.key === "excellent") {
    return {
      title: `${move.san} is an excellent move`,
      text: bestSan && bestSan !== move.san
        ? `Very strong play—nearly as accurate as ${bestSan}, keeping your position in great shape.`
        : "Very accurate move that maintains your advantage.",
      tag: "Strong Move",
    };
  }

  if (cls.key === "good") {
    return {
      title: `${move.san} is a solid move`,
      text: bestSan && bestSan !== move.san
        ? `A playable move that keeps you in the game, though ${bestSan} offered a bit more activity.`
        : "A solid, practical move that keeps your position together.",
      tag: "Solid Play",
    };
  }

  // An error that allows a tactic, or misses one, gets the tactic by name with its squares.
  const isError = ["inaccuracy", "mistake", "miss", "blunder"].includes(cls.key);
  if (isError && (tactics.allowed || tactics.missed)) {
    const { allowed, missed } = tactics;
    const parts = [];
    if (allowed) parts.push(describeTactic(allowed, { owner: "opponent", color: opponentColor }));
    if (missed) parts.push(describeTactic(missed, { owner: "player", color: move.color, missed: true }));
    else if (bestSan) parts.push(`${bestSan} was the stronger move.`);
    const lead = allowed ?? missed;
    const name = tacticName(lead);
    const article = /^[aeiou]/.test(name) ? "an" : "a";
    let title = allowed ? `${move.san} allows ${article} ${name}` : `${move.san} missed ${article} ${name}`;
    if (lead.kind === "free capture") {
      const [target] = lead.targets;
      title = allowed
        ? `${move.san} hangs your ${PIECE_NAME[target.piece]} on ${target.square}`
        : `${move.san} missed a free ${PIECE_NAME[target.piece]}`;
    }
    // Tags feed the weakness report's themes. A Miss keeps its own theme.
    let tag = allowed ? TACTIC_LABEL[allowed.kind]
      : missed.kind === "free capture" ? "Missed Free Piece"
      : missed.kind.endsWith("mate") ? "Missed Mate" : `Missed ${TACTIC_LABEL[missed.kind]}`;
    if (cls.key === "miss") tag = "Missed Refutation";
    return { title, text: parts.join(" "), tag };
  }

  // Otherwise, the verified reasons from Stockfish's lines and the board.
  const errorTitle = `${move.san} is ${cls.key === "inaccuracy" ? "an Inaccuracy" : `a ${cls.label}`}`;
  const described = isError ? describeError(review.reasons, { san: move.san, bestSan, color: move.color }) : null;
  // Without a concrete consequence, the evaluation change and Stockfish's line complete the picture.
  const evalLine = isError && review.reasons && beforeEvalObj && afterEvalObj
    ? `Stockfish's evaluation goes from ${formatEval(beforeEvalObj)} to ${formatEval(afterEvalObj)} after ${move.san}.` +
      `${review.reasons.bestLine ? ` Its best line was ${review.reasons.bestLine}.` : ""}`
    : "";
  if (described) {
    const concrete = review.reasons.consequence || review.reasons.better;
    return {
      title: described.title ?? errorTitle,
      text: concrete || !evalLine ? described.text : `${described.text} ${evalLine}`,
      tag: cls.key === "miss" ? "Missed Refutation" : described.tag ?? (cls.key === "blunder" ? "Critical Error" : "Positional Slip"),
    };
  }
  if (evalLine && cls.key !== "miss") {
    return {
      title: errorTitle,
      text: evalLine,
      tag: cls.key === "blunder" ? "Critical Error" : "Positional Slip",
    };
  }

  // 4. Miss (×) — Opponent blundered and player missed the refutation
  if (cls.key === "miss") {
    return {
      title: `${move.san} missed a big opportunity`,
      text: `${oppLabel} just made a major error, and ${bestSan || "the top engine move"} would have punished it immediately (-${review.winLoss.toFixed(0)} expected-score points).`,
      tag: "Missed Refutation",
    };
  }

  const oppBestReply = inspectUci(fenAfter, evalAfter?.bestMove);
  if (oppBestReply && oppBestReply.captured) {
    const lostPiece = PIECE_NAMES[oppBestReply.captured] || "piece";
    const lostVal = PIECE_VALUES[oppBestReply.captured] || 0;
    const replyPiece = PIECE_NAMES[oppBestReply.piece] || "piece";

    if (oppBestReply.to === move.to && lostVal >= 3) {
      return {
        title: `${move.san} allows ${oppBestReply.san}`,
        text: `In the engine line, ${oppLabel} captures your ${lostPiece} on ${move.to} with ${oppBestReply.san}. ${bestSan ? `Compare the continuation after ${bestSan}.` : ""}`,
        tag: "Hanging Piece",
      };
    }

    if (lostVal >= 3) {
      return {
        title: `${move.san} allows a capture on ${oppBestReply.to}`,
        text: `${oppLabel}'s ${replyPiece} can capture your ${lostPiece} with ${oppBestReply.san}. ${bestSan ? `Compare that reply with the ${bestSan} line.` : ""}`,
        tag: "Engine Capture",
      };
    }
  }

  const bestMoveObj = inspectUci(fenBefore, review.bestMoveUci);
  if (bestMoveObj && bestMoveObj.captured) {
    const missedCap = PIECE_NAMES[bestMoveObj.captured] || "piece";
    const missedVal = PIECE_VALUES[bestMoveObj.captured] || 0;
    if (missedVal >= 3) {
      return {
        title: `${move.san} missed a capture`,
        text: `You could have captured ${oppLabel}'s ${missedCap} on ${bestMoveObj.to} with ${bestMoveObj.san}. Before moving, scan every capture on the board!`,
        tag: "Missed Tactic",
      };
    }
  }

  if (bestMoveObj && bestMoveObj.promotion) {
    return {
      title: `${move.san} missed a pawn promotion`,
      text: `Pushing with ${bestMoveObj.san} promoted your pawn immediately and locked in a winning advantage.`,
      tag: "Promotion",
    };
  }

  if (bestMoveObj && bestMoveObj.san.includes("+")) {
    return {
      title: `${move.san} missed a strong check`,
      text: `The forcing check ${bestMoveObj.san} seized the initiative and disrupted ${oppLabel}'s coordination (costing ${review.winLoss.toFixed(0)} expected-score points).`,
      tag: "Missed Check",
    };
  }

  const severity =
    cls.key === "blunder"
      ? "gives away a major advantage"
      : cls.key === "mistake"
      ? "weakens your position noticeably"
      : "lets some of your edge slip";

  return {
    title: `${move.san} is ${cls.key === "inaccuracy" ? "an Inaccuracy" : `a ${cls.label}`}`,
    text: bestSan
      ? `This ${severity} (-${review.winLoss.toFixed(0)} expected-score points). Compare the continuation after ${bestSan} with what happened in the game.`
      : `This ${severity} (-${review.winLoss.toFixed(0)} expected-score points).`,
    tag: cls.key === "blunder" ? "Critical Error" : "Positional Slip",
  };
}

export function computeGameInsights({ positions, moveReviews, playedColor }) {
  const phases = { opening: [], middlegame: [], endgame: [] };
  for (let ply = 1; ply < positions.length; ply++) {
    const review = moveReviews[ply];
    if (!review || positions[ply].move.color !== playedColor) continue;
    phases[positions[ply - 1].phase].push({
      winLoss: review.winLoss, book: review.book, forced: review.forced,
    });
  }
  return Object.fromEntries(Object.entries(phases).map(([phase, moves]) =>
    [phase, computeGameAccuracy(moves)]));
}
