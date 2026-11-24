# Practice Deck and Weakness Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship ChessBot v3.5.0 with a spaced-repetition deck of the user's own mistakes and a cross-game weakness report on a new Practice page.

**Architecture:** Two pure modules hold the rules: `deck.js` for puzzles, the schedule, and sessions, and `weakness.js` for per-game summaries and the report. `training-store.js` is the only code that touches storage, with one key per record. `review.js` records each finished review. The new Practice page (`practice.html` + `practice.js`) runs sessions with the same drill rules and live Stockfish checks as the Mistakes tab. The board setup moves into a shared `board-setup.js` so both pages use one copy.

**Tech Stack:** Plain ES modules (no bundler), Chrome/Firefox MV3, chess.js 1.4.0, cm-chessboard 8.15.8, Stockfish.js 19 WASM, `node --test`.

**Spec:** [docs/superpowers/specs/2026-11-24-practice-deck-and-weakness-report-design.md](../specs/2026-11-24-practice-deck-and-weakness-report-design.md)

---

## Before you start

- **Branch:** work on `feat/practice-deck`, which already holds the spec.
- **Baseline:** `npm test` reports 54 passing tests on this branch before Task 1. Each task's expected count builds on that.
- **Tests:** `npm test` first runs `node scripts/build.mjs --test`, which copies chess.js into `vendor/`, then runs `node --test tests/*.test.js`. Helper files in `tests/fixtures/` are not picked up by that glob, which is intended.
- **Style:** match the surrounding code. Use ES modules, double quotes in source files, and single quotes in older test files that already use them. New test files use double quotes. Build DOM with `createElement` and `textContent`, never `innerHTML`, so the Firefox add-on linter stays clean.
- **Commits:** end every commit message with this trailer:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```
- **Sandbox:** write temporary files to `$TMPDIR`. Don't push or open a pull request until the user says to.

## Refinements to the spec

The code reading behind this plan led to five small refinements. Each one keeps the spec's intent.

1. **`best` stores UCI and SAN separately.** The puzzle keeps `best.pv` (UCI, at most 8 plies) so the board can play the line, and `best.lineSan` (the review's SAN text) for display. The spec's single `best.line` is split into these two.
2. **A re-review keeps the first `reviewedAt`.** The review page re-analyzes the last game every time it opens. Without this, opening the page would keep moving that game to the front of the report window.
3. **The daily cap counts puzzles already practiced today.** Without this, reopening the Practice page would start another full session the same day.
4. **The pages fall back to Web Storage outside the extension.** `webStorageArea` lets `review.html` and `practice.html` run from a local server for the browser check. The installed extension always uses `storage.local`.
5. **`drillSuccess` moves into `drills.js`.** Both pages show the same solved-drill messages from one function.
6. **Code review of Tasks 3–5 added a fix commit with six more tests (77 after Task 5).** `applyResult` now works out "early" itself, and early practice no longer counts toward the daily cap. `puzzlesFromDecisions` ignores other games' puzzles, and `isRepeat` is false for an empty queue. Later expected counts include these tests.
7. **Code review of Tasks 6–8 added two tests (97 after Task 8).** "Your main focus" is left out when the top two mistake types tie.
8. **Only the user's own games are recorded.** `detectPlayedColor` falls back to White when the username matches neither player, so Task 10 records a game only when the side is confirmed: chosen in Load PGN, reopened from the Practice page, or matched to the Chess.com username.

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `board-setup.js` | Create | `createBoard` and `requestPromotion`, shared by both pages |
| `deck.js` | Create | Pure: dates, puzzles from decisions, schedule, sessions, queue |
| `weakness.js` | Create | Pure: decision extraction, themes, game summary, report, filters |
| `training-store.js` | Create | Storage: keys, version check, pruning, game identity, Web Storage fallback |
| `practice.html`, `practice.css`, `practice.js` | Create | The Practice page |
| `drills.js` | Modify | Add `drillSuccess`, shared by both pages |
| `review.js` | Modify | Use `board-setup.js` and `drillSuccess`, record reviews, Practice button, `?game=&ply=` |
| `review.html`, `review.css` | Modify | Practice button, save notice, `a.btn` style |
| `scripts/build.mjs` | Modify | Package the new files |
| `tests/fixtures/training.js` | Create | Shared test builders |
| `tests/deck.test.js`, `tests/weakness.test.js`, `tests/training-store.test.js` | Create | Unit tests |
| `tests/drills.test.js` | Modify | `drillSuccess` test |
| `package.json`, `package-lock.json`, `browsers/*/manifest.json` | Modify | Version 3.5.0 |
| `README.md`, `docs/methodology.md`, `CHANGELOG.md`, `SECURITY.md` | Modify | Docs |

---

### Task 1: Extract the shared board setup

**Files:**
- Create: `board-setup.js`
- Modify: `review.js` (imports at the top, `initBoard`, the promotion branch of `handleBoardInput`, and the `variation.js` import)
- Modify: `scripts/build.mjs` (the `files` list)

There's no unit test here: cm-chessboard needs a DOM. Step 6 checks the result in the browser.

- [ ] **Step 1: Create `board-setup.js`**

```js
// The chessboard both extension pages use: pieces, arrows, markers, and the promotion picker.
import { Chessboard, COLOR, FEN } from "./vendor/cm-chessboard/src/Chessboard.js";
import { Arrows } from "./vendor/cm-chessboard/src/extensions/arrows/Arrows.js";
import { Markers } from "./vendor/cm-chessboard/src/extensions/markers/Markers.js";
import {
  PromotionDialog,
  PROMOTION_DIALOG_RESULT_TYPE,
} from "./vendor/cm-chessboard/src/extensions/promotion-dialog/PromotionDialog.js";
import { promotionChoices } from "./variation.js";

/** A board with ChessBot's pieces, arrows, markers, and promotion picker. */
export function createBoard(element, { orientation = "w", position = FEN.start } = {}) {
  return new Chessboard(element, {
    position,
    orientation: orientation === "b" ? COLOR.black : COLOR.white,
    assetsUrl: "./vendor/cm-chessboard/assets/",
    style: {
      cssClass: "default",
      showCoordinates: true,
      pieces: { file: "pieces/staunty.svg" },
      animationDuration: 180,
    },
    extensions: [{ class: Arrows }, { class: Markers }, { class: PromotionDialog }],
  });
}

/**
 * Open the piece picker when a drag is a promotion. `onChoice` receives the move, or null when the
 * picker is closed. It is not called when `isCurrent` reports that the board has moved on.
 * Returns false when the drag is not a promotion, so the caller can commit it directly.
 */
export function requestPromotion(board, game, from, to, onChoice, isCurrent = () => true) {
  if (!promotionChoices(game, from, to).length) return false;
  const color = game.turn() === "w" ? COLOR.white : COLOR.black;
  board.showPromotionDialog(to, color, (result) => {
    if (!isCurrent()) return;
    onChoice(result.type === PROMOTION_DIALOG_RESULT_TYPE.pieceSelected
      ? { from, to, promotion: result.piece.charAt(1) }
      : null);
  });
  return true;
}
```

- [ ] **Step 2: Switch the `review.js` imports**

Replace the block at the top of `review.js`:

```js
import {
  Chessboard,
  COLOR,
  FEN,
  INPUT_EVENT_TYPE,
} from "./vendor/cm-chessboard/src/Chessboard.js";
import { Arrows } from "./vendor/cm-chessboard/src/extensions/arrows/Arrows.js";
import {
  Markers,
  MARKER_TYPE,
} from "./vendor/cm-chessboard/src/extensions/markers/Markers.js";
import {
  PromotionDialog,
  PROMOTION_DIALOG_RESULT_TYPE,
} from "./vendor/cm-chessboard/src/extensions/promotion-dialog/PromotionDialog.js";
```

with:

```js
import { COLOR, INPUT_EVENT_TYPE } from "./vendor/cm-chessboard/src/Chessboard.js";
import { MARKER_TYPE } from "./vendor/cm-chessboard/src/extensions/markers/Markers.js";
import { createBoard, requestPromotion } from "./board-setup.js";
```

Then change the `variation.js` import line from:

```js
import { describeVariation, moveToUci, parseUciMove, promotionChoices, replayVariation } from "./variation.js";
```

to:

```js
import { describeVariation, moveToUci, parseUciMove, replayVariation } from "./variation.js";
```

- [ ] **Step 3: Use `createBoard` in `initBoard`**

Replace the whole `initBoard` function in `review.js` with:

```js
function initBoard(orientation = "w") {
  if (board) {
    board.destroy();
  }

  state.orientation = orientation;
  board = createBoard(dom.boardEl, { orientation });
  enableBoardInput();
}
```

- [ ] **Step 4: Use `requestPromotion` in `handleBoardInput`**

In the `validateMoveInput` branch of `handleBoardInput`, replace:

```js
    if (promotionChoices(activeChess, from, to).length) {
      // Let the player choose the piece. Underpromotion can be the only winning move.
      const epoch = state.boardEpoch;
      const color = activeChess.turn() === "w" ? COLOR.white : COLOR.black;
      board.showPromotionDialog(to, color, (result) => {
        if (epoch !== state.boardEpoch) return;
        const chosen = result.type === PROMOTION_DIALOG_RESULT_TYPE.pieceSelected
          ? { from, to, promotion: result.piece.charAt(1) } : null;
        if (!chosen || !commitBoardMove(activeChess, chosen)) board.setPosition(activeChess.fen(), true);
      });
      return true;
    }
    return commitBoardMove(activeChess, { from, to });
```

with:

```js
    // Let the player choose the piece. Underpromotion can be the only winning move.
    const epoch = state.boardEpoch;
    const promoting = requestPromotion(board, activeChess, from, to, (chosen) => {
      if (!chosen || !commitBoardMove(activeChess, chosen)) board.setPosition(activeChess.fen(), true);
    }, () => epoch === state.boardEpoch);
    return promoting || commitBoardMove(activeChess, { from, to });
