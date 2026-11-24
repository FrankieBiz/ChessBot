# Practice Deck and Weakness Report — Design

Date: 2026-11-24
Status: Design approved; spec review passed; awaiting user review of this document
Target release: v3.5.0

## Goal

Turn ChessBot from a one-game reviewer into a training tool that follows the study methods with the best support:

1. **Spaced mistake deck.** Every Mistake, Miss, and Blunder the user makes becomes a saved puzzle that returns on a spaced schedule.
2. **Weakness report.** Aggregates the user's mistakes across reviewed games and links each finding to targeted practice.

## Evidence behind the choice

- Practice testing (self-testing) and distributed practice are the only two techniques rated high utility in Dunlosky et al. (2013), *Improving Students' Learning With Effective Learning Techniques*, Psychological Science in the Public Interest 14(1).
- Serious solitary study was the strongest practice predictor of chess skill in Charness, Tuffiash, Krampe, Reingold & Vasyukova (2005), Applied Cognitive Psychology 19.
- Players and coaches consistently recommend reviewing one's own games and drilling tactics from one's own mistakes over random puzzles. Cross-game weakness reports (Aimchess, Lichess Insights) are popular, but their evidence is thin.
- No controlled study shows that a specific chess training tool raises rating. The design therefore reports counts and sample sizes and makes no claims of effect.

Rejected for this release: analyze-yourself-first mode, threat-check drills, play-out-vs-engine, Woodpecker-style repetition, opening memorization, adaptive (FSRS) scheduling, deck export/import, cross-player comparisons, progress charts.

## Decisions

| Question | Decision |
| --- | --- |
| Where it lives | A separate Practice page (`practice.html`), opened from a **Practice** button in the review header that shows the number of puzzles due. |
| Which games feed it | Only games the user reviews in ChessBot. Nothing runs in the background. Games reviewed before v3.5.0 are not imported. |
| How answers are judged | Live Stockfish, using the same rules as the existing Mistakes tab (`judgeDrillAttempt`, `compareRootMoves`). |
| Schedule | Fixed intervals: 1, 3, 7, 21, 60 days. |

## Part 1: The mistake deck

### Which decisions become puzzles

When a review finishes, a puzzle is created for every decision that the existing Mistakes tab would drill (`getPlayerMistakePlies` in `review.js`):

- The move was made by the user's side (`gameMeta.playedColor`).
- It is graded `mistake`, `miss`, or `blunder`.
- It is not forced (the review sets `forced`).

### Puzzle record

Each puzzle is identified by `<gameKey>:<ply>`. `gameKey` is defined under *Game identity*.

| Field | Contents |
| --- | --- |
| `id`, `gameKey`, `ply`, `color` | Identity. `color` is the user's side. |
| `fen` | Position before the user's move. |
| `initialFen`, `history` | The game's starting FEN and the UCI moves before this position. These rebuild `position.searchOptions` for Stockfish and the repetition check (`describeVariation`). |
| `gameMove` | `{ uci, san }` of the move played. |
| `best` | `{ uci, san, line }`, where `line` is Stockfish's principal variation in SAN, at most 8 plies. |
| `grade`, `winLoss`, `missedMate`, `depth` | Copied from the review (`classification.key`, `winLoss`, `missedMate`, `depth`). |
| `root` | The stored root evaluation passed to `compareRootMoves` as `root`: `{ eval, winWhite, lines }`, with each line's `pv` truncated to 8 plies. |
| `theme` | The weakness-report row ID (Part 2) derived from the coach tag. |
| `phase` | `opening`, `middlegame`, or `endgame`, from the position before the move. |
| `lowClock` | `true` or `false` under the Part 2 rule, or `null` when the game has no clock data. |
| `findChance` | The cohort find-rate estimate (`estimateDifficulty(...).chance`), or `null` when unsupported. |
| `schedule` | `{ step, due, mastered, attempts, lapses, lastResult }`. |
| `createdAt` | Local date the puzzle was created (`YYYY-MM-DD`). |

When a game is reviewed again, its puzzles are rebuilt from the new review but keep their existing `schedule`. A decision that is no longer graded Mistake, Miss, or Blunder has its puzzle removed. A newly graded decision gets a new puzzle.

### Schedule

