#!/usr/bin/env python3
"""Build the icon font: only the glyphs listed in GX.ICONS (core.js), taken from Tabler Icons (MIT).

    npm pack @tabler/icons-webfont@3.49.0 && tar xzf tabler-icons-webfont-3.49.0.tgz
    python3 tools/build_icons.py package          # needs fonttools and brotli (pip install fonttools brotli)

Writes assets/stylesheets/gantrix-icons.woff2 (next to gantrix.css, so the relative
url() works with Redmine 5's plugin_assets and Redmine 6+'s Propshaft alike).
"""
import pathlib
import re
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
CORE = ROOT / 'assets/javascripts/gantrix/core.js'
OUT = ROOT / 'assets/stylesheets/gantrix-icons.woff2'


def main(package):
    package = pathlib.Path(package)
    block = re.search(r'GX\.ICONS = \{(.*?)\};', CORE.read_text(), re.S).group(1)
    icons = {name: int(code, 16) for name, code in re.findall(r"'?([\w-]+)'?: 0x([0-9a-f]+)", block)}
    # outside the Private Use Area a code point is a real character (U+FAD2 is a CJK ideograph), which
    # the fallback font draws until the icon font arrives: pick another icon
    outside = [n for n, c in icons.items() if not 0xE000 <= c <= 0xF8FF]
    if outside:
        sys.exit(f'outside the Private Use Area: {outside}')
    css = (package / 'dist/tabler-icons.css').read_text()
    for name, code in icons.items():
        m = re.search(r'\.ti-%s:before \{\s*content: "\\([0-9a-f]+)"' % re.escape(name), css)
        if not m or int(m.group(1), 16) != code:
            sys.exit(f'{name}: 0x{code:x} does not match Tabler ({m and m.group(1)})')
    font = TTFont(package / 'dist/fonts/tabler-icons.woff2')
    # Tabler's left side bearings are 0 while the outlines start further right; the WOFF2 writer trusts the
    # bearing and moves every outline to the left edge. Make them agree so the icons stay centered.
    glyf, hmtx = font['glyf'], font['hmtx']
    for name in font.getGlyphOrder():
        g = glyf[name]
        if g.numberOfContours:
            g.recalcBounds(glyf)
            hmtx[name] = (hmtx[name][0], g.xMin)
    # one set of vertical metrics (the tables disagree, and browsers pick different ones): the line box is
    # the 1000-unit design square from -100 to 900, whose middle is the middle of the icons
    hhea, os2 = font['hhea'], font['OS/2']
    hhea.ascent, hhea.descent, hhea.lineGap = 900, -100, 0
    os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap = 900, -100, 0
    os2.usWinAscent, os2.usWinDescent = 900, 100
    os2.fsSelection |= 1 << 7   # USE_TYPO_METRICS
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = []
    options.name_IDs = [0, 1, 2, 13, 14]   # keep the copyright and license entries
    options.notdef_outline = False
    sub = subset.Subsetter(options)
    sub.populate(unicodes=icons.values())
    sub.subset(font)
    missing = [n for n, c in icons.items() if c not in font.getBestCmap()]
    if missing:
        sys.exit(f'not in the font: {missing}')
    font.flavor = 'woff2'
    font.save(OUT)
    print(f'{OUT.relative_to(ROOT)}: {len(icons)} icons, {OUT.stat().st_size} bytes')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'package')
