import { Chess, DEFAULT_POSITION } from "./vendor/chess.js/chess.js";
import { COLOR, INPUT_EVENT_TYPE } from "./vendor/cm-chessboard/src/Chessboard.js";
import { MARKER_TYPE } from "./vendor/cm-chessboard/src/extensions/markers/Markers.js";
import { createBoard, requestPromotion } from "./board-setup.js";
import {
  ACCURACY_MODEL_VERSION,
  CLASSIFICATIONS,
  StockfishEngine,
  computeACPL,
  computeGameAccuracy,
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
  analyzeGamePosition, compareRootMoves, deepCheckDecision, parseReviewGame, scoreDecision, terminalPosition,
} from "./analysis.js";
import { EnginePool, enginePoolSize } from "./engine-pool.js";
import { runReview } from "./review-run.js";
import { AI_PRESETS, coachEndpoint, coachRequestBody, migrateCoachSettings } from "./coach-api.js";
import { coachEvidence } from "./coach-evidence.js";
import { findTactic, reviewTactics, tacticArrows } from "./motifs.js";
import { captureGain, describeThreat, lineSteps, threatFen } from "./lines.js";
import { arrowLine, makeShape, shapeColor, squareAt, squareCenter, toggleShape } from "./board-shapes.js";
import { annotatedPgn, GRADE_NAG, mistakeComment, pgnFileName, swingText } from "./annotated-pgn.js";
import { explainError } from "./coach-reasons.js";
import { problemReportUrl } from "./report.js";
import {
  advantagePoints, areaPath, formatSeconds, linePath, moveLabel, moveTimes, phaseDivisions, plyAt,
} from "./eval-chart.js";
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
  HUMAN_MOVE_SEARCH_DEPTH, candidateCpScores, candidateScores, forecastHumanMoves, humanContext, moveFeatureRows,
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
const ARROW_TACTIC = { class: "arrow-tactic" };
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
  // Per ply: the engine comparison behind moveReviews, and the first root search used for peer predictions.
  comparisons: [],
  initialRoots: [],
  // Plies with a quick grade that a deeper check may still change.
  pendingPlies: new Set(),
  currentPly: 0,
  orientation: "w",
  activeTab: "review",
  // The review chart: "advantage" or "times", and the drawn points for hover.
  chartMode: "advantage",
  chartPoints: null,
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
  // The latest evaluation of the variation position, so a threat can be judged against it.
  variationEval: null,
  boardEpoch: 0,
  // The position on the board, and the arrows and circles drawn on each position (keyed by placement and turn).
  shownFen: null,
  shapes: new Map(),
  showThreat: false,

  drillActive: false,
  drillPlies: [],
  drillIndex: 0,
  drillSolvedSet: new Set(),
  drillSolved: false,
  drillChecking: false,

  coachCache: new Map(),
  humanForecasts: new Map(),
  humanForecastTried: new Set(),
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
let enginePool = null;

/** Dark text on a grade color, or white where dark text would fall below 4.5:1 contrast (WCAG AA). */
function badgeTextColor(hex) {
  const channel = (offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  // #11100e, the page's darkest text, has a relative luminance of about 0.0055.
  return (luminance + 0.05) / (0.0055 + 0.05) >= 4.5 ? "#11100e" : "#ffffff";
}

/** A bug-report link with the version, browser and engine count. It contains no game data. */
function reportUrl(error = "", engines = null) {
  return problemReportUrl({
    version: extension?.runtime?.getManifest?.().version, userAgent: navigator.userAgent, engines, error,
  });
}

function stopReviewEngines() {
  enginePool?.abort();
  enginePool = null;
  engine?.abort();
}

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
  shapeLayer: document.getElementById("shapeLayer"),
  threatBtn: document.getElementById("threatBtn"),
  threatBanner: document.getElementById("threatBanner"),
  threatText: document.getElementById("threatText"),
  threatLine: document.getElementById("threatLine"),
  threatEval: document.getElementById("threatEval"),
  shortcutsBtn: document.getElementById("shortcutsBtn"),
  shortcutsBackdrop: document.getElementById("shortcutsBackdrop"),
  closeShortcutsBtn: document.getElementById("closeShortcutsBtn"),
  linePreview: document.getElementById("linePreview"),
  linePreviewBoard: document.getElementById("linePreviewBoard"),
  linePreviewLabel: document.getElementById("linePreviewLabel"),
  copyPgnBtn: document.getElementById("copyPgnBtn"),
  downloadPgnBtn: document.getElementById("downloadPgnBtn"),
  exportStatus: document.getElementById("exportStatus"),

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
  evalGraphWrap: document.getElementById("evalGraphWrap"),
  evalTooltip: document.getElementById("evalTooltip"),
  chartTabs: document.getElementById("chartTabs"),
  chartTitle: document.getElementById("chartTitle"),
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
  accuracyRefWhite: document.getElementById("accuracyRefWhite"),
  acplWhiteVal: document.getElementById("acplWhiteVal"),
  qualityWhiteVal: document.getElementById("qualityWhiteVal"),
  worstWhiteVal: document.getElementById("worstWhiteVal"),
  accBlackName: document.getElementById("accBlackName"),
  accBlackVal: document.getElementById("accBlackVal"),
  accBlackRing: document.getElementById("accBlackRing"),
  accuracyRefBlack: document.getElementById("accuracyRefBlack"),
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
  reportProblemLink: document.getElementById("reportProblemLink"),
  reportErrorLink: document.getElementById("reportErrorLink"),
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
  for (const element of [dom.boardThemeWrap, dom.linePreview]) {
    element.classList.remove("theme-emerald", "theme-slate", "theme-walnut");
    element.classList.add(`theme-${valid}`);
  }
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
    valEl.title = "Game accuracy (Chess.com-compatible CAPS2 calibration)";
    ringEl.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
    return;
  }
  const clamped = Math.max(0, Math.min(100, value));
  valEl.textContent = `${clamped.toFixed(1)}%`;
  valEl.title = `Game accuracy (Chess.com-compatible CAPS2 calibration) · ${clamped.toFixed(1)}%`;
  const offset = RING_CIRCUMFERENCE * (1 - clamped / 100);
  ringEl.style.strokeDashoffset = offset.toFixed(2);
}

