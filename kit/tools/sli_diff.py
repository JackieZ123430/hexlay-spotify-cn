#!/usr/bin/env python3
"""sli_diff.py - what changed between two Speed Limit maps (kit/tools/pack_sli.py packs) for a driver.

    python3 kit/tools/sli_diff.py old.pack new.pack [--github-output FILE]

Compares the roads (OpenStreetMap way ids), each road's limits (tagged numbers, zones, signs that change, per
direction) and the speed cameras. Prints a summary; "changed" is yes when any road, limit or camera differs (a new
build date alone is not a change). --github-output appends changed=true|false and the summary for a GitHub job.
Standard library only.
"""
import argparse
import json
import struct
import sys


def read(path):
    with open(path, 'rb') as f:
        b = f.read()
    if b[:4] != b'SLIP':
        raise SystemExit(path + ': not a Speed Limit pack')
    _, nsec, _, _ = struct.unpack_from('<HHII', b, 4)
    sec = {}
    for i in range(nsec):
        sid, off, ln = struct.unpack_from('<4sII', b, 16 + 12 * i)
        sec[sid.decode()] = (off, ln)
    meta = json.loads(b[sec['META'][0]:sec['META'][0] + sec['META'][1]].decode('utf-8'))
    off = sec['PIEC'][0]
    n = struct.unpack_from('<I', b, off)[0]
    ways = {}
    for i in range(n):
        _, _, _, _, cls, flags, lf, lb, src, _, wid = struct.unpack_from('<iiIHBBBBBBI', b, off + 4 + 24 * i)
        ways.setdefault(wid, set()).add((cls, flags & 1, lf, lb, src))
    cams = set()
    if 'CAMS' in sec:
        off = sec['CAMS'][0]
        for i in range(struct.unpack_from('<I', b, off)[0]):
            x, y, d, ms, _ = struct.unpack_from('<iiHBB', b, off + 4 + 12 * i)
            cams.add((round(x / 10), round(y / 10), d, ms))      # to the metre
    return meta, ways, cams


def limits(pieces):
    """A road's limits as a driver sees them: the tagged ones (number or zone, either direction)."""
    out = set()
    for cls, ow, lf, lb, src in pieces:
        out.add((lf if src & 3 in (1, 2, 3) else 0, lb if (src >> 2) & 3 in (1, 2, 3) else 0, src))
    return out


def diff(old, new):
    mo, wo, co = old
    mn, wn, cn = new
    added = wn.keys() - wo.keys()
    removed = wo.keys() - wn.keys()
    changed = [w for w in wn.keys() & wo.keys() if limits(wn[w]) != limits(wo[w])]
    tagged_new = sum(1 for w in added if any(l != (0, 0, 0) for l in limits(wn[w])))
    s = {
        'data': [mo.get('data'), mn.get('data')],
        'roads_added': len(added), 'roads_removed': len(removed), 'roads_with_new_limits': len(changed),
        'new_roads_with_a_limit': tagged_new,
        'cameras': [len(co), len(cn)], 'cameras_added': len(cn - co), 'cameras_removed': len(co - cn),
    }
    s['changed'] = bool(added or removed or changed or co != cn)
    return s


def summary(s):
    return ('map %s -> %s: %d roads with new limits, %d roads added (%d with a limit), %d removed; '
            'cameras %d -> %d (+%d, -%d)') % (s['data'][0], s['data'][1], s['roads_with_new_limits'], s['roads_added'],
                                             s['new_roads_with_a_limit'], s['roads_removed'], s['cameras'][0], s['cameras'][1],
                                             s['cameras_added'], s['cameras_removed'])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('old')
    ap.add_argument('new')
    ap.add_argument('--github-output')
    a = ap.parse_args(argv)
    s = diff(read(a.old), read(a.new))
    text = summary(s)
    print(text)
    print('changed: ' + ('yes' if s['changed'] else 'no'))
    if a.github_output:
        with open(a.github_output, 'a', encoding='utf-8') as f:
            f.write('changed=%s\nsummary=%s\ndata=%s\n' % ('true' if s['changed'] else 'false', text, s['data'][1] or ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
