import { Chess, DEFAULT_POSITION } from "./vendor/chess.js/chess.js";
import { COLOR, INPUT_EVENT_TYPE } from "./vendor/cm-chessboard/src/Chessboard.js";
import { MARKER_TYPE } from "./vendor/cm-chessboard/src/extensions/markers/Markers.js";
import { createBoard, requestPromotion } from "./board-setup.js";
import {
  CLASSIFICATIONS,
  StockfishEngine,
  computeACPL,
  computeProGameAccuracy,
  formatEval,
  evalToWinWhite,
} from "./engine.js";
import {
  computeCapturedAndMaterial,
  computeGameInsights,
  generateLocalCoachInsight,
} from "./coach.js";

import {
  analyzeDecision, analyzeGamePosition, compareRootMoves, deepCheckDecision, parseReviewGame, scoreDecision, terminalPosition,
} from "./analysis.js";
import { AI_PRESETS, coachEndpoint, coachRequestBody, migrateCoachSettings } from "./coach-api.js";
import { coachEvidence } from "./coach-evidence.js";
import { bookForReview, findBookMoves } from "./opening-book.js";
import { BOOK_MAX_PLY } from "./opening-book-data.js";
import { OPENING_EXPLORER_SAMPLE, openingChoices } from "./opening-explorer.js";
import { comparePersonalPerformance, peerDecisionPrediction, peerPerformance } from "./performance.js";
import { trainingPriority } from "./practical-model.js";
import { computeDecisionQuality } from "./decision-quality.js";
import { drillHint, drillPrompt, drillRejection, drillSuccess, judgeDrillAttempt } from "./drills.js";
import { dueCount, localDate, puzzlesFromDecisions } from "./deck.js";
import { confirmedSide, gameAccuracy, gameDate, pgnSideFor, summarizeGame, userDecisions, userResult } from "./weakness.js";
import { gameKeyFor, loadTraining, saveReview, webStorageArea } from "./training-store.js";
import { describeVariation, moveToUci, parseUciMove, replayVariation } from "./variation.js";
import {
  HUMAN_MOVE_SEARCH_DEPTH, candidateScores, forecastHumanMoves, humanContext, moveFeatureRows,
} from "./human-move-model.js";
import { HUMAN_MOVE_MODEL } from "./human-move-data.js";
import { STOCKFISH_WORKER_PATH } from "./vendor/stockfish/engine-config.js";

const extension = globalThis.browser ?? globalThis.chrome;
const trainingArea = extension?.storage?.local ?? webStorageArea(globalThis.localStorage);
const SVG_NS = "http://www.w3.org/2000/svg";
const RING_CIRCUMFERENCE = 2 * Math.PI * 22;
const ARROW_BEST = { class: "arrow-best" };
const ARROW_PLAYED_BAD = { class: "arrow-played-bad" };
const ARROW_BRILLIANT = { class: "arrow-brilliant" };
const ARROW_COACH_REPLY = { class: "arrow-coach-reply" };
const BOOK_CLASSIFICATION = { key: "book", label: "Book", symbol: "📖", color: "#bda181" };
const REVIEW_CLASSIFICATIONS = { ...CLASSIFICATIONS, book: BOOK_CLASSIFICATION };

const CLASSIFICATION_ORDER = [
  "brilliant",
  "great",
  "best",
  "excellent",
  "good",
  "book",
  "inaccuracy",
  "mistake",
  "miss",
  "blunder",
];

function displayClassification(review) {
  return review.book ? BOOK_CLASSIFICATION : review.classification;
}

function createSvgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

let audioCtx = null;
function playSound(kind = "move") {
  if (!state.soundEnabled) return;
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();

    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (kind === "capture") {
      osc.type = "triangle";
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.exponentialRampToValueAtTime(95, now + 0.08);
      gain.gain.setValueAtTime(0.14, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
      osc.start(now);
      osc.stop(now + 0.09);
    } else if (kind === "check") {
      osc.type = "sine";
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(340, now + 0.12);
      gain.gain.setValueAtTime(0.11, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
      osc.start(now);
      osc.stop(now + 0.13);
    } else if (kind === "success") {
      osc.type = "sine";
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.setValueAtTime(659.25, now + 0.07);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.start(now);
      osc.stop(now + 0.22);
    } else if (kind === "error") {
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(170, now);
      osc.frequency.exponentialRampToValueAtTime(125, now + 0.13);
      gain.gain.setValueAtTime(0.07, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      osc.start(now);
      osc.stop(now + 0.14);
    } else {
      osc.type = "sine";
      osc.frequency.setValueAtTime(165, now);
      osc.frequency.exponentialRampToValueAtTime(75, now + 0.055);
      gain.gain.setValueAtTime(0.11, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      osc.start(now);
      osc.stop(now + 0.06);
    }
  } catch {
    // Ignore audio context restrictions
  }
}

const state = {
  gameMeta: null,
  gameHeaders: null,
  positions: [],
  bookMoves: [],
  openingDeparturePly: -1,
  openingReentryPly: -1,
  evals: [],
  moveReviews: [],
  currentPly: 0,
  orientation: "w",
  activeTab: "review",
  boardTheme: "emerald",
  isAnalyzing: false,
  analysisRunId: 0,
  soundEnabled: true,

  autoplayTimer: null,
  bestLineTimer: null,
  coachReplyPly: null,
  deepCheck: null,
  deepChecks: new Map(),

  exploring: false,
  variationBasePly: 0,
  variationUci: [],
  variationMoves: [],
  variationEvalRunId: 0,
  boardEpoch: 0,

  drillActive: false,
  drillPlies: [],
  drillIndex: 0,
  drillSolvedSet: new Set(),
  drillSolved: false,
  drillChecking: false,

  coachCache: new Map(),
  humanForecasts: new Map(),
  humanForecastBusy: false,
  humanForecastNext: null,
  aiSettings: {
    preset: "openai",
    endpoint: AI_PRESETS.openai.endpoint,
    model: AI_PRESETS.openai.model,
    apiKey: "",
  },
};

let board = null;
let engine = null;

const dom = {
  openingTag: document.getElementById("openingTag"),
  gameMetaSubtitle: document.getElementById("gameMetaSubtitle"),
  depthSelect: document.getElementById("depthSelect"),
  reanalyzeBtn: document.getElementById("reanalyzeBtn"),
  pastePgnBtn: document.getElementById("pastePgnBtn"),
  soundToggleBtn: document.getElementById("soundToggleBtn"),
  soundOnIcon: document.getElementById("soundOnIcon"),
  soundOffIcon: document.getElementById("soundOffIcon"),
  settingsBtn: document.getElementById("settingsBtn"),
  practiceDueBadge: document.getElementById("practiceDueBadge"),
  trainingNotice: document.getElementById("trainingNotice"),

  progressBarWrap: document.getElementById("progressBarWrap"),
  progressFill: document.getElementById("progressFill"),
  progressLabel: document.getElementById("progressLabel"),

  topPlayerSwatch: document.getElementById("topPlayerSwatch"),
  topPlayerName: document.getElementById("topPlayerName"),
  topPlayerRating: document.getElementById("topPlayerRating"),
  topCapturedPieces: document.getElementById("topCapturedPieces"),
  topMaterialLead: document.getElementById("topMaterialLead"),

  bottomPlayerSwatch: document.getElementById("bottomPlayerSwatch"),
  bottomPlayerName: document.getElementById("bottomPlayerName"),
  bottomPlayerRating: document.getElementById("bottomPlayerRating"),
  bottomCapturedPieces: document.getElementById("bottomCapturedPieces"),
  bottomMaterialLead: document.getElementById("bottomMaterialLead"),

  evalBar: document.getElementById("evalBar"),
  evalFillWhite: document.getElementById("evalFillWhite"),
  evalScoreLabel: document.getElementById("evalScoreLabel"),
  boardThemeWrap: document.getElementById("boardThemeWrap"),
  boardEl: document.getElementById("board"),
  squareBadgeOverlay: document.getElementById("squareBadgeOverlay"),

  variationBanner: document.getElementById("variationBanner"),
  variationMovesText: document.getElementById("variationMovesText"),
  variationEvalTag: document.getElementById("variationEvalTag"),
  snapBackBtn: document.getElementById("snapBackBtn"),

  navFirstBtn: document.getElementById("navFirstBtn"),
  navPrevBtn: document.getElementById("navPrevBtn"),
  navPlayBtn: document.getElementById("navPlayBtn"),
  playIcon: document.getElementById("playIcon"),
  pauseIcon: document.getElementById("pauseIcon"),
  navNextBtn: document.getElementById("navNextBtn"),
  navLastBtn: document.getElementById("navLastBtn"),
  flipBoardBtn: document.getElementById("flipBoardBtn"),

  tabReviewBtn: document.getElementById("tabReviewBtn"),
  tabMovesBtn: document.getElementById("tabMovesBtn"),
  tabDrillsBtn: document.getElementById("tabDrillsBtn"),
  plyCounter: document.getElementById("plyCounter"),
  drillCountBadge: document.getElementById("drillCountBadge"),
  panelReview: document.getElementById("panelReview"),
  panelMoves: document.getElementById("panelMoves"),
  panelDrills: document.getElementById("panelDrills"),

  coachCard: document.getElementById("coachCard"),
  moveBadge: document.getElementById("moveBadge"),
  moveHeadline: document.getElementById("moveHeadline"),
  coachMotifTag: document.getElementById("coachMotifTag"),
  moveSubline: document.getElementById("moveSubline"),
  evalDeltaStrip: document.getElementById("evalDeltaStrip"),
  evalDeltaText: document.getElementById("evalDeltaText"),
  practicalImpactText: document.getElementById("practicalImpactText"),
  moveDifficultyText: document.getElementById("moveDifficultyText"),
  temptingMoveText: document.getElementById("temptingMoveText"),
  gradeConfidenceText: document.getElementById("gradeConfidenceText"),
  engineLossText: document.getElementById("engineLossText"),
  moveAccuracyPill: document.getElementById("moveAccuracyPill"),
  pvLinesBox: document.getElementById("pvLinesBox"),
  pvLineWrap: document.getElementById("pvLineWrap"),
  pvEval1: document.getElementById("pvEval1"),
  pvLineText: document.getElementById("pvLineText"),
  pvLine2Wrap: document.getElementById("pvLine2Wrap"),
  pvEval2: document.getElementById("pvEval2"),
  pvLine2Text: document.getElementById("pvLine2Text"),
  coachActionsRow: document.getElementById("coachActionsRow"),
  retryThisMoveBtn: document.getElementById("retryThisMoveBtn"),
  showBestLineBtn: document.getElementById("showBestLineBtn"),
  coachReply: document.getElementById("coachReply"),
  coachReplyText: document.getElementById("coachReplyText"),
  showReplyBtn: document.getElementById("showReplyBtn"),
  playReplyBtn: document.getElementById("playReplyBtn"),
  deepCheckBtn: document.getElementById("deepCheckBtn"),
  deepCheckResult: document.getElementById("deepCheckResult"),
  deepCheckStatus: document.getElementById("deepCheckStatus"),
  deepCheckLine: document.getElementById("deepCheckLine"),
  playDeepLineBtn: document.getElementById("playDeepLineBtn"),
  explainMistakeBtn: document.getElementById("explainMistakeBtn"),
  aiCoachOutput: document.getElementById("aiCoachOutput"),
  aiCoachText: document.getElementById("aiCoachText"),
  guidedPrevBtn: document.getElementById("guidedPrevBtn"),
  guidedNextBtn: document.getElementById("guidedNextBtn"),

  evalGraphSvg: document.getElementById("evalGraphSvg"),
  evalTooltip: document.getElementById("evalTooltip"),
  keyMomentsWrap: document.getElementById("keyMomentsWrap"),
  keyMomentsList: document.getElementById("keyMomentsList"),
  openingStudy: document.getElementById("openingStudy"),
  openingStudyName: document.getElementById("openingStudyName"),
  openingDeparture: document.getElementById("openingDeparture"),
  openingDepartureBtn: document.getElementById("openingDepartureBtn"),
  openingChoices: document.getElementById("openingChoices"),
  openingSample: document.getElementById("openingSample"),

  gameResultTag: document.getElementById("gameResultTag"),
  accWhiteName: document.getElementById("accWhiteName"),
  accWhiteVal: document.getElementById("accWhiteVal"),
  accWhiteRing: document.getElementById("accWhiteRing"),
  acplWhiteVal: document.getElementById("acplWhiteVal"),
  qualityWhiteVal: document.getElementById("qualityWhiteVal"),
  worstWhiteVal: document.getElementById("worstWhiteVal"),
  accBlackName: document.getElementById("accBlackName"),
  accBlackVal: document.getElementById("accBlackVal"),
  accBlackRing: document.getElementById("accBlackRing"),
  acplBlackVal: document.getElementById("acplBlackVal"),
  qualityBlackVal: document.getElementById("qualityBlackVal"),
  worstBlackVal: document.getElementById("worstBlackVal"),
  phaseStrip: document.getElementById("phaseStrip"),
  phaseOpeningVal: document.getElementById("phaseOpeningVal"),
  phaseOpeningBar: document.getElementById("phaseOpeningBar"),
  phaseMiddleVal: document.getElementById("phaseMiddleVal"),
  phaseMiddleBar: document.getElementById("phaseMiddleBar"),
  phaseEndVal: document.getElementById("phaseEndVal"),
  phaseEndBar: document.getElementById("phaseEndBar"),
  scoredWhiteMoves: document.getElementById("scoredWhiteMoves"),
  scoredBlackMoves: document.getElementById("scoredBlackMoves"),
  performanceContext: document.getElementById("performanceContext"),
  peerWhiteContext: document.getElementById("peerWhiteContext"),
  peerBlackContext: document.getElementById("peerBlackContext"),
  personalContext: document.getElementById("personalContext"),
  breakdownBody: document.getElementById("breakdownBody"),
  moveList: document.getElementById("moveList"),

  drillCounter: document.getElementById("drillCounter"),
  drillDots: document.getElementById("drillDots"),
  drillPromptText: document.getElementById("drillPromptText"),
  drillControls: document.getElementById("drillControls"),
  drillHintBtn: document.getElementById("drillHintBtn"),
  drillRevealBtn: document.getElementById("drillRevealBtn"),
  drillNextBtn: document.getElementById("drillNextBtn"),
  drillDoneCard: document.getElementById("drillDoneCard"),
  drillDoneSummary: document.getElementById("drillDoneSummary"),
  drillRestartBtn: document.getElementById("drillRestartBtn"),

  settingsBackdrop: document.getElementById("settingsBackdrop"),
  settingsDrawer: document.getElementById("settingsDrawer"),
  closeSettingsBtn: document.getElementById("closeSettingsBtn"),
  themeChips: Array.from(document.querySelectorAll(".theme-chip")),
  aiPresetSelect: document.getElementById("aiPresetSelect"),
  aiEndpointInput: document.getElementById("aiEndpointInput"),
  aiModelInput: document.getElementById("aiModelInput"),
  aiApiKeyInput: document.getElementById("aiApiKeyInput"),
  fallbackUsernameInput: document.getElementById("fallbackUsernameInput"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  settingsSavedMsg: document.getElementById("settingsSavedMsg"),

  pgnModalBackdrop: document.getElementById("pgnModalBackdrop"),
  pgnErrorBanner: document.getElementById("pgnErrorBanner"),
  closePgnModalBtn: document.getElementById("closePgnModalBtn"),
  cancelPgnBtn: document.getElementById("cancelPgnBtn"),
  loadPgnConfirmBtn: document.getElementById("loadPgnConfirmBtn"),
  pgnColorSelect: document.getElementById("pgnColorSelect"),
  pgnPracticeCheck: document.getElementById("pgnPracticeCheck"),
  pgnTextarea: document.getElementById("pgnTextarea"),
  recentGamesWrap: document.getElementById("recentGamesWrap"),
  recentGamesList: document.getElementById("recentGamesList"),
};

function applyBoardTheme(themeName) {
  const valid = ["emerald", "slate", "walnut"].includes(themeName) ? themeName : "emerald";
  state.boardTheme = valid;
  dom.boardThemeWrap.classList.remove("theme-emerald", "theme-slate", "theme-walnut");
  dom.boardThemeWrap.classList.add(`theme-${valid}`);
  dom.themeChips.forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.theme === valid);
  });
}

dom.themeChips.forEach((chip) => {
  chip.addEventListener("click", async () => {
    applyBoardTheme(chip.dataset.theme);
    try {
      await extension.storage.local.set({ boardTheme: state.boardTheme });
    } catch {
      // Ignore outside extension
    }
  });
});

function updateSoundIcon() {
  dom.soundOnIcon.classList.toggle("hidden", !state.soundEnabled);
  dom.soundOffIcon.classList.toggle("hidden", state.soundEnabled);
}

function updatePlayIcon(isPlaying) {
  dom.playIcon.classList.toggle("hidden", isPlaying);
  dom.pauseIcon.classList.toggle("hidden", !isPlaying);
  dom.navPlayBtn.classList.toggle("playing", isPlaying);
}

function updateAccuracyRing(valEl, ringEl, value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    valEl.textContent = "--";
    ringEl.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
    return;
  }
  const clamped = Math.max(0, Math.min(100, value));
  valEl.textContent = `${clamped.toFixed(1)}%`;
  const offset = RING_CIRCUMFERENCE * (1 - clamped / 100);
  ringEl.style.strokeDashoffset = offset.toFixed(2);
}

