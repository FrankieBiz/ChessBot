// The Practice page: today's spaced review of saved mistakes, theme practice, and the weakness report.
import { COLOR, INPUT_EVENT_TYPE } from "./vendor/cm-chessboard/src/Chessboard.js";
import { MARKER_TYPE } from "./vendor/cm-chessboard/src/extensions/markers/Markers.js";
import { createBoard, requestPromotion } from "./board-setup.js";
import { compareRootMoves } from "./analysis.js";
import { StockfishEngine } from "./engine.js";
import { drillHint, drillPrompt, drillRejection, drillSuccess, judgeDrillAttempt } from "./drills.js";
import { moveToUci, parseUciMove, replayGame } from "./variation.js";
import {
  DEFAULT_DAILY_CAP, OUTCOMES, advanceQueue, applyResult, buildSession, currentId, dueCount, isRepeat,
  localDate, puzzlePosition, puzzleReview, startQueue,
} from "./deck.js";
import { EASY_FIND_CHANCE, PHASES, reportFilter, weaknessReport } from "./weakness.js";
import { loadTraining, savePuzzle, saveSettings, webStorageArea } from "./training-store.js";
import { STOCKFISH_WORKER_PATH } from "./vendor/stockfish/engine-config.js";

const extension = globalThis.browser ?? globalThis.chrome;
const area = extension?.storage?.local ?? webStorageArea(globalThis.localStorage);
const ARROW_BEST = { class: "arrow-best" };
const MAX_DAILY_CAP = 200;
const PHASE_LABELS = { opening: "Opening", middlegame: "Middlegame", endgame: "Endgame" };
const BOARD_THEMES = ["emerald", "slate", "walnut"];

// `?today=YYYY-MM-DD` runs a later day's session, for checking the schedule in a browser.
const requestedToday = new URLSearchParams(location.search).get("today");
const today = /^\d{4}-\d{2}-\d{2}$/.test(requestedToday ?? "") ? requestedToday : localDate();

const byId = (id) => document.getElementById(id);
const dom = {
  subtitle: byId("practiceSubtitle"),
  notice: byId("practiceNotice"),
  capInput: byId("dailyCapInput"),
  themeWrap: byId("boardThemeWrap"),
  board: byId("board"),
  tabSession: byId("tabSessionBtn"),
  tabReport: byId("tabReportBtn"),
  dueCount: byId("dueCount"),
  panelSession: byId("panelSession"),
  panelReport: byId("panelReport"),
  sessionBadge: byId("sessionBadge"),
  sessionCounter: byId("sessionCounter"),
  puzzleContext: byId("puzzleContext"),
  puzzlePrompt: byId("puzzlePrompt"),
  controls: byId("puzzleControls"),
  hintBtn: byId("hintBtn"),
  revealBtn: byId("revealBtn"),
  showLineBtn: byId("showLineBtn"),
  openGameLink: byId("openGameLink"),
  nextBtn: byId("nextBtn"),
  done: byId("sessionDone"),
  doneTitle: byId("sessionDoneTitle"),
  doneText: byId("sessionDoneText"),
  backToDailyBtn: byId("backToDailyBtn"),
  reportBody: byId("reportBody"),
};

const state = {
  data: { writable: true, games: new Map(), puzzles: new Map(), settings: {} },
  queue: startQueue([]),
  mode: "daily",
  puzzle: null,
  game: null,
  outcome: null,
  finished: false,
  checking: false,
  epoch: 0,
  solvedFirstTry: 0,
  skipped: 0,
  unverifiedAttempt: false,
  unloadable: new Set(),
  lineTimer: null,
};

const board = createBoard(dom.board);
const userColor = (puzzle) => (puzzle.color === "b" ? COLOR.black : COLOR.white);
let engine = null;
let engineFailed = false;

function showNotice(text) {
  dom.notice.textContent = text;
  dom.notice.classList.remove("hidden");
}

