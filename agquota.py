#!/usr/bin/env python3
"""agquota v2 - local Antigravity quota monitor (Linux, stdlib only).
Usage: agquota.py serve|once|list|forget EMAIL|doctor|selftest"""
import argparse, json, logging, os, re, signal, ssl, subprocess, sys, tempfile, threading, time, unittest
import urllib.request
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

# ---- 1. Constants ----
log = logging.getLogger("agquota")
RPC = "/exa.language_server_pb.LanguageServerService/GetUserStatus"
POOL_NAMES = {"gemini": "Gemini", "claude_gpt": "Claude and GPT", "other": "Other models"}
MISSING_FRACTION_IS_ZERO = False  # set True for v1 behaviour

def state_path():
    if os.environ.get("AGQUOTA_STATE"): return os.environ["AGQUOTA_STATE"]
    base = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    return os.path.join(base, "agquota", "state.json")

# ---- 2. Time ----
def parse_ts(s):
    """Tolerant ISO-8601 parser (Z, offsets, any fraction length). None on garbage."""
    if not isinstance(s, str): return None
    m = re.match(r"^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(?:\.(\d+))?\s*(Z|[+-]\d\d:?\d\d)?$", s.strip())
    if not m: return None
    d, t, frac, tz = m.groups()
    try:
        dt = datetime.strptime(f"{d}T{t}.{(frac or '0')[:6].ljust(6, '0')}", "%Y-%m-%dT%H:%M:%S.%f")
        if tz and tz != "Z":
            g = tz[1:].replace(":", "")
            dt -= (1 if tz[0] == "+" else -1) * timedelta(hours=int(g[:2]), minutes=int(g[2:]))
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc)

def iso(dt): return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def utcnow(): return datetime.now(timezone.utc)

# ---- 3. Discovery (Linux) ----
class Unreachable(Exception): pass

def _listen_ports(pid):
    inodes = set()
    try:
        for fd in os.listdir(f"/proc/{pid}/fd"):
            try:
                l = os.readlink(f"/proc/{pid}/fd/{fd}")
                if l.startswith("socket:["): inodes.add(l[8:-1])
            except OSError: pass
    except OSError: return []
    ports = set()
    for f in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(f) as fh:
                next(fh, None)
                for line in fh:
                    p = line.split()
                    if len(p) > 9 and p[3] == "0A" and p[9] in inodes:
                        ports.add(int(p[1].rsplit(":", 1)[1], 16))
        except OSError: pass
    return sorted(ports)

def _token(args):
    for i, a in enumerate(args):
        if a == "--csrf_token" and i + 1 < len(args): return args[i + 1]
        if a.startswith("--csrf_token="): return a.split("=", 1)[1]
    return None

def _hub_daemon_dir():
    """Directory where the VS Code extension writes hub_<PORT>.json files."""
    base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    # VS Code extension uses ~/.gemini/antigravity/daemon/
    for candidate in (
        os.path.join(os.path.expanduser("~"), ".gemini", "antigravity", "daemon"),
        os.path.join(base, "antigravity", "daemon"),
    ):
        if os.path.isdir(candidate):
            return candidate
    return None

def _vscode_candidates():
    """Read hub_<PORT>.json files written by the VS Code extension.
    Automatically removes stale files whose process is no longer alive.
    Sorted by file mtime descending (most recently active session first).
    """
    out = []
    d = _hub_daemon_dir()
    if not d:
        return out
    entries = []
    for name in os.listdir(d):
        if not (name.startswith("hub_") and name.endswith(".json")):
            continue
        fpath = os.path.join(d, name)
        try:
            mtime = os.path.getmtime(fpath)
            with open(fpath) as fh:
                info = json.load(fh)
            pid = int(info.get("pid", 0))
            token = info.get("csrfToken") or info.get("csrf_token")
            ports = []
            if info.get("httpPort"): ports.append(int(info["httpPort"]))
            if info.get("httpsPort"): ports.append(int(info["httpsPort"]))
            if not (pid and token and ports):
                continue
            # Verify the pid is still alive; remove stale JSON if not
            try:
                os.kill(pid, 0)
            except OSError:
                try: os.unlink(fpath)
                except OSError: pass
                log.debug("removed stale hub file %s (pid %s dead)", name, pid)
                continue
            entries.append((mtime, (pid, token, ports)))
        except Exception as e:
            log.debug("skipping hub file %s: %s", name, e)
    entries.sort(key=lambda x: x[0], reverse=True)
    return [e[1] for e in entries]

