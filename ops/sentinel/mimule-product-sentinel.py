#!/usr/bin/env python3
"""MIMULE Product Health Sentinel.

Probes the LIVE control-surface product the way a user would, on a timer, so the
team's definition of "done" includes a working running product — not just a
passing per-job diff. Catches the failure classes that rotted unnoticed:
  - dead/blank/wedged pages, broken APIs            (live page+API probes)
  - data that silently stopped flowing (e.g. audit) (freshness probes)
  - backends down (litellm/opencode/jobd)           (service probes)
  - "edited but never deployed" / stale bundle      (deploy-consistency probe)
  - regressions that came back (e.g. Paperclip)     (invariant probes)
  - server bloating toward a wedge                   (resource probe)

Output:
  - scorecard JSON  -> /var/lib/mimule/product-health.json (control surface can read)
  - per-FAIL deduped fix jobs enqueued via mimule-job (only when auto_fix_goal set)
  - summary to stdout / journal

Design guardrails (learned 2026-06-10): this probe is LIGHTWEIGHT (curl + sqlite +
mtime) and must NOT build on the serving box. Fixes are enqueued for the (capped)
team, never built inline here.

Source of truth (added 2026-07-05, SPEC 8 / ULTRAPLAN P2.2): this file, at
ops/sentinel/mimule-product-sentinel.py in the opencode-control-surface repo,
is the source of truth. The deployed copy that the 30-min timer actually runs
is /usr/local/bin/mimule-product-sentinel.py. Deploy = copy + chmod +x:
  cp ops/sentinel/mimule-product-sentinel.py /usr/local/bin/mimule-product-sentinel.py
  chmod +x /usr/local/bin/mimule-product-sentinel.py
No systemctl call is needed (or allowed) to pick up a new version — the timer
invokes the script fresh on its own next run.

Run `python3 mimule-product-sentinel.py --self-test` to exercise the deploy-
consistency check in isolation (throwaway git repo + dist fixture under
mktemp -d; pure stdlib, no network, no writes outside its tempdir, never
touches the real APP_DIR). See docs/PROVING_CASE_FLAPPER.md for the full
root-cause story behind the deploy-consistency signal below.
"""
import json, os, subprocess, sys, tempfile, shutil, time, urllib.request, urllib.error, http.cookiejar, glob

BASE = os.environ.get("CS_URL", "http://127.0.0.1:3000")
DB = "/var/lib/control-surface/dashboard.sqlite"
MODEL_HEALTH = "/var/lib/mimule/model-health.json"
APP_DIR = "/opt/opencode-control-surface"
STATE = "/var/lib/mimule/product-health.json"
JOBS_GLOB = "/var/lib/mimule/jobs/{queue,running}/*.json"
AGENT_STATE = "/var/lib/mimule/agent-liveness.json"
OPENCODE = "/root/.opencode/bin/opencode"
GEMINI = "/usr/bin/gemini"
CODEX = "/usr/bin/codex"
NOW = int(time.time())

def newest_mtime(globs):
    m = 0
    for g in globs:
        for f in glob.glob(g, recursive=True):
            try: m = max(m, os.path.getmtime(f))
            except OSError: pass
    return m

# ── 4. Deploy consistency — pure helpers (also exercised by --self-test) ─────
DEPLOY_GRACE_SECONDS = 15 * 60  # allow time for the deploy step itself to catch up

