#!/usr/bin/env python3
"""Penny Alerts — weekly feed parser (v2).

Reads the free community deal lists and turns them into feed/weekly.json,
a fresh feed the app reads alongside Penny Hunter's briefing. Runs locally
(`python scripts/parse-lists.py`) and in GitHub Actions (see
penny-alerts-workflow.yml, added by Joseph on github.com).

Free signals only. It never fetches walmart.com, brickseek.com, or any
retailer endpoint — only the public coupon-blog lists and RSS feeds below.

Parsing approach reuses Penny Hunter's (Rocketshon/penny-finder-backend,
MIT) scrapers: penny_pages.py's UPC-line regex for the DG/HD list pages,
_rss_common.py's category/signal logic for the RSS feeds, and slickdeals.py's
retailer map + price extraction. Credit in README.md.

Each source is wrapped in try/except: one failure never kills the run.
If a source blocks plain HTTP (403 / Cloudflare challenge), it is recorded
as "blocked" — the parser never uses Playwright/stealth.
If the run yields zero items total, the existing feed/weekly.json is kept
and the script exits 1 so a bad run never wipes a good feed.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urljoin

import feedparser
import httpx
from selectolax.lexbor import LexborHTMLParser as HTMLParser

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 PennyAlerts/0.1"
)

OUT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "feed", "weekly.json")

CF_MARKERS = ("Attention Required", "cf-challenge", "Just a moment",
              "challenges.cloudflare.com", "cf-turnstile")

# Penny Hunter penny_pages.py: "Item name - 012345678901" or "Item — UPC: 012345678901"
UPC_LINE = re.compile(
    r"""(?P<item>[^\n\r]+?)
        \s*[-–—]\s*
        (?:UPC[:\s]*)?
        (?P<upc>\d{11,13})
    """,
    re.VERBOSE,
)
UPC_ANY = re.compile(r"\b\d{11,13}\b")
TAG_STRIP = re.compile(r"<[^>]+>")

_NOISE_PREFIXES = (
    "filed under", "also see", "check our", "download", "quick tips",
    "ready to start", "related post", "advertisement", "continue reading",
    "also check",
)


def today_str() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def clean(text: str) -> str:
    text = re.sub(r"[\x00-\x1f\x7f\ufeff\u200b\u200c\u200d]", "", text or "")
    return re.sub(r"\s+", " ", text).strip()


def department_for(name: str, kind: str) -> str:
    if kind == "penny":
        return "Penny"
    text = (name or "").lower()
    if re.search(r"pet|dog|cat|bird|fish tank|aquarium", text):
        return "Pet"
    if re.search(r"toy|lego|game|doll|playset|nerf", text):
        return "Toys & Games"
    if re.search(r"baby|infant|diaper|toddler|kids|children", text):
        return "Baby & Kids"
    if re.search(r"shoe|cloth|apparel|dress|shirt|pants|jacket|fashion|men's|women", text):
        return "Clothing"
    if re.search(r"food|snack|drink|coffee|grocery|candy|chip|juice|soda|water|popcorn", text):
        return "Grocery"
    if re.search(r"clean|detergent|soap|bleach|laundry|dish", text):
        return "Household"
    if re.search(r"beauty|shampoo|makeup|skincare|deodorant|vitamin|health", text):
        return "Health & Beauty"
    if re.search(r"tv|headphone|computer|laptop|monitor|phone|tablet|wifi|speaker|electronic|camera", text):
        return "Electronics"
    if re.search(r"tool|drill|saw|hammer|hardware|wrench", text):
        return "Tools"
    if re.search(r"furniture|decor|holiday|halloween|christmas|garden|patio|bedding|towel", text):
        return "Home & Seasonal"
    if re.search(r"car|auto|tire|motor oil", text):
        return "Auto"
    return "General"


def make_item(name, retailer, source, kind="deal", upc="", price="", was="",
              valid_to="", url="", image=""):
    name = clean(name)[:140] or "Unknown item"
    return {
        "name": name,
        "upc": upc,
        "price": price,
        "was": was,
        "retailer": retailer,
        "department": department_for(name, kind),
        "source": source,
        "first_seen": today_str(),
        "valid_to": valid_to,
        "url": url,
        "image": image,
    }


def clean_image_url(url: str, base_url: str = "") -> str:
    """Validate a candidate image URL: absolute http(s) only, no data: URIs,
    no empty values, sane length. Resolves relative URLs against the page."""
    url = (url or "").strip()
    if not url or url.startswith("data:"):
        return ""
    if base_url:
        url = urljoin(base_url, url)
    if not url.startswith(("http://", "https://")) or len(url) > 500:
        return ""
    return url


def nearest_image(el, base_url: str = "") -> str:
    """First <img> in the element itself, else in ancestors up to 3 levels.
    Returns a validated absolute URL or ''. A shared page/header image is
    caught later by the shared-image guard, not here."""
    node = el
    for _ in range(4):
        if node is None:
            break
        try:
            for img in node.css("img"):
                attrs = img.attributes or {}
                src = (attrs.get("src") or attrs.get("data-src")
                       or attrs.get("data-lazy-src") or "")
                url = clean_image_url(src, base_url)
                if url:
                    return url
        except Exception:
            pass
        node = getattr(node, "parent", None)
    return ""


def safe_get(client: httpx.Client, url: str, timeout: float = 25.0):
    """GET a URL. Returns (text_or_None, error_or_None)."""
    try:
        resp = client.get(url, timeout=timeout, follow_redirects=True)
    except httpx.HTTPError as e:
        return None, f"{type(e).__name__}"
    if resp.status_code != 200:
        return None, f"HTTP {resp.status_code}"
    body = resp.text or ""
    if any(m in body for m in CF_MARKERS):
        return None, "blocked (bot challenge)"
    return body, None


# ---------------------------------------------------------------- penny pages
def extract_upc_lines(html_text: str, retailer: str, source: str, base_url: str = ""):
    """Penny Hunter penny_pages.py approach: UPC-line regex over list text.
    Also captures a nearby <img> per item when the markup has one."""
    tree = HTMLParser(html_text)
    seen = set()
    items = []
    for el in tree.css("li, p, h2, h3, h4"):
        text = clean(el.text(separator=" "))
        if not (5 < len(text) < 300):
            continue
        if any(text.lower().startswith(p) for p in _NOISE_PREFIXES):
            continue
        m = UPC_LINE.search(text)
        if not m:
            continue
        item = m.group("item").strip(" -–—:")
        upc = m.group("upc")
        if upc in seen:
            continue
        seen.add(upc)
        items.append(make_item(item, retailer, source, kind="penny",
                               upc=upc, price="$0.01",
                               image=nearest_image(el, base_url)))
    return items


def parse_retailshout(html_text: str):
    """RetailShout: li.dg-penny-item cards (h4 name, penny date, UPC span)."""
    tree = HTMLParser(html_text)
    items = []
    seen = set()
    for card in tree.css("li.dg-penny-item"):
        upc_el = card.css_first("span.dg-penny-upc")
        if not upc_el:
            continue
        upc = clean(upc_el.text())
        if not re.fullmatch(r"\d{11,13}", upc) or upc in seen:
            continue
        seen.add(upc)
        name_el = card.css_first("h4")
        date_el = card.css_first("p.dg-penny-date")
        name = clean(name_el.text()) if name_el else "Dollar General penny item"
        note = clean(date_el.text()) if date_el else ""
        # Each card carries its own product photo (webp on retailshout.com).
        img = ""
        img_el = card.css_first("img")
        if img_el is not None:
            attrs = img_el.attributes or {}
            img = clean_image_url(
                attrs.get("src") or attrs.get("data-src")
                or attrs.get("data-lazy-src") or "",
                "https://retailshout.com/")
        it = make_item(name, "dollar-general", "retailshout.com",
                       kind="penny", upc=upc, price="$0.01", image=img)
        if note:
            it["note"] = note
        items.append(it)
    return items


def parse_ppm_table(html_text: str):
    """PennyPinchinMom: a table, one row per item — name | UPC."""
    tree = HTMLParser(html_text)
    items = []
    seen = set()
    for row in tree.css("tr"):
        cells = row.css("td")
        if len(cells) < 2:
            continue
        name = clean(cells[0].text())
        m = UPC_ANY.search(clean(cells[1].text()))
        if not name or not m:
            continue
        upc = m.group(0)
        if upc in seen:
            continue
        seen.add(upc)
        items.append(make_item(name, "dollar-general", "pennypinchinmom.com",
                               kind="penny", upc=upc, price="$0.01"))
    return items


def parse_pennyrecon(html_text: str):
    """PennyRecon front page: JSON-LD ItemList (name + /item/ URL) plus the
    card HTML for the Home Depot SKU, retail price and last-seen date.
    No UPC is exposed in the list HTML, so these items carry the HD SKU
    instead and no UPC — the app shows them without a BrickSeek link."""
    tree = HTMLParser(html_text)
    items = []
    names = {}
    for script in tree.css('script[type="application/ld+json"]'):
        try:
            data = json.loads(script.text())
        except Exception:
            continue
        if not isinstance(data, dict) or data.get("@type") != "ItemList":
            continue
        for el in data.get("itemListElement", []) or []:
            if isinstance(el, dict) and el.get("url") and el.get("name"):
                names[el["url"]] = clean(el["name"])
    seen_urls = set()
    for card_link in tree.css('a[href^="/item/"]'):
        href = card_link.attributes.get("href", "")
        url = "https://www.pennyrecon.com" + href
        if url in seen_urls:
            continue
        seen_urls.add(url)
        name = names.get(url) or clean(card_link.text())
        if not name:
            continue
        # Walk up to THIS card (div.card-body) and read its own SKU/price —
        # never the page-level text, which mixes every card together.
        # The card also carries its own product photo (Home Depot's image
        # CDN, images.thdstatic.com — the URL PennyRecon itself embeds).
        node = card_link
        sku = ""
        retail = ""
        img = ""
        for _ in range(4):
            node = node.parent
            if node is None:
                break
            cls = (node.attributes.get("class") or "") if hasattr(node, "attributes") else ""
            if "card-body" in cls or "card " in cls or cls == "card":
                btn = node.css_first("button.sku") if hasattr(node, "css_first") else None
                if btn is not None:
                    sku = (btn.attributes.get("data-copy") or "").strip()
                    if not sku:
                        m = re.search(r"SKU\s+(\d{6,12})", btn.text() or "")
                        sku = m.group(1) if m else ""
                span = node.css_first("span.retail") if hasattr(node, "css_first") else None
                if span is not None:
                    m = re.search(r"\$([\d,]+\.\d{2})", span.text() or "")
                    retail = ("$" + m.group(1)) if m else ""
                # The photo is a sibling of card-body, inside the
                # <article class="card ..."> wrapper — look at the card
                # node's parent first, then fall back to the node itself.
                img_el = None
                parent = getattr(node, "parent", None)
                if parent is not None and hasattr(parent, "css_first"):
                    img_el = parent.css_first("img")
                if img_el is None:
                    img_el = node.css_first("img") if hasattr(node, "css_first") else None
                if img_el is not None:
                    attrs = img_el.attributes or {}
                    img = clean_image_url(
                        attrs.get("src") or attrs.get("data-src")
                        or attrs.get("data-lazy-src") or "",
                        "https://www.pennyrecon.com/")
                break
        it = make_item(name, "home-depot", "pennyrecon.com",
                       kind="penny", upc="", price="$0.01",
                       was=retail, url=url, image=img)
        if sku:
            it["sku"] = sku
        items.append(it)
    return items


# ---------------------------------------------------------------------- RSS
# Adapted from Penny Hunter _rss_common.py (category -> store, signal ladder).
CATEGORY_STORE = {
    "dollar general": "dollar-general",
    "dg": "dollar-general",
    "target": "target",
    "cvs": "cvs",
    "walgreens": "walgreens",
    "meijer": "meijer",
    "kroger": "kroger",
}
TITLE_STORE_HINTS = {
    "dollar general": "dollar-general",
    " dg ": "dollar-general",
    "target": "target",
    "cvs": "cvs",
    "walgreens": "walgreens",
    "meijer": "meijer",
    "kroger": "kroger",
}
STRONG_PENNY = ("penny list", "1¢", "1 cent", "one cent", "penny item")
WEAK_PENNY = ("penny", "markdown", "clearance", "discontinued")


def _classify_penny(text: str) -> str:
    low = text.lower()
    if any(p in low for p in STRONG_PENNY):
        return "high"
    if any(p in low for p in WEAK_PENNY):
        return "med"
    return "low"


def parse_rss(raw: str, source_name: str):
    """Returns (items, error_or_None)."""
    parsed = feedparser.parse(raw)
    today = today_str()
    items = []
    seen_upcs = set()
    for entry in parsed.entries[:60]:
        title = clean(getattr(entry, "title", "") or "")
        link = getattr(entry, "link", "") or ""
        summary = clean(TAG_STRIP.sub("", html.unescape(getattr(entry, "summary", "") or "")))
        content = ""
        for c in (getattr(entry, "content", None) or [])[:1]:
            content = clean(TAG_STRIP.sub("", html.unescape(getattr(c, "value", "") or "")))
        combined = " ".join([title, summary, content])
        cats = [t.term.lower().strip() for t in getattr(entry, "tags", []) if getattr(t, "term", None)]
        store_id = None
        for c in cats:
            if c in CATEGORY_STORE:
                store_id = CATEGORY_STORE[c]
                break
        heat = _classify_penny(combined)
        if not store_id:
            if heat != "high":
                continue
            low = f" {combined.lower()} "
            for phrase, sid in TITLE_STORE_HINTS.items():
                if phrase in low:
                    store_id = sid
                    break
            if not store_id:
                continue
        if heat == "low" and "deals" in cats and len(cats) <= 2 and store_id != "dollar-general":
            continue
        if heat == "high":
            # Penny-list post: pull any UPCs out of the post text. If none
            # are in the post, skip it — the list pages already carry the
            # real UPCs, and the post title alone is not an item.
            for upc in UPC_ANY.findall(combined)[:25]:
                if upc in seen_upcs:
                    continue
                seen_upcs.add(upc)
                items.append(make_item(title, store_id, source_name,
                                       kind="penny", upc=upc, price="$0.01",
                                       url=link))
        elif heat == "med":
            items.append(make_item(title, store_id, source_name,
                                   kind="deal", upc="", price="",
                                   valid_to=today, url=link))
    return items, None


# --------------------------------------------------------------- Slickdeals
# Retailer map + price extraction adapted from Penny Hunter slickdeals.py.
SLICKDEALS_URL = "https://slickdeals.net/newsearch.php?mode=frontpage&searcharea=deals&searchin=first&rss=1"
RETAILER_MAP = {
    "amazon": "amazon", "amazon.com": "amazon", "ebay": "ebay",
    "ebay.com": "ebay", "walmart": "wm-ct", "walmart.com": "wm-ct",
    "target": "target", "target.com": "target", "best buy": "best-buy",
    "bestbuy.com": "best-buy", "home depot": "home-depot",
    "the home depot": "home-depot", "homedepot.com": "home-depot",
    "lowe's": "lowes", "lowes": "lowes", "lowes.com": "lowes",
    "costco": "costco", "costco.com": "costco", "kohl's": "kohls",
    "kohls": "kohls", "macy's": "macys", "jcpenney": "jcp",
    "tj maxx": "tj-maxx", "marshalls": "marshalls",
    "homegoods": "homegoods", "kroger": "kroger", "meijer": "meijer",
    "cvs": "cvs", "walgreens": "walgreens", "rite aid": "rite-aid",
    "ulta": "ulta", "sephora": "sephora", "menards": "menards",
    "harbor freight": "harbor-freight", "five below": "five-below",
    "big lots": "big-lots", "barnes & noble": "barnes-noble",
    "staples": "staples", "office depot": "office-depot",
    "petsmart": "petsmart", "petco": "petco", "michaels": "michaels",
    "hobby lobby": "hl", "dick's sporting goods": "dicks",
    "dollar general": "dollar-general", "family dollar": "family-dollar",
    "dollar tree": "dollar-tree",
}
PRICE_RE = re.compile(r"\$([\d,]+(?:\.\d{2})?)")
RETAILER_TAIL_RE = re.compile(r"\b(?:at|via|from|on)\s+([A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*){0,3})", re.I)
RETAILER_HEAD_RE = re.compile(r"^([A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*){0,2})\s+has\b", re.I)


def _retailer_for(title: str, summary: str) -> str:
    haystack = f"{title} {summary}"
    for m in RETAILER_TAIL_RE.finditer(haystack):
        cand = m.group(1).strip().lower().rstrip(".,!?;:")
        if cand in RETAILER_MAP:
            return RETAILER_MAP[cand]
    for hay in (title.strip(), summary.strip()):
        m = RETAILER_HEAD_RE.match(hay)
        if m:
            cand = m.group(1).strip().lower().rstrip(".,!?;:")
            if cand in RETAILER_MAP:
                return RETAILER_MAP[cand]
    low = haystack.lower()
    padded = f" {low} "
    for name in sorted(RETAILER_MAP.keys(), key=len, reverse=True):
        if f" {name} " in padded:
            return RETAILER_MAP[name]
    return "online"


def _extract_price(title: str, summary: str):
    prices = []
    for src in (title, summary):
        for m in PRICE_RE.finditer(src or ""):
            try:
                p = float(m.group(1).replace(",", ""))
                if 0 < p < 100000:
                    prices.append(p)
            except ValueError:
                pass
    if not prices:
        return "", ""
    cur = min(prices)
    rest = sorted(set(prices) - {cur})
    if rest and rest[-1] >= cur * 1.2:
        return f"${cur:.2f}", f"${rest[-1]:.2f}"
    return f"${cur:.2f}", ""


def parse_slickdeals(raw: str):
    parsed = feedparser.parse(raw)
    today = today_str()
    items = []
    for entry in parsed.entries[:40]:
        title = clean(getattr(entry, "title", "") or "")
        if not title:
            continue
        summary = clean(TAG_STRIP.sub("", html.unescape(getattr(entry, "summary", "") or "")))
        link = (getattr(entry, "link", "") or "").split("?")[0]
        store_id = _retailer_for(title, summary)
        cur, orig = _extract_price(title, summary)
        # Slickdeals frontpage RSS carries no media thumbnails (verified
        # 2026-11-22) — this is defensive only.
        thumb = ""
        media = getattr(entry, "media_thumbnail", None) or []
        if media:
            thumb = clean_image_url((media[0] or {}).get("url", ""))
        items.append(make_item(title, store_id, "slickdeals.net",
                               kind="deal", upc="", price=cur, was=orig,
                               valid_to=today, url=link, image=thumb))
    return items


# ----------------------------------------------------------------- images
# Image enrichment for items whose list page carries no photo.
# Priority per item: list-page photo > previous-feed cache > Open Food Facts
# > UPCitemdb (paid key only). The previous feed is the image cache — no
# new committed files, and a UPC is looked up at most once per rotation.
OFF_BASE = "https://world.openfoodfacts.org/api/v2/product/"
OFF_UA = "PennyAlerts/0.1"
UPCDB_PAID = "https://api.upcitemdb.com/prod/v1/lookup"


def load_image_cache() -> dict:
    """UPC -> image URL from the previous feed/weekly.json (if any)."""
    cache = {}
    try:
        with open(OUT_PATH, encoding="utf-8") as f:
            prev = json.load(f)
        for it in prev.get("items", []) or []:
            if it.get("upc") and it.get("image"):
                cache.setdefault(it["upc"], it["image"])
    except Exception:
        pass
    return cache


def rotate_candidates(upcs, today: str):
    """Deterministic per-day rotation so every imageless UPC gets a fair
    shot at the lookup caps over successive runs, instead of the same
    misses blocking the front of the queue every day."""
    return sorted(upcs, key=lambda u: hashlib.md5((u + today).encode()).hexdigest())


def off_image(client: httpx.Client, upc: str) -> str:
    """Open Food Facts (free, no key, food/grocery only). Returns an image
    URL or ''. Never raises."""
    try:
        resp = client.get(OFF_BASE + upc + ".json", timeout=15.0,
                          headers={"User-Agent": OFF_UA})
    except httpx.HTTPError:
        return ""
    if resp.status_code != 200:
        return ""
    try:
        data = resp.json()
    except Exception:
        return ""
    if data.get("status") != 1:
        return ""
    img = ((data.get("product") or {}).get("image_url") or "").strip()
    return clean_image_url(img, OFF_BASE)


def upcdb_image(client: httpx.Client, upc: str, key: str):
    """UPCitemdb paid endpoint. Returns (image_url_or_'', rate_limited).
    Only called when UPCITEMDB_KEY is set. The keyless trial endpoint is
    NOT used: it is 100/day per IP and returns 429 EXCEED_LIMIT with 0
    remaining from shared IPs (this VM and GitHub Actions runners) —
    verified live 2026-11-22. key_type comes from the UPCitemdb account
    page (DEV keys use 3); override with UPCITEMDB_KEY_TYPE if it shows
    a different value."""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "user_key": key,
        "key_type": os.environ.get("UPCITEMDB_KEY_TYPE", "3"),
    }
    try:
        resp = client.get(UPCDB_PAID, params={"upc": upc}, headers=headers,
                          timeout=20.0)
    except httpx.HTTPError:
        return "", False
    if resp.status_code == 429:
        return "", True
    if resp.status_code != 200:
        return "", False
    try:
        data = resp.json()
    except Exception:
        return "", False
    items = data.get("items") or []
    if not items:
        return "", False
    imgs = items[0].get("images") or []
    return (clean_image_url(imgs[0], UPCDB_PAID) if imgs else ""), False


def drop_shared_images(deduped):
    """A URL covering >50% of one source's items (and >=5 items) is a page
    header/section photo, not a product photo — drop it for that source.
    (Krazy Coupon Lady and FreeStuffFinder both embed one generic Dollar
    General store photo above their lists; verified 2026-11-22.)"""
    from collections import Counter
    per_source = {}
    for it in deduped:
        if it.get("image"):
            per_source.setdefault(it["source"], Counter())[it["image"]] += 1
    for src, counts in per_source.items():
        total = sum(1 for it in deduped if it["source"] == src)
        for url, n in counts.items():
            if n >= 5 and n > total / 2:
                for it in deduped:
                    if it["source"] == src and it.get("image") == url:
                        it["image"] = ""


# ------------------------------------------------------------------- sources
# (key, display name, url, kind) — kind "fetch" means parse it, "link-only"
# means record it as a manual link with a reason, never fetched for items.
SOURCES = [
    ("freebie-guy-dg", "Freebie Guy — DG penny list",
     "https://THEFREEBIEGUY.COM/DOLLAR-GENERAL-PENNY-SHOPPING-MASTER-LIST/", "fetch"),
    ("retailshout-dg", "RetailShout — DG penny items",
     "https://retailshout.com/latest-dollar-general-penny-items-near-you/", "fetch"),
    ("kcl-dg", "Krazy Coupon Lady — DG penny list",
     "https://thekrazycouponlady.com/tips/store-hacks/dollar-general-penny-list", "fetch"),
    ("pennypinchinmom-dg", "PennyPinchinMom — DG penny list",
     "https://pennypinchinmom.com/dollar-general-penny-list/", "fetch"),
    ("freestufffinder-dg", "FreeStuffFinder — DG penny list",
     "https://freestufffinder.com/dollar-general-penny-list/", "fetch"),
    ("savingk-walmart", "SavingK — Walmart hidden clearance",
     "https://savingk.com/walmart-hidden-clearance-how-to-find-these-secret-deals/", "link-only"),
    ("slickdeals", "Slickdeals — frontpage deals",
     SLICKDEALS_URL, "fetch"),
    ("pennyrecon-hd", "PennyRecon — Home Depot penny items",
     "https://www.pennyrecon.com/", "fetch"),
    ("freebie-guy-rss", "Freebie Guy — RSS",
     "https://thefreebieguy.com/feed/", "fetch"),
    ("pennypinchinmom-rss", "PennyPinchinMom — RSS",
     "https://pennypinchinmom.com/feed/", "fetch"),
    ("kcl-hd", "Krazy Coupon Lady — Home Depot penny items",
     "https://thekrazycouponlady.com/tips/store-hacks/home-depot-penny-items", "link-only"),
    ("freebie-guy-hd", "Freebie Guy — Home Depot penny list",
     "https://thefreebieguy.com/home-depot-penny-list/", "link-only"),
]

LINK_ONLY_NOTES = {
    "savingk-walmart": "Guide page only — no parseable deal database exists; open the page to read it.",
    "kcl-hd": "Page loads but the list is not in the static HTML (JS-rendered) — open it in a browser.",
    "freebie-guy-hd": "Page returns 404 (removed) — kept as a link in case it comes back.",
}


def run_source(client: httpx.Client, key: str, name: str, url: str, kind: str):
    """Returns (items, status_dict). Never raises."""
    if kind == "link-only":
        return [], {"name": name, "url": url, "status": "link-only",
                    "item_count": 0, "note": LINK_ONLY_NOTES.get(key, "")}
    try:
        body, err = safe_get(client, url)
        if body is None:
            status = "blocked" if err and "blocked" in err else "failed"
            return [], {"name": name, "url": url, "status": status,
                        "item_count": 0, "note": err or "fetch failed"}
        if key == "freebie-guy-dg":
            items = extract_upc_lines(body, "dollar-general", "thefreebieguy.com", url)
        elif key == "retailshout-dg":
            items = parse_retailshout(body)
        elif key == "kcl-dg":
            items = extract_upc_lines(body, "dollar-general", "krazycouponlady.com", url)
        elif key == "pennypinchinmom-dg":
            items = parse_ppm_table(body)
        elif key == "freestufffinder-dg":
            items = extract_upc_lines(body, "dollar-general", "freestufffinder.com", url)
        elif key == "slickdeals":
            items = parse_slickdeals(body)
        elif key == "pennyrecon-hd":
            items = parse_pennyrecon(body)
        elif key in ("freebie-guy-rss", "pennypinchinmom-rss"):
            src = "thefreebieguy.com" if key == "freebie-guy-rss" else "pennypinchinmom.com"
            items, _err = parse_rss(body, src)
        else:
            items = []
        return items, {"name": name, "url": url, "status": "ok",
                       "item_count": len(items)}
    except Exception as e:  # one bad source must never kill the run
        return [], {"name": name, "url": url, "status": "failed",
                    "item_count": 0, "note": f"{type(e).__name__}: {e}"}


def main() -> int:
    with httpx.Client(
        headers={"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9"},
        timeout=60.0,
    ) as client:
        all_items = []
        statuses = []
        for key, name, url, kind in SOURCES:
            items, status = run_source(client, key, name, url, kind)
            statuses.append(status)
            all_items.extend(items)
            print(f"{key:22} {status['status']:9} {status['item_count']:4} items"
                  + (f" — {status['note']}" if status.get("note") else ""))

        # Dedupe: by UPC first (keep the first source's copy), else name+retailer.
        # A later copy replaces an earlier one when it has a photo and the
        # earlier one does not — the photo is the more useful copy. Item
        # identity (UPC, else name+retailer) never changes, so the push
        # sender's diff is unaffected by the image field.
        seen_upc = {}
        seen_name = {}
        deduped = []
        for it in all_items:
            if it["upc"]:
                idx = seen_upc.get(it["upc"])
                if idx is None:
                    seen_upc[it["upc"]] = len(deduped)
                    deduped.append(it)
                elif it.get("image") and not deduped[idx].get("image"):
                    it["first_seen"] = min(it["first_seen"], deduped[idx]["first_seen"])
                    deduped[idx] = it
            else:
                k = (it["name"].lower(), it["retailer"])
                idx = seen_name.get(k)
                if idx is None:
                    seen_name[k] = len(deduped)
                    deduped.append(it)
                elif it.get("image") and not deduped[idx].get("image"):
                    it["first_seen"] = min(it["first_seen"], deduped[idx]["first_seen"])
                    deduped[idx] = it
        deduped.sort(key=lambda d: (d["retailer"], d["name"].lower()))

        # Shared decorative images (page header photos) are not product
        # photos — drop them before enrichment.
        drop_shared_images(deduped)

        # Image cache: the previous feed, read before this run overwrites it.
        cache = load_image_cache()
        for it in deduped:
            if not it.get("image") and it.get("upc") and it["upc"] in cache:
                it["image"] = cache[it["upc"]]

        # Open Food Facts enrichment (free, no key) for UPCs still imageless.
        today = today_str()
        off_cap = int(os.environ.get("OFF_LOOKUPS_PER_RUN", "150"))
        need = sorted({it["upc"] for it in deduped
                       if it.get("upc") and not it.get("image")})
        need = rotate_candidates(need, today)[:off_cap]
        off_hits = 0
        for i, upc in enumerate(need):
            img = off_image(client, upc)
            if img:
                off_hits += 1
                for it in deduped:
                    if it.get("upc") == upc and not it.get("image"):
                        it["image"] = img
            if i < len(need) - 1:
                time.sleep(1.0)
        print(f"openfoodfacts: {off_hits}/{len(need)} UPCs got an image")

        # UPCitemdb enrichment, paid key only. Without a key this is skipped
        # entirely (the keyless trial is unusable from shared IPs — see
        # upcdb_image). The optional step is in README.md.
        key = os.environ.get("UPCITEMDB_KEY", "")
        if key:
            cap = int(os.environ.get("UPCITEMDB_LOOKUPS_PER_RUN", "30"))
            need2 = rotate_candidates(sorted(
                {it["upc"] for it in deduped
                 if it.get("upc") and not it.get("image")}), today)[:cap]
            hits = 0
            stopped = False
            for i, upc in enumerate(need2):
                img, limited = upcdb_image(client, upc, key)
                if limited:
                    print("upcitemdb: rate-limited, stopping lookups for this run")
                    stopped = True
                    break
                if img:
                    hits += 1
                    for it in deduped:
                        if it.get("upc") == upc and not it.get("image"):
                            it["image"] = img
                if i < len(need2) - 1:
                    time.sleep(2.1)
            print(f"upcitemdb: {hits}/{len(need2)} UPCs got an image"
                  + (" (stopped early)" if stopped else ""))
        else:
            print("upcitemdb: skipped (no UPCITEMDB_KEY)")

        # Coverage report — the honest numbers for this run.
        total = len(deduped)
        with_img = sum(1 for it in deduped if it.get("image"))
        print(f"images: {with_img}/{total} items "
              f"({(100 * with_img // total) if total else 0}%)")
        for src in sorted({it["source"] for it in deduped}):
            s_items = [it for it in deduped if it["source"] == src]
            s_img = sum(1 for it in s_items if it.get("image"))
            print(f"  {src:22} {s_img}/{len(s_items)}")

        feed = {
            "generated_at": utc_now_iso(),
            "sources": statuses,
            "items": deduped,
        }
        if not deduped:
            print("ERROR: zero items parsed — keeping the existing feed (if any).")
            return 1
        os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
        with open(OUT_PATH, "w", encoding="utf-8") as f:
            json.dump(feed, f, indent=2, sort_keys=True, ensure_ascii=False)
            f.write("\n")
        print(f"Wrote {OUT_PATH}: {len(deduped)} items from "
              f"{sum(1 for s in statuses if s['status'] == 'ok')} ok sources.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
