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
from datetime import datetime, timedelta, timezone
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


_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11,
    "december": 12, "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}
_MONTH_RE = (r"(January|February|March|April|May|June|July|August|September|"
             r"October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|"
             r"Oct|Nov|Dec)\.?")


def parse_list_date(text: str, default_year: int | None = None) -> str:
    """Parse a list-section date out of free text. Accepts 'November 17,
    2026', 'Nov 20, 2026', 'November 10th' (year defaults to the run year),
    and '11/24/2026'. Returns 'YYYY-MM-DD' or '' when nothing parses."""
    if not text:
        return ""
    if default_year is None:
        default_year = datetime.now(timezone.utc).year
    m = re.search(
        _MONTH_RE + r"\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?",
        text, re.IGNORECASE)
    if m:
        month = _MONTHS[m.group(1).lower().rstrip(".")]
        day = int(m.group(2))
        year = int(m.group(3)) if m.group(3) else default_year
        try:
            return datetime(year, month, day).date().isoformat()
        except ValueError:
            return ""
    m = re.search(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b", text)
    if m:
        try:
            return datetime(int(m.group(3)), int(m.group(1)),
                            int(m.group(2))).date().isoformat()
        except ValueError:
            return ""
    return ""


def normalize_upc(upc: str) -> str:
    """One canonical form for a UPC: whitespace stripped; an 11-digit UPC-A
    (leading zero dropped, as RetailShout publishes) is padded back to 12.
    12- and 13-digit codes pass through unchanged. Dedupe keys on this —
    without it the same product enters twice (23 duplicates in the
    2026-11-22 feed)."""
    upc = re.sub(r"\s+", "", str(upc or ""))
    if re.fullmatch(r"\d{11}", upc):
        return "0" + upc
    return upc


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
              valid_to="", url="", image="", list_date=""):
    name = clean(name)[:140] or "Unknown item"
    return {
        "name": name,
        "upc": normalize_upc(upc),
        "price": price,
        "was": was,
        "retailer": retailer,
        "department": department_for(name, kind),
        "source": source,
        "first_seen": today_str(),
        "valid_to": valid_to,
        "url": url,
        "image": image,
        # Date of the list section this item came from (YYYY-MM-DD).
        # '' here means "unknown yet" — main() fills it from first_seen.
        "list_date": list_date or "",
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


def extract_og_image(html_text: str, base_url: str = "") -> str:
    """og:image from a page (Slickdeals deal pages, any per-item page).
    Fallback: the largest sensible <img> (>=200px on a side, by width/
    height attrs or a WxH size in the URL), skipping logos/icons/pixels.
    Returns a validated absolute URL or ''."""
    try:
        tree = HTMLParser(html_text)
    except Exception:
        return ""
    for sel in ('meta[property="og:image"]', 'meta[property="og:image:url"]',
                'meta[name="og:image"]'):
        el = tree.css_first(sel)
        if el is not None:
            url = clean_image_url((el.attributes or {}).get("content", ""), base_url)
            if url:
                return url
    skip = ("logo", "icon", "pixel", "spacer", "avatar", "1x1", "tracking")
    best_url, best_area = "", 0
    for img in tree.css("img"):
        attrs = img.attributes or {}
        src = attrs.get("src") or attrs.get("data-src") or attrs.get("data-lazy-src") or ""
        if not src or src.startswith("data:"):
            continue
        low = src.lower()
        if any(s in low for s in skip):
            continue
        w = h = 0
        try:
            w = int(attrs.get("width") or 0)
            h = int(attrs.get("height") or 0)
        except ValueError:
            pass
        if not (w and h):
            m = re.search(r"(\d{3,4})x(\d{3,4})", src)
            if m:
                w, h = int(m.group(1)), int(m.group(2))
        if w >= 200 and h >= 200 and w * h > best_area:
            url = clean_image_url(src, base_url)
            if url:
                best_url, best_area = url, w * h
    return best_url


def og_image_for_url(client: httpx.Client, url: str) -> str:
    """Fetch a per-item page and extract its og:image (or largest img).
    One retry on transient transport errors; never raises."""
    for attempt in range(2):
        try:
            resp = client.get(url, timeout=20.0, follow_redirects=True,
                              headers={"Referer": urljoin(url, "/")})
        except httpx.HTTPError:
            if attempt == 0:
                time.sleep(1.0)
                continue
            return ""
        if resp.status_code != 200:
            return ""
        body = resp.text or ""
        if any(m in body for m in CF_MARKERS):
            return ""
        return extract_og_image(body, url)
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
def extract_upc_lines(html_text: str, retailer: str, source: str, base_url: str = "",
                      list_date: str = ""):
    """Penny Hunter penny_pages.py approach: UPC-line regex over list text.
    Also captures a nearby <img> per item when the markup has one.
    list_date tags every item with the date of the list it came from
    ('' = unknown, filled from first_seen in main())."""
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
        upc = normalize_upc(m.group("upc"))
        if upc in seen:
            continue
        seen.add(upc)
        items.append(make_item(item, retailer, source, kind="penny",
                               upc=upc, price="$0.01",
                               image=nearest_image(el, base_url),
                               list_date=list_date))
    return items


def extract_upc_lines_tracked(html_text: str, retailer: str, source: str,
                              base_url: str = "", this_week_date: str = ""):
    """Section-aware UPC-line extraction for pages that stack several weekly
    lists (Krazy Coupon Lady, FreeStuffFinder). Walks li/p/h2/h3/h4 in
    document order, tracking the current list section:
    - a heading 'Penny Items for <Month> <day>' sets the current list date
      (year = run year; a date in the future is last year's — these are
      archive pages, a future-dated section cannot be real);
    - a heading starting "This Week's" sets the current date to
      this_week_date (the page's H1 date, e.g. KCL's Nov 3);
    - a heading starting "Past" clears the current date (past lists on
      that page carry no dates — those items fall back to the run date).
    Items found before any dated heading get the run date."""
    tree = HTMLParser(html_text)
    today = today_str()
    seen = set()
    items = []
    current_date = None
    for el in tree.css("li, p, h2, h3, h4"):
        text = clean(el.text(separator=" "))
        if not (5 < len(text) < 300):
            continue
        if el.tag in ("h2", "h3", "h4"):
            low = text.lower()
            if low.startswith("this week"):
                current_date = this_week_date or today
            elif low.startswith("past"):
                current_date = None
            else:
                d = parse_list_date(text)
                if d:
                    if d > today:  # archive page: future section date is last year's
                        y, mo, dy = (int(p) for p in d.split("-"))
                        d = datetime(y - 1, mo, dy).date().isoformat()
                    current_date = d
        if any(text.lower().startswith(p) for p in _NOISE_PREFIXES):
            continue
        m = UPC_LINE.search(text)
        if not m:
            continue
        item = m.group("item").strip(" -–—:")
        upc = normalize_upc(m.group("upc"))
        if upc in seen:
            continue
        seen.add(upc)
        items.append(make_item(item, retailer, source, kind="penny",
                               upc=upc, price="$0.01",
                               image=nearest_image(el, base_url),
                               list_date=current_date or today))
    return items


def extract_fg_dg(html_text: str, base_url: str = ""):
    """Freebie Guy DG master list. The page's CURRENT section has no
    itemized list at all (category names only, verified 2026-11-22) — the
    items live in collapsed <details> blocks under 'Previous 4 Dollar
    General Penny Lists', each with a dated <summary>. Items are tagged
    with their block's date; anything outside a <details> block (the
    current section, if it ever gains items) gets the page's 'Effective'
    date, else the run date."""
    tree = HTMLParser(html_text)
    today = today_str()
    eff_m = re.search(r"Effective\s+[^<\n]{0,80}", html_text)
    eff = parse_list_date(eff_m.group(0)) if eff_m else ""
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
        upc = normalize_upc(m.group("upc"))
        if upc in seen:
            continue
        seen.add(upc)
        list_date = ""
        node = el
        found_details = False
        while node is not None:
            if getattr(node, "tag", "") == "details":
                found_details = True
                summary = node.css_first("summary") if hasattr(node, "css_first") else None
                if summary is not None:
                    list_date = parse_list_date(clean(summary.text()))
                break
            node = getattr(node, "parent", None)
        if not found_details:
            list_date = eff or today
        items.append(make_item(item, "dollar-general", "thefreebieguy.com",
                               kind="penny", upc=upc, price="$0.01",
                               image=nearest_image(el, base_url),
                               list_date=list_date or today))
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
        if not re.fullmatch(r"\d{11,13}", upc):
            continue
        upc = normalize_upc(upc)
        if upc in seen:
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
                       kind="penny", upc=upc, price="$0.01", image=img,
                       # The card's own penny date ("Penny Date: Nov 20,
                       # 2026") is the list date for this item.
                       list_date=parse_list_date(note) or today_str())
        if note:
            it["note"] = note
        items.append(it)
    return items