function switchTab(tabName) {
  state.activeTab = tabName;
  if (tabName !== "review") cancelDeepCheck();
  const map = {
    review: [dom.tabReviewBtn, dom.panelReview],
    moves: [dom.tabMovesBtn, dom.panelMoves],
    drills: [dom.tabDrillsBtn, dom.panelDrills],
  };

  for (const [key, [btn, panel]] of Object.entries(map)) {
    const active = key === tabName;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
    panel.classList.toggle("hidden", !active);
  }

  if (tabName === "drills") {
    startDrillModeIfAvailable();
  } else if (state.drillActive) {
    exitDrillMode();
  }
  renderDeepCheck(state.currentPly);
}

dom.pgnTextarea.addEventListener("input", () => {
  const side = pgnSideFor(dom.pgnTextarea.value, [dom.fallbackUsernameInput.value]);
  if (side) dom.pgnColorSelect.value = side;
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshPracticeBadge();
});
dom.tabReviewBtn.addEventListener("click", () => switchTab("review"));
dom.tabMovesBtn.addEventListener("click", () => switchTab("moves"));
dom.tabDrillsBtn.addEventListener("click", () => switchTab("drills"));

function parseUci(uci) {
  if (!uci || uci.length < 4) return null;
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length >= 5 ? uci[4].toLowerCase() : undefined,
  };
}

function pvToSan(fen, pvUci, maxMoves = 6) {
  if (!fen || !Array.isArray(pvUci) || pvUci.length === 0) return "";
  const sim = new Chess(fen);
  const out = [];
  for (let i = 0; i < Math.min(pvUci.length, maxMoves); i++) {
    const parsed = parseUci(pvUci[i]);
    if (!parsed) break;
    try {
      const m = sim.move({
        from: parsed.from,
        to: parsed.to,
        promotion: parsed.promotion || "q",
      });
      if (!m) break;
      out.push(m.san);
    } catch {
      break;
    }
  }
  return out.join(" ");
}

function applyUciToFen(fen, uci) {
  const parsed = parseUci(uci);
  if (!parsed) return null;
  try {
    const sim = new Chess(fen);
    const m = sim.move({
      from: parsed.from,
      to: parsed.to,
      promotion: parsed.promotion || "q",
    });
    return m ? sim.fen() : null;
  } catch {
    return null;
  }
}

function extractOpeningName(headers) {
  if (!headers) return "";
  if (headers.Opening) return headers.Opening;
  if (headers.ECOUrl) {
    const slug = headers.ECOUrl.split("/openings/")[1];
    if (slug) {
      try {
        return decodeURIComponent(slug)
          .replace(/-/g, " ")
          .replace(/\b\d+\.\.\.?\S*/g, "")
          .replace(/\s+/g, " ")
          .trim();
      } catch {
        // A malformed opening URL can appear in an imported PGN.
      }
    }
  }
  return headers.ECO ? `ECO ${headers.ECO}` : "";
}

function recordedRating(gameRating, pgnRating) {
  for (const [value, source] of [[gameRating, "Chess.com game record"], [pgnRating, "PGN Elo tag"]]) {
    const rating = Number(value);
    if (Number.isSafeInteger(rating) && rating > 0) return { rating, ratingSource: source };
  }
  return { rating: null, ratingSource: "" };
}

function initBoard(orientation = "w") {
  if (board) {
    board.destroy();
  }

  state.orientation = orientation;
  board = createBoard(dom.boardEl, { orientation });
  enableBoardInput();
}

function enableBoardInput() {
  if (!board) return;
  board.disableMoveInput();

  if (state.drillActive) {
    const allowedColor = state.gameMeta?.playedColor === "b" ? COLOR.black : COLOR.white;
    board.enableMoveInput(handleBoardInput, allowedColor);
  } else {
    board.enableMoveInput(handleBoardInput);
  }
}

function updateSquareBadgeOverlay(ply) {
  const el = dom.squareBadgeOverlay;
  if (state.exploring || (state.drillActive && !state.drillSolved) || ply <= 0) {
    el.classList.add("hidden");
    return;
  }

  const pos = state.positions[ply];
  const rev = state.moveReviews[ply];
  if (!pos?.move || !rev) {
    el.classList.add("hidden");
    return;
  }

  const sq = pos.move.to;
  const file = sq.charCodeAt(0) - 97;
  const rank = Number(sq[1]) - 1;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) {
    el.classList.add("hidden");
    return;
  }

  const col = state.orientation === "w" ? file : 7 - file;
  const row = state.orientation === "w" ? 7 - rank : rank;

  const cls = displayClassification(rev);
  el.textContent = cls.symbol;
  el.title = cls.label;
  el.style.background = cls.color;
  el.style.left = `${(col + 1) * 12.5}%`;
  el.style.top = `${row * 12.5}%`;
  el.classList.remove("hidden");
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
}

function updateCapturedPieces(fen) {
  const { capturedByWhite, capturedByBlack, whiteLead } = computeCapturedAndMaterial(fen);
  const whiteAtBottom = state.orientation === "w";

  const topCaptured = whiteAtBottom ? capturedByBlack : capturedByWhite;
  const bottomCaptured = whiteAtBottom ? capturedByWhite : capturedByBlack;
  const topLead = whiteAtBottom ? (whiteLead < 0 ? `+${-whiteLead}` : "") : (whiteLead > 0 ? `+${whiteLead}` : "");
  const bottomLead = whiteAtBottom ? (whiteLead > 0 ? `+${whiteLead}` : "") : (whiteLead < 0 ? `+${-whiteLead}` : "");

  dom.topCapturedPieces.textContent = topCaptured.join("");
  dom.topMaterialLead.textContent = topLead;
  dom.bottomCapturedPieces.textContent = bottomCaptured.join("");
  dom.bottomMaterialLead.textContent = bottomLead;
}

function handleBoardInput(event) {
  if (event.type === INPUT_EVENT_TYPE.moveInputStarted) {
    if (state.drillActive && (state.drillSolved || state.drillChecking)) {
      return false;
    }
    stopAutoplay();
    stopBestLineAnimation();
    // Legal moves depend only on the FEN; the full history is replayed when the move is committed.
    const activeChess = new Chess(getActiveFen());
    const moves = activeChess.moves({ square: event.squareFrom, verbose: true });
    board.removeMarkers(MARKER_TYPE.dot);
    for (const m of moves) {
      board.addMarker(MARKER_TYPE.dot, m.to);
    }
    return moves.length > 0;
  }

  if (event.type === INPUT_EVENT_TYPE.validateMoveInput) {
    board.removeMarkers(MARKER_TYPE.dot);
    const activeChess = getActiveChessInstance();
    const { squareFrom: from, squareTo: to } = event;
    // Let the player choose the piece. Underpromotion can be the only winning move.
    const epoch = state.boardEpoch;
    const promoting = requestPromotion(board, activeChess, from, to, (chosen) => {
      if (!chosen || !commitBoardMove(activeChess, chosen)) board.setPosition(activeChess.fen(), true);
    }, () => epoch === state.boardEpoch);
    return promoting || commitBoardMove(activeChess, { from, to });
  }

  if (event.type === INPUT_EVENT_TYPE.moveInputCanceled) {
    board.removeMarkers(MARKER_TYPE.dot);
  }
  return true;
}

function commitBoardMove(activeChess, move) {
  let moveObj = null;
  try {
    moveObj = activeChess.move(move);
  } catch {
    return false;
  }
  if (!moveObj) return false;

  playSound(moveObj.san.includes("+") ? "check" : moveObj.captured ? "capture" : "move");
  const uci = moveToUci(moveObj);
  // Castling, en passant, and promotion change more than the dragged piece.
  board.setPosition(activeChess.fen(), true);

  if (state.drillActive) {
    const epoch = state.boardEpoch;
    const stillCurrent = () => state.drillActive && !state.drillSolved && state.boardEpoch === epoch;
    state.drillChecking = true;
    setTimeout(() => {
      if (stillCurrent()) evaluateDrillAttempt(moveObj, uci, activeChess.isCheckmate(), stillCurrent);
    }, 40);
    return true;
  }

  if (!state.exploring) {
    state.exploring = true;
    state.variationBasePly = state.currentPly;
    state.variationUci = [];
    state.variationMoves = [];
  }
  state.variationUci.push(uci);
  state.variationMoves.push(moveObj.san);
  state.coachReplyPly = null;
  board.removeArrows();
  board.removeMarkers(MARKER_TYPE.frameDanger);
  dom.squareBadgeOverlay.classList.add("hidden");
  updateCapturedPieces(activeChess.fen());
  renderVariationBanner();
  evaluateVariationPosition();
  return true;
}

