#!/usr/bin/env python3
"""psdz_scan.py <psdzdata> <IDEmu checkout> [out]  - pull the head unit's SOME/IP reference files out of PSdZData.

Finds the iDrive 7 HAR packages in <psdzdata>/swe/swfl (HU_MGU_01 / RSE_MGU_01, marker 'HAR#$%&@' at 0x200), lists
each one with IDEmu's tools/mgu/har.py (run, not copied: IDEmu is PolyForm Noncommercial) and extracts only small
reference files: the SOME/IP catalog, the vsomeip configs and security policies, passwd/group, systemd units, version
files, GNSS/positioning configs and each package's manifest (it has a SHA-256 per file, so the car's own catalog can
be matched to a package version later). Reads PSdZData only; writes only to [out] (default ~/sli-psdz) and
[out].tgz - send that archive over and unpack it into reference/psdz/.
"""
import hashlib, json, os, re, subprocess, sys, tarfile, time

MAGIC = b'HAR#$%&@'
WANT = (r'^/?etc/oap/someip/someip-interfaces\.json$'
        r'|^/?etc/vsomeip/'
        r'|^/?etc/(passwd|group|os-release|[^/]*version[^/]*|[^/]*release[^/]*)$'
        r'|^/?(etc|lib|usr/lib)/systemd/system/[^/]+\.(service|socket)$'
        r'|(?i:gnss|gps|positioning|deadreck|navcore|locationprovider)[^/]*\.(json|conf|xml|ini|cfg|fidl|fdepl|txt)$')
POI = re.compile(r'(?i)gnss|gps|posit|deadreck|navcore|locat')


def har_packages(psdz):
    d = os.path.join(psdz, 'swe', 'swfl')
    if not os.path.isdir(d): sys.exit('no swe/swfl under ' + psdz)
    for f in sorted(os.listdir(d)):
        if not re.match(r'^swfl_[0-9a-fA-F]{8}\.bin\.\d{3}_\d{3}_\d{3}$', f): continue
        p = os.path.join(d, f)
        try:
            with open(p, 'rb') as fh:
                fh.seek(0x200)
                if fh.read(8) == MAGIC: yield p
        except OSError:
            pass


def run_har(har, args):
    r = subprocess.run([sys.executable, '-I', har] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    if r.returncode: raise RuntimeError((r.stderr or r.stdout)[-400:])
    return r.stdout


def catalog_info(path):
    raw = open(path, 'rb').read()
    info = {'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
    try:
        db = json.loads(raw.decode('utf-8'))
        ifs = db.get('interfaces', {})
        info['interfaces'] = len(ifs)
        info['hits'] = sorted(n for n in ifs if POI.search(n) or n.endswith(('.GPSData', '.MapControl')))
    except Exception as e:
        info['error'] = str(e)
    return info


def main(argv):
    if len(argv) < 2: sys.exit(__doc__)
    psdz, idemu = os.path.abspath(argv[0]), os.path.abspath(argv[1])
    out = os.path.abspath(argv[2] if len(argv) > 2 else os.path.expanduser('~/sli-psdz'))
    har = os.path.join(idemu, 'tools', 'mgu', 'har.py')
    if not os.path.isfile(har): sys.exit('no ' + har)
    os.makedirs(os.path.join(out, 'lists'), exist_ok=True)
    want = re.compile(WANT)
    summary = []
    pkgs = list(har_packages(psdz))
    print('%d HAR packages' % len(pkgs))
    for i, p in enumerate(pkgs, 1):
        base = os.path.basename(p)
        t = time.time()
        row = {'package': base, 'bytes': os.path.getsize(p)}
        try:
            listing = run_har(har, ['-l', p])
        except Exception as e:
            row['error'] = str(e); summary.append(row); print('[%d/%d] %s  list failed: %s' % (i, len(pkgs), base, e)); continue
        open(os.path.join(out, 'lists', base + '.txt'), 'w').write(listing)
        names = [l.split(None, 4)[4] for l in listing.splitlines() if len(l.split(None, 4)) == 5]
        row['files'] = len(names)
        row['manifest'] = names[0] if names else None
        hit = [n for n in names if want.search(n)]
        row['poi'] = [n for n in names if POI.search(n)][:200]
        if hit or names:
            rx = '|'.join(['^%s$' % re.escape(names[0])] if names else []) + ('|' + WANT if hit else '')
            dest = os.path.join(out, 'pkgs', base)
            try:
                run_har(har, [p, dest, rx])
            except Exception as e:
                row['extract_error'] = str(e)
            cat = os.path.join(dest, 'etc', 'oap', 'someip', 'someip-interfaces.json')
            if os.path.isfile(cat): row['catalog'] = catalog_info(cat)
        row['wanted'] = len(hit)
        summary.append(row)
        print('[%d/%d] %s  %d files, %d kept%s  (%.0fs)' % (i, len(pkgs), base, row['files'], len(hit),
              ', CATALOG %s' % row['catalog']['sha256'][:12] if 'catalog' in row else '', time.time() - t))
    json.dump(summary, open(os.path.join(out, 'summary.json'), 'w'), indent=1)
    with tarfile.open(out + '.tgz', 'w:gz') as tf:
        tf.add(out, arcname=os.path.basename(out))
    print('\n%s.tgz  (%.1f MB)' % (out, os.path.getsize(out + '.tgz') / 1e6))
    for r in summary:
        if 'catalog' in r:
            c = r['catalog']
            print('catalog in %s: %s interfaces, sha256 %s, hits: %s' % (r['package'], c.get('interfaces'), c['sha256'], ', '.join(c.get('hits', [])) or '-'))


if __name__ == '__main__': main(sys.argv[1:])
