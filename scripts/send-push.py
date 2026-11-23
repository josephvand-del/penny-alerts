#!/usr/bin/env python3
"""Penny Alerts — background push sender.

Runs in GitHub Actions AFTER scripts/parse-lists.py and BEFORE the feed
commit (see penny-alerts-workflow.yml): the new feed is in the working
tree, the OLD feed is still the committed one at HEAD, so the diff is
exact. Sends ONE summary push per subscribed phone when the feed gained
new items, and prunes subscriptions the push service rejects (404/410).

Env (GitHub Secrets, never committed):
  VAPID_PRIVATE_KEY        VAPID private key (paired with the public key in app.js)
  SUPABASE_SERVICE_ROLE_KEY  service_role key for the "bulk finder" project
SUPABASE_URL is hardcoded (public project URL).

Never fails the workflow on push errors: any failure is logged and the
script exits 0, so a push problem can never block the feed update.
`--dry-run` prints what WOULD be sent and contacts nothing.
`--feed PATH` / `--old-feed PATH` override the feed locations (tests).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

# httpx and pywebpush are imported lazily inside the functions that need
# them, so --dry-run works with plain stdlib python (no third-party deps).

SUPABASE_URL = "https://xwekulsnfarjibawqqih.supabase.co"
APP_URL = "https://josephvand-del.github.io/penny-alerts/"
VAPID_SUBJECT = "mailto:josephvand@gmail.com"

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FEED_PATH = os.path.join(REPO_ROOT, "feed", "weekly.json")


def log(msg: str) -> None:
    print(f"[send-push] {msg}", flush=True)


def item_key(item: dict) -> str:
    upc = (item.get("upc") or "").strip()
    if upc:
        return "upc:" + upc
    name = (item.get("name") or "").strip().lower()
    retailer = (item.get("retailer") or "").strip().lower()
    return f"name:{name}|{retailer}"


def load_feed(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        log(f"could not load feed {path}: {e}")
        return None


def load_old_feed() -> dict | None:
    """The committed feed at HEAD (the feed before this run's parse)."""
    try:
        out = subprocess.run(
            ["git", "show", "HEAD:feed/weekly.json"],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=30,
        )
        if out.returncode != 0:
            log("no committed feed at HEAD yet (no baseline) — skipping push")
            return None
        return json.loads(out.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as e:
        log(f"could not read old feed from git: {e} — skipping push")
        return None


def diff_feeds(new_feed: dict, old_feed: dict) -> list:
    old_keys = {item_key(it) for it in old_feed.get("items", []) if isinstance(it, dict)}
    seen: set[str] = set()
    fresh = []
    for it in new_feed.get("items", []):
        if not isinstance(it, dict) or not it.get("name"):
            continue
        key = item_key(it)
        if key in old_keys or key in seen:
            continue
        seen.add(key)
        fresh.append(it)
    # Penny items first, then the rest — the push names the best leads.
    fresh.sort(key=lambda it: 0 if (it.get("price") == "$0.01") else 1)
    return fresh


RETAILER_LABELS = {
    "home-depot": "Home Depot", "walmart": "Walmart", "wm-ct": "Walmart",
    "target": "Target", "dollar-general": "Dollar General",
    "walgreens": "Walgreens", "cvs": "CVS", "rite-aid": "Rite Aid",
    "hobby-lobby": "Hobby Lobby", "jcp": "JCPenney", "kohls": "Kohl's",
    "michaels": "Michaels", "lowes": "Lowe's", "amazon": "Amazon",
    "king-soopers": "King Soopers", "online": "Online",
}


def _store_label(retailer: str) -> str:
    if retailer in RETAILER_LABELS:
        return RETAILER_LABELS[retailer]
    return (retailer or "online").replace("-", " ").title()


def build_payload(new_items: list) -> dict:
    """One summary push per run (v14): the title is the count, the body
    names the top 3 new deals with prices — 'Name — $price (Store)'
    lines — then '+N more' when there are more, then 'Open the app to
    see them.' The register is still the final truth; the push is a
    lead, not a confirmation."""
    n = len(new_items)
    title = f"Penny Alerts: {n} new deal{'s' if n != 1 else ''}"
    lines = []
    for it in new_items[:3]:
        name = (it.get("name") or "")[:80]
        if not name:
            continue
        price = (it.get("price") or "").strip()
        store = _store_label(it.get("retailer") or "")
        if price:
            lines.append(f"{name} — {price} ({store})")
        else:
            lines.append(f"{name} ({store})")
    body = "\n".join(lines)
    if n > 3:
        body += f"\n+{n - 3} more"
    body += "\nOpen the app to see them."
    return {"title": title, "body": body, "url": APP_URL}


def fetch_subscriptions(service_key: str) -> list:
    import httpx

    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
    }
    with httpx.Client(timeout=30) as client:
        resp = client.get(
            f"{SUPABASE_URL}/rest/v1/push_subscriptions?select=endpoint,p256dh,auth",
            headers=headers,
        )
        resp.raise_for_status()
        rows = resp.json()
    return rows if isinstance(rows, list) else []


def delete_subscription(service_key: str, endpoint: str) -> None:
    import urllib.parse

    import httpx

    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
    }
    with httpx.Client(timeout=30) as client:
        client.delete(
            f"{SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq."
            + urllib.parse.quote(endpoint, safe=""),
            headers=headers,
        )


