#!/usr/bin/env python3
"""Usage tracker collector for the Hermes desktop "Usage" page.

Finds every AI account connected to Hermes (auth.json credential pools plus the
Claude Code and Codex CLI logins on this Mac), groups them by real account,
fetches subscription usage % per account, adds Hermes token usage from state.db,
appends a history point, and prints one JSON document on stdout.

Stdlib only. Run: /usr/bin/python3 ~/.hermes/usage-tracker/collect.py
"""
from __future__ import annotations

import base64
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
HERMES_HOME = Path(os.environ.get("HERMES_HOME") or HOME / ".hermes")
OUT_DIR = HERMES_HOME / "usage-tracker"
HISTORY = OUT_DIR / "history.jsonl"
LATEST = OUT_DIR / "latest.json"
TIMEOUT = 12

HERMES_BINS = [
    HERMES_HOME / "hermes-agent/.hermes/bin/hermes",
    HOME / ".local/bin/hermes",
    Path("/opt/homebrew/bin/hermes"),
    Path("/usr/local/bin/hermes"),
]
GH_BINS = [Path("/opt/homebrew/bin/gh"), Path("/usr/local/bin/gh"), Path("/usr/bin/gh")]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def jwt_claims(token: str) -> dict:
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        return json.loads(base64.urlsafe_b64decode(part))
    except Exception:
        return {}


def http_json(url: str, headers: dict, method: str = "GET", body: bytes | None = None) -> dict:
    req = urllib.request.Request(url, headers=headers, method=method, data=body)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read() or b"{}")


def first_existing(paths):
    for p in paths:
        if p.exists():
            return str(p)
    return None


def hermes_usage(provider: str) -> dict:
    exe = first_existing(HERMES_BINS)
    if not exe:
        raise RuntimeError("hermes CLI not found")
    done = subprocess.run([exe, "usage", "--provider", provider, "--json"], capture_output=True, text=True,
                          timeout=25, stdin=subprocess.DEVNULL)
    if done.returncode != 0:
        raise RuntimeError((done.stderr or done.stdout or "fetch failed").strip().splitlines()[-1][:200])
    return json.loads(done.stdout)


def window(label, used, resets_at=None, scope="account"):
    return {"label": label, "used_percent": None if used is None else round(float(used), 1),
            "resets_at": resets_at, "scope": scope}


# ---------------------------------------------------------------- Claude
CLAUDE_LABELS = (("five_hour", "5 hour session"), ("seven_day", "Weekly"), ("seven_day_opus", "Weekly Opus"),
                 ("seven_day_sonnet", "Weekly Sonnet"))
CLAUDE_TIERS = {"default_claude_max_20x": "Max 20x", "default_claude_max_5x": "Max 5x", "default_claude_pro": "Pro"}


def anthropic_headers(token):
    return {"Authorization": f"Bearer {token}", "anthropic-beta": "oauth-2025-04-20", "Accept": "application/json",
            "User-Agent": "claude-code/2.1.0"}


def claude_windows(payload: dict) -> list:
    out = []
    for key, label in CLAUDE_LABELS:
        w = payload.get(key) or {}
        if w.get("utilization") is None:
            continue
        out.append(window(label, w["utilization"], w.get("resets_at"), "model" if "opus" in key or "sonnet" in key else "account"))
    return out


