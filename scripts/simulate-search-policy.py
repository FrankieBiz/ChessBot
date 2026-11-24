"""Compare broad-pass rules offline from one benchmark run that always runs the broad pass.

Run scripts/benchmark-review.mjs with --policy always first. Every decision then records the grade
and loss after each pass (depth, depth + 2, depth + 4) and the nodes each pass used. Skipping the
third pass does not change the first two, so any rule that decides from the first two passes can be
replayed exactly. The first --dev decisions (in benchmark order) were used to choose the rule; the
rest are a holdout.
"""
import argparse
import json
import math
from pathlib import Path
from statistics import mean

SEVERE = {"mistake", "miss", "blunder"}
PRAISE = {"great", "brilliant"}
AGREEMENT = 2.5
SEVERITY_LIMITS = (10, 20)


def agrees(a, b):
    return a["key"] == b["key"] and abs(a["winLoss"] - b["winLoss"]) <= AGREEMENT


def grade_change(a, b):
    if a["key"] != b["key"]:
        return True
    return (a["key"] in PRAISE or b["key"] in PRAISE) and not agrees(a, b)


def grade_at_risk(a, b):
    if grade_change(a, b):
        return True
    if a["key"] in PRAISE or b["key"] in PRAISE:
        return False
    shift = b["winLoss"] - a["winLoss"]
    if abs(shift) <= AGREEMENT:
        return False
    low, high = sorted((b["winLoss"], b["winLoss"] + shift))
    return any(low <= limit <= high for limit in SEVERITY_LIMITS)


RULES = {
    "never": lambda a, b: False,
    "unstable (v3.3)": lambda a, b: not agrees(a, b),
    "grade-change": grade_change,
    "grade-at-risk (v3.4)": grade_at_risk,
    "always": lambda a, b: True,
}


def pass_nodes(row):
    nodes = {}
    for search in row["searches"]:
        depth = int(search["command"].split()[2])
        nodes[depth] = nodes.get(depth, 0) + search["nodes"]
    return [nodes[depth] for depth in sorted(nodes)]


def replay(row, rule):
    passes, nodes = row["passes"], pass_nodes(row)
    if len(passes) == 1:
        return passes[0], sum(nodes), False
    third = len(passes) == 3 and rule(passes[0], passes[1])
    previous, last = (passes[1], passes[2]) if third else (passes[0], passes[1])
    key = last["key"]
    if key in PRAISE and not agrees(previous, last):
        key = "best"  # Unconfirmed praise is reported as Best.
    return {"key": key, "winLoss": last["winLoss"]}, sum(nodes[:3 if third else 2]), third


def summarize(rows, reference, rule):
    results = []
    for row in rows:
        final, nodes, third = replay(row, rule)
        target = reference[row["id"]]
        results.append((final["key"] == target["grade"],
                        (final["key"] in SEVERE) == (target["grade"] in SEVERE),
                        abs(final["winLoss"] - target["winLoss"]), nodes, third))
    nodes = sorted(result[3] for result in results)
    return {
        "decisions": len(results),
        "exactGradeMatches": sum(result[0] for result in results),
        "severeGradeMatches": sum(result[1] for result in results),
        "meanAbsoluteWinLossError": mean(result[2] for result in results),
        "meanNodes": mean(nodes),
        "p90Nodes": nodes[math.ceil(.9 * len(nodes)) - 1],
        "broadPasses": sum(result[4] for result in results),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True, help="benchmark-review.mjs output from --policy always")
    parser.add_argument("--dev", type=int, default=72)
    args = parser.parse_args()
    report = json.loads(args.report.read_text())
    load = lambda path: {row["id"]: row for row in map(json.loads, Path(path).read_text().splitlines()) if row}
    reference = load(report["reference"]["cache"])
    candidate = load(report["candidate"]["cache"])
    ids = sorted(reference)
    rows = [candidate[key] for key in ids]
    if any(row["passes"] is None for row in rows):
        raise SystemExit("The candidate run did not record passes")
    mismatched = [row["id"] for row in rows if replay(row, RULES["always"])[0]["key"] != row["grade"]]
    if mismatched:
        raise SystemExit(f"Replay disagrees with the recorded run on {len(mismatched)} decisions")
    print(json.dumps({
        "method": __doc__.strip().split("\n\n")[1].replace("\n", " "),
        "engine": report["engine"], "input": report["input"], "referenceDepth": report["reference"]["targetDepth"],
        "reviewDepth": report["candidate"]["targetDepth"],
        "splits": {name: {rule: summarize(subset, reference, check) for rule, check in RULES.items()}
                   for name, subset in (("development", rows[:args.dev]), ("holdout", rows[args.dev:]), ("all", rows))},
    }, indent=2))


if __name__ == "__main__":
    main()
