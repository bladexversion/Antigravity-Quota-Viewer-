// ── AgQuota Application Controller ──
import { getUsageData, triggerRefresh, deleteAccount } from "./api.js";
import {
  preferences,
  displayEmail,
  formatDuration,
  formatAgo,
  sortAccounts,
  getPool,
  getPoolPct
} from "./state.js";
import {
  $,
  el,
  updateActiveCard,
  buildAccountRow,
  updateAccountRow,
  showToast,
  showContextMenu,
  openForgetModal
} from "./components.js";

const CYCLE_SECS = 7 * 86400;

// Application State
let appData = null;
let isBusy = false;
let isOffline = false;
let lastLoadTimestamp = Date.now();
const rowMap = new Map();
const prevPoolMap = new Map();
let isFirstLoad = true;

const STATUS_MESSAGES = {
  starting: "Starting up",
  ok: "Connected",
  antigravity_not_running: "Antigravity not running",
  not_logged_in: "Nobody logged in",
  unreachable: "Antigravity not answering",
  error: "Collector error"
};

// ── Check Recoveries ──
function checkRecoveries(accounts) {
  if (isFirstLoad) {
    for (const acc of accounts) {
      const g = getPool(acc, "gemini");
      const c = getPool(acc, "claude_gpt");
      prevPoolMap.set(acc.email, {
        gLow: (getPoolPct(g) ?? 100) < 20,
        cLow: (getPoolPct(c) ?? 100) < 20
      });
    }
    isFirstLoad = false;
    return;
  }

  for (const acc of accounts) {
    const prev = prevPoolMap.get(acc.email);
    const gPct = getPoolPct(getPool(acc, "gemini"));
    const cPct = getPoolPct(getPool(acc, "claude_gpt"));

    const gRecovered = prev?.gLow && gPct !== null && gPct >= 60;
    const cRecovered = prev?.cLow && cPct !== null && cPct >= 60;

    if (gRecovered || cRecovered) {
      const pools = [gRecovered ? "Gemini" : null, cRecovered ? "Claude & GPT" : null]
        .filter(Boolean)
        .join(" & ");
      showToast(`↑ ${displayEmail(acc.email, preferences.hideEmails)} — ${pools} quota recovered!`, "info");
    }

    prevPoolMap.set(acc.email, {
      gLow: (gPct ?? 100) < 20,
      cLow: (cPct ?? 100) < 20
    });
  }
}

// ── Render Dashboard ──
function render() {
  if (!appData) return;

  const collector = appData.collector || {};
  const statusContainer = $("#h-status");
  const statusText = $("#h-status-text");
  const isHealthy = !isOffline && collector.state === "ok";

  statusContainer.className = `h-status ${isHealthy ? "ok" : "bad"}`;
  statusText.textContent = isOffline ? "Offline" : (STATUS_MESSAGES[collector.state] || collector.state || "Connected");

  const offlineBanner = $("#offline-banner");
  if (isOffline) {
    offlineBanner.classList.add("show");
    const cachedTime = appData.generated_at ? new Date(appData.generated_at).toLocaleTimeString() : "earlier";
    $("#offline-text").textContent = `Service offline — showing cached quota data from ${cachedTime}`;
  } else {
    offlineBanner.classList.remove("show");
  }

  const accounts = appData.accounts || [];
  const liveAccount = accounts.find(a => a.status === "live");

  // Check recoveries
  checkRecoveries(accounts);

  // Update top active account card
  updateActiveCard(liveAccount, preferences.hideEmails);

  // Sort accounts
  const sorted = sortAccounts(accounts, preferences.sortMode);

  // Account count badge
  const countEl = $("#acct-count");
  if (countEl) {
    countEl.textContent = `${sorted.length} account${sorted.length === 1 ? "" : "s"}`;
  }

  // Render accounts table body
  const gridBody = $("#grid-body");
  const seenEmails = new Set();

  const handleCopy = async (email, buttonEl) => {
    try {
      await navigator.clipboard.writeText(email);
      buttonEl.textContent = "✓";
      buttonEl.classList.add("copied");
      setTimeout(() => {
        buttonEl.textContent = "Copy";
        buttonEl.classList.remove("copied");
      }, 1400);
      showToast("Email copied", "ok");
    } catch {
      showToast("Copy failed", "bad");
    }
  };

  const handleMenu = (event, account) => {
    showContextMenu(event, account, acc => {
      openForgetModal(acc, async email => {
        try {
          await deleteAccount(email);
          showToast("Account removed", "ok");
          await loadData(true);
        } catch (err) {
          showToast(err.message || "Failed to remove account", "bad");
        }
      });
    });
  };

  for (const account of sorted) {
    seenEmails.add(account.email);
    let row = rowMap.get(account.email);
    if (!row) {
      row = buildAccountRow(account, preferences.sortMode, preferences.hideEmails, handleMenu, handleCopy);
      rowMap.set(account.email, row);
    } else {
      updateAccountRow(row, account, preferences.sortMode, preferences.hideEmails, handleMenu, handleCopy);
    }
  }

  // Remove rows no longer present
  for (const [email, row] of rowMap) {
    if (!seenEmails.has(email)) {
      row.remove();
      rowMap.delete(email);
    }
  }

  // Append in sorted order
  for (const account of sorted) {
    const row = rowMap.get(account.email);
    if (row) gridBody.append(row);
  }

  // Empty state handling
  let emptyState = gridBody.querySelector(".empty-state");
  if (sorted.length === 0) {
    if (!emptyState) {
      emptyState = el("div", "empty-state");
      emptyState.innerHTML = `
        <div class="empty-icon">🔍</div>
        <div class="empty-title">No accounts tracked yet</div>
        <div class="empty-desc">Sign in to Antigravity and your AI quota readings will appear here automatically.</div>
      `;
      gridBody.append(emptyState);
    }
  } else if (emptyState) {
    emptyState.remove();
  }

  tick();
}