function setPrompt(text, tone = "") {
  dom.puzzlePrompt.className = tone ? `drill-prompt ${tone}` : "drill-prompt";
  dom.puzzlePrompt.textContent = text;
}

const allPuzzles = () => [...state.data.puzzles.values()];
const playable = () => allPuzzles().filter((p) => !state.unloadable.has(p.id));
const dailyCap = () => state.data.settings.dailyCap ?? DEFAULT_DAILY_CAP;
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Start Stockfish once and reuse it. Resolves to null when it can't load. */
async function readyEngine() {
  if (engineFailed) return null;
  try {
    engine ??= new StockfishEngine(STOCKFISH_WORKER_PATH);
    await engine.init();
    return engine;
  } catch {
    engineFailed = true;
    return null;
  }
}

function updateCounts() {
  const puzzles = allPuzzles();
  const due = dueCount(puzzles, today);
  const mastered = puzzles.filter((puzzle) => puzzle.schedule.mastered).length;
  dom.dueCount.textContent = String(due);
  dom.subtitle.textContent = `${due} due today · ${plural(puzzles.length, "saved puzzle")} · ${mastered} mastered`;
}

function switchTab(name) {
  const report = name === "report";
  dom.tabSession.classList.toggle("active", !report);
  dom.tabReport.classList.toggle("active", report);
  dom.tabSession.setAttribute("aria-selected", String(!report));
  dom.tabReport.setAttribute("aria-selected", String(report));
  dom.panelSession.classList.toggle("hidden", report);
  dom.panelReport.classList.toggle("hidden", !report);
}

function stopLine() {
  clearInterval(state.lineTimer);
  state.lineTimer = null;
}

function startSession({ filter = null, label = "" } = {}) {
  stopLine();
  state.mode = filter ? "theme" : "daily";
  dom.sessionBadge.textContent = filter ? `PRACTICE · ${label.toUpperCase()}` : "DAILY REVIEW";
  state.queue = startQueue(buildSession(playable(), { today, cap: dailyCap(), filter }));
  state.solvedFirstTry = 0;
  state.skipped = 0;
  switchTab("session");
  loadCurrentPuzzle();
}

function loadCurrentPuzzle() {
  stopLine();
  state.epoch++;
  const id = currentId(state.queue);
  if (!id) {
    finishSession();
    return;
  }
  const puzzle = state.data.puzzles.get(id);
  let game;
  try {
    game = replayGame(puzzle.initialFen, puzzle.history);
    if (game.fen() !== puzzle.fen) throw new Error("The saved moves don't reach the saved position.");
  } catch {
    state.unloadable.add(id);
    state.skipped++;
    state.queue = advanceQueue(state.queue, OUTCOMES.unverified);
    loadCurrentPuzzle();
    return;
  }
  Object.assign(state, { puzzle, game, outcome: null, finished: false, checking: false, unverifiedAttempt: false });

  board.setOrientation(userColor(puzzle), false);
  board.setPosition(puzzle.fen, false);
  board.removeArrows();
  board.removeMarkers(MARKER_TYPE.square);
  board.removeMarkers(MARKER_TYPE.circle);
  const last = parseUciMove(puzzle.history.at(-1));
  if (last) {
    board.addMarker(MARKER_TYPE.square, last.from);
    board.addMarker(MARKER_TYPE.square, last.to);
  }
  board.disableMoveInput();
  board.enableMoveInput(handleBoardInput, userColor(puzzle));

  const { firstPass, index } = state.queue;
  dom.sessionCounter.textContent = isRepeat(state.queue) ? "One more try" : `Puzzle ${index + 1} of ${firstPass}`;
  const moveNumber = puzzle.fen.split(" ")[5];
  dom.puzzleContext.textContent = `Move ${moveNumber} vs ${puzzle.opponent || "your opponent"} · ${puzzle.gameDate}`;
  setPrompt(drillPrompt({ playedSan: puzzle.gameMove.san, review: puzzleReview(puzzle) }));
  dom.controls.classList.remove("hidden");
  dom.hintBtn.classList.remove("hidden");
  dom.revealBtn.classList.remove("hidden");
  for (const element of [dom.showLineBtn, dom.openGameLink, dom.nextBtn, dom.done]) element.classList.add("hidden");
  readyEngine();
}

