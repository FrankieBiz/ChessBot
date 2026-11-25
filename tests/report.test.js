import assert from "node:assert/strict";
import { test } from "node:test";
import { browserInfo, problemReportUrl } from "../report.js";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0";
const EDGE = `${CHROME} Edg/142.0.0.0`;

test("the browser choice matches the bug form's options", () => {
  assert.deepEqual(browserInfo(CHROME), { name: "Chrome", version: "Chromium 142.0.0.0" });
  assert.deepEqual(browserInfo(FIREFOX), { name: "Firefox", version: "Firefox 146.0" });
  assert.equal(browserInfo(EDGE).name, "Other Chromium browser");
});

test("a report link fills the form with version, browser and error only", () => {
  const url = new URL(problemReportUrl({ version: "3.8.0", userAgent: CHROME, engines: 4, error: "Stockfish search timed out" }));
  assert.equal(url.origin + url.pathname, "https://github.com/FrankieBiz/ChessBot/issues/new");
  assert.equal(url.searchParams.get("template"), "bug_report.yml");
  assert.equal(url.searchParams.get("version"), "3.8.0");
  assert.equal(url.searchParams.get("browser"), "Chrome");
  assert.equal(url.searchParams.get("what-happened"), "The review stopped with this message: Stockfish search timed out");
  assert.equal(url.searchParams.get("console"), "ChessBot 3.8.0\nChromium 142.0.0.0\n4 Stockfish engines\nError: Stockfish search timed out");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["browser", "console", "labels", "template", "version", "what-happened"]);
});

test("a report without an error leaves the description to the player", () => {
  const url = new URL(problemReportUrl({ version: "3.8.0", userAgent: FIREFOX }));
  assert.equal(url.searchParams.get("what-happened"), null);
  assert.equal(url.searchParams.get("console"), "ChessBot 3.8.0\nFirefox 146.0");
});
