#!/usr/bin/env python3
"""qrlog_decode.py (from cauliflowermossgrape/idrive7-apps kit/tools/qrlog_decode.py, MIT) - turn photos of an app's
QR log back into the log (Speed Limit: Drive log > Show the log as QR codes, apps/speed_limit/qrlog.js).

    pip install zxing-cpp pillow
    python3 kit/tools/qrlog_decode.py photo1.jpg photo2.jpg ...   (or a folder of photos)
    python3 kit/tools/qrlog_decode.py --osm photos/               the drivers' corrections as roads to fix in OSM

Prints the log in time order (page 1 holds the newest lines, so it comes last) (a photo with several codes, or the same page twice, is fine). A page that
didn't read is named, so you can ask for that photo again.

--osm: instead of the log, Speed Limit's corrections in it (its "correction: way=..." lines, written when the QR
screen opens) as a list to check and fix in OpenStreetMap, newest first: a link to each road, to its place and to
the editor, what the driver set, what the map had and the tag to set. Nothing is sent anywhere: a person checks each
road (street-level photos, local knowledge) and edits OpenStreetMap; the monthly map rebuild then brings it to the
cars and their correction goes by itself. Besides photos it takes a log already decoded (.txt / .log) and the car's
data/corrections.json (copied over SSH).

A code is a text line "MGULOG2 d<n> <app> <version> <page>/<pages>" and a newline, then the page's log lines
compressed with raw deflate and the preset dictionary <n> (apps/speed_limit/qrdict.js holds dictionary 1; d0: none). In a page, a time
after the first is "+<seconds>" since the line before; the decoder writes hh:mm:ss again.
"""
import os
import sys
import zlib

import json
import re

zxingcpp = Image = ImageFilter = ImageOps = None


def _readers():
    """The QR reader, loaded for photos only (a decoded log or corrections.json needs none)."""
    global zxingcpp, Image, ImageFilter, ImageOps
    if zxingcpp is None:
        try:
            import zxingcpp as z
            from PIL import Image as I, ImageFilter as F, ImageOps as O
        except ImportError:
            sys.exit('photos need: pip install zxing-cpp pillow')
        zxingcpp, Image, ImageFilter, ImageOps = z, I, F, O

MAGIC = b'MGULOG2 '
DICT1 = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'apps', 'speed_limit', 'qrdict.js')


def dictionary(n):
    """Dictionary 1 is the JSON string in qrdict.js (the same bytes as idrive7-apps' qrlog-dict-1.txt)."""
    if n == 0:
        return None
    if n != 1:
        raise ValueError('dictionary %d is not known here' % n)
    import json
    with open(DICT1, encoding='utf-8') as f:
        js = f.read()
    a = js.index('Buffer.from(') + len('Buffer.from(')
    return json.JSONDecoder().raw_decode(js[a:])[0].encode('latin1')