function handleBoardInput(event) {
  if (event.type === INPUT_EVENT_TYPE.moveInputStarted) {
    if (!state.puzzle || state.finished || state.checking) return false;
    const moves = state.game.moves({ square: event.squareFrom, verbose: true });
    board.removeMarkers(MARKER_TYPE.dot);
    for (const move of moves) board.addMarker(MARKER_TYPE.dot, move.to);
    return moves.length > 0;
  }
  if (event.type === INPUT_EVENT_TYPE.validateMoveInput) {
    board.removeMarkers(MARKER_TYPE.dot);
    const { squareFrom: from, squareTo: to } = event;
    const epoch = state.epoch;
    const promoting = requestPromotion(board, state.game, from, to, (chosen) => {
      if (!chosen || !commitMove(chosen)) board.setPosition(state.puzzle.fen, true);
    }, () => epoch === state.epoch);
    return promoting || commitMove({ from, to });
  }
  if (event.type === INPUT_EVENT_TYPE.moveInputCanceled) board.removeMarkers(MARKER_TYPE.dot);
  return true;
}

function commitMove(move) {
  let played;
  try {
    played = state.game.move(move);
  } catch {
    return false;
  }
  if (!played) return false;
  const deliversMate = state.game.isCheckmate();
  board.setPosition(state.game.fen(), true);
  state.game.undo();
  state.checking = true;
  const epoch = state.epoch;
  setTimeout(() => judgeAttempt(played.san, moveToUci(played), deliversMate, epoch), 40);
  return true;
}

async function judgeAttempt(san, uci, deliversMate, epoch) {
  const puzzle = state.puzzle;
  const review = puzzleReview(puzzle);
  const attempt = { attemptUci: uci, gameUci: puzzle.gameMove.uci, review, color: puzzle.color, deliversMate };
  let judgement = judgeDrillAttempt(attempt);
  if (judgement.verdict === "unknown") {
    // Moves in the saved lines are compared without a search, so they never wait for Stockfish.
    const stored = puzzle.root.lines.some((line) => line.pv[0] === uci);
    if (!stored) setPrompt(`Checking ${san} with Stockfish…`);
    try {
      const comparison = await compareRootMoves(stored ? null : await readyEngine(), puzzlePosition(puzzle), uci, puzzle.depth, puzzle.root);
      judgement = judgeDrillAttempt({ ...attempt, comparison });
    } catch {
      // Still unknown: Stockfish is unavailable or the comparison didn't finish.
    }
  }
  if (epoch !== state.epoch) return;
  state.checking = false;

  if (judgement.verdict === "best" || judgement.verdict === "alternative") {
    recordOutcome(OUTCOMES.pass);
    finishPuzzle(drillSuccess({ attemptSan: san, judgement, review, deliversMate }), "success");
    return;
  }
  if (judgement.verdict === "unknown") {
    state.unverifiedAttempt = true;
    setPrompt(`Couldn't check ${san} with Stockfish. Try another move, or use Show Answer.`, "error");
  } else {
    recordOutcome(OUTCOMES.fail);
    setPrompt(drillRejection({ attemptSan: san, judgement, review }), "error");
  }
  setTimeout(() => {
    if (epoch === state.epoch && !state.finished) board.setPosition(puzzle.fen, true);
  }, 420);
}

/** Record the first verified result for this puzzle in this session. Repeats never change the schedule. */
function recordOutcome(outcome) {
  if (state.outcome) return;
  state.outcome = outcome;
  if (isRepeat(state.queue)) return;
  if (outcome === OUTCOMES.pass) state.solvedFirstTry++;
  const updated = applyResult(state.puzzle, outcome, today);
  state.puzzle = updated;
  state.data.puzzles.set(updated.id, updated);
  updateCounts();
  if (state.data.writable) {
    savePuzzle(area, updated).catch(() => showNotice("Couldn't save your progress on this puzzle."));
  }
}

