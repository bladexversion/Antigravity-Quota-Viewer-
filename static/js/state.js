// ── State, Data Parsing & Formatting Utilities ──

// Persisted Preferences
export const preferences = {
  get hideEmails() {
    try { return localStorage.getItem("agq_hide") === "1"; } catch { return false; }
  },
  set hideEmails(val) {
    try { localStorage.setItem("agq_hide", val ? "1" : "0"); } catch {}
  },
  get sortMode() {
    try { return localStorage.getItem("agq_sort") || "best"; } catch { return "best"; }
  },
  set sortMode(val) {
    try { localStorage.setItem("agq_sort", val); } catch {}
  },
  get density() {
    try { return localStorage.getItem("agq_density") || "normal"; } catch { return "normal"; }
  },
  set density(val) {
    try { localStorage.setItem("agq_density", val); } catch {}
  }
};

// Mask an email address: aravsun@gmail.com -> a•••••@g•••.com
export function maskEmail(email) {
  if (!email || typeof email !== "string") return "";
  const [user, domain = ""] = email.split("@");
  const lastDot = domain.lastIndexOf(".");
  const maskedUser = user[0] + "•".repeat(Math.min(5, Math.max(user.length - 1, 2)));
  const maskedDomain = (domain[0] || "") + "•••" + (lastDot > 0 ? domain.slice(lastDot) : "");
  return `${maskedUser}@${maskedDomain}`;
}

export function displayEmail(email, isHidden) {
  return isHidden ? maskEmail(email) : email;
}

// Format duration from seconds to human-readable: "6d 23h", "5h 12m", "45s"
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return "—";
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// Format ISO date to relative ago string: "just now", "4m ago", "2h ago", "1d ago"
export function formatAgo(isoString) {
  if (!isoString) return "";
  const past = Date.parse(isoString);
  if (isNaN(past)) return "";
  const diffSec = Math.floor((Date.now() - past) / 1000);
  if (diffSec < 0) return "just now";
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

// Safely get a pool dictionary from an account
export function getPool(account, poolKey) {
  if (!account || !account.pools || typeof account.pools !== "object") return null;
  return account.pools[poolKey] || null;
}

// Determine numeric percentage (0-100) or null
export function getPoolPct(pool) {
  if (!pool) return null;
  if (pool.state === "reset") return 100;
  if (typeof pool.remaining_percent === "number") return pool.remaining_percent;
  if (pool.state === "empty") return 0;
  // If remaining fraction wasn't supplied by Antigravity but resetTime is set,
  // it indicates exhausted quota waiting for reset
  if (pool.state === "unknown" && pool.reset_at && pool.seconds_left > 0) {
    return 0;
  }
  return null;
}

// Classify percentage into health tier
export function getHealthTier(pct) {
  if (pct === null || pct === undefined) {
    return { key: "unknown", label: "Unknown" };
  }
  if (pct >= 80) return { key: "excellent", label: "Excellent" };
  if (pct >= 60) return { key: "good", label: "Good" };
  if (pct >= 40) return { key: "moderate", label: "Moderate" };
  if (pct >= 20) return { key: "low", label: "Low" };
  return { key: "critical", label: "Critical" };
}

// Compute account health tier adapting to active sort mode
export function getAcctHealth(account, sortMode) {
  let pcts = [];
  if (sortMode === "gemini") {
    pcts = [getPoolPct(getPool(account, "gemini"))];
  } else if (sortMode === "claude") {
    pcts = [getPoolPct(getPool(account, "claude_gpt"))];
  } else {
    pcts = [
      getPoolPct(getPool(account, "gemini")),
      getPoolPct(getPool(account, "claude_gpt"))
    ];
  }
  const known = pcts.filter(p => p !== null && p !== undefined);
  if (!known.length) return getHealthTier(null);
  return getHealthTier(Math.min(...known));
}

// Balanced score across both Gemini and Claude & GPT pools
export function getBestScore(account) {
  const g = getPoolPct(getPool(account, "gemini")) ?? 0;
  const c = getPoolPct(getPool(account, "claude_gpt")) ?? 0;
  return Math.min(g, c) * 1000 + (g + c) / 2;
}

// Find earliest reset seconds left for an account
export function earliestReset(account) {
  if (!account || !account.pools) return null;
  let minSecs = null;
  for (const pool of Object.values(account.pools)) {
    if (!pool) continue;
    let sl = pool.seconds_left;
    if (sl == null && pool.reset_at) {
      const parsed = (Date.parse(pool.reset_at) - Date.now()) / 1000;
      if (parsed > 0) sl = parsed;
    }
    if (sl != null && sl > 0) {
      if (minSecs === null || sl < minSecs) minSecs = sl;
    }
  }
  return minSecs;
}

// Sort accounts list deterministically
export function sortAccounts(accounts, sortMode) {
  if (!Array.isArray(accounts)) return [];
  return [...accounts].sort((a, b) => {
    switch (sortMode) {
      case "gemini": {
        const valA = getPoolPct(getPool(a, "gemini")) ?? -1;
        const valB = getPoolPct(getPool(b, "gemini")) ?? -1;
        return valB - valA;
      }
      case "claude": {
        const valA = getPoolPct(getPool(a, "claude_gpt")) ?? -1;
        const valB = getPoolPct(getPool(b, "claude_gpt")) ?? -1;
        return valB - valA;
      }
      case "lowest": {
        return getBestScore(a) - getBestScore(b);
      }
      case "recent": {
        const timeA = Date.parse(a.last_seen || a.first_seen || "2000");
        const timeB = Date.parse(b.last_seen || b.first_seen || "2000");
        return (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
      }
      case "best":
      default: {
        return getBestScore(b) - getBestScore(a);
      }
    }
  });
}