def find_candidates():
    """-> [(pid, csrf_token_or_None, [ports])]"""
    seen_pids = set()
    out = []
    # 1. VS Code extension: read hub JSON files (most reliable)
    for entry in _vscode_candidates():
        seen_pids.add(entry[0])
        out.append(entry)
    # 2. Desktop app / other: scan /proc for language_server binary
    for d in os.listdir("/proc"):
        if not d.isdigit() or int(d) == os.getpid(): continue
        pid = int(d)
        if pid in seen_pids: continue
        try:
            with open(f"/proc/{d}/cmdline", "rb") as fh:
                args = fh.read().decode("utf-8", "replace").split("\0")
        except OSError: continue
        if not args: continue
        base = os.path.basename(args[0]).lower()
        full = " ".join(args).lower()
        if "language_server" not in base: continue
        if "antigravity" not in full: continue
        out.append((pid, _token(args), _listen_ports(pid)))
    return out

# ---- 4. Helper client ----
def call_helper(port, scheme, token):
    url = f"{scheme}://127.0.0.1:{port}{RPC}"  # loopback only, by construction
    body = json.dumps({"metadata": {"ideName": "antigravity", "extensionName": "antigravity", "locale": "en"}}).encode()
    req = urllib.request.Request(url, body, {"Content-Type": "application/json", "Connect-Protocol-Version": "1",
                                             "X-Codeium-Csrf-Token": token})
    ctx = ssl._create_unverified_context() if scheme == "https" else None
    with urllib.request.urlopen(req, timeout=4, context=ctx) as r:
        return json.loads(r.read().decode())

# ---- 5. Parsing and quota logic (pure) ----
def pool_of(label, mid):
    s = f"{label} {mid}".lower()
    if "claude" in s or "gpt" in s: return "claude_gpt"
    return "gemini" if "gemini" in s else "other"

def parse_status(data):
    """GetUserStatus JSON -> account dict, or None if nobody is logged in."""
    us = (data or {}).get("userStatus") or data or {}
    email = us.get("email")
    if not isinstance(email, str) or "@" not in email: return None
    plan = (us.get("planStatus") or {}).get("planInfo") or {}
    cfgs = (us.get("cascadeModelConfigData") or {}).get("clientModelConfigs") or []
    pools = {}
    for c in cfgs:
        if not isinstance(c, dict) or c.get("disabled"): continue
        label, mid = str(c.get("label") or ""), str((c.get("modelOrAlias") or {}).get("model") or "")
        q = c.get("quotaInfo") or {}
        reset = parse_ts(q.get("resetTime"))
        try: frac = None if q.get("remainingFraction") is None else min(1.0, max(0.0, float(q["remainingFraction"])))
        except (TypeError, ValueError): frac = None
        if frac is None and reset is None and "quotaInfo" not in c: continue
        if frac is None and reset is not None and MISSING_FRACTION_IS_ZERO: frac = 0.0
        p = pools.setdefault(pool_of(label, mid), {"remaining": None, "reset_at": None, "models": []})
        p["models"].append(label or mid)
        if frac is None:
            if p["remaining"] is None and reset and not p["reset_at"]: p["reset_at"] = iso(reset)
        elif p["remaining"] is None or frac < p["remaining"]:
            p["remaining"], p["reset_at"] = frac, (iso(reset) if reset else None)
    pfp = str(us.get("profilePictureUrl") or "")
    return {"email": email, "name": str(us.get("name") or ""), "plan": str(plan.get("planName") or ""),
            "tier": str(plan.get("teamsTier") or ""), "profile_picture_url": pfp, "pools": pools}