/** The Lichess-style number and, when supplied by the Chess.com API, Chess.com's own score. */
function setAccuracyDetails(element, lichess, chesscom) {
  const parts = [];
  if (Number.isFinite(lichess)) parts.push(`Lichess-style ${lichess.toFixed(1)}%`);
  if (Number.isFinite(chesscom)) parts.push(`Chess.com ${chesscom.toFixed(1)}%`);
  element.textContent = parts.join(" · ");
  element.classList.toggle("hidden", parts.length === 0);
  element.title = "Lichess-style game accuracy uses Lichess's volatility/harmonic blend. Chess.com is the Game Review score stored by Chess.com, when available.";
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

/** Put a position on the board. Every position change goes through here so drawings and the threat follow it. */
function showPosition(fen, animated = true) {
  state.shownFen = fen;
  board.setPosition(fen, animated);
  renderShapeLayer();
  if (state.showThreat) refreshThreat();
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
  el.style.color = badgeTextColor(cls.color);
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
      if (!chosen || !commitBoardMove(activeChess, chosen)) showPosition(activeChess.fen(), true);
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
  showPosition(activeChess.fen(), true);

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
  if (!engine) {
    dom.variationEvalTag.textContent = withRule("");
    return;
  }
  dom.variationEvalTag.textContent = withRule("Eval...");
  try {
    // During a review this runs on the next free engine, ahead of the review's queue.
    const res = await interactiveSearch((searchEngine) => (
      runId === state.variationEvalRunId ? analyzeGamePosition(searchEngine, position, 12) : null));
    if (!res || runId !== state.variationEvalRunId || !state.exploring) return;
    state.variationEval = { fen: position.fen, eval: res.eval };
    if (state.showThreat && state.shownFen === position.fen) refreshThreat();
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
  showPosition(sim.fen(), true);
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
      showPosition(sim.fen(), true);
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
  if (state.isAnalyzing) stopReviewEngines();
  state.analysisRunId++;
  state.isAnalyzing = false;

  const whiteName = payload.white?.username || headers.White || "White";
  const blackName = payload.black?.username || headers.Black || "Black";
  const result = headers.Result || "*";
  const bookMoves = findBookMoves(positions);
  const opening = extractOpeningName(headers) || bookMoves.findLast((match) => match?.name)?.name || "";
  // Trust the signed-in account or saved username over the page's bottom player when choosing a side.
  const knownSide = confirmedSide({
    colorConfirmed: payload.colorConfirmed,
    playedColor: payload.playedColor,
    accountUsername: payload.accountUsername,
    white: { username: whiteName },
    black: { username: blackName },
  }, dom.fallbackUsernameInput.value);

  state.gameMeta = {
    ...payload,
    result,
    opening,
    white: { username: whiteName, ...recordedRating(payload.white?.rating, headers.WhiteElo), result: payload.white?.result || "" },
    black: { username: blackName, ...recordedRating(payload.black?.rating, headers.BlackElo), result: payload.black?.result || "" },
    playedColor: knownSide || payload.playedColor || positions[1].move.color,
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
  state.comparisons = new Array(positions.length).fill(null);
  state.initialRoots = new Array(positions.length).fill(null);
  state.moveReviews = new Array(positions.length).fill(null);
  state.currentPly = 0;
  clearVariationState();
  resetDrillProgress();
  state.coachCache.clear();
  state.humanForecasts.clear();
  state.humanForecastTried.clear();
  state.shapes.clear();
  state.variationEval = null;
  lineRegistry.clear();

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
    const source = { positions: state.positions, evals: state.evals, initialRoots: state.initialRoots, moveReviews: state.moveReviews, playedColor };
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
      reviewedAt: previous?.accuracyVersion === ACCURACY_MODEL_VERSION ? previous.reviewedAt : Date.now(),
      date,
      color: playedColor,
      result,
      timeClass,
      opponent,
      depth,
      decisions,
      ...accuracy,
      chesscomAccuracy: meta.accuracies ?? meta.chesscomAccuracy ?? null,
    });
    const game = { ...summary, gameId, pgn, timeControl, endTime };
    renderPersonalPerformance(comparePersonalPerformance({ current: game, history: [...data.games.values()] }));
    // Old summaries use the previous accuracy scale; allow a re-review to replace them even at a
    // lower depth. A current-version deeper review still wins.
    if (previous && previous.color === playedColor && previous.depth > depth &&
        previous.accuracyVersion === ACCURACY_MODEL_VERSION) return;
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
  updateExportButtons();
  const depth = Number(dom.depthSelect.value) || 16;

  cancelDeepCheck();
  state.deepChecks.clear();
  clearPerformanceContext();
  dom.progressBarWrap.classList.remove("hidden");
  dom.reportErrorLink.classList.add("hidden");
  dom.progressFill.style.width = "0%";
  dom.progressLabel.textContent = "Loading Stockfish 19…";
  dom.reanalyzeBtn.disabled = true;
  state.evals.fill(null);
  state.moveReviews.fill(null);
  state.coachCache.clear();
  state.humanForecasts.clear();
  state.humanForecastTried.clear();
  switchTab("review");
  resetDrillProgress();
  updateScoreboard();
  renderKeyMoments();
  renderMoveList();
  updateDrillBadgeCount();
  goToPly(state.currentPly, false);

  state.comparisons = new Array(state.positions.length).fill(null);
  state.initialRoots = new Array(state.positions.length).fill(null);
  state.pendingPlies.clear();

  const stale = () => runId !== state.analysisRunId;
  const decisions = state.positions.length - 1;
  let pool = null;
  let quickDone = 0;
  let deepTotal = 0;
  let renderQueued = false;
  const touched = new Set();
  const showProgress = () => {
    const size = pool?.size ?? 1;
    const engines = `${size} ${size === 1 ? "engine" : "engines"}`;
    if (quickDone === 0) {
      dom.progressLabel.textContent = `Loading Stockfish 19 · ${engines}…`;
    } else if (quickDone < decisions) {
      dom.progressLabel.textContent = `Stockfish 19 · quick pass ${quickDone} of ${decisions} moves · depth ${depth} · ${engines}`;
      dom.progressFill.style.width = `${Math.round(quickDone / Math.max(1, decisions) * 50)}%`;
    } else {
      const checked = deepTotal - state.pendingPlies.size;
      dom.progressLabel.textContent = `Stockfish 19 · checking close calls deeper · ${checked} of ${deepTotal} · ${engines}`;
      dom.progressFill.style.width = `${50 + Math.round(checked / Math.max(1, deepTotal) * 50)}%`;
    }
  };
  // Results arrive out of order from several engines; draw them at most every 100 ms.
  // A timer, unlike an animation frame, keeps the progress current in a background tab.
  const queueRender = (...plies) => {
    for (const ply of plies) touched.add(ply);
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => {
      renderQueued = false;
      if (stale()) return;
      // The finished review sets its own label.
      if (state.isAnalyzing) showProgress();
      updateScoreboard();
      renderEvalGraph();
      renderMoveList();
      renderKeyMoments();
      const current = state.currentPly;
      if (touched.has(current) || touched.has(current + 1)) {
        // A variation on the board keeps its own evaluation and arrows.
        if (!state.exploring) {
          updateEvalBar(current);
          updateArrowsForPly(current);
        }
        updateSquareBadgeOverlay(current);
        renderCoachCard(current);
      }
      touched.clear();
    }, 100);
  };
  const rescore = (ply) => {
    const comparison = state.comparisons[ply];
    if (!comparison) return;
    const before = state.positions[ply - 1];
    const pos = state.positions[ply];
    // Miss depends on the opponent's previous loss, so a move is scored again when that loss changes.
    const prevOpponentWinLoss = state.moveReviews[ply - 1]?.winLoss ?? 0;
    const { root } = comparison;
    const review = scoreDecision(before, pos, comparison, prevOpponentWinLoss);
    const book = bookForReview(pos.terminal ? null : state.bookMoves[ply], review);
    state.moveReviews[ply] = {
      ...review,
      provisional: state.pendingPlies.has(ply),
      book,
      peerDifficulty: peerDecisionPrediction(before, state.initialRoots[ply - 1], pos.move.color),
      coachReply: coachEvidence(pos, review),
      tactics: reviewTactics({
        fenEarlier: state.positions[ply - 2]?.fen, fenBefore: before.fen, fenAfter: pos.fen, playedUci: pos.move.uci, grade: review.classification.key,
        playedPv: review.playedPv, bestPv: root.pv,
      }),
      reasons: ["inaccuracy", "mistake", "miss", "blunder"].includes(review.classification.key) ? explainError({
        fenEarlier: state.positions[ply - 2]?.fen, fenBefore: before.fen, fenAfter: pos.fen,
        previousUci: before.move?.uci, previousCaptured: before.move?.captured, playedUci: pos.move.uci,
        playedPv: review.playedPv, bestPv: root.pv, color: pos.move.color, phase: before.phase, winLoss: review.winLoss,
      }) : null,
      bestSan: pvToSan(before.fen, root.pv, 1),
      pvSan: pvToSan(before.fen, root.pv),
      pvEvalStr: formatEval(root.eval),
      secondPvSan: pvToSan(before.fen, root.secondPv, 5),
      secondEvalStr: root.secondEval ? formatEval(root.secondEval) : "",
      playedPvSan: pvToSan(before.fen, review.playedPv),
    };
    state.coachCache.delete(ply);
  };
  const setComparison = (ply, comparison) => {
    state.comparisons[ply] = comparison;
    state.evals[ply - 1] = comparison.root;
    rescore(ply);
    rescore(ply + 1);
    queueRender(ply - 1, ply, ply + 1);
  };

  try {
    engine ??= new StockfishEngine(STOCKFISH_WORKER_PATH);
    const size = enginePoolSize({ cores: navigator.hardwareConcurrency, memoryGB: navigator.deviceMemory });
    pool = enginePool = new EnginePool(() => new StockfishEngine(STOCKFISH_WORKER_PATH), size, engine);
    showProgress();

    await runReview({
      positions: state.positions,
      depth,
      pool,
      isCancelled: stale,
      onRoot: (index, root) => {
        state.initialRoots[index] = root;
        // A move's comparison replaces the position's evaluation; the final position keeps its own search.
        if (!state.comparisons[index + 1]) state.evals[index] = root;
        queueRender(index);
      },
      onQuick: (ply, quick) => {
        quickDone++;
        if (quick.needsRefinement) {
          deepTotal++;
          state.pendingPlies.add(ply);
        }
        setComparison(ply, quick.comparison);
      },
      onFinal: (ply, comparison) => {
        if (!state.pendingPlies.delete(ply)) return;
        setComparison(ply, comparison);
      },
    });
    if (stale()) return;

    pool.close();
    if (enginePool === pool) enginePool = null;
    state.isAnalyzing = false;
    dom.progressFill.style.width = "100%";
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
    if (state.exploring) {
      // Leave a variation the player is exploring on the board; refresh the move's card around it.
      renderCoachCard(state.currentPly);
      updateGuidedCta(state.currentPly);
    } else {
      goToPly(state.currentPly, false);
    }
    recordReviewedGame(runId, depth);
  } catch (err) {
    if (runId !== state.analysisRunId) return;
    pool?.abort();
    if (enginePool === pool) enginePool = null;
    dom.progressLabel.textContent = `Engine error: ${err.message}`;
    dom.reportErrorLink.href = reportUrl(err.message, pool?.size);
    dom.reportErrorLink.classList.remove("hidden");
  } finally {
    if (runId === state.analysisRunId) {
      state.isAnalyzing = false;
      dom.reanalyzeBtn.disabled = false;
      updateExportButtons();
    }
  }
}