async function evaluateVariationPosition() {
  if (!state.exploring) return;
  const runId = ++state.variationEvalRunId;
  let position;
  try {
    position = describeVariation(state.positions[state.variationBasePly], state.variationUci);
  } catch {
    return;
  }
  // A repeated position is a claimable draw, not a finished game. Stockfish receives the same history.
  const drawRule = position.repetition ? "threefold" : position.fiftyMoves ? "50-move" : "";
  dom.variationEvalTag.title = drawRule ? `A draw can be claimed under the ${drawRule} rule` : "";
  const withRule = (text) => drawRule ? `${text} · ${drawRule}` : text;
  if (position.terminal) {
    dom.variationEvalTag.textContent = position.terminal.checkmate ? "#" : "½–½";
    updateEvalBarFromData(position.terminal);
    board.removeArrows();
    return;
  }
  if (!engine || state.isAnalyzing) {
    dom.variationEvalTag.textContent = withRule("");
    return;
  }
  dom.variationEvalTag.textContent = withRule("Eval...");
  try {
    const res = await analyzeGamePosition(engine, position, 12);
    if (runId !== state.variationEvalRunId || !state.exploring) return;
    dom.variationEvalTag.textContent = withRule(formatEval(res.eval));
    updateEvalBarFromData(res);
    board.removeArrows();
    const best = parseUci(res.bestMove);
    if (best) {
      board.addArrow(ARROW_BEST, best.from, best.to);
    }
  } catch {
    // Ignore interrupted variation eval
  }
}

function getActiveFen() {
  if (state.exploring) return getActiveChessInstance().fen();
  return state.positions[state.currentPly]?.fen ?? new Chess().fen();
}

/** The board position with its full game history, including any explored moves. */
function getActiveChessInstance() {
  const base = state.positions[state.exploring ? state.variationBasePly : state.currentPly];
  if (!base) return new Chess();
  return replayVariation(base, state.exploring ? state.variationUci : []);
}

function renderVariationBanner() {
  if (state.exploring) {
    dom.variationBanner.classList.remove("hidden");
    dom.variationMovesText.textContent = state.variationMoves.join(" ");
  } else {
    dom.variationBanner.classList.add("hidden");
    dom.variationMovesText.textContent = "";
    dom.variationEvalTag.textContent = "";
    dom.variationEvalTag.title = "";
  }
  renderOpeningStudy();
  renderCoachReply(state.currentPly);
}

function gameMoveLabel(ply) {
  const move = state.positions[ply].move;
  return `${move.number}${move.color === "w" ? "." : "..."} ${move.san}`;
}

function renderOpeningStudy() {
  if (!dom.openingStudy.open || dom.openingStudy.classList.contains("hidden")) return;
  const departure = state.openingDeparturePly;
  const reentry = state.openingReentryPly;
  dom.openingDeparture.textContent = departure < 0 ? "The game follows the bundled book through its coverage." :
    `First move outside the book: ${gameMoveLabel(departure)}.${reentry > departure ? ` Back in book at ${gameMoveLabel(reentry)}.` : ""}`;
  dom.openingDepartureBtn.classList.toggle("hidden", departure < 0);

  const ply = state.exploring ? state.variationBasePly + state.variationUci.length : state.currentPly;
  const choices = ply < OPENING_EXPLORER_SAMPLE.maxPly ? openingChoices(getActiveFen(), ply + 1) : [];
  dom.openingChoices.replaceChildren(...choices.slice(0, 6).map(openingChoiceButton));
  const { games, minRating } = OPENING_EXPLORER_SAMPLE;
  dom.openingSample.textContent = choices.length
    ? `From ${games.toLocaleString()} rated Lichess games, both players ${minRating}+. Results are for White, draws, then Black.`
    : "This position has no sampled opening continuations.";
}

function openingChoiceButton(choice) {
  const { uci, san, games, whiteWins, draws, blackWins, exampleMoves, exampleUrl } = choice;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "opening-choice";
  const move = document.createElement("strong");
  move.textContent = san;
  const count = document.createElement("span");
  count.textContent = `${games.toLocaleString()} ${games === 1 ? "game" : "games"}`;

  const outcomes = document.createElement("span");
  outcomes.className = "opening-outcomes";
  const percentages = [whiteWins, draws, blackWins].map((result) => result * 100 / games);
  const bar = document.createElement("span");
  bar.className = "opening-outcome-bar";
  bar.setAttribute("aria-hidden", "true");
  for (const share of percentages) {
    const segment = document.createElement("span");
    segment.style.width = `${share}%`;
    bar.appendChild(segment);
  }
  const resultText = document.createElement("span");
  resultText.textContent = percentages.map((share, index) => `${share.toFixed(0)}% ${["W", "D", "B"][index]}`).join(" · ");
  outcomes.append(bar, resultText);
  button.append(move, count, outcomes);
  button.addEventListener("click", () => {
    stopAutoplay();
    stopBestLineAnimation();
    const parsed = parseUciMove(uci);
    if (parsed && commitBoardMove(getActiveChessInstance(), parsed)) dom.snapBackBtn.focus({ preventScroll: true });
  });
  if (!exampleMoves?.length) return button;

  const entry = document.createElement("div");
  entry.className = "opening-choice-entry";
  const tools = document.createElement("div");
  tools.className = "opening-example-links";
  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "btn btn-sm btn-secondary";
  preview.textContent = `Play ${san} example`;
  preview.addEventListener("click", () => {
    const base = state.exploring ? state.variationBasePly : state.currentPly;
    playVariationOnBoard(base, exampleMoves, ARROW_BEST, state.variationUci);
    dom.snapBackBtn.focus({ preventScroll: true });
  });
  tools.appendChild(preview);
  if (typeof exampleUrl === "string" && /^https:\/\/lichess\.org\/[A-Za-z0-9]{8}$/.test(exampleUrl)) {
    const link = document.createElement("a");
    link.textContent = "Source game";
    link.href = exampleUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    tools.appendChild(link);
  }
  entry.append(button, tools);
  return entry;
}

dom.openingStudy.addEventListener("toggle", renderOpeningStudy);
dom.openingDepartureBtn.addEventListener("click", () => {
  if (state.openingDeparturePly < 1) return;
  stopAutoplay();
  goToPly(state.openingDeparturePly - 1);
});

function clearVariationState() {
  state.exploring = false;
  state.variationBasePly = 0;
  state.variationUci = [];
  state.variationMoves = [];
}

function exitVariation() {
  stopBestLineAnimation();
  if (!state.exploring) return;
  clearVariationState();
  state.variationEvalRunId++;
  renderVariationBanner();
  goToPly(state.currentPly, true);
}

function stopBestLineAnimation() {
  if (state.bestLineTimer) {
    clearTimeout(state.bestLineTimer);
    state.bestLineTimer = null;
  }
}

function playVariationOnBoard(basePly, pvMoves, arrow, prefix = []) {
  const base = state.positions[basePly];
  if (!base || !pvMoves.length) return;
  stopAutoplay();
  stopBestLineAnimation();

  const sim = replayVariation(base, prefix);
  state.boardEpoch++;
  state.variationEvalRunId++;
  state.coachReplyPly = null;
  state.exploring = true;
  state.variationBasePly = basePly;
  state.variationUci = prefix.slice();
  state.variationMoves = prefix.length ? sim.history().slice(-prefix.length) : [];
  board.removeArrows();
  board.removeMarkers(MARKER_TYPE.frameDanger);
  dom.squareBadgeOverlay.classList.add("hidden");
  board.setPosition(sim.fen(), true);
  updateCapturedPieces(sim.fen());
  renderVariationBanner();

  let step = 0;
  const playNext = () => {
    state.bestLineTimer = null;
    if (!state.exploring) return;
    if (step >= pvMoves.length) {
      evaluateVariationPosition();
      return;
    }
    const parsed = parseUciMove(pvMoves[step]);
    if (!parsed) return;
    try {
      const m = sim.move(parsed);
      if (!m) return;
      state.variationUci.push(moveToUci(m));
      state.variationMoves.push(m.san);
      board.setPosition(sim.fen(), true);
      board.removeArrows();
      board.addArrow(arrow, m.from, m.to);
      updateCapturedPieces(sim.fen());
      playSound(m.san.includes("+") ? "check" : m.captured ? "capture" : "move");
      renderVariationBanner();
      step++;
      state.bestLineTimer = setTimeout(playNext, 700);
    } catch {
      // Keep the legal part of the variation on the board.
    }
  };

  state.bestLineTimer = setTimeout(playNext, 280);
}

dom.showBestLineBtn.addEventListener("click", () => {
  const before = state.currentPly - 1;
  playVariationOnBoard(before, state.evals[before]?.pv.slice(0, 6) ?? [], ARROW_BEST);
});

function loadGameFromPayload(payload) {
  if (!payload || !payload.pgn) return { ok: false, error: "Empty PGN." };
  stopAutoplay();
  stopBestLineAnimation();

  let game;
  try {
    game = parseReviewGame(payload.pgn, payload.timeControl);
  } catch (err) {
    return { ok: false, error: `Could not parse PGN: ${err.message}` };
  }
  const { headers, positions } = game;
  state.gameHeaders = headers;
  cancelDeepCheck();
  state.deepChecks.clear();
  clearPerformanceContext();
  dom.trainingNotice.classList.add("hidden");
  if (state.isAnalyzing) engine?.abort();
  state.analysisRunId++;
  state.isAnalyzing = false;

  const whiteName = payload.white?.username || headers.White || "White";
  const blackName = payload.black?.username || headers.Black || "Black";
  const result = headers.Result || "*";
  const bookMoves = findBookMoves(positions);
  const opening = extractOpeningName(headers) || bookMoves.findLast((match) => match?.name)?.name || "";

  state.gameMeta = {
    ...payload,
    result,
    opening,
    white: { username: whiteName, ...recordedRating(payload.white?.rating, headers.WhiteElo), result: payload.white?.result || "" },
    black: { username: blackName, ...recordedRating(payload.black?.rating, headers.BlackElo), result: payload.black?.result || "" },
    playedColor: payload.playedColor || positions[1].move.color,
  };

  state.positions = positions;
  state.bookMoves = bookMoves;
  state.openingDeparturePly = bookMoves.findIndex((match, ply) => ply > 0 && ply <= BOOK_MAX_PLY && !match);
  state.openingReentryPly = state.openingDeparturePly < 0 ? -1 :
    bookMoves.findIndex((match, ply) => ply > state.openingDeparturePly && match);
  dom.openingStudy.open = false;
  dom.openingStudy.classList.toggle("hidden", positions[0].searchOptions.initialFen !== DEFAULT_POSITION);
  dom.openingStudyName.textContent = opening;
  state.coachReplyPly = null;
  state.evals = new Array(positions.length).fill(null);
  state.moveReviews = new Array(positions.length).fill(null);
  state.currentPly = 0;
  clearVariationState();
  resetDrillProgress();
  state.coachCache.clear();
  state.humanForecasts.clear();

  dom.keyMomentsWrap.classList.add("hidden");
  dom.phaseStrip.classList.add("hidden");
  dom.drillCountBadge.classList.add("hidden");
  renderVariationBanner();

  switchTab("review");
  initBoard(state.gameMeta.playedColor);
  renderPlayerStrips();
  renderMoveList();
  renderEvalGraph();
  goToPly(0, false);

  dom.gameResultTag.textContent = result;
  dom.accWhiteName.textContent = whiteName;
  dom.accBlackName.textContent = blackName;
  updateScoreboard();

  if (opening) {
    dom.openingTag.textContent = opening;
    dom.openingTag.classList.remove("hidden");
  } else {
    dom.openingTag.classList.add("hidden");
  }

  const tcLabel = state.gameMeta.timeClass ? ` • ${state.gameMeta.timeClass}` : "";
  dom.gameMetaSubtitle.textContent = `${whiteName} vs ${blackName}${tcLabel} (${positions.length - 1} plies)`;

  return { ok: true };
}

function renderPlayerStrips() {
  if (!state.gameMeta) return;
  const white = state.gameMeta.white;
  const black = state.gameMeta.black;

  const top = state.orientation === "w" ? black : white;
  const bottom = state.orientation === "w" ? white : black;
  const topColor = state.orientation === "w" ? "black" : "white";
  const bottomColor = state.orientation === "w" ? "white" : "black";

  dom.topPlayerSwatch.className = `player-swatch ${topColor}`;
  dom.topPlayerName.textContent = top.username;
  dom.topPlayerRating.textContent = top.rating ? `(${top.rating})` : "";
  dom.topPlayerRating.title = top.rating ? `Player rating from ${top.ratingSource}` : "";

  dom.bottomPlayerSwatch.className = `player-swatch ${bottomColor}`;
  dom.bottomPlayerName.textContent = bottom.username;
  dom.bottomPlayerRating.textContent = bottom.rating ? `(${bottom.rating})` : "";
  dom.bottomPlayerRating.title = bottom.rating ? `Player rating from ${bottom.ratingSource}` : "";
}

