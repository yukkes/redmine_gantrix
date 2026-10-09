#!/usr/bin/env python3
"""Build the theme's application.css with the icons inlined as SVG data URIs.

    python3 tools/build_theme_icons.py           # writes themes/gantrix/stylesheets/application.css
    python3 tools/build_theme_icons.py --check   # fails if that file is not up to date

Edit tools/theme/application.src.css, not the generated file. Reads the icons in
tools/theme/icons/*.svg, optimizes each one (SVGO-style: attributes sorted, decimals
rounded, path data shortened, whole-viewBox clipPaths dropped, whitespace collapsed)
and rewrites every
    url(images/icons.svg#name)
in the source into
    url("data:image/svg+xml,<the icon>").

The icons come from lychee_theme_basic (MIT License, (c) Agileware Inc.).
"""
import pathlib
import re
import sys
import urllib.parse
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS = ROOT / 'tools/theme/icons'
SRC = ROOT / 'tools/theme/application.src.css'
CSS = ROOT / 'themes/gantrix/stylesheets/application.css'
NS = 'http://www.w3.org/2000/svg'

ET.register_namespace('', NS)


def number(m):
    """Rounds a coordinate to 2 decimals: smaller paths, the same pixels."""
    s = f'{float(m.group(0)):.2f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def path_data(m):
    """Shorten a path's d: no spaces around commands or before a minus, .5 for 0.5."""
    d = re.sub(r'(?<![\d.])0\.(\d)', r'.\1', m.group(1))
    d = re.sub(r'\s*([A-Za-z])\s*', r'\1', d)
    d = re.sub(r'\s+-', '-', d)
    # 1.5 .3 -> 1.5.3: the second dot starts a new number
    d = re.sub(r'(\.\d+)\s+(?=\.)', r'\1', d)
    return f'd="{d}"'


def unclip(src):
    """Drop a clipPath that is just the whole viewBox (Figma exports one): it clips nothing."""
    box = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', src)
    clip = re.search(r'<defs><clipPath id="([^"]+)"><rect width="([\d.]+)" height="([\d.]+)"[^>]*/></clipPath></defs>', src)
    if not (box and clip and box.groups() == clip.group(2, 3)):
        return src
    src = src.replace(clip.group(0), '')
    return re.sub(rf'<g clip-path="url\(#{clip.group(1)}\)">(.*)</g>', r'\1', src, flags=re.S)


def optimize(src):
    """Minimize one SVG source: drop comments/whitespace, shorten numbers and quotes."""
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    src = re.sub(r'>\s+<', '><', src.strip())
    src = unclip(src)
    src = re.sub(r'-?\d*\.\d{3,}', number, src)
    src = re.sub(r'\bd="([^"]*)"', path_data, src)
    # lowercase hex colors
    src = re.sub(r'#[0-9A-Fa-f]{6}\b', lambda m: m.group(0).lower(), src)
    # single quotes are shorter inside the data URI
    src = src.replace('"', "'")
    return src


def data_uri(svg):
    """Percent-encode the SVG for a CSS url(); keep it readable where safe."""
    # a space is shorter than %20 and allowed inside a quoted url
    encoded = urllib.parse.quote(svg, safe="()=':;,&+/?~ ")
    return f'url("data:image/svg+xml,{encoded}")'


def main():
    icons = sorted(ICONS.glob('*.svg'))
    if not icons:
        sys.exit(f'no icons in {ICONS}')
    uris = {}
    for path in icons:
        name = path.stem
        svg = optimize(path.read_text(encoding='utf-8'))
        uris[name] = data_uri(svg)

    css = SRC.read_text(encoding='utf-8')
    used = set(re.findall(r'url\(images/icons\.svg#([\w-]+)\)', css))
    missing = sorted(used - set(uris))
    if missing:
        sys.exit(f'used in {SRC.name} but not in tools/theme/icons: {missing}')

    out = re.sub(r'url\(images/icons\.svg#[\w-]+\)', lambda m: uris[m.group(0)[len('url(images/icons.svg#'):-1]], css)
    left = re.findall(r'url\(images/icons\.svg#?[\w-]*\)', out)
    if left:
        sys.exit(f'sprite references left: {sorted(set(left))}')
    if '--check' in sys.argv[1:]:
        if CSS.read_text(encoding='utf-8') != out:
            sys.exit(f'{CSS.relative_to(ROOT)} is out of date: run python3 tools/build_theme_icons.py')
        print(f'{CSS.relative_to(ROOT)} is up to date')
        return
    CSS.write_text(out, encoding='utf-8')
    n = len(re.findall(r'data:image/svg\+xml', out))
    print(f'{CSS.relative_to(ROOT)}: {n} inlined icons ({len(out)} bytes)')


if __name__ == '__main__':
    main()
