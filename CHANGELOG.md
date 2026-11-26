# Changelog

All notable changes to ChessBot are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **One huge blunder no longer halves the accuracy score.** Game accuracy averages a weighted mean and a harmonic mean of each move's accuracy. A move that threw away about 89 or more points of winning chances scored 0%, which made the harmonic mean 0 and capped the game at half the weighted mean, below 50% however well the rest was played. As in Lichess, each move now counts as at least 1% in the harmonic mean. Phase accuracy and the comparison with your earlier games use the same fix. Games you reviewed before keep their saved score until you review them again.

## [3.8.0] - 2026-11-25

Versions 3.5.0, 3.6.0, and 3.7.0 were never released on their own. This release includes them, so their entries below are part of it too.

### Added

- **Faster reviews.** Stockfish runs on up to four engines at once. ChessBot uses half the logical cores, and fewer engines on devices that report less than 8 GB of memory. A quick pass grades every move first, so the summary, graph and move list fill in early. Close calls are then checked deeper in the background and marked as checking until they finish. On a MacBook Air M3, the quick pass covered three 70–79-ply club games in 17–30 seconds. The full review took 49–139 seconds instead of 125–352 seconds with one engine. Every grade, loss and confidence label matches checking each move on its own: 220 of 220 moves in those games and 144 of 144 in the search benchmark. Each engine holds its own copy of the network, so a review uses more memory while it runs. The extra engines close when the review finishes.
- **Named tactics in the coach.** Move cards name the tactic in Stockfish's line: a fork, pin, skewer, discovered attack or check, double check, back-rank mate, short forced mate, or undefended piece. Errors name the tactic they allow and the one they missed, with the squares involved. Strong moves name the tactic they carry out. A tactic is named only when the line wins one of the attacked pieces or mates within a few moves. Material is counted from before the current exchange, so a recapture is never credited as a tactic. **Show on board** draws the tactic's lines and marks the attacked pieces.
- **A reason for every mistake.** Each Inaccuracy, Mistake, Miss, and Blunder gets a concrete explanation checked on the board and in Stockfish's lines:
  - the material the reply wins, with the capture that decides it and whether the piece was undefended or attacked more often than defended;
  - checks against your king, or a passed pawn that runs or promotes;
  - a missed recapture, or the material the better move would have won;
  - plain facts about the move itself: a king move that gives up castling, a pawn moved in front of the castled king, an early queen move, or a retreat that cuts a piece's moves;
  - otherwise, the evaluation change and Stockfish's best line.
- **Lichess-style game chart.** The advantage chart shades White's edge light and Black's dark from a center line, on Lichess's centipawn scale. It marks where the middlegame and endgame begin, and dots every Inaccuracy, Mistake, Miss, Blunder, Great, and Brilliant move. Hover for the move and evaluation, and click or drag along the chart to move through the game. Games with clock times add a **Move times** chart: White's moves rise and Black's fall, errors take their grade color, and hovering shows the time spent and the clock left.
- In the summary table, each nonzero count jumps to that side's next move of that grade, cycling through them.
- **Comments in the move list.** Under each Inaccuracy, Mistake, Miss, and Blunder, the Moves tab says which move was best, shows the evaluation before and after, and gives Stockfish's line, as Lichess's computer analysis does.
- **Engine lines you can explore.** Hover a move in any engine line to preview the position on a small board. Click it to play the line on the main board up to that move. This works in the move card, the move-list comments, and the threat line.
- **Show threat.** Press <kbd>X</kbd> or the target button to see what the side that just moved would play if it could move again: mates, named tactics, and checks or captures that cost real material. A quiet move that only gains a tempo is described as no direct threat. The threat appears as a dashed red arrow with its line and evaluation.
- **Draw on the board.** Right-drag draws an arrow and right-click circles a square. Shift, Alt, or both switch from green to red, blue, or yellow, and a left click clears the drawings. Drawings stay with their position as you move through the game.
- **Annotated PGN.** The Moves tab copies or downloads the game as PGN with an evaluation and clock time after every move, grades as standard annotation symbols, and a comment and Stockfish's better line after each mistake. Lichess, Chess.com, and ChessBase can import it.
- **More ways to move through a game.** Scroll on the board to step through moves. <kbd>K</kbd> and <kbd>J</kbd> step back and forward, and <kbd>Home</kbd> and <kbd>End</kbd> jump to the start and end. Stepping back inside a variation takes back one move instead of leaving it. <kbd>?</kbd> opens a list of every shortcut.
- Variation evaluations and threats work while a review is still running. They run on the next free engine, ahead of the review's queue, and don't change the review's results.
- **Report a problem.** Settings, and any engine error, link to a GitHub bug form with the ChessBot version, browser, and error filled in. Nothing is sent until you submit the form, and no game data is included.
- The weakness report adds **Weakened your king** and **Slow development**, and sorts named tactics into the matching mistake types.

### Changed

- The extension is now called **ChessBot: Local Game Review**, and its button on Chess.com reads **ChessBot Review**. ChessBot is not affiliated with Chess.com.

### Fixed

- Browser shortcuts such as <kbd>Cmd</kbd>+<kbd>F</kbd> no longer flip the board, and <kbd>Enter</kbd> or <kbd>Space</kbd> on a focused button no longer also steps or plays the game.
- A search slowed by a busy computer no longer stops the review. The time limit now counts from Stockfish's last output, so only a search that has stopped responding fails.
- Blunder badges use a white symbol for 5.2:1 contrast. Keyboard hints and tab counts meet 4.5:1, and every control shows a visible keyboard focus outline.