def abs_times(text):
    """'+<seconds> ' after the line before -> hh:mm:ss again."""
    out, last = [], None
    for line in text.split('\n'):
        head, _, rest = line.partition(' ')
        if len(head) == 8 and head[2] == ':' and head[5] == ':' and head.replace(':', '').isdigit():
            h, m, s = (int(x) for x in head.split(':'))
            last = h * 3600 + m * 60 + s
        elif head[:1] == '+' and head[1:].isdigit() and last is not None:
            last += int(head[1:])
            line = '%02d:%02d:%02d %s' % (last // 3600 % 24, last // 60 % 60, last % 60, rest)
        out.append(line)
    return '\n'.join(out)


def codes(path):
    """The QR codes' bytes in one photo (as is, then cleaned up: grey with more contrast, sharpened, bigger)."""
    _readers()
    img = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    grey = ImageOps.autocontrast(img.convert('L'), cutoff=1)
    sharp = grey.filter(ImageFilter.UnsharpMask(radius=3, percent=200, threshold=0))
    big = sharp.resize((sharp.width * 2, sharp.height * 2), Image.LANCZOS)
    found = []
    for im in (img, grey, sharp, big):
        for r in zxingcpp.read_barcodes(im, formats=zxingcpp.BarcodeFormat.QRCode):
            if r.valid and r.bytes not in found:
                found.append(bytes(r.bytes))
        if found:
            break
    return found


def page(data):
    """A code's bytes -> (app version, page, pages, text) or None if it isn't a QR log code."""
    if not data.startswith(MAGIC) or b'\n' not in data:
        return None
    head, body = data.split(b'\n', 1)
    words = head.decode('utf8', 'replace').split(' ')
    try:
        n, of = (int(x) for x in words[-1].split('/'))
        d = dictionary(int(words[1][1:]))
        z = zlib.decompressobj(-15, zdict=d) if d else zlib.decompressobj(-15)
        text = abs_times((z.decompress(body) + z.flush()).decode('utf8', 'replace'))
    except (ValueError, IndexError, OSError, zlib.error):
        return None
    return ' '.join(words[2:-1]), n, of, text


CORR = re.compile(r'correction: way=(\d+) set=(\d+)/(\d+) map=(\S+) oneway=(\S+) at=(\S+) on=(\S+)')


def corrections(text):
    """The correction lines of a log, the last one of each road (a later QR log may hold a newer one)."""
    out = {}
    for m in CORR.finditer(text):
        way, f, b, mp, ow, at, on = m.groups()
        lat, lon = (at.split(',') + [None])[:2] if at != '-' else (None, None)
        out.pop(int(way), None)
        out[int(way)] = {'way': int(way), 'f': int(f), 'b': int(b), 'map': mp if mp != '-' else None,
                         'oneway': {'1': True, '0': False}.get(ow), 'lat': lat, 'lon': lon, 'at': on if on != '-' else None}
    return list(out.values())


def corrections_json(path):
    with open(path, encoding='utf-8') as f:
        roads = json.load(f).get('roads', [])
    return [{'way': int(r['way']), 'f': int(r.get('f') or 0), 'b': int(r.get('b') or 0), 'map': None, 'oneway': None,
             'lat': r.get('lat'), 'lon': r.get('lon'), 'at': r.get('at')} for r in roads if r.get('way')]


def _kmh(v):
    """'60d' -> 'none tagged (the default 60)', '90' -> '90 km/h', '0' -> 'none'."""
    m = re.fullmatch(r'(\d+)(d?)', v or '')
    if not m:
        return '?'
    n, d = int(m.group(1)), m.group(2)
    return ('none tagged (default %d)' % n if n else 'none tagged') if d else ('%d km/h' % n if n else 'none')


def osm_review(items):
    """The roads to check, newest first, as Markdown (it pastes into a GitHub issue as it is)."""
    if not items:
        return 'No corrections in it.'
    out = ['## Speed limits to check in OpenStreetMap (%d)' % len(items), '',
           'Check each road (a street-level photo, local knowledge) before editing; "forward" is the direction the way '
           'is drawn in (the arrows in the editor).', '']
    for i, c in enumerate(reversed(items), 1):
        f, b, ow = c['f'], c['b'], c['oneway']
        if ow or (f and f == b):
            # a one-way road (its pieces run the way traffic goes: the limit set is the road's) or both the same
            want, tags = '%d km/h' % (f or b) + ('' if ow else ' (both directions)'), 'maxspeed=%d' % (f or b)
        elif not b:
            want, tags = '%d km/h (forward)' % f, 'maxspeed:forward=%d' % f
        elif not f:
            want, tags = '%d km/h (backward)' % b, 'maxspeed:backward=%d' % b
        else:
            want, tags = '%d km/h forward, %d km/h backward' % (f, b), 'maxspeed:forward=%d + maxspeed:backward=%d' % (f, b)
        had = ''
        if c['map']:
            mf, _, mb = c['map'].partition('/')
            had = '; the map had ' + (_kmh(mf) if ow or mf == mb else _kmh(mf) + ' forward, ' + _kmh(mb) + ' backward')
        out.append('%d. **way %d**: the driver set %s%s%s%s' % (i, c['way'], want, had, ', one-way' if ow else '',
                                                               ' (%s)' % c['at'] if c['at'] else ''))
        out.append('   - road: https://www.openstreetmap.org/way/%d' % c['way'])
        if c['lat'] and c['lon']:
            out.append('   - place: https://www.openstreetmap.org/?mlat=%s&mlon=%s#map=18/%s/%s' % (c['lat'], c['lon'], c['lat'], c['lon']))
        out.append('   - edit: https://www.openstreetmap.org/edit?editor=id&way=%d' % c['way'])
        out.append('   - tag to set: `%s`' % tags)
    return '\n'.join(out)


def main(args):
    osm = '--osm' in args
    args = [a for a in args if a != '--osm']
    if osm:
        items, photos = [], []
        for a in args:
            if a.lower().endswith('.json'):
                items += corrections_json(a)
            elif a.lower().endswith(('.txt', '.log')):
                with open(a, encoding='utf-8', errors='replace') as f:
                    items += corrections(f.read())
            else:
                photos.append(a)
        if photos:
            import io
            from contextlib import redirect_stdout
            buf = io.StringIO()
            with redirect_stdout(buf):
                main(photos)
            items += corrections(buf.getvalue())
        seen = {}
        for c in items:
            seen.pop(c['way'], None)
            seen[c['way']] = c
        print(osm_review(list(seen.values())))
        return 0 if seen else 1
    files = []
    for a in args:
        if os.path.isdir(a):
            files += sorted(os.path.join(a, f) for f in os.listdir(a) if not f.startswith('.'))
        else:
            files.append(a)
    if not files:
        sys.exit(__doc__)
    logs = {}                                  # (app version, pages, page 1's text) -> {page: text}
    for f in files:
        try:
            got = [p for p in (page(c) for c in codes(f)) if p]
        except Exception as e:                 # not an image, unreadable file
            print('# %s: %s' % (f, e), file=sys.stderr)
            continue
        if not got:
            print('# %s: no QR log code found' % f, file=sys.stderr)
        for app, n, of, text in got:
            # photos of the QR log at different times are different logs (their page 1s differ): kept apart.
            # A page other than 1 joins the log it was photographed with (the same app, version and page count).
            key = (app, of, text if n == 1 else None)
            if n != 1:
                key = next((k for k in logs if k[:2] == (app, of) and n not in logs[k]), key)
            logs.setdefault(key, {})[n] = text
    for (app, of, _), pages in logs.items():
        missing = [str(i) for i in range(1, of + 1) if i not in pages]
        print('# %s, %d of %d pages%s' % (app, len(pages), of, ', missing: ' + ', '.join(missing) if missing else ''))
        for i in sorted(pages, reverse=True):      # page 1 is the newest: printed last, so the log reads in time order
            print(pages[i])
    return 0 if logs else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
