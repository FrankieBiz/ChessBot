"""Fit and benchmark symmetric expected-score curves on Lichess PGN archives."""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

import numpy as np
from scipy.optimize import minimize
from scipy.special import expit

RESULTS = {"0-1": 0, "1/2-1/2": 0.5, "1-0": 1}
HEADER = re.compile(r'^\[(\w+) "([^"]*)"\]$')
PLY = re.compile(r'([^{}\s]+)\s*\{([^{}]*)\}')
EVAL = re.compile(r'\[%eval (-?\d+(?:\.\d+)?)\]')
CLOCK = re.compile(r'\[%clk (\d+):(\d\d):(\d\d(?:\.\d+)?)\]')
SPEEDS = ("bullet", "blitz", "rapid")


def extract_position(headers, movetext):
    result = RESULTS.get(headers.get("Result"))
    if (
        result is None or "[%eval " not in movetext
        or headers.get("Termination") not in ("Normal", "Time forfeit")
        or "BOT" in (headers.get("WhiteTitle"), headers.get("BlackTitle"))
        or headers.get("Site", "") == ""
    ):
        return None

    event = headers.get("Event", "").lower().split()
    if len(event) != 3 or event[0] != "rated" or event[1] not in SPEEDS:
        return None
    time_control = re.fullmatch(r"(\d+)(?:\+(\d+))?", headers.get("TimeControl", ""))
    if not time_control:
        return None
    base, inc = int(time_control[1]), int(time_control[2] or 0)
    if not (60 <= base and 0 <= inc <= 30 and base + 40 * inc < 1500):
        return None

    # Official annotated dumps place a clock/eval comment after each SAN move.
    # Verify complete alignment and skip games without this format.
    comments = list(PLY.finditer(movetext))
    bare_moves = re.sub(r"\{[^{}]*\}|\d+\.{1,3}\s*|(?:1/2-1/2|0-1|1-0)\s*$", " ", movetext).split()
    if [entry[1] for entry in comments] != bare_moves:
        return None

    candidates = []
    for ply in range(8, min(121, len(comments))):
        white_comment, black_comment = (
            (comments[ply - 2][2], comments[ply - 1][2]) if ply % 2 == 0
            else (comments[ply - 1][2], comments[ply - 2][2])
        )
        cp = EVAL.search(comments[ply - 1][2])
        white_clock = CLOCK.search(white_comment)
        black_clock = CLOCK.search(black_comment)
        if cp and white_clock and black_clock:
            clocks = [sum(float(value) * scale for value, scale in zip(clock.groups(), (3600, 60, 1)))
                      for clock in (white_clock, black_clock)]
            candidates.append([float(cp[1]), ply, base, inc, *clocks, result, SPEEDS.index(event[1]), headers["Termination"] == "Time forfeit"])
    if not candidates:
        return None
    game_hash = hashlib.blake2s(headers["Site"].encode(), digest_size=8).digest()
    return candidates[int.from_bytes(game_hash, "big") % len(candidates)]