function goToPly(ply, animate = true, withSound = false) {
  if (!state.positions.length) return;
  stopBestLineAnimation();
  hideLinePreview();
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
    showPosition(pos.fen, animate);
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
  // The bar, chart, grades, and accuracy share the Lichess win-probability curve. The tooltip keeps
  // Stockfish's WDL estimate, which is a different calibration.
  const winWhite = evalData?.eval ? evalToWinWhite(evalData.eval) : 50;
  const label = evalData ? formatEval(evalData.eval) : "0.0";

  dom.evalBar.classList.toggle("flipped", state.orientation === "b");
  dom.evalFillWhite.style.height = `${Math.max(4, Math.min(96, winWhite))}%`;
  dom.evalScoreLabel.textContent = evalData?.checkmate ? "#" : label;
  const wdl = evalData?.wdl;
  dom.evalBar.title = wdl
    ? `White · win ${wdl.win / 10}% · draw ${wdl.draw / 10}% · loss ${wdl.loss / 10}%`
    : "White win probability on the Lichess curve";

  const whiteAdvantage = winWhite >= 50;
  const whiteAtBottom = state.orientation === "w";
  const placeAtTop = (whiteAdvantage && !whiteAtBottom) || (!whiteAdvantage && whiteAtBottom);
  dom.evalScoreLabel.classList.toggle("top-dark", placeAtTop);
}

function updateEvalBar(ply) {
  updateEvalBarFromData(state.evals[ply]);
}

