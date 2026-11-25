"""Fit and test same-pool expected sound decisions, with a separate Stockfish transfer check."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy.optimize import minimize
from scipy.special import expit

SPEEDS = ("bullet", "blitz", "rapid")
BANDS = ((800, 1399), (1400, 1799), (1800, 2199), (2200, 2600))
RATED_FEATURES = 13
POSITION_FEATURES = 8
MIN_FIT_BAND = 35
MIN_HOLDOUT_BAND = 100
MIN_TRANSFER_BAND = 50


def load_rows(path, rated):
    source = "rated" if rated else "position"
    width = RATED_FEATURES if rated else POSITION_FEATURES
    rows = []
    seen = set()
    with path.open() as stream:
        for line in stream:
            row = json.loads(line)
            data = row["cohort"].get(source)
            if not data or (rated and data["model"] != "lichessRating"):
                continue
            if len(data["features"]) < width or not isinstance(row["target"]["sound"], bool):
                raise ValueError(f"Invalid row in {path}")
            if row["id"] in seen:
                raise ValueError(f"Duplicate sampled game in {path}")
            seen.add(row["id"])
            rows.append((row["id"], row["timeClass"], row["rating"], row["target"]["sound"], *data["features"][:width]))
    return rows


def by_speed(rows, speed):
    return np.array([row[2:] for row in sorted(rows) if row[1] == speed])


def fit(rows):
    features, observed = rows[:, 2:], rows[:, 1]

    def objective(weights):
        regularized = np.r_[0., weights[1:]]
        logit = features @ weights
        loss = np.mean(np.logaddexp(0., logit) - observed * logit)
        gradient = features.T @ (expit(logit) - observed) / len(observed)
        return loss + .005 * (regularized @ regularized), gradient + .01 * regularized

    result = minimize(objective, np.zeros(features.shape[1]), method="L-BFGS-B", jac=True,
                      options={"ftol": 1e-13, "gtol": 1e-9})
    if not result.success:
        raise RuntimeError(result.message)
    return result.x


def band_mask(rows, band):
    low, high = band
    return (rows[:, 0] >= low) & (rows[:, 0] <= high)


def mean_interval(values):
    center = float(values.mean())
    margin = float(1.96 * values.std(ddof=1) / np.sqrt(len(values)))
    return [round(center - margin, 6), round(center + margin, 6)]


def score(rows, weights, baseline):
    actual = rows[:, 1]
    predicted = expit(rows[:, 2:] @ weights)
    error = predicted - actual
    baseline_error_sq = (baseline - actual) ** 2
    gain = baseline_error_sq - error ** 2
    bins = np.minimum(4, (predicted * 5).astype(int))
    ece = sum(abs(error[bins == index].sum()) for index in range(5)) / len(rows)
    return {
        "decisions": len(rows), "actualSoundRate": round(float(actual.mean()), 6),
        "meanPrediction": round(float(predicted.mean()), 6), "meanBias": round(float(error.mean()), 6),
        "bias95Interval": mean_interval(error), "calibrationError5Bins": round(float(ece), 6),
        "brier": round(float(np.mean(error ** 2)), 6), "baselineBrier": round(float(baseline_error_sq.mean()), 6),
        "brierGain": round(float(gain.mean()), 6), "gain95Interval": mean_interval(gain),
    }


def measure_bands(rows, weights, baseline, rated):
    by_band = {}
    for index, band in enumerate(BANDS):
        subset = rows[band_mask(rows, band)]
        if len(subset) >= 2:
            by_band[str(index)] = score(subset, weights, baseline[index if rated else 0])
    if rated:
        reference = np.full(len(rows), np.mean(baseline))
        for index, band in enumerate(BANDS):
            reference[band_mask(rows, band)] = baseline[index]
    else:
        reference = baseline[0]
    return {"all": score(rows, weights, reference), "byRatingBand": by_band}


def measure_selected(rows, weights, baseline, indices):
    selected = np.concatenate([rows[band_mask(rows, BANDS[index])] for index in indices])
    reference = np.concatenate([np.full(int(band_mask(rows, BANDS[index]).sum()), baseline[index]) for index in indices])
    return score(selected, weights, reference)


def evaluate(fit_rows, holdout, transfer, chesscom, speed):
    train = by_speed(fit_rows, speed)
    archived = by_speed(holdout, speed)
    actual = by_speed(transfer, speed)
    club = by_speed(chesscom, speed)
    weights = fit(train)
    baseline = [float(train[band_mask(train, band), 1].mean()) for band in BANDS]
    archived_stats = measure_bands(archived, weights, baseline, True)
    transfer_stats = measure_bands(actual, weights, baseline, True)
    # August screens the fit. October corroborates selected bands against the browser's adaptive results.
    selected = []
    for index, band in enumerate(BANDS):
        august = archived_stats["byRatingBand"].get(str(index), {})
        october = transfer_stats["byRatingBand"].get(str(index), {})
        if (band_mask(train, band).sum() >= MIN_FIT_BAND and august.get("decisions", 0) >= MIN_HOLDOUT_BAND
                and october.get("decisions", 0) >= MIN_TRANSFER_BAND and abs(august["meanBias"]) <= .05
                and abs(october["meanBias"]) <= .10 and august["brierGain"] > 0 and october["brierGain"] > 0):
            selected.append(index)

    corroboration = None
    if len(selected) >= 2:
        corroboration = {"archived": measure_selected(archived, weights, baseline, selected),
                        "transfer": measure_selected(actual, weights, baseline, selected)}
    supported = bool(corroboration and all(stats["gain95Interval"][0] > 0 and abs(stats["meanBias"]) <= .05
                                and max(map(abs, stats["bias95Interval"])) <= .10
                                and stats["calibrationError5Bins"] <= .10 for stats in corroboration.values()))

    unrated_weights = fit(train[:, :2 + POSITION_FEATURES])
    return {
        "fitDecisions": len(train), "fitBandCounts": [int(band_mask(train, band).sum()) for band in BANDS],
        "baselineRates": baseline, "archivedHoldout": archived_stats, "browserScoringTransfer": transfer_stats,
        "chessComCrossPoolTransfer": measure_bands(club, unrated_weights, [float(train[:, 1].mean())], False),
        "selectedBands": selected, "selectedBandScores": corroboration,
        "supported": supported,
    }, {"ratingBands": [BANDS[index] for index in selected], "weights": weights.tolist()} if supported else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for part in ("fit", "holdout", "transfer", "chesscom"):
        parser.add_argument(f"--{part}", type=Path, required=True)
    parser.add_argument("--model", type=Path)
    args = parser.parse_args()
    inputs = {part: getattr(args, part) for part in ("fit", "holdout", "transfer", "chesscom")}
    samples = {}
    datasets = {}
    games = set()
    for part, path in inputs.items():
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        rows = load_rows(path, part != "chesscom")
        ids = {row[0] for row in rows}
        if games & ids:
            raise ValueError(f"Cross-split game overlap in {path}")
        games.update(ids)
        datasets[part] = rows
        samples[part] = {"file": path.name, "sha256": digest, "decisions": len(rows)}

    results = {}
    models = {}
    for speed in SPEEDS:
        results[speed], model = evaluate(*datasets.values(), speed)
        if model:
            models[speed] = model
    print(json.dumps({"samples": samples, "ratingBands": BANDS, "byTimeClass": results}, indent=2, allow_nan=False))
    if args.model:
        args.model.write_text("// Generated by scripts/benchmark-performance.py.\n"
                              f"export const PEER_PERFORMANCE = {json.dumps(models, indent=2)};\n")


if __name__ == "__main__":
    main()