def claude_accounts(auth: dict) -> list:
    creds = []  # (connection label, token, expires_ms)
    for c in (auth.get("credential_pool") or {}).get("anthropic", []):
        if c.get("access_token"):
            creds.append(("Hermes", c["access_token"], c.get("expires_at_ms")))
    cc = (read_json(HOME / ".claude/.credentials.json").get("claudeAiOauth") or {})
    if cc.get("accessToken"):
        creds.append(("Claude Code", cc["accessToken"], cc.get("expiresAt")))
    if not creds:
        return []

    accounts: dict[str, dict] = {}
    for conn, token, exp in creds:
        if exp and exp < time.time() * 1000:
            continue
        try:
            prof = http_json("https://api.anthropic.com/api/oauth/profile", anthropic_headers(token))
        except Exception:
            continue
        email = (prof.get("account") or {}).get("email") or "unknown"
        org = prof.get("organization") or {}
        acct = accounts.setdefault(email, {"token": token, "connections": [], "plan": None})
        acct["connections"].append(conn)
        acct["plan"] = acct["plan"] or CLAUDE_TIERS.get(org.get("rate_limit_tier") or "") or (
            org.get("organization_type") or "").replace("claude_", "").title() or None

    # Hermes' own fetch (refreshes tokens itself) for the account Hermes is signed in to.
    hermes_snapshot = None
    try:
        hermes_snapshot = hermes_usage("anthropic")
    except Exception:
        pass

    result = []
    for i, (email, a) in enumerate(accounts.items()):
        card = {"id": f"anthropic:{email}", "service": "Claude", "provider": "anthropic", "account": email,
                "plan": a["plan"], "connections": sorted(set(a["connections"])), "windows": [], "status": "ok"}
        try:
            card["windows"] = claude_windows(http_json("https://api.anthropic.com/api/oauth/usage", anthropic_headers(a["token"])))
        except Exception as exc:
            if i == 0 and hermes_snapshot:
                card["windows"] = [window(w["label"], w["used_percent"], w["resets_at"]) for w in hermes_snapshot["windows"]]
            else:
                card.update(status="error", note=f"Could not read usage: {exc}")
        result.append(card)
    if not result and hermes_snapshot:
        result.append({"id": "anthropic:hermes", "service": "Claude", "provider": "anthropic", "account": None,
                       "plan": None, "connections": ["Hermes"], "status": "ok",
                       "windows": [window(w["label"], w["used_percent"], w["resets_at"]) for w in hermes_snapshot["windows"]]})
    return result


# ---------------------------------------------------------------- ChatGPT / Codex
def codex_windows(payload: dict) -> list:
    rl = payload.get("rate_limit") or {}
    out = []
    for key, fallback in (("primary_window", "5 hour session"), ("secondary_window", "Weekly")):
        w = rl.get(key) or {}
        if w.get("used_percent") is None:
            continue
        secs = w.get("limit_window_seconds")
        label = {18000: "5 hour session", 604800: "Weekly"}.get(int(secs), fallback) if secs else fallback
        reset = w.get("reset_at")
        reset = datetime.fromtimestamp(reset, timezone.utc).isoformat() if isinstance(reset, (int, float)) else reset
        out.append(window(label, w["used_percent"], reset))
    return out


def codex_accounts(auth: dict) -> list:
    tokens = []  # (connection, access_token, account_id, base)
    singleton = ((auth.get("providers") or {}).get("openai-codex") or {}).get("tokens") or {}
    if singleton.get("access_token"):
        tokens.append(("Hermes", singleton["access_token"], singleton.get("account_id")))
    for c in (auth.get("credential_pool") or {}).get("openai-codex", []):
        if c.get("access_token"):
            tokens.append(("Hermes", c["access_token"], None))
    cli = read_json(HOME / ".codex/auth.json").get("tokens") or {}
    if cli.get("access_token"):
        tokens.append(("Codex CLI", cli["access_token"], cli.get("account_id")))
    if not tokens:
        return []

    accounts: dict[str, dict] = {}
    for conn, tok, acct_id in tokens:
        claims = jwt_claims(tok)
        email = (claims.get("https://api.openai.com/profile") or {}).get("email") or "unknown"
        auth_claims = claims.get("https://api.openai.com/auth") or {}
        a = accounts.setdefault(email, {"tokens": [], "connections": [], "plan": auth_claims.get("chatgpt_plan_type")})
        a["connections"].append(conn)
        a["tokens"].append((tok, acct_id or auth_claims.get("chatgpt_account_id"), claims.get("exp", 0)))

    hermes_snapshot = None
    try:
        hermes_snapshot = hermes_usage("openai-codex")
    except Exception:
        pass

    result = []
    for i, (email, a) in enumerate(accounts.items()):
        card = {"id": f"openai-codex:{email}", "service": "ChatGPT", "provider": "openai-codex", "account": email,
                "plan": (a["plan"] or "").title() or None, "connections": sorted(set(a["connections"])),
                "windows": [], "status": "ok"}
        payload = None
        for tok, acct_id, exp in sorted(a["tokens"], key=lambda t: -t[2]):
            if exp and exp < time.time():
                continue
            headers = {"Authorization": f"Bearer {tok}", "Accept": "application/json", "User-Agent": "codex-cli"}
            if acct_id:
                headers["ChatGPT-Account-Id"] = acct_id
            try:
                payload = http_json("https://chatgpt.com/backend-api/wham/usage", headers)
                break
            except Exception:
                continue
        if payload:
            card["windows"] = codex_windows(payload)
            card["plan"] = (payload.get("plan_type") or card["plan"] or "").title() or None
            credits = payload.get("credits") or {}
            if credits.get("has_credits") and credits.get("balance") is not None:
                card["note"] = f"Credits balance ${float(credits['balance']):.2f}"
        elif hermes_snapshot and i == 0:
            card["windows"] = [window(w["label"], w["used_percent"], w["resets_at"]) for w in hermes_snapshot["windows"]]
            card["plan"] = hermes_snapshot.get("plan") or card["plan"]
        else:
            card.update(status="error", note="Login expired here. It refreshes the next time this app uses it.")
        result.append(card)
    return result


