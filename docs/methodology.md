# How ChessBot works

This page explains how ChessBot grades moves, decides how deeply to search, and estimates how hard a decision was for a human. The test results behind each model are in [benchmarks.md](benchmarks.md).

## Scoring a game

- **Engine** — Stockfish.js 19.0.1 runs the full Stockfish 19 NNUE network in local single-threaded WASM workers, up to four at once. ChessBot compares the played move and alternatives at the same position, search depth, and perspective. It reruns sharp positions and suspected errors at greater depth within a node budget. PGN move history reaches the engine so it can evaluate repetitions. [Stockfish 19](https://stockfishchess.org/blog/2026/stockfish-19/) · [Stockfish.js builds](https://github.com/nmrugg/stockfish.js/tree/v19.0.1) · [UCI commands](https://official-stockfish.github.io/docs/stockfish-wiki/UCI-Protocol-and-Stockfish-Commands.html)
- **Move grades** — Grades reflect the engine's expected-score drop, calculated as win probability plus half the draw probability. Stockfish calibrates those probabilities on engine self-play. The move card shows the loss alongside the centipawn evaluation and the separate human practical-impact estimate. Great and Brilliant require evidence from deeper search. A Brilliant also requires a meaningful material investment visible in the continuation. Grade thresholds are ChessBot heuristics. [Stockfish WDL model](https://github.com/official-stockfish/WDL_model)
- **Missed mates** — A missed mate in 1 is graded Miss even when the position stays won, and so is a mate in 2 or 3 that the played move no longer forces. The decision then appears in the Mistakes trainer. Its expected-score loss, accuracy, and Decision Quality stay the same, because a won position remains won. A mate in 2 or 3 that is only delayed, such as mate in 2 becoming mate in 4, is described on the move card without a drill. A larger loss keeps its Mistake or Blunder grade.
- **Accuracy and ACPL** — ChessBot applies Lichess's centipawn-to-win curve and combines volatility-weighted and harmonic means. The input is ChessBot's same-position analysis. Accuracy and average centipawn loss count decisions with more than one legal option, including Book moves. The game summary shows the number of scored decisions and the number with uncertain grades. Opening, middlegame, and endgame scores use move number and remaining material. [Lichess accuracy method](https://lichess.org/page/accuracy) · [Lichess source](https://github.com/lichess-org/lila/blob/master/modules/analyse/src/main/AccuracyPercent.scala)
- **Player ratings** — The names on the board show recorded ratings from the Chess.com game record or PGN Elo tags, with the source in the tooltip. Game accuracy and Decision Quality describe the decisions that were played. A held-out study found that even a model using move losses, game length, and game stage typically missed the recorded Lichess rating by several hundred points. [Rating benchmark](benchmarks.md#single-game-rating-feasibility) · [Regan and Haworth, Intrinsic Chess Ratings](https://ojs.aaai.org/index.php/AAAI/article/view/7951)

## Book moves

Book identifies sound moves in the bundled opening book. It contains 8,192 position–move pairs through ply 36 from 3,865 named Lichess lines and 211 additional early continuations sampled from rated games between players rated at least 2100. ChessBot matches the board, turn, castling rights, and legal en passant square before checking the played move. This recognizes transpositions from the standard start and avoids counting repeated positions. The move card names an opening the game has reached when the catalog provides one. Coverage is strongest in the early opening. [Coverage and reproduction](benchmarks.md#opening-book-coverage) · [Lichess opening catalog](https://github.com/lichess-org/chess-openings) · [CC0 game archives](https://database.lichess.org/#standard_games)

Stockfish still evaluates every Book move. ChessBot uses Book for ordinary sound grades supported by the search. Forced moves, tactical grades and missed-mate notices retain their engine labels. Accuracy, Decision Quality, average centipawn loss, and drills use the underlying engine results. The catalog is packaged with the extension, so opening recognition works offline.

## Search confidence and Decision Quality

A review runs in two phases. The quick phase searches every position and compares every move at the review depth. Moves that need more evidence are then checked deeper, and the move list marks them as checking until they finish. Each search task starts from a cleared Stockfish search table, and single-threaded Stockfish is deterministic from a cleared table. A deeper check first repeats the move's quick searches, so its result is the same as checking that move in one uninterrupted run, whichever engine runs it. ChessBot rechecks sharp positions, suspected errors, and moves close to a grade boundary two plies deeper. A third, broader pass searches three candidates four plies deeper and then compares the played move at the same root. It runs only when the grade is still at risk:

- the grade changed between the first two passes,
- Great or Brilliant praise did not hold, or
- a same-grade loss moved more than 2.5 points toward the Inaccuracy/Mistake line at 10 or the Mistake/Blunder line at 20, by enough to cross it if it kept moving.

Stockfish can stop at its node limit before it reaches the requested depth. ChessBot uses the deepest batch that contains every requested line with an exact score from the same depth. If the first comparison cannot score the full shortlist, ChessBot can retry the initial leader and the played move together. That narrower result is provisional because another alternative may be stronger. Great and Brilliant require the distinction to persist across two complete comparisons at different depths. The move card shows the depth used and flags grades whose evidence changed or whose required recheck could not complete. [Stockfish 19 search output](https://github.com/official-stockfish/Stockfish/blob/sf_19/src/search.cpp#L2273-L2337)

**Decision Quality** is a second 0–100 score. ChessBot subtracts the root-mean-square expected-score loss from 100, counting only decisions with more than one legal move. Squaring the losses gives large mistakes more influence. The largest individual loss is shown alongside the score. The original accuracy percentage uses its Lichess-style game weighting.

## Named tactics

The coach names a tactic only when it can verify it on the board along Stockfish's line. It checks the line's first move and, after a forcing first move such as a check or capture, the side's next move. Recognized patterns are:

- a fork, where one piece attacks two or more valuable targets,
- a pin or skewer by the piece that just moved,
- a discovered attack or check, where a move opens another piece's line,
- a double check,
- a back-rank mate or other mate within three moves, and
- a capture of an undefended piece.

A named tactic must win one of the attacked pieces, following a piece that moves away. Within five plies of the tactic, the side must come out at least two points of material ahead, or the line must mate. Material is measured from before the exchange in progress, so winning back a piece that was just taken does not count. When no pattern passes these checks, the card keeps its general explanation.

## Explaining a mistake

Every Inaccuracy, Mistake, Miss, and Blunder gets the most concrete reason ChessBot can verify. A named tactic comes first. Otherwise ChessBot replays Stockfish's line after the played move, counting material over six plies plus any exchange still under way, from before the move. When the line wins material, the card names the capture that decides it and whether that piece was undefended or attacked more often than defended. A Blunder with no loss in that window is checked over twelve plies, and the card says the loss comes further along the line. Two or more checks against the king, and a passed pawn that advances twice or promotes, are named too.

For the better move, ChessBot names a recapture the game move skipped, or the material Stockfish's best line wins. Taking back the piece the opponent just captured does not count as a win. Without a concrete consequence, the card states facts about the move: a king move that gives up castling, a pawn moved in front of the castled king, the queen's first move while minor pieces are still at home, or a retreat that leaves a piece with at least three fewer moves. It also says what the better move does, such as castling, developing a piece, taking a piece, or using an open file. A Blunder's explanation never rests on such a fact alone; without a concrete consequence, the card shows the evaluation change and Stockfish's best line.

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

## Practice deck and weakness report

Each finished review saves the game and turns every Mistake, Miss, and Blunder by your side into a puzzle. Forced moves are excluded, as in the Mistakes tab. A puzzle keeps the position, the moves that led to it, Stockfish's lines, and the review depth, so the Practice page judges answers with the same rules: Stockfish's move and qualifying mates are accepted at once, and other moves are checked live and accepted within three expected-score points. A missed-mate puzzle needs a mate at least as fast.

A new puzzle first comes due the day after the review. A first-try solve moves it to the next interval of 1, 3, 7, 21, and 60 days, and passing the 60-day review masters it. A wrong first try, a hint, or Show Answer sends it back to one day. If Stockfish couldn't check your move, Show Answer leaves the schedule unchanged. Sessions take the most overdue puzzles up to the daily limit and avoid two puzzles in a row from the same game, then from the same mistake type. The schedule rests on two of the best-supported findings in learning research: testing yourself, and spacing practice over time. [Dunlosky et al., 2013](https://doi.org/10.1177/1529100612453266)

Only your own games are saved. A Chess.com game counts when your signed-in account, or the username saved in Settings, is one of the players. A pasted PGN counts when **Save my mistakes for practice** is ticked, using the side you chose. Re-reviewing a game keeps each puzzle's schedule, and a review at a lower depth never replaces a deeper one. ChessBot keeps your 300 most recently reviewed games, counted by when each was first reviewed. Puzzles you haven't mastered stay after their game is removed, up to 500 of them. Practice data is also capped at about 6 MB; when space runs short, puzzles whose game was already removed go first, then the oldest games with their puzzles.

The weakness report covers the 50 games you reviewed most recently (counted from each game's first review) once you have reviewed five. Each mistake gets one type from the coach's tag. A type appears in the main list after three cases and is marked as your main focus after five. If two types tie for the top, neither is marked. A mistake counts as easy when the cohort difficulty model estimates that at least 70% of players find a sound move. A clock is low under 10% of the starting time or 15 seconds, whichever is larger, and only games with recorded clocks count. A game counts as unconverted when your expected score reached 85 before one of your moves and you didn't win. The report shows counts and sample sizes, not statistical tests.

## Optional AI explanations

The presets are **GPT-6.2 Sol** for OpenAI, **DeepSeek V4.1 Flash** for DeepSeek, and **Gemini 4 Hydrogen** for Google. Each receives the selected position and Stockfish continuations after you request an explanation and approve the provider permission. The API key you enter is stored in the browser extension and sent to your chosen endpoint for authentication. The review and scoring work offline with imported PGNs. [OpenAI](https://developers.openai.com/api/docs/models/gpt-6.2-sol) · [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/) · [Gemini](https://aistudio.google.com/docs/openai)
