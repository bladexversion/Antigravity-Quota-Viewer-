// ── UI Components & DOM Renderers ──
import {
  displayEmail,
  formatDuration,
  formatAgo,
  getPool,
  getPoolPct,
  getHealthTier,
  getAcctHealth,
  earliestReset
} from "./state.js";

const CYCLE_SECS = 7 * 86400;

export const $ = selector => document.querySelector(selector);

export function el(tag, className, textContent) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (textContent !== undefined && textContent !== null) {
    element.textContent = textContent;
  }
  return element;
}

// ── Active Account Hero Banner ──
export function updateActiveCard(liveAccount, isHidden) {
  const card = $("#active-card");
  if (!liveAccount) {
    card.style.display = "none";
    return;
  }
  card.style.display = "flex";

  const avatar = $("#ac-avatar");
  if (liveAccount.profile_picture_url) {
    avatar.innerHTML = `<img src="${liveAccount.profile_picture_url}" alt="" />`;
  } else {
    avatar.textContent = (liveAccount.email || "?")[0].toUpperCase();
  }

  const emailEl = $("#ac-email");
  emailEl.textContent = displayEmail(liveAccount.email, isHidden);
  emailEl.dataset.rawEmail = liveAccount.email;
  emailEl.title = isHidden ? "" : liveAccount.email;

  const planEl = $("#ac-plan");
  planEl.textContent = liveAccount.plan ? `${liveAccount.plan} plan` : "Plan active";

  // Pools
  const poolsContainer = $("#ac-pools");
  poolsContainer.innerHTML = "";

  const poolDefs = [
    { key: "gemini", label: "Gemini" },
    { key: "claude_gpt", label: "Claude & GPT" }
  ];

  for (const def of poolDefs) {
    const pool = getPool(liveAccount, def.key);
    const pct = getPoolPct(pool);
    const tier = getHealthTier(pct);

    const poolDiv = el("div", "ac-pool");
    const header = el("div", "ac-pool-header");
    const nameSpan = el("span", "ac-pool-name", def.label);

    let pctText = "—";
    if (pool?.state === "reset") pctText = "↑ Reset";
    else if (pct !== null) pctText = `${pct}%`;

    const pctSpan = el("span", `ac-pool-pct c-${tier.key}`, pctText);
    header.append(nameSpan, pctSpan);

    const track = el("div", "ac-pool-track");
    const fill = el("div", `ac-pool-fill ${getBarClass(pool, pct, tier)}`);
    const fillWidth = pool?.state === "reset" ? 100 : (pct ?? 0);
    fill.style.width = `${fillWidth}%`;
    track.append(fill);

    poolDiv.append(header, track);
    poolsContainer.append(poolDiv);
  }

  // Reset badge
  const resetBadge = $("#ac-reset-badge");
  const minReset = earliestReset(liveAccount);
  if (minReset !== null && minReset > 0) {
    resetBadge.style.display = "inline-flex";
    resetBadge.dataset.resetAt = String(Date.now() + minReset * 1000);
    resetBadge.textContent = `↻ Resets in ${formatDuration(minReset)}`;
    resetBadge.className = `ac-reset-badge ${minReset < 3600 ? "urgent" : minReset < 86400 ? "soon" : "far"}`;
  } else {
    resetBadge.style.display = "none";
    resetBadge.dataset.resetAt = "";
  }

  // Copy button
  const copyBtn = $("#ac-copy");
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(liveAccount.email);
      copyBtn.textContent = "Copied ✓";
      copyBtn.classList.add("done");
      setTimeout(() => {
        copyBtn.textContent = "Copy email";
        copyBtn.classList.remove("done");
      }, 1500);
      showToast("Email copied to clipboard", "ok");
    } catch {
      showToast("Failed to copy email", "bad");
    }
  };
}

// ── Progress Bar Helper ──
function getBarClass(pool, pct, tier) {
  if (!pool) return "bar-unknown";
  if (pool.state === "reset") return "bar-reset";
  if (pct === null || pct === undefined) return "bar-unknown";
  return `bar-${tier.key}`;
}

// ── Pool Cell Builder ──
function buildPoolCell(pool, label) {
  const cell = el("div", "grid-cell cell-pool");
  const pct = getPoolPct(pool);
  const tier = getHealthTier(pct);

  const topRow = el("div", "pool-top");

  let pctText = "—";
  let stateNote = "";

  if (pool?.state === "reset") {
    pctText = "Reset";
    stateNote = "Available";
  } else if (pct !== null) {
    pctText = `${pct}%`;
    stateNote = pct <= 0 ? "Exhausted" : pct < 20 ? "Low" : "";
  } else {
    stateNote = "No data";
  }

  const pctSpan = el("span", `pool-pct c-${tier.key}`, pctText);
  const noteSpan = el("span", "pool-state-label", stateNote);
  topRow.append(pctSpan, noteSpan);

  const track = el("div", "pool-track");
  track.setAttribute("role", "progressbar");
  const fillWidth = pool?.state === "reset" ? 100 : (pct ?? 0);
  track.setAttribute("aria-valuenow", String(fillWidth));

  const fill = el("div", `pool-fill ${getBarClass(pool, pct, tier)}`);
  fill.style.width = `${fillWidth}%`;
  track.append(fill);

  cell.append(topRow, track);
  return cell;
}

