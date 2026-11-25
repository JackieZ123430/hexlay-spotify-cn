#!/usr/bin/env python3
"""bump_version.py - the next patch version of an app: its app.json and its row in the README's table.

    python3 kit/tools/bump_version.py speed_limit        -> prints the new version (1.0.9 -> 1.0.10)

The README row is the one linking the app's title ("| [Speed Limit](#speed-limit) | 1.0.9 |"). Line endings and
the rest of both files are kept as they are.
"""
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


def rewrite(path, fn):
    raw = open(path, 'rb').read().decode('utf-8')
    crlf = '\r\n' in raw
    s = fn(raw.replace('\r\n', '\n'))
    open(path, 'wb').write((s.replace('\n', '\r\n') if crlf else s).encode('utf-8'))


def bump(app_id, root=ROOT):
    spec_path = os.path.join(root, 'apps', app_id, 'app.json')
    spec = json.load(open(spec_path, encoding='utf-8'))
    old = spec['version']
    parts = old.split('.')
    new = '.'.join(parts[:-1] + [str(int(parts[-1]) + 1)])
    n = [0]

    def app_json(s):
        out, k = re.subn(r'("version":\s*")' + re.escape(old) + '"', r'\g<1>' + new + '"', s, count=1)
        n[0] += k
        return out

    def readme(s):
        out, k = re.subn(r'(\| \[' + re.escape(spec['title']) + r'\]\([^)]*\) \| )' + re.escape(old) + r'( \|)', r'\g<1>' + new + r'\g<2>', s, count=1)
        n[0] += k
        return out

    rewrite(spec_path, app_json)
    rewrite(os.path.join(root, 'README.md'), readme)
    if n[0] != 2:
        raise SystemExit('%s: version %s not found in both app.json and the README table' % (app_id, old))
    return new


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    print(bump(sys.argv[1]))
