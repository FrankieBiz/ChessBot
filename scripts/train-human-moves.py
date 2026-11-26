"""Fit the move-level human choice model from rows written by scripts/collect-human-moves.mjs.

Train: a conditional-logit (softmax) model over every legal move, fitted to the move the human
actually played. Validation: chooses the L2 strength by move log-likelihood and fits the logistic
calibration that turns the predicted share of sound moves into a find rate. Test (and an optional
Chess.com sample): compares that find rate with the shipped cohort model on the same decisions and
the same target, the extension's depth-16 comparison of the played move.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy.optimize import minimize
from scipy.special import expit, logit

SOUND = 5.0
FEATURES = ["loss", "sqrtLoss", "best", "lossRating", "sqrtLossRating", "lossClock",
            "capture", "capturedValue", "recapture", "check", "queenPromotion", "underpromotion", "castle",
            "knight", "bishop", "rook", "queen", "king", "escapesAttack", "enPrise", "retreat", "distance",
            "pawnPush", "captureRating", "checkRating"]
RATING = [FEATURES.index(name) for name in ("lossRating", "sqrtLossRating", "captureRating", "checkRating")]
ENGINE_ONLY = [FEATURES.index(name) for name in ("loss", "sqrtLoss", "best")]


class Split:
    def __init__(self, path):
        self.path = path
        self.rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        if not self.rows:
            raise ValueError(f"{path} has no rows")
        sizes = np.array([len(row["moves"]) for row in self.rows])
        self.offsets = np.r_[0, np.cumsum(sizes)[:-1]]
        self.x = np.array([move["features"] for row in self.rows for move in row["moves"]], dtype=float)
        self.loss = np.array([move["loss"] for row in self.rows for move in row["moves"]], dtype=float)
        self.chosen = np.zeros(len(self.x))
        self.chosen[self.offsets + np.array([row["label"] for row in self.rows])] = 1.
        self.group = np.repeat(np.arange(len(self.rows)), sizes)
        self.deep = all("target" in row for row in self.rows)
        self.depth = {row.get("searchDepth", 12) for row in self.rows}
        if self.deep:
            self.sound = np.array([row["target"]["sound"] for row in self.rows], dtype=float)

    def design(self, columns, rated):
        x = self.x.copy()
        if not rated:
            x[:, RATING] = 0.
        mask = np.zeros(x.shape[1], dtype=bool)
        mask[columns] = True
        x[:, ~mask] = 0.
        return x


def group_softmax(split, x, weights):
    scores = x @ weights
    top = np.maximum.reduceat(scores, split.offsets)
    exp = np.exp(scores - top[split.group])
    total = np.add.reduceat(exp, split.offsets)
    return exp / total[split.group], scores - top[split.group] - np.log(total)[split.group]


def fit(split, x, l2):
    n = len(split.rows)
    def objective(weights):
        probability, log_probability = group_softmax(split, x, weights)
        value = -np.sum(log_probability * split.chosen) / n + l2 * weights @ weights
        return value, x.T @ (probability - split.chosen) / n + 2 * l2 * weights
    result = minimize(objective, np.zeros(x.shape[1]), jac=True, method="L-BFGS-B",
                      options={"maxiter": 5000, "gtol": 1e-9})
    if not result.success:
        raise RuntimeError(result.message)
    return result.x


def within(scores, label, k):
    """Chance that the label ranks in the top k when tied scores are ordered at random."""
    greater = int(np.sum(scores > scores[label]))
    tied = int(np.sum(scores == scores[label]))
    return max(0, min(tied, k - greater)) / tied


def move_metrics(split, x, weights):
    probability, log_probability = group_softmax(split, x, weights)
    chosen = split.chosen.astype(bool)
    top1 = top3 = 0.
    tempting_hits = tempting_cheapest = tempting_uniform = errors = 0
    for index, start in enumerate(split.offsets):
        end = split.offsets[index + 1] if index + 1 < len(split.offsets) else len(split.x)
        p, label = probability[start:end], split.rows[index]["label"]
        # Expected hit rates with ties broken at random, so identical feature rows earn no credit.
        top1 += within(p, label, 1)
        top3 += within(p, label, 3)
        unsound = np.flatnonzero(split.loss[start:end] > SOUND)
        if split.loss[start + label] > SOUND and len(unsound) > 1:
            # Which tempting mistake did the player choose, given that they erred?
            position = int(np.flatnonzero(unsound == label)[0])
            errors += 1
            tempting_hits += within(p[unsound], position, 1)
            tempting_cheapest += within(-split.loss[start:end][unsound], position, 1)
            tempting_uniform += 1. / len(unsound)
    n = len(split.rows)
    return {
        "decisions": n,
        "moveLogLoss": float(-np.mean(log_probability[chosen])),
        "top1": top1 / n, "top3": top3 / n,
        "temptingMistake": {"decisions": errors,
                            "modelTop": tempting_hits / errors if errors else None,
                            "smallestEngineLoss": tempting_cheapest / errors if errors else None,
                            "uniform": tempting_uniform / errors if errors else None},
    }


def raw_sound(split, x, weights):
    probability, _ = group_softmax(split, x, weights)
    share = np.add.reduceat(probability * (split.loss <= SOUND), split.offsets)
    return np.clip(share, 1e-4, 1 - 1e-4)


def fit_logistic(z, y):
    design = np.c_[np.ones(len(z)), z]
    def objective(coefficients):
        value = design @ coefficients
        return (np.mean(np.logaddexp(0., value) - y * value) + 1e-4 * coefficients[1:] @ coefficients[1:],
                design.T @ (expit(value) - y) / len(y) + np.r_[0., 2e-4 * coefficients[1:]])
    return minimize(objective, np.zeros(design.shape[1]), jac=True, method="L-BFGS-B").x


def score(y, predicted):
    p = np.clip(predicted, 1e-5, 1 - 1e-5)
    return {"brier": float(np.mean((p - y) ** 2)), "logLoss": float(-np.mean(y * np.log(p) + (1 - y) * np.log1p(-p)))}


def paired(y, better, worse):
    difference = (worse - y) ** 2 - (better - y) ** 2
    gain, margin = np.mean(difference), 1.96 * np.std(difference, ddof=1) / np.sqrt(len(y))
    return {"brierGain": float(gain), "approximate95PercentInterval": [float(gain - margin), float(gain + margin)]}


def find_rate_report(split, predictions, cohort_refit):
    """Brier scores on decisions the shipped cohort model covers, plus full-coverage scores."""
    shipped = [row["cohort"]["shipped"] for row in split.rows]
    covered = np.array([value is not None for value in shipped])
    y = split.sound
    report = {"decisions": len(y), "soundRate": float(np.mean(y)), "cohortCoverage": float(np.mean(covered))}
    yc = y[covered]
    shipped_chance = np.array([value["chance"] / 100 for value in shipped if value is not None])
    report["coveredByCohort"] = {"decisions": int(covered.sum()), "shippedCohort": score(yc, shipped_chance)}
    if cohort_refit is not None:
        report["coveredByCohort"]["refitCohort"] = score(yc, cohort_refit[covered])
    for name, prediction in predictions.items():
        report["coveredByCohort"][name] = score(yc, prediction[covered])
        report["coveredByCohort"][f"{name}VsShipped"] = paired(yc, prediction[covered], shipped_chance)
        if cohort_refit is not None:
            report["coveredByCohort"][f"{name}VsRefit"] = paired(yc, prediction[covered], cohort_refit[covered])
        if name != "engineOnly" and "engineOnly" in predictions:
            report["coveredByCohort"][f"{name}VsEngineOnly"] = paired(
                yc, prediction[covered], predictions["engineOnly"][covered])
        report[f"{name}AllDecisions"] = score(y, prediction)
    return report


def cohort_features(split, key):
    features = []
    for row in split.rows:
        entry = row["cohort"][key]
        features.append(entry["features"][:8] if entry else None)
    return features


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--train", type=Path, required=True)
    parser.add_argument("--validation", type=Path, required=True)
    parser.add_argument("--test", type=Path, required=True)
    parser.add_argument("--chesscom", type=Path)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    splits = {name: Split(path) for name, path in
              (("train", args.train), ("validation", args.validation), ("test", args.test),
               *((("chesscom", args.chesscom),) if args.chesscom else ()))}
    if not all(splits[name].deep for name in splits if name != "train"):
        parser.error("Validation and evaluation rows need --deep targets")
    depths = set().union(*(split.depth for split in splits.values()))
    if len(depths) != 1:
        parser.error(f"Rows mix all-moves search depths {sorted(depths)}")
    search_depth = depths.pop()

    every = list(range(len(FEATURES)))
    families = {"engineOnly": (ENGINE_ONLY, False), "unrated": (every, False), "rated": (every, True)}
    fitted, choice = {}, {}
    for family, (columns, rated) in families.items():
        best = None
        for l2 in (1e-5, 1e-4, 1e-3, 1e-2):
            weights = fit(splits["train"], splits["train"].design(columns, rated), l2)
            validation = move_metrics(splits["validation"], splits["validation"].design(columns, rated), weights)
            if best is None or validation["moveLogLoss"] < best[0]:
                best = (validation["moveLogLoss"], l2, weights)
        _, choice[family], fitted[family] = best

    moves = {name: {family: move_metrics(split, split.design(*families[family]), fitted[family])
                    for family in fitted if family != "rated" or name != "chesscom"}
             for name, split in splits.items()}

    calibration = {}
    validation = splits["validation"]
    for family in ("engineOnly", "unrated", "rated"):
        z = logit(raw_sound(validation, validation.design(*families[family]), fitted[family]))
        calibration[family] = fit_logistic(z, validation.sound)

    def calibrated(split, family):
        z = logit(raw_sound(split, split.design(*families[family]), fitted[family]))
        return expit(calibration[family][0] + calibration[family][1] * z)

    # A fair cohort baseline: the shipped position features refit on the same validation target.
    position = cohort_features(validation, "position")
    keep = np.array([value is not None for value in position])
    refit = fit_logistic(np.array([value[1:] for value in position if value is not None]), validation.sound[keep])

    def refit_prediction(split):
        values = cohort_features(split, "position")
        return np.array([expit(refit[0] + np.dot(refit[1:], value[1:])) if value is not None else np.nan
                         for value in values])

    find_rate = {}
    for name in ("validation", "test", "chesscom"):
        if name not in splits:
            continue
        split = splits[name]
        # engineOnly isolates the gain from scoring every move; the other two add the human features.
        predictions = {"engineOnly": calibrated(split, "engineOnly"), "moveLevelUnrated": calibrated(split, "unrated")}
        if name != "chesscom":
            predictions["moveLevelRated"] = calibrated(split, "rated")
        find_rate[name] = find_rate_report(split, predictions, refit_prediction(split))

    hashes = {name: hashlib.sha256(split.path.read_bytes()).hexdigest() for name, split in splits.items()}
    report = {
        "target": "Played move loses at most five points on the human-choice model's WDL-calibrated loss scale at depth 16",
        "searchDepth": search_depth, "features": FEATURES, "l2": choice, "samples": hashes,
        "moves": moves, "findRate": find_rate,
        "weights": {family: weights.tolist() for family, weights in fitted.items()},
        "calibration": {family: values.tolist() for family, values in calibration.items()},
    }
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"moves": moves, "findRate": find_rate}, indent=2))

    test = find_rate["test"]["coveredByCohort"]
    for family in ("moveLevelUnrated", "moveLevelRated"):
        if test[family]["brier"] >= test["shippedCohort"]["brier"]:
            raise SystemExit(f"{family} did not beat the shipped cohort model on the test month; model not written")
    data = {"searchDepth": search_depth, "features": FEATURES,
            **{family: {"weights": fitted[family].tolist(), "calibration": calibration[family].tolist()}
               for family in ("unrated", "rated")}}
    args.model.write_text("// Generated by scripts/train-human-moves.py.\n"
                          f"export const HUMAN_MOVE_MODEL = {json.dumps(data, indent=2)};\n")


if __name__ == "__main__":
    main()