def parse_ppm_table(html_text: str, list_date: str = ""):
    """PennyPinchinMom: a table, one row per item — name | UPC.
    list_date is the date in the page title (e.g. 11/24/2026)."""
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
        upc = normalize_upc(m.group(0))
        if upc in seen:
            continue
        seen.add(upc)
        items.append(make_item(name, "dollar-general", "pennypinchinmom.com",
                               kind="penny", upc=upc, price="$0.01",
                               list_date=list_date or today_str()))
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
        last = ""
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
                # "Last seen | today" (or a date) is this item's list date.
                lm = re.search(
                    r"Last seen\s*\|\s*([A-Za-z]+\s+\d{1,2}(?:,?\s*\d{4})?|today|yesterday)",
                    clean(node.text(separator=" ")), re.IGNORECASE)
                if lm:
                    v = lm.group(1).strip().lower()
                    if v == "today":
                        last = today_str()
                    elif v == "yesterday":
                        last = (datetime.now(timezone.utc)
                                - timedelta(days=1)).date().isoformat()
                    else:
                        last = parse_list_date(lm.group(1))
                break
        it = make_item(name, "home-depot", "pennyrecon.com",
                       kind="penny", upc="", price="$0.01",
                       was=retail, url=url, image=img,
                       list_date=last or today_str())
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
# > Open Products Facts > og:image from the item's own page (Slickdeals)
# > UPCitemdb (paid key only). The previous feed is the image cache — no
# new committed files, and a UPC is looked up at most once per rotation.
OFF_BASE = "https://world.openfoodfacts.org/api/v2/product/"
OFF_UA = "PennyAlerts/0.1"
UPCDB_PAID = "https://api.upcitemdb.com/prod/v1/lookup"


