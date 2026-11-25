"""Test how well archived move quality predicts one player's Lichess rating."""
import argparse
import hashlib
import json
import math
import re
import subprocess
from pathlib import Path

import numpy as np

from calibrate import HEADER, PLY, RESULTS, SPEEDS

EVAL = re.compile(r"\[%eval (#-?\d+|-?\d+(?:\.\d+)?)\]")
STAGES = {"early": (0, 10), "middle": (10, 25), "late": (25, None)}
QUALITY = ("accuracy", "logObserved", "rmsLoss", "largeLossRate", *STAGES, "hasMiddle", "hasLate")
COLUMNS = {name: index for index, name in enumerate(("rating", "opposingRating", "result", "moves", *QUALITY))}
MODELS = {
    "cohort": (),
    "accuracy": ("accuracy",),
    "quality": QUALITY,
    "opponent": ("opposingRating",),
    "opponentResult": ("opposingRating", "result"),
    "opponentResultQuality": ("opposingRating", "result", *QUALITY),
}


def digest(value):
    return int.from_bytes(hashlib.blake2s(value.encode(), digest_size=8).digest(), "big")


def win_percent(comment):
    match = EVAL.search(comment)
    if not match:
        return np.nan
    value = match[1]
    if value.startswith("#"):
        return 0.0 if value.startswith("#-") else 100.0
    pawns = min(10, max(-10, float(value)))
    return 100 / (1 + math.exp(-0.368208 * pawns))


def extract_game(headers, movetext, buckets):
    event = headers.get("Event", "").lower().split()
    result = RESULTS.get(headers.get("Result"))
    site = headers.get("Site", "")
    if (len(event) != 3 or event[0] != "rated" or event[1] not in SPEEDS or result is None
            or not site.startswith("https://lichess.org/") or "[%eval " not in movetext
            or headers.get("Termination") not in ("Normal", "Time forfeit")
            or "BOT" in (headers.get("WhiteTitle"), headers.get("BlackTitle"))):
        return None

    game_hash = digest(site)
    black = game_hash % 2
    player, opponent = ("Black", "White") if black else ("White", "Black")
    username = headers.get(player, "").lower()
    if not username or digest(username) % 10 not in buckets:
        return None
    try:
        rating, opposing_rating = (int(headers[color + "Elo"]) for color in (player, opponent))
    except (KeyError, ValueError):
        return None
    if not all(800 <= value <= 2600 for value in (rating, opposing_rating)):
        return None

    comments = list(PLY.finditer(movetext))
    moves = re.sub(r"\{[^{}]*\}|\d+\.{1,3}\s*|(?:1/2-1/2|0-1|1-0)\s*$", " ", movetext).split()
    if [entry[1] for entry in comments] != moves:
        return None
    scores = np.array([win_percent(entry[2]) for entry in comments])
    # Each loss uses two adjacent, annotated positions and the mover's perspective.
    losses = np.maximum(0, np.diff(scores, prepend=np.nan)[black::2] * (1 if black else -1))
    observed = losses[np.isfinite(losses)]
    if len(observed) < 8 or len(observed) < 0.8 * len(losses):
        return None

    accuracy = np.clip(103.1668100711649 * np.exp(-0.04354415386753951 * observed)
                       - 3.166924740191411 + 1, 0, 100).mean()
    stages = []
    for start, end in STAGES.values():
        stage = losses[start:end]
        stage = stage[np.isfinite(stage)]
        stages.append(float(stage.mean()) if len(stage) >= 5 else np.nan)
    features = [rating, opposing_rating, 1 - result if black else result, len(losses),
                accuracy, np.log1p(len(observed)), np.sqrt(np.mean(observed ** 2)),
                np.mean(observed > 10), *(value if np.isfinite(value) else 0 for value in stages),
                float(np.isfinite(stages[1])), float(np.isfinite(stages[2]))]
    return SPEEDS.index(event[1]), username, game_hash, features