function showTrainingNotice(text) {
  dom.trainingNotice.textContent = text;
  dom.trainingNotice.classList.remove("hidden");
}

/** Show how many practice puzzles are due on the header's Practice link. */
async function refreshPracticeBadge() {
  try {
    const data = await loadTraining(trainingArea);
    const due = dueCount([...data.puzzles.values()], localDate());
    dom.practiceDueBadge.textContent = String(due);
    dom.practiceDueBadge.classList.toggle("hidden", due === 0);
  } catch {
    dom.practiceDueBadge.classList.add("hidden");
  }
}

/** Save the finished review's summary and the user's mistakes as practice puzzles. */
async function recordReviewedGame(runId, depth) {
  dom.trainingNotice.classList.add("hidden");
  const meta = state.gameMeta;
  if (!meta?.pgn) return;
  try {
    // Read everything from state before the first await: it is consistent only at the end of a finished run.
    const playedColor = confirmedSide(meta, dom.fallbackUsernameInput.value);
    if (!playedColor) {
      if (/^\d+$/.test(String(meta.gameId ?? ""))) {
        const known = [meta.accountUsername, dom.fallbackUsernameInput.value].some((n) => typeof n === "string" && n.trim());
        showTrainingNotice(known
          ? "Not saved for practice: you aren't a player in this game."
          : "Not saved for practice: ChessBot couldn't tell which side you played. Add your Chess.com username in Settings.");
      }
      return;
    }
    const { initialFen, history } = state.positions.at(-1).searchOptions;
    const today = localDate();
    const source = { positions: state.positions, evals: state.evals, moveReviews: state.moveReviews, playedColor };
    const decisions = userDecisions(source);
    const accuracy = gameAccuracy(source);
    const opponent = (playedColor === "w" ? meta.black : meta.white)?.username ?? "";
    const date = gameDate({ endTime: meta.endTime, headers: state.gameHeaders ?? {} }, today);
    const result = userResult(meta.result, playedColor);
    const { gameId = null, pgn, timeClass, timeControl = null, endTime = null } = meta;

    const data = await loadTraining(trainingArea);
    if (!data.writable || runId !== state.analysisRunId) return;
    const gameKey = await gameKeyFor({ gameId, initialFen, history });
    if (runId !== state.analysisRunId) return;
    const previous = data.games.get(gameKey);

    const summary = summarizeGame({
      gameKey,
      reviewedAt: previous?.reviewedAt ?? Date.now(),
      date,
      color: playedColor,
      result,
      timeClass,
      opponent,
      depth,
      decisions,
      ...accuracy,
    });
    const game = { ...summary, gameId, pgn, timeControl, endTime };
    renderPersonalPerformance(comparePersonalPerformance({ current: game, history: [...data.games.values()] }));
    if (previous && previous.color === playedColor && previous.depth > depth) return;
    const existing = [...data.puzzles.values()].filter((puzzle) => puzzle.gameKey === gameKey);
    const { puzzles, removedIds } = puzzlesFromDecisions({
      gameKey, color: playedColor, opponent, gameDate: date, decisions, today, existing,
    });
    await saveReview(trainingArea, { game, puzzles, removedIds });
    if (runId === state.analysisRunId) await refreshPracticeBadge();
  } catch {
    if (runId === state.analysisRunId) showTrainingNotice("Couldn't save practice puzzles from this game.");
  }
}

async function runFullAnalysis() {
  if (!state.positions.length || state.isAnalyzing) return;

  const runId = ++state.analysisRunId;
  state.isAnalyzing = true;
  const depth = Number(dom.depthSelect.value) || 16;

  cancelDeepCheck();
  state.deepChecks.clear();
  clearPerformanceContext();
  dom.progressBarWrap.classList.remove("hidden");
  dom.progressFill.style.width = "0%";
  dom.progressLabel.textContent = "Loading Stockfish 19…";
  dom.reanalyzeBtn.disabled = true;
  state.evals.fill(null);
  state.moveReviews.fill(null);
  state.coachCache.clear();
  state.humanForecasts.clear();
  switchTab("review");
  resetDrillProgress();
  updateScoreboard();
  renderKeyMoments();
  renderMoveList();
  updateDrillBadgeCount();
  goToPly(state.currentPly, false);

  try {
    engine ??= new StockfishEngine(STOCKFISH_WORKER_PATH);
    await engine.startNewGame();

    const total = state.positions.length;
    for (let i = 0; i < total; i++) {
      if (runId !== state.analysisRunId) return;
      const pos = state.positions[i];
      dom.progressLabel.textContent = `Stockfish 19 · position ${i + 1} of ${total} · depth target ${depth}`;

      const evalResult = await analyzeGamePosition(engine, pos, depth);
      if (runId !== state.analysisRunId) return;
      state.evals[i] = evalResult;
      if (i >= 1) {
        const before = state.positions[i - 1];
        const prevOpponentWinLoss = state.moveReviews[i - 1]?.winLoss ?? 0;
        const initialRoot = state.evals[i - 1];
        const compared = await analyzeDecision(engine, before, pos, depth, initialRoot, prevOpponentWinLoss);
        if (runId !== state.analysisRunId) return;
        const { root } = compared;
        state.evals[i - 1] = root;
        const review = scoreDecision(before, pos, compared, prevOpponentWinLoss);
        state.moveReviews[i] = {
          ...review,
          book: bookForReview(pos.terminal ? null : state.bookMoves[i], review),
          peerDifficulty: peerDecisionPrediction(before, initialRoot, pos.move.color),
          coachReply: coachEvidence(pos, review),
          bestSan: pvToSan(before.fen, root.pv, 1),
          pvSan: pvToSan(before.fen, root.pv),
          pvEvalStr: formatEval(root.eval),
          secondPvSan: pvToSan(before.fen, root.secondPv, 5),
          secondEvalStr: root.secondEval ? formatEval(root.secondEval) : "",
          playedPvSan: pvToSan(before.fen, review.playedPv),
        };
      }
      dom.progressFill.style.width = `${Math.round((i + 1) / total * 100)}%`;

      if (i % 2 === 0 || i === total - 1) {
        updateScoreboard();
        renderEvalGraph();
        renderMoveList();
        renderKeyMoments();
        if (state.currentPly === i || state.currentPly === i - 1) {
          updateEvalBar(state.currentPly);
          updateArrowsForPly(state.currentPly);
          updateSquareBadgeOverlay(state.currentPly);
          renderCoachCard(state.currentPly);
        }
      }
    }

    state.isAnalyzing = false;
    dom.progressLabel.textContent = "Stockfish 19 review complete";
    setTimeout(() => {
      if (runId === state.analysisRunId) {
        dom.progressBarWrap.classList.add("hidden");
      }
    }, 1200);

    updateScoreboard();
    renderPeerPerformance(depth);
    renderEvalGraph();
    renderMoveList();
    renderKeyMoments();
    updateDrillBadgeCount();
    goToPly(state.currentPly, false);
    recordReviewedGame(runId, depth);
  } catch (err) {
    if (runId !== state.analysisRunId) return;
    dom.progressLabel.textContent = `Engine error: ${err.message}`;
  } finally {
    if (runId === state.analysisRunId) {
      state.isAnalyzing = false;
      dom.reanalyzeBtn.disabled = false;
    }
  }
}

function goToPly(ply, animate = true, withSound = false) {
  if (!state.positions.length) return;
  stopBestLineAnimation();
  const clamped = Math.max(0, Math.min(state.positions.length - 1, ply));
  if (clamped !== state.currentPly) cancelDeepCheck();
  state.currentPly = clamped;
  state.coachReplyPly = null;
  state.boardEpoch++;
  state.drillChecking = false;

  if (state.exploring) {
    clearVariationState();
    renderVariationBanner();
  }

  const pos = state.positions[clamped];
  if (board) {
    board.setPosition(pos.fen, animate);
    board.removeMarkers(MARKER_TYPE.square);
    board.removeMarkers(MARKER_TYPE.circle);
    if (pos.move && !state.drillActive) {
      board.addMarker(MARKER_TYPE.square, pos.move.from);
      board.addMarker(MARKER_TYPE.square, pos.move.to);
    }
  }

  if (withSound && pos.move) {
    playSound(pos.move.san.includes("+") ? "check" : pos.move.captured ? "capture" : "move");
  }

  dom.plyCounter.textContent = `${state.positions.length - 1}`;
  updateCapturedPieces(pos.fen);
  updateEvalBar(clamped);
  updateArrowsForPly(clamped);
  updateSquareBadgeOverlay(clamped);
  renderCoachCard(clamped);
  renderOpeningStudy();
  updateGuidedCta(clamped);
  highlightActiveMoveInList(clamped);
  renderEvalGraph();
}

function updateGuidedCta(ply) {
  const lastPly = state.positions.length - 1;
  dom.guidedPrevBtn.disabled = ply <= 0;

  if (ply === 0) {
    dom.guidedNextBtn.textContent = "Start Review →";
    dom.guidedNextBtn.disabled = lastPly === 0;
  } else if (ply >= lastPly) {
    const mistakes = getPlayerMistakePlies();
    if (mistakes.length > 0) {
      dom.guidedNextBtn.textContent = `Retry Your ${mistakes.length} Mistake${mistakes.length > 1 ? "s" : ""} →`;
      dom.guidedNextBtn.disabled = false;
    } else {
      dom.guidedNextBtn.textContent = "Review Complete ✓";
      dom.guidedNextBtn.disabled = true;
    }
  } else {
    dom.guidedNextBtn.textContent = "Next Move →";
    dom.guidedNextBtn.disabled = false;
  }
}

dom.guidedPrevBtn.addEventListener("click", () => {
  stopAutoplay();
  if (state.exploring) exitVariation();
  else goToPly(state.currentPly - 1, true, true);
});

dom.guidedNextBtn.addEventListener("click", () => {
  stopAutoplay();
  if (state.currentPly >= state.positions.length - 1) {
    if (getPlayerMistakePlies().length > 0) {
      switchTab("drills");
    }
    return;
  }
  goToPly(state.currentPly + 1, true, true);
});

function updateEvalBarFromData(evalData) {
  const winWhite = evalData ? evalData.winWhite : 50;
  const label = evalData ? formatEval(evalData.eval) : "0.0";

  dom.evalBar.classList.toggle("flipped", state.orientation === "b");
  dom.evalFillWhite.style.height = `${Math.max(4, Math.min(96, winWhite))}%`;
  dom.evalScoreLabel.textContent = evalData?.checkmate ? "#" : label;
  const wdl = evalData?.wdl;
  dom.evalBar.title = wdl
    ? `White · win ${wdl.win / 10}% · draw ${wdl.draw / 10}% · loss ${wdl.loss / 10}%`
    : "Stockfish expected score";

  const whiteAdvantage = winWhite >= 50;
  const whiteAtBottom = state.orientation === "w";
  const placeAtTop = (whiteAdvantage && !whiteAtBottom) || (!whiteAdvantage && whiteAtBottom);
  dom.evalScoreLabel.classList.toggle("top-dark", placeAtTop);
}

function updateEvalBar(ply) {
  updateEvalBarFromData(state.evals[ply]);
}

function updateArrowsForPly(ply) {
  if (!board) return;
  board.removeArrows();
  board.removeMarkers(MARKER_TYPE.frameDanger);

  if (state.drillActive && !state.drillSolved) return;
  if (ply <= 0) return;

  const pos = state.positions[ply];
  const review = state.moveReviews[ply];
  if (!pos || !pos.move || !review) return;
  if (state.coachReplyPly === ply && review.coachReply) {
    const { from, to, square } = review.coachReply;
    board.addArrow(ARROW_COACH_REPLY, from, to);
    board.addMarker(MARKER_TYPE.frameDanger, square);
    return;
  }

  const clsKey = review.classification.key;
  const isError = clsKey === "inaccuracy" || clsKey === "mistake" || clsKey === "miss" || clsKey === "blunder";

  if (isError) {
    board.addArrow(ARROW_PLAYED_BAD, pos.move.from, pos.move.to);
    const best = parseUci(review.bestMoveUci);
    if (best) {
      board.addArrow(ARROW_BEST, best.from, best.to);
    }
  } else if (clsKey === "brilliant") {
    board.addArrow(ARROW_BRILLIANT, pos.move.from, pos.move.to);
  } else {
    const best = parseUci(review.bestMoveUci);
    if (best) {
      board.addArrow(ARROW_BEST, best.from, best.to);
    }
  }
}

function renderCoachReply(ply) {
  const reply = state.moveReviews[ply]?.coachReply;
  dom.coachReply.classList.toggle("hidden", !reply);
  if (!reply) return;
  dom.coachReplyText.textContent = reply.text;
  const shown = state.coachReplyPly === ply;
  dom.showReplyBtn.setAttribute("aria-pressed", String(shown));
  dom.showReplyBtn.textContent = shown ? "Hide reply arrow" : "Show on board";
}