function finishPuzzle(message, tone) {
  const { puzzle } = state;
  state.finished = true;
  board.disableMoveInput();
  setPrompt(message, tone);
  const best = parseUciMove(puzzle.best.uci);
  if (best) board.addArrow(ARROW_BEST, best.from, best.to);
  dom.hintBtn.classList.add("hidden");
  dom.revealBtn.classList.add("hidden");
  dom.showLineBtn.classList.toggle("hidden", puzzle.best.pv.length < 2);
  const hasGame = state.data.games.has(puzzle.gameKey);
  dom.openGameLink.classList.toggle("hidden", !hasGame);
  if (hasGame) dom.openGameLink.href = `./review.html?game=${encodeURIComponent(puzzle.gameKey)}&ply=${puzzle.ply}`;
  dom.nextBtn.classList.remove("hidden");
}

function finishSession() {
  state.puzzle = null;
  board.disableMoveInput();
  board.removeArrows();
  board.removeMarkers(MARKER_TYPE.square);
  board.removeMarkers(MARKER_TYPE.circle);
  dom.controls.classList.add("hidden");
  dom.puzzlePrompt.classList.add("hidden");
  dom.puzzleContext.textContent = "";
  dom.sessionCounter.textContent = "";
  dom.done.classList.remove("hidden");

  const puzzles = allPuzzles();
  const due = dueCount(playable(), today);
  const upcoming = puzzles.map((p) => p.schedule.due).filter((date) => date && date > today).sort()[0];
  const more = state.mode === "daily" && due > 0 ? buildSession(playable(), { today, cap: dailyCap() }).length : 0;
  dom.backToDailyBtn.textContent = more > 0 ? `Keep going (${more})` : "Back to today's puzzles";
  dom.backToDailyBtn.classList.toggle("hidden", state.mode === "daily" && more === 0);
  const later = upcoming ? ` Your next puzzles are due on ${upcoming}.` : "";
  const attempted = state.queue.firstPass - state.skipped;
  let title;
  let text;
  if (!puzzles.length) {
    title = "No puzzles yet";
    text = "Review a game, and your Mistakes, Misses, and Blunders come back here as puzzles the next day.";
  } else if (state.skipped > 0 && attempted === 0) {
    title = "Couldn't load these puzzles";
    text = "Their saved positions couldn't be rebuilt. Reviewing the game again rebuilds them.";
  } else if (attempted > 0) {
    title = state.mode === "daily" ? "Done for today" : "Practice complete";
    text = `You solved ${state.solvedFirstTry} of ${attempted} on the first try.`;
    if (state.mode === "daily") {
      if (more > 0) text += ` ${plural(more, "more puzzle")} ${more === 1 ? "is" : "are"} due.`;
      else if (due > 0) text += ` ${plural(due, "more puzzle")} ${due === 1 ? "is" : "are"} due. Raise the daily limit to keep going.`;
      else text += later;
    }
  } else if (state.mode === "theme") {
    title = "Nothing to practice";
    text = "Every puzzle of this kind is mastered.";
  } else if (due > 0) {
    title = "Daily limit reached";
    text = `${plural(due, "more puzzle")} ${due === 1 ? "is" : "are"} due. Raise the daily limit to keep going.`;
  } else {
    title = "Nothing due today";
    text = `You're up to date.${later}`;
  }
  dom.doneTitle.textContent = title;
  dom.doneText.textContent = text;
  if (state.skipped) {
    showNotice(`${plural(state.skipped, "saved puzzle")} couldn't be rebuilt and ${state.skipped === 1 ? "was" : "were"} skipped.`);
  }
  updateCounts();
}