def send_pushes(subscriptions: list, payload: dict, vapid_private_key: str) -> tuple[int, int]:
    from pywebpush import WebPushException, webpush

    sent = pruned = 0
    data = json.dumps(payload)
    for sub in subscriptions:
        endpoint = sub.get("endpoint") or ""
        try:
            webpush(
                subscription_info={
                    "endpoint": endpoint,
                    "keys": {"p256dh": sub.get("p256dh"), "auth": sub.get("auth")},
                },
                data=data,
                vapid_private_key=vapid_private_key,
                vapid_claims={"sub": VAPID_SUBJECT},
            )
            sent += 1
        except WebPushException as e:
            status = e.response.status_code if e.response is not None else None
            log(f"push failed for {endpoint[:60]}… (HTTP {status})")
            if status in (404, 410):
                try:
                    delete_subscription(os.environ["SUPABASE_SERVICE_ROLE_KEY"], endpoint)
                    pruned += 1
                    log("pruned dead subscription")
                except Exception as de:  # noqa: BLE001 - pruning must never kill the run
                    log(f"prune failed: {de}")
        except Exception as e:  # noqa: BLE001 - one bad subscription never kills the run
            log(f"push error for {endpoint[:60]}…: {e}")
    return sent, pruned


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Send Penny Alerts background pushes.")
    ap.add_argument("--dry-run", action="store_true",
                    help="print what WOULD be sent; contact nothing")
    ap.add_argument("--feed", default=FEED_PATH,
                    help="path to the new feed/weekly.json (default: repo feed)")
    ap.add_argument("--old-feed", default=None,
                    help="path to the old feed JSON (default: git show HEAD:feed/weekly.json)")
    args = ap.parse_args(argv)

    new_feed = load_feed(args.feed)
    if new_feed is None:
        log("no new feed — nothing to do")
        return 0
    if args.old_feed:
        old_feed = load_feed(args.old_feed)
        if old_feed is None:
            log("no baseline feed — skipping push")
            return 0
    else:
        old_feed = load_old_feed()
        if old_feed is None:
            return 0

    new_items = diff_feeds(new_feed, old_feed)
    if not new_items:
        log("no new items — sending nothing")
        return 0
    payload = build_payload(new_items)
    log(f"{len(new_items)} new item(s); payload: {payload['title']} — {payload['body']}")

    if args.dry_run:
        log("dry run — not fetching subscriptions, not sending")
        return 0

    vapid_key = os.environ.get("VAPID_PRIVATE_KEY", "")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not vapid_key or not service_key:
        log("VAPID_PRIVATE_KEY or SUPABASE_SERVICE_ROLE_KEY not set — push disabled, skipping")
        return 0

    try:
        subs = fetch_subscriptions(service_key)
    except Exception as e:  # noqa: BLE001 - never fail the workflow
        log(f"could not fetch subscriptions: {e}")
        return 0
    if not subs:
        log("no subscriptions stored — nothing to send to")
        return 0
    log(f"sending to {len(subs)} subscription(s)")
    sent, pruned = send_pushes(subs, payload, vapid_key)
    log(f"done: {sent} sent, {pruned} pruned")
    return 0


if __name__ == "__main__":
    sys.exit(main())