```

Confirm nothing else uses the removed names:

Run: `grep -n "new Chessboard\|FEN\.\|PromotionDialog\|PROMOTION_DIALOG_RESULT_TYPE\|class: Arrows\|class: Markers\|promotionChoices" review.js`
Expected: no output.

- [ ] **Step 5: Package `board-setup.js`**

In `scripts/build.mjs`, change:

```js
  const files = ["analysis.js", "background.js", "calibration-data.js",
```

to:

```js
  const files = ["analysis.js", "background.js", "board-setup.js", "calibration-data.js",
```

(Only the start of the line changes. Keep the rest of the array as it is.)

- [ ] **Step 6: Test, build, and check the review page in a browser**

Run: `npm test`
Expected: `ℹ pass 54` and `ℹ fail 0`.

Run: `npm run build`
Expected: `Built dist/chessbot-chrome-v3.4.0.zip` and `Built dist/chessbot-firefox-v3.4.0.zip`.

Serve the build in the background: `python3 -m http.server 8765 --bind 127.0.0.1 --directory dist/chrome`. Open `http://127.0.0.1:8765/review.html` in the browser tool and check:

1. Load this PGN with **Load PGN** as White, at depth 12:

   ```
   [SetUp "1"]
   [FEN "8/P7/8/8/8/8/k7/4K3 w - - 0 1"]

   1. Kd2 Kb2 *
   ```

2. At the start position, drag the a7 pawn to a8. The piece picker appears. Choosing the rook puts a white rook on a8, and the variation bar shows `a8=R`.
3. Drag a7 to a8 again and close the picker without choosing. The pawn returns to a7.
4. The console shows no errors from `review.js` or `board-setup.js`.

Stop the server when done.

- [ ] **Step 7: Commit**

```bash
git add board-setup.js review.js scripts/build.mjs
git commit -m "refactor: share board setup and promotion picker" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared success message for solved drills

**Files:**
- Modify: `drills.js`
- Modify: `review.js` (the `drills.js` import and the success branch of `evaluateDrillAttempt`)
- Test: `tests/drills.test.js`

- [ ] **Step 1: Write the failing test**

In `tests/drills.test.js`, change the import line to:

```js
import { drillHint, drillPrompt, drillRejection, drillSuccess, judgeDrillAttempt } from '../drills.js';
```

Append this test to the end of the file:

```js
test('solved drills name the move, and alternatives name the engine move', () => {
  assert.equal(
    drillSuccess({ attemptSan: 'Rd8#', judgement: { verdict: 'alternative', mate: 1 }, review: mateReview, deliversMate: true }),
    'Checkmate! Rd8# ends the game.');
  assert.equal(
    drillSuccess({ attemptSan: 'e4', judgement: { verdict: 'best' }, review: plainReview }),
    "Great find! e4 is Stockfish's top move.");
  assert.equal(
    drillSuccess({ attemptSan: 'Rb8', judgement: { verdict: 'alternative', mate: 2 }, review: mateReview }),
    "Nice! Rb8 also forces mate in 2 (Stockfish's line starts b8=R).");
  assert.equal(
    drillSuccess({ attemptSan: 'd4', judgement: { verdict: 'alternative', mate: null }, review: plainReview }),
    'Nice! d4 is also strong (top engine move was e4).');
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npm test 2>&1 | grep -E "drillSuccess|SyntaxError|fail [1-9]"`
Expected: a SyntaxError that `drillSuccess` is not exported by `drills.js`.

- [ ] **Step 3: Add `drillSuccess` to `drills.js`**

Insert after the `drillRejection` function:

```js
/** Feedback for a solved drill. */
export function drillSuccess({ attemptSan, judgement, review, deliversMate = false }) {
  if (deliversMate) return `Checkmate! ${attemptSan} ends the game.`;
  if (judgement.verdict === "best") return `Great find! ${attemptSan} is Stockfish's top move.`;
  return review.missedMate?.drill
    ? `Nice! ${attemptSan} also forces mate in ${judgement.mate} (Stockfish's line starts ${review.bestSan}).`
    : `Nice! ${attemptSan} is also strong (top engine move was ${review.bestSan}).`;
}
```

- [ ] **Step 4: Use it in `review.js`**

Change the import to:

```js
import { drillHint, drillPrompt, drillRejection, drillSuccess, judgeDrillAttempt } from "./drills.js";
```

In `evaluateDrillAttempt`, replace:

```js
  if (judgement.verdict === "best" || judgement.verdict === "alternative") {
    playSound("success");
    let message = `Great find! ${moveObj.san} is Stockfish's top move.`;
    if (deliversMate) message = `Checkmate! ${moveObj.san} ends the game.`;
    else if (judgement.verdict === "alternative") {
      message = review.missedMate?.drill
        ? `Nice! ${moveObj.san} also forces mate in ${judgement.mate} (Stockfish's line starts ${review.bestSan}).`
        : `Nice! ${moveObj.san} is also strong (top engine move was ${review.bestSan}).`;
    }
    markDrillSolved(message, review.bestMoveUci, mistakePly);
    return;
  }
```

with:

```js
  if (judgement.verdict === "best" || judgement.verdict === "alternative") {
    playSound("success");
    const message = drillSuccess({ attemptSan: moveObj.san, judgement, review, deliversMate });
    markDrillSolved(message, review.bestMoveUci, mistakePly);
    return;
  }
```

- [ ] **Step 5: Run the tests**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `ℹ tests 55`, `ℹ pass 55`, `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add drills.js review.js tests/drills.test.js
git commit -m "refactor: share the solved-drill message" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Deck dates and puzzle records

**Files:**
- Create: `tests/fixtures/training.js`
- Create: `deck.js`
- Test: `tests/deck.test.js`

- [ ] **Step 1: Create the shared test builders**

Create `tests/fixtures/training.js`:

```js
// Shared builders for the practice deck and weakness report tests.
export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const LABELS = { best: "Best", good: "Good", inaccuracy: "Inaccuracy", mistake: "Mistake", miss: "Miss", blunder: "Blunder" };
const MISTAKES = new Set(["mistake", "miss", "blunder"]);

/** One user decision, shaped like weakness.userDecisions output. */
export function decision({ ply = 5, grade = "mistake", theme = "hanging", phase = "middlegame", lowClock = null,
  findChance = 60, expectedBefore = 55 } = {}) {
  const line = (pv, winWhite) => ({ multipv: 1, depth: 16, pv, eval: { type: "cp", value: 40 }, winWhite });
  const bestLine = line(["f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7", "f1e1", "b7b5", "a4b3"], 55);
  return {
    ply,
    fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
    searchOptions: { initialFen: START_FEN, history: ["e2e4", "e7e5", "g1f3", "b8c6"] },
    phase,
    move: { uci: "a2a3", san: "a3" },
    review: {
      classification: { key: grade, label: LABELS[grade] },
      winLoss: 12,
      bestMoveUci: "f1b5",
      bestSan: "Bb5",
      pvSan: "Bb5 a6 Ba4 Nf6 O-O Be7",
      missedMate: null,
      depth: 16,
    },
    root: { ...bestLine, lines: [bestLine, line(["f1c4", "g8f6"], 54)] },
    theme: MISTAKES.has(grade) ? theme : null,
    lowClock,
    findChance,
    expectedBefore,
  };
}

/** A minimal saved puzzle: the fields sessions and filters read. */
export function puzzle(id, { gameKey = "g1", theme = "hanging", phase = "middlegame", due = "2026-11-24", step = 0,
  mastered = false, createdAt = "2026-11-20", lastReviewed = null, lowClock = null, findChance = null } = {}) {
  return {
    id, gameKey, theme, phase, lowClock, findChance, createdAt,
    schedule: { step, due: mastered ? null : due, mastered, attempts: 0, lapses: 0, lastResult: null, lastReviewed },
  };
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/deck.test.js`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REVIEW_INTERVALS, addDays, localDate, newSchedule, puzzleId, puzzlePosition, puzzleReview, puzzlesFromDecisions,
} from "../deck.js";
import { decision } from "./fixtures/training.js";

const base = { gameKey: "g", color: "w", opponent: "Rival", gameDate: "2026-11-23" };

test("local dates are calendar dates across month, year, and leap-day boundaries", () => {
  assert.equal(localDate(new Date(2026, 10, 24, 23, 59)), "2026-11-24");
  assert.equal(localDate(new Date(2027, 0, 5, 0, 1)), "2027-01-05");
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-11-24", 60), "2027-01-23");
});

test("a new puzzle first comes due the next day", () => {
  assert.deepEqual(REVIEW_INTERVALS, [1, 3, 7, 21, 60]);
  assert.deepEqual(newSchedule("2026-11-24"), {
    step: 0, due: "2026-11-25", mastered: false, attempts: 0, lapses: 0, lastResult: null, lastReviewed: null,
  });
});

test("only Mistakes, Misses, and Blunders become puzzles", () => {
  const decisions = [
    decision({ ply: 3, grade: "good" }),
    decision({ ply: 5, grade: "mistake" }),
    decision({ ply: 7, grade: "miss", theme: "missed-mate" }),
    decision({ ply: 9, grade: "blunder" }),
  ];
  const { puzzles, removedIds } = puzzlesFromDecisions({ ...base, gameKey: "chesscom:1", decisions, today: "2026-11-24" });
  assert.deepEqual(puzzles.map((p) => p.id), ["chesscom:1:5", "chesscom:1:7", "chesscom:1:9"]);
  assert.deepEqual(removedIds, []);

  const [first] = puzzles;
  assert.equal(first.id, puzzleId("chesscom:1", 5));
  assert.equal(first.color, "w");
  assert.equal(first.opponent, "Rival");
  assert.equal(first.gameDate, "2026-11-23");
  assert.deepEqual(first.gameMove, { uci: "a2a3", san: "a3" });
  assert.deepEqual(first.best, {
    uci: "f1b5", san: "Bb5", pv: ["f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7", "f1e1", "b7b5"],
    lineSan: "Bb5 a6 Ba4 Nf6 O-O Be7",
  });
  assert.deepEqual(first.history, ["e2e4", "e7e5", "g1f3", "b8c6"]);
  assert.equal(first.root.winWhite, 55);
  assert.equal(first.root.lines[0].pv.length, 8);
  assert.deepEqual(first.root.lines[1], { pv: ["f1c4", "g8f6"], eval: { type: "cp", value: 40 }, winWhite: 54 });
  assert.equal(first.grade, "mistake");
  assert.equal(first.gradeLabel, "Mistake");
  assert.equal(first.depth, 16);
  assert.equal(first.theme, "hanging");
  assert.equal(first.schedule.due, "2026-11-25");
  assert.equal(first.createdAt, "2026-11-24");
});

test("reviewing a game again keeps schedules, drops puzzles that no longer qualify, and adds new ones", () => {
  const first = puzzlesFromDecisions({ ...base, decisions: [decision({ ply: 5 }), decision({ ply: 9 })], today: "2026-11-01" });
  const practiced = first.puzzles.map((p) => ({ ...p, schedule: { ...p.schedule, step: 2, due: "2026-11-20" } }));
  const again = puzzlesFromDecisions({
    ...base, today: "2026-11-24", existing: practiced,
    decisions: [decision({ ply: 5, grade: "blunder" }), decision({ ply: 9, grade: "good" }), decision({ ply: 11 })],
  });
  assert.deepEqual(again.puzzles.map((p) => p.id), ["g:5", "g:11"]);
  assert.equal(again.puzzles[0].grade, "blunder");
  assert.equal(again.puzzles[0].schedule.step, 2);
  assert.equal(again.puzzles[0].createdAt, "2026-11-01");
  assert.equal(again.puzzles[1].schedule.due, "2026-11-25");
  assert.deepEqual(again.removedIds, ["g:9"]);
});

test("a puzzle supplies what the drill rules and the Stockfish comparison read", () => {
  const [p] = puzzlesFromDecisions({ ...base, decisions: [decision()], today: "2026-11-01" }).puzzles;
  assert.deepEqual(puzzleReview(p), {
    bestMoveUci: "f1b5", bestSan: "Bb5", winLoss: 12, missedMate: null,
    classification: { key: "mistake", label: "Mistake" },
  });
  assert.deepEqual(puzzlePosition(p), {
    fen: p.fen, searchOptions: { initialFen: p.initialFen, history: ["e2e4", "e7e5", "g1f3", "b8c6"] },
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npm test 2>&1 | grep -E "deck|Cannot find module|fail [1-9]"`
Expected: an error that `../deck.js` cannot be found.

- [ ] **Step 4: Create `deck.js` with dates and puzzle records**

```js
// Spaced review of the user's own mistakes. Pure functions: no storage, clock, or DOM access.

/** Days until each review. Passing the last review masters the puzzle. */
export const REVIEW_INTERVALS = [1, 3, 7, 21, 60];
export const DEFAULT_DAILY_CAP = 20;
/** Grades that become puzzles. These match the review page's Mistakes tab. */
export const PUZZLE_GRADES = new Set(["mistake", "miss", "blunder"]);
const STORED_PV_PLIES = 8;

const pad = (value) => String(value).padStart(2, "0");

/** A local calendar date as YYYY-MM-DD. */
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Calendar arithmetic on YYYY-MM-DD strings, unaffected by time zones and daylight saving. */
export function addDays(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export const puzzleId = (gameKey, ply) => `${gameKey}:${ply}`;

export function newSchedule(today) {
  return {
    step: 0, due: addDays(today, REVIEW_INTERVALS[0]), mastered: false,
    attempts: 0, lapses: 0, lastResult: null, lastReviewed: null,
  };
}

const storedLine = ({ pv, eval: evaluation, winWhite }) => ({ pv: pv.slice(0, STORED_PV_PLIES), eval: evaluation, winWhite });

/**
 * Puzzles for one reviewed game, merged with that game's existing puzzles. Existing puzzles keep
 * their schedule and creation date. Returns the puzzles to save and the IDs of puzzles to delete.
 */
export function puzzlesFromDecisions({ gameKey, color, opponent, gameDate, decisions, today, existing = [] }) {
  const previous = new Map(existing.map((puzzle) => [puzzle.id, puzzle]));
  const puzzles = decisions
    .filter((decision) => PUZZLE_GRADES.has(decision.review.classification.key))
    .map((decision) => {
      const { ply, review, root } = decision;
      const id = puzzleId(gameKey, ply);
      const kept = previous.get(id);
      return {
        id, gameKey, ply, color, opponent, gameDate,
        fen: decision.fen,
        initialFen: decision.searchOptions.initialFen,
        history: decision.searchOptions.history.slice(),
        gameMove: { uci: decision.move.uci, san: decision.move.san },
        best: {
          uci: review.bestMoveUci,
          san: review.bestSan ?? "",
          pv: root.pv.slice(0, STORED_PV_PLIES),
          lineSan: review.pvSan ?? "",
        },
        grade: review.classification.key,
        gradeLabel: review.classification.label,
        winLoss: review.winLoss,
        missedMate: review.missedMate ?? null,
        depth: review.depth,
        root: { eval: root.eval, winWhite: root.winWhite, lines: root.lines.map(storedLine) },
        theme: decision.theme,
        phase: decision.phase,
        lowClock: decision.lowClock,
        findChance: decision.findChance,
        schedule: kept?.schedule ?? newSchedule(today),
        createdAt: kept?.createdAt ?? today,
      };
    });
  const current = new Set(puzzles.map((puzzle) => puzzle.id));
  const removedIds = existing.map((puzzle) => puzzle.id).filter((id) => !current.has(id));
  return { puzzles, removedIds };
}

/** The review fields that judgeDrillAttempt, drillPrompt, drillRejection, drillSuccess, and drillHint read. */
export function puzzleReview(puzzle) {
  return {
    bestMoveUci: puzzle.best.uci,
    bestSan: puzzle.best.san,
    winLoss: puzzle.winLoss,
    missedMate: puzzle.missedMate,
    classification: { key: puzzle.grade, label: puzzle.gradeLabel },
  };
}

/** The position object compareRootMoves expects, with the game history for repetition rules. */
export function puzzlePosition(puzzle) {
  return { fen: puzzle.fen, searchOptions: { initialFen: puzzle.initialFen, history: puzzle.history } };
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `ℹ tests 60`, `ℹ pass 60`, `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add deck.js tests/deck.test.js tests/fixtures/training.js
git commit -m "feat: build practice puzzles from reviewed mistakes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The review schedule

**Files:**
- Modify: `deck.js`
- Test: `tests/deck.test.js`

- [ ] **Step 1: Write the failing tests**

In `tests/deck.test.js`, extend the import from `../deck.js` with `OUTCOMES, applyResult, isDue, resetPuzzle`. Then append:

```js
const fresh = () => ({ id: "g:5", schedule: newSchedule("2026-11-01") });

test("each first-try pass moves a puzzle up the ladder until it is mastered", () => {
  let p = fresh();
  let day = "2026-11-02";
  const dues = [];
  for (let i = 0; i < 4; i++) {
    p = applyResult(p, OUTCOMES.pass, day);
    dues.push(p.schedule.due);
    day = p.schedule.due;
  }
  assert.deepEqual(dues, ["2026-11-05", "2026-11-12", "2026-12-03", "2027-02-01"]);
  assert.equal(p.schedule.step, 4);
  p = applyResult(p, OUTCOMES.pass, day);
  assert.equal(p.schedule.mastered, true);
  assert.equal(p.schedule.due, null);
  assert.equal(p.schedule.attempts, 5);
  assert.equal(p.schedule.lastReviewed, "2027-02-01");
  assert.equal(isDue(p, "2030-01-01"), false);
});

test("a fail sends the puzzle back to one day and counts a lapse", () => {
  let p = applyResult(fresh(), OUTCOMES.pass, "2026-11-02");
  p = applyResult(p, OUTCOMES.fail, "2026-11-05");
  assert.deepEqual(p.schedule, {
    step: 0, due: "2026-11-06", mastered: false, attempts: 2, lapses: 1, lastResult: "fail", lastReviewed: "2026-11-05",
  });
});

test("an unverified result leaves the puzzle untouched", () => {
  const p = fresh();
  assert.equal(applyResult(p, OUTCOMES.unverified, "2026-11-02"), p);
});

test("an unknown result is a programming error", () => {
  assert.throws(() => applyResult(fresh(), "maybe", "2026-11-02"), /Unknown outcome/);
});

test("practice before the due date never moves a puzzle forward, but a fail still resets it", () => {
  const p = { id: "g:5", schedule: { ...newSchedule("2026-11-01"), step: 2, due: "2026-11-20" } };
  const passed = applyResult(p, OUTCOMES.pass, "2026-11-10", { early: true });
  assert.equal(passed.schedule.step, 2);
  assert.equal(passed.schedule.due, "2026-11-20");
  assert.equal(passed.schedule.attempts, 1);
  const failed = applyResult(p, OUTCOMES.fail, "2026-11-10", { early: true });
  assert.equal(failed.schedule.step, 0);
  assert.equal(failed.schedule.due, "2026-11-11");
});

test("a puzzle is due on or after its date until it is mastered, and a reset brings it back tomorrow", () => {
  const p = fresh();
  assert.equal(isDue(p, "2026-11-01"), false);
  assert.equal(isDue(p, "2026-11-02"), true);
  assert.equal(isDue(p, "2026-11-30"), true);
  const mastered = { ...p, schedule: { ...p.schedule, step: 4, mastered: true, due: null } };
  const reset = resetPuzzle(mastered, "2026-12-01");
  assert.equal(reset.schedule.mastered, false);
  assert.equal(reset.schedule.step, 0);
  assert.equal(reset.schedule.due, "2026-12-02");
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test 2>&1 | grep -E "SyntaxError|fail [1-9]"`
Expected: a SyntaxError that `OUTCOMES` (or `applyResult`) is not exported by `deck.js`.

- [ ] **Step 3: Add the schedule to `deck.js`**

Append to `deck.js`:

```js
export const OUTCOMES = Object.freeze({ pass: "pass", fail: "fail", unverified: "unverified" });

export const isDue = (puzzle, today) => !puzzle.schedule.mastered && puzzle.schedule.due <= today;

/**
 * The puzzle after one session result. `early` marks practice before the due date: a pass then
 * leaves the step and due date as they were, while a fail still resets them. An unverified result
 * (Stockfish couldn't check the move) changes nothing.
 */
export function applyResult(puzzle, outcome, today, { early = false } = {}) {
  if (outcome === OUTCOMES.unverified) return puzzle;
  if (outcome !== OUTCOMES.pass && outcome !== OUTCOMES.fail) throw new Error(`Unknown outcome: ${outcome}`);
  const current = puzzle.schedule;
  const schedule = { ...current, attempts: current.attempts + 1, lastResult: outcome, lastReviewed: today };
  if (outcome === OUTCOMES.fail) {
    Object.assign(schedule, {
      step: 0, due: addDays(today, REVIEW_INTERVALS[0]), mastered: false, lapses: current.lapses + 1,
    });
  } else if (!early) {
    if (current.step >= REVIEW_INTERVALS.length - 1) {
      Object.assign(schedule, { mastered: true, due: null });
    } else {
      const step = current.step + 1;
      Object.assign(schedule, { step, due: addDays(today, REVIEW_INTERVALS[step]) });
    }
  }
  return { ...puzzle, schedule };
}

/** Bring a puzzle, including a mastered one, back to the first step, due tomorrow. */
export function resetPuzzle(puzzle, today) {
  return {
    ...puzzle,
    schedule: { ...puzzle.schedule, step: 0, due: addDays(today, REVIEW_INTERVALS[0]), mastered: false },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `ℹ tests 66`, `ℹ pass 66`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add deck.js tests/deck.test.js
git commit -m "feat: schedule practice puzzles at 1, 3, 7, 21, and 60 days" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Sessions and the session queue

**Files:**
- Modify: `deck.js`
- Test: `tests/deck.test.js`

The daily cap counts every puzzle already practiced today (`schedule.lastReviewed === today`). Without that, reopening the page would start another full session.

- [ ] **Step 1: Write the failing tests**

In `tests/deck.test.js`, extend the `../deck.js` import with `advanceQueue, buildSession, currentId, dueCount, isRepeat, startQueue`, and change the fixtures import to `import { decision, puzzle } from "./fixtures/training.js";`. Then append:

```js
const ids = (puzzles) => puzzles.map((p) => p.id);

test("today's session takes due puzzles, most overdue first, up to the daily cap", () => {
  const puzzles = [
    puzzle("a", { due: "2026-11-24", gameKey: "g1" }),
    puzzle("b", { due: "2026-11-22", gameKey: "g2" }),
    puzzle("c", { due: "2026-11-25", gameKey: "g3" }),
    puzzle("d", { mastered: true, gameKey: "g4" }),
    puzzle("e", { due: "2026-11-23", gameKey: "g5" }),
  ];
  assert.deepEqual(ids(buildSession(puzzles, { today: "2026-11-24" })), ["b", "e", "a"]);
  assert.deepEqual(ids(buildSession(puzzles, { today: "2026-11-24", cap: 2 })), ["b", "e"]);
  assert.equal(dueCount(puzzles, "2026-11-24"), 3);
});

test("puzzles already practiced today count toward the daily cap", () => {
  const puzzles = [
    puzzle("a", { gameKey: "g1" }),
    puzzle("b", { gameKey: "g2" }),
    puzzle("done", { due: "2026-11-27", lastReviewed: "2026-11-24", gameKey: "g3" }),
  ];
  assert.deepEqual(ids(buildSession(puzzles, { today: "2026-11-24", cap: 2 })), ["a"]);
});

test("the session avoids repeating a game first and a theme second", () => {
  const puzzles = [
    puzzle("a1", { gameKey: "A", theme: "hanging", createdAt: "2026-11-01" }),
    puzzle("a2", { gameKey: "A", theme: "hanging", createdAt: "2026-11-02" }),
    puzzle("b1", { gameKey: "B", theme: "hanging", createdAt: "2026-11-03" }),
    puzzle("c1", { gameKey: "C", theme: "missed-mate", createdAt: "2026-11-04" }),
  ];
  assert.deepEqual(ids(buildSession(puzzles, { today: "2026-11-24" })), ["a1", "c1", "a2", "b1"]);
});

test("theme practice puts due puzzles first, includes ones not yet due, and skips mastered ones", () => {
  const puzzles = [
    puzzle("later", { due: "2026-12-01", gameKey: "g1" }),
    puzzle("due", { due: "2026-11-20", gameKey: "g2" }),
    puzzle("other", { due: "2026-11-20", theme: "missed-mate", gameKey: "g3" }),
    puzzle("done", { mastered: true, gameKey: "g4" }),
  ];
  const session = buildSession(puzzles, { today: "2026-11-24", filter: (p) => p.theme === "hanging" });
  assert.deepEqual(ids(session), ["due", "later"]);
});

test("a failed puzzle comes back once at the end of the session", () => {
  let queue = startQueue([puzzle("a"), puzzle("b")]);
  assert.equal(currentId(queue), "a");
  assert.equal(isRepeat(queue), false);
  queue = advanceQueue(queue, OUTCOMES.fail);
  assert.equal(currentId(queue), "b");
  queue = advanceQueue(queue, OUTCOMES.pass);
  assert.equal(currentId(queue), "a");
  assert.equal(isRepeat(queue), true);
  queue = advanceQueue(queue, OUTCOMES.fail);
  assert.equal(currentId(queue), null);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test 2>&1 | grep -E "SyntaxError|fail [1-9]"`
Expected: a SyntaxError that `advanceQueue` (or another new name) is not exported by `deck.js`.

- [ ] **Step 3: Add sessions to `deck.js`**

Append to `deck.js`:

```js
export const dueCount = (puzzles, today) => puzzles.filter((puzzle) => isDue(puzzle, today)).length;

const byDue = (a, b) => (a.schedule.due ?? "").localeCompare(b.schedule.due ?? "") ||
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** Reorder so consecutive puzzles avoid the same game first and the same theme second, when possible. */
export function interleave(puzzles) {
  const remaining = puzzles.slice();
  const ordered = [];
  while (remaining.length) {
    const last = ordered.at(-1);
    let index = 0;
    if (last) {
      const candidates = [
        remaining.findIndex((p) => p.gameKey !== last.gameKey && p.theme !== last.theme),
        remaining.findIndex((p) => p.gameKey !== last.gameKey),
        remaining.findIndex((p) => p.theme !== last.theme),
      ];
      index = candidates.find((candidate) => candidate >= 0) ?? 0;
    }
    ordered.push(...remaining.splice(index, 1));
  }
  return ordered;
}

/**
 * Today's puzzles: due ones, most overdue first, up to the daily cap minus puzzles already practiced
 * today. With `filter`, a theme-practice set instead: matching puzzles that aren't mastered, due ones
 * first, up to the cap.
 */
export function buildSession(puzzles, { today, cap = DEFAULT_DAILY_CAP, filter = null }) {
  const open = puzzles.filter((puzzle) => !puzzle.schedule.mastered);
  if (filter) {
    const matching = open.filter(filter)
      .sort((a, b) => Number(isDue(b, today)) - Number(isDue(a, today)) || byDue(a, b));
    return interleave(matching.slice(0, cap));
  }
  const practicedToday = puzzles.filter((puzzle) => puzzle.schedule.lastReviewed === today).length;
  const room = Math.max(0, cap - practicedToday);
  return interleave(open.filter((puzzle) => isDue(puzzle, today)).sort(byDue).slice(0, room));
}

/** A session queue. A failed puzzle comes back once at the end, and that repeat never changes its schedule. */
export function startQueue(puzzles) {
  return { ids: puzzles.map((puzzle) => puzzle.id), index: 0, firstPass: puzzles.length, requeued: [] };
}

export const currentId = (queue) => queue.ids[queue.index] ?? null;
export const isRepeat = (queue) => queue.index >= queue.firstPass;

export function advanceQueue(queue, outcome) {
  const id = currentId(queue);
  const requeue = Boolean(id) && outcome === OUTCOMES.fail && !isRepeat(queue) && !queue.requeued.includes(id);
  return {
    ...queue,
    index: queue.index + 1,
    ids: requeue ? [...queue.ids, id] : queue.ids,
    requeued: requeue ? [...queue.requeued, id] : queue.requeued,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `ℹ tests 71`, `ℹ pass 71`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add deck.js tests/deck.test.js
git commit -m "feat: daily and theme practice sessions with interleaving" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Weakness themes, clocks, results, and dates

**Files:**
- Create: `weakness.js`
- Test: `tests/weakness.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/weakness.test.js`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { THEMES, gameDate, isLowClock, themeForTag, themeLabel, userResult } from "../weakness.js";

test("coach tags map to report rows, and unknown tags fall back to No single tactic", () => {
  assert.equal(themeForTag("Hanging Piece"), "hanging");
  assert.equal(themeForTag("Engine Capture"), "allowed-tactic");
  assert.equal(themeForTag("Missed Defense"), "allowed-mate");
  assert.equal(themeForTag("Missed Tactic"), "missed-material");
  assert.equal(themeForTag("Missed Mate"), "missed-mate");
  assert.equal(themeForTag("Missed Refutation"), "missed-refutation");
  assert.equal(themeForTag("Missed Check"), "missed-forcing");
  assert.equal(themeForTag("Promotion"), "missed-forcing");
  assert.equal(themeForTag("Critical Error"), "positional");
  assert.equal(themeForTag("Positional Slip"), "positional");
  assert.equal(themeForTag("Something New"), "positional");
  assert.equal(themeForTag(null), "positional");
  assert.equal(themeLabel("hanging"), "Left a piece hanging");
});

test("every coach tag for a Mistake, Miss, or Blunder has a report row", async () => {
  const source = await readFile(new URL("../coach.js", import.meta.url), "utf8");
  const tags = new Set();
  for (const [, expression] of source.matchAll(/\btag:\s*([^,\n]+)/g)) {
    // Strings at the start or after ? and : are results; strings after === are comparisons.
    for (const [, tag] of expression.matchAll(/(?:^|[?:]\s*)"([^"]+)"/g)) tags.add(tag);
  }
  const praiseTags = ["Checkmate", "Forced Move", "Tactical Sacrifice", "Critical Move", "Equally Strong",
    "King Safety", "Tactical Precision", "Top Engine Move", "Strong Move", "Solid Play"];
  const mapped = new Set(THEMES.flatMap((theme) => theme.tags));
  assert.deepEqual([...tags].filter((tag) => !praiseTags.includes(tag) && !mapped.has(tag)), []);
  for (const tag of mapped) assert.ok(tags.has(tag), `${tag} is not a tag in coach.js`);
});

test("a clock is low under 10% of the base time or 15 seconds, whichever is larger", () => {
  assert.equal(isLowClock(17.9, 180), true);
  assert.equal(isLowClock(18, 180), false);
  assert.equal(isLowClock(14.9, 60), true);
  assert.equal(isLowClock(15, 60), false);
  assert.equal(isLowClock(59, 600), true);
  assert.equal(isLowClock(null, 180), null);
  assert.equal(isLowClock(30, undefined), null);
});

test("results are scored from the user's side", () => {
  assert.equal(userResult("1-0", "w"), 1);
  assert.equal(userResult("1-0", "b"), 0);
  assert.equal(userResult("0-1", "b"), 1);
  assert.equal(userResult("1/2-1/2", "w"), 0.5);
  assert.equal(userResult("*", "w"), null);
  assert.equal(userResult(undefined, "b"), null);
});

test("a game's date comes from the Chess.com end time, then PGN headers, then the review date", () => {
  const endTime = Math.floor(new Date(2026, 10, 20, 12, 0).getTime() / 1000);
  assert.equal(gameDate({ endTime, headers: { Date: "2001.01.01" } }, "2026-11-24"), "2026-11-20");
  assert.equal(gameDate({ headers: { UTCDate: "2026.11.19", Date: "2026.11.18" } }, "2026-11-24"), "2026-11-19");
  assert.equal(gameDate({ headers: { Date: "2026.11.18" } }, "2026-11-24"), "2026-11-18");
  assert.equal(gameDate({ headers: { Date: "????.??.??" } }, "2026-11-24"), "2026-11-24");
  assert.equal(gameDate({}, "2026-11-24"), "2026-11-24");
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test 2>&1 | grep -E "weakness|Cannot find module|fail [1-9]"`
Expected: an error that `../weakness.js` cannot be found.

- [ ] **Step 3: Create `weakness.js` with the theme table and helpers**

```js
// Cross-game weakness report. Pure functions: no storage, clock, or DOM access.
import { localDate } from "./deck.js";

/** The report appears once this many games are reviewed. */
export const REPORT_MIN_GAMES = 5;
/** The report covers this many of the most recently reviewed games. */
export const REPORT_WINDOW = 50;
/** A mistake type with fewer cases goes under Less common. */
export const ROW_MIN_CASES = 3;
/** The top mistake type is labeled Your main focus only with at least this many cases. */
export const FOCUS_MIN_CASES = 5;
/** A mistake counts as easy when at least this share (percent) of players find a sound move. */
export const EASY_FIND_CHANCE = 70;
/** An expected score (0–100) at or above this is a winning position. */
export const WINNING_SCORE = 85;
/** A clock is low under the larger of these: seconds, or a share of the base time. */
export const LOW_CLOCK_FLOOR = 15;
export const LOW_CLOCK_SHARE = 0.1;
export const PHASES = ["opening", "middlegame", "endgame"];

/** Report rows, in tie-break order. Each Mistake, Miss, or Blunder gets one row from its coach tag. */
export const THEMES = [
  { id: "hanging", label: "Left a piece hanging", tags: ["Hanging Piece"] },
  { id: "allowed-tactic", label: "Allowed a tactic", tags: ["Engine Capture"] },
  { id: "allowed-mate", label: "Allowed checkmate", tags: ["Missed Defense"] },
  { id: "missed-material", label: "Missed winning material", tags: ["Missed Tactic"] },
  { id: "missed-mate", label: "Missed checkmate", tags: ["Missed Mate"] },
  { id: "missed-refutation", label: "Didn't punish a mistake", tags: ["Missed Refutation"] },
  { id: "missed-forcing", label: "Missed a check or promotion", tags: ["Missed Check", "Promotion"] },
  { id: "positional", label: "No single tactic", tags: ["Critical Error", "Positional Slip"] },
];
const THEME_BY_TAG = new Map(THEMES.flatMap((theme) => theme.tags.map((tag) => [tag, theme.id])));

export const themeForTag = (tag) => THEME_BY_TAG.get(tag) ?? "positional";
export const themeLabel = (id) => THEMES.find((theme) => theme.id === id)?.label ?? id;

/** True when the clock is low, false when it isn't, and null without a clock or base time. */
export function isLowClock(seconds, baseSeconds) {
  if (!Number.isFinite(seconds) || !Number.isFinite(baseSeconds)) return null;
  return seconds < Math.max(LOW_CLOCK_FLOOR, LOW_CLOCK_SHARE * baseSeconds);
}

/** The user's score from a PGN result tag: 1, 0.5, or 0, or null when unknown. */
export function userResult(resultTag, color) {
  if (resultTag === "1/2-1/2") return 0.5;
  if (resultTag === "1-0") return color === "w" ? 1 : 0;
  if (resultTag === "0-1") return color === "b" ? 1 : 0;
  return null;
}

/** The game's date: the Chess.com end time, then the PGN date headers, then `today`. */
export function gameDate({ endTime, headers = {} }, today) {
  if (Number.isFinite(endTime) && endTime > 0) return localDate(new Date(endTime * 1000));
  const tag = [headers.UTCDate, headers.Date].find((value) => /^\d{4}\.\d{2}\.\d{2}$/.test(value ?? ""));
  return tag ? tag.replaceAll(".", "-") : today;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `ℹ tests 82`, `ℹ pass 82`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add weakness.js tests/weakness.test.js
git commit -m "feat: weakness themes, low-clock rule, results, and game dates" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: User decisions and the game summary

**Files:**
- Modify: `weakness.js`
- Test: `tests/weakness.test.js`

`userDecisions` turns a finished review into one record per non-forced decision by the user. Both `deck.js` and the summary use these records. The coach tag is computed only for Mistakes, Misses, and Blunders.

- [ ] **Step 1: Write the failing tests**

In `tests/weakness.test.js`, add these imports below the existing ones:

```js
import { parseReviewGame } from "../analysis.js";
import { gameAccuracy, summarizeGame, userDecisions } from "../weakness.js";
import { decision } from "./fixtures/training.js";
```

Then append:

```js
const CLOCK_PGN = `[Event "Clock test"]
[TimeControl "180"]
[Result "*"]

1. e4 {[%clk 0:02:59]} e5 {[%clk 0:02:58]} 2. Nf3 {[%clk 0:00:10]} Nc6 {[%clk 0:02:50]} 3. Bc4 {[%clk 0:00:09]} *`;

function clockReview() {
  const { positions } = parseReviewGame(CLOCK_PGN);
  const line = (winWhite) => ({ multipv: 1, depth: 16, eval: { type: "cp", value: 30 }, winWhite, pv: ["d2d4"] });
  const evals = positions.map((_, i) => ({ ...line(50 + i), lines: [line(50 + i)] }));
  const review = (key, extra = {}) => ({
    classification: { key, label: key }, forced: false, accuracy: 90, winLoss: 0, bestMoveUci: "d2d4",
    bestSan: "d4", pvSan: "d4", missedMate: null, depth: 16, difficulty: null,
    playedEval: { type: "cp", value: 20 }, playedPv: ["e2e4"], ...extra,
  });
  const moveReviews = [
    null,
    review("best"),
    review("best"),
    // 2. Nf3: a quiet mistake, so the coach tags it Positional Slip.
    review("mistake", { playedEval: { type: "cp", value: -150 }, playedPv: ["g1f3", "d7d5"],
      difficulty: { chance: 72.4, model: "position" } }),
    review("best"),
    // 3. Bc4: allows mate in 1, so the coach tags it Missed Defense.
    review("blunder", { bestMoveUci: "f1b5", playedEval: { type: "mate", value: -1 }, playedPv: ["f1c4", "d8h4"] }),
  ];
  return { positions, evals, moveReviews };
}

test("user decisions carry the position, theme, clock, find chance, and expected score", () => {
  const source = clockReview();
  const decisions = userDecisions({ ...source, playedColor: "w" });
  assert.deepEqual(decisions.map((d) => d.ply), [1, 3, 5]);
  assert.deepEqual(decisions.map((d) => d.theme), [null, "positional", "allowed-mate"]);
  assert.deepEqual(decisions.map((d) => d.lowClock), [null, false, true]);
  assert.deepEqual(decisions.map((d) => d.findChance), [null, 72.4, null]);
  assert.deepEqual(decisions.map((d) => d.expectedBefore), [50, 52, 54]);
  assert.deepEqual(decisions[1].move, { uci: "g1f3", san: "Nf3" });
  assert.equal(decisions[1].fen, source.positions[2].fen);
  assert.deepEqual(decisions[1].searchOptions, source.positions[2].searchOptions);
  assert.equal(decisions[1].phase, source.positions[2].phase);
  assert.equal(decisions[1].root, source.evals[2]);
  assert.equal(decisions[1].review, source.moveReviews[3]);
});

test("Black's decisions use Black's clock and expected score, and forced moves are skipped", () => {
  const source = clockReview();
  const black = userDecisions({ ...source, playedColor: "b" });
  assert.deepEqual(black.map((d) => d.ply), [2, 4]);
  assert.deepEqual(black.map((d) => d.lowClock), [null, false]);
  assert.deepEqual(black.map((d) => d.expectedBefore), [49, 47]);

  source.moveReviews[3] = { ...source.moveReviews[3], forced: true };
  assert.deepEqual(userDecisions({ ...source, playedColor: "w" }).map((d) => d.ply), [1, 5]);
});

test("game accuracy matches the review page's overall and phase scores", () => {
  const { accuracy, phaseAccuracy } = gameAccuracy({ ...clockReview(), playedColor: "w" });
  assert.equal(typeof accuracy, "number");
  assert.deepEqual(Object.keys(phaseAccuracy).sort(), ["endgame", "middlegame", "opening"]);
});

test("a game summary keeps counts, clock totals, the best expected score, and each mistake", () => {
  const decisions = [
    decision({ ply: 3, grade: "good", phase: "opening", lowClock: false, expectedBefore: 52 }),
    decision({ ply: 5, grade: "mistake", theme: "hanging", lowClock: true, findChance: 75, expectedBefore: 88 }),
    decision({ ply: 7, grade: "blunder", theme: "allowed-mate", lowClock: null, findChance: null, expectedBefore: null }),
  ];
  const summary = summarizeGame({
    gameKey: "g", reviewedAt: 5, date: "2026-11-23", color: "w", result: 0.5, timeClass: "blitz",
    opponent: "Rival", depth: 16, decisions, accuracy: 81.5,
    phaseAccuracy: { opening: 95, middlegame: 70, endgame: null },
  });
  assert.deepEqual(summary, {
    gameKey: "g", reviewedAt: 5, date: "2026-11-23", color: "w", result: 0.5, timeClass: "blitz",
    opponent: "Rival", depth: 16, decisions: 3, phaseMoves: { opening: 1, middlegame: 2, endgame: 0 },
    phaseAccuracy: { opening: 95, middlegame: 70, endgame: null }, accuracy: 81.5,
    clock: { lowDecisions: 1, otherDecisions: 1 }, maxExpectedScore: 88,
    mistakes: [
      { ply: 5, theme: "hanging", phase: "middlegame", lowClock: true, findChance: 75 },
      { ply: 7, theme: "allowed-mate", phase: "middlegame", lowClock: null, findChance: null },
    ],
  });
});

test("a game without clocks or scores has null clock totals and expected score", () => {
  const summary = summarizeGame({
    gameKey: "g", reviewedAt: 1, date: "2026-11-23", color: "b", result: null, decisions: [],
    accuracy: null, phaseAccuracy: {},
  });
  assert.equal(summary.clock, null);
  assert.equal(summary.maxExpectedScore, null);
  assert.deepEqual(summary.phaseAccuracy, { opening: null, middlegame: null, endgame: null });
  assert.equal(summary.timeClass, "");
  assert.equal(summary.opponent, "");
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test 2>&1 | grep -E "SyntaxError|fail [1-9]"`
Expected: a SyntaxError that `gameAccuracy` (or another new name) is not exported by `weakness.js`.

- [ ] **Step 3: Add decisions and summaries to `weakness.js`**

Replace the import line at the top of `weakness.js` with:

```js
import { Chess } from "./vendor/chess.js/chess.js";
import { computeGameInsights, generateLocalCoachInsight } from "./coach.js";
import { PUZZLE_GRADES, localDate } from "./deck.js";
import { computeProGameAccuracy, evalToWinWhite } from "./engine.js";
```

Append to `weakness.js`:

```js
const sideScore = (winWhite, color) => (Number.isFinite(winWhite) ? (color === "w" ? winWhite : 100 - winWhite) : null);

/**
 * The user's non-forced decisions from a finished review: the position before the move, the review,
 * the root evaluation, and the fields the deck and the report need.
 */
export function userDecisions({ positions, evals, moveReviews, playedColor }) {
  const clockKey = playedColor === "w" ? "whiteSeconds" : "blackSeconds";
  const decisions = [];
  for (let ply = 1; ply < positions.length; ply++) {
    const before = positions[ply - 1];
    const after = positions[ply];
    const review = moveReviews[ply];
    const root = evals[ply - 1];
    if (!after.move || after.move.color !== playedColor || !review || review.forced || !root) continue;

    const mistake = PUZZLE_GRADES.has(review.classification.key);
    const tag = mistake ? generateLocalCoachInsight({
      ChessClass: Chess,
      fenBefore: before.fen,
      fenAfter: after.fen,
      move: after.move,
      evalBefore: root,
      evalAfter: { eval: review.playedEval, bestMove: review.playedPv?.[1] },
      review,
    }).tag : null;
    const context = before.practicalContext;
    decisions.push({
      ply,
      fen: before.fen,
      searchOptions: before.searchOptions,
      phase: before.phase,
      move: { uci: after.move.uci, san: after.move.san },
      review,
      root,
      theme: mistake ? themeForTag(tag) : null,
      lowClock: isLowClock(context?.[clockKey], context?.timeControl?.base),
      findChance: Number.isFinite(review.difficulty?.chance) ? review.difficulty.chance : null,
      expectedBefore: sideScore(root.winWhite, playedColor),
    });
  }
  return decisions;
}

/** Overall and phase accuracy for the user's side, computed the way the review page shows them. */
export function gameAccuracy({ positions, evals, moveReviews, playedColor }) {
  const winTimeline = evals.map((evaluation) => (evaluation ? evalToWinWhite(evaluation.eval) : null));
  const moves = [];
  for (let ply = 1; ply < positions.length; ply++) {
    const review = moveReviews[ply];
    if (review && !review.forced && positions[ply].move?.color === playedColor) {
      moves.push({ ply, accuracy: review.accuracy });
    }
  }
  return {
    accuracy: computeProGameAccuracy(winTimeline, moves),
    phaseAccuracy: computeGameInsights({ positions, winTimeline, moveReviews, playedColor }),
  };
}

/** The stored summary of one reviewed game. */
export function summarizeGame({ gameKey, reviewedAt, date, color, result, timeClass, opponent, depth, decisions,
  accuracy, phaseAccuracy }) {
  const lowDecisions = decisions.filter((d) => d.lowClock === true).length;
  const otherDecisions = decisions.filter((d) => d.lowClock === false).length;
  const scores = decisions.map((d) => d.expectedBefore).filter(Number.isFinite);
  return {
    gameKey, reviewedAt, date, color, result,
    timeClass: timeClass || "",
    opponent: opponent || "",
    depth,
    decisions: decisions.length,
    phaseMoves: Object.fromEntries(PHASES.map((phase) => [phase, decisions.filter((d) => d.phase === phase).length])),
    phaseAccuracy: Object.fromEntries(PHASES.map((phase) => [phase, phaseAccuracy?.[phase] ?? null])),
    accuracy: accuracy ?? null,
    clock: lowDecisions + otherDecisions ? { lowDecisions, otherDecisions } : null,
    maxExpectedScore: scores.length ? Math.max(...scores) : null,
    mistakes: decisions.filter((d) => d.theme)
      .map(({ ply, theme, phase, lowClock, findChance }) => ({ ply, theme, phase, lowClock, findChance })),
  };
}
```

Note: `summarizeGame({ ..., depth })` with `depth` missing gives `depth: undefined`. The last test passes no depth on purpose and only checks other fields.

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `ℹ tests 87`, `ℹ pass 87`, `ℹ fail 0`.

If the decision-theme test fails, print the coach tag for ply 3 or 5 with a one-off `node -e` script before changing the fixture. The fixture is built so ply 3 reaches the final Positional Slip branch of `generateLocalCoachInsight`, and ply 5 reaches the Missed Defense branch.

- [ ] **Step 5: Commit**

```bash
git add weakness.js tests/weakness.test.js
git commit -m "feat: per-game decisions and summaries for the weakness report" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The weakness report and practice filters

**Files:**
- Modify: `weakness.js`
- Test: `tests/weakness.test.js`

- [ ] **Step 1: Write the failing tests**

In `tests/weakness.test.js`, extend the `../weakness.js` import with `reportFilter, weaknessReport`. Then append:

```js
function game(i, overrides = {}) {
  return {
    gameKey: `g${i}`, reviewedAt: 1000 + i, date: "2026-11-01", color: "w", result: 1, timeClass: "blitz",
    opponent: "", depth: 16, decisions: 20, phaseMoves: { opening: 5, middlegame: 10, endgame: 5 },
    phaseAccuracy: { opening: 90, middlegame: 80, endgame: 70 }, accuracy: 80, clock: null,
    maxExpectedScore: 60, mistakes: [], ...overrides,
  };
}
const mistake = (theme, extra = {}) => ({ ply: 9, theme, phase: "middlegame", lowClock: null, findChance: null, ...extra });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test("the report waits for five reviewed games", () => {
  assert.deepEqual(weaknessReport([0, 1, 2, 3].map((i) => game(i))), { ready: false, games: 4, needed: 5 });
});

test("the report covers the 50 most recently reviewed games", () => {
  const games = Array.from({ length: 55 }, (_, i) => game(i));
  games[0].mistakes = [mistake("hanging"), mistake("hanging"), mistake("hanging")];
  const report = weaknessReport(games);
  assert.equal(report.games, 50);
  assert.equal(report.moves, 1000);
  assert.equal(report.mistakes, 0);
});

test("mistake types are ranked, rare ones go under Less common, and main focus needs five cases", () => {
  const positional = Array.from({ length: 5 }, () => mistake("positional"));
  const games = [
    game(0, { mistakes: [mistake("hanging"), mistake("hanging"), ...positional] }),
    game(1, { mistakes: [mistake("hanging")] }),
    game(2, { mistakes: [mistake("hanging"), mistake("allowed-tactic")] }),
    game(3, { mistakes: [mistake("allowed-tactic")] }),
    game(4),
  ];
  const { themes, moves } = weaknessReport(games);
  assert.equal(moves, 100);
  assert.deepEqual(themes.common.map((row) => [row.id, row.count, row.games]), [["positional", 5, 1], ["hanging", 4, 3]]);
  assert.equal(themes.common[0].label, "No single tactic");
  close(themes.common[0].per100, 5);
  assert.deepEqual(themes.lessCommon.map((row) => [row.id, row.count]), [["allowed-tactic", 2]]);
  assert.equal(themes.focus, "positional");

  games[0].mistakes.pop();
  const tied = weaknessReport(games).themes;
  assert.deepEqual(tied.common.map((row) => row.id), ["hanging", "positional"]);
  assert.equal(tied.focus, null);
});

test("the easy share counts mistakes where at least 70% find a sound move and skips unknown estimates", () => {
  const games = [0, 1, 2, 3, 4].map((i) => game(i));
  games[0].mistakes = [80, 70, 69.9, null].map((findChance) => mistake("hanging", { findChance }));
  assert.deepEqual(weaknessReport(games).easy, { easy: 2, rated: 3, unrated: 1 });
});

test("phase and overall accuracy are weighted by the user's moves", () => {
  const games = [
    game(0, {
      accuracy: 60, phaseMoves: { opening: 10, middlegame: 10, endgame: 0 },
      phaseAccuracy: { opening: 90, middlegame: 70, endgame: null },
    }),
    ...[1, 2, 3, 4].map((i) => game(i)),
  ];
  const { phases, overall } = weaknessReport(games);
  assert.equal(phases.opening.games, 5);
  close(phases.opening.accuracy, 90);
  close(phases.middlegame.accuracy, 78);
  assert.equal(phases.endgame.games, 4);
  close(phases.endgame.accuracy, 70);
  close(overall, 76);
});

test("low-clock rates use only games with clocks", () => {
  const games = [
    game(0, {
      clock: { lowDecisions: 4, otherDecisions: 16 },
      mistakes: [mistake("hanging", { lowClock: true }), mistake("hanging", { lowClock: true }),
        mistake("hanging", { lowClock: false })],
    }),
    game(1, { clock: { lowDecisions: 2, otherDecisions: 18 }, mistakes: [mistake("hanging", { lowClock: false })] }),
    game(2, { mistakes: [mistake("hanging")] }),
    game(3),
    game(4),
  ];
  const { clock } = weaknessReport(games);
  assert.equal(clock.games, 2);
  assert.equal(clock.lowMoves, 6);
  assert.equal(clock.otherMoves, 34);
  assert.equal(clock.lowMistakes, 2);
  assert.equal(clock.otherMistakes, 2);
  close(clock.lowRate, 200 / 6);
  close(clock.otherRate, 200 / 34);
  assert.equal(weaknessReport([0, 1, 2, 3, 4].map((i) => game(i))).clock, null);
});

test("unconverted wins need an expected score of 85 or more and a known result", () => {
  const games = [
    game(0, { maxExpectedScore: 85, result: 0.5 }),
    game(1, { maxExpectedScore: 84.9, result: 0 }),
    game(2, { maxExpectedScore: 95, result: 1 }),
    game(3, { maxExpectedScore: 90, result: null }),
    game(4, { maxExpectedScore: 99, result: 0 }),
  ];
  const { conversion } = weaknessReport(games);
  assert.equal(conversion.winning, 3);
  assert.equal(conversion.unconverted, 2);
  assert.deepEqual(conversion.gameKeys.sort(), ["g0", "g4"]);
});

test("report filters select the matching puzzles", () => {
  const p = { gameKey: "g4", theme: "hanging", phase: "endgame", lowClock: true, findChance: 70 };
  assert.equal(reportFilter("theme", "hanging")(p), true);
  assert.equal(reportFilter("theme", "positional")(p), false);
  assert.equal(reportFilter("phase", "endgame")(p), true);
  assert.equal(reportFilter("lowClock")(p), true);
  assert.equal(reportFilter("lowClock")({ ...p, lowClock: null }), false);
  assert.equal(reportFilter("easy")(p), true);
  assert.equal(reportFilter("easy")({ ...p, findChance: null }), false);
  assert.equal(reportFilter("unconverted", ["g4"])(p), true);
  assert.equal(reportFilter("unconverted", ["g1"])(p), false);
  assert.throws(() => reportFilter("rating"), /Unknown report filter/);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test 2>&1 | grep -E "SyntaxError|fail [1-9]"`
Expected: a SyntaxError that `reportFilter` (or `weaknessReport`) is not exported by `weakness.js`.

- [ ] **Step 3: Add the report to `weakness.js`**

Append to `weakness.js`:

```js
const per100 = (count, moves) => (moves ? (count / moves) * 100 : null);

function weightedMean(pairs) {
  let total = 0;
  let weight = 0;
  for (const [value, count] of pairs) {
    if (Number.isFinite(value) && count > 0) {
      total += value * count;
      weight += count;
    }
  }
  return weight ? total / weight : null;
}

/** The weakness report over the most recently reviewed games, or `{ ready: false }` until there are enough. */
export function weaknessReport(summaries) {
  const games = [...summaries].sort((a, b) => b.reviewedAt - a.reviewedAt).slice(0, REPORT_WINDOW);
  if (games.length < REPORT_MIN_GAMES) return { ready: false, games: games.length, needed: REPORT_MIN_GAMES };

  const moves = games.reduce((sum, game) => sum + game.decisions, 0);
  const mistakes = games.flatMap((game) => game.mistakes.map((m) => ({ ...m, gameKey: game.gameKey })));

  const rows = THEMES.map((theme, order) => {
    const cases = mistakes.filter((m) => m.theme === theme.id);
    return {
      id: theme.id, label: theme.label, order, count: cases.length,
      games: new Set(cases.map((m) => m.gameKey)).size, per100: per100(cases.length, moves),
    };
  }).filter((row) => row.count > 0).sort((a, b) => b.count - a.count || a.order - b.order);
  const common = rows.filter((row) => row.count >= ROW_MIN_CASES);
  const lessCommon = rows.filter((row) => row.count < ROW_MIN_CASES);
  const focus = common[0]?.count >= FOCUS_MIN_CASES ? common[0].id : null;

  const rated = mistakes.filter((m) => Number.isFinite(m.findChance));
  const easy = {
    easy: rated.filter((m) => m.findChance >= EASY_FIND_CHANCE).length,
    rated: rated.length,
    unrated: mistakes.length - rated.length,
  };

  const phases = Object.fromEntries(PHASES.map((phase) => {
    const reached = games.filter((g) => g.phaseMoves[phase] > 0 && Number.isFinite(g.phaseAccuracy[phase]));
    return [phase, {
      games: reached.length,
      accuracy: weightedMean(reached.map((g) => [g.phaseAccuracy[phase], g.phaseMoves[phase]])),
    }];
  }));
  const overall = weightedMean(games.map((g) => [g.accuracy, g.decisions]));

  const timed = games.filter((g) => g.clock);
  let clock = null;
  if (timed.length) {
    const timedKeys = new Set(timed.map((g) => g.gameKey));
    const timedMistakes = mistakes.filter((m) => timedKeys.has(m.gameKey));
    const lowMoves = timed.reduce((sum, g) => sum + g.clock.lowDecisions, 0);
    const otherMoves = timed.reduce((sum, g) => sum + g.clock.otherDecisions, 0);
    const lowMistakes = timedMistakes.filter((m) => m.lowClock === true).length;
    const otherMistakes = timedMistakes.filter((m) => m.lowClock === false).length;
    clock = {
      games: timed.length, lowMoves, otherMoves, lowMistakes, otherMistakes,
      lowRate: per100(lowMistakes, lowMoves), otherRate: per100(otherMistakes, otherMoves),
    };
  }

  const winning = games.filter((g) => Number.isFinite(g.result) && Number.isFinite(g.maxExpectedScore) &&
    g.maxExpectedScore >= WINNING_SCORE);
  const unconverted = winning.filter((g) => g.result < 1);
  const conversion = { winning: winning.length, unconverted: unconverted.length, gameKeys: unconverted.map((g) => g.gameKey) };

  return {
    ready: true, games: games.length, moves, mistakes: mistakes.length,
    themes: { common, lessCommon, focus }, easy, phases, overall, clock, conversion,
  };
}

/** A puzzle predicate for a report row's Practice button. */
export function reportFilter(kind, value) {
  switch (kind) {
    case "theme": return (puzzle) => puzzle.theme === value;
    case "phase": return (puzzle) => puzzle.phase === value;
    case "lowClock": return (puzzle) => puzzle.lowClock === true;
    case "easy": return (puzzle) => Number.isFinite(puzzle.findChance) && puzzle.findChance >= EASY_FIND_CHANCE;
    case "unconverted": {
      const keys = new Set(value);
      return (puzzle) => keys.has(puzzle.gameKey);
    }
    default: throw new Error(`Unknown report filter: ${kind}`);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `ℹ tests 95`, `ℹ pass 95`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add weakness.js tests/weakness.test.js
git commit -m "feat: cross-game weakness report and practice filters" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Training storage

**Files:**
- Create: `training-store.js`
- Test: `tests/training-store.test.js`

The storage area is a parameter, so tests pass an in-memory fake. `webStorageArea` lets the pages run outside the extension, as in the browser check in Task 12. In the installed extension, the pages always use `storage.local`.

- [ ] **Step 1: Write the failing tests**

Create `tests/training-store.test.js`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_GAMES, TRAINING_VERSION, TrainingVersionError, gameKeyFor, loadTraining, pruneGames, savePuzzle, saveReview,
  saveSettings, webStorageArea,
} from "../training-store.js";

class MemoryArea {
  constructor(initial = {}) {
    this.data = structuredClone(initial);
  }

  async get(keys) {
    if (keys === null) return structuredClone(this.data);
    const list = [].concat(keys).filter((key) => key in this.data);
    return structuredClone(Object.fromEntries(list.map((key) => [key, this.data[key]])));
  }

  async set(entries) {
    Object.assign(this.data, structuredClone(entries));
  }

  async remove(keys) {
    for (const key of [].concat(keys)) delete this.data[key];
  }
}

const gameRecord = (gameKey, reviewedAt) => ({ gameKey, reviewedAt, pgn: "1. e4 *" });
const savedPuzzle = (id, gameKey, mastered = false) => ({
  id, gameKey, schedule: { step: 0, due: mastered ? null : "2026-11-25", mastered },
});

test("a reviewed game and each of its puzzles are stored under their own keys", async () => {
  const area = new MemoryArea({ boardTheme: "slate" });
  await saveReview(area, { game: gameRecord("g1", 1), puzzles: [savedPuzzle("g1:5", "g1"), savedPuzzle("g1:9", "g1")] });
  assert.deepEqual(Object.keys(area.data).sort(), [
    "boardTheme", "training:card:g1:5", "training:card:g1:9", "training:game:g1", "training:version",
  ]);
  const data = await loadTraining(area);
  assert.equal(data.version, TRAINING_VERSION);
  assert.equal(data.writable, true);
  assert.deepEqual([...data.games.keys()], ["g1"]);
  assert.deepEqual([...data.puzzles.keys()].sort(), ["g1:5", "g1:9"]);
  assert.deepEqual(data.settings, {});
});

test("saving a game again deletes puzzles that no longer qualify", async () => {
  const area = new MemoryArea();
  await saveReview(area, { game: gameRecord("g1", 1), puzzles: [savedPuzzle("g1:5", "g1"), savedPuzzle("g1:9", "g1")] });
  await saveReview(area, { game: gameRecord("g1", 1), puzzles: [savedPuzzle("g1:5", "g1")], removedIds: ["g1:9"] });
  assert.deepEqual([...(await loadTraining(area)).puzzles.keys()], ["g1:5"]);
});

test("two pages saving different puzzles from stale copies keep both changes", async () => {
  const area = new MemoryArea();
  await saveReview(area, { game: gameRecord("g1", 1), puzzles: [savedPuzzle("g1:5", "g1"), savedPuzzle("g1:9", "g1")] });
  const reviewTab = await loadTraining(area);
  const practiceTab = await loadTraining(area);
  await savePuzzle(area, { ...practiceTab.puzzles.get("g1:5"), schedule: { step: 1, due: "2026-11-28", mastered: false } });
  await savePuzzle(area, { ...reviewTab.puzzles.get("g1:9"), schedule: { step: 2, due: "2026-12-01", mastered: false } });
  const { puzzles } = await loadTraining(area);
  assert.equal(puzzles.get("g1:5").schedule.step, 1);
  assert.equal(puzzles.get("g1:9").schedule.step, 2);
});

test("data written by a newer version is read-only", async () => {
  const area = new MemoryArea({ "training:version": TRAINING_VERSION + 1 });
  assert.equal((await loadTraining(area)).writable, false);
  await assert.rejects(saveReview(area, { game: gameRecord("g1", 1), puzzles: [] }), TrainingVersionError);
  await assert.rejects(savePuzzle(area, savedPuzzle("g1:5", "g1")), TrainingVersionError);
  assert.deepEqual(Object.keys(area.data), ["training:version"]);
});

test("pruning drops the oldest games and their mastered puzzles but keeps unmastered ones", async () => {
  const area = new MemoryArea({
    "training:game:old": gameRecord("old", 1),
    "training:game:mid": gameRecord("mid", 2),
    "training:game:new": gameRecord("new", 3),
    "training:card:old:5": savedPuzzle("old:5", "old", true),
    "training:card:old:9": savedPuzzle("old:9", "old", false),
    "training:card:mid:5": savedPuzzle("mid:5", "mid", true),
  });
  assert.deepEqual(await pruneGames(area, 2), ["old"]);
  const { games, puzzles } = await loadTraining(area);
  assert.deepEqual([...games.keys()].sort(), ["mid", "new"]);
  assert.deepEqual([...puzzles.keys()].sort(), ["mid:5", "old:9"]);
});

test(`saving a review keeps at most ${MAX_GAMES} games`, async () => {
  const entries = {};
  for (let i = 0; i < MAX_GAMES; i++) entries[`training:game:g${i}`] = gameRecord(`g${i}`, i + 1);
  const area = new MemoryArea(entries);
  await saveReview(area, { game: gameRecord("latest", MAX_GAMES + 1), puzzles: [] });
  const { games } = await loadTraining(area);
  assert.equal(games.size, MAX_GAMES);
  assert.equal(games.has("g0"), false);
  assert.equal(games.has("latest"), true);
});

test("a game is identified by its Chess.com ID or by a fingerprint of its moves", async () => {
  const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  assert.equal(await gameKeyFor({ gameId: "123456789", initialFen: start, history: ["e2e4"] }), "chesscom:123456789");
  const pasted = await gameKeyFor({ gameId: "manual-1", initialFen: start, history: ["e2e4", "e7e5"] });
  assert.match(pasted, /^pgn:[0-9a-f]{16}$/);
  assert.equal(await gameKeyFor({ gameId: "manual-2", initialFen: start, history: ["e2e4", "e7e5"] }), pasted);
  assert.notEqual(await gameKeyFor({ gameId: null, initialFen: start, history: ["d2d4", "e7e5"] }), pasted);
});

test("settings are saved under their own key", async () => {
  const area = new MemoryArea();
  await saveSettings(area, { dailyCap: 30 });
  assert.deepEqual((await loadTraining(area)).settings, { dailyCap: 30 });
});

test("pages opened outside the extension keep the same data in Web Storage", async () => {
  const backing = new Map([["unrelated", "not json"]]);
  const storage = {
    get length() { return backing.size; },
    key: (index) => [...backing.keys()][index] ?? null,
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => backing.set(key, String(value)),
    removeItem: (key) => backing.delete(key),
  };
  const area = webStorageArea(storage);
  await saveReview(area, { game: gameRecord("g1", 1), puzzles: [savedPuzzle("g1:5", "g1")] });
  const data = await loadTraining(area);
  assert.equal(data.games.get("g1").pgn, "1. e4 *");
  assert.deepEqual([...data.puzzles.keys()], ["g1:5"]);
  assert.deepEqual(await area.get("training:version"), { "training:version": TRAINING_VERSION });
  await area.remove("training:card:g1:5");
  assert.equal(backing.has("training:card:g1:5"), false);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test 2>&1 | grep -E "training-store|Cannot find module|fail [1-9]"`
Expected: an error that `../training-store.js` cannot be found.

- [ ] **Step 3: Create `training-store.js`**

```js
// Saved practice data. Each game and each puzzle has its own storage key, so the review page and a
// Practice page can save at the same time without overwriting each other's records.
export const TRAINING_VERSION = 1;
export const MAX_GAMES = 500;

const VERSION_KEY = "training:version";
const GAME_PREFIX = "training:game:";
const PUZZLE_PREFIX = "training:card:";
const SETTINGS_KEY = "practice:settings";

export const gameStorageKey = (gameKey) => `${GAME_PREFIX}${gameKey}`;
export const puzzleStorageKey = (id) => `${PUZZLE_PREFIX}${id}`;

export class TrainingVersionError extends Error {
  constructor() {
    super("Saved practice data is from a newer version of ChessBot.");
    this.name = "TrainingVersionError";
  }
}

/** All saved practice data. `writable` is false when a newer version of ChessBot wrote it. */
export async function loadTraining(area) {
  const all = await area.get(null);
  const version = Number(all[VERSION_KEY] ?? TRAINING_VERSION);
  const games = new Map();
  const puzzles = new Map();
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(GAME_PREFIX)) games.set(value.gameKey, value);
    else if (key.startsWith(PUZZLE_PREFIX)) puzzles.set(value.id, value);
  }
  return { version, writable: version <= TRAINING_VERSION, games, puzzles, settings: { ...(all[SETTINGS_KEY] ?? {}) } };
}

async function assertWritable(area) {
  const stored = (await area.get(VERSION_KEY))[VERSION_KEY];
  if (Number(stored ?? TRAINING_VERSION) > TRAINING_VERSION) throw new TrainingVersionError();
}

/** Save one reviewed game and its puzzles, delete puzzles that no longer qualify, then prune old games. */
export async function saveReview(area, { game, puzzles, removedIds = [] }) {
  await assertWritable(area);
  const entries = { [VERSION_KEY]: TRAINING_VERSION, [gameStorageKey(game.gameKey)]: game };
  for (const puzzle of puzzles) entries[puzzleStorageKey(puzzle.id)] = puzzle;
  await area.set(entries);
  if (removedIds.length) await area.remove(removedIds.map(puzzleStorageKey));
  await pruneGames(area);
}

export async function savePuzzle(area, puzzle) {
  await assertWritable(area);
  await area.set({ [puzzleStorageKey(puzzle.id)]: puzzle });
}

export async function saveSettings(area, settings) {
  await area.set({ [SETTINGS_KEY]: settings });
}

/** Above `limit` games, remove the oldest games and their mastered puzzles. Unmastered puzzles stay. */
export async function pruneGames(area, limit = MAX_GAMES) {
  const { games, puzzles } = await loadTraining(area);
  if (games.size <= limit) return [];
  const dropped = [...games.values()].sort((a, b) => a.reviewedAt - b.reviewedAt)
    .slice(0, games.size - limit).map((game) => game.gameKey);
  const droppedSet = new Set(dropped);
  const keys = dropped.map(gameStorageKey);
  for (const puzzle of puzzles.values()) {
    if (droppedSet.has(puzzle.gameKey) && puzzle.schedule.mastered) keys.push(puzzleStorageKey(puzzle.id));
  }
  await area.remove(keys);
  return dropped;
}

/**
 * A stable game identity: `chesscom:<id>` for Chess.com games, otherwise `pgn:` and the first 16 hex
 * characters of SHA-256 over the starting FEN and the UCI moves, so headers and comments don't matter.
 */
export async function gameKeyFor({ gameId, initialFen, history }) {
  if (/^\d+$/.test(String(gameId ?? ""))) return `chesscom:${gameId}`;
  const bytes = new TextEncoder().encode(`${initialFen} ${history.join(" ")}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `pgn:${hex.slice(0, 16)}`;
}

/** A `storage.local` stand-in over Web Storage, for pages opened outside the extension. */
export function webStorageArea(storage) {
  const read = (key) => {
    const raw = storage.getItem(key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  return {
    async get(keys) {
      const list = keys === null || keys === undefined
        ? Array.from({ length: storage.length }, (_, index) => storage.key(index))
        : [].concat(keys);
      const result = {};
      for (const key of list) {
        const value = read(key);
        if (value !== undefined) result[key] = value;
      }
      return result;
    },
    async set(entries) {
      for (const [key, value] of Object.entries(entries)) storage.setItem(key, JSON.stringify(value));
    },
    async remove(keys) {
      for (const key of [].concat(keys)) storage.removeItem(key);
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `ℹ tests 106`, `ℹ pass 106`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add training-store.js tests/training-store.test.js
git commit -m "feat: per-key training storage with versioning and pruning" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Record reviews from the review page

**Files:**
- Modify: `review.js` (imports, `state`, `dom`, `loadGameFromPayload`, `runFullAnalysis`, `bootstrap`, and new functions `recordReviewedGame`, `refreshPracticeBadge`, `showTrainingNotice`)
- Modify: `review.html` (Practice link, save notice)
- Modify: `review.css` (`a.btn`, `.training-notice`)
- Modify: `scripts/build.mjs`

A re-review keeps the game's original `reviewedAt`, so reopening the review page doesn't reorder the report window. The review page re-analyzes the stored `activeGame` each time it opens.

- [ ] **Step 1: Add imports and the storage area**

In `review.js`, add after the `drills.js` import:

```js
import { dueCount, localDate, puzzlesFromDecisions } from "./deck.js";
import { gameAccuracy, gameDate, summarizeGame, userDecisions, userResult } from "./weakness.js";
import { gameKeyFor, loadTraining, saveReview, webStorageArea } from "./training-store.js";
```

Below `const extension = globalThis.browser ?? globalThis.chrome;`, add:

```js
const trainingArea = extension?.storage?.local ?? webStorageArea(globalThis.localStorage);
```

- [ ] **Step 2: Extend `state` and `dom`**

In `state`, add after `gameMeta: null,`:

```js
  gameHeaders: null,
```

In `dom`, add after `settingsBtn: document.getElementById("settingsBtn"),`:

```js
  practiceDueBadge: document.getElementById("practiceDueBadge"),
  trainingNotice: document.getElementById("trainingNotice"),
```

- [ ] **Step 3: Keep the PGN headers when a game loads**

In `loadGameFromPayload`, after `const { headers, positions } = game;`, add:

```js
  state.gameHeaders = headers;
  dom.trainingNotice.classList.add("hidden");
```

- [ ] **Step 4: Add the recording functions**

Insert above `async function runFullAnalysis() {`:

```js
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

/**
 * The user's side when it is known: chosen in Load PGN, reopened from the Practice page, or matched
 * to the Chess.com username. A Chess.com game where neither player matches isn't the user's game.
 */
function confirmedColor(meta) {
  if (meta.colorConfirmed) return meta.playedColor;
  const user = (meta.username || "").trim().toLowerCase();
  if (user && meta.white?.username?.toLowerCase() === user) return "w";
  if (user && meta.black?.username?.toLowerCase() === user) return "b";
  return null;
}

/** Save the finished review's summary and the user's mistakes as practice puzzles. */
async function recordReviewedGame(runId, depth) {
  const meta = state.gameMeta;
  const playedColor = meta ? confirmedColor(meta) : null;
  if (!meta?.pgn || !playedColor) return;
  try {
    const data = await loadTraining(trainingArea);
    if (!data.writable || runId !== state.analysisRunId) return;

    const { initialFen, history } = state.positions.at(-1).searchOptions;
    const gameKey = await gameKeyFor({ gameId: meta.gameId, initialFen, history });
    const today = localDate();
    const source = { positions: state.positions, evals: state.evals, moveReviews: state.moveReviews, playedColor };
    const decisions = userDecisions(source);
    const opponent = (playedColor === "w" ? meta.black : meta.white)?.username ?? "";
    const date = gameDate({ endTime: meta.endTime, headers: state.gameHeaders ?? {} }, today);
    const summary = summarizeGame({
      gameKey,
      reviewedAt: data.games.get(gameKey)?.reviewedAt ?? Date.now(),
      date,
      color: playedColor,
      result: userResult(meta.result, playedColor),
      timeClass: meta.timeClass,
      opponent,
      depth,
      decisions,
      ...gameAccuracy(source),
    });
    const existing = [...data.puzzles.values()].filter((puzzle) => puzzle.gameKey === gameKey);
    const { puzzles, removedIds } = puzzlesFromDecisions({
      gameKey, color: playedColor, opponent, gameDate: date, decisions, today, existing,
    });
    const game = {
      ...summary,
      gameId: meta.gameId ?? null,
      pgn: meta.pgn,
      timeControl: meta.timeControl ?? null,
      endTime: meta.endTime ?? null,
    };
    await saveReview(trainingArea, { game, puzzles, removedIds });
    if (runId === state.analysisRunId) await refreshPracticeBadge();
  } catch {
    if (runId === state.analysisRunId) showTrainingNotice("Couldn't save practice puzzles from this game.");
  }
}
```

- [ ] **Step 5: Call it when a review finishes**

In `runFullAnalysis`, inside the `try` block, change the final lines from:

```js
    updateDrillBadgeCount();
    goToPly(state.currentPly, false);
  } catch (err) {
```

to:

```js
    updateDrillBadgeCount();
    goToPly(state.currentPly, false);
    recordReviewedGame(runId, depth);
  } catch (err) {
```

- [ ] **Step 6: Open a saved game at a move from the Practice page**

Replace `bootstrap` with:

```js
async function bootstrap() {
  await loadSavedSettings();
  initBoard("w");
  renderBreakdownTable();
  refreshPracticeBadge();

  // The Practice page links here with ?game=<gameKey>&ply=<ply> to open a saved game at that move.
  const params = new URLSearchParams(location.search);
  const requestedGame = params.get("game");
  if (requestedGame) {
    try {
      const record = (await loadTraining(trainingArea)).games.get(requestedGame);
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
        return;
      }
    }
  } catch {
    // Ignore outside extension context
  }

  dom.gameMetaSubtitle.textContent = "Finish a game on Chess.com or click Load PGN to begin";
  openPgnModal();
}
```

- [ ] **Step 6b: Mark the side as confirmed in Load PGN**

In the `loadPgnConfirmBtn` click handler, the user picks their side, so add `colorConfirmed: true` to the payload:

```js
  const payload = {
    gameId: `manual-${Date.now()}`,
    pgn,
    playedColor: dom.pgnColorSelect.value,
    colorConfirmed: true,
    timeClass: "Custom PGN",
  };
```

Chess.com games are recorded only when the signed-in username matches one of the players, because `detectPlayedColor` in `background.js` falls back to White when neither matches.

- [ ] **Step 7: Add the Practice link and save notice to `review.html`**

In `review.html`, insert this before the `soundToggleBtn` button inside `.topbar-controls`:

```html
      <a id="practiceBtn" class="btn btn-secondary" href="./practice.html" title="Practice puzzles from your reviewed games">
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>
        <span>Practice</span>
        <span id="practiceDueBadge" class="tab-count hidden">0</span>
      </a>
```

Insert this after the closing `</div>` of `progressBarWrap`:

```html
  <p id="trainingNotice" class="training-notice hidden" role="status"></p>
```

- [ ] **Step 8: Style them in `review.css`**

Append to `review.css`:

```css
/* Practice link and the practice save notice */
a.btn {
  text-decoration: none;
}

.training-notice {
  max-width: 1320px;
  margin: 8px auto 0;
  padding: 0 24px;
  color: var(--warning);
  font-size: 12.5px;
}
```

- [ ] **Step 9: Package the new modules**

In `scripts/build.mjs`, add `"deck.js"` after `"decision-quality.js"`, `"training-store.js"` after `"tactics.js"`, and `"weakness.js"` after `"variation.js"` in the `files` array.

Run: `grep -o '"[a-z-]*\.js"' scripts/build.mjs | tr '\n' ' '`
Expected: the list includes `"board-setup.js"`, `"deck.js"`, `"training-store.js"`, and `"weakness.js"`.

- [ ] **Step 10: Test and build**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `ℹ tests 106`, `ℹ pass 106`, `ℹ fail 0`.

Run: `npm run build`
Expected: both zips build with no errors.

- [ ] **Step 11: Commit**

```bash
git add review.js review.html review.css scripts/build.mjs
git commit -m "feat: save reviewed games and mistakes for practice" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The Practice page

**Files:**
- Create: `practice.html`, `practice.css`, `practice.js`
- Modify: `scripts/build.mjs`

- [ ] **Step 1: Create `practice.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ChessBot Practice</title>
  <link rel="icon" type="image/svg+xml" href="./icons/icon.svg" />
  <link rel="stylesheet" href="./vendor/cm-chessboard/assets/chessboard.css" />
  <link rel="stylesheet" href="./vendor/cm-chessboard/assets/extensions/arrows/arrows.css" />
  <link rel="stylesheet" href="./vendor/cm-chessboard/assets/extensions/markers/markers.css" />
  <link rel="stylesheet" href="./vendor/cm-chessboard/assets/extensions/promotion-dialog/promotion-dialog.css" />
  <link rel="stylesheet" href="./review.css" />
  <link rel="stylesheet" href="./practice.css" />
</head>
<body>
  <header class="topbar">
    <div class="topbar-left">
      <img src="./icons/icon.svg" alt="" class="brand-icon" />
      <div class="brand-text">
        <div class="brand-title-row">
          <h1>Practice</h1>
        </div>
        <span id="practiceSubtitle" class="game-meta">Loading your puzzles…</span>
      </div>
    </div>

    <div class="topbar-controls">
      <label class="depth-control" for="dailyCapInput">
        <span>Daily puzzles</span>
        <input id="dailyCapInput" class="cap-input" type="number" min="1" max="200" step="1" value="20" />
      </label>
      <a class="btn btn-secondary" href="./review.html">Back to review</a>
    </div>
  </header>

  <p id="practiceNotice" class="practice-notice hidden" role="status"></p>

  <main class="studio">
    <section class="board-column">
      <div class="board-frame">
        <div class="board-stage">
          <div id="boardThemeWrap" class="board-container-wrap theme-emerald">
            <div id="board" class="chessboard-mount"></div>
          </div>
        </div>
      </div>
    </section>

    <aside class="inspector">
      <nav class="sidebar-tabs practice-tabs" role="tablist">
        <button id="tabSessionBtn" class="tab-btn active" type="button" role="tab" aria-selected="true">
          Today <span id="dueCount" class="tab-count">0</span>
        </button>
        <button id="tabReportBtn" class="tab-btn" type="button" role="tab" aria-selected="false">
          Weaknesses
        </button>
      </nav>

      <div id="panelSession" class="tab-panel">
        <div class="inspector-scroll drill-panel">
          <div class="drill-top-row">
            <span id="sessionBadge" class="drill-badge">DAILY REVIEW</span>
            <strong id="sessionCounter"></strong>
          </div>
          <p id="puzzleContext" class="puzzle-context"></p>
          <p id="puzzlePrompt" class="drill-prompt hidden"></p>

          <div id="puzzleControls" class="drill-controls hidden">
            <button id="hintBtn" class="btn btn-secondary" type="button">Hint</button>
            <button id="revealBtn" class="btn btn-secondary" type="button">Show Answer</button>
            <button id="showLineBtn" class="btn btn-secondary hidden" type="button">Show line</button>
            <a id="openGameLink" class="btn btn-secondary hidden" href="./review.html">Open game</a>
            <button id="nextBtn" class="btn btn-primary-cta hidden" type="button">Next →</button>
          </div>

          <div id="sessionDone" class="drill-done hidden">
            <h3 id="sessionDoneTitle">Done for today</h3>
            <p id="sessionDoneText"></p>
            <button id="backToDailyBtn" class="btn btn-secondary hidden" type="button">Back to today's puzzles</button>
          </div>
        </div>
      </div>

      <div id="panelReport" class="tab-panel hidden">
        <div id="reportBody" class="inspector-scroll report"></div>
      </div>
    </aside>
  </main>

  <script type="module" src="./practice.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `practice.css`**

```css
/* Practice page layout and the weakness report. Shared tokens and components come from review.css. */
.practice-tabs {
  grid-template-columns: repeat(2, 1fr);
}

.practice-notice {
  max-width: 1320px;
  margin: 10px auto 0;
  padding: 0 24px;
  color: var(--warning);
  font-size: 12.5px;
}

.cap-input {
  width: 58px;
  background: transparent;
  color: var(--text);
  border: none;
  font: inherit;
  font-weight: 600;
  outline: none;
}

.puzzle-context {
  font-size: 12px;
  color: var(--text-muted);
}

.report-summary,
.report-empty {
  font-size: 12.5px;
  color: var(--text-secondary);
}

.report-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.report-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.report-row.focus {
  border-color: var(--accent);
}

.report-row-title {
  font-weight: 600;
}

.report-row-meta {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-muted);
}

.report-row .btn {
  flex-shrink: 0;
}

.focus-badge {
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 700;
  color: #c2e59d;
  background: rgba(129, 182, 76, 0.14);
}
```

- [ ] **Step 3: Create `practice.js`**

```js
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
  state.queue = startQueue(buildSession(allPuzzles(), { today, cap: dailyCap(), filter }));
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
    state.skipped++;
    state.queue = advanceQueue(state.queue, OUTCOMES.unverified);
    loadCurrentPuzzle();
    return;
  }
  Object.assign(state, { puzzle, game, outcome: null, finished: false, checking: false });

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
    setPrompt(`Checking ${san} with Stockfish…`);
    try {
      // Moves in the saved lines are compared without a search, so this works even without Stockfish.
      const comparison = await compareRootMoves(await readyEngine(), puzzlePosition(puzzle), uci, puzzle.depth, puzzle.root);
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
  dom.controls.classList.add("hidden");
  dom.puzzlePrompt.classList.add("hidden");
  dom.puzzleContext.textContent = "";
  dom.sessionCounter.textContent = "";
  dom.backToDailyBtn.classList.toggle("hidden", state.mode === "daily");
  dom.done.classList.remove("hidden");

  const puzzles = allPuzzles();
  const due = dueCount(puzzles, today);
  const upcoming = puzzles.map((p) => p.schedule.due).filter((date) => date && date > today).sort()[0];
  const later = upcoming ? ` Your next puzzles are due on ${upcoming}.` : "";
  const attempted = state.queue.firstPass - state.skipped;
  let title;
  let text;
  if (!puzzles.length) {
    title = "No puzzles yet";
    text = "Review a game, and your Mistakes, Misses, and Blunders come back here as puzzles the next day.";
  } else if (attempted > 0) {
    title = state.mode === "daily" ? "Done for today" : "Practice complete";
    text = `You solved ${state.solvedFirstTry} of ${attempted} on the first try.${state.mode === "daily" ? later : ""}`;
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
  recordOutcome(OUTCOMES.fail);
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
  const value = Math.round(Number(dom.capInput.value));
  const cap = Number.isFinite(value) ? Math.min(MAX_DAILY_CAP, Math.max(1, value)) : DEFAULT_DAILY_CAP;
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
  renderReport();
  startSession();
  readyEngine();
}

init();
```

- [ ] **Step 4: Package the Practice page**

In `scripts/build.mjs`, add `"practice.css", "practice.html", "practice.js"` after `"practical-model.js"` in the `files` array.

- [ ] **Step 5: Test and build**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `ℹ tests 106`, `ℹ pass 106`, `ℹ fail 0`.

Run: `npm run build && unzip -l dist/chessbot-chrome-v3.4.0.zip | grep -E "practice|deck|weakness|training-store|board-setup"`
Expected: `board-setup.js`, `deck.js`, `practice.css`, `practice.html`, `practice.js`, `training-store.js`, and `weakness.js` are all listed.

- [ ] **Step 6: Commit**

```bash
git add practice.html practice.css practice.js scripts/build.mjs
git commit -m "feat: Practice page with daily review, theme practice, and weakness report" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Browser check

**Files:** none changed, unless the check finds a bug. Fix bugs in their own commits with a regression test where the logic is in a pure module.

Use the browser tool (Playwright MCP or the built-in browser pane). The pages run from a local server, so they store data in `localStorage` through `webStorageArea`.

- [ ] **Step 1: Serve a fresh build**

Run: `npm run build`

Run in the background: `python3 -m http.server 8765 --bind 127.0.0.1 --directory dist/chrome`

Open `http://127.0.0.1:8765/review.html`. Run `localStorage.clear()` in the page, then reload.

- [ ] **Step 2: Review a game and confirm puzzles are saved**

Set **Depth** to 12. Choose **Load PGN**, pick **Black**, paste the PGN below, and select **Analyze Game**. Wait for "Stockfish 19 review complete".

```
[Event "Paris Opera"]
[Site "Paris FRA"]
[Date "1858.??.??"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0
```

Run in the page:

```js
Object.keys(localStorage).filter((key) => key.startsWith("training:")).sort()
```

Expected:
- One `training:game:pgn:…` key, `training:version`, and one `training:card:…` key per Black Mistake, Miss, or Blunder. Compare the card count with the Mistakes tab badge.
- The header **Practice** link has no badge, because nothing is due today.

- [ ] **Step 3: Today's empty state, then tomorrow's session**

Select **Practice**. Expected: "Nothing due today" and "Your next puzzles are due on <tomorrow>".

Get tomorrow's date with `date -v+1d +%F`. Open `http://127.0.0.1:8765/practice.html?today=<tomorrow>`. Expected: "Puzzle 1 of N" with the board facing Black and the opponent's last move highlighted.

Read the answer for the current puzzle:

```js
Object.entries(localStorage).filter(([key]) => key.startsWith("training:card:"))
  .map(([, value]) => JSON.parse(value)).map((p) => ({ id: p.id, best: p.best.uci, game: p.gameMove.uci, fen: p.fen }))
```

Make moves by clicking the from-square, then the to-square (`#board [data-square="e7"]`, for example).

1. **Correct answer:** play the current puzzle's `best` move. Expected: a "Great find!" message, a green arrow, and **Next →**. Its stored schedule now has `step: 1` and `due` three days after `<tomorrow>`.
2. **Wrong answer:** on the next puzzle, play the `game` move. Expected: "That's the … you played in the game", with the piece returning. The stored schedule has `step: 0`, `lapses: 1`, and `due` one day after `<tomorrow>`.
3. **Hint:** on another puzzle (load a session with 3 or more puzzles, or reset a card's `due` in `localStorage`), select **Hint**. Expected: a circle on the best move's starting square and the hint text. That puzzle's stored `lastResult` is `"fail"`.
4. After the last first-pass puzzle, each failed puzzle comes back once, marked "One more try". Solving it doesn't change its stored schedule again.
5. The final card reads "Done for today" and "You solved X of Y on the first try."

- [ ] **Step 4: Theme practice and the report**

Inject five fixture games, then reload `practice.html?today=<tomorrow>`:

```js
(() => {
  const themes = ["hanging", "hanging", "allowed-tactic", "missed-material", "hanging"];
  for (let i = 0; i < 5; i++) {
    const gameKey = `fixture:${i}`;
    localStorage.setItem(`training:game:${gameKey}`, JSON.stringify({
      gameKey, reviewedAt: Date.now() - (i + 1) * 1000, date: "2026-11-20", color: "w", result: i === 0 ? 0.5 : 1,
      timeClass: "blitz", opponent: `Fixture ${i}`, depth: 12, decisions: 30,
      phaseMoves: { opening: 8, middlegame: 16, endgame: 6 }, phaseAccuracy: { opening: 92, middlegame: 81, endgame: 70 },
      accuracy: 82, clock: { lowDecisions: 4, otherDecisions: 26 }, maxExpectedScore: 90,
      mistakes: [{ ply: 21, theme: themes[i], phase: "middlegame", lowClock: i % 2 === 0, findChance: 75 }],
      gameId: null, pgn: "1. e4 e5 *", timeControl: null, endTime: null,
    }));
  }
})();
```

Open **Weaknesses**. Expected:
- "Based on 6 games and … of your moves."
- "Mistakes by type" lists "Left a piece hanging" (3 or more times) without "Your main focus", unless the real game adds two more.
- Sections for Easy or hard, Game phase, Low on time, and Converting wins. Converting wins reads "1 of 5 games", because only the fixtures reached a winning position and fixture 0 drew.

Select a **Practice these** button that has open puzzles (the real game's themes). Expected: the badge reads `PRACTICE · <LABEL>`, and only matching puzzles appear. At the end, **Back to today's puzzles** returns to the daily review.

- [ ] **Step 5: Open game**

After any puzzle, select **Open game**. Expected: the review page loads the Opera Game, shows the puzzle's move in the coach card, and starts analysis. When the review finishes, the game record keeps its original `reviewedAt`:

```js
JSON.parse(localStorage.getItem(Object.keys(localStorage).find((key) => key.startsWith("training:game:pgn:")))).reviewedAt
```

- [ ] **Step 6: Review-page regression**

On the review page, the **Mistakes** tab drill still works: solving shows the same "Great find!" or "Nice!" text as before. The promotion check from Task 1, Step 6 still passes. The console shows no errors from ChessBot files.

- [ ] **Step 7: Stop the server**

Stop the background `http.server`.

---

### Task 13: Version 3.5.0 and documentation

**Files:**
- Modify: `package.json`, `package-lock.json`, `browsers/chrome/manifest.json`, `browsers/firefox/manifest.json`
- Modify: `CHANGELOG.md`, `README.md`, `docs/methodology.md`, `SECURITY.md`

- [ ] **Step 1: Bump the version**

Run:

```bash
sed -i '' 's/"version": "3.4.0"/"version": "3.5.0"/' package.json browsers/chrome/manifest.json browsers/firefox/manifest.json
npm install --package-lock-only --ignore-scripts
grep -n '"version"' package.json browsers/*/manifest.json && grep -n '"version": "3.5.0"' package-lock.json | head -2
```

Expected: all three files show `3.5.0`, and the lock file shows `3.5.0` for the root package.

- [ ] **Step 2: Update `CHANGELOG.md`**

Replace the `## [Unreleased]` section and its two subsections with the block below. Use today's date from `date +%F`. The repository-setup entries already shipped with PR #1 on `main`, so they move under 3.5.0 too.

```markdown
## [Unreleased]

## [3.5.0] - <today>

### Added

- **Practice page** with a spaced review of your own mistakes. Every Mistake, Miss, and Blunder from a reviewed game becomes a puzzle that comes back after 1, 3, 7, 21, and 60 days, mixed across games. A wrong first try, a hint, or Show Answer sends a puzzle back to one day. The daily limit defaults to 20 puzzles.
- **Weakness report** across your 50 most recently reviewed games: mistakes by type, mistakes in easy positions, accuracy by game phase, mistakes when low on time, and winning positions you didn't convert. Each finding links to matching puzzles.
- **Practice** link in the review header, with the number of puzzles due.
- Repository documentation: license, contributing guide, security policy, code of conduct, issue and pull request templates.
- Continuous integration that runs the test suite on Node.js 24 and 26 and builds both browser packages.

### Changed

- The review page and the Practice page share one board setup and one set of drill messages.
- The README is now an overview. Scoring details moved to [docs/methodology.md](docs/methodology.md), and benchmark results moved to [docs/benchmarks.md](docs/benchmarks.md).
- The browser packages include the project license.
```

Then update the link references at the bottom of the file to:

```markdown
[Unreleased]: https://github.com/FrankieBiz/ChessBot/compare/v3.5.0...HEAD
[3.5.0]: https://github.com/FrankieBiz/ChessBot/compare/v3.4.0...v3.5.0
[3.4.0]: https://github.com/FrankieBiz/ChessBot/compare/v3.3.0...v3.4.0
[3.3.0]: https://github.com/FrankieBiz/ChessBot/releases/tag/v3.3.0
```

- [ ] **Step 3: Update `README.md`**

In **Features**, insert after the **Practice drills** bullet:

```markdown
- **Spaced practice from your own games.** Every Mistake, Miss, and Blunder you make is saved as a puzzle on the Practice page and comes back after 1, 3, 7, 21, and 60 days, mixed across games. Testing yourself on a spaced schedule is one of the two study methods with the strongest research support.
- **Weakness report.** Across your reviewed games, see which kinds of mistakes you make most, how many come in easy positions, how each game phase goes, what happens when you're low on time, and which won games slipped away. Each finding links to matching puzzles.
```

In **Usage**, add:

```markdown
- **Practice:** select **Practice** in the review header. Puzzles from a game first come due the day after you review it.
```

In **Privacy**, add:

```markdown
- Practice puzzles and the weakness report are stored in the browser's extension storage on your computer.
```

In **Project structure**, add these rows after the `drills.js`, `variation.js` row:

```markdown
| `practice.html`, `practice.js`, `practice.css` | The Practice page: daily review, theme practice, and the weakness report |
| `deck.js`, `weakness.js`, `training-store.js` | Spaced-review schedule, weakness report, and saved practice data |
| `board-setup.js` | The board and promotion picker shared by both pages |
```

- [ ] **Step 4: Add a section to `docs/methodology.md`**

Insert before `## Optional AI explanations`:

```markdown
## Practice deck and weakness report

Each finished review saves the game and turns every Mistake, Miss, and Blunder by your side into a puzzle. Forced moves are excluded, as in the Mistakes tab. A puzzle keeps the position, the moves that led to it, Stockfish's lines, and the review depth, so the Practice page judges answers with the same rules: Stockfish's move and qualifying mates are accepted at once, and other moves are checked live and accepted within three expected-score points. A missed-mate puzzle needs a mate at least as fast.

A new puzzle first comes due the day after the review. A first-try solve moves it to the next interval of 1, 3, 7, 21, and 60 days, and passing the 60-day review masters it. A wrong first try, a hint, or Show Answer sends it back to one day. Sessions take the most overdue puzzles up to the daily limit and avoid two puzzles in a row from the same game, then from the same mistake type. The schedule rests on two of the best-supported findings in learning research: testing yourself, and spacing practice over time. [Dunlosky et al., 2013](https://doi.org/10.1177/1529100612453266)

The weakness report covers your 50 most recently reviewed games once you have reviewed five. Each mistake gets one type from the coach's tag. A type appears in the main list after three cases and is marked as your main focus after five. A mistake counts as easy when the cohort difficulty model estimates that at least 70% of players find a sound move. A clock is low under 10% of the starting time or 15 seconds, whichever is larger, and only games with recorded clocks count. A game counts as unconverted when your expected score reached 85 before one of your moves and you didn't win. The report shows counts and sample sizes, not statistical tests.
```

- [ ] **Step 5: Update `SECURITY.md`**

Change the supported-versions rows to:

```markdown
| 3.5.x | Yes |
| Earlier | No |
```

- [ ] **Step 6: Final verification**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `ℹ tests 106`, `ℹ pass 106`, `ℹ fail 0`.

Run: `npm run build && ls dist/*v3.5.0.zip && unzip -p dist/chessbot-chrome-v3.5.0.zip manifest.json | grep '"version"'`
Expected: both v3.5.0 zips exist, and the manifest shows `"version": "3.5.0"`.

Run: `git status --short`
Expected: only the files in this task are modified.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json browsers/chrome/manifest.json browsers/firefox/manifest.json CHANGELOG.md README.md docs/methodology.md SECURITY.md
git commit -m "chore: release notes and docs for v3.5.0" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Hand off**

Report the test count, the browser-check results, and anything that didn't match this plan. Ask the user before pushing `feat/practice-deck` or opening a pull request.
