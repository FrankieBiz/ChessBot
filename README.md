<p align="center">
  <img src="icons/icon-128.png" width="96" height="96" alt="ChessBot logo">
</p>

<h1 align="center">ChessBot</h1>

<p align="center">
  <strong>Private, offline game review for Chess.com games and PGNs, powered by full-strength Stockfish 19 in your browser.</strong>
</p>

<p align="center">
  <a href="https://github.com/FrankieBiz/ChessBot/actions/workflows/ci.yml"><img src="https://github.com/FrankieBiz/ChessBot/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/FrankieBiz/ChessBot/releases/latest"><img src="https://img.shields.io/github/v/release/FrankieBiz/ChessBot?sort=semver" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="License: GPL-3.0"></a>
  <img src="https://img.shields.io/badge/engine-Stockfish%2019-2e7d32" alt="Engine: Stockfish 19">
  <img src="https://img.shields.io/badge/browsers-Chrome%20%7C%20Firefox-555" alt="Browsers: Chrome and Firefox">
</p>

<p align="center">
  <img src="docs/images/review-move.png" alt="ChessBot reviewing the 1858 Opera Game. The move card shows Stockfish's top lines, how often players find a sound move, and the most tempting mistake." width="900">
</p>

ChessBot is a browser extension that reviews your finished games the way a coach would. Every move gets a grade, an explanation, and Stockfish's best continuation. Your mistakes become practice drills. The engine runs entirely on your computer, so there is no account, no upload, and no waiting in a server queue.

## Features

- **Full-strength engine, fully local.** Stockfish 19 with its full NNUE network runs in a WebAssembly worker inside the extension. Your games never leave your browser.
- **Move grades from Brilliant to Blunder.** Grades come from the drop in expected score, not raw centipawns. Positions where the grade is at risk are rechecked with deeper searches, and the move card says when a grade is still uncertain.
- **Accuracy and Decision Quality.** Lichess-style accuracy, average centipawn loss, and separate opening, middlegame, and endgame scores. Decision Quality adds a score that weighs large mistakes more heavily.
- **Coaching on every move.** A built-in coach points out hanging pieces, missed tactics, king-safety problems, and missed mates. Optional AI explanations use your own key for OpenAI, DeepSeek, Gemini, or any OpenAI-compatible endpoint.
- **Practice drills.** The Mistakes tab replays your Mistakes, Misses, and Blunders from the original position. Missed mates come back as drills that only accept a mate at least as fast.
- **Human difficulty.** For each decision, ChessBot estimates how often players find a sound move and names the most tempting mistake. The model was trained on public-domain Lichess games.
- **Practical impact.** A clock-aware model estimates how much a move changed a human player's real chances, not just the engine evaluation.
- **Free exploration.** Try your own moves on the board, with a full promotion picker. Repetitions and 50-move draws are recognized in your variations.
- **Fair-play safe.** The review button appears only after a Chess.com game is over. ChessBot never runs during live play.

<p align="center">
  <img src="docs/images/review-summary.png" alt="Game summary with the advantage timeline, accuracy, Decision Quality, and grade counts for each player" width="900">
</p>

## Install

ChessBot isn't in the Chrome Web Store or Firefox Add-ons yet. Install it from a release:

