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
- **Out of scope:** Maia-style neural move prediction (extension size is already ~76 MiB per ZIP);
  revisit only if the benchmark shows a gap. Motif-based explanations (separate effort).

## Part B: Validation harness (scripts only; no extension changes until step 4)

### Sampler
- Extend `scripts/sample-review-positions.py` to draw ~1,500 decisions, stratified by time class,
  rating band, game phase, and eval-loss bucket, so boundary cases are not drowned by easy "Best" moves.
- New `scripts/sample-chesscom.py` pulls public monthly archives across rating bands, with rate
  limiting and a cached manifest. Keeps only PGN plus metadata (ratings, clocks, time control) and
  records SHA-256 of sources.

### Reference labeller
- Runs full Stockfish 19 at depth 22, 3 PV, clearing hash between positions, as in the current benchmark.
- Writes a cached, resumable `reference.jsonl`. Bad PGNs are skipped with a logged reason.
- Expected cost: ~1-2 s/position on the M3, so roughly an hour for 1,500 positions.

### Evaluator
- Extend `scripts/benchmark-review.mjs` to report exact-grade agreement and expected-score error with
  **bootstrap confidence intervals**, broken out by grade, phase, and source (Lichess vs Chess.com).
- The report labels a result "inconclusive" when the interval spans zero.

### Threshold fitting
- Grid-search grade boundaries to maximise agreement with the reference on the Lichess train split;
  select on a validation split; report on the Chess.com holdout.
- Output a data file (same style as `calibration-data.js`) so thresholds are fitted, not hardcoded.

### CI guard
- A fixed fixture of ~100 positions with committed reference labels runs under `npm test` and fails if
  agreement drops by more than an agreed margin.

## Part A: Rating-aware grading

- Engine-based grade stays the primary label. A conditioning layer on rating and clock adds a
  **"hard to find / expected at your level"** qualifier.
- Extend `practical-model.js` and `difficulty-model.js` rather than adding a parallel system. Fit a small
  logistic (or GBM-style) model for P(player of rating R with clock T finds a move losing <= X points).
  Coefficients ship as a data file, like `difficulty-data.js`.
- Great and Brilliant additionally require the move to be unlikely for that rating, which removes
  meaningless "Great" labels on obvious recaptures.
- Fallback: no rating or clock means the existing position-only model. Plain PGNs do not regress.
- Ship the layer only if held-out Brier score or log loss improves with an interval that excludes zero,
  on both the Lichess test split and the Chess.com holdout; otherwise it stays behind a flag.

## Rollout order

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
- The harness runs serially, single-worker; uniform instant failures are treated as harness failures
  before logic failures.

## Honesty guard

The README states every result with its interval. Claims that do not clear the interval check are
published as "inconclusive".
