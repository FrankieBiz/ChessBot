# How ChessBot works

This page explains how ChessBot grades moves, decides how deeply to search, and estimates how hard a decision was for a human. The test results behind each model are in [benchmarks.md](benchmarks.md).

## Scoring a game

- **Engine** — Stockfish.js 19.0.1 runs the full Stockfish 19 NNUE network in a local single-threaded WASM worker. ChessBot compares the played move and alternatives at the same position, search depth, and perspective. It reruns sharp positions and suspected errors at greater depth within a node budget. PGN move history reaches the engine so it can evaluate repetitions. [Stockfish 19](https://stockfishchess.org/blog/2026/stockfish-19/) · [Stockfish.js builds](https://github.com/nmrugg/stockfish.js/tree/v19.0.1) · [UCI commands](https://official-stockfish.github.io/docs/stockfish-wiki/UCI-Protocol-and-Stockfish-Commands.html)
- **Move grades** — Grades reflect the engine's expected-score drop, calculated as win probability plus half the draw probability. Stockfish calibrates those probabilities on engine self-play. Great and Brilliant require evidence from deeper search. A Brilliant also requires a meaningful material investment visible in the continuation. Grade thresholds are ChessBot heuristics. [Stockfish evaluation FAQ](https://official-stockfish.github.io/docs/stockfish-wiki/Stockfish-FAQ.html#interpretation-of-the-stockfish-evaluation)
- **Missed mates** — A missed mate in 1 is graded Miss even when the position stays won, and so is a mate in 2 or 3 that the played move no longer forces. The decision then appears in the Mistakes trainer. Its expected-score loss, accuracy, and Decision Quality stay the same, because a won position remains won. A mate in 2 or 3 that is only delayed, such as mate in 2 becoming mate in 4, is described on the move card without a drill. A larger loss keeps its Mistake or Blunder grade.
- **Accuracy and ACPL** — ChessBot applies Lichess's centipawn-to-win curve and combines volatility-weighted and harmonic means. The input is ChessBot's same-position analysis. Moves with only one legal option are excluded from accuracy and average centipawn loss. Opening, middlegame, and endgame scores use move number and remaining material. [Lichess accuracy method](https://lichess.org/page/accuracy) · [Lichess source](https://github.com/lichess-org/lila/blob/master/modules/analyse/src/main/AccuracyPercent.scala)
- **Player ratings** — The names on the board show ratings supplied by the Chess.com game record or PGN Elo tags, when available. The former single-game Elo formula used a fixed accuracy-to-rating conversion. A validated rating estimate would require calibration against a large, comparable set of rated human games. [Regan and Haworth, Intrinsic Chess Ratings](https://ojs.aaai.org/index.php/AAAI/article/view/7951) · [Maia human move prediction research](https://arxiv.org/abs/2006.01855)

## Search confidence and Decision Quality

The normal review starts each game with a cleared Stockfish search table. ChessBot rechecks sharp positions, suspected errors, and moves close to a grade boundary two plies deeper. A third, broader pass searches three candidates four plies deeper and then compares the played move at the same root. It runs only when the grade is still at risk:

- the grade changed between the first two passes,
- Great or Brilliant praise did not hold, or
- a same-grade loss moved more than 2.5 points toward the Inaccuracy/Mistake line at 10 or the Mistake/Blunder line at 20, by enough to cross it if it kept moving.

Great and Brilliant require the underlying distinction to persist across completed depths. The move card flags a grade that changed between the last two passes and shows the depth used.

**Decision Quality** is a second 0–100 score. ChessBot subtracts the root-mean-square expected-score loss from 100, counting only decisions with more than one legal move. Squaring the losses gives large mistakes more influence. The largest individual loss is shown alongside the score. The original accuracy percentage uses its Lichess-style game weighting.

## Practice drills

The Mistakes tab replays every Mistake, Miss, and Blunder for your side, starting with the largest expected-score or practical loss. Missed mates rank as if they had lost at least 20 points. A missed-mate drill asks for a mate at least as fast as the one available, so another winning move doesn't solve it. Other drills accept Stockfish's move or any move within three expected-score points. Repeating the game move is never accepted.

Dragging a pawn to the last rank opens a piece picker, so underpromotions can be played. Moves you explore on the board keep the game's history. Stockfish and the repetition check therefore see earlier positions, and the variation tag notes when a draw can be claimed under the threefold or 50-move rule.

## Practical impact

Practical impact compares the expected human game score of the played move and Stockfish's best candidate from the same decision. Each candidate uses the same recorded post-move clocks. The number is in points on a 0–100 expected-score scale. It is available on supported standard-start positions from ply 8 through 120. A fitted position-only curve is used when either clock is missing. Forced moves, mate evaluations, custom starts, and declared time controls outside the model's range use engine review alone.

ChessBot uses the larger of the practical and engine expected-score losses to prioritize existing error drills. It also checks a practical loss of at least five points with a deeper search. The engine-accuracy formula still uses Lichess-style scoring, so the practical estimate does not enter the accuracy percentage.

## How often players find a sound move

ChessBot estimates which moves a player is likely to choose, then asks how many of them are sound. Once the review finishes, the move card runs one extra Stockfish search over every legal move at depth 14 (about 0.36 million nodes). A depth-12 version rated some traps as the best move, such as 4. Nxe5 against 3...Nd4 in the Italian Game, so v3.4 uses the deeper search. A softmax model then assigns each move a probability. It combines Stockfish's expected-score loss for that move with features that make a move look natural or tempting: captures, recaptures, checks, promotions, castling, piece type, moving an attacked piece, leaving a piece en prise, retreats, and distance. Lichess ratings change how strongly losses and tactics count, and a low clock makes losses count less.

The card shows two things:

- **Players find a sound move** — the calibrated chance of choosing a move that loses at most five expected-score points, the Good grade boundary.
- **Most tempting mistake** — the unsound move the model rates most likely, with its share of players and its loss. It is hidden below 8%.

Lichess games with supported ratings use the rated model, and other games use the unrated one. Until the extra search finishes, or if it can't run, the card shows the earlier cohort estimate. That estimate uses only the root evaluation and position features.

## Optional AI explanations

The presets are **GPT-6.2 Sol** for OpenAI, **DeepSeek V4.1 Flash** for DeepSeek, and **Gemini 4 Hydrogen** for Google. Each receives the selected position and Stockfish continuations after you request an explanation and approve the provider permission. The API key you enter is stored in the browser extension and sent to your chosen endpoint for authentication. The review and scoring work offline with imported PGNs. [OpenAI](https://developers.openai.com/api/docs/models/gpt-6.2-sol) · [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/) · [Gemini](https://aistudio.google.com/docs/openai)