dom.showReplyBtn.addEventListener("click", () => {
  const ply = state.currentPly;
  if (!state.moveReviews[ply]?.coachReply) return;
  stopAutoplay();
  if (state.exploring) exitVariation();
  state.coachReplyPly = state.coachReplyPly === ply ? null : ply;
  updateArrowsForPly(ply);
  renderCoachReply(ply);
});

dom.playReplyBtn.addEventListener("click", () => {
  const ply = state.currentPly;
  playVariationOnBoard(ply, state.moveReviews[ply]?.coachReply?.line ?? [], ARROW_COACH_REPLY);
});

function cancelDeepCheck() {
  const check = state.deepCheck;
  state.deepCheck = null;
  check?.worker.abort();
}

function renderDeepCheck(ply) {
  const review = state.moveReviews[ply];
  const canCheck = review && !review.forced && !state.isAnalyzing;
  const running = state.deepCheck?.ply === ply;
  const stored = state.deepChecks.get(ply);
  dom.deepCheckBtn.classList.toggle("hidden", !canCheck);
  dom.deepCheckBtn.textContent = running ? "Cancel check" : stored?.line ? "Check again" : "Deep Check";
  dom.deepCheckResult.classList.toggle("hidden", !running && !stored);
  dom.deepCheckStatus.textContent = running ? "Stockfish is checking this decision at a higher depth…" : stored?.status ?? "";
  dom.deepCheckLine.textContent = running ? "" : stored?.line ?? "";
  dom.playDeepLineBtn.classList.toggle("hidden", running || !stored?.pv?.length);
}

async function checkCurrentDecision() {
  const ply = state.currentPly;
  if (state.deepCheck) {
    cancelDeepCheck();
    renderDeepCheck(ply);
    return;
  }
  const review = state.moveReviews[ply];
  if (!review || review.forced || state.isAnalyzing) return;
  const before = state.positions[ply - 1];
  const after = state.positions[ply];
  const previousLoss = state.moveReviews[ply - 1]?.winLoss ?? 0;
  const check = { ply, worker: new StockfishEngine(STOCKFISH_WORKER_PATH) };
  state.deepCheck = check;
  renderDeepCheck(ply);
  try {
    await check.worker.startNewGame();
    const comparison = await deepCheckDecision(check.worker, before, after, review.depth, previousLoss);
    if (state.deepCheck !== check) return;
    if (!comparison) {
      state.deepChecks.set(ply, { status: `The local search budget left the original depth-${review.depth} comparison as the deepest available.` });
      return;
    }
    const deeper = scoreDecision(before, after, comparison, previousLoss);
    const change = review.classification.key === deeper.classification.key ? deeper.classification.label :
      `${review.classification.label} → ${deeper.classification.label}`;
    const evidence = { stable: "Two deeper comparisons agree", single: "One deeper comparison", borderline: "Grade still uncertain" };
    state.deepChecks.set(ply, {
      status: `Depth ${deeper.depth} · ${change} · ${deeper.winLoss.toFixed(1)} pts lost. ${evidence[deeper.searchConfidence]}.`,
      line: pvToSan(before.fen, comparison.root.pv),
      pv: comparison.root.pv.slice(0, 6),
    });
  } catch (error) {
    if (state.deepCheck === check) state.deepChecks.set(ply, { status: `Deep Check could not finish. ${error.message}` });
  } finally {
    if (state.deepCheck === check) {
      cancelDeepCheck();
      renderDeepCheck(ply);
    }
  }
}

dom.deepCheckBtn.addEventListener("click", checkCurrentDecision);
dom.playDeepLineBtn.addEventListener("click", () => {
  playVariationOnBoard(state.currentPly - 1, state.deepChecks.get(state.currentPly)?.pv ?? [], ARROW_BEST);
});
window.addEventListener("pagehide", cancelDeepCheck);

function renderCoachCard(ply) {
  dom.aiCoachOutput.classList.add("hidden");
  dom.moveBadge.title = "";
  renderCoachReply(ply);
  renderDeepCheck(ply);

  if (ply === 0) {
    dom.coachCard.style.borderLeftColor = "#81b64c";
    dom.moveBadge.className = "class-badge badge-neutral";
    dom.moveBadge.style.background = "";
    dom.moveBadge.textContent = "•";
    dom.coachMotifTag.classList.add("hidden");
    dom.moveHeadline.textContent = state.gameMeta?.opening || "Game Review Ready";
    dom.moveSubline.textContent = state.isAnalyzing
      ? "Local Stockfish MultiPV is evaluating your game. You can start stepping through moves right away!"
      : "Click Start Review below (or press Enter / ArrowRight) to walk through every move with engine scoring and tactical coaching.";
    dom.evalDeltaStrip.classList.add("hidden");
    dom.pvLinesBox.classList.add("hidden");
    dom.coachActionsRow.classList.add("hidden");
    return;
  }

  const posBefore = state.positions[ply - 1];
  const posAfter = state.positions[ply];
  const review = state.moveReviews[ply];
  const moveNum = posAfter.move.number;
  const movePrefix = posAfter.move.color === "w" ? `${moveNum}.` : `${moveNum}...`;

  if (!review) {
    dom.coachCard.style.borderLeftColor = "#55514a";
    dom.moveBadge.className = "class-badge badge-neutral";
    dom.moveBadge.style.background = "";
    dom.moveBadge.textContent = "…";
    dom.coachMotifTag.classList.add("hidden");
    dom.moveHeadline.textContent = `${movePrefix} ${posAfter.move.san}`;
    dom.moveSubline.textContent = "Stockfish MultiPV is evaluating this position...";
    dom.evalDeltaStrip.classList.add("hidden");
    dom.pvLinesBox.classList.add("hidden");
    dom.coachActionsRow.classList.add("hidden");
    return;
  }

  const cls = displayClassification(review);
  const insight = review.book ? {
    title: `${posAfter.move.san} is a book move`,
    text: review.book.name || "Recorded in the bundled opening book.",
    tag: review.book.eco,
  } : generateLocalCoachInsight({
    ChessClass: Chess,
    fenBefore: posBefore.fen,
    fenAfter: posAfter.fen,
    move: posAfter.move,
    evalBefore: state.evals[ply - 1],
    evalAfter: { eval: review.playedEval, bestMove: review.playedPv[1] },
    review,
  });

  dom.coachCard.style.borderLeftColor = cls.color;
  dom.moveBadge.className = "class-badge";
  dom.moveBadge.style.background = cls.color;
  dom.moveBadge.textContent = cls.symbol;
  dom.moveBadge.title = review.book ? `Book · Stockfish grade ${review.classification.label}` : cls.label;
  dom.moveHeadline.textContent = `${movePrefix} ${insight.title}`;
  dom.moveSubline.textContent = insight.text;

  if (insight.tag) {
    dom.coachMotifTag.textContent = insight.tag;
    dom.coachMotifTag.classList.remove("hidden");
  } else {
    dom.coachMotifTag.classList.add("hidden");
  }

  const evalBeforeStr = formatEval(state.evals[ply - 1]?.eval);
  const evalAfterStr = formatEval(review.playedEval);
  dom.evalDeltaText.textContent = `Best ${evalBeforeStr} · played ${evalAfterStr} · ${review.cpLoss} cp lost`;
  dom.engineLossText.textContent = `Engine expected-score loss ${review.winLoss.toFixed(1)} pts`;
  dom.engineLossText.title = `Stockfish depth ${review.depth}. Expected-score loss uses engine self-play on a 0–100 scale. This loss drives the move grade.`;
  dom.moveAccuracyPill.textContent = review.forced ? "Only legal move" : `Move: ${review.accuracy.toFixed(0)}%`;
  dom.evalDeltaStrip.classList.remove("hidden");
  const impact = review.practicalImpact;
  const showImpact = impact && impact.loss >= 0.5;
  dom.practicalImpactText.classList.toggle("hidden", !showImpact);
  if (showImpact) {
    const basis = impact.model === "clock" ? "with the recorded clocks" : "using position evaluations";
    dom.practicalImpactText.textContent = `Practical impact ≈ ${impact.loss.toFixed(0)} pts lost`;
    dom.practicalImpactText.title = `Estimated change in expected game score ${basis}, on a 0–100 scale`;
  }

  renderDifficulty(ply, review);
  const searchEvidence = { single: "One comparison", stable: "Two depths agree", borderline: "Grade uncertain", forced: "Forced move" };
  dom.gradeConfidenceText.textContent = `Depth ${review.depth} · ${searchEvidence[review.searchConfidence]}`;
  dom.gradeConfidenceText.classList.remove("hidden");

  if (review.pvSan) {
    dom.pvLinesBox.classList.remove("hidden");
    dom.pvLineWrap.classList.remove("hidden");
    dom.pvEval1.textContent = review.pvEvalStr || "";
    dom.pvLineText.textContent = review.pvSan;
    dom.showBestLineBtn.classList.remove("hidden");

    if (review.secondPvSan) {
      dom.pvLine2Wrap.classList.remove("hidden");
      dom.pvEval2.textContent = review.secondEvalStr || "";
      dom.pvLine2Text.textContent = review.secondPvSan;
    } else {
      dom.pvLine2Wrap.classList.add("hidden");
    }
  } else {
    dom.pvLinesBox.classList.add("hidden");
    dom.showBestLineBtn.classList.add("hidden");
  }

  const isPlayerError =
    posAfter.move.color === state.gameMeta?.playedColor &&
    (cls.key === "mistake" || cls.key === "miss" || cls.key === "blunder");
  dom.retryThisMoveBtn.classList.toggle("hidden", !isPlayerError);

  dom.explainMistakeBtn.classList.remove("hidden");
  dom.explainMistakeBtn.textContent = isPlayerError ? "AI Deep Explain" : "AI Explain";
  dom.coachActionsRow.classList.remove("hidden");

  if (state.coachCache.has(ply)) {
    dom.aiCoachText.textContent = state.coachCache.get(ply);
    dom.aiCoachOutput.classList.remove("hidden");
  }
}

function renderDifficulty(ply, review) {
  const forecast = state.humanForecasts.get(ply);
  const difficulty = forecast ?? review.difficulty;
  dom.moveDifficultyText.classList.toggle("hidden", !difficulty);
  dom.temptingMoveText.classList.add("hidden");
  if (forecast) {
    const level = forecast.variant === "rated" ? "at this Lichess rating" : "in similar positions";
    dom.moveDifficultyText.textContent = `Players find a sound move ≈ ${Math.round(forecast.soundChance / 5) * 5}%`;
    dom.moveDifficultyText.title = `Move-level estimate ${level}: the chance of choosing a move that loses at most ` +
      `five expected-score points, from Stockfish's score for every legal move`;
    const tempting = forecast.tempting;
    if (tempting && tempting.probability >= 0.08) {
      // For the game move, quote the review's deeper loss so the card shows one figure for it.
      const played = tempting.uci === state.positions[ply].move.uci;
      const loss = played ? review.winLoss : tempting.loss;
      dom.temptingMoveText.textContent = `Most tempting mistake: ${tempting.san}${played ? ", the game move" : ""} ` +
        `(≈${Math.round(tempting.probability * 100)}% of players, −${loss.toFixed(0)} pts)`;
      dom.temptingMoveText.title = "The unsound move the human-choice model rates most likely, with its expected-score loss";
      dom.temptingMoveText.classList.remove("hidden");
    }
  } else if (difficulty) {
    const rounded = Math.round(difficulty.chance / 5) * 5;
    dom.moveDifficultyText.textContent = `Estimated sound-move find rate ≈ ${rounded}%`;
    const basis = difficulty.model === "lichessRating" ? "at these Lichess ratings and clocks" : "in similar positions";
    dom.moveDifficultyText.title = `Estimated share of human moves ${basis} that lose at most five position-score points`;
  }
  if (!forecast) requestHumanForecast(ply);
}

/** Search every legal move once the review is idle, then forecast which moves a human would choose. */
async function requestHumanForecast(ply) {
  if (!HUMAN_MOVE_MODEL || !engine?.ready || state.isAnalyzing || ply < 1 || state.humanForecasts.has(ply)) return;
  if (state.humanForecastBusy) {
    state.humanForecastNext = ply;
    return;
  }
  const before = state.positions[ply - 1];
  const after = state.positions[ply];
  if (!before || !after?.move || before.terminal || before.legalMoves < 2) return;
  state.humanForecastBusy = true;
  const runId = state.analysisRunId;
  try {
    // Start from a cleared search table, as in training and validation. Entries left by the review's
    // deep search of the played move would otherwise single that move out.
    await engine.startNewGame();
    const search = await engine.analyzePosition(before.fen, HUMAN_MOVE_SEARCH_DEPTH, {
      ...before.searchOptions, multiPv: before.legalMoves,
    });
    if (runId !== state.analysisRunId || search.lines.length !== before.legalMoves) return;
    const { color } = after.move;
    const clocks = before.practicalContext;
    const context = humanContext({
      rating: before.lichessRatings?.[color] ?? null,
      clockSeconds: clocks ? (color === "w" ? clocks.whiteSeconds : clocks.blackSeconds) : null,
    });
    const rows = moveFeatureRows(replayVariation(before), candidateScores(search, color), context, before.move?.to ?? null);
    const forecast = forecastHumanMoves(rows, context);
    if (!forecast) return;
    state.humanForecasts.set(ply, forecast);
    if (state.currentPly === ply && !state.exploring && state.moveReviews[ply]) renderDifficulty(ply, state.moveReviews[ply]);
  } catch {
    // The review keeps the cohort estimate.
  } finally {
    state.humanForecastBusy = false;
    const next = state.humanForecastNext;
    state.humanForecastNext = null;
    if (next !== null && next === state.currentPly) requestHumanForecast(next);
  }
}