def pool_state(p, live, now):
    r = p.get("remaining")
    if r is None: return "unknown"
    if live: return "available" if r > 0 else "empty"
    ra = parse_ts(p.get("reset_at"))
    if ra and now >= ra: return "reset"
    return "available" if r > 0 else "empty"

def account_state(states):
    for s in ("available", "reset", "empty"):
        if s in states: return s
    return "unknown"

def view_account(a, live, now):
    pools, states = {}, []
    for k, p in a.get("pools", {}).items():
        st = pool_state(p, live, now); states.append(st)
        ra = parse_ts(p.get("reset_at")); r = p.get("remaining")
        pct = None if r is None else int(round(r * 100))
        pools[k] = {"label": POOL_NAMES.get(k, k), "state": st, "reset_at": p.get("reset_at"),
                    "seconds_left": max(0, int((ra - now).total_seconds())) if ra else None,
                    "remaining_percent": None if st in ("reset", "unknown") else pct,
                    "used_percent": None if st in ("reset", "unknown") or pct is None else 100 - pct,
                    "last_seen_remaining_percent": pct if st == "reset" else None, "models": p.get("models", [])}
    return {"email": a["email"], "name": a.get("name", ""), "plan": a.get("plan", ""), "status": "live" if live else "saved",
            "state": account_state(states), "first_seen": a.get("first_seen"), "last_seen": a.get("last_seen"),
            "profile_picture_url": a.get("profile_picture_url", ""), "pools": pools}

# ---- 6. Store ----
class Store:
    def __init__(s, path):
        s.path, s.lock, s.accounts, s.live, s.saved_at = path, threading.Lock(), {}, None, 0
        s.status = {"state": "starting", "note": "", "last_ok_at": None, "last_error": None, "last_run": 0}
        s.load()

    def load(s):
        try:
            with open(s.path) as fh: d = json.load(fh)
            accs = d["accounts"]; assert isinstance(accs, dict)
            for e, a in accs.items():  # v1 files lack "version"; keep what is usable
                if isinstance(a, dict): a.setdefault("email", e); a.setdefault("pools", {}); s.accounts[e] = a
        except FileNotFoundError: pass
        except Exception as e:
            bad = f"{s.path}.corrupt-{int(time.time())}"
            try: os.replace(s.path, bad)
            except OSError: pass
            log.warning("state file unreadable (%s); moved to %s", e, bad)

    def save(s):
        d = os.path.dirname(s.path); os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".state-")
        try:
            with os.fdopen(fd, "w") as fh: json.dump({"version": 2, "accounts": s.accounts}, fh, indent=1)
            os.chmod(tmp, 0o600); os.replace(tmp, s.path); s.saved_at = time.time()
        except Exception:
            try: os.unlink(tmp)
            except OSError: pass
            raise

    def apply(s, state, note, acc):
        now = utcnow()
        with s.lock:
            if state != s.status["state"]: log.info("collector: %s %s", state, note)
            st = s.status; st.update(state=state, note=note, last_run=time.time())
            if state in ("unreachable", "error"): st["last_error"] = note
            if state == "ok": st["last_ok_at"] = iso(now)
            new_live = acc["email"] if acc else None
            if new_live != s.live and new_live: log.info("active account: %s", new_live)
            s.live = new_live
            if not acc: return
            old = s.accounts.get(acc["email"])
            pfp = acc.get("profile_picture_url") or (old or {}).get("profile_picture_url", "")
            rec = dict(acc, first_seen=(old or {}).get("first_seen") or iso(now), last_seen=iso(now), profile_picture_url=pfp)
            changed = old is None or old.get("pools") != rec["pools"] or old.get("plan") != rec["plan"] or old.get("profile_picture_url") != pfp
            s.accounts[acc["email"]] = rec
            if changed or time.time() - s.saved_at > 300: s.save()

    def forget(s, email):
        with s.lock:
            if email not in s.accounts: return False
            del s.accounts[email]; s.save(); return True

    def view(s):
        now = utcnow()
        with s.lock:
            accs = [view_account(a, a["email"] == s.live, now) for a in s.accounts.values()]
            col = {k: s.status[k] for k in ("state", "note", "last_ok_at", "last_error")}
            alive = time.time() - s.status["last_run"] < 600
        rank = {"available": 1, "reset": 2, "empty": 3, "unknown": 4}
        accs.sort(key=lambda a: (a["status"] != "live", rank[a["state"]], a["email"]))
        return {"generated_at": iso(now), "collector": col, "accounts": accs, "_alive": alive}