dom.hintBtn.addEventListener("click", () => {
  if (!state.puzzle || state.finished || state.checking) return;
  recordOutcome(OUTCOMES.fail);
  const best = parseUciMove(state.puzzle.best.uci);
  if (!best) return;
  board.removeMarkers(MARKER_TYPE.circle);
  board.addMarker(MARKER_TYPE.circle, best.from);
  setPrompt(drillHint({ review: puzzleReview(state.puzzle), fromSquare: best.from }));
});

dom.revealBtn.addEventListener("click", () => {
  if (!state.puzzle || state.finished) return;
  recordOutcome(state.unverifiedAttempt && !state.outcome ? OUTCOMES.unverified : OUTCOMES.fail);
  state.epoch++;
  state.checking = false;
  const best = parseUciMove(state.puzzle.best.uci);
  if (best) {
    try {
      state.game.move(best);
      board.setPosition(state.game.fen(), true);
      state.game.undo();
    } catch {
      // Keep the puzzle position.
    }
  }
  finishPuzzle(`Best move was ${state.puzzle.best.san}.`, "");
});

dom.showLineBtn.addEventListener("click", () => {
  if (!state.puzzle) return;
  stopLine();
  const game = replayGame(state.puzzle.initialFen, state.puzzle.history);
  const line = state.puzzle.best.pv.map(parseUciMove).filter(Boolean);
  board.removeArrows();
  board.setPosition(game.fen(), false);
  let index = 0;
  state.lineTimer = setInterval(() => {
    if (index >= line.length) {
      stopLine();
      return;
    }
    try {
      game.move(line[index++]);
    } catch {
      stopLine();
      return;
    }
    board.setPosition(game.fen(), true);
  }, 650);
});

dom.nextBtn.addEventListener("click", () => {
  state.queue = advanceQueue(state.queue, state.outcome ?? OUTCOMES.unverified);
  loadCurrentPuzzle();
});

dom.backToDailyBtn.addEventListener("click", () => startSession());
dom.tabSession.addEventListener("click", () => switchTab("session"));
dom.tabReport.addEventListener("click", () => {
  renderReport();
  switchTab("report");
});

dom.capInput.addEventListener("change", () => {
  const raw = dom.capInput.value.trim();
  const value = Math.round(Number(raw));
  const cap = raw !== "" && Number.isFinite(value) && value >= 1 ? Math.min(MAX_DAILY_CAP, value) : dailyCap();
  dom.capInput.value = String(cap);
  state.data.settings = { ...state.data.settings, dailyCap: cap };
  if (state.data.writable) saveSettings(area, state.data.settings).catch(() => showNotice("Couldn't save the daily limit."));
  if (state.mode === "daily" && !state.puzzle) startSession();
});

function element(tag, className = "", text = undefined) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const percent = (value) => (Number.isFinite(value) ? `${Math.round(value)}%` : "—");
const rate = (value) => (Number.isFinite(value) ? value.toFixed(1) : "—");

function practiceButton(filter, label) {
  const count = allPuzzles().filter((p) => !p.schedule.mastered && filter(p)).length;
  const button = element("button", "btn btn-secondary btn-sm", count ? `Practice these (${count})` : "No open puzzles");
  button.type = "button";
  button.disabled = count === 0;
  button.addEventListener("click", () => startSession({ filter, label }));
  return button;
}

function reportRow(title, meta, action, focus = false) {
  const row = element("div", focus ? "report-row focus" : "report-row");
  const text = element("div", "report-row-text");
  const heading = element("div", "report-row-title", title);
  if (focus) heading.append(element("span", "focus-badge", "Your main focus"));
  text.append(heading, element("div", "report-row-meta", meta));
  row.append(text);
  if (action) row.append(action);
  return row;
}

function reportSection(title, ...children) {
  const section = element("section", "report-section");
  const header = element("div", "section-header");
  header.append(element("h3", "", title));
  section.append(header, ...children);
  return section;
}

