"""Train an offline model of how often humans make a sound move."""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

import chess
import numpy as np
from scipy.optimize import minimize
from scipy.special import expit

from calibrate import CLOCK, EVAL, HEADER, PLY

BASE = slice(0, 8)
CLOCKED = slice(0, 11)
RATED = slice(0, 13)
FEATURES = ("intercept", "mover_cp", "abs_mover_cp", "ply", "legal_moves",
            "capture_density", "in_check", "non_pawn_material",
            "own_clock", "clock_advantage", "time_control", "mover_rating", "opponent_rating")
MATERIAL = {chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9}


def to_seconds(clock):
    return sum(float(part) * multiplier for part, multiplier in zip(clock.groups(), (3600, 60, 1)))


def sample_game(headers, text):
    site = headers.get("Site", "")
    event = headers.get("Event", "").split()
    if (not site or len(event) != 3 or event[0] != "Rated" or event[1] not in ("Bullet", "Blitz", "Rapid")
        or headers.get("Termination") not in ("Normal", "Time forfeit")
        or "BOT" in (headers.get("WhiteTitle"), headers.get("BlackTitle"))):
        return None
    digest = hashlib.blake2s(site.encode(), digest_size=8).digest()
    if digest[0] % 2:
        return None

    control = re.fullmatch(r"(\d+)(?:\+(\d+))?", headers.get("TimeControl", ""))
    if not control:
        return None
    base, inc = int(control[1]), int(control[2] or 0)
    if not (60 <= base and 0 <= inc <= 30 and base + 40 * inc < 1500):
        return None

    result = " ".join(text)
    if "[%eval " not in result:
        return None
    result = re.sub(r"}\s*{", " ", result)
    entries = list(PLY.finditer(result))
    bare_moves = re.sub(r"\{[^{}]*\}|\d+\.{1,3}\s*|(?:1/2-1/2|0-1|1-0)\s*$", " ", result).split()
    if [entry[1] for entry in entries] != bare_moves:
        return None
    candidates = []
    for ply in range(8, min(121, len(entries) - 1)):
        before, after = EVAL.search(entries[ply - 1][2]), EVAL.search(entries[ply][2])
        own_clock, opp_clock = CLOCK.search(entries[ply - 2][2]), CLOCK.search(entries[ply - 1][2])
        if before and after and own_clock and opp_clock:
            candidates.append((ply, float(before[1]), float(after[1]), to_seconds(own_clock), to_seconds(opp_clock)))
    if not candidates:
        return None
    ply, before, after, own_clock, opp_clock = candidates[int.from_bytes(digest[1:], "big") % len(candidates)]

    board = chess.Board()
    try:
        for san in bare_moves[:ply]:
            board.push_san(san.rstrip("!?"))
    except ValueError:
        return None
    legal = list(board.legal_moves)
    if len(legal) < 2:
        return None
    sign = 1 if board.turn == chess.WHITE else -1
    color, opponent = ("White", "Black") if sign == 1 else ("Black", "White")
    try:
        own_elo, opp_elo = int(headers[color + "Elo"]), int(headers[opponent + "Elo"])
    except (ValueError, KeyError):
        return None
    if not (800 <= own_elo <= 2600 and 800 <= opp_elo <= 2600):
        return None
    captures = sum(board.is_capture(move) for move in legal)
    material = sum(len(board.pieces(piece, color)) * value
                   for piece, value in MATERIAL.items() for color in chess.COLORS)
    own_clock = np.clip(own_clock, 0., 3600.) + inc + 5.
    opp_clock = np.clip(opp_clock, 0., 3600.) + inc + 5.
    features = [
        1., sign * np.clip(before, -10., 10.) / 5., abs(np.clip(before, -10., 10.)) / 5.,
        (ply - 40.) / 40., np.log2(len(legal)) / 5., captures / len(legal), float(board.is_check()),
        material / 62., np.clip(np.log2(own_clock / 60.), -3., 3.),
        np.clip(np.log2(own_clock / opp_clock), -3., 3.), np.log2((base + 40. * inc) / 300.),
        (own_elo - 1500.) / 600., (opp_elo - 1500.) / 600.,
    ]
    swing = sign * (expit(.368208 * np.clip(before, -10., 10.)) - expit(.368208 * np.clip(after, -10., 10.)))
    return features + [int(swing <= 0.05)]