- Intervals `I = [1, 3, 7, 21, 60]` days. All dates are local calendar dates (`YYYY-MM-DD`), not 24-hour periods.
- **New puzzle:** `step = 0`, `due = reviewDate + I[0]`.
- **Pass** (first attempt in the session accepted, with no hint or answer shown) at step `s`:
  - If `s = 4`, the puzzle becomes `mastered`.
  - Otherwise `step = s + 1` and `due = today + I[s + 1]`.
- **Fail** (first attempt rejected, or Hint or Show Answer used before the first attempt): `step = 0`, `due = today + 1`, and `lapses` increases by one.
- **Unverified** (Stockfish could not check a non-best move): no change, and the puzzle stays due.
- Mastered puzzles never appear in sessions. They still count in the report, and the Practice page can reset one to `step = 0`, due tomorrow.

### Daily session

1. Select puzzles with `due ≤ today` that are not mastered. Sort them by `due` ascending, then `createdAt`.
2. Take the first `dailyCap` puzzles. The default is 20, adjustable on the Practice page. The rest stay due.
3. Interleave: reorder greedily so that consecutive puzzles avoid the same game first and the same theme second, whenever another puzzle allows it.
4. A failed puzzle is appended once to the end of the session queue. The repeat does not count toward `dailyCap` and does not change the schedule again.

### Theme practice

A session filtered by a report row (theme, phase, low clock, easy positions, or unconverted games) includes matching puzzles that are not mastered, due ones first, capped at `dailyCap`. A due puzzle follows the normal schedule. A puzzle that is not yet due does not move forward on a pass, but a fail resets it as above.

### Puzzle screen

- The board is oriented to the user's side, with the opponent's last move highlighted.
- The prompt reuses `drillPrompt` and adds the opponent and game date.
- Judging follows `judgeDrillAttempt`. The best move, a mate that is at least as fast where a missed mate is the target, and repeating the game move are decided instantly. Other moves call `compareRootMoves(engine, position, attemptUci, puzzle.depth, puzzle.root)` and are accepted within `DRILL_ACCEPT_LOSS` (3) points.
- Hint uses `drillHint`. Show Answer plays `best.line`.
- After an answer, the user can step through Stockfish's line or select **Open game**. This opens `review.html?game=<gameKey>&ply=<ply>`, which loads the stored PGN, runs the normal review, and moves to that ply when its analysis is ready. The link is hidden if the game record has been pruned.

## Part 2: The weakness report

### Window and minimums

- The report appears once the user has reviewed at least 5 games.
- It covers the 50 most recently reviewed games (by `reviewedAt`).
- The header states the sample size, for example "12 games, 418 of your moves". *Moves* means the user's non-forced decisions.

### Rows

**1. Mistakes by type.** Each Mistake, Miss, and Blunder gets exactly one theme from its coach tag (`generateLocalCoachInsight(...).tag`):

| Row ID | Label | Coach tags |
| --- | --- | --- |
| `hanging` | Left a piece hanging | Hanging Piece |
| `allowed-tactic` | Allowed a tactic | Engine Capture |
| `allowed-mate` | Allowed checkmate | Missed Defense |
| `missed-material` | Missed winning material | Missed Tactic |
| `missed-mate` | Missed checkmate | Missed Mate |
| `missed-refutation` | Didn't punish a mistake | Missed Refutation |
| `missed-forcing` | Missed a check or promotion | Missed Check, Promotion |
| `positional` | No single tactic | Critical Error, Positional Slip |

- Any tag not in this table maps to `positional`. A unit test enumerates every tag `coach.js` can return for these grades, so a new tag fails the test until it is mapped.
- Each row shows its count, the number of games it occurred in, and its rate per 100 moves.
- Rows are sorted by count. Rows with fewer than 3 cases go under **Less common**.
- The top row is labeled **Your main focus** only when it has at least 5 cases.

**2. Easy or hard.** Shows the share of mistakes with `findChance ≥ 70`. Mistakes with a `null` find chance are excluded, and the denominator is shown.

**3. Game phase.** Shows accuracy in each phase and overall, aggregated across games as averages of per-game values (`computeGameInsights`, `computeProGameAccuracy`), weighted by the number of the user's moves in that phase. Each phase states how many games reached it.

