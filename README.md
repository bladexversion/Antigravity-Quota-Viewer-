# AgQuota ⚡

A sleek, lightweight desktop dashboard and local background monitor for tracking multiple Google accounts used with **Antigravity** and their remaining AI quotas.

AgQuota runs entirely locally on loopback (`127.0.0.1`), requires **zero external Python dependencies** (stdlib only), and gives you an instant, high-density overview of your accounts so you know which account to work with next.

---

## 🎯 Key Concepts

1. **Independent Quota Pools**:
   * **Gemini**: Dedicated independent quota pool.
   * **Claude & GPT**: **Shared single pool**. Consumes the same underlying allowance and is always tracked and displayed together.
2. **Passive Multi-Account Harvesting**:
   * Antigravity only exposes the quota for the currently logged-in account via its local language server RPC.
   * AgQuota passively records quota snapshots whenever you switch accounts in Antigravity and persists them to `~/.local/state/agquota/state.json`.
3. **Monitoring Only**:
   * AgQuota is purely a monitoring and comparison dashboard. It does not tamper with credentials, proxy requests, or automate account switching.

---

## ✨ Features

* **Live Active Account Hero Card**: Prominently displays your currently active Antigravity account with its real profile picture, plan, pulsing status indicator, remaining pool percentages, and reset countdown badge.
* **Compact Comparison Grid**: Compare all your accounts at a glance without unnecessary scrolling.
* **Deterministic Sorting**:
  * **Best Overall**: Prioritizes accounts with strong availability across *both* quota pools using a balanced score formula.
  * **Highest Gemini**: Focuses on Gemini availability.
  * **Highest Claude & GPT**: Focuses on Claude & GPT availability.
  * **Lowest Quota**: Identifies accounts nearing exhaustion.
  * **Recently Active**: Chronological order of last activity.
* **Dynamic Health System**:
  * 🟢 **Excellent / Good** (60–100%)
  * 🟡 **Moderate** (40–59%)
  * 🟠 **Low** (20–39%)
  * 🔴 **Critical** (0–19%)
* **Profile Pictures (PFP)**: Automatically extracts and displays base64 account avatars directly from Antigravity's status RPC with smooth initial-letter fallbacks.
* **Row Density Switcher**: Toggle between `Compact`, `Normal`, and `Spacious` display modes (persisted in `localStorage`).
* **Privacy Mode**: One-click "Hide" switch masks email addresses (`a•••••@g•••.com`).
* **Live Timers & Auto-Refresh**: Dynamic second-by-second countdown tickers and a 30s auto-refresh loop with account recovery alerts.
* **Account Management**: Copy email in one click; forget inactive accounts with a confirmation modal showing last known stats.

---

## 🚀 Quick Start

### Prerequisites
* Linux (or WSL2)
* Python 3.8+ (no `pip install` required)
* Antigravity installed and running

## 🚀 Quick Start

### 1. Run in the Background (Recommended)

Set up AgQuota to run silently in the background and start automatically on login/boot:

```bash
python3 agquota.py setup
```

That's it! It automatically detects your local environment, installs the `systemd` user service, and starts it immediately.

View your dashboard anytime at **http://127.0.0.1:8765/**.

#### Managing the Background Service

```bash
# Check service status
python3 agquota.py status

# Stop background server (temporary - restarts on next reboot)
python3 agquota.py stop

# Restart background server
python3 agquota.py restart

# Stream live background logs
journalctl --user -u agquota -f

# Uninstall background service (completely removes autostart)
python3 agquota.py uninstall
```

##### `stop` vs `uninstall`

> 💡 **Which one should I use?**
> * Use **`stop`** if you want to stop it **temporarily** (frees port 8765 now, but starts again when you reboot/log in).
> * Use **`uninstall`** if you want to stop and remove the background service **completely** (will not restart on reboot).

| Command | Action | Restarts on next reboot? |
| :--- | :--- | :--- |
| **`python3 agquota.py stop`** | **Temporarily pauses** the background server and frees port 8765 right now. | **Yes** (autostart remains enabled for next login/reboot). |
| **`python3 agquota.py uninstall`** | **Permanently removes** the background service and deletes the systemd unit file. | **No** (autostart is completely unregistered). |

> **Note:** Neither command deletes your code or your saved account history (`~/.local/state/agquota/state.json`).

---

### 2. Or Run Manually in Foreground

If you prefer to run it manually only when you want to view the dashboard:

```bash
python3 agquota.py
```
*(Press `Ctrl+C` to stop).*

---

## 🛠️ CLI Utilities

AgQuota includes built-in diagnostic and inspection tools:

```bash
# Print a plain-text terminal report of all accounts
python3 agquota.py list

# One-shot JSON dump of current quotas
python3 agquota.py once --json

# Run diagnostics on Antigravity language server processes & ports
python3 agquota.py doctor

# Run internal test suite
python3 agquota.py selftest

# Forget a saved account from the CLI
python3 agquota.py forget user@gmail.com
```

---

## 📁 Project Architecture

```
QUOTA/
├── agquota.py              # Server daemon, discovery, state & CLI management
├── index.html              # Main dashboard entrypoint
├── static/
│   ├── css/
│   │   └── style.css       # Dark theme, design tokens, CSS Grid table & animations
│   └── js/
│       ├── api.js          # REST client (/api/usage, /api/refresh, /api/usage/:email)
│       ├── app.js          # Main app coordinator, timer loops & event listeners
│       ├── components.js   # Hero card, row builder, context menu, modals & toast
│       └── state.js        # Health scoring, sorting algorithms & localStorage preferences
├── .gitignore
└── README.md
```

---

## 🔒 Security & Privacy

* **Strictly Localhost**: Binds strictly to `127.0.0.1`.
* **Zero Telemetry**: No third-party network requests, CDNs, external analytics, or remote tracking.
* **Standard CSP**: Enforces Content Security Policy (`default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src data: 'self'; connect-src 'self'`).
* **Safe Permissions**: Quota state cache (`~/.local/state/agquota/state.json`) is created with strict file permissions (`0600`).
