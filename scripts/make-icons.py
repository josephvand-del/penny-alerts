#!/usr/bin/env python3
"""Penny Alerts — regenerate the PNG app icons from icon.svg.

Chrome's install criteria need 192px and 512px PNG icons; the manifest
used to carry only an SVG ("any"), so the browser offered a
shortcut-style card instead of a proper install. This script renders:
  icon-192.png          192x192, the icon.svg design as-is
  icon-512.png          512x512, the icon.svg design as-is
  icon-512-maskable.png 512x512, maskable variant: full-bleed green
                        background, the coin mark centred in the safe
                        zone, no "PENNY" text (it sits at the bottom
                        edge and a circular mask would clip it)

Run: python3 scripts/make-icons.py   (needs cairosvg + libcairo)
"""
from __future__ import annotations

import os
import re

import cairosvg

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def main() -> None:
    with open(os.path.join(ROOT, "icon.svg"), encoding="utf-8") as f:
        svg = f.read()
    cairosvg.svg2png(bytestring=svg.encode("utf-8"),
                     write_to=os.path.join(ROOT, "icon-192.png"),
                     output_width=192, output_height=192)
    cairosvg.svg2png(bytestring=svg.encode("utf-8"),
                     write_to=os.path.join(ROOT, "icon-512.png"),
                     output_width=512, output_height=512)
    # Maskable: full-bleed background (the OS applies the mask), the
    # coin mark kept inside the central 80% safe zone, text removed.
    maskable = re.sub(r'<text.*?</text>', '', svg, flags=re.S)
    maskable = maskable.replace(' rx="96"', '')
    cairosvg.svg2png(bytestring=maskable.encode("utf-8"),
                     write_to=os.path.join(ROOT, "icon-512-maskable.png"),
                     output_width=512, output_height=512)
    print("icons written: icon-192.png, icon-512.png, icon-512-maskable.png")


if __name__ == "__main__":
    main()
