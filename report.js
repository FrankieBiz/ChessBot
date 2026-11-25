// A GitHub bug-report link with the version, browser and error filled in. It sends nothing itself:
// the player sees the form on GitHub and decides whether to submit it. No game data is included.
const NEW_ISSUE = "https://github.com/FrankieBiz/ChessBot/issues/new";

/** The bug form's browser choice and a short version string from a user agent. */
export function browserInfo(userAgent = "") {
  const firefox = userAgent.match(/Firefox\/([\d.]+)/);
  if (firefox) return { name: "Firefox", version: `Firefox ${firefox[1]}` };
  const chrome = userAgent.match(/Chrome\/([\d.]+)/);
  const branded = /Edg\/|OPR\/|Brave|Vivaldi/.test(userAgent);
  if (chrome) return { name: branded ? "Other Chromium browser" : "Chrome", version: `Chromium ${chrome[1]}` };
  return { name: "Other Chromium browser", version: "unknown browser" };
}

export function problemReportUrl({ version = "unknown", userAgent = "", engines = null, error = "" } = {}) {
  const browser = browserInfo(userAgent);
  const params = new URLSearchParams({ template: "bug_report.yml", labels: "bug", version, browser: browser.name });
  if (error) params.set("what-happened", `The review stopped with this message: ${error}`);
  const details = [`ChessBot ${version}`, browser.version, engines ? `${engines} Stockfish ${engines === 1 ? "engine" : "engines"}` : null,
    error ? `Error: ${error}` : null].filter(Boolean);
  params.set("console", details.join("\n"));
  return `${NEW_ISSUE}?${params}`;
}