dom.retryThisMoveBtn.addEventListener("click", () => {
  const ply = state.currentPly;
  const plies = getPlayerMistakePlies();
  const idx = plies.indexOf(ply);
  if (idx >= 0) {
    state.drillPlies = plies;
    state.drillIndex = idx;
    switchTab("drills");
    loadCurrentDrillStep();
  }
});

function renderKeyMoments() {
  const myColor = state.gameMeta?.playedColor || "w";
  const moments = [];
  for (let i = 1; i < state.positions.length; i++) {
    const pos = state.positions[i];
    const rev = state.moveReviews[i];
    if (!pos?.move || !rev) continue;
    const k = rev.classification.key;
    if ((k === "blunder" || k === "mistake" || k === "miss") && pos.move.color === myColor) {
      moments.push({ ply: i, san: pos.move.san, color: pos.move.color, cls: rev.classification, priority: trainingPriority(rev) });
    } else if (k === "brilliant" || k === "great") {
      moments.push({ ply: i, san: pos.move.san, color: pos.move.color, cls: rev.classification });
    }
  }

  if (moments.length === 0) {
    dom.keyMomentsWrap.classList.add("hidden");
    return;
  }

  dom.keyMomentsWrap.classList.remove("hidden");
  const frag = document.createDocumentFragment();
  const visibleMoments = moments.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, 12).sort((a, b) => a.ply - b.ply);
  visibleMoments.forEach((m) => {
    const moveNum = state.positions[m.ply].move.number;
    const prefix = m.color === "w" ? `${moveNum}.` : `${moveNum}...`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `moment-pill ${m.cls.key}`;
    btn.textContent = `${prefix}${m.san}${m.cls.symbol}`;
    btn.title = `Jump to ${m.cls.label}`;
    btn.addEventListener("click", () => {
      if (state.drillActive) exitDrillMode();
      goToPly(m.ply, true, true);
    });
    frag.appendChild(btn);
  });
  dom.keyMomentsList.replaceChildren(frag);
}

function updatePhaseBar(valEl, barEl, score) {
  if (score === null || score === undefined) {
    valEl.textContent = "—";
    barEl.style.width = "0%";
    return;
  }
  valEl.textContent = `${score.toFixed(0)}%`;
  barEl.style.width = `${Math.max(4, Math.min(100, score))}%`;
}

function setPerformanceLine(element, text) {
  element.textContent = text;
  element.classList.toggle("hidden", !text);
  dom.performanceContext.classList.toggle("hidden", !Array.from(dom.performanceContext.children)
    .some((line) => !line.classList.contains("hidden")));
}

function clearPerformanceContext() {
  for (const element of [dom.peerWhiteContext, dom.peerBlackContext, dom.personalContext]) {
    setPerformanceLine(element, "");
  }
}

function renderPeerPerformance(depth) {
  const { positions, moveReviews, gameHeaders: headers } = state;
  for (const [color, side, element] of [["w", "White", dom.peerWhiteContext], ["b", "Black", dom.peerBlackContext]]) {
    const comparison = peerPerformance({ positions, moveReviews, color, headers, depth });
    if (!comparison) {
      setPerformanceLine(element, "");
      continue;
    }
    const { observedSound, expectedSound, decisions, rating, timeClass, pool } = comparison;
    const platform = pool === "chesscom" ? "Chess.com" : "Lichess";
    setPerformanceLine(element, `${side} found ${observedSound} of ${decisions} sound moves. ` +
      `The model expects ${expectedSound.toFixed(1)} for a ${rating}-rated ${platform} ${timeClass} player.`);
  }
}

function renderPersonalPerformance(comparison) {
  if (!comparison) return setPerformanceLine(dom.personalContext, "");
  const { currentAccuracy, medianAccuracy, difference, games, decisions, timeClass } = comparison;
  const movement = difference === 0 ? "matches" : `${Math.abs(difference).toFixed(1)} points ${difference > 0 ? "above" : "below"}`;
  setPerformanceLine(dom.personalContext, `Your ${currentAccuracy.toFixed(1)}% accuracy ${movement} your median ` +
    `of ${medianAccuracy.toFixed(1)}% in ${games} earlier ${timeClass} games (${decisions} decisions).`);
}

function updateScoreboard() {
  const winTimeline = state.evals.map((e) => e ? evalToWinWhite(e.eval) : null);
  const whiteMoves = [];
  const blackMoves = [];
  const whiteCpLosses = [];
  const blackCpLosses = [];
  const reviewsByColor = { w: [], b: [] };

  const counts = {
    w: Object.fromEntries(CLASSIFICATION_ORDER.map((k) => [k, 0])),
    b: Object.fromEntries(CLASSIFICATION_ORDER.map((k) => [k, 0])),
  };

  for (let i = 1; i < state.positions.length; i++) {
    const rev = state.moveReviews[i];
    const move = state.positions[i]?.move;
    if (!rev || !move) continue;
    reviewsByColor[move.color].push(rev);
    counts[move.color][displayClassification(rev).key]++;
    if (rev.forced) continue;
    if (move.color === "w") {
      whiteMoves.push({ ply: i, accuracy: rev.accuracy });
      whiteCpLosses.push(rev.cpLoss);
    } else {
      blackMoves.push({ ply: i, accuracy: rev.accuracy });
      blackCpLosses.push(rev.cpLoss);
    }
  }

  const whiteAcc = computeProGameAccuracy(winTimeline, whiteMoves);
  const blackAcc = computeProGameAccuracy(winTimeline, blackMoves);
  const whiteAcpl = computeACPL(whiteCpLosses);
  const blackAcpl = computeACPL(blackCpLosses);

  updateAccuracyRing(dom.accWhiteVal, dom.accWhiteRing, whiteAcc);
  updateAccuracyRing(dom.accBlackVal, dom.accBlackRing, blackAcc);
  dom.acplWhiteVal.textContent = whiteAcpl !== null ? `${whiteAcpl} ACPL` : "-- ACPL";
  dom.acplBlackVal.textContent = blackAcpl !== null ? `${blackAcpl} ACPL` : "-- ACPL";

  for (const [color, qualityEl, peakEl, countEl, count] of [
    ["w", dom.qualityWhiteVal, dom.worstWhiteVal, dom.scoredWhiteMoves, whiteMoves.length],
    ["b", dom.qualityBlackVal, dom.worstBlackVal, dom.scoredBlackMoves, blackMoves.length],
  ]) {
    const reviews = reviewsByColor[color];
    const uncertain = reviews.filter(({ searchConfidence }) => searchConfidence === "borderline").length;
    const scores = `${count} scored ${count === 1 ? "decision" : "decisions"}`;
    countEl.textContent = `${scores}${uncertain ? ` · ${uncertain} uncertain ${uncertain === 1 ? "grade" : "grades"}` : ""}`;
    const quality = computeDecisionQuality(reviews);
    qualityEl.textContent = quality ? `Decision quality ${quality.score.toFixed(1)}` : "";
    peakEl.textContent = quality ? `Biggest loss ${quality.biggestLoss.toFixed(0)} pts` : "";
  }
  renderBreakdownTable(counts);

  if (state.gameMeta) {
    const myColor = state.gameMeta.playedColor || "w";
    const insights = computeGameInsights({
      positions: state.positions,
      winTimeline,
      moveReviews: state.moveReviews,
      playedColor: myColor,
    });

    const hasPhaseScores = [insights.opening, insights.middlegame, insights.endgame].some((score) => score !== null);
    dom.phaseStrip.classList.toggle("hidden", !hasPhaseScores);
    if (hasPhaseScores) {
      updatePhaseBar(dom.phaseOpeningVal, dom.phaseOpeningBar, insights.opening);
      updatePhaseBar(dom.phaseMiddleVal, dom.phaseMiddleBar, insights.middlegame);
      updatePhaseBar(dom.phaseEndVal, dom.phaseEndBar, insights.endgame);
    }
  }
}

function renderBreakdownTable(counts) {
  const frag = document.createDocumentFragment();
  for (const key of CLASSIFICATION_ORDER) {
    const cls = REVIEW_CLASSIFICATIONS[key];
    const tr = document.createElement("tr");

    const tdLabel = document.createElement("td");
    const cellSpan = document.createElement("span");
    cellSpan.className = "table-class-cell";

    const dot = document.createElement("span");
    dot.className = "mini-dot";
    dot.style.background = cls.color;
    dot.textContent = cls.symbol;

    const nameSpan = document.createElement("span");
    nameSpan.textContent = cls.label;
    if (key === "book") nameSpan.title = "Sound opening move in the bundled Lichess catalog";

    cellSpan.appendChild(dot);
    cellSpan.appendChild(nameSpan);
    tdLabel.appendChild(cellSpan);

    const tdWhite = document.createElement("td");
    tdWhite.className = "num";
    tdWhite.textContent = String(counts.w[key]);

    const tdBlack = document.createElement("td");
    tdBlack.className = "num";
    tdBlack.textContent = String(counts.b[key]);

    tr.appendChild(tdLabel);
    tr.appendChild(tdWhite);
    tr.appendChild(tdBlack);
    frag.appendChild(tr);
  }
  dom.breakdownBody.replaceChildren(frag);
}

function renderMoveList() {
  const frag = document.createDocumentFragment();
  const totalPlies = state.positions.length - 1;

  let ply = 1;
  while (ply <= totalPlies) {
    const move = state.positions[ply].move;
    const row = document.createElement("div");
    row.className = "move-row";
    const numEl = document.createElement("span");
    numEl.className = "move-num";
    numEl.textContent = `${move.number}.`;
    row.appendChild(numEl);
    for (const color of ["w", "b"]) {
      const next = state.positions[ply]?.move;
      row.appendChild(next?.color === color && next.number === move.number
        ? createMoveCell(ply++) : document.createElement("span"));
    }
    frag.appendChild(row);
  }

  dom.moveList.replaceChildren(frag);
  highlightActiveMoveInList(state.currentPly);
}

function createMoveCell(ply) {
  const pos = state.positions[ply];
  const rev = state.moveReviews[ply];
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "move-cell";
  btn.dataset.ply = String(ply);

  const sanSpan = document.createElement("span");
  sanSpan.textContent = pos.move.san;
  btn.appendChild(sanSpan);

  if (rev) {
    const cls = displayClassification(rev);
    const badge = document.createElement("span");
    badge.className = "move-cell-badge";
    badge.style.background = cls.color;
    badge.textContent = cls.symbol;
    badge.title = cls.label;
    badge.setAttribute("aria-hidden", "true");
    btn.setAttribute("aria-label", `${pos.move.san}, ${cls.label}`);
    btn.appendChild(badge);
  }

  btn.addEventListener("click", () => {
    stopAutoplay();
    goToPly(ply, true, true);
  });

  return btn;
}

