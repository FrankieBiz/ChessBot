# Validation Harness and Rating-Aware Grading — Design

Date: 2026-11-23
Status: Draft for review

## Goal

Raise the accuracy and credibility of ChessBot's move grading. Part B builds a larger,
statistically honest validation harness. Part A uses it to ship rating- and clock-aware
grading. B comes first so that every A change is measured, not anecdotal.

## Motivation (from the README's own caveats)

1. Calibration is fitted on Lichess, but the primary input is Chess.com games, which are unvalidated.
2. Grade thresholds are "ChessBot heuristics", not fitted to anything.
3. The v3.3 deeper-search benchmark (72 positions) was inconclusive: 95% interval of
   -0.314 to +0.224 points; exact grade agreement 57/72.
4. The Practical Impact secondary check (431 positions) was inconclusive.
5. Accuracy uses one Lichess-style curve for all players and ignores rating.

## Decisions

- **Ground truth:** deep-engine reference (full Stockfish 19, depth 22, 3 PV, hash cleared per position).
  Measures agreement with the engine, not with human judgment. Reproducible and scalable.
- **Chess.com holdout:** sampled from the public `api.chess.com` monthly archives by an offline script.
- **Sequencing:** B then A.
- **Reuse first:** `benchmark-review.mjs` already has a cached resumable reference pass, exact-grade
  agreement, expected-score error, and a paired normal-approximation interval. `difficulty-model.js`
  already gives a rating- and clock-conditioned P(sound move). The branch `feat/v3.4-coaching-search`
  also has an in-progress `human-move-model.js` (softmax over legal moves, `soundChance`) with
  `human-move-data.js` and `scripts/collect-human-moves.mjs`. This design extends those; it adds no
  parallel system.
- **Out of scope:** Maia-style neural move prediction (extension size is already ~76 MiB per ZIP);
  revisit only if the benchmark shows a gap. Motif-based explanations (separate effort).

## Part B: Validation harness (scripts only; no extension changes until step 4)

### Sampler
- Extend `scripts/sample-review-positions.py` to draw ~1,500 decisions, stratified by time class,
  rating band, game phase, and eval-loss bucket, so boundary cases are not drowned by easy "Best" moves.
- New `scripts/sample-chesscom.py` pulls public monthly archives across rating bands, with rate
  limiting and a cached manifest. Keeps only PGN plus metadata (ratings, clocks, time control) and
  records SHA-256 of sources.
- Chess.com archives carry no engine evals, so the Chess.com holdout is stratified by time class,
  rating band, and game phase only. Eval-loss strata apply to the Lichess sample (which has `%eval`).

### Reference labeller
- Reuses the existing reference pass in `benchmark-review.mjs` (full Stockfish 19, depth 22, 3 PV, hash
  cleared per position, cached and resumable). New work: add `phase` and `source` fields to each row,
  and skip bad PGNs with a logged reason.
- Measured cost (`research/search-review-2026-10.json`, 4 workers): mean 15.1 s, median 10.4 s,
  p90 29.7 s per position. 1,500 positions is roughly 1.6 hours wall-clock with 4 workers, about 6 hours
  on a single worker. Plan for an overnight resumable run, or reduce the first sample to ~600.

### Evaluator
- The script already reports exact-grade agreement, expected-score error, and a normal-approximation
  paired interval. Extend it to **bootstrap confidence intervals**, broken out by grade, phase, and
  source (Lichess vs Chess.com).
- The report labels a result "inconclusive" when the interval spans zero.

### Threshold fitting
- Grid-search grade boundaries to maximise agreement with the reference on the Lichess train split;
  select on a validation split; report on the Chess.com holdout.
- Output a data file (same style as `calibration-data.js`) so thresholds are fitted, not hardcoded.

### CI guard
- A fixed fixture of ~100 positions with committed reference labels. Live candidate reviews take minutes,
  so this runs as a separate command (`npm run bench:guard`) and CI job, not in the default `npm test`.
  It fails if agreement drops by more than an agreed margin. `npm test` keeps only fast unit tests.

## Part A: Rating-aware grading

- Engine-based grade stays the primary label. A conditioning layer on rating and clock adds a
  **"hard to find / expected at your level"** qualifier.
- `difficulty-model.js` already estimates P(find a sound move) conditioned on rating and clock, and
  `human-move-model.js` (in progress on this branch) predicts it from all legal moves. Step 0 of Part A is to
  decide which single model is canonical (compare held-out Brier/log loss with the harness) and retire or
  merge the other. Part A then extends that model; it does not add a third.
- **Chess.com ratings:** `difficulty-model.js` currently accepts rating features only on lichess.org
  and trains on the Lichess scale, so the rating layer would not fire on Chess.com, the primary input.
  Part A must define the Chess.com path: either fit a Chess.com-to-Lichess rating mapping from the holdout,
  or fit rating coefficients on Chess.com data directly. Without one of these, the layer is Lichess-only
  and the spec must say so.
- Coefficients ship as a data file, like `difficulty-data.js`.
- Great and Brilliant additionally require the move to be unlikely for that rating, which removes
  meaningless "Great" labels on obvious recaptures.
- Fallback: no rating or clock means the existing position-only model. Plain PGNs do not regress.
- Ship the layer only if held-out Brier score or log loss improves with an interval that excludes zero,
  on both the Lichess test split and the Chess.com holdout; otherwise it stays behind a flag.

## Rollout order

0. Reconcile `difficulty-model.js` and `human-move-model.js` (Part A step 0), since it affects what
   the later steps extend.
1. Sampler and reference labeller.
2. Evaluator with confidence intervals.
3. Re-benchmark v3.3 for a baseline with real intervals.
4. Threshold fitting (first extension change).
5. Rating-aware layer behind a feature flag.
6. CI fixture.

Each step is independently shippable.

## Reproducibility and failure handling

- Every artifact (samples, reference labels, fitted coefficients) records source archive, byte range,
  SHA-256, and script version in `research/*.json`. README benchmark tables are regenerated from these
  files, not hand-edited.
- Chess.com API throttling or errors: back off, fall back to the cached manifest.
- Missing or out-of-range rating/clock: fall back to the position-only model.

## Testing

- Unit tests for new model functions in the existing `tests/*.test.js` style.
- CI fixture guards against grading regressions.
- Benchmark runs use 4 workers for throughput. If results look uniformly wrong (identical instant
  failures), suspect the harness and rerun with `--workers 1` before debugging logic.

## Honesty guard

The README states every result with its interval. Claims that do not clear the interval check are
published as "inconclusive".