def read_sample(path, buckets):
    chosen = {}
    headers, text = {}, []
    with subprocess.Popen(["zstd", "-dc", str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          encoding="utf-8", errors="replace") as process:
        for line in process.stdout:
            if line.startswith('[Event "'):
                game = extract_game(headers, " ".join(text), buckets)
                if game:
                    speed, player, game_hash, features = game
                    saved = chosen.get(player)
                    if saved is None or game_hash < saved[0]:
                        chosen[player] = game_hash, speed, features
                headers, text = {}, []
            line = line.strip()
            header = HEADER.fullmatch(line)
            if header:
                headers[header[1]] = header[2]
            elif line:
                text.append(line)
        # A byte prefix can end mid-record.
        errors = process.stderr.read()
        if process.wait() and "premature end" not in errors.lower():
            raise RuntimeError(errors)
    return {name: np.array([row for _, speed, row in chosen.values() if speed == index])
            for index, name in enumerate(SPEEDS)}


def model_predictions(features, train, *query_sets):
    ratings = train[:, COLUMNS["rating"]]
    if not features:
        return [np.full(len(rows), np.median(ratings)) for rows in query_sets]
    columns = [COLUMNS[name] for name in features]
    inputs = train[:, columns]
    center = inputs.mean(axis=0)
    scale = inputs.std(axis=0)
    scale[scale == 0] = 1

    def design(rows):
        standardized = (rows[:, columns] - center) / scale
        return np.column_stack([np.ones(len(rows)), standardized])

    x = design(train)
    penalty = np.diag([0, *([0.01 * len(train)] * len(columns))])
    weights = np.linalg.solve(x.T @ x + penalty, x.T @ ratings)
    return [design(rows) @ weights for rows in query_sets]


def conformal_radius(errors):
    rank = int(np.ceil(0.9 * (len(errors) + 1)))
    return float(np.sort(np.abs(errors))[rank - 1])


def measures(errors, radius):
    return {"mae": round(float(np.abs(errors).mean()), 1),
            "medianAbsoluteError": round(float(np.median(np.abs(errors))), 1),
            "bias": round(float(errors.mean()), 1),
            "interval90HalfWidth": round(radius, 1),
            "coverage": round(float(np.mean(np.abs(errors) <= radius)), 4)}


def paired_mae_change(baseline_errors, model_errors):
    differences = np.abs(model_errors) - np.abs(baseline_errors)
    rng = np.random.default_rng(20261124)
    means = [differences[rng.integers(len(differences), size=len(differences))].mean() for _ in range(2000)]
    return {"maeChange": round(float(differences.mean()), 2),
            "bootstrap95Interval": np.quantile(means, [0.025, 0.975]).round(2).tolist()}


def benchmark(train, validation, test):
    if min(len(train), len(validation), len(test)) < 50:
        raise ValueError("Each time class needs at least 50 distinct players in every split")
    errors = {}
    radii = {}
    metrics = {}
    for model, features in MODELS.items():
        predicted_validation, predicted_test = model_predictions(features, train, validation, test)
        validation_errors = predicted_validation - validation[:, COLUMNS["rating"]]
        errors[model] = predicted_test - test[:, COLUMNS["rating"]]
        radii[model] = conformal_radius(validation_errors)
        metrics[model] = measures(errors[model], radii[model])

    moves = test[:, COLUMNS["moves"]]
    lengths = {"8–19": moves < 20, "20–34": (moves >= 20) & (moves < 35), "35+": moves >= 35}
    by_length = {name: {"games": int(mask.sum()), **{
        model: measures(error[mask], radii[model]) for model, error in errors.items()
    }} for name, mask in lengths.items() if mask.sum() >= 30}

    # Hold game length constant so stage comparisons use the same population.
    stage_train, stage_test = [rows[rows[:, COLUMNS["moves"]] >= 35] for rows in (train, test)]
    stages = None
    if min(len(stage_train), len(stage_test)) >= 30:
        stages = {"games": len(stage_test), "mae": {}}
        for name, features in {"cohort": (), **{name: (name,) for name in STAGES}}.items():
            predicted, = model_predictions(features, stage_train, stage_test)
            residuals = predicted - stage_test[:, COLUMNS["rating"]]
            stages["mae"][name] = round(float(np.abs(residuals).mean()), 1)

    incremental_quality = paired_mae_change(errors["opponentResult"], errors["opponentResultQuality"])
    return {"players": dict(zip(("train", "validation", "test"), map(len, (train, validation, test)))),
            "holdout": metrics, "holdoutByGameLengthPerSide": by_length, "lossByMoveStage": stages,
            "incrementalQualityVsOpponentResult": incremental_quality}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("train", "validation", "test"):
        parser.add_argument(f"--{name}", required=True, type=Path)
    args = parser.parse_args()
    samples = {}
    sets = []
    for name, buckets in (("train", range(5)), ("validation", range(5, 7)), ("test", range(7, 10))):
        path = getattr(args, name)
        with path.open("rb") as stream:
            sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
        if any(sample["sha256"] == sha256 for sample in samples.values()):
            parser.error("Use different monthly archives for train, validation, and test")
        samples[name] = {"file": path.name, "bytes": path.stat().st_size, "sha256": sha256}
        sets.append(read_sample(path, buckets))
    report = {"samples": samples, "byTimeClass": {
        speed: benchmark(*(sample[speed] for sample in sets)) for speed in SPEEDS
    }}
    print(json.dumps(report, indent=2, allow_nan=False, ensure_ascii=False))


if __name__ == "__main__":
    main()
