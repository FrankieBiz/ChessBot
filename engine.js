// Move scoring and the Stockfish UCI worker transport.

export const CLASSIFICATIONS = {
  brilliant:  { key: "brilliant",  label: "Brilliant",  symbol: "!!", color: "#26c6da" },
  great:      { key: "great",      label: "Great",      symbol: "!",  color: "#5c8bb0" },
  best:       { key: "best",       label: "Best",       symbol: "★",  color: "#81b64c" },
  excellent:  { key: "excellent",  label: "Excellent",  symbol: "✓",  color: "#96bc4b" },
  good:       { key: "good",       label: "Good",       symbol: "•",  color: "#a2b578" },
  inaccuracy: { key: "inaccuracy", label: "Inaccuracy", symbol: "?!", color: "#f7c631" },
  mistake:    { key: "mistake",    label: "Mistake",    symbol: "?",  color: "#e68a2e" },
  miss:       { key: "miss",       label: "Miss",       symbol: "×",  color: "#f26b5e" },
  blunder:    { key: "blunder",    label: "Blunder",    symbol: "??", color: "#ca3431" },
};

export const PIECE_VALUES = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

const MAX_CP_CAP = 1000;

/**
 * Convert a centipawn evaluation (White's perspective) into White's Win% (0–100).
 * Formula: Win% = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clampedCp)) - 1)
 */
export function cpToWinProbability(cpWhite) {
  const clampedCp = Math.max(-MAX_CP_CAP, Math.min(MAX_CP_CAP, cpWhite));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clampedCp)) - 1);
}

/**
 * Convert an engine evaluation { type: 'cp'|'mate', value: number } (White's perspective)
 * into a capped centipawn integer [-1000, 1000] for ACPL calculation.
 */
export function evalToCappedCpWhite(evalObj) {
  if (!evalObj) return 0;
  if (evalObj.type === "mate") {
    if (evalObj.value > 0) return MAX_CP_CAP;
    if (evalObj.value < 0) return -MAX_CP_CAP;
    return 0;
  }
  return Math.max(-MAX_CP_CAP, Math.min(MAX_CP_CAP, evalObj.value));
}

/**
 * Convert an engine evaluation { type: 'cp'|'mate', value: number } (White's perspective)
 * into White's Win% (0–100).
 */
export function evalToWinWhite(evalObj) {
  if (!evalObj) return 50;
  if (evalObj.type === "mate") {
    if (evalObj.value > 0) return 100;
    if (evalObj.value < 0) return 0;
    return 50;
  }
  return cpToWinProbability(evalObj.value);
}

/**
 * Compute per-move Centipawn Loss (0..1000) for the moving side.
 */
export function computeMoveCpLoss(evalBefore, evalAfter, color) {
  const cpBefore = evalToCappedCpWhite(evalBefore);
  const cpAfter = evalToCappedCpWhite(evalAfter);
  const signedBefore = color === "w" ? cpBefore : -cpBefore;
  const signedAfter = color === "w" ? cpAfter : -cpAfter;
  return Math.max(0, Math.min(MAX_CP_CAP, signedBefore - signedAfter));
}

/**
 * Compute Average Centipawn Loss (ACPL) for an array of per-move cp losses.
 */
export function computeACPL(cpLosses) {
  if (!cpLosses || cpLosses.length === 0) return null;
  const sum = cpLosses.reduce((acc, v) => acc + v, 0);
  return Math.round(sum / cpLosses.length);
}

/**
 * Convert a Win% loss (0–100) into per-move accuracy (0–100).
 * Lichess official formula with +1.0 uncertainty allowance, clamped [0, 100].
 */
export function winLossToAccuracy(winLoss) {
  const clampedLoss = Math.max(0, Math.min(100, winLoss));
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * clampedLoss) - 3.166924740191411 + 1;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Standard deviation of a numeric array.
 */