def _git_last_commit_epoch(app_dir):
    """Epoch seconds of the last commit touching app/, or None if git is
    unusable here (missing binary, not a repo, or no commit has ever touched
    app/) — callers must fall back to the old mtime comparison in that case."""
    try:
        result = subprocess.run(
            ["git", "-C", app_dir, "log", "-1", "--format=%ct", "--", "app/"],
            capture_output=True, text=True, timeout=10,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    value = result.stdout.strip()
    return int(value) if value else None

def evaluate_deploy_consistency(app_dir, now, build_running=False):
    """Deploy-consistency signal (SPEC 8 / ULTRAPLAN P2.2 fix, 2026-07-05).

    Old signal (any app/ source mtime newer than the built bundle) fired on
    every uncommitted WIP edit — this host's normal workflow is a builder
    agent editing app/ for 1-3 hours as uncommitted WIP, THEN the orchestrator
    verifies, commits, and only then builds+restarts. That produced 7 distinct
    "Frontend changes not deployed" incidents in ~10 days, each auto-resolved
    by the idle sweep and recreated within days (see
    docs/PROVING_CASE_FLAPPER.md for the full evidence trail). The check's
    INTENT is right — finished, committed changes must reach production — the
    signal was wrong for how this host works.

    New signal: committed-but-not-deployed. The last commit touching app/ is
    newer than the deployed bundle by more than DEPLOY_GRACE_SECONDS (allows
    the deploy step itself to catch up) AND no build is running -> fail, same
    severity/fix_goal as before. Fresh uncommitted WIP (mtime newer than both
    the last commit and the bundle) is the expected working state on this
    host and produces NO finding; it only earns a warn if it goes stale
    (>24h, suggesting abandoned work). If git is unusable here (not a repo,
    no commit has ever touched app/, or the binary is missing) this falls
    back to the old raw-mtime comparison so a broken checkout doesn't
    silently disable the check.

    Returns a list of finding dicts shaped for add(): {id, name, status,
    detail, severity, fix_goal}. Pure w.r.t. app_dir/now/build_running so
    --self-test can exercise it against a throwaway fixture instead of the
    real APP_DIR.
    """
    out = []
    src_m = newest_mtime([f"{app_dir}/app/**/*.tsx", f"{app_dir}/app/**/*.ts", f"{app_dir}/app/**/*.css"])
    dist_m = newest_mtime([f"{app_dir}/dist/assets/*.js"])
    commit_m = _git_last_commit_epoch(app_dir)

    def _report(signal_label, delta_seconds, fallback_note=""):
        delta_min = delta_seconds / 60
        if build_running:
            out.append({
                "id": "undeployed", "name": "Build in progress (changes not yet deployed)",
                "status": "warn", "severity": "warn",
                "detail": f"{signal_label} is {delta_min:.0f} min newer than the bundle; a team build is running{fallback_note}",
                "fix_goal": None,
            })
        else:
            out.append({
                "id": "undeployed", "name": "Frontend changes not deployed", "status": "fail",
                "severity": "high",
                "detail": f"{signal_label} is {delta_min:.0f} min newer than the built bundle (no build running){fallback_note}",
                "fix_goal": f"In {app_dir}, frontend changes are newer than the deployed dist bundle and no build is running — a job edited but never deployed. Run bun run check, bun run build, restart control-surface, verify the live site reflects the changes.",
            })

    if commit_m is None:
        # git unusable here (not a repo / no commits touching app/ / git
        # missing) — fall back to the old raw-mtime comparison rather than
        # silently disabling the check.
        if src_m and dist_m and src_m > dist_m + 5:
            _report("newest app/ source", src_m - dist_m, " (git fallback: no repo/commits touching app/)")
        return out

    if dist_m and commit_m > dist_m + DEPLOY_GRACE_SECONDS:
        _report("last commit touching app/", commit_m - dist_m)

    # Uncommitted WIP: source newer than both the last commit and the bundle —
    # this host's normal working state. Only worth a nudge once it goes stale.
    if src_m and src_m > commit_m and (not dist_m or src_m > dist_m):
        wip_age_h = (now - src_m) / 3600
        if wip_age_h > 24:
            out.append({
                "id": "wip-stale", "name": "Uncommitted frontend WIP is stale", "status": "warn",
                "severity": "warn",
                "detail": f"newest uncommitted app/ source is {wip_age_h:.1f}h old and still not committed — abandoned work?",
                "fix_goal": None,
            })
    return out

# ── --self-test: throwaway git repo + dist fixture under mktemp -d ──────────
# Pure stdlib, no network, no writes outside its own tempdir, never touches
# the real APP_DIR. Exits (via sys.exit) before any of the live-probe code
# below (network/DB/systemctl) runs.

def _selftest_git(tmp, *args, env_extra=None):
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    return subprocess.run(["git", "-C", tmp, *args], capture_output=True, text=True, env=env, timeout=10)

def _selftest_fixture(tmp):
    os.makedirs(os.path.join(tmp, "app"), exist_ok=True)
    os.makedirs(os.path.join(tmp, "dist", "assets"), exist_ok=True)
    _selftest_git(tmp, "init", "-q")
    _selftest_git(tmp, "config", "user.email", "selftest@example.invalid")
    _selftest_git(tmp, "config", "user.name", "Sentinel Selftest")

def _selftest_commit(tmp, rel_path, content, epoch):
    path = os.path.join(tmp, rel_path)
    with open(path, "w") as fh:
        fh.write(content)
    os.utime(path, (epoch, epoch))
    date_str = f"{int(epoch)} +0000"
    _selftest_git(tmp, "add", rel_path)
    return _selftest_git(tmp, "commit", "-q", "-m", f"selftest: {rel_path}",
                         env_extra={"GIT_AUTHOR_DATE": date_str, "GIT_COMMITTER_DATE": date_str})

def _selftest_write_dist(tmp, epoch):
    path = os.path.join(tmp, "dist", "assets", "bundle.js")
    with open(path, "w") as fh:
        fh.write("console.log('selftest bundle');")
    os.utime(path, (epoch, epoch))

def _selftest_touch_uncommitted(tmp, rel_path, epoch):
    path = os.path.join(tmp, rel_path)
    with open(path, "w") as fh:
        fh.write("// uncommitted WIP\n")
    os.utime(path, (epoch, epoch))

def run_self_test():
    now = time.time()
    cases = []

    # Case 1 (required): fresh uncommitted WIP -> no finding at all.
    tmp = tempfile.mkdtemp(prefix="mimule-sentinel-selftest-")
    try:
        _selftest_fixture(tmp)
        base_epoch = now - 2 * 3600
        _selftest_commit(tmp, "app/base.tsx", "// base\n", base_epoch)
        _selftest_write_dist(tmp, base_epoch)
        _selftest_touch_uncommitted(tmp, "app/wip.tsx", now)
        findings = evaluate_deploy_consistency(tmp, now, build_running=False)
        cases.append(("fresh WIP -> no finding", len(findings) == 0, findings))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # Case 2 (required): committed but not deployed beyond the grace period -> fail.
    tmp = tempfile.mkdtemp(prefix="mimule-sentinel-selftest-")
    try:
        _selftest_fixture(tmp)
        commit_epoch = now - 3600  # 1h ago, well beyond the 15-min grace
        dist_epoch = commit_epoch - 4000
        _selftest_write_dist(tmp, dist_epoch)
        _selftest_commit(tmp, "app/changed.tsx", "// changed\n", commit_epoch)
        findings = evaluate_deploy_consistency(tmp, now, build_running=False)
        ok = any(f["status"] == "fail" and f["id"] == "undeployed" for f in findings) and \
            not any(f["id"] == "wip-stale" for f in findings)
        cases.append(("committed-not-deployed beyond grace -> fail", ok, findings))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # Case 3 (required): deployed after the commit -> no finding.
    tmp = tempfile.mkdtemp(prefix="mimule-sentinel-selftest-")
    try:
        _selftest_fixture(tmp)
        commit_epoch = now - 7200
        dist_epoch = now - 1800  # deployed after the commit
        _selftest_commit(tmp, "app/shipped.tsx", "// shipped\n", commit_epoch)
        _selftest_write_dist(tmp, dist_epoch)
        findings = evaluate_deploy_consistency(tmp, now, build_running=False)
        cases.append(("deployed after commit -> no finding", len(findings) == 0, findings))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # Case 4 (bonus): committed-not-deployed while a build IS running -> warn, not fail.
    tmp = tempfile.mkdtemp(prefix="mimule-sentinel-selftest-")
    try:
        _selftest_fixture(tmp)
        commit_epoch = now - 3600
        dist_epoch = commit_epoch - 4000
        _selftest_write_dist(tmp, dist_epoch)
        _selftest_commit(tmp, "app/changed.tsx", "// changed\n", commit_epoch)
        findings = evaluate_deploy_consistency(tmp, now, build_running=True)
        ok = any(f["status"] == "warn" and f["id"] == "undeployed" for f in findings) and \
            not any(f["status"] == "fail" for f in findings)
        cases.append(("build running -> informational warn only (bonus)", ok, findings))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # Case 5 (bonus): no git repo at all -> honest fallback to the old mtime compare.
    tmp = tempfile.mkdtemp(prefix="mimule-sentinel-selftest-")
    try:
        os.makedirs(os.path.join(tmp, "app"), exist_ok=True)
        os.makedirs(os.path.join(tmp, "dist", "assets"), exist_ok=True)
        _selftest_write_dist(tmp, now - 3600)
        _selftest_touch_uncommitted(tmp, "app/nogit.tsx", now)
        findings = evaluate_deploy_consistency(tmp, now, build_running=False)
        ok = any(f["status"] == "fail" and f["id"] == "undeployed" and "git fallback" in f["detail"] for f in findings)
        cases.append(("no git repo -> mtime fallback still fails (bonus)", ok, findings))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("[product-sentinel --self-test]")
    all_ok = True
    for label, ok, findings in cases:
        print(f"  {'PASS' if ok else 'FAIL'}  {label}")
        if not ok:
            print(f"          findings: {json.dumps(findings)}")
        all_ok = all_ok and ok
    sys.exit(0 if all_ok else 1)

if "--self-test" in sys.argv:
    run_self_test()

def operator_token():
    try:
        out = subprocess.run(["systemctl", "show", "control-surface.service",
                              "-p", "Environment", "--value"],
                             capture_output=True, text=True, timeout=10).stdout
        for tok in out.split():
            if tok.startswith("OPERATOR_TOKEN="):
                return tok.split("=", 1)[1]
    except Exception:
        pass
    return ""

def make_opener():
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    tok = operator_token()
    if tok:
        try:
            req = urllib.request.Request(f"{BASE}/api/auth/session",
                data=json.dumps({"token": tok}).encode(),
                headers={"Content-Type": "application/json"}, method="POST")
            op.open(req, timeout=8)
        except Exception:
            pass
    return op

OPENER = make_opener()

def http_get(path, timeout=8):
    t0 = time.time()
    try:
        r = OPENER.open(f"{BASE}{path}", timeout=timeout)
        body = r.read()
        return r.status, body, time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, b"", time.time() - t0
    except Exception as e:
        return 0, str(e).encode(), time.time() - t0

def sqlite_scalar(sql):
    try:
        out = subprocess.run(["sqlite3", DB, sql], capture_output=True, text=True, timeout=10)
        return out.stdout.strip()
    except Exception:
        return ""

findings = []
def add(cid, name, status, detail, severity="warn", fix_goal=None):
    findings.append({"id": cid, "name": name, "status": status, "severity": severity,
                     "detail": detail, "auto_fix_goal": fix_goal})

# ── 1. Live pages + APIs ──────────────────────────────────────────────────────
PAGES = ["/", "/api/version", "/api/home", "/api/insights", "/api/gateway",
         "/api/agent-team", "/api/governance/policies", "/api/builder/workflows",
         "/api/cost", "/api/doctor"]
def probe(p, tries=3):
    """Retry to avoid false 'broken' verdicts from transient slowness under build
    load. 401/403 = auth-gated (OK). A timeout (HTTP 0) after retries is treated as
    SLOW (warn, no auto-fix) — a code fix does not cure load. Only a persistent real
    non-200 (404/500) is a genuine breakage worth an auto-fix job."""
    code, body, dt = 0, b"", 0.0
    for i in range(tries):
        code, body, dt = http_get(p, timeout=12)
        if code in (200, 401, 403):
            return code, body, dt
        if i < tries - 1:
            time.sleep(2)
    return code, body, dt

build_running = bool(subprocess.run(["pgrep", "-f", "mimule-team"], capture_output=True).stdout.strip())
for p in PAGES:
    code, body, dt = probe(p)
    if code in (200, 401, 403):
        if dt > 4.0:
            add(f"slow{p}", f"Slow endpoint {p}", "warn",
                f"HTTP {code} but {dt:.1f}s" + (" (build load)" if build_running else ""), "warn")
        elif code == 200 and len(body) == 0 and p == "/":
            add("blank-root", "Root page blank", "fail",
                "GET / returned 200 with empty body", "critical",
                fix_goal=f"In {APP_DIR}, GET / serves an empty body — the SPA shell is not being served. Fix static/index serving, rebuild, restart, re-verify.")
    elif code == 0:
        # Timed out after retries → unresponsive/slow, almost always transient load.
        # WARN only — never auto-enqueue a code fix for a timeout.
        add(f"slow{p}", f"Endpoint {p} unresponsive", "warn",
            f"timed out x3" + (" during a build" if build_running else " — check if wedged"), "warn")
    else:
        add(f"page{p}", f"Live endpoint {p}", "fail",
            f"HTTP {code}", "critical",
            fix_goal=f"In {APP_DIR}, the live endpoint {p} persistently returns HTTP {code} instead of 200 (confirmed over 3 retries). Diagnose and fix so it returns 200 with valid data; rebuild, restart control-surface, re-verify it is live.")

# ── 1b. Asset integrity — the USER's view through the public edge ───────────
# A 200 on "/" is not enough: the HTML must reference assets that actually
# resolve THROUGH the CDN (stale shells / purged hashes render unstyled pages).
import re as _re
_PUBLIC = os.environ.get("CS_PUBLIC_URL", "https://control.techinsiderbytes.com")
def _pub_get(path, timeout=12):
    import urllib.request as _ur
    try:
        with _ur.urlopen(_PUBLIC + path, timeout=timeout) as _r:
            return _r.status, _r.read()
    except Exception:
        return 0, b""
try:
    _pub_code, _pub_body = _pub_get("/")
    if _pub_code == 200 and _pub_body:
        _html = _pub_body.decode("utf-8", "replace")
        _assets = _re.findall(r'(?:href|src)="(/assets/[^"]+)"', _html)[:6]
        if not _assets:
            add("asset-integrity", "No assets referenced in shell", "fail",
                "index.html references no /assets/* files — broken build output", "critical",
                fix_goal=None)
        for _a in _assets:
            _ac, _ab = _pub_get(_a)
            if _ac != 200 or len(_ab) < 100:
                add("asset-integrity", "Page asset broken for real users", "fail",
                    f"{_a} returns HTTP {_ac} ({len(_ab)}b) — the page renders UNSTYLED in browsers",
                    "critical", fix_goal=None)
                break
        # Cache headers: shell must not be browser-cacheable (stale-hash breakage)
        try:
            import urllib.request as _ur
            _req = _ur.Request(_PUBLIC + "/", method="HEAD")
            with _ur.urlopen(_req, timeout=10) as _r:
                _cc = (_r.headers.get("Cache-Control") or "").lower()
            if "no-cache" not in _cc:
                add("shell-cacheable", "HTML shell is browser-cacheable", "warn",
                    f"Cache-Control on / is '{_cc or 'absent'}' — browsers will hold stale shells after deploys", "warn")
        except Exception:
            pass
except Exception as _e:
    add("asset-integrity", "Asset integrity check errored", "warn", str(_e)[:120], "warn")

# ── 2. Data freshness ─────────────────────────────────────────────────────────
audit_ts = sqlite_scalar("SELECT IFNULL(MAX(ts),0) FROM action_audit;")
events_ts = sqlite_scalar("SELECT IFNULL(MAX(ts),0) FROM events;")
def age_h(ms):
    try: return (NOW - int(ms)/1000) / 3600
    except Exception: return 1e9
# events is the live activity stream — if IT is stale, the system stopped recording.
if age_h(events_ts) > 6:
    add("events-stale", "Activity (events) stale", "fail",
        f"events last write {age_h(events_ts):.1f}h ago", "critical",
        fix_goal=f"In {APP_DIR}, the events activity stream stopped recording (>6h). Diagnose the ingestion path and restore it; verify new rows appear.")
# The Audit view surfaces BOTH the operator-action log (action_audit, hash-chained,
# sparse) AND the live System Events feed. If events is fresh, the view DOES show
# activity — a quiet operator log is then expected (autonomous operation), not broken.
if age_h(audit_ts) > 72:
    if age_h(events_ts) <= 6:
        add("audit-operator-quiet", "Operator audit quiet (system events live)", "warn",
            f"action_audit last write {age_h(audit_ts):.0f}h ago, but the System Events feed is current ({age_h(events_ts):.1f}h) — the audit view shows live activity", "warn")
    else:
        add("audit-stale", "Audit view shows no recent activity", "fail",
            f"both action_audit ({age_h(audit_ts):.0f}h) and the events feed ({age_h(events_ts):.0f}h) are stale", "high",
            fix_goal=f"In {APP_DIR}, the Audit view shows no recent activity — both action_audit and the events feed are stale. Diagnose the activity/event ingestion path and restore it; verify the audit page shows recent activity.")
try:
    mh = json.load(open(MODEL_HEALTH))
    if age_h(mh.get("checkedAt", 0)) > 8:
        add("modelhealth-stale", "Model health stale", "warn",
            f"model-health.json checkedAt {age_h(mh.get('checkedAt',0)):.1f}h ago", "warn")
except Exception as e:
    add("modelhealth-missing", "Model health unreadable", "warn", str(e), "warn")

# ── 2b. Gateway model coverage (shows full roster, not just LiteLLM names?) ────
try:
    mh_models = json.load(open(MODEL_HEALTH)).get("models", [])
    avail = sum(1 for m in mh_models if m.get("available"))
    code, body, _ = http_get("/api/models")
    shown = 0
    if code == 200:
        try:
            dd = json.loads(body)
            # /api/models wraps the array as { data: { models: [...] } }
            ms = dd.get("models") if isinstance(dd, dict) else dd
            if ms is None and isinstance(dd, dict):
                inner = dd.get("data") or {}
                ms = inner.get("models") if isinstance(inner, dict) else None
            shown = len(ms) if isinstance(ms, list) else 0
        except Exception: pass
    if avail >= 10 and shown < avail * 0.5:
        add("gateway-coverage", "Gateway model coverage incomplete", "warn",
            f"gateway lists {shown} models but {avail}/{len(mh_models)} discovered models are available", "warn",
            fix_goal=f"In {APP_DIR}, the Gateway/models view surfaces only {shown} LiteLLM logical names while {avail} discovered models are available in model-health.json. Make the gateway view include the full discovered roster with per-model availability status (not just the LiteLLM-configured editorial models). Rebuild, restart, verify the gateway lists the broader set.")
except Exception:
    pass

# ── 3. Backend services ───────────────────────────────────────────────────────
for svc in ["control-surface.service", "litellm.service", "opencode-server.service"]:
    st = subprocess.run(["systemctl", "is-active", svc], capture_output=True, text=True).stdout.strip()
    if st != "active":
        add(f"svc-{svc}", f"Service {svc} down", "fail", f"is-active={st}", "critical")

# ── 4. Deploy consistency (committed-but-not-deployed / stale WIP) ────────────
# See evaluate_deploy_consistency() above for the full rationale (SPEC 8 /
# ULTRAPLAN P2.2, docs/PROVING_CASE_FLAPPER.md) — this replaced a raw
# any-mtime-drift signal that flapped on every uncommitted WIP edit.
for _f in evaluate_deploy_consistency(APP_DIR, NOW, build_running):
    add(_f["id"], _f["name"], _f["status"], _f["detail"], _f["severity"], _f["fix_goal"])

# ── 5. Invariants (regressions that should stay fixed) ────────────────────────
js = sorted(glob.glob(f"{APP_DIR}/dist/assets/*.js"))
bundle = ""
if js:
    try: bundle = open(js[-1], "r", errors="ignore").read()
    except Exception: pass
if '"/paperclip"' in bundle:
    add("paperclip-back", "Removed Paperclip page is back", "fail",
        "the /paperclip route is in the served bundle again", "high",
        fix_goal=f"In {APP_DIR}, the Paperclip page/route reappeared in the live bundle (a regression). Remove PaperclipPage, its route in app/App.tsx, the nav item in app/components/DashSidebar.tsx, and the navRegistry entry; rebuild, restart, verify it is gone.")

# ── 6. Resource (bloat toward a wedge) ────────────────────────────────────────
try:
    pid = subprocess.run(["systemctl", "show", "control-surface.service", "-p", "MainPID", "--value"],
                         capture_output=True, text=True).stdout.strip()
    if pid and pid != "0":
        rss_kb = int(open(f"/proc/{pid}/status").read().split("VmRSS:")[1].split()[0])
        if rss_kb > 1_200_000:
            add("rss-high", "Control surface memory high", "warn",
                f"RSS {rss_kb//1024}MB approaching cgroup cap — restart soon to avoid a wedge", "warn")
except Exception:
    pass

# ── 7. Agent liveness (quota-aware, 6h round-trip window) ────────────────────
# Binary + lightweight round-trip probes for the three agent runners.
# codex quota EXHAUSTED → binary check only, NEVER invoke with a real prompt.
# opencode/gemini → real round-trip at most once per 6h (state tracked in AGENT_STATE).
# All findings are warn-only (no fix_goal) so auto-fix never fires for quota/agent issues.

AGENTS = [
    ("opencode", OPENCODE),
    ("gemini", GEMINI),
    ("codex", CODEX),
]

def read_agent_state():
    try:
        return json.load(open(AGENT_STATE))
    except Exception:
        return {}

def write_agent_state(state):
    try:
        tmp = AGENT_STATE + ".tmp"
        json.dump(state, open(tmp, "w"), indent=2)
        os.replace(tmp, AGENT_STATE)
    except Exception:
        pass

agent_state = read_agent_state()
agent_card = {}

for name, path in AGENTS:
    # Binary check (every run)
    bin_ok = os.path.exists(path) and os.access(path, os.X_OK)
    if not bin_ok:
        add(f"agent-{name}-missing", f"Agent runner {name} missing", "warn",
            f"{path} not found", "warn")
        agent_card[name] = {"ok": False, "lastRoundTrip": None, "latencySec": None}
        continue

    # codex: binary only — NEVER round-trip (quota exhausted)
    if name == "codex":
        agent_card[name] = {"ok": True, "lastRoundTrip": None, "latencySec": None}
        continue

    last = agent_state.get(name, {})
    last_rt = last.get("lastRoundTrip", 0)
    elapsed = NOW - last_rt
    need_roundtrip = elapsed > 6 * 3600

    if not need_roundtrip:
        # Stale-failure carry-forward: re-emit warn if last round-trip failed
        if last.get("ok") is False:
            err = last.get("error", "unknown error")
            add(f"agent-{name}-roundtrip", f"Agent runner {name} not responding", "warn",
                f"round-trip failed: {err}", "warn")
        agent_card[name] = {
            "ok": last.get("ok", True),
            "lastRoundTrip": last.get("lastRoundTrip"),
            "latencySec": last.get("latencySec"),
        }
        continue

    # Round-trip probe
    ok = False
    latency = None
    error = ""
    try:
        t0 = time.time()
        if name == "opencode":
            res = subprocess.run([OPENCODE, "run", "--model", "opencode/nemotron-3-ultra-free",
                                   "--title", "__mimule_probe_v1__:product-sentinel-liveness",
                                   "Reply with exactly: OK"],
                                  timeout=90, capture_output=True, text=True)
        elif name == "gemini":
            res = subprocess.run([GEMINI, "-p", "Reply with exactly: OK"],
                                  timeout=90, capture_output=True, text=True)
        else:
            res = None  # should not reach (codex handled above)
        dt = time.time() - t0
        if res and res.returncode == 0 and "OK" in (res.stdout or ""):
            ok = True
            latency = round(dt, 1)
        else:
            err = (res.stderr or res.stdout or "no output") if res else "no result"
            error = err.strip()[-200:]
    except Exception as e:
        error = str(e)[-200:]

    agent_state[name] = {
        "lastRoundTrip": NOW,
        "ok": ok,
        "latencySec": latency,
        "error": error,
    }
    agent_card[name] = {
        "ok": ok,
        "lastRoundTrip": NOW,
        "latencySec": latency,
    }
    if not ok:
        add(f"agent-{name}-roundtrip", f"Agent runner {name} not responding", "warn",
            f"round-trip failed: {error}", "warn")

write_agent_state(agent_state)

# ── Assemble scorecard ────────────────────────────────────────────────────────
fails = [f for f in findings if f["status"] == "fail"]
warns = [f for f in findings if f["status"] == "warn"]
score = max(0, 100 - 20*len(fails) - 5*len(warns))
scorecard = {"checkedAt": NOW, "checkedAtISO": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(NOW)),
             "score": score, "fails": len(fails), "warns": len(warns), "findings": findings,
             "agents": agent_card}