## [3.7.0] - 2026-11-24

### Added

- **Opening study** identifies where a game departed from the book and shows common alternatives with sample counts and results. Try a move or play an example continuation offline.
- **Deep Check** gives a selected move a larger Stockfish search budget. It reports the completed depth, any grade change, and a playable continuation.
- Coach cards can highlight the opponent's reply and its target square, then play through the verified continuation.
- Performance can compare a completed review with the player's median across comparable saved games.

### Changed

- Expanded recorded opening coverage with 153,664 rated Lichess games across eight months. On the held-out sample, lookup coverage at ply 8 rose from 33.3% to 50.9% before Stockfish screening.
- The move card now shows the completed search depth and whether the grade came from one comparison, agreed across depths, or remained uncertain.

## [3.6.0] - 2026-11-24

### Added

- **Book** on the review card, board badge, move list, and game summary. The bundled opening book recognizes 8,403 position–move pairs offline, including transpositions, using Lichess opening theory and common continuations from rated games. Stockfish still evaluates the move and preserves any tactical warnings.
- Each move card shows the expected-score loss that drives its engine grade. The summary shows the number of scored decisions and uncertain grades, and recorded player ratings show their source.
- A reproducible single-game rating study measures prediction error by time control and compares it with simple baselines.

### Fixed

- Stockfish comparisons keep complete, same-depth sets of lines. A capped recheck that cannot confirm a grade leaves it marked uncertain.
- A collapse above the 20-point expected-score loss boundary keeps its Blunder grade after an opponent's error. Exact loss boundaries classify consistently despite floating-point rounding.
- Reanalyzing a game or leaving a drill safely discards pending move checks for that board position.

## [3.5.0] - 2026-11-24

### Added

- **Practice page** with a spaced review of your own mistakes. Every Mistake, Miss, and Blunder from a reviewed game becomes a puzzle that comes back after 1, 3, 7, 21, and 60 days, mixed across games. A wrong first try, a hint, or Show Answer sends a puzzle back to one day. The daily limit defaults to 20 puzzles.
- **Weakness report** across your 50 most recently reviewed games: mistakes by type, mistakes in easy positions, accuracy by game phase, mistakes when low on time, and winning positions you didn't convert. Each finding links to matching puzzles.
- On Chess.com, ChessBot reads your signed-in username from the page to tell which side you played.
- **Practice** link in the review header, with the number of puzzles due.
- Only your own games feed the deck: Chess.com games where your signed-in account, or the username in Settings, is one of the players, and pasted PGNs with **Save my mistakes for practice** ticked.
- Repository documentation: license, contributing guide, security policy, code of conduct, issue and pull request templates.
- Continuous integration that runs the test suite on Node.js 24 and 26 and builds both browser packages.

### Changed

- The review page and the Practice page share one board setup and one set of drill messages.
- The README is now an overview. Scoring details moved to [docs/methodology.md](docs/methodology.md), and benchmark results moved to [docs/benchmarks.md](docs/benchmarks.md).
- The browser packages include the project license.

## [3.4.0] - 2026-11-24

### Added

- Missed mates are graded **Miss** and added to the Mistakes trainer. A missed mate in 1 counts, and so does a mate in 2 or 3 that the played move no longer forces. Accuracy and Decision Quality are unchanged because the position stays won. A mate that is only delayed is described on the move card without a drill.
- Missed-mate drills accept only a mate at least as fast as the one available, and the coach names the mate.
- Pawn promotions open a piece picker, so underpromotions can be played in drills and variations.
- A move-level model of human choices estimates how often players find a sound move and names the most tempting mistake. It was trained on public-domain Lichess games and tested on held-out Lichess and Chess.com games.

### Changed

- Explored variations keep the full game history, so threefold repetition and the 50-move rule are recognized. The variation tag notes when a draw can be claimed.
- The broad third search pass runs only when a grade is at risk. On 144 benchmark decisions, it matches v3.3's grades with 7% fewer search nodes.
- The all-moves search for the difficulty estimate starts from a cleared hash table. A warm table leaked the played move's deeper result into the estimate.

## [3.3.0] - 2026-11-23

This is the first version in this repository. Earlier releases (3.1 and 3.2) were developed before version control. It includes local Stockfish 19 review, move grades, Lichess-style accuracy, Decision Quality, the built-in coach with optional AI explanations, the Mistakes trainer, clock-aware practical impact, and the cohort difficulty model.

[Unreleased]: https://github.com/FrankieBiz/ChessBot/compare/v3.8.0...HEAD
[3.8.0]: https://github.com/FrankieBiz/ChessBot/compare/v3.4.0...v3.8.0
[3.7.0]: https://github.com/FrankieBiz/ChessBot/commit/41af3defc7e487ba0e43950efc2c2ad4f636f68e
[3.6.0]: https://github.com/FrankieBiz/ChessBot/commit/bcc32d8eacce90d2112ef4de441e906be8d01ad9
[3.5.0]: https://github.com/FrankieBiz/ChessBot/commit/704db0ac8ab070a7fa3c7314bbfe4662b861ad3b
[3.4.0]: https://github.com/FrankieBiz/ChessBot/compare/v3.3.0...v3.4.0
[3.3.0]: https://github.com/FrankieBiz/ChessBot/releases/tag/v3.3.0