**4. Low on time.**
- The user's clock before a move is the remaining time recorded after their previous move, from `practicalContext`.
- A move is low-clock when that time is under `max(15 s, 10% of the base time)`.
- The row compares the mistake rate per 100 moves on low-clock moves with the rate on other moves.
- It uses only games whose review recorded clocks. The review parses clocks only for standard-start games with a time control that `parseTimeControl` supports. The number of such games is shown.

**5. Converting wins.**
- A game counts when the user's expected score, measured before one of their own decisions, reached 85 or more, and the result was not a win for the user.
- The row shows "N of M games: you were winning but drew or lost." M is the number of games that reached 85 or more.
- Games with an unknown result (`result` is `null`) are left out of both N and M.

Every row has a **Practice these** button that starts a theme-practice session with the matching puzzles.

### Game summary record

Stored per reviewed game: `gameKey`, `reviewedAt`, `date` (from PGN `UTCDate`/`Date` headers, otherwise the review date), `color`, `result` (1, ½, or 0 for the user, or `null` if unknown), `timeClass`, `opponent`, `depth`, `decisions`, `phaseMoves`, `phaseAccuracy`, `accuracy`, `clock` (`{ lowDecisions, otherDecisions }` or `null`), `maxExpectedScore`, and `mistakes` (`[{ ply, theme, phase, lowClock, findChance }]`). The game record also stores `pgn` and the user's color so **Open game** can reload it.

### Game identity

- Chess.com games use `chesscom:<gameId>` from the loaded payload.
- Pasted PGNs use `pgn:<first 16 hex characters of SHA-256 of initialFen + " " + the UCI move list>`. The same game pasted twice is recognized regardless of headers or comments.
- The same game reviewed once from Chess.com and once as a pasted PGN gets two identities and duplicate puzzles. This is accepted for v3.5.0.
- **Open game** rebuilds the review from the stored PGN text and color. Clocks, time control, and ratings come from the PGN headers and comments, as they do for a pasted PGN. Chess.com PGNs include them.

## Part 3: Build, data, and testing

### Files

| File | Responsibility |
| --- | --- |
| `deck.js` (new) | Pure logic: `puzzlesFromReview`, `applyResult(puzzle, outcome, today)`, `buildSession(puzzles, { today, cap, filter })`, interleaving, and local-date arithmetic. `today` is a parameter, never read from the clock inside the module. |
| `weakness.js` (new) | Pure logic: the theme table, `summarizeGame(...)`, `weaknessReport(summaries)`, and all thresholds (5 games, window 50, 3 and 5 cases, find chance 70, expected score 85, the clock rule) as exported constants. |
| `training-store.js` (new) | The only module that touches `storage.local` for training data. Handles reading, writing, the version check, and pruning. Takes the storage area as a parameter so tests can pass a fake. |
| `board-setup.js` (new) | Extracted from `review.js`. It has two exports: `createBoard(element, { orientation, theme })`, which builds the cm-chessboard instance with the pieces, Arrows, Markers, and PromotionDialog, and `requestPromotion(board, game, from, to, onMove)`, which wraps `promotionChoices` and `showPromotionDialog` with the epoch guard. Each page keeps its own input handler and commit callback, because the review page's `handleBoardInput` and `commitBoardMove` depend on review-only state such as drills and variations. Behavior on the review page must not change. |
| `practice.html`, `practice.js`, `practice.css` (new) | The Practice page. Links `review.css` for shared tokens and components, and adds `practice.css` for page-specific layout. |
| `review.js` | Records the game and puzzles when a review finishes, shows the **Practice** button with the due count, and handles `?game=&ply=`. |
| `review.html` | Adds the Practice button. |
| `scripts/build.mjs` | Adds the new files to the package list. |
| `tests/*.test.js` | New `deck`, `weakness`, and `training-store` tests. |
| `README.md`, `docs/methodology.md`, `CHANGELOG.md`, `package.json` | Feature documentation and version 3.5.0. |

No new extension permissions.

### Storage layout

| Key | Value |
| --- | --- |
| `training:version` | `1` |
| `training:game:<gameKey>` | Game record: summary plus `pgn` |
| `training:card:<puzzleId>` | Puzzle record |
| `practice:settings` | `{ dailyCap }` |