def load_rows(path):
    rows = []
    headers, contents = {}, []
    with subprocess.Popen(["zstd", "-dc", str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          encoding="utf-8", errors="replace") as process:
        for line in process.stdout:
            if line.startswith('[Event "'):
                row = sample_game(headers, contents)
                if row is not None:
                    rows.append(row)
                headers, contents = {}, []
            line = line.strip()
            header = HEADER.fullmatch(line)
            if header:
                headers[header[1]] = header[2]
            elif line:
                contents.append(line)
        errors = process.stderr.read()
        if process.wait() and "premature end" not in errors.lower():
            raise RuntimeError(errors)
    if len(rows) < 1000:
        raise ValueError(f"{path} has too few usable labeled decisions ({len(rows)})")
    return np.asarray(rows)


def fit(rows, features):
    x, y = rows[:, features], rows[:, -1]
    def objective(coefficients):
        regularized = np.r_[0., coefficients[1:]]
        logit = x @ coefficients
        bce = np.mean(np.logaddexp(0., logit) - y * logit)
        return (bce + .001 * (regularized @ regularized),
                x.T @ (expit(logit) - y) / len(y) + .002 * regularized)
    result = minimize(objective, np.zeros(x.shape[1]), method="L-BFGS-B", jac=True,
                      options={"ftol": 1e-13, "gtol": 1e-9})
    if not result.success:
        raise RuntimeError(result.message)
    return result.x


def score(y, predicted):
    brier = np.mean((predicted - y)**2)
    p = np.clip(predicted, .00001, .99999)
    return {"brier": float(brier), "logLoss": float(-np.mean(y * np.log(p) + (1. - y) * np.log1p(-p)))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for split in ("train", "validation", "test"):
        parser.add_argument(f"--{split}", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    args = parser.parse_args()
    paths = {split: getattr(args, split) for split in ("train", "validation", "test")}
    hashes = {}
    for split, path in paths.items():
        with path.open("rb") as stream:
            hashes[split] = hashlib.file_digest(stream, "sha256").hexdigest()
    if len(set(hashes.values())) != 3:
        parser.error("Expected three distinct monthly samples")
    parts = {name: load_rows(path) for name, path in paths.items()}
    models = {"evalOnly": slice(0, 4), "position": BASE, "clock": CLOCKED, "lichessRating": RATED}
    coefficients = {name: fit(parts["train"], features) for name, features in models.items()}
    rate = float(np.mean(parts["train"][:, -1]))
    scores = {}
    for name in ("validation", "test"):
        rows = parts[name]
        y = rows[:, -1]
        scores[name] = {"constant": score(y, np.full(len(y), rate)), **{
            family: score(y, expit(rows[:, models[family]] @ weights))
            for family, weights in coefficients.items()
        }}
    validation = scores["validation"]
    position_model = "position" if validation["position"]["brier"] < validation["evalOnly"]["brier"] else "evalOnly"
    selected = [position_model]
    for family in ("clock", "lichessRating"):
        if validation[family]["brier"] < validation[selected[-1]]["brier"]:
            selected.append(family)

    y = parts["test"][:, -1]
    strata = {}
    for name, mask in (("balanced", parts["test"][:, 2] <= .2), ("lopsided", parts["test"][:, 2] >= .6)):
        rows = parts["test"][mask]
        strata[name] = {"decisions": len(rows), "rate": float(np.mean(y[mask])), **{
            family: score(y[mask], expit(rows[:, models[family]] @ coefficients[family]))
            for family in selected
        }}

    test_rows = parts["test"]
    eval_only = expit(test_rows[:, models["evalOnly"]] @ coefficients["evalOnly"])
    paired_gains = {}
    for family in selected:
        prediction = expit(test_rows[:, models[family]] @ coefficients[family])
        differences = (eval_only - y) ** 2 - (prediction - y) ** 2
        gain = np.mean(differences)
        margin = 1.96 * np.std(differences, ddof=1) / np.sqrt(len(y))
        paired_gains[family] = {"gain": float(gain), "approximate95PercentInterval":
                               [float(gain - margin), float(gain + margin)]}

    print(json.dumps({
        "samples": {name: {"file": path.name, "sha256": hashes[name], "decisions": len(parts[name])}
                    for name, path in paths.items()},
        "target": "Observed move loses at most five points on the Lichess centipawn curve",
        "features": FEATURES, "trainingSoundMoveRate": rate, "selectedOnValidation": selected,
        **scores, "testByPosition": strata, "testPairedBrierGainVsEvalOnly": paired_gains,
    }, indent=2))
    if scores["test"][position_model]["brier"] >= scores["test"]["constant"]["brier"]:
        raise SystemExit("Difficulty model failed its holdout publication check")
    data = {"position": coefficients[position_model].tolist(), **{
        family: coefficients[family].tolist() for family in selected if family != position_model
    }}
    args.model.write_text("// Generated by scripts/train-difficulty.py.\n"
                          f"export const DIFFICULTY_COEFFICIENTS = {json.dumps(data, indent=2)};\n")


if __name__ == "__main__":
    main()