# ---- 7. Collector ----
class Collector(threading.Thread):
    def __init__(s, store, poll):
        super().__init__(daemon=True); s.store, s.poll, s.conn, s.stop_ev = store, poll, None, threading.Event()

    def _fetch(s, c):
        acc = parse_status(call_helper(*c))
        return ("ok", "", acc) if acc else ("not_logged_in", "Antigravity is running but nobody is logged in", None)

    def collect_once(s):
        cands = find_candidates()
        if not cands: return "antigravity_not_running", "Antigravity helper process not found", None
        primary_res = None
        for pid, tok, ports in cands:
            for port in (ports if tok else []):
                for scheme in ("http", "https"):
                    try:
                        st, note, acc = s._fetch((port, scheme, tok))
                        if st == "ok" and acc:
                            if primary_res is None:
                                primary_res = (st, note, acc)
                                s.conn = (port, scheme, tok)
                            else:
                                # Update other active sessions too so all logged-in accounts have fresh quota
                                s.store.apply("ok", "", acc)
                        elif primary_res is None:
                            primary_res = (st, note, acc)
                        break
                    except Exception as e:
                        log.debug("port %s %s: %s", port, scheme, e)
        if primary_res:
            return primary_res
        return "unreachable", "Antigravity is running but no port answered", None

    def collect_once_and_apply(s):
        st, note, acc = s.collect_once()
        s.store.apply(st, note, acc)
        return st, note, acc

    def run(s):
        delay = s.poll
        while not s.stop_ev.is_set():
            try:
                st, note, acc = s.collect_once_and_apply()
                delay = s.poll if st in ("ok", "not_logged_in") else min(max(delay * 2, s.poll), 300)
            except Exception as e:
                log.exception("collector crashed"); s.store.apply("error", str(e), None); delay = min(delay * 2, 300)
            s.stop_ev.wait(delay)

# ---- 8. HTTP ----
def text_report(v, show="remaining"):
    lines = [f"collector: {v['collector']['state']} {v['collector']['note']}".strip()]
    for a in v["accounts"]:
        lines.append(f"{a['email']} [{a['status']}, {a['plan'] or 'plan ?'}] {a['state']}")
        for p in a["pools"].values():
            n = p["used_percent"] if show == "used" else p["remaining_percent"]
            val = "no data" if n is None and p["state"] != "reset" else ("quota has reset" if p["state"] == "reset" else f"{n}% {show}")
            lines.append(f"  {p['label']}: {val}" + (f", resets in {p['seconds_left']}s" if p["seconds_left"] else ""))
    return "\n".join(lines) + "\n"