def read_sample(path):
    rows = []
    headers = {}
    text = []
    with subprocess.Popen(["zstd", "-dc", str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          encoding="utf-8", errors="replace") as process:
        for line in process.stdout:
            if line.startswith('[Event "'):
                row = extract_position(headers, " ".join(text))
                if row is not None:
                    rows.append(row)
                headers, text = {}, []
            line = line.strip()
            header = HEADER.fullmatch(line)
            if header:
                headers[header[1]] = header[2]
            elif line:
                text.append(line)
        # Ignore a possible partial final game in an HTTP range sample.
        errors = process.stderr.read()
        status = process.wait()
        if status and "premature end" not in errors.lower():
            raise RuntimeError(errors)
    if len(rows) < 1000:
        raise ValueError(f"{path} contains only {len(rows)} usable annotated games")
    return np.array(rows)


def inputs(rows, family):
    cp, ply, base, inc, white, black = rows[:, :6].T
    phase = (ply - 40.) / 40.
    white = np.clip(white, 0., 3600.) + inc + 5.
    black = np.clip(black, 0., 3600.) + inc + 5.
    speed = np.log2((base + 40. * inc) / 300.)
    pressure = np.clip(np.log2(np.minimum(white, black) / 60.), -3., 3.)
    clock_advantage = np.clip(np.log2(white / black), -3., 3.)
    slopes = {"scalar": [np.ones_like(phase)], "phase": [np.ones_like(phase), phase],
              "clock": [np.ones_like(phase), phase, speed, pressure]}
    offsets = {"scalar": [], "phase": [], "clock": [clock_advantage]}
    offset = np.array(offsets[family]).T if offsets[family] else np.empty((len(rows), 0))
    return np.clip(cp, -10., 10.), np.array(slopes[family]).T, offset


def fit(rows, family):
    cp, x, z = inputs(rows, family)
    actual = rows[:, 6]
    def objective(weights):
        log_slopes, offsets = np.split(weights, [x.shape[1]])
        signed = cp * np.exp(x @ log_slopes)
        logits = signed + z @ offsets
        residual = expit(logits) - actual
        loss = np.mean(np.logaddexp(0, logits) - actual * logits)
        gradient = np.r_[x.T @ (residual * signed), z.T @ residual] / len(actual)
        return loss, gradient

    bounds = [(-2.5, 1.)] + [(-0.6, 0.6)] * (x.shape[1] - 1) + [(0., 1.5)] * z.shape[1]
    start = np.zeros(len(bounds))
    start[0] = np.log(.368208)
    result = minimize(objective, start, method="L-BFGS-B", jac=True,
                      bounds=bounds,
                      options={"ftol": 1e-13, "gtol": 1e-9})
    if not result.success:
        raise RuntimeError(result.message)
    return result.x


def predict(rows, family, weights):
    cp, x, z = inputs(rows, family)
    log_slopes, offsets = np.split(weights, [x.shape[1]])
    return expit(cp * np.exp(x @ log_slopes) + z @ offsets)


def measure(prediction, rows, baseline):
    actual = rows[:, 6]
    delta = (baseline - actual)**2 - (prediction - actual)**2
    mean = np.mean(delta)
    margin = 1.96 * np.std(delta, ddof=1) / np.sqrt(len(delta))
    p = np.clip(prediction, 1e-12, 1 - 1e-12)
    groups = []
    for idx in range(10):
        group = (p >= idx / 10) & (p < (idx + 1) / 10)
        if np.any(group):
            groups.append(np.sum(group) * abs(np.mean(p[group] - actual[group])))
    return {
        "mse": float(np.mean((actual - p)**2)),
        "crossEntropy": float(np.mean(-actual * np.log(p) - (1 - actual) * np.log1p(-p))),
        "calibrationError10Bins": float(sum(groups) / len(actual)),
        "mseGainVsLichess": float(mean), "pairedApproxCI95": [float(mean - margin), float(mean + margin)],
    }


def benchmark(rows, weights):
    predictions = {"lichess": expit(.368208 * np.clip(rows[:, 0], -10., 10.))}
    predictions.update({name: predict(rows, name, values) for name, values in weights.items()})
    metrics = {name: measure(p, rows, predictions["lichess"]) for name, p in predictions.items()}
    by_speed = {}
    for index, speed in enumerate(SPEEDS):
        mask = rows[:, 7] == index
        if np.sum(mask) >= 100:
            by_speed[speed] = {"games": int(np.sum(mask)), **{
                name: measure(p[mask], rows[mask], predictions["lichess"][mask])["mse"]
                for name, p in predictions.items()
            }}
    by_termination = {}
    for flag, label in ((0, "normal"), (1, "timeForfeit")):
        mask = rows[:, 8] == flag
        if np.sum(mask) >= 100:
            by_termination[label] = {"games": int(np.sum(mask)), **{
                name: measure(p[mask], rows[mask], predictions["lichess"][mask])["mse"]
                for name, p in predictions.items()
            }}
    return {"games": len(rows), "metrics": metrics, "mseByTimeClass": by_speed,
            "mseByTermination": by_termination}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("train", "validation", "test"):
        parser.add_argument(f"--{name}", required=True, type=Path)
    parser.add_argument("--model", type=Path, help="Write verified JavaScript coefficients")
    args = parser.parse_args()
    inputs_by_split = {name: getattr(args, name) for name in ("train", "validation", "test")}
    unique_files = {path.resolve() for path in inputs_by_split.values()}
    if len(unique_files) != 3:
        parser.error("Provide three distinct monthly archives")
    digests = {}
    for name, path in inputs_by_split.items():
        with path.open("rb") as disk_file:
            digests[name] = hashlib.file_digest(disk_file, "sha256").hexdigest()
    if len(set(digests.values())) != 3:
        parser.error("Training, validation, and test samples must be distinct")
    parts = {name: read_sample(path) for name, path in inputs_by_split.items()}
    weights = {name: fit(parts["train"], name) for name in ("scalar", "phase", "clock")}
    validation = benchmark(parts["validation"], weights)
    # Use the simplest fallback within 0.00025 MSE of the best validation result.
    families = ("lichess", "scalar", "phase")
    min_mse = min(validation["metrics"][name]["mse"] for name in families)
    fallback = next(name for name in families if validation["metrics"][name]["mse"] <= min_mse + .00025)
    test = benchmark(parts["test"], weights)
    result = {
        "samples": {name: {"file": path.name, "bytes": path.stat().st_size,
                           "sha256": digests[name], "games": len(parts[name])}
                    for name, path in inputs_by_split.items()},
        "coefficients": {name: values.tolist() for name, values in weights.items()},
        "selectedFallback": fallback,
        "validation": validation,
        "test": test,
    }
    print(json.dumps(result, indent=2, allow_nan=False))
    if args.model:
        for split in (validation, test):
            metric = split["metrics"]
            if (metric["clock"]["mse"] >= metric[fallback]["mse"]
                or any(metric[name]["pairedApproxCI95"][0] <= 0 for name in ("clock", fallback))
                or any(group["clock"] >= group["lichess"] for group in split["mseByTimeClass"].values())):
                raise SystemExit("Calibration did not pass the publication checks")
        model = {"clock": result["coefficients"]["clock"], "fallback": result["coefficients"][fallback]}
        args.model.write_text("// Generated by scripts/calibrate.py from the documented monthly samples.\n"
                              f"export const CALIBRATION = {json.dumps(model, indent=2)};\n")


if __name__ == "__main__":
    main()