function updateArrowsForPly(ply) {
  // A variation draws its own arrows; the game move's arrows return when it ends.
  if (!board || state.exploring) return;
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
    // When the reply is a tactic, show what it attacks.
    const allowed = review.tactics?.allowed;
    if (allowed && allowed.san === review.coachReply.san) {
      for (const [start, end] of tacticArrows(allowed)) board.addArrow(ARROW_TACTIC, start, end);
      for (const { square: target } of allowed.targets) {
        if (target !== square) board.addMarker(MARKER_TYPE.frameDanger, target);
      }
    }
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
    dom.moveBadge.style.color = "";
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
    dom.moveBadge.style.color = "";
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
  dom.moveBadge.style.color = badgeTextColor(cls.color);
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
  dom.engineLossText.title = `Stockfish depth ${review.depth}. Expected-score loss uses the Lichess win-probability curve. This loss drives the move grade and move accuracy; game accuracy uses a Chess.com-compatible calibration.`;
  dom.moveAccuracyPill.textContent = review.forced ? "Only legal move" : `Move: ${review.accuracy.toFixed(0)}%`;
  dom.moveAccuracyPill.title = review.forced
    ? "The only legal move scores 100%."
    : "Lichess-style move accuracy. Game accuracy uses a Chess.com-compatible calibration.";
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
  const searchEvidence = {
    single: "One comparison", stable: "Two depths agree", borderline: "Grade uncertain", forced: "Forced move",
    pending: "Checking deeper…",
  };
  dom.gradeConfidenceText.textContent = `Depth ${review.depth} · ${searchEvidence[review.searchConfidence]}`;
  dom.gradeConfidenceText.classList.remove("hidden");

  if (review.pvSan) {
    const root = state.evals[ply - 1];
    dom.pvLinesBox.classList.remove("hidden");
    dom.pvLineWrap.classList.remove("hidden");
    dom.pvEval1.textContent = review.pvEvalStr || "";
    renderLineMoves(dom.pvLineText, "pv1", ply - 1, lineSteps(posBefore.fen, root?.pv, 6));
    dom.showBestLineBtn.classList.remove("hidden");

    if (review.secondPvSan) {
      dom.pvLine2Wrap.classList.remove("hidden");
      dom.pvEval2.textContent = review.secondEvalStr || "";
      renderLineMoves(dom.pvLine2Text, "pv2", ply - 1, lineSteps(posBefore.fen, root?.secondPv, 5));
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
      const loss = played ? review.winLoss : (Number.isFinite(tempting.cpLoss) ? tempting.cpLoss : tempting.loss);
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
  if (state.humanForecastTried.has(ply)) return;
  if (state.humanForecastBusy) {
    state.humanForecastNext = ply;
    return;
  }
  const before = state.positions[ply - 1];
  const after = state.positions[ply];
  if (!before || !after?.move || before.terminal || before.legalMoves < 2) return;
  // Do not repeat a heavy all-moves search when it could not return every legal move.
  state.humanForecastTried.add(ply);
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
    const rows = moveFeatureRows(replayVariation(before), candidateScores(search, color), context, before.move?.to ?? null,
      candidateCpScores(search, color));
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
  // Use the uniform quick-pass roots for the Lichess-style comparison. state.evals can contain
  // deeper re-search roots, which would add artificial volatility; game accuracy itself no longer
  // depends on this timeline.
  const timelineSource = state.initialRoots.some(Boolean) ? state.initialRoots : state.evals;
  const winTimeline = timelineSource.map((e) => e ? evalToWinWhite(e.eval) : null);
  const whiteMoves = [];
  const blackMoves = [];
  const whiteGameMoves = [];
  const blackGameMoves = [];
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
    const gameMove = { winLoss: rev.winLoss, book: rev.book, forced: rev.forced };
    if (move.color === "w") whiteGameMoves.push(gameMove);
    else blackGameMoves.push(gameMove);
    if (rev.forced) continue;
    if (move.color === "w") {
      whiteMoves.push({ ply: i, accuracy: rev.accuracy });
      whiteCpLosses.push(rev.cpLoss);
    } else {
      blackMoves.push({ ply: i, accuracy: rev.accuracy });
      blackCpLosses.push(rev.cpLoss);
    }
  }

  const whiteAcc = computeGameAccuracy(whiteGameMoves);
  const blackAcc = computeGameAccuracy(blackGameMoves);
  // Keep the Lichess-style number available for comparison and for users with older expectations.
  const whiteLichess = computeProGameAccuracy(winTimeline, whiteMoves);
  const blackLichess = computeProGameAccuracy(winTimeline, blackMoves);
  const whiteAcpl = computeACPL(whiteCpLosses);
  const blackAcpl = computeACPL(blackCpLosses);

  updateAccuracyRing(dom.accWhiteVal, dom.accWhiteRing, whiteAcc);
  updateAccuracyRing(dom.accBlackVal, dom.accBlackRing, blackAcc);
  const reference = state.gameMeta?.accuracies ?? state.gameMeta?.chesscomAccuracy;
  setAccuracyDetails(dom.accuracyRefWhite, whiteLichess, reference?.white);
  setAccuracyDetails(dom.accuracyRefBlack, blackLichess, reference?.black);
  dom.acplWhiteVal.textContent = whiteAcpl !== null ? `${whiteAcpl} ACPL` : "-- ACPL";
  dom.acplBlackVal.textContent = blackAcpl !== null ? `${blackAcpl} ACPL` : "-- ACPL";

  for (const [color, qualityEl, peakEl, countEl, count] of [
    ["w", dom.qualityWhiteVal, dom.worstWhiteVal, dom.scoredWhiteMoves, whiteMoves.length],
    ["b", dom.qualityBlackVal, dom.worstBlackVal, dom.scoredBlackMoves, blackMoves.length],
  ]) {
    const reviews = reviewsByColor[color];
    const uncertain = reviews.filter(({ searchConfidence }) => searchConfidence === "borderline").length;
    const checking = reviews.filter(({ provisional }) => provisional).length;
    const scores = `${count} scored ${count === 1 ? "decision" : "decisions"}`;
    countEl.textContent = `${scores}${uncertain ? ` · ${uncertain} uncertain ${uncertain === 1 ? "grade" : "grades"}` : ""}` +
      `${checking ? ` · ${checking} being checked deeper` : ""}`;
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

/** A count that jumps to that side's next move of this grade when clicked, like Lichess's summary. */
function countCell(key, color, count, label) {
  const cell = document.createElement("td");
  cell.className = "num";
  if (!count) {
    cell.textContent = "0";
    return cell;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "count-jump";
  button.textContent = String(count);
  const side = color === "w" ? "White" : "Black";
  button.setAttribute("aria-label", `Go to ${side}'s next ${label} (${count} in total)`);
  button.title = `Go to ${side}'s next ${label}`;
  button.addEventListener("click", () => {
    const plies = [];
    for (let ply = 1; ply < state.positions.length; ply++) {
      const review = state.moveReviews[ply];
      if (review && state.positions[ply].move?.color === color && displayClassification(review).key === key) plies.push(ply);
    }
    const next = plies.find((ply) => ply > state.currentPly) ?? plies[0];
    if (next === undefined) return;
    stopAutoplay();
    goToPly(next, true, true);
  });
  cell.appendChild(button);
  return cell;
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
    dot.style.color = badgeTextColor(cls.color);
    dot.textContent = cls.symbol;

    const nameSpan = document.createElement("span");
    nameSpan.textContent = cls.label;
    if (key === "book") nameSpan.title = "Sound opening move in the bundled Lichess catalog";

    cellSpan.appendChild(dot);
    cellSpan.appendChild(nameSpan);
    tdLabel.appendChild(cellSpan);

    const tdWhite = countCell(key, "w", counts.w[key], cls.label);
    const tdBlack = countCell(key, "b", counts.b[key], cls.label);

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
  const filler = () => {
    const span = document.createElement("span");
    span.className = "move-filler";
    span.textContent = "…";
    return span;
  };

  // Two moves per row, as on a scoresheet. A comment ends its row, as in Lichess's analysis.
  let row = null;
  for (let ply = 1; ply <= totalPlies; ply++) {
    const move = state.positions[ply].move;
    if (move.color === "w" || !row) {
      row = document.createElement("div");
      row.className = "move-row";
      const numEl = document.createElement("span");
      numEl.className = "move-num";
      numEl.textContent = `${move.number}.`;
      row.appendChild(numEl);
      if (move.color === "b") row.appendChild(filler());
      frag.appendChild(row);
    }
    row.appendChild(createMoveCell(ply));
    const comment = moveListComment(ply);
    if (comment) {
      if (move.color === "w") row.appendChild(filler());
      frag.appendChild(comment);
      row = null;
    } else if (move.color === "b") {
      row = null;
    }
  }

  if (previewButton && dom.moveList.contains(previewButton)) hideLinePreview();
  dom.moveList.replaceChildren(frag);
  highlightActiveMoveInList(state.currentPly);
  updateExportButtons();
}

/** "Mistake. g4 was best." with the evaluation change and Stockfish's line, under a graded error. */
function moveListComment(ply) {
  const review = state.moveReviews[ply];
  if (!review || review.book) return null;
  const grade = review.classification.key;
  if (!mistakeComment(grade, review.bestSan)) return null;
  const cls = displayClassification(review);
  const comment = document.createElement("div");
  comment.className = "move-comment";
  comment.classList.toggle("is-provisional", Boolean(review.provisional));
  comment.style.setProperty("--comment-color", cls.color);

  const text = document.createElement("div");
  const word = document.createElement("span");
  word.className = "move-comment-grade";
  word.textContent = `${cls.label}.`;
  text.append(word, review.bestSan ? ` ${review.bestSan} was best.` : "");
  const swing = document.createElement("span");
  swing.className = "move-comment-swing";
  swing.textContent = `${formatEval(state.evals[ply - 1]?.eval)} → ${formatEval(review.playedEval)}`;
  swing.title = "Evaluation before and after the move, from White's side";
  text.append(swing);
  comment.append(text);

  const steps = lineSteps(state.positions[ply - 1].fen, state.evals[ply - 1]?.pv, 6);
  if (steps.length) {
    const line = document.createElement("div");
    line.className = "line-moves";
    renderLineMoves(line, `list-${ply}`, ply - 1, steps);
    comment.append(line);
  }
  return comment;
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
    badge.style.color = badgeTextColor(cls.color);
    badge.textContent = cls.symbol;
    badge.title = rev.provisional ? `${cls.label} · checking deeper` : cls.label;
    badge.setAttribute("aria-hidden", "true");
    btn.classList.toggle("is-provisional", Boolean(rev.provisional));
    btn.setAttribute("aria-label", `${pos.move.san}, ${cls.label}${rev.provisional ? ", checking deeper" : ""}`);
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
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      cell.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    }
  });
}

// Chart colors: White's side light, Black's side dark, the current move in orange.
const CHART = {
  white: "rgba(236, 233, 226, 0.9)", black: "rgba(0, 0, 0, 0.62)", line: "rgba(255, 255, 255, 0.62)",
  center: "rgba(255, 255, 255, 0.2)", division: "rgba(255, 255, 255, 0.24)", label: "#a3a098",
  current: "#e8923a", hover: "rgba(255, 255, 255, 0.5)", whiteBar: "rgba(236, 233, 226, 0.88)", blackBar: "#5b5750",
};
const CHART_MARKED = new Set(["inaccuracy", "mistake", "miss", "blunder", "brilliant", "great"]);
let chartHoverPly = null;
let chartScrubbing = false;

/** The chart's size in CSS pixels, so dots and labels are drawn without stretching. */
function chartSize() {
  const box = dom.evalGraphSvg.getBoundingClientRect();
  return { width: Math.max(120, Math.round(box.width) || 420), height: Math.max(60, Math.round(box.height) || 132) };
}

function chartTimes() {
  return state.positions.length > 1 ? moveTimes(state.positions) : null;
}

function renderChartTabs() {
  const hasTimes = Boolean(chartTimes());
  dom.chartTabs.classList.toggle("hidden", !hasTimes);
  // With both charts available, the tabs name the chart.
  dom.chartTitle.classList.toggle("hidden", hasTimes);
  if (!hasTimes) state.chartMode = "advantage";
  for (const button of dom.chartTabs.querySelectorAll("[data-chart]")) {
    const active = button.dataset.chart === state.chartMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  dom.chartTitle.textContent = state.chartMode === "times" ? "Move Times" : "Advantage";
}

function renderEvalGraph() {
  renderChartTabs();
  const svg = dom.evalGraphSvg;
  const { width: W, height: H } = chartSize();
  const mid = H / 2;
  const n = state.positions.length;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const frag = document.createDocumentFragment();
  frag.appendChild(createSvgEl("line", { x1: 0, y1: mid, x2: W, y2: mid, stroke: CHART.center, "stroke-width": 1 }));
  if (n <= 1) {
    svg.replaceChildren(frag);
    return;
  }
  const step = W / (n - 1);
  const xFor = (ply) => ply * step;

  // Phase divisions, labelled at the top like a scoresheet's sections.
  const divisions = phaseDivisions(state.positions);
  for (const [phase, ply] of [["Middlegame", divisions.middlegame], ["Endgame", divisions.endgame]]) {
    if (ply === null) continue;
    const x = xFor(ply);
    frag.appendChild(createSvgEl("line", {
      x1: x, y1: 0, x2: x, y2: H, stroke: CHART.division, "stroke-width": 1, "stroke-dasharray": "3 3",
    }));
    const label = createSvgEl("text", { x: Math.min(x + 4, W - 4), y: 11, fill: CHART.label, "font-size": 9.5,
      "text-anchor": x + 60 > W ? "end" : "start", class: "chart-label" });
    label.textContent = phase;
    frag.appendChild(label);
  }

  let points;
  if (state.chartMode === "times") {
    points = drawMoveTimes(frag, chartTimes(), { W, H, mid, step, xFor });
  } else {
    // Lichess's centipawn curve, gentler than Stockfish's win-draw-loss estimate, keeps large advantages readable.
    points = advantagePoints(state.evals.map((entry) => entry ? evalToWinWhite(entry.eval) : undefined), n, W, H);
    const defs = createSvgEl("defs");
    const clip = (id, y, height) => {
      const path = createSvgEl("clipPath", { id });
      path.appendChild(createSvgEl("rect", { x: 0, y, width: W, height }));
      defs.appendChild(path);
    };
    clip("chartAbove", 0, mid);
    clip("chartBelow", mid, H - mid);
    frag.appendChild(defs);
    const area = areaPath(points, mid);
    frag.appendChild(createSvgEl("path", { d: area, fill: CHART.white, "clip-path": "url(#chartAbove)" }));
    frag.appendChild(createSvgEl("path", { d: area, fill: CHART.black, "clip-path": "url(#chartBelow)" }));
    frag.appendChild(createSvgEl("path", { d: linePath(points), fill: "none", stroke: CHART.line, "stroke-width": 1.2,
      "stroke-linejoin": "round" }));
    for (let ply = 1; ply < n; ply++) {
      const review = state.moveReviews[ply];
      if (!review || !CHART_MARKED.has(review.classification.key)) continue;
      frag.appendChild(createSvgEl("circle", {
        cx: points[ply].x.toFixed(1), cy: points[ply].y.toFixed(1), r: review.classification.key === "blunder" ? 3.6 : 3,
        fill: review.classification.color, stroke: "#11100e", "stroke-width": 1,
      }));
    }
  }

  // The current move.
  const current = Math.min(state.currentPly, n - 1);
  const x = xFor(current);
  frag.appendChild(createSvgEl("line", { x1: x, y1: 0, x2: x, y2: H, stroke: CHART.current, "stroke-width": 1.5 }));
  if (points?.[current]) {
    frag.appendChild(createSvgEl("circle", { cx: x.toFixed(1), cy: points[current].y.toFixed(1), r: 3.8,
      fill: CHART.current, stroke: "#11100e", "stroke-width": 1.2 }));
  }
  const hover = createSvgEl("g", { id: "chartHover" });
  frag.appendChild(hover);
  svg.replaceChildren(frag);
  state.chartPoints = points;
  if (chartHoverPly !== null) showChartHover(chartHoverPly);
}

/** Bars of time spent per move: White's up from the center, Black's down. Errors take their grade color. */
function drawMoveTimes(frag, times, { W, H, mid, step, xFor }) {
  const known = times.filter(Number.isFinite);
  const longest = Math.max(1, ...known);
  const room = mid - 6;
  const width = Math.max(1, Math.min(10, step * 0.72));
  const points = [{ ply: 0, x: 0, y: mid }];
  for (let ply = 1; ply < state.positions.length; ply++) {
    const seconds = times[ply];
    const white = state.positions[ply].move.color === "w";
    const height = Number.isFinite(seconds) ? Math.max(1, (seconds / longest) * room) : 0;
    const y = white ? mid - height : mid;
    const review = state.moveReviews[ply];
    const error = review && ["inaccuracy", "mistake", "miss", "blunder"].includes(review.classification.key);
    if (height) {
      frag.appendChild(createSvgEl("rect", {
        x: (xFor(ply) - width / 2).toFixed(1), y: y.toFixed(1), width: width.toFixed(1), height: height.toFixed(1),
        fill: error ? review.classification.color : white ? CHART.whiteBar : CHART.blackBar, rx: Math.min(1.5, width / 3),
      }));
    }
    points.push({ ply, x: xFor(ply), y: white ? mid - height : mid + height });
  }
  return points;
}

/** The hover crosshair, dot, and tooltip beside the point. */
function showChartHover(ply) {
  const group = document.getElementById("chartHover");
  const point = state.chartPoints?.[ply];
  if (!group || !point) return;
  const { height: H, width: W } = chartSize();
  group.replaceChildren(
    createSvgEl("line", { x1: point.x, y1: 0, x2: point.x, y2: H, stroke: CHART.hover, "stroke-width": 1, "stroke-dasharray": "2 2" }),
    createSvgEl("circle", { cx: point.x, cy: point.y, r: 3.4, fill: "#f3f1ec", stroke: "#11100e", "stroke-width": 1 }),
  );
  const position = state.positions[ply];
  const review = state.moveReviews[ply];
  // Annotation marks attach to the move as on a scoresheet: Nf3?!, Bxf7+!!
  const mark = { brilliant: "!!", great: "!", inaccuracy: "?!", mistake: "?", blunder: "??", miss: "?" }[review?.classification.key] ?? "";
  let detail;
  if (state.chartMode === "times") {
    const seconds = chartTimes()?.[ply];
    const color = position.move?.color;
    const left = color && position.practicalContext?.[color === "w" ? "whiteSeconds" : "blackSeconds"];
    detail = ply ? `${formatSeconds(seconds)}${Number.isFinite(left) ? ` · ${formatSeconds(left)} left` : ""}` : "";
  } else {
    detail = state.evals[ply] ? formatEval(state.evals[ply].eval) : "…";
  }
  const label = ply ? `${moveLabel(position)}${mark}` : "Start";
  dom.evalTooltip.textContent = detail ? `${label} · ${detail}` : label;
  dom.evalTooltip.classList.remove("hidden");
  const tipWidth = dom.evalTooltip.offsetWidth || 110;
  const left = point.x + 10 + tipWidth > W ? point.x - 10 - tipWidth : point.x + 10;
  dom.evalTooltip.style.left = `${Math.max(4, left)}px`;
  dom.evalTooltip.style.top = `${Math.max(4, Math.min(H - 26, point.y - 12))}px`;
}

function hideChartHover() {
  chartHoverPly = null;
  document.getElementById("chartHover")?.replaceChildren();
  dom.evalTooltip.classList.add("hidden");
}

function chartPlyFromEvent(event) {
  const box = dom.evalGraphSvg.getBoundingClientRect();
  return plyAt((event.clientX - box.left) / box.width, state.positions.length);
}

// Click or drag along the chart to move through the game.
dom.evalGraphSvg.addEventListener("pointerdown", (event) => {
  if (state.positions.length <= 1 || event.button !== 0) return;
  stopAutoplay();
  chartScrubbing = true;
  dom.evalGraphSvg.setPointerCapture(event.pointerId);
  const ply = chartPlyFromEvent(event);
  if (ply !== state.currentPly) goToPly(ply, false);
});

dom.evalGraphSvg.addEventListener("pointermove", (event) => {
  if (state.positions.length <= 1) return;
  const ply = chartPlyFromEvent(event);
  if (chartScrubbing && ply !== state.currentPly) goToPly(ply, false);
  if (ply !== chartHoverPly) {
    chartHoverPly = ply;
    showChartHover(ply);
  }
});

for (const type of ["pointerup", "pointercancel"]) {
  dom.evalGraphSvg.addEventListener(type, () => { chartScrubbing = false; });
}
dom.evalGraphSvg.addEventListener("pointerleave", () => {
  if (!chartScrubbing) hideChartHover();
});

dom.chartTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-chart]");
  if (!button || button.dataset.chart === state.chartMode) return;
  state.chartMode = button.dataset.chart;
  hideChartHover();
  renderEvalGraph();
});