def make_handler(store, port, extra_hosts=(), collector=None):
    allowed = {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}", *extra_hosts}
    class H(BaseHTTPRequestHandler):
        server_version = "agquota"
        def log_message(s, *a): log.debug("http " + a[0], *a[1:])
        def _send(s, code, body, ctype="application/json", csp=False):
            if not isinstance(body, (bytes, str)): body = json.dumps(body)
            b = body.encode() if isinstance(body, str) else body
            s.send_response(code)
            for k, v in (("Content-Type", ctype + "; charset=utf-8"), ("Content-Length", str(len(b))),
                         ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff")): s.send_header(k, v)
            if csp: s.send_header("Content-Security-Policy", "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src data: 'self'; font-src 'self'; connect-src 'self'")
            s.end_headers(); s.wfile.write(b)
        def _err(s, code, msg): s._send(code, {"error": msg, "code": code})
        def _route(s, method):
            try:
                if s.headers.get("Host", "") not in allowed: return s._err(403, "host not allowed")
                u = urlparse(s.path); path = u.path.rstrip("/") or "/"; q = parse_qs(u.query)
                if method == "DELETE":
                    m = re.fullmatch(r"/api/usage/(.+)", path)
                    if not m: return s._err(404, "not found")
                    if s.headers.get("X-Agquota") != "1": return s._err(403, "missing X-Agquota header")
                    return s._send(200, {"forgotten": True}) if store.forget(unquote(m.group(1))) else s._err(404, "unknown account")
                if method not in ("GET", "POST"): return s._err(405, "method not allowed")
                if path.startswith("/static/"):
                    rel = path[len("/static/"):].lstrip("/")
                    safe_path = os.path.abspath(os.path.join(HERE, "static", rel))
                    if not safe_path.startswith(os.path.abspath(os.path.join(HERE, "static"))):
                        return s._err(403, "forbidden")
                    if not os.path.isfile(safe_path):
                        return s._err(404, "not found")
                    mime = "application/octet-stream"
                    if safe_path.endswith(".css"): mime = "text/css"
                    elif safe_path.endswith(".js"): mime = "application/javascript"
                    elif safe_path.endswith(".svg"): mime = "image/svg+xml"
                    elif safe_path.endswith(".json"): mime = "application/json"
                    elif safe_path.endswith(".woff2"): mime = "font/woff2"
                    with open(safe_path, "rb") as fh:
                        return s._send(200, fh.read(), mime)
                if path.startswith("/fonts/"):
                    f = find_font()
                    if not f: return s._err(404, "font not installed")
                    with open(f, "rb") as fh: return s._send(200, fh.read(), "font/woff2")
                if path in ("/api/refresh", "/api/reload"):
                    if collector:
                        try: collector.collect_once_and_apply()
                        except Exception as e: log.error("manual refresh failed: %s", e)
                    v = store.view(); v.pop("_alive")
                    return s._send(200, v)
                v = store.view(); alive = v.pop("_alive")
                if path in ("/", "/index.html", "/dashboard", "/dashboard3", "/view"): return s._send(200, load_dashboard(), "text/html", csp=True)
                if path == "/health": return s._send(200, {"ok": True, "collector_alive": alive})
                if path == "/api/usage":
                    if q.get("format") == ["text"]: return s._send(200, text_report(v, (q.get("show") or ["remaining"])[0]), "text/plain")
                    return s._send(200, v)
                if path == "/api/active":
                    a = next((a for a in v["accounts"] if a["status"] == "live"), None)
                    return s._send(200, a) if a else s._send(404, {"error": v["collector"]["note"] or "no live account", "code": 404})
                m = re.fullmatch(r"/api/usage/(.+)", path)
                if m:
                    a = next((a for a in v["accounts"] if a["email"] == unquote(m.group(1))), None)
                    return s._send(200, a) if a else s._err(404, "unknown account")
                s._err(404, "not found")
            except Exception:
                log.exception("handler failed")
                try: s._err(500, "internal error")
                except Exception: pass
        def do_GET(s): s._route("GET")
        def do_DELETE(s): s._route("DELETE")
        def do_POST(s): s._route("POST")
        do_PUT = do_OPTIONS = do_PATCH = do_POST
    return H

# ---- 9. Dashboard (separate dashboard.html next to this file) ----
HERE = os.path.dirname(os.path.abspath(__file__))

def load_dashboard():
    try:
        with open(os.path.join(HERE, "dashboard.html"), encoding="utf-8") as fh: return fh.read()
    except OSError:
        return "<h1>dashboard.html not found</h1><p>Put dashboard.html in the same folder as agquota.py.</p>"

def load_quota_view():
    try:
        with open(os.path.join(HERE, "quota-view.html"), encoding="utf-8") as fh: return fh.read()
    except OSError:
        return "<h1>quota-view.html not found</h1><p>Put quota-view.html in the same folder as agquota.py.</p>"

def load_dashboard():
    for name in ("index.html", "dashboard.html", "dashboard3.html"):
        p = os.path.join(HERE, name)
        if os.path.exists(p):
            with open(p, encoding="utf-8") as fh: return fh.read()
    return "<h1>index.html not found</h1><p>Put index.html in the same folder as agquota.py.</p>"

def find_font():
    """Optional local Geist Mono: drop any *GeistMono*.woff2 next to this file. Nothing is fetched online."""
    for n in sorted(os.listdir(HERE)):
        l = n.lower().replace("-", "").replace("_", "").replace(" ", "")
        if l.endswith(".woff2") and "geist" in l and "mono" in l: return os.path.join(HERE, n)

# ---- 10. CLI ----
def env_int(name, default):
    v = os.environ.get(name)
    if v is None: return default
    try: return int(v)
    except ValueError: sys.exit(f"error: {name} must be an integer, got {v!r}")

def cmd_serve(a, store):
    col = Collector(store, a.poll); col.start()
    host = a.host
    extra = set()
    if host not in ("127.0.0.1", "localhost", "::1"):
        if not a.i_know_this_is_exposed: sys.exit("error: non-loopback --host needs --i-know-this-is-exposed")
        log.warning("WARNING: dashboard exposed on %s; anyone who can reach it can read your quota", host)
        extra = {f"{host}:{a.port}"}
    try: srv = ThreadingHTTPServer((host, a.port), make_handler(store, a.port, extra, collector=col))
    except OSError as e: sys.exit(f"error: cannot bind {host}:{a.port} ({e}). Another agquota may already be running; try --port.")
    def stop(*_): threading.Thread(target=srv.shutdown, daemon=True).start()
    signal.signal(signal.SIGINT, stop); signal.signal(signal.SIGTERM, stop)
    print(f"agquota on http://{host}:{a.port}/  (Ctrl+C to stop)")
    srv.serve_forever(); col.stop_ev.set()
    with store.lock:
        try: store.save()
        except Exception as e: log.error("final save failed: %s", e)

def cmd_once(a, store):
    st, note, acc = Collector(store, 30).collect_once(); store.apply(st, note, acc)
    v = store.view(); v.pop("_alive")
    print(json.dumps(v, indent=1) if a.json else text_report(v, a.show), end="")
    return 0 if st == "ok" else 1

def cmd_doctor():
    ok = lambda b: "PASS" if b else "FAIL"
    c = find_candidates(); print(f"[{ok(c)}] Antigravity process: {len(c)} found")
    for pid, tok, ports in c:
        print(f"[{ok(tok)}] pid {pid}: csrf token present: {bool(tok)}")
        print(f"[{ok(ports)}] pid {pid}: listening ports: {ports}")
        for port in ports if tok else []:
            answered = False
            for sch in ("http", "https"):
                try:
                    acc = parse_status(call_helper(port, sch, tok))
                    print(f"[PASS] {sch}://127.0.0.1:{port} answered; logged in: {bool(acc)}")
                    answered = True
                    break  # found working scheme, no need to try the other
                except Exception as e:
                    log.debug("%s://127.0.0.1:%s: %s", sch, port, e)
            if not answered:
                print(f"[FAIL] port {port}: neither http nor https answered")
    html_found = any(os.path.exists(os.path.join(HERE, f)) for f in ("index.html", "dashboard3.html"))
    print(f"[{ok(html_found)}] index.html next to agquota.py")
    print(f"[{'PASS' if find_font() else 'INFO'}] local Geist Mono woff2 font: {find_font() or 'not found, using system monospace'}")
    print(f"state file: {state_path()}")

def selftest():
    class T(unittest.TestCase):
        def test_ts(s):
            for x in ("2026-11-09T10:00:00Z", "2026-11-09T10:00:00.123456789Z", "2026-11-09T15:30:00+05:30"):
                s.assertIsNotNone(parse_ts(x))
            s.assertEqual(iso(parse_ts("2026-11-09T15:30:00+05:30")), "2026-11-09T10:00:00Z")
            s.assertIsNone(parse_ts("garbage")); s.assertIsNone(parse_ts(None))
        def test_parse(s):
            def cfg(l, f, off=False, r="2026-11-09T15:00:00Z"):
                return {"label": l, "disabled": off, "modelOrAlias": {"model": l}, "quotaInfo": {"remainingFraction": f, "resetTime": r}}
            d = {"userStatus": {"email": "a@b.c", "cascadeModelConfigData": {"clientModelConfigs": [
                cfg("Gemini 3 Pro", 0.6), cfg("Gemini Flash", 0.2), cfg("Claude Sonnet", 5), cfg("GPT-OSS", 0.3),
                cfg("Gemini Off", 0.0, True), cfg("Mystery", 0.5), cfg("Gemini X", None)]}}}
            a = parse_status(d)
            s.assertEqual(a["pools"]["gemini"]["remaining"], 0.2); s.assertEqual(a["pools"]["claude_gpt"]["remaining"], 0.3)
            s.assertIn("other", a["pools"]); s.assertIsNone(parse_status({"userStatus": {}}))
            s.assertEqual(parse_status({"userStatus": {"email": "a@b.c", "cascadeModelConfigData": {"clientModelConfigs": [cfg("Gemini", None)]}}})["pools"]["gemini"]["remaining"], None)
        def test_state(s):
            now = parse_ts("2026-11-09T12:00:00Z"); p = {"remaining": 0.5, "reset_at": "2026-11-09T11:00:00Z"}
            s.assertEqual(pool_state(p, False, now), "reset"); s.assertEqual(pool_state(p, True, now), "available")
            s.assertEqual(pool_state(dict(p, reset_at="2026-11-09T12:00:00Z"), False, now), "reset")
            s.assertEqual(pool_state(dict(p, remaining=0, reset_at="2026-11-09T13:00:00Z"), False, now), "empty")
            s.assertEqual(pool_state({"remaining": None}, False, now), "unknown")
            s.assertEqual(account_state(["empty", "reset"]), "reset")
        def test_store(s):
            with tempfile.TemporaryDirectory() as d:
                path = os.path.join(d, "s.json"); st = Store(path)
                st.apply("ok", "", {"email": "a@b.c", "name": "", "plan": "Pro", "tier": "", "pools": {}})
                s.assertIn("a@b.c", Store(path).accounts); s.assertEqual(oct(os.stat(path).st_mode & 0o777), "0o600")
                open(path, "w").write("{bad"); Store(path)
                s.assertTrue(any(".corrupt-" in f for f in os.listdir(d)))
    r = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromTestCase(T))
    return 0 if r.wasSuccessful() else 1

