/**
 * Chess.com Local Game Review — Content Script (v1.3 — AMO Linter Clean)
 * Matches *://*.chess.com/game/*
 *
 * Uses pure DOM APIs (zero innerHTML/outerHTML) to pass Mozilla addons-linter cleanly.
 * Strictly waits for a game to officially end before injecting a full-width
 * "Local Game Review" button. Never triggers during live games.
 */
(() => {
  "use strict";

  const extension = globalThis.browser ?? globalThis.chrome;

  const MODAL_WRAPPER_ID = "clgr-modal-wrapper";
  const SIDEBAR_WRAPPER_ID = "clgr-sidebar-wrapper";
  const SVG_NS = "http://www.w3.org/2000/svg";

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

  let lastUrl = window.location.href;
  let observer = null;

  function isValidUsername(name) {
    if (!name || typeof name !== "string") return false;
    const trimmed = name.trim();
    if (!/^[a-zA-Z0-9_-]{3,30}$/.test(trimmed)) return false;
    return !RESERVED_USERNAMES.has(trimmed.toLowerCase());
  }

  function parseGameUrl(urlStr) {
    try {
      const url = new URL(urlStr);
      const match = url.pathname.match(/\/game\/(?:(live|daily)\/)?(\d+)/i);
      if (!match) return null;
      return {
        gameType: (match[1] || "live").toLowerCase(),
        gameId: match[2],
      };
    } catch {
      return null;
    }
  }

  function extractUsernameFromElement(el) {
    if (!el) return null;

    const attrs = [
      el.getAttribute("data-username"),
      el.getAttribute("data-user-activity-key"),
    ];
    for (const val of attrs) {
      if (isValidUsername(val)) return val.trim();
    }

    const href = el.getAttribute("href");
    if (href) {
      const m = href.match(/\/member\/([a-zA-Z0-9_-]+)/i);
      if (m && isValidUsername(m[1])) return m[1].trim();
    }

    const text = (el.textContent || "").trim();
    if (isValidUsername(text)) return text;

    return null;
  }

  const NAV_USERNAME_SELECTORS = [
    "#notifications-request[data-username]",
    "[data-user-activity-key]",
    ".nav-user-menu-button[href*='/member/']",
  ];

  /** The signed-in account's name, from the site navigation only (never the board's player tags). */
  function detectAccountUsername() {
    for (const sel of NAV_USERNAME_SELECTORS) {
      const name = extractUsernameFromElement(document.querySelector(sel));
      if (isValidUsername(name)) return name.trim();
    }
    return null;
  }

  function detectGameUsernames() {
    const candidates = [];
    const addCandidate = (name) => {
      if (!isValidUsername(name)) return;
      const clean = name.trim();
      if (!candidates.some((c) => c.toLowerCase() === clean.toLowerCase())) {
        candidates.push(clean);
      }
    };

    const bottomSelectors = [
      "#board-layout-player-bottom [data-test-element='user-tagline-username']",
      "#board-layout-player-bottom .user-username-component",
      "#board-layout-player-bottom a[href*='/member/']",
      ".board-layout-bottom [data-test-element='user-tagline-username']",
      ".board-layout-bottom .user-username-component",
      ".player-bottom [data-test-element='user-tagline-username']",
      ".player-bottom .user-username-component",
    ];
    for (const sel of bottomSelectors) {
      addCandidate(extractUsernameFromElement(document.querySelector(sel)));
    }

    for (const sel of NAV_USERNAME_SELECTORS) {
      addCandidate(extractUsernameFromElement(document.querySelector(sel)));
    }

    const topSelectors = [
      "#board-layout-player-top [data-test-element='user-tagline-username']",
      "#board-layout-player-top .user-username-component",
      "#board-layout-player-top a[href*='/member/']",
      ".board-layout-top [data-test-element='user-tagline-username']",
      ".board-layout-top .user-username-component",
      ".player-top [data-test-element='user-tagline-username']",
      ".player-top .user-username-component",
    ];
    for (const sel of topSelectors) {
      addCandidate(extractUsernameFromElement(document.querySelector(sel)));
    }

    document
      .querySelectorAll("[data-test-element='user-tagline-username'], .user-username-component")
      .forEach((el) => addCandidate(extractUsernameFromElement(el)));

    return {
      primaryUsername: candidates[0] || null,
      candidateUsernames: candidates,
    };
  }

  function isElementVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function createSparkleIcon() {
    const span = document.createElement("span");
    span.className = "clgr-icon";
    span.setAttribute("aria-hidden", "true");

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("fill", "none");

    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", "12");
    circle.setAttribute("cy", "12");
    circle.setAttribute("r", "10");
    circle.setAttribute("fill", "#81b64c");
    circle.setAttribute("fill-opacity", "0.18");
    circle.setAttribute("stroke", "#81b64c");
    circle.setAttribute("stroke-width", "1.8");

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M12 6.5l1.6 3.7 3.9 1.3-3.9 1.3L12 16.5l-1.6-3.7-3.9-1.3 3.9-1.3L12 6.5z");
    path.setAttribute("fill", "#81b64c");

    svg.appendChild(circle);
    svg.appendChild(path);
    span.appendChild(svg);
    return span;
  }

  function createSpinner() {
    const spinner = document.createElement("span");
    spinner.className = "clgr-spinner";
    spinner.setAttribute("aria-hidden", "true");
    return spinner;
  }

  function createReviewButtonBlock(wrapperId) {
    const wrapper = document.createElement("div");
    wrapper.id = wrapperId;
    wrapper.className = "clgr-btn-wrapper";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "clgr-review-btn";

    const iconSlot = document.createElement("span");
    iconSlot.className = "clgr-icon-slot";
    iconSlot.appendChild(createSparkleIcon());

    const labelSpan = document.createElement("span");
    labelSpan.textContent = "Local Game Review";

    btn.appendChild(iconSlot);
    btn.appendChild(labelSpan);

    const statusEl = document.createElement("div");
    statusEl.className = "clgr-status-text";

    btn.addEventListener("click", () => handleReviewClick(btn, iconSlot, labelSpan, statusEl));

    wrapper.appendChild(btn);
    wrapper.appendChild(statusEl);
    return wrapper;
  }

  async function handleReviewClick(btn, iconSlot, labelSpan, statusEl) {
    const parsed = parseGameUrl(window.location.href);
    if (!parsed) {
      statusEl.textContent = "Could not detect game ID from URL.";
      statusEl.className = "clgr-status-text clgr-error";
      return;
    }

    const detected = detectGameUsernames();
    let username = detected.primaryUsername;
    const candidateUsernames = [...detected.candidateUsernames];

    try {
      const stored = await extension.storage.local.get("fallbackUsername");
      if (stored && isValidUsername(stored.fallbackUsername)) {
        const saved = stored.fallbackUsername.trim();
        if (!username) username = saved;
        if (!candidateUsernames.some((c) => c.toLowerCase() === saved.toLowerCase())) {
          candidateUsernames.push(saved);
        }
      }
    } catch {
      // Ignore storage read failure
    }

    if (!username) {
      const entered = window.prompt(
        "Chess.com Local Game Review:\nEnter your Chess.com username (or either player's username) to fetch this game's PGN:"
      );
      if (!entered || !isValidUsername(entered)) {
        statusEl.textContent = "Please enter a valid Chess.com username.";
        statusEl.className = "clgr-status-text clgr-error";
        return;
      }
      username = entered.trim();
      candidateUsernames.unshift(username);
      try {
        await extension.storage.local.set({ fallbackUsername: username });
      } catch {
        // Ignore storage write failure
      }
    }

    btn.disabled = true;
    iconSlot.replaceChildren(createSpinner());
    labelSpan.textContent = "Fetching Game...";
    statusEl.className = "clgr-status-text";
    statusEl.textContent = `Loading PGN for ${username}...`;

    try {
      const response = await extension.runtime.sendMessage({
        type: "OPEN_GAME_REVIEW",
        gameId: parsed.gameId,
        gameType: parsed.gameType,
        username,
        candidateUsernames,
        accountUsername: detectAccountUsername(),
        pageUrl: window.location.href,
      });

      if (response && response.ok) {
        statusEl.className = "clgr-status-text clgr-success";
        statusEl.textContent = "Opened Local Game Review!";
        setTimeout(() => {
          resetButton(btn, iconSlot, labelSpan, statusEl);
        }, 2000);
      } else {
        const errMsg =
          (response && response.error) ||
          "Game not indexed by Chess.com yet. Wait a few seconds and click again.";
        statusEl.className = "clgr-status-text clgr-error";
        statusEl.textContent = errMsg;
        resetButton(btn, iconSlot, labelSpan, null);
      }
    } catch (err) {
      statusEl.className = "clgr-status-text clgr-error";
      statusEl.textContent = `Extension error: ${err.message || err}`;
      resetButton(btn, iconSlot, labelSpan, null);
    }
  }

  function resetButton(btn, iconSlot, labelSpan, statusEl) {
    btn.disabled = false;
    iconSlot.replaceChildren(createSparkleIcon());
    labelSpan.textContent = "Local Game Review";
    if (statusEl) {
      statusEl.textContent = "";
      statusEl.className = "clgr-status-text";
    }
  }

  function tryInjectModalButton() {
    if (document.getElementById(MODAL_WRAPPER_ID)) return;

    const modal = document.querySelector(
      ".game-over-modal-content, [data-cy='game-over-modal'], .game-over-modal-component"
    );
    if (!modal || !isElementVisible(modal)) return;

    const wrapper = createReviewButtonBlock(MODAL_WRAPPER_ID);

    const modalButtons = modal.querySelector(
      ".game-over-modal-buttons, .game-over-buttons-component"
    );
    const greenReviewBtn =
      modal.querySelector(".game-over-review-button-component") ||
      modal.querySelector("a[href*='/analysis/game/']") ||
      modal.querySelector("button[class*='review']");

    if (greenReviewBtn && greenReviewBtn.parentElement && greenReviewBtn.parentElement !== modalButtons) {
      greenReviewBtn.insertAdjacentElement("afterend", wrapper);
      return;
    }

    if (modalButtons && modalButtons.parentElement) {
      modalButtons.insertAdjacentElement("beforebegin", wrapper);
      return;
    }

    modal.appendChild(wrapper);
  }

  function tryInjectSidebarButton() {
    if (document.getElementById(SIDEBAR_WRAPPER_ID)) return;

    const sidebarReview = document.querySelector(
      ".game-review-buttons-component, .game-over-buttons-component"
    );
    if (!sidebarReview || !isElementVisible(sidebarReview)) return;
    if (sidebarReview.closest(".game-over-modal-content, .game-over-modal-component, [data-cy='game-over-modal']")) {
      return;
    }

    const wrapper = createReviewButtonBlock(SIDEBAR_WRAPPER_ID);
    if (sidebarReview.parentElement) {
      sidebarReview.insertAdjacentElement("beforebegin", wrapper);
    }
  }

  function tryInjectAll() {
    if (!parseGameUrl(window.location.href)) return;
    tryInjectModalButton();
    tryInjectSidebarButton();
  }

  function startObserver() {
    tryInjectAll();

    let debounceTimer = null;
    observer = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        [MODAL_WRAPPER_ID, SIDEBAR_WRAPPER_ID].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.remove();
        });
      }

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(tryInjectAll, 220);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  } else {
    startObserver();
  }
})();