# ---------------------------------------------------------------- Grok
def xai_accounts(auth: dict) -> list:
    prov = ((auth.get("providers") or {}).get("xai-oauth") or {}).get("tokens") or {}
    pool = (auth.get("credential_pool") or {}).get("xai-oauth", [])
    if not prov and not pool:
        return []
    email = jwt_claims(prov.get("id_token", "")).get("email")
    return [{"id": f"xai-oauth:{email}", "service": "Grok", "provider": "xai-oauth", "account": email,
             "plan": "SuperGrok", "connections": ["Hermes"], "windows": [], "status": "no_data",
             "note": "xAI does not share subscription usage %. Hermes usage of this account is shown below."}]


# ---------------------------------------------------------------- GitHub Copilot
def copilot_accounts(auth: dict) -> list:
    if not (auth.get("credential_pool") or {}).get("copilot"):
        return []
    gh = first_existing(GH_BINS)
    token = None
    if gh:
        try:
            token = subprocess.run([gh, "auth", "token"], capture_output=True, text=True, timeout=10).stdout.strip()
        except Exception:
            token = None
    card = {"id": "copilot", "service": "GitHub Copilot", "provider": "copilot", "account": None, "plan": None,
            "connections": ["Hermes"], "windows": [], "status": "ok"}
    if not token:
        card.update(status="error", note="GitHub CLI login not found")
        return [card]
    try:
        d = http_json("https://api.github.com/copilot_internal/user",
                      {"Authorization": f"token {token}", "Accept": "application/json", "Editor-Version": "vscode/1.95.0"})
    except Exception as exc:
        card.update(status="error", note=f"Could not read usage: {exc}")
        return [card]
    card["account"] = d.get("login")
    sku = d.get("access_type_sku") or ""
    card["plan"] = "Free" if "free" in sku else (d.get("copilot_plan") or "").title() or None
    reset = d.get("quota_reset_date_utc")
    labels = {"premium_interactions": "Premium requests (monthly)", "chat": "Chat (monthly)",
              "completions": "Code completions (monthly)"}
    for key, label in labels.items():
        q = (d.get("quota_snapshots") or {}).get(key) or {}
        if q.get("unlimited") or not q.get("entitlement"):
            continue
        card["windows"].append(window(label, 100 - float(q.get("percent_remaining") or 0), reset))
    if not card["windows"]:
        card["note"] = "Unlimited or no metered quota on this plan"
    return [card]


