# Changelog

All notable changes to ChessBot are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/FrankieBiz/ChessBot/compare/v3.7.0...HEAD
[3.7.0]: https://github.com/FrankieBiz/ChessBot/compare/v3.6.0...v3.7.0
[3.6.0]: https://github.com/FrankieBiz/ChessBot/compare/v3.5.0...v3.6.0
[3.5.0]: https://github.com/FrankieBiz/ChessBot/compare/v3.4.0...v3.5.0
[3.4.0]: https://github.com/FrankieBiz/ChessBot/compare/v3.3.0...v3.4.0
[3.3.0]: https://github.com/FrankieBiz/ChessBot/releases/tag/v3.3.0
