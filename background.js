/**
 * ChessBot — Chrome MV3 Service Worker (background.js)
 *
 * Queries Chess.com's official PubAPI across candidate player usernames with
 * automatic retry/backoff, month-boundary & archive fallback, stores the game
 * in chrome.storage.local, and opens review.html in a new extension tab.
 */
"use strict";

const MAX_RETRIES = 6;
const RETRY_DELAYS_MS = [0, 1500, 2500, 3500, 4500, 5000];

const RESERVED_USERNAMES = new Set([
  "profile",
  "settings",
  "friends",
  "clubs",
  "home",
  "play",
  "messages",
  "login",
  "register",
  "upgrade",
  "membership",
  "notifications",
  "puzzles",
  "learn",
  "watch",
  "news",
  "social",
  "more",
  "stats",
  "games",
  "archive",
  "member",
  "members",
  "undefined",
  "null",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isValidUsername(name) {
  if (!name || typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!/^[a-zA-Z0-9_-]{3,30}$/.test(trimmed)) return false;
  return !RESERVED_USERNAMES.has(trimmed.toLowerCase());
}

function getRecentYearMonths() {
  const now = new Date();
  const curYear = now.getUTCFullYear();
  const curMonth = now.getUTCMonth() + 1;

  const prevDate = new Date(Date.UTC(curYear, curMonth - 2, 1));
  const prevYear = prevDate.getUTCFullYear();
  const prevMonth = prevDate.getUTCMonth() + 1;

  return [
    { year: curYear, month: pad2(curMonth) },
    { year: prevYear, month: pad2(prevMonth) },
  ];
}

async function fetchMonthlyGames(username, year, month) {
  const cleanUser = encodeURIComponent(username.trim().toLowerCase());
  const url = `https://api.chess.com/pub/player/${cleanUser}/games/${year}/${month}`;

  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (res.status === 404) {
    return { status: 404, games: [] };
  }
  if (!res.ok) {
    throw new Error(`Chess.com PubAPI returned HTTP ${res.status}`);
  }

  const data = await res.json();
  return { status: res.status, games: Array.isArray(data.games) ? data.games : [] };
}

async function fetchPlayerArchives(username) {
  const cleanUser = encodeURIComponent(username.trim().toLowerCase());
  const url = `https://api.chess.com/pub/player/${cleanUser}/games/archives`;

  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.archives) ? data.archives : [];
}

function findGameById(games, gameId) {
  const suffix = `/${gameId}`;
  return (
    games.find((g) => {
      if (!g || !g.url) return false;
      const cleanUrl = g.url.split("?")[0].replace(/\/+$/, "");
      return cleanUrl.endsWith(suffix);
    }) || null
  );
}

async function fetchGameWithRetry(candidateUsernames, gameId) {
  const users = candidateUsernames.filter(isValidUsername);
  if (users.length === 0) {
    throw new Error("Could not detect a valid Chess.com username on this page.");
  }

  const recentMonths = getRecentYearMonths();
  let lastError = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const delay = RETRY_DELAYS_MS[attempt] || 3000;
    if (delay > 0) {
      await sleep(delay);
    }

    for (const user of users) {
      try {
        const cur = recentMonths[0];
        const curRes = await fetchMonthlyGames(user, cur.year, cur.month);
        const matchCur = findGameById(curRes.games, gameId);
        if (matchCur && matchCur.pgn) {
          return { game: matchCur, matchedUser: user };
        }

        if (attempt === 0) {
          const prev = recentMonths[1];
          const prevRes = await fetchMonthlyGames(user, prev.year, prev.month);
          const matchPrev = findGameById(prevRes.games, gameId);
          if (matchPrev && matchPrev.pgn) {
            return { game: matchPrev, matchedUser: user };
          }
        }
      } catch (err) {
        lastError = err;
      }
    }
  }

  try {
    const primaryUser = users[0];
    const archives = await fetchPlayerArchives(primaryUser);
    const checked = new Set(recentMonths.map((m) => `${m.year}/${m.month}`));
    const olderArchives = archives
      .slice()
      .reverse()
      .filter((u) => {
        const m = u.match(/\/(\d{4})\/(\d{2})$/);
        return m && !checked.has(`${m[1]}/${m[2]}`);
      })
      .slice(0, 6);

    for (const archiveUrl of olderArchives) {
      const m = archiveUrl.match(/\/(\d{4})\/(\d{2})$/);
      if (!m) continue;
      const res = await fetchMonthlyGames(primaryUser, m[1], m[2]);
      const match = findGameById(res.games, gameId);
      if (match && match.pgn) {
        return { game: match, matchedUser: primaryUser };
      }
    }
  } catch (err) {
    lastError = err;
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error(
    `Game #${gameId} was not found yet for ${users.join(" / ")}. Wait a few seconds and click again.`
  );
}

/**
 * Determine which color the user played, preferring the signed-in account over the bottom player.
 * The bottom player is not always the user, so the account name (when present) decides first.
 */
function detectPlayedColor(game, primaryUsername, accountUsername = null) {
  const whiteUser = (game.white?.username || "").trim().toLowerCase();
  const blackUser = (game.black?.username || "").trim().toLowerCase();
  for (const name of [accountUsername, primaryUsername]) {
    const lower = (name || "").trim().toLowerCase();
    if (!lower) continue;
    if (blackUser === lower) return "b";
    if (whiteUser === lower) return "w";
  }
  return "w";
}

function buildGamePayload(game, gameId, primaryUsername, accountUsername = null) {
  return {
    gameId,
    url: game.url || "",
    pgn: game.pgn || "",
    timeClass: game.time_class || "",
    timeControl: game.time_control || "",
    rated: Boolean(game.rated),
    endTime: game.end_time || Math.floor(Date.now() / 1000),
    username: primaryUsername,
    accountUsername,
    playedColor: detectPlayedColor(game, primaryUsername, accountUsername),
    white: {
      username: game.white?.username || "White",
      rating: game.white?.rating ?? null,
      result: game.white?.result || "",
    },
    black: {
      username: game.black?.username || "Black",
      rating: game.black?.rating ?? null,
      result: game.black?.result || "",
    },
    fetchedAt: Date.now(),
  };
}

async function saveGameToStorage(payload) {
  const stored = await chrome.storage.local.get(["recentGames", "fallbackUsername"]);
  const recent = Array.isArray(stored.recentGames) ? stored.recentGames : [];
  const filtered = recent.filter((g) => g.gameId !== payload.gameId);
  filtered.unshift(payload);

  const updates = {
    activeGame: payload,
    recentGames: filtered.slice(0, 15),
  };

  // Auto-clean a stale invalid fallback username only when the signed-in account is known.
  if (stored.fallbackUsername && !isValidUsername(stored.fallbackUsername) && isValidUsername(payload.accountUsername)) {
    updates.fallbackUsername = payload.accountUsername;
  }

  await chrome.storage.local.set(updates);
}

/**
 * Chrome MV3 async message listener (MUST return true and invoke sendResponse).
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "OPEN_GAME_REVIEW") {
    return false;
  }

  (async () => {
    try {
      const { gameId, username, candidateUsernames } = message;
      const accountUsername = isValidUsername(message.accountUsername) ? message.accountUsername.trim() : null;
      if (!gameId) {
        sendResponse({ ok: false, error: "Missing game ID." });
        return;
      }

      const candidates = [];
      if (isValidUsername(username)) candidates.push(username.trim());
      if (Array.isArray(candidateUsernames)) {
        for (const c of candidateUsernames) {
          if (isValidUsername(c) && !candidates.some((u) => u.toLowerCase() === c.trim().toLowerCase())) {
            candidates.push(c.trim());
          }
        }
      }

      if (candidates.length === 0) {
        sendResponse({ ok: false, error: "Could not detect a valid Chess.com username on this page." });
        return;
      }

      const { game, matchedUser } = await fetchGameWithRetry(candidates, gameId);
      const primaryUser = accountUsername || matchedUser || candidates[0];
      const payload = buildGamePayload(game, gameId, primaryUser, accountUsername);
      await saveGameToStorage(payload);

      await chrome.tabs.create({
        url: chrome.runtime.getURL("review.html"),
      });

      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  })();

  return true;
});

/**
 * Clicking the toolbar icon opens review.html directly.
 */
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("review.html"),
  });
});