def cmd_install_service():
    user_systemd = os.path.expanduser("~/.config/systemd/user")
    os.makedirs(user_systemd, exist_ok=True)
    svc_path = os.path.join(user_systemd, "agquota.service")
    py = sys.executable or "/usr/bin/python3"
    script = os.path.abspath(__file__)
    content = f"""[Unit]
Description=AgQuota Local Antigravity Monitor
After=network.target

[Service]
Type=simple
ExecStart={py} {script} serve
WorkingDirectory={HERE}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
"""
    with open(svc_path, "w", encoding="utf-8") as f:
        f.write(content)
    try:
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
        subprocess.run(["systemctl", "--user", "enable", "--now", "agquota"], check=True)
        print("✓ AgQuota background service successfully installed and started!")
        print("  • Dashboard: http://127.0.0.1:8765/")
        print("  • Status:    systemctl --user status agquota")
        print("  • Logs:      journalctl --user -u agquota -f")
        print("  • Stop:      systemctl --user stop agquota")
        print("  • Uninstall: python3 agquota.py uninstall")
        return 0
    except Exception as e:
        print(f"Service file written to {svc_path}, but systemctl failed: {e}")
        print("You can activate it manually with:")
        print("  systemctl --user daemon-reload && systemctl --user enable --now agquota")
        return 1