def load_first_seen_map() -> dict:
    """(key -> first_seen) from the previous feed/weekly.json, so a re-run
    doesn't stamp every old item with today's date. Key is ('upc', upc)
    or ('name', (name.lower(), retailer)) — the same identity dedupe uses."""
    prev = {}
    try:
        with open(OUT_PATH, encoding="utf-8") as f:
            data = json.load(f)
        for it in data.get("items", []) or []:
            fs = it.get("first_seen") or ""
            if not fs:
                continue
            if it.get("upc"):
                prev.setdefault(("upc", normalize_upc(it["upc"])), fs)
            else:
                prev.setdefault(("name", (str(it.get("name", "")).lower(),
                                         it.get("retailer", ""))), fs)
    except Exception:
        pass
    return prev


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


def opf_image(client: httpx.Client, upc: str) -> str:
    """Open Products Facts (free, no key, general products — the
    non-food sibling of Open Food Facts). Same API shape as off_image.
    Returns an image URL or ''. Never raises. Measured 2026-11-22: 3/15
    on a beauty/household sample (all one Huggies product family);
    Open Beauty Facts scored 0/15 on the same sample, so it is not used."""
    try:
        resp = client.get("https://world.openproductsfacts.org/api/v2/product/"
                          + upc + ".json", timeout=15.0,
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
    return clean_image_url(img, "https://world.openproductsfacts.org/")


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
]