- One key per record, so the review tab and a Practice tab can write at the same time without overwriting each other's records. Loading reads all keys and filters by prefix.
- **Size:** about 12 KB per game: the game record with its PGN is about 4 KB, and about 5 puzzles take about 1.6 KB each, mostly the move history and Stockfish lines. Chrome's `storage.local` quota is 10 MB and is shared with the rest of the extension.
- **Pruning:** keep at most 300 game records, removing the oldest by `reviewedAt` (a missing `reviewedAt` counts as oldest). Puzzles whose game has been removed are orphans. Mastered orphans are removed, and at most 500 unmastered orphans are kept, oldest removed first. With about 5 puzzles per game that is about 4.5 MB. A player averaging 12 puzzles per game in long games reaches about 8.5 MB, still inside the quota.
- **Version:** if `training:version` is greater than the supported version, the Practice page is read-only and `review.js` does not record.

### Build order

1. Extract `board-setup.js` and confirm the review page behaves as before.
2. Build `deck.js` and `weakness.js` with their unit tests.
3. Build `training-store.js` with its tests.
4. Record reviews from `review.js` and add the Practice button.
5. Build the Practice page: session, report, theme practice, and Open game.
6. Run the browser check, then update the docs and version.

### Data flow

1. A review finishes in `runFullAnalysis`. `review.js` builds the game summary (`weakness.js`) and puzzles (`deck.js`), then saves them (`training-store.js`). Saving is skipped when the user's color is unknown.
2. The Practice page opens. It loads all records, builds today's session and the report, and starts Stockfish in the background.
3. The user makes a move. The page judges it, applies `applyResult`, and saves that puzzle's key.

### Error handling

| Case | Behavior |
| --- | --- |
| Stockfish fails to load or a comparison throws | Best moves, mates, and game-move repeats are still judged. Other moves show "Couldn't check this move with Stockfish" with the answer available, and the result is *unverified*. |
| A save fails, including when storage is full | The review shows a small notice that puzzles from this game weren't saved. The review is otherwise unaffected. |
| Data from a newer version | The Practice page is read-only, with a notice. |
| A puzzle whose position can't be rebuilt from `initialFen` + `history` | It is skipped and counted in a notice. The session continues. |
| `?game=` for a pruned game | The review page shows its normal empty state, and the Practice page hides the link. |

### Testing

**Unit tests** (`node:test`, pure modules):
- **Schedule:** the full ladder through mastery; fail resets to step 0 due tomorrow; unverified results leave the puzzle unchanged; Hint or Show Answer counts as a fail.
- **Sessions:** a failed puzzle is re-queued once; the cap is respected and the rest stay due; due ordering; interleaving avoids the same game and theme back to back when possible.
- **Theme practice:** passing early doesn't move a puzzle forward, and failing resets it.
- **Re-review:** keeps schedules, removes puzzles that no longer qualify, and adds new ones.
- **Local dates:** month and year boundaries.
- **Report:**
  - The tag table covers every coach tag for these grades.
  - Each threshold is tested at its boundary: 5 games, 3 cases, 5 cases for main focus, find chance 70, expected score 85, and the clock rule including the 15-second floor.
  - The 50-game window and rate per 100 moves are computed correctly.
  - Null clocks and find chances are excluded from denominators.
- **Storage:**
  - Records are written under one key each.
  - The version check makes newer data read-only.
  - Pruning above 300 games removes mastered orphans, including ones mastered after their game was removed, and caps unmastered orphans at 500.
  - Game identity is stable for the same PGN with different headers.
- **Fixture:** puzzles and a summary built from a saved review of the 1858 Opera Game.

**Browser check** (built extension):
- Review two PGNs and confirm the puzzles and game records are saved.
- On the Practice page, with the date set forward through a test hook in `practice.js`, run a session with a correct answer, a wrong answer, and Hint.
- Run a theme practice session.
- Check that the report appears after 5 reviewed games, using fixture records.
- Confirm that **Open game** reaches the right move.
- Confirm that the review page's board, promotion picker, and drills behave as before.

**Build:** `npm test` and the GitHub CI workflow pass, and both zips contain the new files.

## Out of scope

- Importing games reviewed before v3.5.0, and background analysis of recent games
- Analyze-yourself-first mode, threat-check drills, play-out-vs-engine
- Adaptive scheduling, deck export/import, progress charts, comparisons with other players