// ── Reset Cell Builder ──
function buildResetCell(account) {
  const cell = el("div", "grid-cell cell-reset");
  const minReset = earliestReset(account);

  if (minReset !== null && minReset > 0) {
    const textSpan = el("span", `reset-txt ${minReset < 86400 ? "soon" : ""}`);
    textSpan.dataset.resetAt = String(Date.now() + minReset * 1000);
    textSpan.textContent = formatDuration(minReset);

    const cycleBar = el("div", "reset-cycle-bar");
    const cycleFill = el("div", "reset-cycle-fill");
    cycleFill.dataset.resetAt = String(Date.now() + minReset * 1000);

    const progress = Math.max(0, Math.min(100, (1 - minReset / CYCLE_SECS) * 100));
    cycleFill.style.width = `${progress}%`;
    cycleBar.append(cycleFill);

    cell.append(textSpan, cycleBar);
  } else {
    const textSpan = el("span", "reset-txt", "—");
    cell.append(textSpan);
  }

  return cell;
}

// ── Account Grid Row Builder ──
export function buildAccountRow(account, sortMode, isHidden, onMenu, onCopy) {
  const row = el("div", "grid-row");
  row.dataset.email = account.email;
  if (account.status === "live") {
    row.classList.add("row-live");
  }

  // 1. Account Identity Cell
  const cellAcct = el("div", "grid-cell cell-acct");
  const avatar = el("div", "acct-avatar");
  if (account.profile_picture_url) {
    avatar.innerHTML = `<img src="${account.profile_picture_url}" alt="" />`;
  } else {
    avatar.textContent = (account.email || "?")[0].toUpperCase();
  }

  const info = el("div", "acct-info");
  const emailSpan = el("span", "acct-email", displayEmail(account.email, isHidden));
  emailSpan.dataset.rawEmail = account.email;
  emailSpan.title = isHidden ? "" : account.email;

  const meta = el("div", "acct-meta");
  if (account.status === "live") {
    meta.append(el("span", "acct-tag-live", "Active"));
  } else if (account.last_seen) {
    const ageSpan = el("span", "acct-data-age", formatAgo(account.last_seen));
    ageSpan.dataset.dataAge = account.last_seen;
    meta.append(ageSpan);
  }

  if (account.plan) {
    meta.append(el("span", "acct-plan", account.plan));
  }
  info.append(emailSpan, meta);

  const copyBtn = el("button", "acct-copy-btn", "Copy");
  copyBtn.type = "button";
  copyBtn.title = "Copy email address";
  copyBtn.onclick = e => {
    e.stopPropagation();
    onCopy(account.email, copyBtn);
  };

  cellAcct.append(avatar, info, copyBtn);
  row.append(cellAcct);

  // 2. Gemini Pool Cell
  row.append(buildPoolCell(getPool(account, "gemini"), "Gemini"));

  // 3. Claude & GPT Pool Cell (Combined Single Allowance)
  row.append(buildPoolCell(getPool(account, "claude_gpt"), "Claude & GPT"));

  // 4. Account Health Badge Cell
  const cellHealth = el("div", "grid-cell");
  const health = getAcctHealth(account, sortMode);
  const badge = el("span", `health-badge hb-${health.key}`, health.label);
  cellHealth.append(badge);
  row.append(cellHealth);

  // 5. Reset Countdown Cell
  row.append(buildResetCell(account));

  // 6. Action Menu Cell
  const cellMenu = el("div", "grid-cell cell-menu");
  const menuBtn = el("button", "menu-btn");
  menuBtn.type = "button";
  menuBtn.setAttribute("aria-label", "Account options");
  menuBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="8" cy="3" r="1.3"/>
      <circle cx="8" cy="8" r="1.3"/>
      <circle cx="8" cy="13" r="1.3"/>
    </svg>
  `;
  menuBtn.onclick = e => {
    e.stopPropagation();
    onMenu(e, account);
  };
  cellMenu.append(menuBtn);
  row.append(cellMenu);

  return row;
}

// ── In-place Row Update ──
export function updateAccountRow(row, account, sortMode, isHidden, onMenu, onCopy) {
  if (account.status === "live") row.classList.add("row-live");
  else row.classList.remove("row-live");

  const avatar = row.querySelector(".acct-avatar");
  if (avatar) {
    if (account.profile_picture_url) {
      const img = avatar.querySelector("img");
      if (!img || img.src !== account.profile_picture_url) {
        avatar.innerHTML = `<img src="${account.profile_picture_url}" alt="" />`;
      }
    } else {
      avatar.textContent = (account.email || "?")[0].toUpperCase();
    }
  }

  const emailSpan = row.querySelector(".acct-email");
  if (emailSpan) {
    emailSpan.textContent = displayEmail(account.email, isHidden);
    emailSpan.dataset.rawEmail = account.email;
    emailSpan.title = isHidden ? "" : account.email;
  }

  const ageSpan = row.querySelector(".acct-data-age");
  if (ageSpan && account.last_seen && account.status !== "live") {
    ageSpan.textContent = formatAgo(account.last_seen);
  }

  // Replace pools, health, reset cells
  const cells = row.children;
  if (cells[1]) row.replaceChild(buildPoolCell(getPool(account, "gemini"), "Gemini"), cells[1]);
  if (cells[2]) row.replaceChild(buildPoolCell(getPool(account, "claude_gpt"), "Claude & GPT"), cells[2]);

  if (cells[3]) {
    const health = getAcctHealth(account, sortMode);
    cells[3].innerHTML = "";
    cells[3].append(el("span", `health-badge hb-${health.key}`, health.label));
  }

  if (cells[4]) {
    row.replaceChild(buildResetCell(account), cells[4]);
  }
}

// ── Toast Notification ──
let toastTimeout = null;
export function showToast(message, type = "info") {
  const toast = $("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.className = `show ${type}`;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.className = "";
  }, 2600);
}

// ── Context Menu ──
export function showContextMenu(event, account, onForget) {
  let menu = $("#ctx-menu");
  if (!menu) {
    menu = el("div", "ctx-menu");
    menu.id = "ctx-menu";
    document.body.append(menu);
  }
  menu.innerHTML = "";
  menu.style.display = "block";

  // Item 1: Copy Email
  const copyItem = el("div", "ctx-item");
  copyItem.innerHTML = `
    <svg class="ctx-icon ctx-icon-copy" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="5" y="5" width="9" height="9" rx="1.8"></rect>
      <path d="M5 2H3a1 1 0 0 0-1 1v8"></path>
    </svg>
    <span>Copy email</span>
  `;
  copyItem.onclick = async () => {
    closeContextMenu();
    try {
      await navigator.clipboard.writeText(account.email);
      showToast("Email copied", "ok");
    } catch {
      showToast("Copy failed", "bad");
    }
  };

  // Separator
  const sep = el("div", "ctx-sep");

  // Item 2: Forget Account
  const forgetItem = el("div", "ctx-item danger");
  forgetItem.innerHTML = `
    <svg class="ctx-icon ctx-icon-trash" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 4h10M6 4V2.5A1.5 1.5 0 0 1 7.5 1h1A1.5 1.5 0 0 1 10 2.5V4M12 4v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4"></path>
    </svg>
    <span>Forget account</span>
  `;
  forgetItem.onclick = () => {
    closeContextMenu();
    onForget(account);
  };

  menu.append(copyItem, sep, forgetItem);

  const rect = event.currentTarget.getBoundingClientRect?.() || {
    bottom: event.clientY,
    left: event.clientX,
    top: event.clientY
  };

  let top = rect.bottom + 4;
  let left = rect.left;
  if (left + 170 > window.innerWidth - 12) left = window.innerWidth - 182;
  if (top + 100 > window.innerHeight - 12) top = rect.top - 104;

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;

  setTimeout(() => {
    const closeHandler = e => {
      if (!menu.contains(e.target)) closeContextMenu();
    };
    document.addEventListener("click", closeHandler, { capture: true, once: true });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") closeContextMenu();
    }, { once: true });
    window.addEventListener("scroll", closeContextMenu, { capture: true, once: true, passive: true });
  }, 0);
}

export function closeContextMenu() {
  const menu = $("#ctx-menu");
  if (menu) menu.style.display = "none";
}

// ── Confirmation Modal ──
export function openForgetModal(account, onConfirm) {
  const overlay = $("#dialog-overlay");
  const body = $("#dialog-body");

  const g = getPoolPct(getPool(account, "gemini"));
  const c = getPoolPct(getPool(account, "claude_gpt"));

  let quotaHtml = "";
  if (g !== null || c !== null) {
    const items = [];
    if (g !== null) {
      const tier = getHealthTier(g);
      items.push(`
        <div class="forget-quota-item">
          <span class="forget-quota-label">Gemini</span>
          <span class="forget-quota-val c-${tier.key}">${g}%</span>
        </div>
      `);
    }
    if (c !== null) {
      const tier = getHealthTier(c);
      items.push(`
        <div class="forget-quota-item">
          <span class="forget-quota-label">Claude & GPT</span>
          <span class="forget-quota-val c-${tier.key}">${c}%</span>
        </div>
      `);
    }
    quotaHtml = `<div class="forget-quota">${items.join("")}</div>`;
  }

  body.innerHTML = `
    Remove <strong>${account.email}</strong> from AgQuota?
    ${quotaHtml}
    <div class="dialog-warn">
      This removes the account from monitoring. It does not affect your Google or Antigravity sign-in.
    </div>
  `;

  overlay.hidden = false;

  const confirmBtn = $("#dialog-confirm");
  const cancelBtn = $("#dialog-cancel");

  const cleanup = () => {
    overlay.hidden = true;
    confirmBtn.onclick = null;
    cancelBtn.onclick = null;
  };

  confirmBtn.onclick = async () => {
    cleanup();
    await onConfirm(account.email);
  };

  cancelBtn.onclick = cleanup;
  overlay.onclick = e => {
    if (e.target === overlay) cleanup();
  };
}