// Redraw at the new pixel size when the panel resizes.
new ResizeObserver(() => renderEvalGraph()).observe(dom.evalGraphWrap);

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

  if (judgement.verdict === "unknown") {
    dom.drillPromptText.className = "drill-prompt";
    dom.drillPromptText.textContent = `Couldn't check ${moveObj.san} with Stockfish. Try another move.`;
    setTimeout(() => {
      if (stillCurrent()) {
        showPosition(beforePos.fen, true);
        state.drillChecking = false;
      }
    }, 420);
    return;
  }

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
      showPosition(resetFen, true);
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
    showPosition(bestFen, true);
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
    // A deeper check may have regraded the move while the provider answered.
    if (state.analysisRunId === analysisRunId && state.aiSettings === settings && state.moveReviews[ply] === review) {
      state.coachCache.set(ply, content);
    }
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
  dom.reportProblemLink.href = reportUrl();
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
  state.humanForecastTried.clear();
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
  renderShapeLayer();
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
    if (!dom.shortcutsBackdrop.classList.contains("hidden")) {
      closeShortcuts();
    } else if (!dom.settingsDrawer.classList.contains("hidden")) {
      closeSettingsDrawer();
    } else if (!dom.pgnModalBackdrop.classList.contains("hidden")) {
      closePgnModal();
    } else if (state.exploring) {
      exitVariation();
    }
    return;
  }

  // Browser shortcuts such as Cmd+F are not ChessBot's.
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === "?") {
    ev.preventDefault();
    openShortcuts();
    return;
  }
  if (!dom.shortcutsBackdrop.classList.contains("hidden") || !dom.pgnModalBackdrop.classList.contains("hidden")) return;
  // Buttons and links keep Enter and Space for themselves.
  const control = tag === "BUTTON" || tag === "A" || tag === "SUMMARY";
  if (control && (ev.key === "Enter" || ev.key === " ")) return;
  if (ev.key === "x" || ev.key === "X") {
    setThreat(!state.showThreat);
    return;
  }

  if (state.drillActive) return;

  if (ev.key === "ArrowLeft" || ev.key === "k" || ev.key === "K") {
    ev.preventDefault();
    stepBack();
  } else if (ev.key === "ArrowRight" || ev.key === "Enter" || ev.key === "j" || ev.key === "J") {
    ev.preventDefault();
    stopAutoplay();
    dom.guidedNextBtn.click();
  } else if (ev.key === "ArrowUp" || ev.key === "Home") {
    ev.preventDefault();
    stopAutoplay();
    goToPly(0, true);
  } else if (ev.key === "ArrowDown" || ev.key === "End") {
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

// ── Engine lines you can hover and click, as in Lichess's analysis board ─────────────────────────
// Each rendered line is registered by id; its move buttons carry the id and their index.
const lineRegistry = new Map();
let previewBoard = null;
let previewOrientation = null;
let previewButton = null;

/** Fill `container` with a line's moves. `basePly` is the game position the line starts from (null for a threat line). */
function renderLineMoves(container, id, basePly, steps, { previewOnly = false } = {}) {
  // A redrawn line never sends mouseout, so a preview of one of its old moves would stay up.
  if (previewButton && container.contains(previewButton)) hideLinePreview();
  lineRegistry.set(id, { basePly, steps, previewOnly });
  container.classList.toggle("is-preview-only", previewOnly);
  const frag = document.createDocumentFragment();
  steps.forEach((step, index) => {
    if (step.number) {
      const number = document.createElement("span");
      number.className = "line-num";
      number.textContent = step.number;
      frag.append(number);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "line-move";
    button.textContent = step.san;
    button.dataset.line = id;
    button.dataset.index = String(index);
    button.setAttribute("aria-label", previewOnly ? step.label : `${step.label}: show on the board`);
    frag.append(button);
  });
  container.replaceChildren(frag);
}

function lineStepFor(button) {
  const entry = lineRegistry.get(button.dataset.line);
  const index = Number(button.dataset.index);
  return entry?.steps[index] ? { entry, index, step: entry.steps[index] } : null;
}

function showLinePreview(button) {
  const found = lineStepFor(button);
  if (!found) return;
  const { step } = found;
  previewButton = button;
  dom.linePreview.classList.remove("hidden");
  const orientation = state.orientation === "b" ? COLOR.black : COLOR.white;
  if (!previewBoard) {
    previewBoard = createBoard(dom.linePreviewBoard, { orientation: state.orientation, position: step.fen, coordinates: false });
  } else {
    if (previewOrientation !== orientation) previewBoard.setOrientation(orientation, false);
    previewBoard.setPosition(step.fen, false);
  }
  previewOrientation = orientation;
  previewBoard.removeMarkers(MARKER_TYPE.square);
  previewBoard.addMarker(MARKER_TYPE.square, step.from);
  previewBoard.addMarker(MARKER_TYPE.square, step.to);
  dom.linePreviewLabel.textContent = step.label;

  // Above the move when there is room, otherwise below; always inside the window.
  const rect = button.getBoundingClientRect();
  const width = dom.linePreview.offsetWidth;
  const height = dom.linePreview.offsetHeight;
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.left + rect.width / 2 - width / 2));
  const top = rect.top - height - 8 >= 8 ? rect.top - height - 8 : Math.min(window.innerHeight - height - 8, rect.bottom + 8);
  dom.linePreview.style.left = `${left}px`;
  dom.linePreview.style.top = `${top}px`;
}

