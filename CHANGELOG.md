# Changelog

All notable changes to ChessBot are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Repository documentation: license, contributing guide, security policy, code of conduct, issue and pull request templates.
- Continuous integration that runs the test suite on Node.js 24 and 26 and builds both browser packages.

### Changed

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

[Unreleased]: https://github.com/FrankieBiz/ChessBot/compare/v3.4.0...HEAD
[3.4.0]: https://github.com/FrankieBiz/ChessBot/compare/v3.3.0...v3.4.0
[3.3.0]: https://github.com/FrankieBiz/ChessBot/releases/tag/v3.3.0
