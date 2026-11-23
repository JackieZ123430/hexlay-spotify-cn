#!/usr/bin/env python3
"""Rebuild Spotify's CJK atlas with the pinned Noto Sans SC and Unicode Unihan 17.0 data.

Usage: python kit/tools/bake_spotify_cjk.py /path/to/NotoSansSC.ttf /path/to/Unihan.zip

The font and its checksum are documented in bake_cjk.py. Unihan is available at
https://www.unicode.org/Public/17.0.0/ucd/Unihan.zip under the Unicode data license
(https://www.unicode.org/license.txt). Only glyph bitmaps and code points are emitted.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
from zipfile import ZipFile

import bake_fonts
from bake_cjk import ROOT, SHA256
from localize import load_locale, zh_credit


def corpus_characters(archive):
    """Rank simplified characters by recorded frequency and include their traditional variants."""
    frequencies = {}
    variants = {}
    with ZipFile(archive) as data:
        for line in data.read('Unihan_Readings.txt').decode('utf-8').splitlines():
            if '\tkHanyuPinlu\t' in line:
                code, _, readings = line.split('\t')
                frequencies[code] = sum(int(n) for n in re.findall(r'\((\d+)\)', readings))
        for line in data.read('Unihan_Variants.txt').decode('utf-8').splitlines():
            if '\tkTraditionalVariant\t' in line:
                code, _, alternatives = line.split('\t')
                variants[code] = alternatives.split()
    for code in sorted(frequencies, key=lambda key: (-frequencies[key], key)):
        for candidate in (code, *variants.get(code, ())):
            point = int(candidate[2:], 16)
            if 0x4e00 <= point <= 0x9fff:
                yield chr(point)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('font', type=Path)
    parser.add_argument('unihan', type=Path)
    args = parser.parse_args()
    if hashlib.sha256(args.font.read_bytes()).hexdigest() != SHA256:
        parser.error('Noto Sans SC SHA-256 mismatch')
    bake_fonts.FONTDIR = str(args.font.resolve().parent)

    shared = ROOT / 'kit/runtime/fonts/cjk.json'
    shared_atlas = json.loads(shared.read_text(encoding='utf-8'))['sizes'][0]
    required = ''.join(chr(int(point)) for point in shared_atlas['glyphs'])
    required += ''.join(load_locale('zh-CN', 'spotify').values())
    required += zh_credit()['corner']
    # Common title, artist and device-name characters that a prose corpus can rank low.
    required += '稻香陳奕迅鄧紫棋粵藍牙音響客廳晴雙截棍周杰倫療癒靜謐孤勇葉惠美濾滤粒'
    ranked = list(dict.fromkeys(required + ''.join(corpus_characters(args.unihan))))

    # At k=1.44, the 27 px Now Playing title requests 39 logical pixels. Keep
    # one 40 px atlas and leave room in a 4,096 px column for earlier font uploads.
    atlas = bake_fonts.bake(args.font.name, (500,), 40, ''.join(ranked[:2100]))
    if atlas['atlasH'] > 3400 or any(ord(ch) not in atlas['glyphs'] for ch in required):
        raise SystemExit('Spotify atlas exceeds its renderer budget or is missing UI glyphs')
    encoded = json.dumps(atlas, separators=(',', ':')).encode()
    font = {'family': 'cjk', 'source': 'Noto Sans SC (OFL-1.1)',
            'cacheKey': hashlib.sha256(encoded).hexdigest()[:16], 'sizes': [atlas]}
    out = ROOT / 'kit/localization/fonts/spotify/zh-CN/cjk.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes((json.dumps(font, separators=(',', ':')) + '\n').encode())
    print('Spotify CJK:', len(atlas['glyphs']), 'glyphs at 40 px, atlas height', atlas['atlasH'])


if __name__ == '__main__':
    main()
