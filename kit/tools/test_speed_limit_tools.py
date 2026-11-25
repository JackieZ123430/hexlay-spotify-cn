#!/usr/bin/env python3
"""test_speed_limit_tools.py - Speed Limit's PC tools: the OpenStreetMap review list from corrections
(qrlog_decode.py --osm), the map comparison of the monthly rebuild (sli_diff.py) and the version bump (bump_version.py).

    python3 kit/tools/test_speed_limit_tools.py
"""
import io
import json
import os
import shutil
import sys
import tempfile
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, HERE)
import qrlog_decode as Q      # noqa: E402  (loads no QR reader: photos only)
import sli_diff               # noqa: E402
import bump_version           # noqa: E402

fails = []


def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok:
        fails.append(what)


# ---- the review list: lines as the car writes them when the QR screen opens (main.js logFixes)
log = '\n'.join([
    '-- 2026-11-23 (UTC)',
    '08:56:16 report: speed_limit 1.0.10, map 2026-11-21 (254826 pieces), 3 corrections, on, show=both',
    '+0 correction: way=59594305 set=40/40 map=60d/60d oneway=1 at=41.58993,44.94827 on=2026-11-22T14:23',
    '+0 correction: way=20647951 set=50/50 map=90/90 oneway=0 at=41.78164,44.96341 on=2026-11-22T15:01',
    '+0 correction: way=111 set=60/0 map=90/70 oneway=0 at=- on=-',
    '+30 drive: match way 59594305 40c shown 40c (map 60d) at 41.58993,44.94827 h355 42km/h nav 3m off',
    # a later QR log: the loop corrected again (the newest wins)
    '+60 correction: way=59594305 set=50/50 map=60d/60d oneway=1 at=41.58993,44.94827 on=2026-11-23T08:57',
])
items = Q.corrections(log)
check(len(items) == 3 and [c['way'] for c in items] == [20647951, 111, 59594305], 'corrections: one per road, a newer one replaces the older')
loop = items[-1]
check(loop['f'] == 50 and loop['oneway'] is True and loop['lat'] == '41.58993', 'the newest of the loop: 50, one-way, its place')
text = Q.osm_review(items)
first = text.split('\n1. ')[1].split('\n2. ')[0]
check('way 59594305' in first and 'none tagged (default 60)' in first and 'one-way' in first and '`maxspeed=50`' in first,
      'newest first: the loop, untagged on the map (default 60), maxspeed=50')
check('https://www.openstreetmap.org/way/59594305' in first and 'edit?editor=id&way=59594305' in first and 'mlat=41.58993' in first,
      'links to the road, the editor and the place')
two = text.split('\n2. ')[1].split('\n3. ')[0]
check('way 111' in two and 'maxspeed:forward=60' in two and '90 km/h forward, 70 km/h backward' in two and 'place:' not in two,
      'one direction only: maxspeed:forward, the map\'s two limits, no place when none was known')
check('maxspeed=50' in text.split('\n3. ')[1] and '(both directions)' in text.split('\n3. ')[1], 'both directions the same: maxspeed=50')
check(Q.osm_review([]) == 'No corrections in it.', 'no corrections: says so')

d = tempfile.mkdtemp()
try:
    cj = os.path.join(d, 'corrections.json')
    with open(cj, 'w', encoding='utf-8') as f:
        json.dump({'version': 1, 'roads': [{'way': 59594305, 'f': 50, 'b': 50, 'lat': 41.58993, 'lon': 44.94827, 'at': '2026-11-22T14:23'}]}, f)
    lg = os.path.join(d, 'speed_limit.log')
    with open(lg, 'w', encoding='utf-8') as f:
        f.write(log)
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = Q.main(['--osm', cj, lg])
    out = buf.getvalue()
    check(rc == 0 and '(3)' in out and out.count('**way 59594305**') == 1, '--osm: corrections.json and a decoded log together, each road once')

    # ---- the map comparison: the committed map against itself, and against one with a limit changed
    pack = os.path.join(ROOT, 'apps', 'speed_limit', 'georgia.pack')
    same = sli_diff.diff(sli_diff.read(pack), sli_diff.read(pack))
    check(not same['changed'], 'sli_diff: the same map: no change')
    old = sli_diff.read(pack)
    meta, ways, cams = old
    w = next(iter(ways))
    ways2 = dict(ways)
    ways2[w] = {(c, o, 77, 77, 5) for c, o, lf, lb, s in ways[w]}
    moved = sli_diff.diff(old, (meta, ways2, set(list(cams)[1:])))
    check(moved['changed'] and moved['roads_with_new_limits'] == 1 and moved['cameras_removed'] == 1, 'sli_diff: a new limit and a camera gone: changed')
    go = os.path.join(d, 'out.txt')
    with redirect_stdout(io.StringIO()):
        sli_diff.main([pack, pack, '--github-output', go])
    check('changed=false' in open(go, encoding='utf-8').read(), 'sli_diff: GitHub output written')

    # ---- the version bump, on a copy
    os.makedirs(os.path.join(d, 'apps', 'speed_limit'))
    shutil.copy(os.path.join(ROOT, 'apps', 'speed_limit', 'app.json'), os.path.join(d, 'apps', 'speed_limit', 'app.json'))
    shutil.copy(os.path.join(ROOT, 'README.md'), os.path.join(d, 'README.md'))
    v0 = json.load(open(os.path.join(d, 'apps', 'speed_limit', 'app.json'), encoding='utf-8'))['version']
    v1 = bump_version.bump('speed_limit', d)
    want = '.'.join(v0.split('.')[:-1] + [str(int(v0.split('.')[-1]) + 1)])
    readme = open(os.path.join(d, 'README.md'), encoding='utf-8').read()
    check(v1 == want and json.load(open(os.path.join(d, 'apps', 'speed_limit', 'app.json'), encoding='utf-8'))['version'] == want
          and '| [Speed Limit](#speed-limit) | %s |' % want in readme, 'bump_version: %s -> %s in app.json and the README table' % (v0, v1))
finally:
    shutil.rmtree(d, ignore_errors=True)

print('\nok' if not fails else '\nFAIL: ' + '; '.join(fails))
sys.exit(1 if fails else 0)