function hideLinePreview() {
  previewButton = null;
  dom.linePreview.classList.add("hidden");
}

function playLineMove(button) {
  const found = lineStepFor(button);
  hideLinePreview();
  if (!found || found.entry.previewOnly || state.drillActive || !state.positions.length) return;
  const { entry, index } = found;
  const uci = entry.steps.map((step) => step.uci);
  // A line starts from the position before a move; show that move, then the line from before it.
  if (state.currentPly !== entry.basePly + 1) goToPly(entry.basePly + 1, false);
  playVariationOnBoard(entry.basePly, [uci[index]], ARROW_BEST, uci.slice(0, index));
}

document.addEventListener("mouseover", (event) => {
  const button = event.target.closest?.(".line-move");
  if (button) showLinePreview(button);
});
document.addEventListener("mouseout", (event) => {
  const button = event.target.closest?.(".line-move");
  if (button && !button.contains(event.relatedTarget)) hideLinePreview();
});
document.addEventListener("focusin", (event) => {
  if (event.target.matches?.(".line-move")) showLinePreview(event.target);
});
document.addEventListener("focusout", (event) => {
  if (event.target.matches?.(".line-move")) hideLinePreview();
});
document.addEventListener("click", (event) => {
  const button = event.target.closest?.(".line-move");
  if (button) playLineMove(button);
});
document.addEventListener("scroll", hideLinePreview, true);