# ---------------------------------------------------------------- Hermes token usage
def hermes_token_usage() -> dict:
    db = HERMES_HOME / "state.db"
    out = {}
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
        now = time.time()
        midnight = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        for period, since in (("today", midnight), ("7d", now - 7 * 86400), ("30d", now - 30 * 86400)):
            rows = con.execute(
                "select coalesce(billing_provider,'other'), count(*), sum(api_call_count), "
                "sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens+reasoning_tokens), "
                "sum(coalesce(estimated_cost_usd,0)) from sessions where coalesce(last_activity_at, started_at) >= ? "
                "group by 1", (since,)).fetchall()
            out[period] = {r[0]: {"sessions": r[1], "api_calls": r[2] or 0, "tokens": r[3] or 0,
                                  "est_cost_usd": round(r[4] or 0, 2)} for r in rows if r[0] != "other" or r[3]}
        days = con.execute(
            "select date(coalesce(last_activity_at, started_at),'unixepoch','localtime') d, coalesce(billing_provider,'other'), "
            "sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens+reasoning_tokens) from sessions "
            "where coalesce(last_activity_at, started_at) >= ? group by 1,2 order by 1", (now - 14 * 86400,)).fetchall()
        out["daily"] = [{"day": d, "provider": p, "tokens": t or 0} for d, p, t in days]
        con.close()
    except Exception as exc:
        out["error"] = str(exc)
    return out


# ---------------------------------------------------------------- history
def update_history(accounts: list) -> list:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    points = []
    if HISTORY.exists():
        for line in HISTORY.read_text().splitlines():
            try:
                points.append(json.loads(line))
            except Exception:
                pass
    t = int(time.time())
    vals = {a["id"]: {w["label"]: w["used_percent"] for w in a["windows"] if w["used_percent"] is not None}
            for a in accounts if a["windows"]}
    if vals and (not points or t - points[-1]["t"] >= 600):
        points.append({"t": t, "v": vals})
    cutoff = t - 30 * 86400
    points = [p for p in points if p["t"] >= cutoff]
    HISTORY.write_text("".join(json.dumps(p, separators=(",", ":")) + "\n" for p in points))
    return [p for p in points if p["t"] >= t - 7 * 86400]


COMPACT = OUT_DIR / "latest-compact.json"
CHUNK = 3500  # the desktop shell.exec RPC returns only the last 4000 chars of stdout


def series(history: list) -> dict:
    """{account_id: {window_label: [[unix_hour, pct], ...]}} with one point per hour (last value wins)."""
    out: dict = {}
    for p in history:
        hour = p["t"] // 3600 * 3600
        for acct, wins in p["v"].items():
            for label, pct in wins.items():
                pts = out.setdefault(acct, {}).setdefault(label, [])
                if pts and pts[-1][0] == hour:
                    pts[-1][1] = pct
                else:
                    pts.append([hour, pct])
    return out


def write_compact(doc: dict) -> int:
    compact = {"fetched_at": doc["fetched_at"], "accounts": doc["accounts"], "hermes": doc["hermes"],
               "series": series(doc["history"])}
    text = json.dumps(compact, separators=(",", ":"))
    COMPACT.write_text(text)
    return max(1, -(-len(text) // CHUNK))


def collect() -> dict:
    auth = read_json(HERMES_HOME / "auth.json")
    jobs = [claude_accounts, codex_accounts, xai_accounts, copilot_accounts]
    accounts = []
    with ThreadPoolExecutor(max_workers=len(jobs) + 1) as pool:
        futs = [pool.submit(j, auth) for j in jobs]
        usage_fut = pool.submit(hermes_token_usage)
        for f in futs:
            try:
                accounts.extend(f.result(timeout=28))
            except Exception as exc:
                accounts.append({"id": f"error:{len(accounts)}", "service": "Unknown", "status": "error",
                                 "windows": [], "connections": [], "note": str(exc)[:200]})
        hermes = usage_fut.result()
    doc = {"fetched_at": now_iso(), "accounts": accounts, "hermes": hermes, "history": update_history(accounts)}
    LATEST.write_text(json.dumps(doc))
    return doc


def main(argv: list) -> None:
    """No args: collect and print the full JSON.
    --refresh: collect, write the compact file, print {"chunks": N}.
    --chunk I: print slice I of the compact file (for the desktop plugin)."""
    if argv[:1] == ["--chunk"]:
        i = int(argv[1])
        sys.stdout.write(COMPACT.read_text()[i * CHUNK:(i + 1) * CHUNK])
        return
    doc = collect()
    if argv[:1] == ["--refresh"]:
        print(json.dumps({"chunks": write_compact(doc)}))
    else:
        print(json.dumps(doc))


if __name__ == "__main__":
    main(sys.argv[1:])