function renderReport() {
  try {
    const report = weaknessReport([...state.data.games.values()]);
    if (!report.ready) {
      dom.reportBody.replaceChildren(element("p", "report-empty",
        `The report appears after ${report.needed} reviewed games. You've reviewed ${report.games} so far.`));
      return;
    }
    const parts = [element("p", "report-summary", `Based on ${report.games} games and ${report.moves} of your moves.`)];

    const { common, lessCommon, focus } = report.themes;
    const themeRows = common.map((row) => reportRow(row.label,
      `${row.count} times in ${plural(row.games, "game")} · ${rate(row.per100)} per 100 moves`,
      practiceButton(reportFilter("theme", row.id), row.label), row.id === focus));
    parts.push(reportSection("Mistakes by type", ...(themeRows.length
      ? themeRows
      : [element("p", "report-empty", "No mistake type has come up 3 or more times yet.")])));
    if (lessCommon.length) {
      parts.push(reportSection("Less common", ...lessCommon.map((row) => reportRow(row.label,
        plural(row.count, "time"), practiceButton(reportFilter("theme", row.id), row.label)))));
    }

    const { easy, rated, unrated } = report.easy;
    const easyMeta = rated
      ? `${easy} of ${rated} mistakes came where at least ${EASY_FIND_CHANCE}% of players find a sound move.` +
        (unrated ? ` ${unrated} more had no estimate.` : "")
      : "No estimate is available for these mistakes yet.";
    parts.push(reportSection("Easy or hard",
      reportRow("Mistakes in easy positions", easyMeta, practiceButton(reportFilter("easy"), "Easy positions"))));

    parts.push(reportSection("Game phase", ...PHASES.map((phase) => {
      const { games, accuracy } = report.phases[phase];
      const meta = games
        ? `${percent(accuracy)} vs ${percent(report.overall)} overall · ${plural(games, "game")} reached it`
        : "Not reached yet";
      return reportRow(PHASE_LABELS[phase], meta, practiceButton(reportFilter("phase", phase), PHASE_LABELS[phase]));
    })));

    const { clock } = report;
    parts.push(reportSection("Low on time", clock
      ? reportRow("Mistakes per 100 moves",
        `${rate(clock.lowRate)} when low on time vs ${rate(clock.otherRate)} otherwise · ` +
          `${plural(clock.games, "game")} with clocks, ${plural(clock.lowMoves, "low-clock move")}`,
        practiceButton(reportFilter("lowClock"), "Low on time"))
      : element("p", "report-empty", "None of these games recorded clock times.")));

    const { conversion } = report;
    parts.push(reportSection("Converting wins", conversion.winning
      ? reportRow(`${conversion.unconverted} of ${plural(conversion.winning, "game")}`, "You were winning but drew or lost.",
        practiceButton(reportFilter("unconverted", conversion.gameKeys), "Unconverted games"))
      : element("p", "report-empty", "You haven't reached a winning position in these games yet.")));

    dom.reportBody.replaceChildren(...parts);
  } catch {
    dom.reportBody.replaceChildren(element("p", "report-empty", "Couldn't build the report from your saved games."));
  }
}

async function applySavedBoardTheme() {
  try {
    const { boardTheme } = await area.get("boardTheme");
    if (BOARD_THEMES.includes(boardTheme)) {
      dom.themeWrap.classList.remove(...BOARD_THEMES.map((name) => `theme-${name}`));
      dom.themeWrap.classList.add(`theme-${boardTheme}`);
    }
  } catch {
    // Keep the default theme.
  }
}

async function init() {
  await applySavedBoardTheme();
  try {
    state.data = await loadTraining(area);
  } catch {
    showNotice("Couldn't load your saved puzzles.");
  }
  if (!state.data.writable) {
    showNotice("Your saved practice data comes from a newer version of ChessBot. You can practice, but progress won't be saved.");
  }
  dom.capInput.value = String(dailyCap());
  updateCounts();
  startSession();
  renderReport();
}

init();