// ── Arrows and circles drawn with the right mouse button ──────────────────────────────────────────
const SHAPE_STROKE = { green: "#15781b", red: "#882020", blue: "#003088", yellow: "#e68f00", threat: "#e0524f" };
let drawing = null;

const shapeKey = (fen) => (fen ? fen.split(" ").slice(0, 2).join(" ") : "");

function boardSquareAt(event) {
  const rect = dom.boardEl.getBoundingClientRect();
  return squareAt((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height, state.orientation);
}

function shapeElement(shape, { pending = false, threat = null } = {}) {
  const color = threat ? "threat" : shape.color;
  const classes = ["shape", shape.to ? "shape-arrow" : "shape-circle"];
  if (pending) classes.push("shape-pending");
  if (threat) classes.push("shape-threat", ...(threat.serious ? [] : ["is-minor"]));
  if (!shape.to) {
    const { x, y } = squareCenter(shape.from, state.orientation);
    return createSvgEl("circle", { cx: x, cy: y, r: 0.46, stroke: SHAPE_STROKE[color], class: classes.join(" ") });
  }
  const line = arrowLine(shape.from, shape.to, state.orientation, 0.5);
  return createSvgEl("line", {
    ...line, stroke: SHAPE_STROKE[color], "marker-end": `url(#shape-head-${color})`, class: classes.join(" "),
  });
}

function renderShapeLayer() {
  const layer = dom.shapeLayer;
  if (!layer) return;
  const key = shapeKey(state.shownFen);
  const shapes = [...(state.shapes.get(key) ?? [])];
  const children = [];
  const threat = state.showThreat && threatView.key === key ? threatView.arrow : null;
  if (shapes.length || drawing?.current || threat) {
    const defs = createSvgEl("defs");
    for (const [color, stroke] of Object.entries(SHAPE_STROKE)) {
      const marker = createSvgEl("marker", {
        id: `shape-head-${color}`, viewBox: "0 0 10 10", refX: 0, refY: 5,
        markerWidth: 4, markerHeight: 4, orient: "auto", markerUnits: "strokeWidth",
      });
      marker.append(createSvgEl("path", { d: "M0,0 L10,5 L0,10 Z", fill: stroke }));
      defs.append(marker);
    }
    children.push(defs);
  }
  if (threat) children.push(shapeElement(threat, { threat }));
  for (const shape of shapes) children.push(shapeElement(shape));
  if (drawing?.current) children.push(shapeElement(makeShape(drawing.from, drawing.current, drawing.color), { pending: true }));
  layer.replaceChildren(...children);
}

dom.boardThemeWrap.addEventListener("mousedown", (event) => {
  if (!state.shownFen) return;
  if (event.button === 0) {
    // A left click clears the drawings on this position, as on Lichess.
    if (state.shapes.delete(shapeKey(state.shownFen))) renderShapeLayer();
    return;
  }
  if (event.button !== 2) return;
  const square = boardSquareAt(event);
  if (!square) return;
  event.preventDefault();
  drawing = { from: square, current: square, color: shapeColor(event) };
  renderShapeLayer();
});
window.addEventListener("mousemove", (event) => {
  if (!drawing) return;
  const square = boardSquareAt(event) ?? drawing.current;
  if (square !== drawing.current) {
    drawing.current = square;
    renderShapeLayer();
  }
});
window.addEventListener("mouseup", (event) => {
  if (!drawing || event.button !== 2) return;
  const { from, color } = drawing;
  const to = boardSquareAt(event);
  drawing = null;
  if (to && state.shownFen) {
    const key = shapeKey(state.shownFen);
    const shapes = toggleShape(state.shapes.get(key) ?? [], makeShape(from, to, color));
    if (shapes.length) state.shapes.set(key, shapes);
    else state.shapes.delete(key);
  }
  renderShapeLayer();
});
dom.boardThemeWrap.addEventListener("contextmenu", (event) => event.preventDefault());

// ── Show threat (X): what the side that just moved would play if it could move again ────────────
const THREAT_DEPTH = 14;
const threatView = { runId: 0, key: null, arrow: null };

/** Search on the review pool while a review runs (ahead of its queue), otherwise on the main engine. */
function interactiveSearch(task) {
  if (enginePool) return enginePool.run(task, { priority: true });
  if (!engine) return Promise.reject(new Error("Stockfish has not started"));
  return task(engine);
}

/** The engine's evaluation of a position the page already searched, if any. */
function knownEval(fen) {
  if (state.positions[state.currentPly]?.fen === fen && state.evals[state.currentPly]) return state.evals[state.currentPly].eval;
  if (state.variationEval?.fen === fen) return state.variationEval.eval;
  return null;
}

function setThreat(enabled) {
  state.showThreat = enabled;
  dom.threatBtn.setAttribute("aria-pressed", String(enabled));
  dom.threatBtn.title = enabled ? "Hide threat (X)" : "Show threat (X)";
  refreshThreat();
}

async function refreshThreat() {
  const runId = ++threatView.runId;
  const fen = state.shownFen;
  threatView.key = shapeKey(fen);
  threatView.arrow = null;
  dom.threatBanner.classList.toggle("hidden", !state.showThreat || !fen);
  renderShapeLayer();
  if (!state.showThreat || !fen) return;

  const passed = threatFen(fen);
  const attacker = fen.split(" ")[1] === "w" ? "Black" : "White";
  dom.threatBanner.classList.add("is-minor");
  dom.threatEval.textContent = "";
  dom.threatLine.replaceChildren();
  if (!passed) {
    const inCheck = new Chess(fen).inCheck();
    dom.threatText.textContent = inCheck ? `${attacker} is already giving check.` : "The game is over in this position.";
    return;
  }
  dom.threatText.textContent = `Checking what ${attacker} threatens…`;
  const current = knownEval(fen);
  let result;
  try {
    result = await interactiveSearch(async (searchEngine) => {
      if (runId !== threatView.runId) return null;
      const threat = await searchEngine.analyzePosition(passed, THREAT_DEPTH, { multiPv: 1 });
      // Judging the threat needs the real position's evaluation too.
      const real = current ?? (runId === threatView.runId ? (await searchEngine.analyzePosition(fen, THREAT_DEPTH, { multiPv: 1 })).eval : null);
      return { threat, real };
    });
  } catch {
    if (runId === threatView.runId) dom.threatText.textContent = "Stockfish isn't ready yet. Try again in a moment.";
    return;
  }
  if (runId !== threatView.runId || !result) return;
  const { threat, real } = result;
  const steps = lineSteps(passed, threat.pv, 6);
  const verdict = describeThreat({
    attacker: passed.split(" ")[1], steps, threatEval: threat.eval, currentEval: real,
    // The six moves shown: a longer line picks up later trades that have nothing to do with the threat.
    tactic: findTactic(passed, threat.pv), gain: captureGain(passed, steps),
  });
  dom.threatText.textContent = verdict.headline;
  dom.threatBanner.classList.toggle("is-minor", !verdict.serious);
  dom.threatEval.textContent = steps.length ? formatEval(threat.eval) : "";
  dom.threatEval.title = "Stockfish's evaluation if the threat could be played";
  renderLineMoves(dom.threatLine, "threat", null, steps, { previewOnly: true });
  if (steps[0]) threatView.arrow = { from: steps[0].from, to: steps[0].to, serious: verdict.serious };
  renderShapeLayer();
}

dom.threatBtn.addEventListener("click", () => setThreat(!state.showThreat));

// ── Stepping: wheel on the board, and stepping back inside a variation ───────────────────────────
function stepBackInVariation() {
  stopBestLineAnimation();
  if (state.variationUci.length <= 1) {
    exitVariation();
    return;
  }
  state.variationUci.pop();
  state.variationMoves.pop();
  state.boardEpoch++;
  state.variationEvalRunId++;
  const sim = replayVariation(state.positions[state.variationBasePly], state.variationUci);
  board.removeArrows();
  showPosition(sim.fen(), true);
  updateCapturedPieces(sim.fen());
  renderVariationBanner();
  evaluateVariationPosition();
}

function stepBack() {
  stopAutoplay();
  if (state.exploring) stepBackInVariation();
  else goToPly(state.currentPly - 1, true, true);
}

// One move per wheel notch. Trackpads send many small pixel deltas, so those add up to a step.
const WHEEL_STEP = 50;
let wheelTotal = 0;
dom.boardThemeWrap.addEventListener("wheel", (event) => {
  if (!state.positions.length || state.drillActive) return;
  event.preventDefault();
  wheelTotal += event.deltaMode === 0 ? event.deltaY : Math.sign(event.deltaY) * WHEEL_STEP;
  if (Math.abs(wheelTotal) < WHEEL_STEP) return;
  const forward = wheelTotal > 0;
  wheelTotal = 0;
  if (forward) {
    if (state.exploring) return;
    stopAutoplay();
    goToPly(state.currentPly + 1, true, true);
  } else {
    stepBack();
  }
}, { passive: false });

// ── Shortcut sheet (?) ────────────────────────────────────────────────────────────────────────────
function openShortcuts() {
  dom.shortcutsBackdrop.classList.remove("hidden");
  dom.closeShortcutsBtn.focus();
}

function closeShortcuts() {
  dom.shortcutsBackdrop.classList.add("hidden");
}

dom.shortcutsBtn.addEventListener("click", openShortcuts);
dom.closeShortcutsBtn.addEventListener("click", closeShortcuts);
dom.shortcutsBackdrop.addEventListener("click", (event) => {
  if (event.target === dom.shortcutsBackdrop) closeShortcuts();
});

// ── Annotated PGN export ──────────────────────────────────────────────────────────────────────────
function buildAnnotatedPgn() {
  const moves = [];
  for (let ply = 1; ply < state.positions.length; ply++) {
    const position = state.positions[ply];
    const before = state.positions[ply - 1];
    const review = state.moveReviews[ply];
    const grade = review && !review.book ? review.classification.key : null;
    // Each [%eval] is the position's own evaluation, as on the chart, so a comment's change runs from
    // the previous move's [%eval] to this one's.
    const after = state.evals[ply]?.eval ?? review?.playedEval ?? null;
    const comment = grade ? mistakeComment(grade, review.bestSan) : "";
    moves.push({
      san: position.move.san,
      color: position.move.color,
      number: position.move.number,
      nag: grade ? GRADE_NAG[grade] : undefined,
      eval: after,
      clock: position.practicalContext?.[position.move.color === "w" ? "whiteSeconds" : "blackSeconds"],
      comment: comment ? `${swingText(state.evals[ply - 1]?.eval, after)} ${comment}` : "",
      variation: comment ? lineSteps(before.fen, state.evals[ply - 1]?.pv, 8) : null,
    });
  }
  const version = extension?.runtime?.getManifest?.().version;
  return annotatedPgn({
    headers: state.gameHeaders ?? {}, moves,
    annotator: `ChessBot${version ? ` ${version}` : ""} (Stockfish 19, depth ${dom.depthSelect.value})`,
  });
}

let exportStatusTimer = null;
function showExportStatus(text) {
  dom.exportStatus.textContent = text;
  clearTimeout(exportStatusTimer);
  exportStatusTimer = setTimeout(() => { dom.exportStatus.textContent = ""; }, 2500);
}

function updateExportButtons() {
  const ready = state.positions.length > 1 && !state.isAnalyzing;
  for (const button of [dom.copyPgnBtn, dom.downloadPgnBtn]) {
    button.disabled = !ready;
  }
  dom.copyPgnBtn.title = ready ? "Copy the game as PGN with evaluations, grades, and Stockfish's better lines"
    : "Available when the review finishes";
}

dom.copyPgnBtn.addEventListener("click", async () => {
  const pgn = buildAnnotatedPgn();
  try {
    await navigator.clipboard.writeText(pgn);
    showExportStatus("Copied");
  } catch {
    // Some pages can't use the clipboard API; fall back to a selected text area.
    const area = document.createElement("textarea");
    area.value = pgn;
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    showExportStatus(copied ? "Copied" : "Copy failed");
  }
});

dom.downloadPgnBtn.addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([buildAnnotatedPgn()], { type: "application/x-chess-pgn" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = pgnFileName(state.gameHeaders ?? {});
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showExportStatus("Saved");
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
          accuracies: record.chesscomAccuracy ?? null,
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