function highlightActiveMoveInList(ply) {
  const cells = dom.moveList.querySelectorAll(".move-cell");
  cells.forEach((cell) => {
    const isActive = Number(cell.dataset.ply) === ply;
    cell.classList.toggle("active", isActive);
    if (isActive && state.activeTab === "moves") {
      cell.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });
}

function renderEvalGraph() {
  const svg = dom.evalGraphSvg;
  const W = 420;
  const H = 112;
  const midY = H / 2;
  const n = state.positions.length;

  const frag = document.createDocumentFragment();

  if (n <= 1) {
    frag.appendChild(
      createSvgEl("line", {
        x1: 0,
        y1: midY,
        x2: W,
        y2: midY,
        stroke: "#3a3732",
        "stroke-dasharray": "4 3",
      })
    );
    svg.replaceChildren(frag);
    return;
  }

  const defs = createSvgEl("defs");
  const whiteGrad = createSvgEl("linearGradient", { id: "clgrWhiteGrad", x1: "0", y1: "0", x2: "0", y2: "1" });
  whiteGrad.appendChild(createSvgEl("stop", { offset: "0%", "stop-color": "#f2f0ea", "stop-opacity": "0.94" }));
  whiteGrad.appendChild(createSvgEl("stop", { offset: "100%", "stop-color": "#c9c6be", "stop-opacity": "0.78" }));
  defs.appendChild(whiteGrad);
  frag.appendChild(defs);

  const xFor = (i) => (i / (n - 1)) * W;
  const yFor = (winWhite) => H - (Math.max(0, Math.min(100, winWhite)) / 100) * H;

  const pts = [];
  for (let i = 0; i < n; i++) {
    const win = state.evals[i] ? state.evals[i].winWhite : 50;
    pts.push({ i, x: xFor(i), y: yFor(win), win });
  }

  const linePath = pts
    .map((p, idx) => `${idx === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
  const whiteArea = `${linePath} L${W},${H} L0,${H} Z`;
  const blackArea = `M0,0 L${W},0 L${W},${H} L0,${H} Z`;

  frag.appendChild(createSvgEl("path", { d: blackArea, fill: "#1b1a17" }));
  frag.appendChild(createSvgEl("path", { d: whiteArea, fill: "url(#clgrWhiteGrad)" }));
  frag.appendChild(
    createSvgEl("line", {
      x1: 0,
      y1: midY,
      x2: W,
      y2: midY,
      stroke: "rgba(255,255,255,0.22)",
      "stroke-width": 1,
      "stroke-dasharray": "3 3",
    })
  );
  frag.appendChild(
    createSvgEl("path", {
      d: linePath,
      fill: "none",
      stroke: "#81b64c",
      "stroke-width": 1.6,
    })
  );

  const curPt = pts[state.currentPly] || pts[0];
  frag.appendChild(
    createSvgEl("line", {
      x1: curPt.x.toFixed(1),
      y1: 0,
      x2: curPt.x.toFixed(1),
      y2: H,
      stroke: "#26c6da",
      "stroke-width": 1.5,
      "stroke-opacity": "0.85",
    })
  );

  for (let i = 1; i < n; i++) {
    const rev = state.moveReviews[i];
    if (!rev) continue;
    const k = rev.classification.key;
    if (k === "blunder" || k === "miss" || k === "mistake" || k === "brilliant" || k === "great") {
      const color = rev.classification.color;
      const r = k === "blunder" ? 3.8 : 3.0;
      frag.appendChild(
        createSvgEl("circle", {
          cx: pts[i].x.toFixed(1),
          cy: pts[i].y.toFixed(1),
          r,
          fill: color,
          stroke: "#11100e",
          "stroke-width": 1.2,
        })
      );
    }
  }

  frag.appendChild(
    createSvgEl("circle", {
      cx: curPt.x.toFixed(1),
      cy: curPt.y.toFixed(1),
      r: 3.6,
      fill: "#26c6da",
      stroke: "#11100e",
      "stroke-width": 1.4,
    })
  );

  svg.replaceChildren(frag);
}

function getPlyFromGraphEvent(ev) {
  const rect = dom.evalGraphSvg.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
  return {
    ply: Math.round(ratio * (state.positions.length - 1)),
    ratio,
    rect,
  };
}

dom.evalGraphSvg.addEventListener("click", (ev) => {
  if (state.positions.length <= 1) return;
  stopAutoplay();
  const { ply } = getPlyFromGraphEvent(ev);
  goToPly(ply, true, true);
});

dom.evalGraphSvg.addEventListener("mousemove", (ev) => {
  if (state.positions.length <= 1) return;
  const { ply, ratio, rect } = getPlyFromGraphEvent(ev);
  const pos = state.positions[ply];
  const evData = state.evals[ply];
  const rev = state.moveReviews[ply];

  let text = "Start";
  if (ply > 0 && pos?.move) {
    const moveNum = pos.move.number;
    const prefix = pos.move.color === "w" ? `${moveNum}.` : `${moveNum}...`;
    const evalStr = evData ? formatEval(evData.eval) : "…";
    const sym = rev ? ` ${displayClassification(rev).symbol}` : "";
    text = `${prefix}${pos.move.san}${sym} (${evalStr})`;
  }

  dom.evalTooltip.textContent = text;
  dom.evalTooltip.classList.remove("hidden");
  const leftPx = Math.max(6, Math.min(rect.width - 135, ratio * rect.width - 45));
  dom.evalTooltip.style.left = `${leftPx}px`;
});

dom.evalGraphSvg.addEventListener("mouseleave", () => {
  dom.evalTooltip.classList.add("hidden");
});

/**
 * "Retry Your Mistakes" Tabbed Trainer (Mistakes, Misses, and Blunders)
 */
function getPlayerMistakePlies() {
  const myColor = state.gameMeta?.playedColor || "w";
  const list = [];
  for (let i = 1; i < state.positions.length; i++) {
    const pos = state.positions[i];
    const rev = state.moveReviews[i];
    if (!pos?.move || !rev) continue;
    if (pos.move.color !== myColor) continue;
    const k = rev.classification.key;
    if (k === "mistake" || k === "miss" || k === "blunder") {
      list.push(i);
    }
  }
  return list.sort((a, b) => trainingPriority(state.moveReviews[b]) - trainingPriority(state.moveReviews[a]));
}

function updateDrillBadgeCount() {
  const count = getPlayerMistakePlies().length;
  if (count > 0) {
    dom.drillCountBadge.textContent = String(count);
    dom.drillCountBadge.classList.remove("hidden");
  } else {
    dom.drillCountBadge.classList.add("hidden");
  }
}

function renderDrillDots() {
  const frag = document.createDocumentFragment();
  state.drillPlies.forEach((ply, idx) => {
    const dot = document.createElement("span");
    dot.className = "drill-dot";
    if (state.drillSolvedSet.has(ply)) dot.classList.add("solved");
    if (idx === state.drillIndex) dot.classList.add("current");
    frag.appendChild(dot);
  });
  dom.drillDots.replaceChildren(frag);
}

function startDrillModeIfAvailable() {
  stopAutoplay();
  const plies = getPlayerMistakePlies();
  if (plies.length === 0) {
    state.drillActive = false;
    dom.drillCounter.textContent = "Clean game!";
    dom.drillDots.replaceChildren();
    dom.drillPromptText.className = "drill-prompt success";
    dom.drillPromptText.textContent = state.isAnalyzing
      ? "Still analyzing your game—mistakes will appear here once Stockfish finishes."
      : "Zero Mistakes, Misses, or Blunders detected for your side in this game!";
    dom.drillControls.classList.add("hidden");
    dom.drillDoneCard.classList.add("hidden");
    return;
  }

  state.drillActive = true;
  if (state.drillPlies.length !== plies.length || plies.some((ply, index) => state.drillPlies[index] !== ply)) {
    state.drillPlies = plies;
    state.drillIndex = 0;
  }
  dom.drillControls.classList.remove("hidden");
  dom.drillDoneCard.classList.add("hidden");
  loadCurrentDrillStep();
}

function resetDrillProgress() {
  state.drillActive = false;
  state.drillPlies = [];
  state.drillIndex = 0;
  state.drillSolvedSet.clear();
  state.drillSolved = false;
  state.drillChecking = false;
}

function exitDrillMode() {
  state.drillActive = false;
  state.drillSolved = false;
  state.drillChecking = false;
  enableBoardInput();
  goToPly(state.currentPly, true);
}

function loadCurrentDrillStep() {
  const mistakePly = state.drillPlies[state.drillIndex];
  const beforePly = mistakePly - 1;
  const moveNum = state.positions[mistakePly].move.number;
  const rev = state.moveReviews[mistakePly];
  const playedSan = state.positions[mistakePly].move.san;

  state.drillSolved = false;
  state.drillChecking = false;

  const label = rev.missedMate?.drill ? "Missed mate" : "Mistake";
  dom.drillCounter.textContent = `${label} ${state.drillIndex + 1} of ${state.drillPlies.length} • Move ${moveNum}`;
  dom.drillPromptText.className = "drill-prompt";
  dom.drillPromptText.textContent = drillPrompt({ playedSan, review: rev });
  dom.drillNextBtn.classList.add("hidden");
  dom.drillDoneCard.classList.add("hidden");
  renderDrillDots();

  goToPly(beforePly, true);
  enableBoardInput();
}

async function evaluateDrillAttempt(moveObj, attemptedUci, deliversMate, stillCurrent) {
  const mistakePly = state.drillPlies[state.drillIndex];
  const beforePos = state.positions[mistakePly - 1];
  const originalMove = state.positions[mistakePly].move;
  const review = state.moveReviews[mistakePly];
  const attempt = {
    attemptUci: attemptedUci, gameUci: originalMove.uci, review, color: originalMove.color, deliversMate,
  };
  let judgement = judgeDrillAttempt(attempt);

  if (judgement.verdict === "unknown" && engine && engine.ready && !state.isAnalyzing) {
    dom.drillPromptText.className = "drill-prompt";
    dom.drillPromptText.textContent = `Checking ${moveObj.san} with Stockfish...`;
    try {
      const comparison = await compareRootMoves(engine, beforePos, attemptedUci, review.depth, state.evals[mistakePly - 1]);
      judgement = judgeDrillAttempt({ ...attempt, comparison });
    } catch {
      // Keep the unverified judgement.
    }
  }
  if (!stillCurrent()) return;

  if (judgement.verdict === "best" || judgement.verdict === "alternative") {
    playSound("success");
    const message = drillSuccess({ attemptSan: moveObj.san, judgement, review, deliversMate });
    markDrillSolved(message, review.bestMoveUci, mistakePly);
    return;
  }

  playSound("error");
  rejectDrillAttempt(drillRejection({ attemptSan: moveObj.san, judgement, review }), beforePos.fen, stillCurrent);
}

function markDrillSolved(message, bestUci, mistakePly) {
  state.drillChecking = false;
  state.drillSolved = true;
  state.drillSolvedSet.add(mistakePly);
  renderDrillDots();

  dom.drillPromptText.className = "drill-prompt success";
  dom.drillPromptText.textContent = message;

  const best = parseUci(bestUci);
  if (best) {
    board.addArrow(ARROW_BEST, best.from, best.to);
  }

  if (state.drillIndex < state.drillPlies.length - 1) {
    dom.drillNextBtn.textContent = "Next Mistake →";
    dom.drillNextBtn.classList.remove("hidden");
  } else {
    dom.drillNextBtn.classList.add("hidden");
    dom.drillDoneSummary.textContent = `You worked through all ${state.drillPlies.length} critical mistake${state.drillPlies.length > 1 ? "s" : ""} from this game.`;
    dom.drillDoneCard.classList.remove("hidden");
  }
}

function rejectDrillAttempt(message, resetFen, stillCurrent) {
  dom.drillPromptText.className = "drill-prompt error";
  dom.drillPromptText.textContent = message;
  setTimeout(() => {
    if (stillCurrent()) {
      board.setPosition(resetFen, true);
      state.drillChecking = false;
    }
  }, 420);
}

dom.drillHintBtn.addEventListener("click", () => {
  if (!state.drillActive || state.drillSolved) return;
  const mistakePly = state.drillPlies[state.drillIndex];
  const best = parseUci(state.moveReviews[mistakePly]?.bestMoveUci);
  if (best) {
    board.removeMarkers(MARKER_TYPE.circle);
    board.addMarker(MARKER_TYPE.circle, best.from);
    dom.drillPromptText.className = "drill-prompt";
    dom.drillPromptText.textContent = drillHint({ review: state.moveReviews[mistakePly], fromSquare: best.from });
  }
});

dom.drillRevealBtn.addEventListener("click", () => {
  if (!state.drillActive) return;
  const mistakePly = state.drillPlies[state.drillIndex];
  const beforePos = state.positions[mistakePly - 1];
  const review = state.moveReviews[mistakePly];
  const bestFen = applyUciToFen(beforePos.fen, review.bestMoveUci);
  if (bestFen) {
    board.setPosition(bestFen, true);
  }
  markDrillSolved(`Best move was ${review.bestSan}.`, review.bestMoveUci, mistakePly);
});

dom.drillNextBtn.addEventListener("click", () => {
  if (state.drillIndex < state.drillPlies.length - 1) {
    state.drillIndex++;
    loadCurrentDrillStep();
  }
});

dom.drillRestartBtn.addEventListener("click", () => {
  state.drillSolvedSet.clear();
  state.drillIndex = 0;
  dom.drillDoneCard.classList.add("hidden");
  loadCurrentDrillStep();
});

async function explainCurrentMoveWithAi() {
  const { currentPly: ply, aiSettings: settings, analysisRunId } = state;
  const review = state.moveReviews[ply];
  if (!review) return;
  if (state.coachCache.has(ply)) return;

  if (!settings.endpoint || !settings.model || (!settings.apiKey && settings.preset !== "custom")) {
    openSettingsDrawer();
    dom.settingsSavedMsg.textContent = "Set up an AI provider to request an explanation.";
    return;
  }

  const pos = state.positions[ply];
  const evidence = {
    fen: state.positions[ply - 1].fen,
    mover: pos.move.color === "w" ? "White" : "Black",
    played: pos.move.san,
    grade: review.classification.label,
    bestLine: review.pvSan,
    playedLine: review.playedPvSan,
    secondLine: review.secondPvSan,
    bestWhiteEval: review.pvEvalStr,
    playedWhiteEval: formatEval(review.playedEval),
    expectedScoreLoss: Number(review.winLoss.toFixed(1)),
    searchDepth: review.depth,
  };
  const stillCurrent = () => state.analysisRunId === analysisRunId && state.currentPly === ply && state.aiSettings === settings;

  dom.explainMistakeBtn.disabled = true;
  dom.explainMistakeBtn.textContent = "Thinking…";
  dom.aiCoachOutput.classList.remove("hidden");
  dom.aiCoachText.textContent = "Asking AI Coach…";
  try {
    const url = coachEndpoint(settings.endpoint);
    const request = { origins: [`${url.protocol}//${url.hostname}/*`] };
    if (extension.runtime.getManifest().browser_specific_settings?.gecko) request.data_collection = ["websiteContent"];
    const allowed = await extension.permissions.request(request);
    if (!allowed) throw new Error("Permission was declined for this provider.");
    if (!stillCurrent()) return;

    const headers = { "Content-Type": "application/json" };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify(coachRequestBody(settings, evidence)),
    });
    if (!res.ok) throw new Error(`Provider returned HTTP ${res.status}. Check the selected model and API key.`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content || data.choices[0].finish_reason === "length") {
      throw new Error("The provider returned an incomplete explanation.");
    }
    if (state.analysisRunId === analysisRunId && state.aiSettings === settings) state.coachCache.set(ply, content);
    if (stillCurrent()) dom.aiCoachText.textContent = content;
  } catch (err) {
    if (stillCurrent()) dom.aiCoachText.textContent = `AI Coach unavailable. ${err.message} See the local review above.`;
  } finally {
    dom.explainMistakeBtn.disabled = false;
    if (stillCurrent()) dom.explainMistakeBtn.textContent = "AI Explain";
  }
}

