# Benchmarks

Each model and search rule in ChessBot was fitted on one set of games and measured on games it had not seen. The sections below give the results and the commands to reproduce them. Raw outputs and source hashes are in [`research/`](../research/). For what each model does in the extension, see [methodology.md](methodology.md).

## Practical impact calibration

The trainer used one deterministic sample position per game from three 64 MiB prefixes of the Lichess rated standard PGN archives. It fitted coefficients on February 2026, selected among candidate curves on May 2026, and measured the resulting model on October 2026. Samples include annotated human bullet, blitz, and rapid games with supported increment clocks. The target was the actual game score (1 for a White win, ½ for a draw, and 0 for a Black win). All curves received the same recorded centipawn evaluations. [Lichess CC0 data](https://database.lichess.org/#standard_games)

| Expected-score model | May validation MSE (19,013 games) | October holdout MSE (17,882 games) |
| --- | ---: | ---: |
| Published Lichess curve | 0.20884 | 0.20853 |
| Refit position-only curve | 0.20596 | 0.20312 |
| Position and ply | 0.20589 | 0.20316 |
| Position, ply, time control, and clocks | **0.19724** | **0.19641** |

October's clock-aware model reduced squared prediction error by 5.8% versus the published curve, with gains in all three supported time classes. The largest gain was in games that ended on time. In the subgroup that eventually ended normally, the clock-aware model increased MSE from 0.18609 to 0.19098. Termination was used only for that retrospective breakdown. The position-only fallback improved overall holdout MSE by 2.6%. [Benchmark output and source hashes](../research/calibration-2026-10.json)

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

## How often players find a sound move

### Move-level model (v3.4)

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

Ties count as partial matches. The mistake rows cover decisions where the player's move lost more than five points in the depth-14 search and at least one other move was also unsound. The model is much lighter than Maia-style neural networks, and its features are fixed rather than learned. The held-out target excludes the deeper rechecks that a full review runs on about two in five decisions. Teaching effectiveness and calibration above Chess.com's sampled rating range remain unverified. [Move-level benchmark](../research/human-moves-2026-11.json)

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

Lower is better. Adding clocks without ratings did not improve the May validation result, so the browser uses the position model for that case. The held-out target uses adjacent archive evaluations. Calibration on Chess.com and teaching effectiveness remain unverified. [Difficulty benchmark](../research/difficulty-2026-08.json)

To reproduce the fit, use the previous archive download command for February, May, and August. With `zstd`, NumPy, SciPy, and `chess==1.11.2` installed, run the trainer.

```sh
python3 scripts/train-difficulty.py --train 2026-02.pgn.zst --validation 2026-05.pgn.zst \
  --test 2026-08.pgn.zst --model difficulty-data.js
```

## Search depth and grade accuracy

### Deeper-search benchmark

The benchmark sampled 72 isolated decisions from the October 2026 Lichess archive. Both releases started at the normal depth-16 target. The reference used full Stockfish 19 at uncapped depth 22, with a broad three-move search and the played move included in the matched comparison. The harness cleared the search table between independent positions.

| Measurement | v3.2 | v3.3 |
| --- | ---: | ---: |
| Exact grade agreement | 52 / 72 | 57 / 72 |
| Severe versus nonsevere agreement | 71 / 72 | 72 / 72 |
| Mean absolute expected-score loss error | 0.776 pts | 0.731 pts |
| Mean absolute capped centipawn loss error | 14.13 cp | 14.46 cp |
| Mean reported search nodes | 0.93 million | 1.31 million |

The change in expected-score error was inconclusive. Its approximate 95% interval was −0.314 to +0.224 points. Average search nodes increased by 41%, with the additional work concentrated in the deeper cases. Five v3.3 decisions were flagged as uncertain. The reference awards eligible praise from a single deeper comparison. The production review requires stability across comparisons, which can affect exact label agreement. Isolated decisions omit prior opponent errors when assigning a Miss. [Paired benchmark results](../research/search-review-2026-10.json)

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

Mean errors and node counts cover all 144 decisions. The v3.4 rule matches v3.3's grades with 7% fewer nodes on average. Its lower loss error is within sampling noise, since only 11 of 144 decisions ran a broad pass. Running it on every rechecked decision gained five exact grades for 64% more work. A deeper review setting could offer that trade. [Policy comparison](../research/search-policy-2026-11.json)

```sh
node scripts/benchmark-review.mjs --input review-positions.jsonl --baseline /path/to/unpacked-v3.2.0 \
  --candidate . --cache /tmp/chessbot-review-cache --count 144 --policy always > always.json
python3 scripts/simulate-search-policy.py --report always.json
```