def cmd_stop_service():
    try:
        subprocess.run(["systemctl", "--user", "stop", "agquota"], stderr=subprocess.DEVNULL)
    except Exception: pass
    try:
        subprocess.run(["fuser", "-k", f"{env_int('AGQUOTA_PORT', 8765)}/tcp"], stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    except Exception: pass
    print("✓ AgQuota background server stopped.")
    print("  • To start again:  ./setup-service.sh (or: systemctl --user start agquota)")
    print("  • To run manually: ./run.sh")
    return 0

def cmd_restart_service():
    try:
        subprocess.run(["systemctl", "--user", "restart", "agquota"], check=True)
        print("✓ AgQuota background service restarted.")
        print("  • Status: systemctl --user status agquota")
        return 0
    except Exception as e:
        print(f"Failed to restart service via systemctl: {e}")
        return 1

def cmd_status_service():
    try:
        subprocess.run(["systemctl", "--user", "status", "agquota", "--no-pager"])
        return 0
    except Exception as e:
        print(f"Failed to query systemctl: {e}")
        return 1

def cmd_uninstall_service():
    svc_path = os.path.expanduser("~/.config/systemd/user/agquota.service")
    try:
        subprocess.run(["systemctl", "--user", "stop", "agquota"], stderr=subprocess.DEVNULL)
        subprocess.run(["systemctl", "--user", "disable", "agquota"], stderr=subprocess.DEVNULL)
        if os.path.exists(svc_path): os.unlink(svc_path)
        subprocess.run(["systemctl", "--user", "daemon-reload"], stderr=subprocess.DEVNULL)
        print("✓ AgQuota background service stopped and removed.")
        return 0
    except Exception as e:
        print(f"Error uninstalling service: {e}")
        return 1

def main():
    if len(sys.argv) == 1:
        sys.argv.append("serve")
    ap = argparse.ArgumentParser(prog="agquota", description="AgQuota — Antigravity AI Quota Monitor")
    ap.add_argument("-v", "--verbose", action="store_true")
    sp = ap.add_subparsers(dest="cmd")
    s = sp.add_parser("serve", help="Run local web server dashboard")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=env_int("AGQUOTA_PORT", 8765))
    s.add_argument("--poll", type=int, default=env_int("AGQUOTA_POLL_SECONDS", 30))
    s.add_argument("--i-know-this-is-exposed", action="store_true")
    o = sp.add_parser("once", help="Print quota snapshot once")
    o.add_argument("--show", choices=["remaining", "used"], default="remaining")
    o.add_argument("--json", action="store_true")
    sp.add_parser("list", help="List accounts in terminal")
    f = sp.add_parser("forget", help="Remove an account from monitoring")
    f.add_argument("email")
    sp.add_parser("doctor", help="Run diagnostics")
    sp.add_parser("selftest", help="Run internal tests")
    sp.add_parser("install", help="Install & start systemd background user service")
    sp.add_parser("setup", help="Alias for install")
    sp.add_parser("stop", help="Stop the background server")
    sp.add_parser("restart", help="Restart the background server")
    sp.add_parser("status", help="Check background server status")
    sp.add_parser("uninstall", help="Stop and remove systemd background user service")
    a = ap.parse_args()
    if not a.cmd: a.cmd = "serve"
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if a.cmd in ("install", "setup"): return cmd_install_service()
    if a.cmd == "stop": return cmd_stop_service()
    if a.cmd == "restart": return cmd_restart_service()
    if a.cmd == "status": return cmd_status_service()
    if a.cmd == "uninstall": return cmd_uninstall_service()
    if a.cmd == "doctor": return cmd_doctor()
    if a.cmd == "selftest": return selftest()
    if a.cmd == "serve" and getattr(a, "poll", 30) < 5: sys.exit("error: --poll must be at least 5 seconds")
    store = Store(state_path())
    if a.cmd == "serve": return cmd_serve(a, store)
    if a.cmd == "once": return cmd_once(a, store)
    if a.cmd == "list":
        v = store.view(); v.pop("_alive"); print(text_report(v), end="")
    if a.cmd == "forget": print("forgotten" if store.forget(a.email) else "no such account")

if __name__ == "__main__":
    sys.exit(main() or 0)
