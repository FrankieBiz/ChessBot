# Benchmarks

Each model and search rule in ChessBot was fitted on one set of games and measured on games it had not seen. The sections below give the results and the commands to reproduce them. Raw outputs and source hashes are in [`research/`](../research/). For what each model does in the extension, see [methodology.md](methodology.md).

## Opening explorer and expanded coverage

ChessBot 3.7 uses 153,664 rated standard blitz, rapid, and classical games with both players rated at least 2100. The sample spans eight monthly archive prefixes in 2026. The 8,192 named position-move pairs stay in the book. Game-derived coverage grows from 211 to 5,774 pairs by sampling more games and extending the lookup through ply 26. Inclusion still requires at least 20 games, 5% of the observed moves played at that position, and five games in each of two or more months. [Lichess rated archive](https://database.lichess.org/#standard_games) · [Lichess opening lines](https://github.com/lichess-org/chess-openings/tree/48a8c0e733facfdc9a3723fe882e51ec28014074)

The explorer gives White-win, draw, and Black-win counts for up to eight choices from each position, based on at least 20 observations at the position and five for the choice. The counts describe this high-rated Lichess sample. ChessBot uses the same engine checks for Book labels as in 3.6.

The 6,657-game October holdout uses the same independent block as the 3.6 benchmark. Book columns report exact played moves found in each catalog before the engine check. The explorer column reports positions with at least one sampled alternative. Coverage is highest in the first few moves and falls in deeper, less common positions. [Per-ply counts and source hashes](../research/opening-explorer-2026-11.json)

| Ply | 3.6 Book | 3.7 Book | Explorer |
| ---: | ---: | ---: | ---: |
| 4 | 80.7% | 90.3% | 97.3% |
| 6 | 53.2% | 72.9% | 86.5% |
| 8 | 33.3% | 50.9% | 66.9% |
| 10 | 18.8% | 31.7% | 45.1% |
| 12 | 9.4% | 17.3% | 28.0% |
| 16 | 1.9% | 4.0% | 6.6% |
| 20 | 0.6% | 0.9% | 1.4% |

To rebuild the bundled catalogs, use `npm ci`, `curl`, and `zstd`. Run these commands from the repository root. The generator checks the SHA-256 of each input, replays the PGNs, and compares the catalogs on the October block.

```sh
opening_archive_dir=$(mktemp -d)
for month in 2026-01 2026-02 2026-03 2026-04 2026-05 2026-06 2026-08 2026-09; do
  case "$month" in
    2026-02|2026-05|2026-08) bytes=67108864 ;;
    *) bytes=268435456 ;;
  esac
  curl --fail --location --retry 2 --range "0-$((bytes - 1))" --max-filesize "$bytes" \
    "https://database.lichess.org/standard/lichess_db_standard_rated_${month}.pgn.zst" \
    --output "${opening_archive_dir}/${month}.pgn.zst" || exit 1
done
curl --fail --location --range 70160138-137269001 --max-filesize 67108864 \
  "https://database.lichess.org/standard/lichess_db_standard_rated_2026-10.pgn.zst" \
  --output "${opening_archive_dir}/2026-10.pgn.zst" || exit 1
node scripts/build-opening-book.mjs "${opening_archive_dir}" "${opening_archive_dir}/2026-10.pgn.zst"
```

## Opening book coverage

Replaying 3,865 named Lichess opening lines gives 8,192 position-move pairs. The first 64 MiB of each February, May, and August 2026 Lichess rated archive yielded 18,168 human blitz, rapid, and classical games with both players rated at least 2100. The generator adds moves through ply 20 if at least 20 games played the move, it accounted for at least 5% of plays from that position, and at least five games played it in each of two months. This adds 211 pairs and 1.4 KiB to the gzip-compressed data module. Both data sources are released under CC0. [Lichess opening lines](https://github.com/lichess-org/chess-openings/tree/48a8c0e733facfdc9a3723fe882e51ec28014074) · [Lichess rated archives](https://database.lichess.org/#standard_games)

A separate October 2026 block contained 6,657 eligible games. Each row gives the share of played moves at that ply found in the catalog before applying the Stockfish screen. A ply is one move by either player. Coverage remains sparse later in the opening. [Per-ply counts and source hashes](../research/opening-book-2026-11.json)

| Ply | Named lines | Named lines and game sample |
| ---: | ---: | ---: |
| 3 | 87.2% | 91.4% |
| 4 | 73.5% | 80.7% |
| 5 | 60.8% | 67.9% |
| 6 | 49.1% | 53.2% |
| 8 | 29.9% | 33.3% |
| 10 | 17.9% | 18.8% |
| 12 | 9.4% | 9.4% |
| 20 | 0.5% | 0.6% |

To regenerate this catalog and print the October results, use a checkout of ChessBot 3.6 at `bcc32d8`. Install dependencies with `npm ci`, make `zstd` available, then run these commands from that checkout. The generator checks the three source archive hashes.

```sh
opening_archive_dir=$(mktemp -d)
for month in 2026-02 2026-05 2026-08; do
  curl --fail --location --range 0-67108863 --max-filesize 67108864 \
    "https://database.lichess.org/standard/lichess_db_standard_rated_${month}.pgn.zst" \
    --output "${opening_archive_dir}/${month}.pgn.zst"
done
curl --fail --location --range 70160138-137269001 --max-filesize 67108864 \
  "https://database.lichess.org/standard/lichess_db_standard_rated_2026-10.pgn.zst" \
  --output "${opening_archive_dir}/2026-10.pgn.zst"
node scripts/build-opening-book.mjs "${opening_archive_dir}" "${opening_archive_dir}/2026-10.pgn.zst"
```

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

## Single-game rating feasibility

The benchmark predicts a player's recorded pregame Lichess rating from one annotated game. This target measures how much one game's moves tell us about a player's established rating. Chess.com's Game Rating instead compares a game's play with expectations for the player's known rating. Research on intrinsic ratings and rating-conditioned move prediction supports testing richer models, with separate validation for each population. [Chess.com Game Rating](https://support.chess.com/en/articles/10773754-how-is-game-rating-calculated-in-game-review) · [Regan and Haworth](https://ojs.aaai.org/index.php/AAAI/article/view/7951) · [Maia-2](https://arxiv.org/abs/2409.20553)

The benchmark uses the first 64 MiB of the February, May, and October 2026 Lichess rated standard archives for fitting, interval calibration, and testing. Each game contributes at most one side, selected by a hash of its game ID. Distinct username hash buckets keep evaluated players disjoint across splits, and the sampler retains at most one game per evaluated player. Both ratings are between 800 and 2600, and each sampled side has at least eight decisions scored from adjacent annotations covering at least 80% of its moves. Models are fitted separately for bullet, blitz, and rapid. The opponent-based baselines use the opponent's recorded rating in the same pool, which is available in these rated games and reflects matchmaking. [Lichess archive documentation](https://database.lichess.org/#standard_games)

Move quality uses the archive's adjacent-position evaluations and the Lichess-style move accuracy curve. The richer model adds decision count, root-mean-square loss, frequency of losses above ten points, and mean loss in each move-number band. These band features use moves 1–10, 11–25, and 26 onward for the chosen side. ChessBot's full review uses a common-root Stockfish comparison and excludes forced moves. The archived data offers a less expensive test of rating prediction. [Lichess accuracy](https://lichess.org/page/accuracy)

| Time class | Held-out games | Mean move accuracy only MAE | Richer move quality MAE | Move-quality 90% interval half-width | Opponent + result MAE | Opponent + result + quality MAE |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Bullet | 769 | 325.8 | 313.2 | ±633.8 | 50.9 | 51.2 |
| Blitz | 1,813 | 301.8 | 283.1 | ±594.4 | 44.8 | 45.6 |
| Rapid | 1,420 | 279.4 | 257.3 | ±545.8 | 55.5 | 55.4 |

Errors and interval widths are in Lichess rating points. The move-only intervals cover 90.4%, 91.6%, and 91.6% of held-out ratings, respectively. Among players who made at least 35 moves, the richer move-only model still has MAE of 304.9, 280.8, and 251.2. Adding move quality to opponent rating and game result changes MAE by +0.29 in bullet (paired bootstrap 95% interval −0.18 to +0.77), +0.74 in blitz (+0.33 to +1.14), and −0.06 in rapid (−0.66 to +0.54). The report also includes training-cohort and opponent-only baselines, interval coverage by game length, and rating error by move-number band. [Held-out results and archive hashes](../research/game-rating-2026-11.json)

This stays a research benchmark. The sample represents annotated games in the selected Lichess rating pools. Coverage and errors may differ for other pools, time controls, and review engines. A game-performance metric for ChessBot would need a defined target beyond reproducing a known rating, plus holdout tests on Chess.com games and on longer sequences of play.

```sh
python3 scripts/benchmark-game-rating.py --train 2026-02.pgn.zst \
  --validation 2026-05.pgn.zst --test 2026-10.pgn.zst
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

### Complete-search result handling (v3.6)

The v3.6 run replayed the same 72 October decisions from the deeper-search benchmark. It compared the v3.5 source at commit `704db0a` with the v3.6 search code, starting at depth 16 on the same Stockfish.js 19.0.1 build. The reference used an uncapped depth-22 matched comparison and the v3.5 grader. The harness clears the search table before each isolated decision. [Paired benchmark results](../research/search-reliability-2026-11.json)

| Measurement | v3.5 | v3.6 |
| --- | ---: | ---: |
| Exact grade agreement | 58 / 72 | 60 / 72 |
| Severe versus nonsevere agreement | 72 / 72 | 72 / 72 |
| Mean absolute expected-score loss error | 0.700 pts | 0.567 pts |
| Mean absolute capped centipawn loss error | 14.19 cp | 14.07 cp |
| Decisions flagged as uncertain | 2 | 3 |
| Mean reported search nodes | 1.205 million | 1.284 million |

Four decisions used a deeper completed comparison. In one, the restored comparison triggered a broader search. The grade changed from Blunder to Mistake, matching the depth-22 reference, and the move card flagged the disagreement between the completed passes. That position accounted for the 6.5% increase in mean nodes and nearly all of the reduction in expected-score loss error. The paired change in error was −0.133 points, with an approximate 95% interval from −0.393 to +0.127. This replay checks the handling of capped searches and gives an inconclusive estimate of the effect on average grading error.

To reproduce the comparison, generate the October sample as above and point the harness at a v3.5 build or a checkout with its vendored chess.js generated.

```sh
node scripts/benchmark-review.mjs --input review-positions.jsonl \
  --baseline /path/to/v3.5.0 --candidate . --cache /tmp/chessbot-v36-review-cache --count 72
```

### Optional Deep Check (v3.7)

The audit uses the first rated Bullet, Blitz, and Rapid game in a separate September 2026 Lichess prefix with 24 to 38 plies and at least two discretionary decisions in each phase. Each game is reviewed from start to finish at the normal depth-16 target, keeping the search table and previous opponent loss between moves. Every discretionary decision then receives a Deep Check on a cleared copy of the packaged WASM engine. The reference uses official native Stockfish 19 at uncapped depth 22, with a fresh shortlist and the played move compared at the same root and depth. All three grades use the opponent-loss context from the original review. [Lichess CC0 archive](https://database.lichess.org/#standard_games) · [Stockfish 19 release](https://github.com/official-stockfish/Stockfish/releases/tag/sf_19)

Deep Check can issue up to 9 million nodes of cumulative search budget across two passes. It returns a result only when it finds a complete comparison deeper than the original. The deepest returned comparison can stand alone or be corroborated by a separate completed depth. The comparison below uses the initial grade wherever Deep Check found no deeper result. Difficulty groups use the cohort find-rate estimate from the initial review, with 70% and above classed as easy, 40% through 69% as moderate, and lower values as difficult. Early positions and mate evaluations can lack an estimate.

To reproduce the audit, use `npm ci`, `npm test` to prepare the chess.js vendor module, `zstd`, and the official native Stockfish 19 release for your platform. The sample here starts at the beginning of the archive and uses its first 16 MiB.

```sh
curl --fail --location --range 0-16777215 --max-filesize 16777216 \
  https://database.lichess.org/standard/lichess_db_standard_rated_2026-09.pgn.zst \
  --output 2026-09.pgn.zst
node scripts/benchmark-deep-check.mjs --archive 2026-09.pgn.zst \
  --reference-stockfish /path/to/stockfish --workers 5
```

### Parallel two-phase review

ChessBot reviews a game on up to four single-threaded Stockfish engines. The quick phase searches every position and compares every move at the review depth. The deeper checks then run, and each one first repeats its move's quick searches from a cleared search table. Single-threaded Stockfish is deterministic from a cleared table, so each result equals checking that move on its own in one run. The timing test used three rated 10+0 Lichess games from October 2026 between players rated 1335 to 1426. It ran on a MacBook Air with an Apple M3, which has no fan and slows under sustained load.

| Game | Plies | One engine, move by move | Quick phase, four engines | Full review, four engines | Moves identical to separate checks |
| --- | ---: | ---: | ---: | ---: | ---: |
| [oJHcigqo](https://lichess.org/oJHcigqo) | 70 | 351.6 s | 29.8 s | 139.3 s | 70 / 70 |
| [PERrcovj](https://lichess.org/PERrcovj) | 71 | 136.0 s | 17.3 s | 69.9 s | 71 / 71 |
| [Vg0fM6xz](https://lichess.org/Vg0fM6xz) | 79 | 124.7 s | 20.4 s | 49.4 s | 79 / 79 |

Full reviews were 1.9 to 2.5 times faster, and the complete quick-phase summary appeared after 17 to 30 seconds. Six or eight engines were no faster than four on this machine, because the extra cores are efficiency cores. Machines with more performance cores or better cooling should gain more. On the 144 decisions of the search benchmark, every pooled grade, loss, and confidence label also matched. The grades kept the same agreement with the depth-22 reference: 118 exact, 142 severe versus nonsevere, and 0.543 points mean loss error. Starting deeper checks from a cleared table without repeating the quick searches gave 0.806 points mean loss error, so ChessBot repeats them. [Results](../research/review-speed-2026-11.json)

```sh
node scripts/benchmark-review-speed.mjs --pgn games.pgn --check
```