tmp = STATE + ".tmp"
json.dump(scorecard, open(tmp, "w"), indent=2); os.replace(tmp, STATE)

# ── Auto-enqueue deduped fix jobs (team is capped/paused; this just queues) ────
def open_job_markers():
    seen = set()
    for f in glob.glob("/var/lib/mimule/jobs/queue/*.json") + glob.glob("/var/lib/mimule/jobs/running/*.json"):
        try:
            g = json.load(open(f)).get("goal", "")
            if "[sentinel:" in g:
                seen.add(g.split("[sentinel:", 1)[1].split("]", 1)[0])
        except Exception: pass
    return seen

enqueued = []
if os.environ.get("SENTINEL_ENQUEUE", "1") == "1":
    existing = open_job_markers()
    for f in fails:
        if not f.get("auto_fix_goal"):
            continue
        key = f["id"]
        if key in existing:
            continue
        goal = f["auto_fix_goal"] + f" [sentinel:{key}]"
        try:
            subprocess.run(["/usr/local/bin/mimule-job", "team", goal, APP_DIR, "8"],
                           capture_output=True, text=True, timeout=15)
            enqueued.append(key)
        except Exception:
            pass

# ── Summary ───────────────────────────────────────────────────────────────────
print(f"[product-sentinel] score={score} fails={len(fails)} warns={len(warns)} enqueued={len(enqueued)}")
for f in fails:
    print(f"  FAIL [{f['severity']}] {f['name']}: {f['detail']}")
for f in warns:
    print(f"  warn {f['name']}: {f['detail']}")
if enqueued:
    print(f"  -> fix jobs enqueued (deduped): {', '.join(enqueued)}")
