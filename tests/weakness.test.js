import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { THEMES, gameDate, isLowClock, themeForTag, themeLabel, userResult } from "../weakness.js";

test("coach tags map to report rows, and unknown tags fall back to No single tactic", () => {
  assert.equal(themeForTag("Hanging Piece"), "hanging");
  assert.equal(themeForTag("Engine Capture"), "allowed-tactic");
  assert.equal(themeForTag("Missed Defense"), "allowed-mate");
  assert.equal(themeForTag("Missed Tactic"), "missed-material");
  assert.equal(themeForTag("Missed Mate"), "missed-mate");
  assert.equal(themeForTag("Missed Refutation"), "missed-refutation");
  assert.equal(themeForTag("Missed Check"), "missed-forcing");
  assert.equal(themeForTag("Promotion"), "missed-forcing");
  assert.equal(themeForTag("Critical Error"), "positional");
  assert.equal(themeForTag("Positional Slip"), "positional");
  assert.equal(themeForTag("Something New"), "positional");
  assert.equal(themeForTag(null), "positional");
  assert.equal(themeLabel("hanging"), "Left a piece hanging");
});

test("every coach tag for a Mistake, Miss, or Blunder has a report row", async () => {
  const source = await readFile(new URL("../coach.js", import.meta.url), "utf8");
  const tags = new Set();
  for (const [, expression] of source.matchAll(/\btag:\s*([^,\n]+)/g)) {
    // Strings at the start or after ? and : are results; strings after === are comparisons.
    for (const [, tag] of expression.matchAll(/(?:^|[?:]\s*)"([^"]+)"/g)) tags.add(tag);
  }
  const praiseTags = ["Checkmate", "Forced Move", "Tactical Sacrifice", "Critical Move", "Equally Strong",
    "King Safety", "Tactical Precision", "Top Engine Move", "Strong Move", "Solid Play"];
  const mapped = new Set(THEMES.flatMap((theme) => theme.tags));
  assert.deepEqual([...tags].filter((tag) => !praiseTags.includes(tag) && !mapped.has(tag)), []);
  for (const tag of mapped) assert.ok(tags.has(tag), `${tag} is not a tag in coach.js`);
});

test("a clock is low under 10% of the base time or 15 seconds, whichever is larger", () => {
  assert.equal(isLowClock(17.9, 180), true);
  assert.equal(isLowClock(18, 180), false);
  assert.equal(isLowClock(14.9, 60), true);
  assert.equal(isLowClock(15, 60), false);
  assert.equal(isLowClock(59, 600), true);
  assert.equal(isLowClock(null, 180), null);
  assert.equal(isLowClock(30, undefined), null);
});

test("results are scored from the user's side", () => {
  assert.equal(userResult("1-0", "w"), 1);
  assert.equal(userResult("1-0", "b"), 0);
  assert.equal(userResult("0-1", "b"), 1);
  assert.equal(userResult("1/2-1/2", "w"), 0.5);
  assert.equal(userResult("*", "w"), null);
  assert.equal(userResult(undefined, "b"), null);
});

test("a game's date comes from the Chess.com end time, then PGN headers, then the review date", () => {
  const endTime = Math.floor(new Date(2026, 10, 20, 12, 0).getTime() / 1000);
  assert.equal(gameDate({ endTime, headers: { Date: "2001.01.01" } }, "2026-11-24"), "2026-11-20");
  assert.equal(gameDate({ headers: { UTCDate: "2026.11.19", Date: "2026.11.18" } }, "2026-11-24"), "2026-11-19");
  assert.equal(gameDate({ headers: { Date: "2026.11.18" } }, "2026-11-24"), "2026-11-18");
  assert.equal(gameDate({ headers: { Date: "????.??.??" } }, "2026-11-24"), "2026-11-24");
  assert.equal(gameDate({}, "2026-11-24"), "2026-11-24");
});