LINK_ONLY_NOTES = {
    "savingk-walmart": "Guide page only — no parseable deal database exists; open the page to read it.",
    "kcl-hd": "Page loads but the list is not in the static HTML (JS-rendered) — open it in a browser.",
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
            items = extract_fg_dg(body, url)
        elif key == "retailshout-dg":
            items = parse_retailshout(body)
        elif key == "kcl-dg":
            # The page's H1 carries the current list's date
            # ("Dollar General Penny List Nov 3: ...").
            h1_m = re.search(r"<h1[^>]*>(.*?)</h1>", body, re.S)
            h1_date = parse_list_date(clean(h1_m.group(1))) if h1_m else ""
            items = extract_upc_lines_tracked(
                body, "dollar-general", "krazycouponlady.com", url,
                this_week_date=h1_date)
        elif key == "pennypinchinmom-dg":
            title_m = re.search(r"<title[^>]*>(.*?)</title>", body, re.S)
            ppm_date = parse_list_date(clean(title_m.group(1))) if title_m else ""
            items = parse_ppm_table(body, ppm_date)
        elif key == "freestufffinder-dg":
            items = extract_upc_lines_tracked(
                body, "dollar-general", "freestufffinder.com", url)
        elif key == "slickdeals":
            items = parse_slickdeals(body)
        elif key == "pennyrecon-hd":
            items = parse_pennyrecon(body)
        elif key in ("freebie-guy-rss", "pennypinchinmom-rss"):
            src = "thefreebieguy.com" if key == "freebie-guy-rss" else "pennypinchinmom.com"
            items, _err = parse_rss(body, src)
        else:
            items = []
        status = {"name": name, "url": url, "status": "ok",
                  "item_count": len(items)}
        if key == "pennyrecon-hd":
            # The site lists more items than have detail pages; only the
            # latter are parseable. Say so instead of silently showing a
            # subset (2026-11-22: 304 live, 166 with /item/ links).
            tm = re.search(r"(\d+)\s+live \$0\.01 items", body)
            if tm:
                status["note"] = (f"{len(items)} of {tm.group(1)} live on site "
                                  "— only items with detail pages are parsed")
        return items, status
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

        # Dedupe: by UPC first (normalized — see normalize_upc), else
        # name+retailer. FIRST source wins, always: a later copy never
        # replaces the kept item (the old code did exactly that when the
        # later copy had an image, which stole 83 of Freebie Guy's 135
        # UPCs for other sources). A later copy may only LEND its image
        # when the kept copy has none. Every source that listed the item
        # is recorded on the kept copy (sources / source_count) BEFORE
        # the duplicates are dropped — that is what the app's "Most
        # verified" sort ranks on. list_date keeps the LATEST listing
        # date (the freshest confirmation the item is still a penny);
        # first_seen keeps the earliest.
        seen_upc = {}
        seen_name = {}
        deduped = []
        for it in all_items:
            if it["upc"]:
                idx = seen_upc.get(it["upc"])
                if idx is None:
                    seen_upc[it["upc"]] = len(deduped)
                    it["sources"] = [it["source"]]
                    it["source_count"] = 1
                    deduped.append(it)
                    continue
            else:
                k = (it["name"].lower(), it["retailer"])
                idx = seen_name.get(k)
                if idx is None:
                    seen_name[k] = len(deduped)
                    it["sources"] = [it["source"]]
                    it["source_count"] = 1
                    deduped.append(it)
                    continue
            kept = deduped[idx]
            if it["source"] not in kept["sources"]:
                kept["sources"].append(it["source"])
                kept["source_count"] = len(kept["sources"])
            if it.get("image") and not kept.get("image"):
                kept["image"] = it["image"]
            if it["first_seen"] < kept["first_seen"]:
                kept["first_seen"] = it["first_seen"]
            if it.get("list_date") and (not kept.get("list_date")
                                        or it["list_date"] > kept["list_date"]):
                kept["list_date"] = it["list_date"]
        deduped.sort(key=lambda d: (d["retailer"], d["name"].lower()))

        # Preserve first_seen from the previous feed (per UPC, else
        # name+retailer): without this every re-run re-stamps old items
        # with today's date and "Most recent" can never tell a new item
        # from an old one. Items with no list_date yet fall back to
        # first_seen (RSS/Slickdeals items carry no list date).
        prev_seen = load_first_seen_map()
        for it in deduped:
            key = (("upc", it["upc"]) if it.get("upc")
                   else ("name", (it["name"].lower(), it["retailer"])))
            if key in prev_seen:
                it["first_seen"] = prev_seen[key]
            if not it.get("list_date"):
                it["list_date"] = it["first_seen"]

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

        # Open Products Facts enrichment (free, no key) for UPCs still
        # imageless — the non-food sibling of Open Food Facts.
        opf_cap = int(os.environ.get("OPF_LOOKUPS_PER_RUN", "150"))
        need_opf = sorted({it["upc"] for it in deduped
                           if it.get("upc") and not it.get("image")})
        need_opf = rotate_candidates(need_opf, today)[:opf_cap]
        opf_hits = 0
        for i, upc in enumerate(need_opf):
            img = opf_image(client, upc)
            if img:
                opf_hits += 1
                for it in deduped:
                    if it.get("upc") == upc and not it.get("image"):
                        it["image"] = img
            if i < len(need_opf) - 1:
                time.sleep(1.0)
        print(f"openproductsfacts: {opf_hits}/{len(need_opf)} UPCs got an image")

        # og:image enrichment for items with a per-item page but no image
        # (Slickdeals deal pages — RSS carries no thumbnails and the
        # items have no UPCs, so this is their only photo source).
        og_cap = int(os.environ.get("OG_LOOKUPS_PER_RUN", "40"))
        need_og = [it for it in deduped if it.get("url") and not it.get("image")][:og_cap]
        og_hits = 0
        for i, it in enumerate(need_og):
            img = og_image_for_url(client, it["url"])
            if img:
                og_hits += 1
                it["image"] = img
            if i < len(need_og) - 1:
                time.sleep(1.0)
        print(f"og:image: {og_hits}/{len(need_og)} linked items got an image")

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