function standardDeviation(values) {
  if (!values || values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Blend the volatility-weighted and harmonic means of scored decisions.
 * The leading moves use the first complete window, as in Lichess's aggregation.
 */
export function computeProGameAccuracy(timeline, playerMoves) {
  if (!playerMoves.length) return null;

  const windowSize = Math.min(timeline.length, Math.max(2, Math.min(8, Math.floor((timeline.length - 1) / 10))));
  let weightedSum = 0;
  let totalWeight = 0;
  let reciprocalSum = 0;

  for (const { ply, accuracy } of playerMoves) {
    const end = Math.max(windowSize, ply + 1);
    const window = timeline.slice(end - windowSize, end);
    const sigma = window.every(Number.isFinite) ? standardDeviation(window) : 0;
    const weight = Math.max(0.5, Math.min(12, sigma));
    weightedSum += accuracy * weight;
    totalWeight += weight;
    reciprocalSum += 1 / accuracy;
  }

  const blended = (weightedSum / totalWeight + playerMoves.length / reciprocalSum) / 2;
  return Math.round(blended * 10) / 10;
}

/**
 * Format an eval object (White's perspective) for display (e.g., "+2.4", "-0.8", "M3", "-M2").
 */
export function formatEval(evalObj) {
  if (!evalObj) return "0.0";
  if (evalObj.type === "mate") {
    if (evalObj.value === 0) return "#";
    const sign = evalObj.value > 0 ? "" : "-";
    return `${sign}M${Math.abs(evalObj.value)}`;
  }
  const pawns = evalObj.value / 100;
  const sign = pawns > 0.04 ? "+" : "";
  return `${sign}${pawns.toFixed(1)}`;
}

/**
 * Compute material balance (White minus Black) from a FEN string.
 */
export function computeMaterialBalanceFromFen(fen) {
  if (!fen) return 0;
  const placement = fen.split(" ")[0] || "";
  let white = 0;
  let black = 0;
  for (const ch of placement) {
    const lower = ch.toLowerCase();
    if (!(lower in PIECE_VALUES)) continue;
    const val = PIECE_VALUES[lower];
    if (ch === lower) black += val;
    else white += val;
  }
  return white - black;
}

export const GRADE_LOSS_LIMITS = { excellent: 3, good: 5, inaccuracy: 10, mistake: 20 };

/** Grade only the quality that the evaluated decision actually establishes. */
export function classifyMove({
  playedUci,
  bestMoveUci,
  winBefore,
  winAfter,
  legalMoves,
  isSacrifice = false,
  equivalentBest = false,
  secondScore,
  confirmed = false,
  prevOpponentWinLoss = 0,
  missedMate = null,
}) {
  const winLoss = Math.max(0, winBefore - winAfter);
  const isTopEngineMove = Boolean(bestMoveUci && playedUci === bestMoveUci);
  const classified = (key) => ({ ...CLASSIFICATIONS[key], winLoss });

  if (legalMoves === 1) return classified("best");
  if (confirmed && isSacrifice && winLoss <= 2 && winAfter >= 52 && Number.isFinite(secondScore) && secondScore < 90) {
    return classified("brilliant");
  }
  if (confirmed && isTopEngineMove && Number.isFinite(secondScore) && winBefore - secondScore >= 10 &&
      ((winBefore >= 60 && secondScore <= 45) || (winBefore >= 45 && secondScore <= 35))) {
    return classified("great");
  }

  // A missed short mate is a Miss even when the position stays won. Larger losses keep their severity grade.
  if (missedMate?.drill && winLoss <= GRADE_LOSS_LIMITS.inaccuracy) return classified("miss");
  if ((isTopEngineMove || equivalentBest) && winLoss <= 1.5) return classified("best");
  if (winLoss <= GRADE_LOSS_LIMITS.excellent) return classified("excellent");
  if (winLoss <= GRADE_LOSS_LIMITS.good) return classified("good");
  if (winLoss <= GRADE_LOSS_LIMITS.inaccuracy) return classified("inaccuracy");
  if (prevOpponentWinLoss >= 15 && winBefore >= 65 && winAfter < 60) return classified("miss");
  if (winLoss <= GRADE_LOSS_LIMITS.mistake) return classified("mistake");
  return classified("blunder");
}

export function parseUciInfoLine(line, turn = "w") {
  if (!line.startsWith("info ") || /\b(?:upperbound|lowerbound)\b/.test(line)) return null;
  const score = line.match(/\bscore (cp|mate) (-?\d+)/);
  const depth = line.match(/\bdepth (\d+)/);
  const pv = line.match(/\bpv (.+)$/);
  if (!score || !depth || !pv) return null;

  const evaluation = { type: score[1], value: Number(score[2]) * (turn === "w" ? 1 : -1) };
  const rawWdl = line.match(/\bwdl (\d+) (\d+) (\d+)/)?.slice(1).map(Number);
  const wdl = rawWdl && {
    win: rawWdl[turn === "w" ? 0 : 2], draw: rawWdl[1], loss: rawWdl[turn === "w" ? 2 : 0],
  };
  return {
    multipv: Number(line.match(/\bmultipv (\d+)/)?.[1] ?? 1),
    depth: Number(depth[1]),
    eval: evaluation,
    wdl: wdl ?? null,
    winWhite: wdl ? (wdl.win + wdl.draw / 2) / 10 : evalToWinWhite(evaluation),
    pv: pv[1].trim().split(/\s+/),
  };
}

export function summarizeLines(lines, turn) {
  const [first, second] = lines;
  return {
    ...first,
    lines,
    bestMove: first.pv[0],
    secondEval: second?.eval ?? null,
    secondWinWhite: second?.winWhite ?? null,
    secondMove: second?.pv[0] ?? null,
    secondPv: second?.pv ?? [],
    pvGap: second ? Math.max(0, (first.winWhite - second.winWhite) * (turn === "w" ? 1 : -1)) : 0,
  };
}

export class StockfishEngine {
  constructor(workerPath) {
    this.workerPath = workerPath;
    this.worker = null;
    this.ready = false;
    this.initPromise = null;
    this.request = null;
    this.queue = Promise.resolve();
    this.generation = 0;
  }

  init() {
    if (this.ready) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    try {
      this.worker = new Worker(this.workerPath);
    } catch (error) {
      return Promise.reject(new Error(`Could not start Stockfish: ${error.message}`));
    }

    const worker = this.worker;
    worker.onmessage = ({ data }) => {
      if (this.worker !== worker) return;
      for (const line of String(data).split(/\r?\n/)) this.request?.onLine(line.trim());
    };
    worker.onerror = ({ message }) => {
      if (this.worker === worker) this.terminate(new Error(`Stockfish worker error: ${message || "unknown error"}`));
    };

    this.initPromise = this.waitForOutput(30000, "Stockfish initialization timed out", (finish) => (line) => {
      if (line === "uciok") {
        worker.postMessage("setoption name Hash value 32");
        worker.postMessage("setoption name UCI_ShowWDL value true");
        worker.postMessage("isready");
      } else if (line === "readyok") {
        this.ready = true;
        finish();
      }
    });
    worker.postMessage("uci");
    return this.initPromise;
  }

  waitForOutput(timeout, errorMessage, handler) {
    return new Promise((resolve, reject) => {
      const finish = (value) => {
        clearTimeout(timer);
        this.request = null;
        resolve(value);
      };
      const timer = setTimeout(() => this.terminate(new Error(errorMessage)), timeout);
      this.request = {
        onLine: handler(finish),
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
    });
  }

  enqueue(operation) {
    const generation = this.generation;
    const result = this.queue.then(async () => {
      if (generation !== this.generation) throw new Error("Analysis cancelled");
      await this.init();
      if (generation !== this.generation) throw new Error("Analysis cancelled");
      return operation();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  startNewGame() {
    return this.enqueue(() => {
      const response = this.waitForOutput(15000, "Stockfish did not reset for the new game", (finish) => (line) => {
        if (line === "readyok") finish();
      });
      this.worker.postMessage("ucinewgame");
      this.worker.postMessage("isready");
      return response;
    });
  }

  analyzePosition(fen, depth = 16, options = {}) {
    return this.enqueue(() => this.search(fen, depth, options));
  }

  search(fen, depth, { initialFen = fen, history = [], searchMoves = [], multiPv = 2 } = {}) {
    const turn = fen.split(" ")[1];
    const iterations = new Map();
    const response = this.waitForOutput(45000, "Stockfish search timed out", (finish) => (line) => {
      const parsed = parseUciInfoLine(line, turn);
      if (parsed) {
        if (!iterations.has(parsed.depth)) iterations.set(parsed.depth, []);
        iterations.get(parsed.depth)[parsed.multipv - 1] = parsed;
        return;
      }
      if (!line.startsWith("bestmove ")) return;
      const best = line.split(/\s+/)[1];
      const ranked = [...iterations.values()].reverse()
        .map((lines) => lines.filter(Boolean))
        .filter((lines) => lines[0]?.multipv === 1);
      const complete = ranked.filter((lines) => lines.length === multiPv &&
        new Set(lines.map((candidate) => candidate.pv[0])).size === multiPv);
      const candidateLines = complete.find((lines) => lines[0].pv[0] === best) ??
        complete[0] ?? ranked.find((lines) => lines[0].pv[0] === best)?.slice(0, 1);
      if (candidateLines) finish(summarizeLines(candidateLines, turn));
      else this.terminate(new Error("Stockfish returned no complete evaluation"));
    });
    this.worker.postMessage(`setoption name MultiPV value ${multiPv}`);
    const played = history.length ? ` moves ${history.join(" ")}` : "";
    const restrict = searchMoves.length ? ` searchmoves ${searchMoves.join(" ")}` : "";
    this.worker.postMessage(`position fen ${initialFen}${played}`);
    const nodes = Math.min(4_000_000, Math.round(90_000 * 2 ** ((depth - 10) / 2)));
    this.worker.postMessage(`go depth ${depth} nodes ${nodes}${restrict}`);
    return response;
  }

  abort() {
    this.terminate();
  }

  terminate(error = new Error("Analysis cancelled")) {
    this.generation++;
    this.request?.reject(error);
    this.request = null;
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.initPromise = null;
    this.queue = Promise.resolve();
  }
}
