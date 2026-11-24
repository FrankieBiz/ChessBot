# ChessBot Local Game Review

ChessBot reviews finished Chess.com games and pasted standard-chess PGNs. Stockfish and the built-in coach run in the browser. Open the extension from the toolbar, paste a PGN, or use the review button on a completed Chess.com game.

## Install the local build

- **Chrome** — Open `chrome://extensions`, enable Developer mode, and load the unpacked `dist/chrome` folder.
- **Firefox** — Open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**, and choose `dist/firefox/manifest.json`. The temporary add-on is removed when Firefox closes.

The browser ZIPs contain the same files as the unpacked folders. The full Stockfish network makes each ZIP roughly 76 MiB. Run `npm ci`, `npm test`, and `npm run build` to rebuild both packages from the pinned dependencies. The build uses the system `zip` utility.

## How ChessBot scores a game

- **Engine** — Stockfish.js 19.0.1 runs the full Stockfish 19 NNUE network in a local single-threaded WASM worker. ChessBot compares the played move and alternatives at the same position, search depth, and perspective. It reruns sharp positions and suspected errors at greater depth within a node budget. PGN move history reaches the engine so it can evaluate repetitions. [Stockfish 19](https://stockfishchess.org/blog/2026/stockfish-19/) · [Stockfish.js builds](https://github.com/nmrugg/stockfish.js/tree/v19.0.1) · [UCI commands](https://official-stockfish.github.io/docs/stockfish-wiki/UCI-Protocol-and-Stockfish-Commands.html)
- **Move grades** — Grades reflect the engine's expected-score drop, calculated as win probability plus half the draw probability. Stockfish calibrates those probabilities on engine self-play. Great and Brilliant require evidence from deeper search. A Brilliant also requires a meaningful material investment visible in the continuation. Grade thresholds are ChessBot heuristics. [Stockfish evaluation FAQ](https://official-stockfish.github.io/docs/stockfish-wiki/Stockfish-FAQ.html#interpretation-of-the-stockfish-evaluation)
- **Missed mates** — A missed mate in 1 is graded Miss even when the position stays won, and so is a mate in 2 or 3 that the played move no longer forces. The decision then appears in the Mistakes trainer. Its expected-score loss, accuracy, and Decision Quality stay the same, because a won position remains won. A mate in 2 or 3 that is only delayed, such as mate in 2 becoming mate in 4, is described on the move card without a drill. A larger loss keeps its Mistake or Blunder grade.
- **Accuracy and ACPL** — ChessBot applies Lichess's centipawn-to-win curve and combines volatility-weighted and harmonic means. The input is ChessBot's same-position analysis. Moves with only one legal option are excluded from accuracy and average centipawn loss. Opening, middlegame, and endgame scores use move number and remaining material. [Lichess accuracy method](https://lichess.org/page/accuracy) · [Lichess source](https://github.com/lichess-org/lila/blob/master/modules/analyse/src/main/AccuracyPercent.scala)
- **Player ratings** — The names on the board show ratings supplied by the Chess.com game record or PGN Elo tags, when available. The former single-game Elo formula used a fixed accuracy-to-rating conversion. A validated rating estimate would require calibration against a large, comparable set of rated human games. [Regan and Haworth, Intrinsic Chess Ratings](https://ojs.aaai.org/index.php/AAAI/article/view/7951) · [Maia human move prediction research](https://arxiv.org/abs/2006.01855)

## Practice drills

The Mistakes tab replays every Mistake, Miss, and Blunder for your side, starting with the largest expected-score or practical loss. Missed mates rank as if they had lost at least 20 points. A missed-mate drill asks for a mate at least as fast as the one available, so another winning move doesn't solve it. Other drills accept Stockfish's move or any move within three expected-score points. Repeating the game move is never accepted.

Dragging a pawn to the last rank opens a piece picker, so underpromotions can be played. Moves you explore on the board keep the game's history. Stockfish and the repetition check therefore see earlier positions, and the variation tag notes when a draw can be claimed under the threefold or 50-move rule.

## Optional AI explanations

The presets are **GPT-6.2 Sol** for OpenAI, **DeepSeek V4.1 Flash** for DeepSeek, and **Gemini 4 Hydrogen** for Google. Each receives the selected position and Stockfish continuations after you request an explanation and approve the provider permission. The API key you enter is stored in the browser extension and sent to your chosen endpoint for authentication. The review and scoring work offline with imported PGNs. [OpenAI](https://developers.openai.com/api/docs/models/gpt-6.2-sol) · [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/) · [Gemini](https://aistudio.google.com/docs/openai)

## Practical impact calibration

Practical impact compares the expected human game score of the played move and Stockfish's best candidate from the same decision. Each candidate uses the same recorded post-move clocks. The number is in points on a 0–100 expected-score scale. It is available on supported standard-start positions from ply 8 through 120. A fitted position-only curve is used when either clock is missing. Forced moves, mate evaluations, custom starts, and declared time controls outside the model's range use engine review alone.

ChessBot uses the larger of the practical and engine expected-score losses to prioritize existing error drills. It also checks a practical loss of at least five points with a deeper search. The engine-accuracy formula still uses Lichess-style scoring, so the practical estimate does not enter the accuracy percentage.

### Benchmark

The trainer used one deterministic sample position per game from three 64 MiB prefixes of the Lichess rated standard PGN archives. It fitted coefficients on February 2026, selected among candidate curves on May 2026, and measured the resulting model on October 2026. Samples include annotated human bullet, blitz, and rapid games with supported increment clocks. The target was the actual game score (1 for a White win, ½ for a draw, and 0 for a Black win). All curves received the same recorded centipawn evaluations. [Lichess CC0 data](https://database.lichess.org/#standard_games)

| Expected-score model | May validation MSE (19,013 games) | October holdout MSE (17,882 games) |
| --- | ---: | ---: |
| Published Lichess curve | 0.20884 | 0.20853 |
| Refit position-only curve | 0.20596 | 0.20312 |
| Position and ply | 0.20589 | 0.20316 |
| Position, ply, time control, and clocks | **0.19724** | **0.19641** |

October's clock-aware model reduced squared prediction error by 5.8% versus the published curve, with gains in all three supported time classes. The largest gain was in games that ended on time. In the subgroup that eventually ended normally, the clock-aware model increased MSE from 0.18609 to 0.19098. Termination was used only for that retrospective breakdown. The position-only fallback improved overall holdout MSE by 2.6%. [Benchmark output and source hashes](research/calibration-2026-10.json)

The main test measures forecasts from observed Lichess positions using the archive evaluations. A secondary check rescored 431 October positions with the bundled full Stockfish 19 network at depth 13 and single PV. It chose games whose first four SHA-256 bytes of the PGN Site tag, read as a big-endian integer, were divisible by 40. Clock-aware MSE fell from 0.19897 to 0.19150 on that subset. Its approximate 95% interval for the absolute improvement was −0.00232 to 0.01727, so the smaller check was inconclusive.

Chess.com calibration, the effects of unplayed alternatives, and the learning benefit of the new drill order remain unverified.

To reproduce the benchmark, use `zstd` and Python with NumPy and SciPy. Download the three byte ranges and run the trainer from the repository root.

```sh
for month in 2026-02 2026-05 2026-10; do
  curl --fail --location --range 0-67108863 --max-filesize 67108864 \
    "https://database.lichess.org/standard/lichess_db_standard_rated_${month}.pgn.zst" \
    --output "${month}.pgn.zst"
done

python3 scripts/calibrate.py --train 2026-02.pgn.zst --validation 2026-05.pgn.zst \
  --test 2026-10.pgn.zst --model calibration-data.js
```

## Search confidence and Decision Quality

The normal review starts each game with a cleared Stockfish search table. ChessBot rechecks sharp positions, suspected errors, and moves close to a grade boundary two plies deeper. A third, broader pass searches three candidates four plies deeper and then compares the played move at the same root. It runs only when the grade is still at risk:

- the grade changed between the first two passes,
- Great or Brilliant praise did not hold, or
- a same-grade loss moved more than 2.5 points toward the Inaccuracy/Mistake line at 10 or the Mistake/Blunder line at 20, by enough to cross it if it kept moving.

Great and Brilliant require the underlying distinction to persist across completed depths. The move card flags a grade that changed between the last two passes and shows the depth used.

**Decision Quality** is a second 0–100 score. ChessBot subtracts the root-mean-square expected-score loss from 100, counting only decisions with more than one legal move. Squaring the losses gives large mistakes more influence. The largest individual loss is shown alongside the score. The original accuracy percentage uses its Lichess-style game weighting.

## How often players find a sound move

ChessBot estimates which moves a player is likely to choose, then asks how many of them are sound. Once the review finishes, the move card runs one extra Stockfish search over every legal move at depth 14 (about 0.36 million nodes). A depth-12 version rated some traps as the best move, such as 4. Nxe5 against 3...Nd4 in the Italian Game, so v3.4 uses the deeper search. A softmax model then assigns each move a probability. It combines Stockfish's expected-score loss for that move with features that make a move look natural or tempting: captures, recaptures, checks, promotions, castling, piece type, moving an attacked piece, leaving a piece en prise, retreats, and distance. Lichess ratings change how strongly losses and tactics count, and a low clock makes losses count less.

The card shows two things:

- **Players find a sound move** — the calibrated chance of choosing a move that loses at most five expected-score points, the Good grade boundary.
- **Most tempting mistake** — the unsound move the model rates most likely, with its share of players and its loss. It is hidden below 8%.

Lichess games with supported ratings use the rated model, and other games use the unrated one. Until the extra search finishes, or if it can't run, the card shows the earlier cohort estimate. That estimate uses only the root evaluation and position features.

### Benchmark

Training used one decision per game from the February 2026 Lichess prefix (5,000 decisions), with the move the player chose as the label. May (1,200 decisions) chose the regularization and fitted the find-rate calibration. August (2,500 decisions) and 1,431 rated October 2026 Chess.com games were held out. The Chess.com games came from players in a public club, through the public API. That sample skews toward lower ratings, with a median near 900. The target for held-out decisions comes from the extension's own depth-16 comparison of the played move: sound means a loss of at most five points. The cohort model was scored on the same decisions and target, both as shipped and refit to this target on May. Comparisons cover decisions the cohort model supports, 2,415 in August and 1,345 on Chess.com.

| Find-rate model | August Lichess Brier | October Chess.com Brier |
| --- | ---: | ---: |
| Cohort model, as shipped in v3.3 | 0.1569 | 0.1421 |
| Cohort model refit to this target | 0.1531 | 0.1373 |
| Stockfish loss for every move only | 0.1396 | 0.1268 |
| Move-level model, unrated | 0.1313 | **0.1246** |
| Move-level model, Lichess ratings | **0.1305** | — |

Lower is better. Against the shipped cohort model, the move-level model lowered the Brier score by 0.0264 (95% interval 0.0212 to 0.0315) in August and by 0.0175 (95% interval 0.0112 to 0.0238) on Chess.com. Scoring every move accounts for most of the gain. The human features added 0.0083 (95% interval 0.0051 to 0.0115) on Lichess. On Chess.com they added 0.0021 (95% interval -0.0020 to 0.0063), which is not distinguishable from zero.

The all-moves search starts from a cleared Stockfish table, both here and in the extension. An earlier draft ran it right after the deep comparison of the played move. That left the played move's deep result in the table and lowered the August Brier score by about 0.015 at depth 12. It is a leak, because it singles out the move the player chose. Under matched conditions, a depth-12 search scored about the same as depth 14: 0.1323 in August and 0.1237 on Chess.com. It missed traps such as the one above, however.

| Move prediction | August Lichess | October Chess.com |
| --- | ---: | ---: |
| Chosen move ranked first, Stockfish loss only | 26% | 25% |
| Chosen move ranked first, move-level model | 34% | 36% |
| Chosen move in the top three, move-level model | 58% | 59% |
| Mistake matched the most tempting mistake | 27% of 562 | 23% of 293 |
| Mistake matched the smallest unsound loss | 23% | 17% |
| Mistake matched by chance | 4% | 4% |

Ties count as partial matches. The mistake rows cover decisions where the player's move lost more than five points in the depth-14 search and at least one other move was also unsound. The model is much lighter than Maia-style neural networks, and its features are fixed rather than learned. The held-out target excludes the deeper rechecks that a full review runs on about two in five decisions. Teaching effectiveness and calibration above Chess.com's sampled rating range remain unverified. [Move-level benchmark](research/human-moves-2026-11.json)

To reproduce it, download the February, May, and August archive prefixes. Collect the rows, then fit. The Chess.com rows are optional.

```sh
node scripts/collect-human-moves.mjs --lichess 2026-02.pgn.zst --out train.jsonl --count 5000 --workers 6
node scripts/collect-human-moves.mjs --lichess 2026-05.pgn.zst --out validation.jsonl --count 1200 --workers 6 --deep
node scripts/collect-human-moves.mjs --lichess 2026-08.pgn.zst --out test.jsonl --count 2500 --workers 6 --deep
node scripts/fetch-chesscom-games.mjs --month 2026/10 --games 1500 --out chesscom-games.jsonl
node scripts/collect-human-moves.mjs --chesscom chesscom-games.jsonl --out chesscom.jsonl --count 1500 --workers 6 --deep
python3 scripts/train-human-moves.py --train train.jsonl --validation validation.jsonl --test test.jsonl \
  --chesscom chesscom.jsonl --model human-move-data.js --report research/human-moves-2026-11.json
```

### Cohort model

The earlier cohort model uses the position before the move, legal choices, captures, remaining material, check, and Stockfish's evaluation. In supported Lichess games, it can also use both player ratings and pre-move clocks. The position-only model supplies the estimate for Chess.com games and PGNs without supported ratings or clock metadata. The percentage is rounded to five-point increments and describes a cohort, including the possibility of several sound alternatives.

The trainer sampled one decision per annotated game from 64 MiB prefixes of Lichess rated bullet, blitz, and rapid archives. The target was whether the observed move lost at most five points under the Lichess centipawn curve. February 2026 supplied training data, May selected the feature sets, and August was held out. [Lichess CC0 archive](https://database.lichess.org/#standard_games)

| Model | August Brier score, 7,323 decisions |
| --- | ---: |
| Single average find rate | 0.17900 |
| Engine evaluation and move number | 0.17586 |
| Position, including legal choices and tactical context | 0.17437 |
| Position, clocks, and Lichess ratings | 0.17212 |

Lower is better. Adding clocks without ratings did not improve the May validation result, so the browser uses the position model for that case. The held-out target uses adjacent archive evaluations. Calibration on Chess.com and teaching effectiveness remain unverified. [Difficulty benchmark](research/difficulty-2026-08.json)

To reproduce the fit, use the previous archive download command for February, May, and August. With `zstd`, NumPy, SciPy, and `chess==1.11.2` installed, run the trainer.

```sh
python3 scripts/train-difficulty.py --train 2026-02.pgn.zst --validation 2026-05.pgn.zst \
  --test 2026-08.pgn.zst --model difficulty-data.js
```

### Deeper-search benchmark

The benchmark sampled 72 isolated decisions from the October 2026 Lichess archive. Both releases started at the normal depth-16 target. The reference used full Stockfish 19 at uncapped depth 22, with a broad three-move search and the played move included in the matched comparison. The harness cleared the search table between independent positions.

| Measurement | v3.2 | v3.3 |
| --- | ---: | ---: |
| Exact grade agreement | 52 / 72 | 57 / 72 |
| Severe versus nonsevere agreement | 71 / 72 | 72 / 72 |
| Mean absolute expected-score loss error | 0.776 pts | 0.731 pts |
| Mean absolute capped centipawn loss error | 14.13 cp | 14.46 cp |
| Mean reported search nodes | 0.93 million | 1.31 million |

The change in expected-score error was inconclusive. Its approximate 95% interval was −0.314 to +0.224 points. Average search nodes increased by 41%, with the additional work concentrated in the deeper cases. Five v3.3 decisions were flagged as uncertain. The reference awards eligible praise from a single deeper comparison. The production review requires stability across comparisons, which can affect exact label agreement. Isolated decisions omit prior opponent errors when assigning a Miss. [Paired benchmark results](research/search-review-2026-10.json)

To reproduce the search benchmark, unpack the v3.2.0 extension to a separate directory and use the October archive prefix downloaded above.

```sh
python3 scripts/sample-review-positions.py 2026-10.pgn.zst > review-positions.jsonl
node scripts/benchmark-review.mjs --input review-positions.jsonl \
  --baseline /path/to/unpacked-v3.2.0 --candidate . --cache /tmp/chessbot-review-cache
```

### Broad-pass policy benchmark

In the v3.3 benchmark, a run without the broad pass matched three fewer grades and used 26% fewer nodes. To find which decisions need it, v3.4 records the grade and loss after every pass. One run then executed the broad pass on every rechecked decision. Skipping that pass leaves the first two unchanged, so each rule below is an exact replay of the same searches. The rule was chosen on the original 72 decisions and then checked on the next 72 from the same archive, which played no part in the choice. The reference is the same depth-22 search.

| Broad-pass rule | Exact grades (choice / holdout) | Severe vs nonsevere | Mean loss error | Mean nodes | 90th-percentile nodes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Never | 54 / 60 | 71 / 71 | 0.715 pts | 0.97 million | 2.20 million |
| Any loss change over 2.5 points (v3.3) | 57 / 59 | 72 / 70 | 0.632 pts | 1.32 million | 3.68 million |
| Grade change or failed praise | 56 / 59 | 71 / 70 | 0.629 pts | 1.21 million | 3.04 million |
| **Grade at risk (v3.4)** | **57 / 59** | **72 / 70** | **0.609 pts** | **1.23 million** | **3.42 million** |
| Always | 59 / 62 | 72 / 70 | 0.528 pts | 2.17 million | 6.25 million |

Mean errors and node counts cover all 144 decisions. The v3.4 rule matches v3.3's grades with 7% fewer nodes on average. Its lower loss error is within sampling noise, since only 11 of 144 decisions ran a broad pass. Running it on every rechecked decision gained five exact grades for 64% more work. A deeper review setting could offer that trade. [Policy comparison](research/search-policy-2026-11.json)

```sh
node scripts/benchmark-review.mjs --input review-positions.jsonl --baseline /path/to/unpacked-v3.2.0 \
  --candidate . --cache /tmp/chessbot-review-cache --count 144 --policy always > always.json
python3 scripts/simulate-search-policy.py --report always.json
```