1. Download `chessbot-chrome-vX.Y.Z.zip` or `chessbot-firefox-vX.Y.Z.zip` from the [latest release](https://github.com/FrankieBiz/ChessBot/releases/latest), then unzip it.
2. Load it into your browser:
   - **Chrome:** open `chrome://extensions`, turn on **Developer mode**, select **Load unpacked**, and choose the unzipped folder.
   - **Firefox 140 or later:** open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**, and choose `manifest.json` in the unzipped folder. Firefox removes temporary add-ons when it closes.

### Build from source

You need [Node.js](https://nodejs.org/) 24 or later and the `zip` command.

```bash
git clone https://github.com/FrankieBiz/ChessBot.git
cd ChessBot
npm ci
npm test
npm run build
```

The build writes unpacked extensions to `dist/chrome` and `dist/firefox`, plus a zip for each. The full Stockfish network makes each zip about 76 MB.

## Usage

- **Chess.com:** finish a game, then select **Local Game Review** on the game page.
- **Any PGN:** select the toolbar icon, choose **Load PGN**, paste the game, pick your color, and select **Analyze Game**.
- **Depth:** choose from 12 (fast) to 20 (maximum). The default of 16 balances speed and accuracy.
- **Keyboard:** <kbd>←</kbd> <kbd>→</kbd> step through moves, <kbd>Space</kbd> plays the game, <kbd>F</kbd> flips the board, <kbd>R</kbd> retries a drill, and <kbd>Esc</kbd> returns to the main line.

## Accuracy you can check

ChessBot's grading rules and models are tested against deeper searches and held-out games. Full results and reproduction commands are in [docs/benchmarks.md](docs/benchmarks.md).

| Measurement | Result |
| --- | --- |
| Grades matching a depth-22 Stockfish reference (144 decisions) | 116 exact, 142 on serious versus minor |
| Find-rate forecast error (Brier score, lower is better) on held-out Lichess games | 0.1305, down from 0.1569 in v3.3 |
| Same forecast on held-out Chess.com games | 0.1246, down from 0.1421 in v3.3 |
| Clock-aware expected-score model versus the published Lichess curve | 5.8% lower squared error |

[How ChessBot works](docs/methodology.md) explains the grading, search, and difficulty models in detail.

## Privacy

- Analysis runs locally. ChessBot has no accounts, analytics, or tracking.
- To review a Chess.com game, the extension reads the game from Chess.com's public API.
- AI explanations are off until you set up a provider. When you request one, the position and Stockfish lines go to the provider you chose. Your API key is stored in the browser's extension storage and sent only to that provider.
- The extension asks for access to an AI provider's site the first time you request an explanation from it.

## Project structure

| Path | Contents |
| --- | --- |
| `review.html`, `review.js`, `review.css` | The review page: board, move card, summary, drills, and settings |
| `engine.js`, `analysis.js` | Stockfish worker control, move grading, and adaptive search |
| `coach.js`, `coach-api.js`, `tactics.js` | Built-in coaching text, optional AI explanations, and missed-mate detection |
| `drills.js`, `variation.js` | Drill checking and variation replay |
| `human-move-model.js`, `difficulty-model.js`, `practical-model.js` | Human difficulty and practical-impact models, with fitted data in the matching `*-data.js` files |
| `content.js`, `background.js` | The Chess.com page button and game fetching |
| `browsers/` | Manifests for Chrome and Firefox |
| `scripts/` | Build script, benchmarks, and model training |
| `research/` | Benchmark outputs and source hashes |
| `tests/` | Unit tests for the Node.js built-in test runner |

## Roadmap

- Multi-core Stockfish on Chrome. In a test of the WebAssembly build on an Apple M3, four threads searched about four times as many positions per second as one.
- Chrome Web Store and Firefox Add-ons listings.
- Optional endgame tablebases for perfect play with seven or fewer pieces.
- A deep-review setting that trades time for more grades matching a deeper search.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, testing, and the evidence expected for engine or model changes. Report security issues privately as described in [SECURITY.md](SECURITY.md). Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

ChessBot is free software, released under the [GNU General Public License v3.0](LICENSE) or later.

It bundles these projects:

- [Stockfish](https://stockfishchess.org/) through [Stockfish.js](https://github.com/nmrugg/stockfish.js), GPL-3.0
- [chess.js](https://github.com/jhlywa/chess.js), BSD-2-Clause
- [cm-chessboard](https://github.com/shaack/cm-chessboard), MIT

The human-difficulty and calibration models were trained on the [Lichess open database](https://database.lichess.org/), released under CC0.

ChessBot is an independent project. It is not affiliated with or endorsed by Chess.com or Lichess.
