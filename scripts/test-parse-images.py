#!/usr/bin/env python3
"""Unit tests for the image helpers in parse-lists.py — no network.
Run: /tmp/pa-venv/bin/python scripts/test-parse-images.py
(or any python with httpx + selectolax installed). Exits 0 on ALL PASS."""
import os
import sys

import importlib.util

_spec = importlib.util.spec_from_file_location(
    "parse_lists", os.path.join(os.path.dirname(os.path.abspath(__file__)), "parse-lists.py"))
pl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pl)

failures = 0


def check(label, actual, expected):
    global failures
    if actual == expected:
        print("PASS " + label)
    else:
        failures += 1
        print(f"FAIL {label}\n  actual:   {actual!r}\n  expected: {expected!r}")


class FakeResp:
    def __init__(self, status=200, payload=None):
        self.status_code = status
        self._payload = payload or {}

    def json(self):
        return self._payload


class FakeClient:
    def __init__(self, mapping):
        # mapping: url-prefix -> FakeResp (or Exception to raise)
        self.mapping = mapping

    def get(self, url, **kwargs):
        for prefix, resp in self.mapping.items():
            if url.startswith(prefix):
                if isinstance(resp, Exception):
                    raise resp
                return resp
        return FakeResp(404, {"status": 0})


# --- extract_og_image ---
html_og = ('<html><head>'
           '<meta property="og:image" content="https://example.com/a.jpg">'
           '</head><body><img src="https://example.com/big.jpg" width="600" height="400">'
           '</body></html>')
check("og:image wins over page img", pl.extract_og_image(html_og), "https://example.com/a.jpg")

html_fallback = ('<html><body>'
                 '<img src="https://example.com/logo.png" width="120" height="40">'
                 '<img src="/imgs/small.jpg" width="100" height="100">'
                 '<img src="https://example.com/hero.jpg" width="800" height="600">'
                 '</body></html>')
check("fallback picks largest sensible img",
      pl.extract_og_image(html_fallback, "https://example.com/page"),
      "https://example.com/hero.jpg")

html_sized_url = ('<html><body>'
                  '<img src="https://cdn.example.com/450x450/12345.thumb">'
                  '</body></html>')
check("fallback reads WxH from URL",
      pl.extract_og_image(html_sized_url), "https://cdn.example.com/450x450/12345.thumb")

check("no og and no big img -> empty",
      pl.extract_og_image('<html><body><img src="https://example.com/icon.png" width="16" height="16"></body></html>'),
      "")
check("data: URI never returned",
      pl.extract_og_image('<html><head><meta property="og:image" content="data:image/png;base64,AAA"></head></html>'),
      "")
check("relative og:image resolves against page",
      pl.extract_og_image('<html><head><meta property="og:image" content="/img/a.jpg"></head></html>',
                          "https://example.com/deal/1"),
      "https://example.com/img/a.jpg")

# --- og_image_for_url (stub client) ---
stub = FakeClient({
    "https://slickdeals.net/f/1": FakeResp(200),
})
# FakeResp has no .text — og_image_for_url reads resp.text; give it one.
stub.mapping["https://slickdeals.net/f/1"] = type("R", (), {
    "status_code": 200,
    "text": html_og,
})()
check("og_image_for_url extracts og:image",
      pl.og_image_for_url(stub, "https://slickdeals.net/f/1"), "https://example.com/a.jpg")
check("og_image_for_url 404 -> empty",
      pl.og_image_for_url(stub, "https://slickdeals.net/f/404"), "")

# --- opf_image (stub client) ---
opf_ok = FakeClient({
    "https://world.openproductsfacts.org/api/v2/product/036000183399.json":
        FakeResp(200, {"status": 1, "product": {
            "image_url": "https://images.openproductsfacts.org/images/products/003/600/001/8339/front_en.3.400.jpg"}}),
    "https://world.openproductsfacts.org/api/v2/product/000000000000.json":
        FakeResp(404, {"status": 0}),
})
check("opf_image returns product image",
      pl.opf_image(opf_ok, "036000183399"),
      "https://images.openproductsfacts.org/images/products/003/600/001/8339/front_en.3.400.jpg")
check("opf_image unknown product -> empty",
      pl.opf_image(opf_ok, "000000000000"), "")

# --- host allowlist: new image hosts are not retailer store domains ---
for url in ("https://images.openproductsfacts.org/images/products/x.jpg",
            "https://slickdeals.net/attachment/1/2/3/450x450/1.thumb",
            "https://images.thdstatic.com/productImages/x/svn/y-64_600.jpg"):
    check("clean_image_url keeps " + url.split("/")[2], bool(pl.clean_image_url(url)), True)

print("ALL PASS" if failures == 0 else f"{failures} FAILURES")
sys.exit(0 if failures == 0 else 1)
