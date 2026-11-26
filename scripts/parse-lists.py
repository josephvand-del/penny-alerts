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
              valid_to="", url="", image="", list_date="", is_stack=False,
              steps=None):
    name = clean(name)[:140] or "Unknown item"
    return {
        "name": name,
        "kind": kind,
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
        # '' means unknown — never the run date, never filled in later.
        "list_date": list_date or "",
        # Coupon-stack / bundle deal (lives on the Bundles tab, not Deals).
        "is_stack": bool(is_stack),
        # How-to steps, copied ONLY from the source's own text (coupon
        # lines, thread scenario sentences). [] = the source gave no
        # usable steps; the app shows its generic checklist instead.
        # Never invented.
        "steps": [clean(s) for s in (steps or []) if clean(s)][:6],
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
    """GET a URL. Returns (text_or_None, error_or_None). A single retry
    on timeout/connection errors: DealNews' editors feed answered 200
    in ~1s on three manual retries after timing out twice inside parser
    runs (Nov 23, 2026) — a slow moment, not a dead source. One retry
    keeps a flaky minute from dropping a source for the whole day."""
    last_err = None
    for attempt in range(2):
        try:
            resp = client.get(url, timeout=timeout, follow_redirects=True)
        except httpx.HTTPError as e:
            last_err = f"{type(e).__name__}"
            if attempt == 0:
                time.sleep(3)
                continue
            return None, last_err
        if resp.status_code != 200:
            return None, f"HTTP {resp.status_code}"
        body = resp.text or ""
        if any(m in body for m in CF_MARKERS):
            return None, "blocked (bot challenge)"
        return body, None
    return None, last_err or "fetch failed"


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
      that page carry no dates — those items get '' (unknown), never
      the run date).
    Items found before any dated heading get '' (unknown)."""
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
                current_date = this_week_date or ""
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
                               list_date=current_date or ""))
    return items


def extract_fg_dg(html_text: str, base_url: str = ""):
    """Freebie Guy DG master list. The page's CURRENT section has no
    itemized list at all (category names only, verified 2026-11-22) — the
    items live in collapsed <details> blocks under 'Previous 4 Dollar
    General Penny Lists', each with a dated <summary>. Items are tagged
    with their block's date; anything outside a <details> block (the
    current section, if it ever gains items) gets the page's 'Effective'
    date, else '' (unknown)."""
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
            list_date = eff or ""
        items.append(make_item(item, "dollar-general", "thefreebieguy.com",
                               kind="penny", upc=upc, price="$0.01",
                               image=nearest_image(el, base_url),
                               list_date=list_date or ""))
    return items


def parse_retailshout(html_text: str, retailer: str = "dollar-general",
                      prefix: str = "dg"):
    """RetailShout penny-item cards (DG verified 2026-11-22, DT verified
    2026-11-25): .<prefix>-penny-item cards (h4 name, penny date, UPC
    span). DG cards are <li>, DT cards are <div> — the selector is
    class-only, tag-agnostic. DT cards also carry a price line ('Was
    $6.00 → now $0.01') — the was price is kept (it is the savings for
    the Biggest-deals sort) — and a SKU, which rides in the note (the
    app shows the UPC on the card). The card's own penny date ('Penny
    Date: Nov 20, 2026' / 'Date Pennied: Sep 17, 2026') is the list
    date for this item. Penny items never get a stop date (see main)."""
    tree = HTMLParser(html_text)
    items = []
    seen = set()
    for card in tree.css(f".{prefix}-penny-item"):
        upc_el = card.css_first(f"span.{prefix}-penny-upc")
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
        date_el = card.css_first(f"p.{prefix}-penny-date")
        name = clean(name_el.text()) if name_el else "Penny item"
        note = clean(date_el.text()) if date_el else ""
        was = ""
        price_el = card.css_first(f"p.{prefix}-penny-price")
        if price_el is not None:
            wm = re.search(r"[Ww]as\s*\$([\d,]+(?:\.\d{2})?)",
                           clean(price_el.text()))
            if wm:
                try:
                    was = f"${float(wm.group(1).replace(',', '')):.2f}"
                except ValueError:
                    was = ""
        sku_el = card.css_first(f"span.{prefix}-penny-sku")
        if sku_el is not None:
            sku = clean(sku_el.text())
            if sku:
                note = (note + f" · SKU {sku}") if note else f"SKU {sku}"
        # Each card carries its own product photo (webp on retailshout.com).
        # DT cards lazy-load: src is a data: placeholder and the real URL
        # is data-lazy-src — prefer the lazy attributes first (DG cards
        # carry a plain src and fall through to it).
        img = ""
        img_el = card.css_first("img")
        if img_el is not None:
            attrs = img_el.attributes or {}
            img = clean_image_url(
                attrs.get("data-lazy-src") or attrs.get("data-src")
                or attrs.get("src") or "",
                "https://retailshout.com/")
        it = make_item(name, retailer, "retailshout.com",
                       kind="penny", upc=upc, price="$0.01", was=was,
                       image=img,
                       # The card's own penny date ("Penny Date: Nov 20,
                       # 2026") is the list date for this item.
                       list_date=parse_list_date(note) or "")
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
                               list_date=list_date or ""))
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
                       list_date=last or "")
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
    "kohls": "kohls",
    "kohl's": "kohls",
    "jcpenney": "jcp",
    "jcp": "jcp",
    "michaels": "michaels",
    "lowes": "lowes",
    "lowe's": "lowes",
    "best buy": "best-buy",
    "amazon": "amazon",
    "walmart": "wm-ct",
    "home depot": "home-depot",
    "hobby lobby": "hobby-lobby",
    "sephora": "sephora",
    "ulta": "ulta",
    "publix": "publix",
    "under armour": "under-armour",
    "belk": "belk",
    "nike": "nike",
    "lululemon": "lululemon",
    "macys": "macys",
    "macy's": "macys",
    "bj's": "bjs",
    "rite aid": "rite-aid",
}
TITLE_STORE_HINTS = {
    "dollar general": "dollar-general",
    " dg ": "dollar-general",
    "target": "target",
    "cvs": "cvs",
    "walgreens": "walgreens",
    "meijer": "meijer",
    "kroger": "kroger",
    "kohls": "kohls",
    "kohl's": "kohls",
    "jcpenney": "jcp",
    "jcp": "jcp",
    "michaels": "michaels",
    "lowes": "lowes",
    "lowe's": "lowes",
    "best buy": "best-buy",
    "amazon": "amazon",
    "walmart": "wm-ct",
    "home depot": "home-depot",
    "hobby lobby": "hobby-lobby",
    "sephora": "sephora",
    "ulta": "ulta",
    "publix": "publix",
    "under armour": "under-armour",
    "belk": "belk",
    "nike": "nike",
    "lululemon": "lululemon",
    "macys": "macys",
    "macy's": "macys",
    "bj's": "bjs",
    "rite aid": "rite-aid",
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


def _entry_date(entry) -> str:
    """RSS published date as YYYY-MM-DD, or '' when the entry has none.
    Used as list_date for RSS items (a real post date, never the run date)."""
    pp = getattr(entry, "published_parsed", None)
    if pp:
        try:
            return datetime(*pp[:6], tzinfo=timezone.utc).date().isoformat()
        except Exception:
            return ""
    return ""


def parse_rss(raw: str, source_name: str):
    """Returns (items, error_or_None)."""
    parsed = feedparser.parse(raw)
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
        list_date = _entry_date(entry)
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
                                       url=link, list_date=list_date))
        elif heat == "med":
            # No source-given end date: main() assigns the stop date
            # (list_date + 7 days).
            items.append(make_item(title, store_id, source_name,
                                   kind="deal", upc="", price="",
                                   url=link, list_date=list_date))
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
    "hobby lobby": "hobby-lobby", "dick's sporting goods": "dicks",
    "dollar general": "dollar-general", "family dollar": "family-dollar",
    "dollar tree": "dollar-tree", "belk": "belk", "lululemon": "lululemon",
    "nike": "nike", "publix": "publix", "under armour": "under-armour",
    "bj's": "bjs", "macy's": "macys",
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
    """Deal price from a title + summary (Slickdeals, DealNews, TT).

    The price is the FIRST real $ amount in the TITLE — deal titles
    lead with the deal price ('$150 + Free Shipping w/ Walmart+ or on
    $35+'). NEVER take the minimum across title+summary: the summary
    is full of incidental amounts ('$1 Walmart+ trial available', 'on
    $35+') that are not the price. The Blackstone griddle (title $150,
    summary '$1 trial') came out as price $1.00 / was $150.00 under
    the old min() rule; it is $150.00 / no was. _title_price_was
    already implements the first-price rule (plus Reg/was clauses and
    shipping-threshold stripping), so the title goes through it; the
    summary is only used, with the same rule, when the title carries
    no price at all.
    """
    cur, orig = _title_price_was(title)
    if cur:
        return cur, orig
    return _title_price_was(summary or "")


def parse_slickdeals(raw: str, force_retailer: str = "", require_title: str = "",
                     max_age_days: int | None = None, no_stack: bool = False,
                     require_text: str = "", force_stack: bool = False):
    """Slickdeals RSS (frontpage, or a store search). Adds list_date from
    the entry's published date, stack flagging (coupon-stack threads),
    and how-to steps lifted from the thread summary — only sentences
    that actually read like steps (clip/coupon/code/apply/get $/…);
    plain sale descriptions get no steps. force_retailer is the fallback
    retailer for a store search feed, used only when the thread itself
    names no store. require_title keeps only entries whose title
    contains the phrase (a relevance-ranked search returns old threads
    too); require_text is the same test against title+summary (the
    'dollar general' search is noisy — its first hit is a '1 Million
    Dollar' sweepstakes, which names no Dollar General anywhere);
    max_age_days drops entries published more than that many days
    ago; no_stack forces is_stack False (a search feed routed to Deals);
    force_stack forces is_stack True (a 'walgreens free' search is
    stack-style by construction)."""
    parsed = feedparser.parse(raw)
    today_d = datetime.now(timezone.utc).date()
    items = []
    for entry in parsed.entries[:40]:
        title = clean(getattr(entry, "title", "") or "")
        if not title:
            continue
        if require_title and require_title.lower() not in title.lower():
            continue
        summary = clean(TAG_STRIP.sub("", html.unescape(getattr(entry, "summary", "") or "")))
        if require_text and require_text.lower() not in f"{title} {summary}".lower():
            continue
        list_date = _entry_date(entry)
        if max_age_days is not None:
            if not list_date:
                continue
            try:
                age = (today_d - datetime.strptime(list_date, "%Y-%m-%d").date()).days
            except ValueError:
                continue
            if age < 0 or age > max_age_days:
                continue
        link = (getattr(entry, "link", "") or "").split("?")[0]
        # The search query already pins the store; _retailer_for still
        # wins when the thread names another store ('$6.71 With S&S @
        # Amazon' in a CVS search is an Amazon deal, not a CVS one).
        store_id = _retailer_for(title, summary)
        if store_id == "online" and force_retailer:
            store_id = force_retailer
        cur, orig = _extract_price(title, summary)
        # Slickdeals frontpage RSS carries no media thumbnails (verified
        # 2026-11-22) — this is defensive only.
        thumb = ""
        media = getattr(entry, "media_thumbnail", None) or []
        if media:
            thumb = clean_image_url((media[0] or {}).get("url", ""))
        items.append(make_item(title, store_id, "slickdeals.net",
                               kind="deal", upc="", price=cur, was=orig,
                               url=link, image=thumb,
                               list_date=list_date,
                               is_stack=True if force_stack else
                               (False if no_stack else looks_like_stack(title, summary, store_id)),
                               steps=_steps_from_text(summary)))
    return items


# ------------------------------------------------------- coupon stacks (v13)
# A "stack" is a coupon-stack / bundle deal: buy the listed items, clip
# the digitals, earn the rewards — the final price is the out-of-pocket
# after rewards. Walgreens/CVS/Target stacks come from the coupon blogs
# and deal forums in text form (Facebook reels can't be read by a script
# — no public API, login wall, video — so the same stacks are read where
# the blogs publish them with full math).

_STEP_RES = [
    r"\bclip\b", r"\bcoupon\b", r"\bcode\b", r"\bpromo\b", r"\bapply\b",
    r"\bcheckout\b", r"\brewards?\b", r"\bwags cash\b", r"\bextra ?bucks\b",
    r"\bregister rewards\b", r"\brebate\b", r"\bbogo\b",
    r"\badd\b.{0,40}\bto cart\b", r"\bget \$", r"\buse\b.{0,30}\bcoupon\b",
]


def _steps_from_text(text: str) -> list:
    """How-to steps, lifted ONLY from the source's own text: split it into
    sentences and keep the ones that read like steps (clip the coupon,
    apply the code, get $X back…). Plain sale descriptions match nothing
    and come back []. Never invented, never reworded — the sentence is
    kept verbatim (URLs and *markup* stripped)."""
    if not text:
        return []
    t = re.sub(r"https?://\S+", " ", text).replace("*", "")
    t = re.sub(r"\s+", " ", t).strip()
    if not t:
        return []
    steps = []
    for p in re.split(r"(?<=[.!?])\s+|\s*;\s*", t):
        p = clean(p)
        if not (10 <= len(p) <= 220):
            continue
        # Must read like a sentence, not a cut-off fragment ('$2.19)
        # This rebate…' starts mid-parenthetical).
        if not p[0].isalpha():
            continue
        low = p.lower()
        if any(re.search(rx, low) for rx in _STEP_RES):
            if p not in steps:
                steps.append(p)
        if len(steps) >= 5:
            break
    return steps


def looks_like_stack(title: str, summary: str, retailer: str) -> bool:
    """Is this Slickdeals thread a coupon stack? Drugstore reward phrases
    (Walgreens Cash, Register Rewards, ExtraBucks, rebate) always count;
    for Walgreens/CVS, 'ac/acs' (after coupons), 'pick up' and 'get $'
    in the title count too; for Target only an explicit bundle does."""
    text = f" {title} {summary} ".lower()
    if any(p in text for p in ("wags cash", "walgreens cash", "register rewards",
                               "extrabucks", "extra bucks", "rebate")):
        return True
    if re.search(r"\becb\b", text):
        return True
    if retailer in ("walgreens", "cvs"):
        if re.search(r"\bac\b|\bacs\b", text) or "pick up" in text \
                or "get $" in text or "bundle" in text:
            return True
    if retailer == "target" and "bundle" in text:
        return True
    return False


def _parse_relative_time(text: str) -> str:
    """'14 hours ago' / '45 minutes ago' / '2 days ago' -> the date that
    was, in UTC (the parser's clock). 'today'/'yesterday' and ISO dates
    also handled. '' when nothing parses."""
    if not text:
        return ""
    now = datetime.now(timezone.utc)
    m = re.search(r"(\d+)\s*(minute|hour|day|week)s?\s*ago", text, re.I)
    if m:
        n, unit = int(m.group(1)), m.group(2).lower()
        delta = {"minute": timedelta(minutes=n), "hour": timedelta(hours=n),
                 "day": timedelta(days=n), "week": timedelta(weeks=n)}[unit]
        return (now - delta).date().isoformat()
    low = text.strip().lower()
    if low == "today":
        return now.date().isoformat()
    if low == "yesterday":
        return (now - timedelta(days=1)).date().isoformat()
    m = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", text)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return ""


def _parse_mdy(text: str) -> str:
    """'11/22/26' (FG article dates) -> '2026-11-22'. '' when unparseable."""
    m = re.search(r"\b(\d{1,2})/(\d{1,2})/(\d{2,4})\b", text or "")
    if not m:
        return ""
    mo, dy, yr = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if yr < 100:
        yr += 2000
    try:
        return datetime(yr, mo, dy).date().isoformat()
    except ValueError:
        return ""


def parse_kcl_store(html_text: str, page_url: str, retailer: str):
    """Krazy Coupon Lady /coupons-for/<store> pages (verified 2026-11-22):
    static HTML deal cards — h3._title_, _finalPrice_ / _originalPrice_
    spans, _timestamp_ ('14 hours ago'), product photo on
    content-images.thekrazycouponlady.com. The cards carry no link and no
    coupon lines in the HTML; both live in the page's embedded deal-data
    blob (devalue-serialized): each deal object starts at
    [0,{"_id":[…], "title":[0,"…"] and holds its coupon "line" entries,
    payLinePrice/payLineDetails ('Pay $7.00, get $5 Register Rewards')
    and expiredAt just before finalPrice. Cards are matched to blob
    objects by exact title; a card with no blob match gets steps [] and
    no valid_to. The blob holds 20 deals, the page shows 11 cards —
    only the cards are emitted."""
    tree = HTMLParser(html_text)
    unesc = html.unescape(html_text)
    blob = {}
    deal_start = re.compile(
        r'\[0,\{"_id":\[0,"[A-Za-z0-9]{17,}"\],"title":\[0,"([^"]+)"\]')
    starts = [(m.start(), m.group(1)) for m in deal_start.finditer(unesc)]
    for i, (pos, title) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else pos + 15000
        seg = unesc[pos:end]
        lines = [l for l in re.findall(r'"line":\[0,"([^"]+)"\]', seg)
                 if l != "Deal availability varies by location"]
        payp = re.findall(r'"payLinePrice":\[0,([\d.]+)\]', seg)
        payd = re.findall(r'"payLineDetails":\[0,"([^"]+)"\]', seg)
        steps = list(lines)
        if payp and payd:
            try:
                steps.append(f"Pay ${float(payp[0]):.2f}, {payd[0]}")
            except ValueError:
                pass
        exp = re.findall(r'"expiredAt":\[0,"(\d{4}-\d{2}-\d{2})', seg)
        # First object wins: the blob can repeat a title (verified
        # 2026-11-22: '2 Brach's Candy Cane Packs' twice, different pay
        # lines) and the cards match the first.
        key = title.strip().lower()
        if key not in blob:
            blob[key] = (steps[:5], exp[0] if exp else "")
    items = []
    for card in tree.css("[class*='_dealCard_']"):
        title_el = card.css_first("h3[class*='_title_']") or card.css_first("h3")
        if title_el is None:
            continue
        title = clean(title_el.text())
        if not title:
            continue
        final_el = card.css_first("[class*='_finalPrice_']")
        orig_el = card.css_first("[class*='_originalPrice_']")
        final = clean(final_el.text()) if final_el is not None else ""
        orig = clean(orig_el.text()) if orig_el is not None else ""
        ts_el = card.css_first("[class*='_timestamp_']")
        list_date = _parse_relative_time(clean(ts_el.text()) if ts_el is not None else "")
        img = ""
        for im in card.css("img"):
            src = (im.attributes or {}).get("src", "") or ""
            if "content-images.thekrazycouponlady.com" in src:
                img = clean_image_url(src, page_url)
                break
        if not img:
            img = nearest_image(card, page_url)
        steps, valid_to = blob.get(title.lower(), ([], ""))
        name = title
        if final:
            name = f"{title} — {final}" + (f" (was {orig})" if orig else "")
        items.append(make_item(name, retailer, "krazycouponlady.com",
                               kind="deal", price=final, was=orig,
                               valid_to=valid_to, url=page_url, image=img,
                               list_date=list_date, is_stack=True, steps=steps))
    return items


def _title_price_was(title: str):
    """First real $ amount in a deal-post title -> (price, was).
    '$3.xx' placeholders ('$3.xx Each' = 'three-something') are NOT a
    price and are skipped; the 'Reg. $X' clause is the was price, never
    the price (a Scott post reading '$3.xx Each (Reg. $5)' must not come
    out as price $5.00); a was price at or below the price is dropped.
    A '$47 Worth … Only $1.38' title is was $47.00 / price $1.38 — the
    worth amount is never the price."""
    t = re.sub(r"\$\s*[\d,]+(?:\.\d+)?\s*\.xx", "", title, flags=re.I)
    was = ""
    wm = re.search(r"(?:reg\.?|was|retail)\s*\$([\d,]+(?:\.\d{2})?)", t, re.I)
    if wm:
        try:
            was = f"${float(wm.group(1).replace(',', '')):.2f}"
        except ValueError:
            was = ""
    if not was:
        wm2 = re.search(r"\$([\d,]+(?:\.\d{2})?)\s*(?:worth|value)\b", t, re.I) \
            or re.search(r"(?:worth|value)\s*(?:of\s*)?\$([\d,]+(?:\.\d{2})?)", t, re.I)
        if wm2:
            try:
                was = f"${float(wm2.group(1).replace(',', '')):.2f}"
            except ValueError:
                was = ""
            t = t[:wm2.start()] + t[wm2.end():]
    t2 = re.sub(r"\(?\s*(?:reg\.?|was|retail)\s*\$[\d,]+(?:\.\d{2})?\s*\)?",
                "", t, flags=re.I)
    # Shipping thresholds are not prices.
    t2 = re.sub(r"free shipping\s+(?:w/|with)\s*\$[\d,]+(?:\.\d{2})?"
                r"|orders of\s*\$[\d,]+(?:\.\d{2})?"
                r"|\$[\d,]+(?:\.\d{2})?\s+or more",
                "", t2, flags=re.I)
    price = ""
    dm = re.search(r"(?:drops?\s+to|down to|now|just|only)\s*\$([\d,]+(?:\.\d{2})?)",
                   t2, re.I)
    if dm:
        try:
            price = f"${float(dm.group(1).replace(',', '')):.2f}"
        except ValueError:
            price = ""
        if price and not was:
            # An earlier $ amount is the was price ('$100 Crock-Pot
            # Drops to $40').
            before = PRICE_RE.findall(t2[:dm.start()])
            if before:
                try:
                    cand = float(before[-1].replace(',', ''))
                    if cand > float(price[1:]):
                        was = f"${cand:.2f}"
                except ValueError:
                    pass
    if not price:
        # First $ amount that is not a discount ('$5 off $25' — neither
        # the $5 nor the $25 is a price).
        for m in PRICE_RE.finditer(t2):
            if re.match(r"\s*off\b", t2[m.end():m.end() + 6], re.I):
                continue
            if re.search(r"\boff\s*$", t2[max(0, m.start() - 5):m.start()], re.I):
                continue
            try:
                price = f"${float(m.group(1).replace(',', '')):.2f}"
            except ValueError:
                price = ""
            break
    if price and was:
        try:
            if float(was[1:]) <= float(price[1:]):
                was = ""
        except ValueError:
            pass
    return price, was


def _summary_image(entry) -> str:
    """First <img> in an RSS entry's summary HTML (LRWC/TT post photos),
    or ''. The summary is HTML — strip tags only after pulling the img."""
    raw = getattr(entry, "summary", "") or ""
    m = re.search(r'<img[^>]+src="([^"]+)"', raw)
    if m:
        return clean_image_url(m.group(1))
    return ""


def parse_fg_deals(html_text: str, base_url: str, default_retailer: str = "walgreens"):
    """Freebie Guy /<store>-deals/ pages (verified 2026-11-22/23):
    <article> cards, each with a heading, a post link, a thumbnail and
    a <time> ('11/22/26'). The full scenario lives on the linked post —
    the card title already carries the price hook, so steps stay [] and
    the modal links through to the post. Retailer is detected from the
    title+link (a Walgreens page can carry a Walmart deal); the page's
    store is only the fallback. Stacks (is_stack=True) — these are
    coupon-deal posts, Bundles-tab material."""
    tree = HTMLParser(html_text)
    items = []
    seen = set()
    for art in tree.css("article"):
        head = art.css_first("h2") or art.css_first("h3")
        link_el = art.css_first("a")
        if head is None or link_el is None:
            continue
        title = clean(head.text())
        link = (link_el.attributes or {}).get("href", "")
        if not title or not link:
            continue
        link = urljoin(base_url, link)
        if link in seen:
            continue
        seen.add(link)
        tm = art.css_first("time")
        list_date = _parse_mdy(clean(tm.text())) if tm is not None else ""
        price, was = _title_price_was(title)
        img = ""
        img_el = art.css_first("img")
        if img_el is not None:
            img = clean_image_url(
                (img_el.attributes or {}).get("src", "") or "", base_url)
        low = f"{title} {link}".lower()
        if "walgreens" in low:
            retailer = "walgreens"
        elif "walmart" in low:
            retailer = "wm-ct"
        elif "cvs" in low:
            retailer = "cvs"
        elif "target" in low:
            retailer = "target"
        else:
            retailer = default_retailer
        items.append(make_item(title, retailer, "thefreebieguy.com",
                               kind="deal", price=price, was=was,
                               url=link, image=img, list_date=list_date,
                               is_stack=True))
    return items


def parse_fg_walgreens(html_text: str, base_url: str):
    """Back-compat alias — the Walgreens page is parse_fg_deals with the
    Walgreens fallback."""
    return parse_fg_deals(html_text, base_url, "walgreens")


def parse_retailshout_ad(html_text: str, retailer: str):
    """RetailShout weekly-ad pages (Walgreens verified 2026-11-22: 70
    .finds-item cards with .finds-item-title / .finds-item-price).
    These are weekly-ad sale items, not coupon stacks — they go to the
    Deals tab (is_stack=False). The H2 carries the ad week
    ('Walgreens Weekly Ad for 11-22-26 to 11-28-26') -> list_date and
    valid_to. Price is the first $ amount in the price string ('$4 or
    $4.50', '2/$9 or $5.99 each'); BOGO-only offers have no $ price and
    keep the whole offer text as the note."""
    tree = HTMLParser(html_text)
    start = end = ""
    # The ad week is body text ('Walgreens Weekly Ad for 11-22-26 to
    # 11-28-26'), not a heading — search the page text.
    m = re.search(r"(\d{1,2})-(\d{1,2})-(\d{2})\s+to\s+(\d{1,2})-(\d{1,2})-(\d{2})",
                  clean(tree.text(separator=" ")))
    if m:
        y = 2000 + int(m.group(3))
        try:
            start = datetime(y, int(m.group(1)), int(m.group(2))).date().isoformat()
            end = datetime(y, int(m.group(4)), int(m.group(5))).date().isoformat()
        except ValueError:
            start = end = ""
    items = []
    seen = set()
    for el in tree.css(".finds-item"):
        title_el = el.css_first(".finds-item-title")
        price_el = el.css_first(".finds-item-price")
        title = clean(title_el.text()) if title_el is not None else ""
        title = re.sub(r"^\d+\)\s*", "", title)
        offer = clean(price_el.text()) if price_el is not None else ""
        if not title:
            continue
        key = title.lower()
        if key in seen:
            continue
        seen.add(key)
        price = ""
        pm = PRICE_RE.search(offer)
        if pm:
            try:
                price = f"${float(pm.group(1).replace(',', '')):.2f}"
            except ValueError:
                price = ""
        it = make_item(title, retailer, "retailshout.com",
                       kind="deal", price=price, url="",
                       list_date=start, valid_to=end)
        if offer:
            it["note"] = offer
        items.append(it)
    return items


def parse_lrwc_rss(raw: str):
    """Living Rich With Coupons RSS (verified 2026-11-22: 45 entries).
    Keeps only Walgreens/CVS/Target/Rite Aid posts — the coupon-blog deal
    posts. Steps come from the entry summary where it reads like steps;
    most entries are prose and get []."""
    parsed = feedparser.parse(raw)
    items = []
    for entry in parsed.entries[:60]:
        title = clean(getattr(entry, "title", "") or "")
        link = getattr(entry, "link", "") or ""
        summary = clean(TAG_STRIP.sub("", html.unescape(getattr(entry, "summary", "") or "")))
        if not title or not link:
            continue
        low = f" {title} {summary} ".lower()
        retailer = ""
        for phrase, sid in TITLE_STORE_HINTS.items():
            if phrase in low:
                retailer = sid
                break
        if retailer not in ("walgreens", "cvs", "target", "rite-aid"):
            continue
        cur, orig = _title_price_was(title)
        thumb = _summary_image(entry)
        media = getattr(entry, "media_thumbnail", None) or []
        if not thumb and media:
            thumb = clean_image_url((media[0] or {}).get("url", ""))
        items.append(make_item(title, retailer, "livingrichwithcoupons.com",
                               kind="deal", price=cur, was=orig,
                               url=link, image=thumb,
                               list_date=_entry_date(entry),
                               is_stack=True,
                               steps=_steps_from_text(summary)))
    return items


def parse_weekly_bargains_flyer(html_text: str, page_url: str, retailer: str):
    """Weekly Bargains flyer pages (Hobby Lobby Black Friday ad verified
    2026-11-22): static HTML. The h2 'Valid from November 18, 2026 to
    November 30, 2026' gives list_date/valid_to; the deal items are <li>
    lines 'White Layered Wood Pumpkin – now $1.62 (save $4.87)' — was =
    now + save. Normal deals (is_stack=False), Deals tab. The flyer
    images on later pages are image-only and are not parsed."""
    tree = HTMLParser(html_text)
    start = end = ""
    for h in tree.css("h2"):
        m = re.search(r"Valid from\s+([A-Za-z]+ \d{1,2}, \d{4})\s+to\s+([A-Za-z]+ \d{1,2}, \d{4})",
                      clean(h.text()))
        if m:
            start = parse_list_date(m.group(1))
            end = parse_list_date(m.group(2))
            break
    pat = re.compile(r"^(.+?)\s*[–—-]\s*now\s*\$([\d,]+\.\d{2})\s*\(save\s*\$([\d,]+\.\d{2})\)")
    items = []
    seen = set()
    for el in tree.css("li"):
        txt = clean(el.text(separator=" "))
        mm = pat.match(txt)
        if not mm:
            continue
        name = mm.group(1).strip()
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        try:
            now = float(mm.group(2).replace(",", ""))
            save = float(mm.group(3).replace(",", ""))
        except ValueError:
            continue
        items.append(make_item(name, retailer, "weekly-bargains.com",
                               kind="deal", price=f"${now:.2f}",
                               was=f"${now + save:.2f}",
                               url=page_url, list_date=start, valid_to=end))
    return items


def discover_swd_urls(sitemap_xml: str) -> list:
    """Saving With Dana discovery: all dated penny-list pages from the
    sitemap, newest-first. The run tries them in order and uses the first
    that yields items — the current week's page is sometimes an empty
    shell until the list is posted (Nov 22, 2026: the 2026-11-22 page
    had no table at all), so the previous week is the honest fallback.
    Every URL comes from the sitemap; none is ever guessed."""
    found = re.findall(
        r"https://savingwithdana\.com/penny-list/(\d{4}-\d{2}-\d{2})\.html",
        sitemap_xml or "")
    return [f"https://savingwithdana.com/penny-list/{d}.html"
            for d in sorted(set(found), reverse=True)]


def discover_swd_url(sitemap_xml: str) -> str:
    """Saving With Dana discovery: the site's sitemap lists the dated
    penny-list pages (/penny-list/YYYY-MM-DD.html). Return the LATEST
    one, or '' when the sitemap yields none — the run then skips the
    source instead of fetching a guessed date."""
    urls = discover_swd_urls(sitemap_xml)
    return urls[0] if urls else ""


def discover_ss_walgreens_url(homepage_html: str) -> str:
    """Southern Savers discovery: the homepage links the current
    Walgreens ad post (/walgreens-ad-coupons-MM-DD-MM-DD/). Return the
    one with the latest start date, or '' when the homepage yields
    none — the run then skips the source instead of guessing a slug."""
    found = re.findall(
        r"https://www\.southernsavers\.com/walgreens-ad-coupons-(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,2})/",
        homepage_html or "")
    if not found:
        return ""
    best = max(found, key=lambda g: (int(g[0]), int(g[1])))
    return (f"https://www.southernsavers.com/walgreens-ad-coupons-"
            f"{best[0]}-{best[1]}-{best[2]}-{best[3]}/")


def parse_saving_with_dana(html_text: str, page_url: str):
    """Saving With Dana DG penny list (verified 2026-11-23): clean
    <table> rows — name | 'UPC 194383090021' | 'Thu, Nov 5' (the
    Pennied date). 306 unique UPCs on the Nov 1 page. list_date is the
    row's Pennied date (month+day, run year), falling back to the page
    date from the URL."""
    tree = HTMLParser(html_text)
    page_date = ""
    m = re.search(r"/penny-list/(\d{4}-\d{2}-\d{2})\.html", page_url or "")
    if m:
        page_date = m.group(1)
    items = []
    seen = set()
    for row in tree.css("table tr"):
        cells = [clean(c.text()) for c in row.css("td, th")]
        if len(cells) < 2:
            continue
        text = " | ".join(cells)
        um = re.search(r"\b(\d{12})\b", text)
        if not um:
            continue
        upc = um.group(1)
        if upc in seen:
            continue
        seen.add(upc)
        # Columns are [photo | name + UPC div | Pennied date] — the
        # name cell merges 'NameUPC <digits>' with no space.
        name = cells[1]
        name = re.sub(r"\s*UPC\s*\d{12}\s*", "", name).strip(" -|")
        row_date = parse_list_date(cells[-1])
        img = ""
        img_el = row.css_first("img")
        if img_el is not None:
            img = clean_image_url((img_el.attributes or {}).get("src", ""),
                                  page_url)
        items.append(make_item(name, "dollar-general", "savingwithdana.com",
                               kind="penny", upc=upc, price="$0.01",
                               url=page_url, image=img,
                               list_date=row_date or page_date))
    return items


def parse_crazy4couponing(html_text: str, page_url: str):
    """Crazy4Couponing DG penny list (verified 2026-11-23): <li> items
    'Name, size<span class="upc">UPC: 070132099111</span>' under dated
    section headings ('Dollar General Penny List Tuesday November 24,
    2026'). The current Nov 24 section is categories-only; the UPCs
    live in the archived dated sections — each item takes its section's
    date as list_date. 209 UPC matches on the page."""
    tree = HTMLParser(html_text)
    items = []
    seen = set()
    current_date = ""
    for el in tree.css("h2, h3, li"):
        tag = (el.tag or "").lower()
        if tag in ("h2", "h3"):
            d = parse_list_date(clean(el.text()))
            if d:
                current_date = d
            continue
        span = el.css_first("span.upc")
        if span is None:
            continue
        um = re.search(r"(\d{12})", span.text() or "")
        if not um:
            continue
        upc = um.group(1)
        if upc in seen:
            continue
        seen.add(upc)
        name = clean(el.text())
        name = re.sub(r"\s*UPC:\s*\d{12}\s*", "", name).strip(" -,")
        if not name:
            continue
        items.append(make_item(name, "dollar-general", "crazy4couponing.com",
                               kind="penny", upc=upc, price="$0.01",
                               url=page_url, list_date=current_date))
    return items


def parse_southern_savers_page(html_text: str, page_url: str):
    """Southern Savers Walgreens ad post (verified 2026-11-23): each
    <li> holds several deals. A deal is a 'Product, $price' line
    followed by coupon/reward lines and a '(buy (2), makes it $20.99
    ea.)' span — the makes-it amount is the final per-item price, the
    product line's $ is the was price, the coupon/reward lines are the
    steps (never invented). H1 'Walgreens Ad & Coupons: 11/22-11/28'
    gives list_date / valid_to. Stacks (is_stack=True)."""
    tree = HTMLParser(html_text)
    start = end = ""
    h1 = tree.css_first("h1")
    if h1 is not None:
        m = re.search(r"(\d{1,2})/(\d{1,2})-(\d{1,2})/(\d{1,2})",
                      clean(h1.text()))
        if m:
            y = datetime.now(timezone.utc).year
            try:
                start = datetime(y, int(m.group(1)), int(m.group(2))).date().isoformat()
                end = datetime(y, int(m.group(3)), int(m.group(4))).date().isoformat()
            except ValueError:
                start = end = ""
    # A product line is 'Name, $price' or 'Name, 2 for $45' (greedy
    # name — 'Depend Guards, Depend Underwear or Poise Pads, 2 for $45'
    # is one product). Coupon lines are excluded: they also end in a $
    # amount ('…in Pepsi Products, 12-pack cans, 3 for $14.99') but
    # carry WYB/WC/rebate wording.
    prod_re = re.compile(r"^(.+),\s*(?:\d+\s+for\s+)?\$([\d,]+(?:\.\d{2})?)$")
    coupon_re = re.compile(
        r"coupon|reward|rebate|WYB|WC\b|eCoupon|get \$|\boff\b", re.I)
    makes_re = re.compile(
        r"\(buy\s*\((\d+)\)[^)]*?makes it\s+(?:\$([\d,]+\.\d{2})|FREE)", re.I)
    items = []
    for li in tree.css("li"):
        # Split the li on <br> tags, not on text nodes: the coupon
        # lines contain <abbr>WYB</abbr> and long rebate spans, and
        # text() splits those into fragments ('$5 WC' / 'WYB' / '$30
        # or more…'). <br>-split segments stay whole.
        raw = li.html or ""
        segments = []
        for seg in re.split(r"<br\s*/?>", raw, flags=re.I):
            txt = clean(TAG_STRIP.sub("", html.unescape(seg)))
            if txt:
                segments.append(txt)
        pending_name = pending_was = ""
        pending_steps = []
        for line in segments:
            mm = makes_re.search(line)
            if mm:
                if not pending_name:
                    # Fallback: the product lives inside the coupon
                    # line ('$5 WC WYB $30 or more in Pepsi Products,
                    # 12-pack cans, 3 for $14.99').
                    for cand in reversed(pending_steps):
                        fm = re.search(
                            r"\bin\s+(.+?)(?:,?\s*\d+\s+for\s+\$([\d,]+\.\d{2}))",
                            cand)
                        if fm:
                            pending_name = fm.group(1).strip()
                            try:
                                pending_was = f"${float(fm.group(2).replace(',', '')):.2f}"
                            except ValueError:
                                pending_was = ""
                            break
                if not pending_name:
                    continue
                qty = mm.group(1)
                final = (f"${float(mm.group(2).replace(',', '')):.2f}"
                         if mm.group(2) else "$0.00")
                steps = [s for s in pending_steps if s][:4]
                steps.append(f"Buy {qty}, makes it {final} each.")
                items.append(make_item(pending_name, "walgreens",
                                       "southernsavers.com", kind="deal",
                                       price=final, was=pending_was,
                                       valid_to=end, url=page_url,
                                       list_date=start, is_stack=True,
                                       steps=steps[:6]))
                pending_name = pending_was = ""
                pending_steps = []
                continue
            pm = prod_re.match(line)
            if pm and not coupon_re.search(line):
                pending_name = pm.group(1).strip()
                try:
                    pending_was = f"${float(pm.group(2).replace(',', '')):.2f}"
                except ValueError:
                    pending_was = ""
                continue
            # Coupon / reward / rebate lines accumulate from the start
            # of the deal block (they precede the product line) and
            # become steps at the makes-it line.
            if coupon_re.search(line):
                pending_steps.append(line[:180])
    return items


def parse_glitchndealz_penny(html_text: str, page_url: str):
    """GlitchNDealz DG penny page (verified 2026-11-23): dated tables
    (Product | Package | UPC) under dated headings ('November 17 Dollar
    General penny checklist', 'Previous report: November 3, 2026').
    Each item takes its table's heading date as list_date. 39 UPCs."""
    tree = HTMLParser(html_text)
    items = []
    seen = set()
    current_date = ""
    for el in tree.css("h2, h3, table"):
        tag = (el.tag or "").lower()
        if tag in ("h2", "h3"):
            d = parse_list_date(clean(el.text()))
            if d:
                current_date = d
            continue
        for row in el.css("tr"):
            cells = [clean(c.text()) for c in row.css("td, th")]
            if len(cells) < 3:
                continue
            um = re.search(r"\b(\d{12})\b", cells[2])
            if not um:
                continue
            upc = um.group(1)
            if upc in seen:
                continue
            seen.add(upc)
            name = f"{cells[0]} {cells[1]}".strip()
            items.append(make_item(name, "dollar-general",
                                   "glitchndealz.com", kind="penny",
                                   upc=upc, price="$0.01", url=page_url,
                                   list_date=current_date))
    return items


def parse_dealnews(raw: str):
    """DealNews RSS (todays-edition + editors-choice, verified
    2026-11-23): feedparser maps dealnews:retailer / :category /
    :expires and media:content, but there is NO dealnews:price element
    in the XML — the price lives in the title ('... for $200 + free
    shipping'), so _extract_price does the work after stripping the
    'free shipping w/ $99' threshold (a shipping minimum, not a price).
    No source-given end date (the dealnews:expires values run months
    out and are not the deal's real end) — main() assigns the stop
    date (list_date + 7 days)."""
    parsed = feedparser.parse(raw)
    items = []
    for entry in parsed.entries[:50]:
        title = clean(getattr(entry, "title", "") or "")
        if not title:
            continue
        summary = clean(TAG_STRIP.sub("", html.unescape(getattr(entry, "summary", "") or "")))
        link = (getattr(entry, "link", "") or "").split("?")[0]
        retailer = _retailer_for(
            f"{getattr(entry, 'dealnews_retailer', '') or ''} {title}", summary)
        # Shipping thresholds are not prices: 'free shipping w/ $99',
        # 'Shipping is free with orders of $99 or more'.
        scrubbed = re.sub(
            r"free shipping\s+(?:w/|with)\s*\$[\d,]+(?:\.\d{2})?"
            r"|orders of\s*\$[\d,]+(?:\.\d{2})?"
            r"|\$[\d,]+(?:\.\d{2})?\s+or more",
            "", f"{title} {summary}", flags=re.I)
        cur, orig = _extract_price(scrubbed, "")
        thumb = ""
        media = getattr(entry, "media_content", None) or []
        if media:
            thumb = clean_image_url((media[0] or {}).get("url", ""))
        if not thumb:
            thumb = _summary_image(entry)
        items.append(make_item(title, retailer, "dealnews.com",
                               kind="deal", upc="", price=cur, was=orig,
                               url=link, image=thumb,
                               list_date=_entry_date(entry),
                               is_stack=looks_like_stack(title, summary, retailer),
                               steps=_steps_from_text(summary)))
    return items


DEAL_FEED_SKIP = re.compile(
    r"giveaway|giv(?:e|ing) away|sweepstakes|enter to win|settlement|claims? due|recall",
    re.I)


def _deal_price(title: str, summary: str):
    """Price for a deal-blog post: the title's price hook first
    (_title_price_was handles 'Reg $X' and '$47 Worth … Only $1.38'),
    falling back to the first $ amount in the summary."""
    price, was = _title_price_was(title)
    if price:
        return price, was
    return _extract_price(title, summary)


def parse_deal_feed(raw: str, source_name: str):
    """Generic deal-blog RSS (Southern Savers, GlitchNDealz,
    Passionate Penny Pincher, Fabulessly Frugal, Hip2Save feeds —
    verified 2026-11-23): post-level deals, not penny lists. Store
    from the entry's categories, then title hints, then _retailer_for.
    Price from the title/summary; a post with no price, no %-off, no
    FREE and no stack signal is skipped (a claims/giveaway post is not
    a deal). Steps from the summary text."""
    parsed = feedparser.parse(raw)
    items = []
    seen_links = set()
    for entry in parsed.entries[:60]:
        title = clean(getattr(entry, "title", "") or "")
        link = (getattr(entry, "link", "") or "").split("?")[0]
        if not title or not link or link in seen_links:
            continue
        if DEAL_FEED_SKIP.search(title):
            continue
        seen_links.add(link)
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
        if not store_id:
            low = f" {combined.lower()} "
            for phrase, sid in TITLE_STORE_HINTS.items():
                if phrase in low:
                    store_id = sid
                    break
        if not store_id:
            store_id = _retailer_for(title, summary)
        price, was = _deal_price(title, summary or content)
        is_stack = looks_like_stack(title, summary or content, store_id)
        if not price and not is_stack and "%" not in title \
                and "free" not in title.lower():
            continue
        if not price and re.search(r"\bfree\b", title, re.I):
            price = "$0.00"
        items.append(make_item(title, store_id, source_name,
                               kind="deal", upc="", price=price, was=was,
                               url=link,
                               image=_summary_image(entry),
                               list_date=_entry_date(entry),
                               is_stack=is_stack,
                               steps=_steps_from_text(summary or content)))
    return items


def parse_hip2save_api(raw: str, search_store: str):
    """Hip2Save WordPress REST API (verified 2026-11-23):
    /wp-json/wp/v2/deals?search=<store>&per_page=5 returns JSON posts
    with title/date/full HTML body. One feed item per post (the post
    IS the deal); price from the title first, then the body; steps
    from the body text. The search store is the retailer fallback —
    a 'Michaels' search also matches 'Michael Kors', so the title
    still gets the final say via _retailer_for."""
    try:
        posts = json.loads(raw)
    except Exception:
        return []
    if not isinstance(posts, list):
        return []
    items = []
    for post in posts[:10]:
        title = clean(TAG_STRIP.sub("", html.unescape(
            ((post.get("title") or {}).get("rendered") or ""))))
        link = (post.get("link") or "").split("?")[0]
        if not title or not link:
            continue
        date = (post.get("date") or "")[:10]
        body_html = (post.get("content") or {}).get("rendered") or ""
        body = clean(TAG_STRIP.sub("", html.unescape(body_html)))
        price, was = _deal_price(title, body)
        store_id = _retailer_for(title, body)
        if store_id == "online":
            store_id = search_store
        is_stack = looks_like_stack(title, body, store_id)
        if not price and not is_stack and "%" not in title \
                and "free" not in title.lower():
            continue
        if not price and re.search(r"\bfree\b", title, re.I):
            price = "$0.00"
        img = ""
        m = re.search(r'<img[^>]+src="([^"]+)"', body_html)
        if m:
            img = clean_image_url(m.group(1))
        items.append(make_item(title, store_id, "hip2save.com",
                               kind="deal", upc="", price=price, was=was,
                               url=link, image=img,
                               list_date=date, is_stack=is_stack,
                               steps=_steps_from_text(body)))
    return items


def parse_clearancefinds_lowes(html_text: str, page_url: str):
    """ClearanceFinds Lowe's penny list (verified 2026-11-23): monthly
    page, <article> cards with div.sku 'ITEM #11804', h2 name,
    span.price '4¢', and a 'Seen Oct 27–Nov 20, 2026' range. The
    7-digit Lowe's item number is stored as sku — it is NOT a UPC and
    never goes in the upc field ('UPC verification needed' is printed
    on every card). list_date is the END of the seen range (freshest
    sighting). 121 unique item numbers on the page."""
    tree = HTMLParser(html_text)
    items = []
    seen = set()
    for art in tree.css("article"):
        sku_el = art.css_first("div.sku")
        if sku_el is None:
            continue
        sm = re.search(r"ITEM #(\d+)", sku_el.text() or "")
        if not sm:
            continue
        item_no = sm.group(1)
        if item_no in seen:
            continue
        seen.add(item_no)
        head = art.css_first("h2")
        name = clean(head.text()) if head is not None else ""
        if not name:
            continue
        price = ""
        pel = art.css_first("span.price")
        if pel is not None:
            cm = re.search(r"(\d+)\s*¢", pel.text() or "")
            if cm:
                price = f"${int(cm.group(1)) / 100:.2f}"
        meta = art.css_first("p.meta")
        list_date = ""
        if meta is not None:
            rm = re.search(r"Seen\s+.+?[–-]\s*([A-Za-z]+\s+\d{1,2},?\s*\d{4})",
                          clean(meta.text(separator=" ")))
            if rm:
                list_date = parse_list_date(rm.group(1))
        img = nearest_image(art, page_url)
        it = make_item(name, "lowes", "clearancefinds.com",
                       kind="deal", upc="", price=price, was="",
                       url=page_url, image=img, list_date=list_date)
        it["sku"] = item_no
        items.append(it)
    return items


def parse_aminahstore(html_text: str, page_url: str):
    """Aminahstore Home Depot penny list (verified 2026-11-23): <li>
    items 'Name; SKU 215-583.' under 'Reported penny items for
    November 15, 2026'. Mixed SKU formats — 6-digit legacy ('215-583')
    and 12-digit internet ('1009-074-829') — both go in the sku field,
    never UPC. 15 list items on the live page (the scout's 47 was not
    reproducible — only 16 SKU mentions exist in the page at all).
    One further item is named in prose ('(SKU 1003-951-328)') and is
    taken with an unknown date."""
    tree = HTMLParser(html_text)
    items = []
    seen = set()
    current_date = ""
    for el in tree.css("h2, h3, li"):
        tag = (el.tag or "").lower()
        if tag in ("h2", "h3"):
            d = parse_list_date(clean(el.text()))
            current_date = d  # '' clears it: later sections are undated
            continue
        m = re.search(r";\s*SKU\s+([\d-]{5,})\s*\.?\s*$",
                      clean(el.text()))
        if not m:
            continue
        sku = m.group(1)
        if sku in seen:
            continue
        seen.add(sku)
        name = clean(el.text())
        name = re.sub(r";\s*SKU\s+[\d-]{5,}\s*\.?\s*$", "", name).strip()
        if not name:
            continue
        it = make_item(name, "home-depot", "aminahstore.com",
                       kind="penny", upc="", price="$0.01",
                       url=page_url, list_date=current_date)
        it["sku"] = sku
        items.append(it)
    # Prose mentions: 'Name (SKU 1003-951-328)' outside the list.
    for p in tree.css("p"):
        text = clean(p.text(separator=" "))
        for m in re.finditer(r"(.{10,120}?)\s*\(SKU\s+([\d-]{5,})\)", text):
            sku = m.group(2)
            if sku in seen:
                continue
            seen.add(sku)
            name = m.group(1).strip(" -,;:")
            name = name.split(".")[-1].strip()
            if not name:
                continue
            it = make_item(name, "home-depot", "aminahstore.com",
                           kind="penny", upc="", price="$0.01",
                           url=page_url, list_date="")
            it["sku"] = sku
            items.append(it)
    return items


def parse_weeklyadhunters(html_text: str, page_url: str):
    """weeklyadhunters Dollar General weekly ad (verified 2026-11-23):
    'Price List (273 items)' as <ul class='omni-pt-list'> rows —
    <span class='omni-pt-name'> + <span class='omni-pt-price'> ('2 for
    $3', '$2.00', 'Buy 1 Get 1 Free'). Ad prices, not pennies. The
    H1 'Dollar General Weekly Ad (Nov 22 – 28, 2026)' gives list_date
    / valid_to. Dixie / Vanity Fair rows are SKIPPED — the row is
    garbled (name says $2.95, listed price shows $9.95) and the real
    Dixie deal is emitted separately from the reel (see main()).
    A no-$ offer ('Buy 1 Get 1 Free') is kept in the name so the offer
    is not lost."""
    tree = HTMLParser(html_text)
    start = end = ""
    h1 = tree.css_first("h1")
    if h1 is not None:
        m = re.search(r"([A-Za-z]+)\s+(\d{1,2})\s*[–-]\s*(\d{1,2}),\s*(\d{4})",
                      clean(h1.text()))
        if m:
            try:
                month = _MONTHS[m.group(1).lower().rstrip(".")]
                y = int(m.group(4))
                start = datetime(y, month, int(m.group(2))).date().isoformat()
                end = datetime(y, month, int(m.group(3))).date().isoformat()
            except (KeyError, ValueError):
                start = end = ""
    items = []
    for li in tree.css("ul.omni-pt-list li"):
        name_el = li.css_first("span.omni-pt-name")
        price_el = li.css_first("span.omni-pt-price")
        if name_el is None or price_el is None:
            continue
        name = clean(name_el.text())
        offer = clean(price_el.text())
        if not name or not offer:
            continue
        if "dixie" in name.lower() or "vanity fair" in name.lower():
            continue
        pm = PRICE_RE.search(offer)
        price = ""
        if pm:
            try:
                price = f"${float(pm.group(1).replace(',', '')):.2f}"
            except ValueError:
                price = ""
        if not price:
            name = f"{name} — {offer}"
        items.append(make_item(name, "dollar-general",
                               "weeklyadhunters.com", kind="deal",
                               price=price, was="", valid_to=end,
                               url=page_url, list_date=start))
    return items


def parse_kart_deals(html_text: str, page_url: str):
    """Kart.deals JCPenney live clearance (verified 2026-11-23): static
    <article class='deal-card'> cards — h3 title, the price part's
    first $ is the sale price, the line-through span is the was price,
    image from sc-images.jcpenney.com. 'Last updated: Nov 22, 10:22 PM
    ET' is the list_date. The page shows the first 30 of 540 live
    deals (infinite list); only JCPenney is wired — other
    /store/<domain> URLs were not fetched or verified."""
    tree = HTMLParser(html_text)
    list_date = parse_list_date(
        (re.search(r"Last updated:\s*([A-Za-z]+\s+\d{1,2})",
                   clean(tree.text(separator=" "))) or [None, ""])[1])
    items = []
    seen = set()
    for card in tree.css("article.deal-card"):
        title_el = card.css_first("h3")
        if title_el is None:
            continue
        title = clean(title_el.text())
        if not title or title.lower() in seen:
            continue
        seen.add(title.lower())
        link_el = card.css_first("a[href*='/deals/']")
        url = urljoin(page_url, (link_el.attributes or {}).get("href", "")) \
            if link_el is not None else page_url
        price = was = ""
        pel = card.css_first("[data-card-part='price']")
        if pel is not None:
            amounts = PRICE_RE.findall(pel.text() or "")
            if amounts:
                try:
                    price = f"${float(amounts[0].replace(',', '')):.2f}"
                except ValueError:
                    price = ""
            wel = pel.css_first("[class*='line-through']")
            if wel is not None:
                wm = PRICE_RE.search(wel.text() or "")
                if wm:
                    try:
                        was = f"${float(wm.group(1).replace(',', '')):.2f}"
                    except ValueError:
                        was = ""
        img = ""
        img_el = card.css_first("img")
        if img_el is not None:
            img = clean_image_url((img_el.attributes or {}).get("src", ""),
                                  page_url)
        items.append(make_item(title, "jcp", "kart.deals",
                               kind="deal", upc="", price=price, was=was,
                               valid_to="", url=url, image=img,
                               list_date=list_date))
    return items


def parse_bradsdeals(html_text: str, page_url: str):
    """Brad's Deals homepage (verified 2026-11-23): .post-tile-vertical
    deal tiles — headline link + details text + posted-time. No RSS
    exists (all feed URLs 404), so the homepage tiles are the source.
    Price from the title/details; retailer from the title; giveaway /
    settlement tiles skipped."""
    tree = HTMLParser(html_text)
    items = []
    seen = set()
    for tile in tree.css(".post-tile-vertical"):
        link_el = tile.css_first(".post-tile-vertical__headline-link")
        title_el = tile.css_first(".post-tile-vertical__headline-text")
        if link_el is None or title_el is None:
            continue
        title = clean(title_el.text())
        link = urljoin(page_url, (link_el.attributes or {}).get("href", ""))
        if not title or not link or link in seen:
            continue
        if DEAL_FEED_SKIP.search(title):
            continue
        seen.add(link)
        det_el = tile.css_first(".post-tile-vertical__details-content")
        details = clean(det_el.text()) if det_el is not None else ""
        time_el = tile.css_first(".post-tile-vertical__posted-time")
        list_date = _parse_relative_time(
            clean(time_el.text()) if time_el is not None else "")
        price, was = _deal_price(title, details)
        store_id = _retailer_for(title, details)
        is_stack = looks_like_stack(title, details, store_id)
        if not price and not is_stack and "%" not in title \
                and "free" not in title.lower():
            continue
        if not price and re.search(r"\bfree\b", title, re.I):
            price = "$0.00"
        img = ""
        img_el = tile.css_first("img")
        if img_el is not None:
            img = clean_image_url((img_el.attributes or {}).get("src", ""),
                                  page_url)
        items.append(make_item(title, store_id, "bradsdeals.com",
                               kind="deal", upc="", price=price, was=was,
                               url=link, image=img,
                               list_date=list_date, is_stack=is_stack,
                               steps=_steps_from_text(details)))
    return items


def parse_tt_rss(raw: str):
    """TotallyTarget RSS (verified 2026-11-22: 10 entries). Keeps the
    weekly-ad preview and clearance-find posts — the Target deal content.
    Steps stay [] (the scenario is inside the linked post)."""
    parsed = feedparser.parse(raw)
    items = []
    for entry in parsed.entries[:20]:
        title = clean(getattr(entry, "title", "") or "")
        link = getattr(entry, "link", "") or ""
        if not title or not link:
            continue
        low = title.lower()
        if "weekly ad preview" not in low and "clearance finds" not in low:
            continue
        cur, orig = _extract_price(title, "")
        items.append(make_item(title, "target", "totallytarget.com",
                               kind="deal", price=cur, was=orig,
                               url=link, image=_summary_image(entry),
                               list_date=_entry_date(entry),
                               is_stack=True))
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
def _mark_food(items, dept):
    """Food-tab marking (v15): a source whose whole feed is food
    (restaurant/fast-food/free-food searches, Kroger) marks every item
    food=True and pins its department — 'Restaurant' for restaurant
    threads, 'Grocery' for grocery deals. The app's Food tab reads the
    flag, not the name; the department gives the Food tab its dept
    filter. Stacks keep is_stack=True and still live on Bundles."""
    for it in items:
        it["food"] = True
        it["department"] = dept
    return items


SOURCES = [
    ("freebie-guy-dg", "Freebie Guy — DG penny list",
     "https://THEFREEBIEGUY.COM/DOLLAR-GENERAL-PENNY-SHOPPING-MASTER-LIST/", "fetch"),
    ("retailshout-dg", "RetailShout — DG penny items",
     "https://retailshout.com/latest-dollar-general-penny-items-near-you/", "fetch"),
    ("retailshout-dt", "RetailShout — Dollar Tree penny items",
     "https://retailshout.com/latest-dollar-tree-penny-items-near-you/", "fetch"),
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
    ("kcl-walgreens", "Krazy Coupon Lady — Walgreens stacks",
     "https://thekrazycouponlady.com/coupons-for/walgreens", "fetch"),
    ("kcl-cvs", "Krazy Coupon Lady — CVS stacks",
     "https://thekrazycouponlady.com/coupons-for/cvs", "fetch"),
    ("kcl-target", "Krazy Coupon Lady — Target stacks",
     "https://thekrazycouponlady.com/coupons-for/target", "fetch"),
    ("freebie-guy-walgreens", "Freebie Guy — Walgreens deals",
     "https://thefreebieguy.com/walgreens-deals/", "fetch"),
    ("retailshout-walgreens-ad", "RetailShout — Walgreens weekly ad",
     "https://retailshout.com/walgreens-weekly-ad/", "fetch"),
    ("retailshout-cvs-ad", "RetailShout — CVS weekly ad",
     "https://retailshout.com/cvs-weekly-ad/", "link-only"),
    ("lrwc-rss", "Living Rich With Coupons — RSS",
     "https://www.livingrichwithcoupons.com/feed", "fetch"),
    ("totallytarget-rss", "TotallyTarget — RSS",
     "https://www.totallytarget.com/feed/", "fetch"),
    ("slickdeals-search-walgreens", "Slickdeals — Walgreens search",
     "https://slickdeals.net/newsearch.php?firstonly=1&q=walgreens&searcharea=deals&searchin=first&rss=1", "fetch"),
    ("slickdeals-search-cvs", "Slickdeals — CVS search",
     "https://slickdeals.net/newsearch.php?firstonly=1&q=cvs&searcharea=deals&searchin=first&rss=1", "fetch"),
    ("weekly-bargains-hl", "Weekly Bargains — Hobby Lobby Black Friday ad",
     "https://weekly-bargains.com/us/hobby-lobby/hobby-lobby-home-fall-decor-2026-11-18-4458192/", "fetch"),
    ("katalozi365-hl", "Katalozi365 — Hobby Lobby weekly leaflet",
     "https://katalozi365.com/us/hobby-lobby/current-hobby-lobby-leaflet-valid-from-sunday-11-15-2026-to-saturday-11-21-2026-4441183/", "link-only"),
    ("milled-hl", "Milled — Hobby Lobby email (75% fall decor)",
     "https://milled.com/hobby-lobby/sale-alert-75-off-fall-decor-floral-and-crafts-k5Mfgh5TdmwAFgvS", "link-only"),
    ("slickdeals-search-hobby-lobby", "Slickdeals — Hobby Lobby search",
     "https://slickdeals.net/newsearch.php?firstonly=1&q=hobby+lobby&searcharea=deals&searchin=first&rss=1", "fetch"),
    ("slickdeals-search-target", "Slickdeals — Target search",
     "https://slickdeals.net/newsearch.php?firstonly=1&q=target&searcharea=deals&searchin=first&rss=1", "fetch"),
    ("slickdeals-search-dollar-general", "Slickdeals — Dollar General search",
     "https://slickdeals.net/newsearch.php?firstonly=1&q=dollar+general&searcharea=deals&searchin=first&rss=1", "fetch"),
    ("slickdeals-search-dollar-tree", "Slickdeals — Dollar Tree search",
     "https://slickdeals.net/newsearch.php?firstonly=1&q=dollar+tree&searcharea=deals&searchin=first&rss=1", "fetch"),
    ("slickdeals-search-home-depot", "Slickdeals — Home Depot search",
     "https://slickdeals.net/newsearch.php?firstonly=1&q=home+depot&searcharea=deals&searchin=first&rss=1", "fetch"),
    ("slickdeals-search-clearance", "Slickdeals — clearance search",
     "https://slickdeals.net/newsearch.php?firstonly=1&q=clearance&searcharea=deals&searchin=first&rss=1", "fetch"),
    ("slickdeals-search-walgreens-free", "Slickdeals — Walgreens free search",
     "https://slickdeals.net/newsearch.php?firstonly=1&q=walgreens+free&searcharea=deals&searchin=first&rss=1", "fetch"),
    ("slickdeals-search-free-food", "Slickdeals — free food search",
     "https://slickdeals.net/newsearch.php?firstonly=1&q=free+food&searcharea=deals&searchin=first&rss=1", "fetch"),
    ("slickdeals-search-fast-food", "Slickdeals — fast food search",
     "https://slickdeals.net/newsearch.php?firstonly=1&q=fast+food&searcharea=deals&searchin=first&rss=1", "fetch"),
    ("slickdeals-search-restaurant", "Slickdeals — restaurant search",
     "https://slickdeals.net/newsearch.php?firstonly=1&q=restaurant&searcharea=deals&searchin=first&rss=1", "fetch"),
    ("slickdeals-search-kroger", "Slickdeals — Kroger search",
     "https://slickdeals.net/newsearch.php?firstonly=1&q=kroger&searcharea=deals&searchin=first&rss=1", "fetch"),
    ("saving-with-dana-dg", "Saving With Dana — DG penny list",
     "https://savingwithdana.com/sitemap.xml", "fetch"),
    ("crazy4couponing-dg", "Crazy4Couponing — DG penny list",
     "https://crazy4couponing.com/dollar-general-penny-list", "fetch"),
    ("southern-savers-walgreens", "Southern Savers — Walgreens ad & coupons",
     "https://www.southernsavers.com/", "fetch"),
    ("southern-savers-feed", "Southern Savers — RSS",
     "https://www.southernsavers.com/feed/", "fetch"),
    ("glitchndealz-feed", "GlitchNDealz — RSS",
     "https://glitchndealz.com/feed/", "fetch"),
    ("glitchndealz-penny", "GlitchNDealz — DG penny list",
     "https://glitchndealz.com/penny-list-for-dollar-general", "fetch"),
    ("dealnews-today", "DealNews — today's edition RSS",
     "https://s1.dlnws.com/dealnews/rss/todays-edition.xml", "fetch"),
    ("dealnews-editors", "DealNews — editors' choice RSS",
     "https://www.dealnews.com/rss/editors-choice", "fetch"),
    ("hip2save-feed", "Hip2Save — RSS",
     "https://hip2save.com/feed/", "fetch"),
    ("hip2save-api-walgreens", "Hip2Save — Walgreens deals (WP API)",
     "https://hip2save.com/wp-json/wp/v2/deals?search=walgreens&per_page=5", "fetch"),
    ("hip2save-api-cvs", "Hip2Save — CVS deals (WP API)",
     "https://hip2save.com/wp-json/wp/v2/deals?search=cvs&per_page=5", "fetch"),
    ("hip2save-api-target", "Hip2Save — Target deals (WP API)",
     "https://hip2save.com/wp-json/wp/v2/deals?search=target&per_page=5", "fetch"),
    ("hip2save-api-dollar-general", "Hip2Save — Dollar General deals (WP API)",
     "https://hip2save.com/wp-json/wp/v2/deals?search=dollar-general&per_page=5", "fetch"),
    ("hip2save-api-hobby-lobby", "Hip2Save — Hobby Lobby deals (WP API)",
     "https://hip2save.com/wp-json/wp/v2/deals?search=hobby-lobby&per_page=5", "fetch"),
    ("hip2save-api-home-depot", "Hip2Save — Home Depot deals (WP API)",
     "https://hip2save.com/wp-json/wp/v2/deals?search=home-depot&per_page=5", "fetch"),
    ("hip2save-api-restaurant", "Hip2Save — restaurant deals (WP API)",
     "https://hip2save.com/wp-json/wp/v2/deals?search=restaurant&per_page=5", "fetch"),
    ("kcl-michaels", "Krazy Coupon Lady — Michaels stacks",
     "https://www.thekrazycouponlady.com/coupons-for/michaels", "fetch"),
    ("kcl-kohls", "Krazy Coupon Lady — Kohl's stacks",
     "https://www.thekrazycouponlady.com/coupons-for/kohls", "fetch"),
    ("kcl-jcpenney", "Krazy Coupon Lady — JCPenney stacks",
     "https://www.thekrazycouponlady.com/coupons-for/jcpenney", "fetch"),
    ("kcl-kroger", "Krazy Coupon Lady — Kroger stacks",
     "https://thekrazycouponlady.com/coupons-for/kroger", "fetch"),
    ("clearancefinds-lowes", "ClearanceFinds — Lowe's penny list",
     "https://clearancefinds.com/alerts/lowes-penny-list-november-2026/", "fetch"),
    ("aminahstore-hd", "Aminahstore — Home Depot penny list",
     "https://aminahstore.com/article/111", "fetch"),
    ("weeklyadhunters-dg", "weeklyadhunters — Dollar General weekly ad",
     "https://weeklyadhunters.com/dollar-general-weekly-ad/", "fetch"),
    ("kart-jcpenney", "Kart.deals — JCPenney live clearance",
     "https://kart.deals/store/jcpenney-com?sort=price-asc&filters=open", "fetch"),
    ("freebie-guy-target", "Freebie Guy — Target deals",
     "https://thefreebieguy.com/target-deals/", "fetch"),
    ("freebie-guy-cvs", "Freebie Guy — CVS deals",
     "https://thefreebieguy.com/cvs-deals/", "link-only"),
    ("passionate-penny-pincher-feed", "Passionate Penny Pincher — RSS",
     "https://passionatepennypincher.com/feed/", "fetch"),
    ("fabulessly-frugal-feed", "Fabulessly Frugal — deals RSS",
     "https://fabulesslyfrugal.com/deals/feed/", "fetch"),
    ("bradsdeals-home", "Brad's Deals — homepage deals",
     "https://www.bradsdeals.com/", "fetch"),
    ("pennypuss", "Penny Puss — DG penny list",
     "https://pennypuss.com/", "link-only"),
]

LINK_ONLY_NOTES = {
    "savingk-walmart": "Guide page only — no parseable deal database exists; open the page to read it.",
    "kcl-hd": "Page loads but the list is not in the static HTML (JS-rendered) — open it in a browser.",
    "retailshout-cvs-ad": "This week's page is a gift guide, not a priced deal list — open it manually.",
    "katalozi365-hl": "Leaflet is image-based — the page text gives only the category discounts (75% fall decor, 50% tableware), no per-item prices.",
    "milled-hl": "Hobby Lobby's own email, mirrored — the parser couldn't fetch the page (connection reset twice, 2026-11-22); open it manually.",
    "freebie-guy-cvs": "Only 1 CVS-titled deal on the page — not a real CVS list; open it manually.",
    "pennypuss": "Homepage yields no current list link (only a 2023 index) and the Oct 27 list page carries only 6 UPCs in static HTML, not the 27 claimed — the rest are not in the page text.",
}


def run_source(client: httpx.Client, key: str, name: str, url: str, kind: str):
    """Returns (items, status_dict). Never raises."""
    if kind == "link-only":
        return [], {"name": name, "url": url, "status": "link-only",
                    "item_count": 0, "note": LINK_ONLY_NOTES.get(key, "")}
    if key == "dealnews-editors":
        # DealNews stalls the editors feed on a client that already
        # fetched the today's-edition feed (reproduced Nov 23, 2026:
        # same client ReadTimeout twice even after a 10s sleep; a fresh
        # client answers in <1s, 4/4). Fetch it on its own fresh client.
        with httpx.Client(
            headers={"User-Agent": USER_AGENT,
                     "Accept-Language": "en-US,en;q=0.9"},
            timeout=60.0,
        ) as fresh:
            body, err = safe_get(fresh, url)
        if body is None:
            status = "blocked" if err and "blocked" in err else "failed"
            return [], {"name": name, "url": url, "status": status,
                        "item_count": 0, "note": err or "fetch failed"}
        items = parse_dealnews(body)
        return items, {"name": name, "url": url, "status": "ok",
                       "item_count": len(items)}
    try:
        body, err = safe_get(client, url)
        if body is None:
            status = "blocked" if err and "blocked" in err else "failed"
            return [], {"name": name, "url": url, "status": status,
                        "item_count": 0, "note": err or "fetch failed"}
        if key == "saving-with-dana-dg":
            # The SOURCES url is the sitemap (discovery doc). The current
            # week's dated page comes from the sitemap — never guessed.
            # The latest page is sometimes an empty shell until the list
            # is posted, so try sitemap URLs newest-first (max 2) and use
            # the first that yields items.
            page_urls = discover_swd_urls(body)
            if not page_urls:
                return [], {"name": name, "url": url, "status": "failed",
                            "item_count": 0,
                            "note": "discovery failed — sitemap lists no "
                            "penny-list page; skipped rather than guessing"}
            last_err, tried = "", []
            for page_url in page_urls[:2]:
                page_body, err2 = safe_get(client, page_url)
                if page_body is None:
                    last_err = err2 or "fetch failed"
                    tried.append(page_url)
                    continue
                items = parse_saving_with_dana(page_body, page_url)
                if items:
                    note = ""
                    if page_url != page_urls[0]:
                        note = (f"latest page {page_urls[0]} is empty "
                                "(list not posted yet); fell back to "
                                f"{page_url}")
                    return items, {"name": name, "url": page_url,
                                   "status": "ok",
                                   "item_count": len(items), "note": note}
                tried.append(page_url)
            return [], {"name": name, "url": page_urls[0], "status": "failed",
                        "item_count": 0,
                        "note": ("no sitemap penny-list page yielded items "
                                 f"(tried {', '.join(tried)}); "
                                 f"{last_err}")}
        if key == "southern-savers-walgreens":
            # The SOURCES url is the homepage (discovery doc). The
            # current Walgreens ad post comes from the homepage links —
            # never a guessed date slug. The homepage only links the ad
            # while it is fresh (2026-11-25: the 11/22 ad had already
            # scrolled off, so discovery failed outright) — fall back
            # to the site's own search page, which lists the ad posts
            # newest-first even after they leave the homepage.
            page_url = discover_ss_walgreens_url(body)
            if not page_url:
                search_body, _err = safe_get(
                    client,
                    "https://www.southernsavers.com/?s=walgreens+ad+coupons")
                if search_body:
                    page_url = discover_ss_walgreens_url(search_body)
            if not page_url:
                return [], {"name": name, "url": url, "status": "failed",
                            "item_count": 0,
                            "note": "discovery failed — homepage and site "
                            "search link no Walgreens ad post; skipped "
                            "rather than guessing"}
            page_body, err2 = safe_get(client, page_url)
            if page_body is None:
                return [], {"name": name, "url": page_url, "status": "failed",
                            "item_count": 0, "note": err2 or "fetch failed"}
            items = parse_southern_savers_page(page_body, page_url)
            return items, {"name": name, "url": page_url, "status": "ok",
                           "item_count": len(items)}
        if key == "freebie-guy-dg":
            items = extract_fg_dg(body, url)
        elif key == "retailshout-dg":
            items = parse_retailshout(body)
        elif key == "retailshout-dt":
            items = parse_retailshout(body, retailer="dollar-tree",
                                      prefix="dt")
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
        elif key == "kcl-walgreens":
            items = parse_kcl_store(body, url, "walgreens")
        elif key == "kcl-cvs":
            items = parse_kcl_store(body, url, "cvs")
        elif key == "kcl-target":
            items = parse_kcl_store(body, url, "target")
        elif key == "freebie-guy-walgreens":
            items = parse_fg_walgreens(body, url)
        elif key == "retailshout-walgreens-ad":
            items = parse_retailshout_ad(body, "walgreens")
        elif key == "lrwc-rss":
            items = parse_lrwc_rss(body)
        elif key == "totallytarget-rss":
            items = parse_tt_rss(body)
        elif key == "slickdeals-search-walgreens":
            items = parse_slickdeals(body, force_retailer="walgreens")
        elif key == "slickdeals-search-cvs":
            items = parse_slickdeals(body, force_retailer="cvs")
        elif key == "weekly-bargains-hl":
            items = parse_weekly_bargains_flyer(body, url, "hobby-lobby")
        elif key == "slickdeals-search-hobby-lobby":
            # Relevance-ranked search returns old threads too — keep only
            # fresh ones whose title names Hobby Lobby, routed to Deals.
            items = parse_slickdeals(body, force_retailer="hobby-lobby",
                                     require_title="hobby lobby",
                                     max_age_days=7, no_stack=True)
        elif key == "slickdeals-search-target":
            items = parse_slickdeals(body, force_retailer="target",
                                     max_age_days=14, no_stack=True)
        elif key == "slickdeals-search-dollar-general":
            # Noisy: the first hit is a '1 Million Dollar' sweepstakes —
            # keep only threads that name Dollar General in title or
            # summary, routed to Deals.
            items = parse_slickdeals(body, force_retailer="dollar-general",
                                     require_text="dollar general",
                                     max_age_days=14, no_stack=True)
        elif key == "slickdeals-search-dollar-tree":
            # Same noise filter as the Dollar General search.
            items = parse_slickdeals(body, force_retailer="dollar-tree",
                                     require_text="dollar tree",
                                     max_age_days=14, no_stack=True)
        elif key in ("slickdeals-search-free-food",
                     "slickdeals-search-fast-food",
                     "slickdeals-search-restaurant"):
            # Food-tab sources: restaurant/fast-food threads, routed to
            # Deals-shaped items and marked food (Restaurant dept).
            items = _mark_food(
                parse_slickdeals(body, max_age_days=14, no_stack=True),
                "Restaurant")
        elif key == "slickdeals-search-kroger":
            # Kroger = King Soopers in Colorado. Grocery dept, Food tab.
            items = _mark_food(
                parse_slickdeals(body, force_retailer="kroger",
                                 max_age_days=14, no_stack=True),
                "Grocery")
        elif key == "slickdeals-search-home-depot":
            items = parse_slickdeals(body, force_retailer="home-depot",
                                     max_age_days=14, no_stack=True)
        elif key == "slickdeals-search-clearance":
            items = parse_slickdeals(body, max_age_days=14, no_stack=True)
        elif key == "slickdeals-search-walgreens-free":
            items = parse_slickdeals(body, force_retailer="walgreens",
                                     max_age_days=14, force_stack=True)
        elif key == "crazy4couponing-dg":
            items = parse_crazy4couponing(body, url)
        elif key == "southern-savers-feed":
            items = parse_deal_feed(body, "southernsavers.com")
        elif key == "glitchndealz-feed":
            items = parse_deal_feed(body, "glitchndealz.com")
        elif key == "glitchndealz-penny":
            items = parse_glitchndealz_penny(body, url)
        elif key in ("dealnews-today", "dealnews-editors"):
            items = parse_dealnews(body)
        elif key == "hip2save-feed":
            items = parse_deal_feed(body, "hip2save.com")
        elif key == "hip2save-api-restaurant":
            # The WP search is the retailer fallback ('restaurant' when
            # the post names no chain); the whole feed is food.
            items = _mark_food(parse_hip2save_api(body, "restaurant"),
                               "Restaurant")
        elif key.startswith("hip2save-api-"):
            store = key[len("hip2save-api-"):]
            items = parse_hip2save_api(body, store)
        elif key == "kcl-michaels":
            items = parse_kcl_store(body, url, "michaels")
        elif key == "kcl-kohls":
            items = parse_kcl_store(body, url, "kohls")
        elif key == "kcl-jcpenney":
            items = parse_kcl_store(body, url, "jcp")
        elif key == "kcl-kroger":
            # Kroger stacks (King Soopers in Colorado) — coupon stacks,
            # so they live on Bundles; marked food + Grocery anyway.
            items = _mark_food(parse_kcl_store(body, url, "kroger"),
                               "Grocery")
        elif key == "clearancefinds-lowes":
            items = parse_clearancefinds_lowes(body, url)
        elif key == "aminahstore-hd":
            items = parse_aminahstore(body, url)
        elif key == "weeklyadhunters-dg":
            items = parse_weeklyadhunters(body, url)
        elif key == "kart-jcpenney":
            items = parse_kart_deals(body, url)
        elif key == "freebie-guy-target":
            items = parse_fg_deals(body, url, "target")
        elif key == "passionate-penny-pincher-feed":
            items = parse_deal_feed(body, "passionatepennypincher.com")
        elif key == "fabulessly-frugal-feed":
            items = parse_deal_feed(body, "fabulesslyfrugal.com")
        elif key == "bradsdeals-home":
            items = parse_bradsdeals(body, url)
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

        # The Dixie deal (Joseph's reel, Nov 22, 2026 — Stacey Workman):
        # 4 Dixie plates/bowls for $8.50 before tax, valid Nov 22–28.
        # Emitted ONLY when the weeklyadhunters DG ad parsed OK — the ad
        # corroborates the sale (it lists 'Dixie or Vanity Fair Products
        # - $2.95' and 'Ultra Plates'), but its price-list row is
        # garbled (name $2.95, listed price $9.95) and it carries neither
        # the 2-for-$5 / 2-for-$7 structure nor the digitals. The price
        # here is the reel's $8.50 final, never the garbled row. The
        # steps are the reel's mechanics as Joseph shared them — not
        # invented. One Deals-tab item (not a stack).
        wah = next((s for s in statuses
                    if s["name"].startswith("weeklyadhunters")
                    and s["status"] == "ok"), None)
        if wah is not None:
            all_items.append(make_item(
                "4 Dixie Plates/Bowls — $8.50 (was $12.00) at Dollar General",
                "dollar-general", "weeklyadhunters.com", kind="deal",
                price="$8.50", was="$12.00", valid_to="2026-11-28",
                url=wah["url"], list_date="2026-11-22",
                steps=[
                    "Buy 2 regular Dixie plates/bowls (32-count, floral) — on sale 2 for $5, mix & match.",
                    "Buy 2 Dixie Ultra plates/bowls (20-count plates / 26-count bowls, blue swirl) — on sale 2 for $7, mix & match.",
                    "Clip the $0.50 manufacturer digital coupon for Dixie in the DG app.",
                    "Clip the $3.00 DG store coupon (spend $12 on Dixie or Vanity Fair) in the DG app.",
                    "Total at the register: $12.00 − $3.50 in coupons = $8.50 before tax.",
                    "Digital coupons vary by account — clip them in the DG app first and confirm before you shop. Valid Nov 22–28, 2026.",
                ]))

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
            if it.get("sku") and not kept.get("sku"):
                kept["sku"] = it["sku"]
            if it.get("is_stack") and not kept.get("is_stack"):
                kept["is_stack"] = True
            if it.get("food") and not kept.get("food"):
                # A later copy from a food source marks the kept item
                # food too (first source wins on everything else).
                kept["food"] = True
                if kept.get("department") in ("", "General") \
                        and it.get("department"):
                    kept["department"] = it["department"]
            if it.get("steps") and not kept.get("steps"):
                kept["steps"] = it["steps"]
            if it["first_seen"] < kept["first_seen"]:
                kept["first_seen"] = it["first_seen"]
            if it.get("list_date") and (not kept.get("list_date")
                                        or it["list_date"] > kept["list_date"]):
                kept["list_date"] = it["list_date"]
        deduped.sort(key=lambda d: (d["retailer"], d["name"].lower()))

        # Preserve first_seen from the previous feed (per UPC, else
        # name+retailer): without this every re-run re-stamps old items
        # with today's date and "Most recent" can never tell a new item
        # from an old one. Items with no determinable list date keep
        # list_date '' (unknown) — never the run date, never first_seen.
        prev_seen = load_first_seen_map()
        for it in deduped:
            key = (("upc", it["upc"]) if it.get("upc")
                   else ("name", (it["name"].lower(), it["retailer"])))
            if key in prev_seen:
                it["first_seen"] = prev_seen[key]

        # Stop date (v15): a deal with no source-given end date stops
        # list_date + 7 days, so a deal from a finished week stops
        # crowding the feed instead of hovering for months. Penny items
        # never stop — their list date is when the item pennied, not
        # when the deal ends (a September penny is still a penny).
        # A source-given valid_to is never overwritten. An item with no
        # list date and no end date keeps no stop date.
        for it in deduped:
            if it["kind"] != "penny" and not it.get("valid_to") \
                    and it.get("list_date"):
                try:
                    stop = (datetime.strptime(
                        it["list_date"], "%Y-%m-%d").date()
                        + timedelta(days=7)).isoformat()
                    it["valid_to"] = stop
                except ValueError:
                    pass

        # Food tab (v15): any non-penny deal whose department is
        # Grocery is food, even from a general source (a Walgreens ad
        # snack, a Slickdeals grocery thread). Penny items stay on the
        # Deals tab whatever their department — the penny hunt is the
        # Deals tab's job.
        for it in deduped:
            if it["kind"] != "penny" and it.get("department") == "Grocery":
                it["food"] = True

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