dom.explainMistakeBtn.addEventListener("click", explainCurrentMoveWithAi);

function openSettingsDrawer() {
  dom.settingsBackdrop.classList.remove("hidden");
  dom.settingsDrawer.classList.remove("hidden");
  dom.settingsSavedMsg.textContent = "";
}

function closeSettingsDrawer() {
  dom.settingsBackdrop.classList.add("hidden");
  dom.settingsDrawer.classList.add("hidden");
}

dom.settingsBtn.addEventListener("click", openSettingsDrawer);
dom.closeSettingsBtn.addEventListener("click", closeSettingsDrawer);
dom.settingsBackdrop.addEventListener("click", closeSettingsDrawer);

function clearKeyOnEndpointChange() {
  if (!dom.aiApiKeyInput.value || dom.aiApiKeyInput.value !== state.aiSettings.apiKey) return;
  try {
    if (coachEndpoint(dom.aiEndpointInput.value).origin === coachEndpoint(state.aiSettings.endpoint).origin) return;
  } catch {
    // Invalid or blank endpoints cannot use a stored key.
  }
  dom.aiApiKeyInput.value = "";
}

dom.aiPresetSelect.addEventListener("change", () => {
  const preset = AI_PRESETS[dom.aiPresetSelect.value];
  if (preset && dom.aiPresetSelect.value !== "custom") {
    dom.aiEndpointInput.value = preset.endpoint;
    dom.aiModelInput.value = preset.model;
    clearKeyOnEndpointChange();
  }
});
dom.aiEndpointInput.addEventListener("change", clearKeyOnEndpointChange);

dom.saveSettingsBtn.addEventListener("click", async () => {
  state.coachCache.clear();
  state.humanForecasts.clear();
  dom.aiCoachOutput.classList.add("hidden");
  state.aiSettings = {
    preset: dom.aiPresetSelect.value,
    endpoint: dom.aiEndpointInput.value.trim(),
    model: dom.aiModelInput.value.trim(),
    apiKey: dom.aiApiKeyInput.value.trim(),
  };
  const fallbackUsername = dom.fallbackUsernameInput.value.trim();

  try {
    await extension.storage.local.set({
      aiSettings: state.aiSettings,
      fallbackUsername,
      boardTheme: state.boardTheme,
    });
    dom.settingsSavedMsg.textContent = "Saved locally.";
  } catch {
    dom.settingsSavedMsg.textContent = "Saved for this session.";
  }
});

async function loadSavedSettings() {
  try {
    const stored = await extension.storage.local.get([
      "aiSettings",
      "fallbackUsername",
      "soundEnabled",
      "boardTheme",
    ]);
    if (stored.aiSettings) {
      state.aiSettings = migrateCoachSettings({ ...state.aiSettings, ...stored.aiSettings });
    }
    if (typeof stored.soundEnabled === "boolean") {
      state.soundEnabled = stored.soundEnabled;
    }
    if (stored.boardTheme) {
      applyBoardTheme(stored.boardTheme);
    }
    updateSoundIcon();
    dom.aiPresetSelect.value = state.aiSettings.preset || "openai";
    dom.aiEndpointInput.value = state.aiSettings.endpoint;
    dom.aiModelInput.value = state.aiSettings.model;
    dom.aiApiKeyInput.value = state.aiSettings.apiKey || "";
    dom.fallbackUsernameInput.value = stored.fallbackUsername || "";
  } catch {
    updateSoundIcon();
  }
}

dom.soundToggleBtn.addEventListener("click", async () => {
  state.soundEnabled = !state.soundEnabled;
  updateSoundIcon();
  try {
    await extension.storage.local.set({ soundEnabled: state.soundEnabled });
  } catch {
    // Ignore
  }
});

async function openPgnModal() {
  dom.pgnErrorBanner.classList.add("hidden");
  dom.pgnErrorBanner.textContent = "";
  dom.pgnModalBackdrop.classList.remove("hidden");
  try {
    const stored = await extension.storage.local.get("recentGames");
    const recent = Array.isArray(stored.recentGames) ? stored.recentGames : [];
    if (recent.length > 0) {
      dom.recentGamesWrap.classList.remove("hidden");
      const frag = document.createDocumentFragment();
      recent.slice(0, 6).forEach((g) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "recent-item";

        const playersSpan = document.createElement("span");
        playersSpan.textContent = `${g.white?.username || "White"} vs ${g.black?.username || "Black"}`;
        const tcSpan = document.createElement("span");
        tcSpan.textContent = g.timeClass || "";

        item.appendChild(playersSpan);
        item.appendChild(tcSpan);
        item.addEventListener("click", () => {
          const res = loadGameFromPayload(g);
          if (res.ok) {
            closePgnModal();
            runFullAnalysis();
          }
        });
        frag.appendChild(item);
      });
      dom.recentGamesList.replaceChildren(frag);
    } else {
      dom.recentGamesWrap.classList.add("hidden");
    }
  } catch {
    dom.recentGamesWrap.classList.add("hidden");
  }
}

function closePgnModal() {
  dom.pgnModalBackdrop.classList.add("hidden");
}

dom.pastePgnBtn.addEventListener("click", openPgnModal);
dom.closePgnModalBtn.addEventListener("click", closePgnModal);
dom.cancelPgnBtn.addEventListener("click", closePgnModal);
dom.loadPgnConfirmBtn.addEventListener("click", () => {
  const pgn = dom.pgnTextarea.value.trim();
  if (!pgn) {
    dom.pgnErrorBanner.textContent = "Please paste a valid PGN first.";
    dom.pgnErrorBanner.classList.remove("hidden");
    return;
  }
  const payload = {
    gameId: `manual-${Date.now()}`,
    pgn,
    playedColor: dom.pgnColorSelect.value,
    colorConfirmed: dom.pgnPracticeCheck.checked,
    timeClass: "Custom PGN",
  };
  const res = loadGameFromPayload(payload);
  if (!res.ok) {
    dom.pgnErrorBanner.textContent = res.error;
    dom.pgnErrorBanner.classList.remove("hidden");
    return;
  }
  closePgnModal();
  runFullAnalysis();
});

function stopAutoplay() {
  if (state.autoplayTimer) {
    clearInterval(state.autoplayTimer);
    state.autoplayTimer = null;
    updatePlayIcon(false);
  }
}

function toggleAutoplay() {
  if (state.autoplayTimer) {
    stopAutoplay();
    return;
  }
  if (state.drillActive) switchTab("review");
  if (state.currentPly >= state.positions.length - 1) {
    goToPly(0, false);
  }
  updatePlayIcon(true);
  state.autoplayTimer = setInterval(() => {
    if (state.currentPly >= state.positions.length - 1) {
      stopAutoplay();
      return;
    }
    goToPly(state.currentPly + 1, true, true);
  }, 850);
}

dom.navPlayBtn.addEventListener("click", toggleAutoplay);
dom.navFirstBtn.addEventListener("click", () => {
  stopAutoplay();
  if (state.drillActive) switchTab("review");
  goToPly(0, true);
});
dom.navPrevBtn.addEventListener("click", () => {
  stopAutoplay();
  if (state.exploring) exitVariation();
  else {
    if (state.drillActive) switchTab("review");
    goToPly(state.currentPly - 1, true, true);
  }
});
dom.navNextBtn.addEventListener("click", () => {
  stopAutoplay();
  if (state.drillActive) switchTab("review");
  goToPly(state.currentPly + 1, true, true);
});
dom.navLastBtn.addEventListener("click", () => {
  stopAutoplay();
  if (state.drillActive) switchTab("review");
  goToPly(state.positions.length - 1, true, true);
});

dom.flipBoardBtn.addEventListener("click", () => {
  if (!board) return;
  state.orientation = state.orientation === "w" ? "b" : "w";
  board.setOrientation(state.orientation === "b" ? COLOR.black : COLOR.white, true);
  renderPlayerStrips();
  updateEvalBar(state.currentPly);
  updateSquareBadgeOverlay(state.currentPly);
  const pos = state.positions[state.currentPly];
  if (pos) updateCapturedPieces(pos.fen);
});

dom.snapBackBtn.addEventListener("click", exitVariation);

dom.reanalyzeBtn.addEventListener("click", () => {
  if (state.positions.length) {
    runFullAnalysis();
  }
});

document.addEventListener("keydown", (ev) => {
  const tag = (ev.target && ev.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  if (ev.key === "Escape") {
    stopAutoplay();
    if (!dom.settingsDrawer.classList.contains("hidden")) {
      closeSettingsDrawer();
    } else if (!dom.pgnModalBackdrop.classList.contains("hidden")) {
      closePgnModal();
    } else if (state.exploring) {
      exitVariation();
    }
    return;
  }

  if (state.drillActive) return;

  if (ev.key === "ArrowLeft") {
    ev.preventDefault();
    stopAutoplay();
    if (state.exploring) exitVariation();
    else goToPly(state.currentPly - 1, true, true);
  } else if (ev.key === "ArrowRight" || ev.key === "Enter") {
    ev.preventDefault();
    stopAutoplay();
    dom.guidedNextBtn.click();
  } else if (ev.key === "ArrowUp") {
    ev.preventDefault();
    stopAutoplay();
    goToPly(0, true);
  } else if (ev.key === "ArrowDown") {
    ev.preventDefault();
    stopAutoplay();
    goToPly(state.positions.length - 1, true, true);
  } else if (ev.key === " ") {
    ev.preventDefault();
    toggleAutoplay();
  } else if (ev.key === "f" || ev.key === "F") {
    dom.flipBoardBtn.click();
  } else if ((ev.key === "r" || ev.key === "R") && !dom.retryThisMoveBtn.classList.contains("hidden")) {
    dom.retryThisMoveBtn.click();
  }
});

async function bootstrap() {
  await loadSavedSettings();
  initBoard("w");
  updateScoreboard();
  refreshPracticeBadge();

  // The Practice page links here with ?game=<gameKey>&ply=<ply> to open a saved game at that move.
  const params = new URLSearchParams(location.search);
  const requestedGame = params.get("game");
  let missingGame = false;
  if (requestedGame) {
    try {
      const record = (await loadTraining(trainingArea)).games.get(requestedGame);
      if (!record) missingGame = true;
      if (record) {
        const res = loadGameFromPayload({
          gameId: record.gameId, pgn: record.pgn, playedColor: record.color, colorConfirmed: true,
          timeClass: record.timeClass, timeControl: record.timeControl, endTime: record.endTime,
        });
        if (res.ok) {
          const ply = Number(params.get("ply"));
          if (Number.isInteger(ply)) goToPly(ply, false);
          runFullAnalysis();
          return;
        }
      }
    } catch {
      // Fall back to the usual start.
    }
  }

  try {
    const stored = await extension.storage.local.get("activeGame");
    if (stored && stored.activeGame && stored.activeGame.pgn) {
      const res = loadGameFromPayload(stored.activeGame);
      if (res.ok) {
        runFullAnalysis();
        if (missingGame) showTrainingNotice("That game is no longer saved for practice.");
        return;
      }
    }
  } catch {
    // Ignore outside extension context
  }

  dom.gameMetaSubtitle.textContent = "Finish a game on Chess.com or click Load PGN to begin";
  openPgnModal();
  if (missingGame) showTrainingNotice("That game is no longer saved for practice.");
}

bootstrap();