// ── Data Fetching ──
async function loadData(manual = false) {
  if (isBusy) return;
  isBusy = true;

  const refreshBtn = $("#ref-btn");
  if (refreshBtn) refreshBtn.classList.add("spinning");

  try {
    if (manual) {
      appData = await triggerRefresh();
    } else {
      appData = await getUsageData();
    }
    isOffline = false;
    lastLoadTimestamp = Date.now();
  } catch (err) {
    console.error("Failed to load quota data:", err);
    isOffline = true;
  } finally {
    isBusy = false;
    if (refreshBtn) {
      setTimeout(() => refreshBtn.classList.remove("spinning"), 400);
    }
  }

  render();
}

// ── Live Timers (Every Second) ──
function tick() {
  const now = Date.now();

  // Reset countdowns in grid rows
  document.querySelectorAll(".reset-txt[data-reset-at]").forEach(el => {
    const target = parseInt(el.dataset.resetAt, 10);
    const secLeft = (target - now) / 1000;
    if (secLeft > 0) {
      el.textContent = formatDuration(secLeft);
      if (secLeft < 86400) el.classList.add("soon");
      else el.classList.remove("soon");
    } else {
      el.textContent = "—";
      el.classList.remove("soon");
    }
  });

  // Cycle progress bars
  document.querySelectorAll(".reset-cycle-fill[data-reset-at]").forEach(el => {
    const target = parseInt(el.dataset.resetAt, 10);
    const secLeft = (target - now) / 1000;
    if (secLeft <= 0) {
      el.style.width = "100%";
    } else {
      const p = Math.max(0, Math.min(100, (1 - secLeft / CYCLE_SECS) * 100));
      el.style.width = `${p}%`;
    }
  });

  // Active card reset badge
  const activeResetBadge = $("#ac-reset-badge");
  if (activeResetBadge && activeResetBadge.dataset.resetAt) {
    const target = parseInt(activeResetBadge.dataset.resetAt, 10);
    const secLeft = (target - now) / 1000;
    if (secLeft > 0) {
      activeResetBadge.textContent = `↻ Resets in ${formatDuration(secLeft)}`;
      activeResetBadge.className = `ac-reset-badge ${secLeft < 3600 ? "urgent" : secLeft < 86400 ? "soon" : "far"}`;
      activeResetBadge.style.display = "inline-flex";
    } else {
      activeResetBadge.style.display = "none";
    }
  }

  // Saved accounts data age labels
  document.querySelectorAll(".acct-data-age[data-data-age]").forEach(el => {
    el.textContent = formatAgo(el.dataset.dataAge);
  });

  // Header update timestamp
  if (appData && appData.generated_at) {
    const tsEl = $("#h-ts");
    if (tsEl) tsEl.textContent = `Updated ${formatAgo(appData.generated_at)}`;
  }

  // Refresh countdown
  const cdEl = $("#refresh-cd");
  if (cdEl) {
    const remaining = Math.max(0, 30 - Math.floor((now - lastLoadTimestamp) / 1000));
    cdEl.textContent = remaining > 0 ? `in ${remaining}s` : "updating...";
  }
}

// ── Density Mode Handler ──
function applyDensity(density) {
  preferences.density = density;
  const wrap = $("#tbl-wrap");
  wrap.classList.remove("d-compact", "d-normal", "d-spacious");
  wrap.classList.add(`d-${density}`);

  document.querySelectorAll(".density-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.density === density);
  });
}

// ── Sort Mode Handler ──
function applySort(mode) {
  preferences.sortMode = mode;
  document.querySelectorAll(".sort-pill").forEach(pill => {
    pill.classList.toggle("active", pill.dataset.sort === mode);
  });
  render();
}

// ── Initialization ──
function init() {
  // Density buttons
  applyDensity(preferences.density);
  document.querySelectorAll(".density-btn").forEach(btn => {
    btn.onclick = () => applyDensity(btn.dataset.density);
  });

  // Sort pills
  document.querySelectorAll(".sort-pill").forEach(pill => {
    pill.classList.toggle("active", pill.dataset.sort === preferences.sortMode);
    pill.onclick = () => applySort(pill.dataset.sort);
  });

  // Email mask toggle
  const maskCheckbox = $("#mask");
  maskCheckbox.checked = preferences.hideEmails;
  maskCheckbox.onchange = e => {
    preferences.hideEmails = e.target.checked;
    render();
  };

  // Refresh button
  const refreshBtn = $("#ref-btn");
  refreshBtn.onclick = () => loadData(true);

  // Background loops
  setInterval(() => {
    if (!document.hidden) loadData(false);
  }, 30000);

  setInterval(tick, 1000);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadData(false);
  });

  // Initial load
  loadData(false);
}

// Start application when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
