#!/usr/bin/env python3
"""pack_sli.py - compile an OpenStreetMap extract into a speed-limit pack for apps/speed_limit (no map, no names).

    python3 kit/tools/pack_sli.py reference/osm/georgia-latest.osm.pbf -o apps/speed_limit/georgia.slp

Only what the app needs to tell the limit of the road the car is on: drivable roads as short pieces (their shape,
class, flags, the limit each way) and a grid to find the pieces near a position. The PBF reader is osm_nav's
(hexlay/idrive7-geo-map kit/tools/pack_osm.py, MIT); Python's standard library only.

Layout (little endian; sections 4-byte aligned):

  0   'SLIP'  u16 version (1)  u16 sections  u32 meta length  u32 0
  16  sections x { char[4] id, u32 offset, u32 length }
  META  JSON: region, source, built, bbox (degrees), grid { cell, col0, row0, cols, rows } (Web Mercator metres),
        counts, attribution
  PIEC  u32 n, n x 24 bytes:
          i32 x0, i32 y0      first point, Web Mercator decimetres
          u32 pt              index of its second point in PNTS
          u16 n               points (the first included)
          u8  class           0 motorway 1 trunk 2 primary 3 secondary 4 tertiary 5 unclassified 6 residential
                              7 living_street 8 service (only with a limit tagged)
          u8  flags           1 oneway, 2 tunnel, 4 link (ramp), 8 roundabout, 16 urban (inside a settlement, by
                              landuse and places), 32 bridge (car parks and driveways are left out)
          u8  limF, u8 limB   km/h along / against the piece's direction (0: none tagged)
          u8  src             bits 0-1 forward, 2-3 backward: 0 untagged, 1 a number, 2 a zone ("GE:urban"),
                              3 signs that change (signals, variable)
          u8  0
          u32 way             OSM way id
  PNTS  u32 n, n x { i16 dx, i16 dy }  decimetres from the piece's first point
  GRID  u32 cells, u32 key[cells] (row * cols + col, sorted), u32 first[cells + 1], u32 piece[]
  CAMS  (optional: a reader without it ignores it) u32 n, n x 12 bytes: i32 x, i32 y (Web Mercator decimetres),
        u16 direction of the traffic it checks (degrees from north, 0xFFFF not known), u8 maxspeed (0 not known), u8 0.
        From highway=speed_camera nodes and the devices of enforcement=maxspeed relations.

A oneway road's piece runs the way traffic goes (oneway=-1 is turned round, its limits swapped). Pieces are in the
Z-order of the grid cell they start in, so a place's roads are close together in the file; a way's pieces are not
(chain them by their end points).
"""
import argparse
import bisect
import json
import math
import os
import struct
import sys
import time
import zlib
from array import array

R_EARTH = 6378137.0
VERSION = 1
CELL = 400.0            # grid cell, Web Mercator metres
URBAN_CELL = 100.0      # settlement raster cell
SIMPLIFY = 1.5          # Douglas-Peucker tolerance, Web Mercator metres
SEG_MAX = 150.0         # longer segments get points in between (the i16 deltas and the grid stay small)
PIECE_MAX = 500.0       # a piece is at most this long

ROAD = {
    'motorway': 0, 'trunk': 1, 'primary': 2, 'secondary': 3, 'tertiary': 4, 'unclassified': 5, 'road': 5,
    'residential': 6, 'living_street': 7, 'service': 8,
    'motorway_link': 0, 'trunk_link': 1, 'primary_link': 2, 'secondary_link': 3, 'tertiary_link': 4,
}
F_ONEWAY, F_TUNNEL, F_LINK, F_ROUNDABOUT, F_URBAN, F_BRIDGE, F_MINOR = 1, 2, 4, 8, 16, 32, 64
SRC_NONE, SRC_NUM, SRC_ZONE, SRC_VAR = 0, 1, 2, 3
CARDINAL = {'N': 0, 'NNE': 22, 'NE': 45, 'ENE': 67, 'E': 90, 'ESE': 112, 'SE': 135, 'SSE': 157, 'S': 180, 'SSW': 202,
            'SW': 225, 'WSW': 247, 'W': 270, 'WNW': 292, 'NW': 315, 'NNW': 337}
ZONES = {'urban': 60, 'rural': 90, 'motorway': 110, 'living_street': 20, 'walk': 20, 'pedestrian': 20}
URBAN_LANDUSE = ('residential', 'commercial', 'retail', 'industrial', 'garages', 'construction', 'education')
PLACE_RADIUS = {'city': 3000, 'town': 1500, 'village': 600, 'suburb': 700, 'quarter': 400, 'neighbourhood': 300,
                'hamlet': 250}


# ---------------------------------------------------------------- OSM PBF (from osm_nav's pack_osm.py)
def _varint(b, i):
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        if c < 0x80:
            return r, i
        s += 7


def _fields(b):
    i, n = 0, len(b)
    while i < n:
        key, i = _varint(b, i)
        f, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _varint(b, i)
        elif wt == 2:
            ln, i = _varint(b, i)
            v = b[i:i + ln]
            i += ln
        elif wt == 1:
            v = b[i:i + 8]
            i += 8
        elif wt == 5:
            v = b[i:i + 4]
            i += 4
        else:
            raise ValueError('protobuf wire type %d' % wt)
        yield f, wt, v


def _packed(b):
    out = []
    i, n = 0, len(b)
    ap = out.append
    while i < n:
        r = s = 0
        while True:
            c = b[i]
            i += 1
            r |= (c & 0x7F) << s
            if c < 0x80:
                break
            s += 7
        ap(r)
    return out


def _zz(v):
    return (v >> 1) ^ -(v & 1)


def _blocks(path):
    with open(path, 'rb') as f:
        while True:
            h = f.read(4)
            if len(h) < 4:
                return
            hdr = f.read(struct.unpack('>I', h)[0])
            btype, size = '', 0
            for fn, wt, v in _fields(hdr):
                if fn == 1:
                    btype = bytes(v).decode()
                elif fn == 3:
                    size = v
            blob = f.read(size)
            if len(blob) < size:
                raise ValueError('the .pbf ends in the middle of a block (an incomplete download?)')
            raw = None
            for fn, wt, v in _fields(blob):
                if fn == 1:
                    raw = bytes(v)
                elif fn == 3:
                    raw = zlib.decompress(bytes(v))
                elif fn == 4:
                    import lzma
                    raw = lzma.decompress(bytes(v))
                elif fn in (6, 7):
                    raise ValueError('this .pbf uses lz4/zstd blobs: recompress it with osmium (zlib)')
            if btype == 'OSMHeader' and raw is not None:
                yield 'header', memoryview(raw)
            elif btype == 'OSMData' and raw is not None:
                yield 'data', memoryview(raw)


def _block(raw, want):
    """One PrimitiveBlock; want = set of 'nodes', 'ways', 'rels'."""
    strings, groups = [], []
    gran, lat_off, lon_off = 100, 0, 0
    for fn, wt, v in _fields(raw):
        if fn == 1:
            strings = [bytes(s).decode('utf-8', 'replace') for f2, w2, s in _fields(v) if f2 == 1]
        elif fn == 2:
            groups.append(v)
        elif fn == 17:
            gran = v
        elif fn == 19:
            lat_off = v
        elif fn == 20:
            lon_off = v
    for g in groups:
        for fn, wt, v in _fields(g):
            if fn == 2 and 'nodes' in want:
                ids = lats = lons = kv = None
                for f2, w2, v2 in _fields(v):
                    if f2 == 1:
                        ids = _packed(v2)
                    elif f2 == 8:
                        lats = _packed(v2)
                    elif f2 == 9:
                        lons = _packed(v2)
                    elif f2 == 10:
                        kv = _packed(v2)
                nid = la = lo = 0
                k = 0
                for j in range(len(ids)):
                    nid += _zz(ids[j])
                    la += _zz(lats[j])
                    lo += _zz(lons[j])
                    tags = None
                    if kv:
                        while k < len(kv) and kv[k] != 0:
                            if tags is None:
                                tags = {}
                            tags[strings[kv[k]]] = strings[kv[k + 1]]
                            k += 2
                        k += 1
                    yield ('n', nid, 1e-9 * (lat_off + gran * la), 1e-9 * (lon_off + gran * lo), tags)
            elif fn == 1 and 'nodes' in want:
                nid, la, lo, keys, vals = 0, 0, 0, [], []
                for f2, w2, v2 in _fields(v):
                    if f2 == 1:
                        nid = _zz(v2)
                    elif f2 == 2:
                        keys = _packed(v2)
                    elif f2 == 3:
                        vals = _packed(v2)
                    elif f2 == 8:
                        la = _zz(v2)
                    elif f2 == 9:
                        lo = _zz(v2)
                tags = {strings[a]: strings[b] for a, b in zip(keys, vals)} or None
                yield ('n', nid, 1e-9 * (lat_off + gran * la), 1e-9 * (lon_off + gran * lo), tags)
            elif fn == 3 and 'ways' in want:
                wid, keys, vals, refs = 0, [], [], []
                for f2, w2, v2 in _fields(v):
                    if f2 == 1:
                        wid = v2
                    elif f2 == 2:
                        keys = _packed(v2)
                    elif f2 == 3:
                        vals = _packed(v2)
                    elif f2 == 8:
                        refs = _packed(v2)
                acc, rr = 0, []
                for r in refs:
                    acc += _zz(r)
                    rr.append(acc)
                yield ('w', wid, rr, {strings[a]: strings[b] for a, b in zip(keys, vals)})
            elif fn == 4 and 'rels' in want:
                rid, keys, vals, roles, mids, types = 0, [], [], [], [], []
                for f2, w2, v2 in _fields(v):
                    if f2 == 1:
                        rid = v2
                    elif f2 == 2:
                        keys = _packed(v2)
                    elif f2 == 3:
                        vals = _packed(v2)
                    elif f2 == 8:
                        roles = _packed(v2)
                    elif f2 == 9:
                        mids = _packed(v2)
                    elif f2 == 10:
                        types = _packed(v2)
                acc, mm = 0, []
                for r, m, ty in zip(roles, mids, types):
                    acc += _zz(m)
                    mm.append((('node', 'way', 'relation')[ty], acc, strings[r]))
                yield ('r', rid, mm, {strings[a]: strings[b] for a, b in zip(keys, vals)})


def header_timestamp(path):
    """osmosis_replication_timestamp of the extract (seconds), or None."""
    for kind, raw in _blocks(path):
        if kind != 'header':
            return None
        for fn, wt, v in _fields(raw):
            if fn == 32:
                return v
        return None
    return None


# ---------------------------------------------------------------- geometry
def merc(lat, lon):
    lat = max(-85.0, min(85.0, lat))
    return (R_EARTH * math.radians(lon), R_EARTH * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


def merc_scale(y):
    """Web Mercator metres per ground metre at mercator y."""
    return 1.0 / math.cos(2 * math.atan(math.exp(y / R_EARTH)) - math.pi / 2)


def simplify(pts, tol):
    """Douglas-Peucker (iterative); keeps both ends. (osm_nav's.)"""
    n = len(pts)
    if n < 3 or tol <= 0:
        return list(pts)
    keep = bytearray(n)
    keep[0] = keep[-1] = 1
    stack = [(0, n - 1)]
    t2 = tol * tol
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if l2 == 0:
                d = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
                d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d > best:
                best, bi = d, i
        if best > t2:
            keep[bi] = 1
            stack.append((a, bi))
            stack.append((bi, b))
    return [p for p, k in zip(pts, keep) if k]


def assemble_rings(ways):
    """Closed rings from way coordinate lists that join end to end (multipolygon members). (osm_nav's.)"""
    rings, open_ = [], [list(w) for w in ways if len(w) >= 2]
    while open_:
        cur = open_.pop()
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, w in enumerate(open_):
                if w[0] == cur[-1]:
                    cur += w[1:]
                elif w[-1] == cur[-1]:
                    cur += w[-2::-1]
                elif w[-1] == cur[0]:
                    cur = w[:-1] + cur
                elif w[0] == cur[0]:
                    cur = w[:0:-1] + cur
                else:
                    continue
                open_.pop(i)
                changed = True
                break
        if cur[0] == cur[-1] and len(cur) >= 4:
            rings.append(cur[:-1])
    return rings


# ---------------------------------------------------------------- tags
def road_class(t):
    hw = t.get('highway')
    if hw not in ROAD or t.get('area') == 'yes':
        return -1
    if t.get('access') in ('no', 'private') and t.get('motor_vehicle') not in ('yes', 'designated', 'destination'):
        return -1
    if t.get('motor_vehicle') == 'no' or t.get('motorcar') == 'no':
        return -1
    return ROAD[hw]


def parse_limit(v):
    """(km/h, source) of a maxspeed value; (0, SRC_NONE) if it says nothing usable."""
    if not v:
        return 0, SRC_NONE
    v = v.split(';')[0].strip()
    lv = v.lower()
    if lv in ('signals', 'variable'):
        return 0, SRC_VAR
    if ':' in lv:
        zone = lv.split(':', 1)[1].strip()
        if zone in ZONES:
            return ZONES[zone], SRC_ZONE
        return 0, SRC_NONE
    if lv in ZONES:
        return ZONES[lv], SRC_ZONE
    num = ''
    for ch in lv:
        if ch.isdigit():
            num += ch
        elif num:
            break
    if not num:
        return 0, SRC_NONE
    s = int(num)
    if 'mph' in lv:
        s = round(s * 1.609344)
    if s < 5 or s > 250:
        return 0, SRC_NONE
    return s, SRC_NUM


def limits(t):
    """(limF, srcF, limB, srcB) along and against the way's own direction."""
    base = parse_limit(t.get('maxspeed'))
    if base[1] == SRC_NONE:
        for k in ('maxspeed:type', 'source:maxspeed', 'zone:maxspeed'):
            z = parse_limit(t.get(k))
            if z[1] == SRC_ZONE:
                base = z
                break
    f = parse_limit(t.get('maxspeed:forward'))
    b = parse_limit(t.get('maxspeed:backward'))
    if f[1] == SRC_NONE:
        f = base
    if b[1] == SRC_NONE:
        b = base
    return f[0], f[1], b[0], b[1]


def camera_direction(v):
    """Degrees (0..359) of a camera's direction=* (degrees or N/NE/...), or 0xFFFF; several or forward/backward: none."""
    v = (v or '').strip().upper()
    if v in CARDINAL:
        return CARDINAL[v]
    try:
        d = float(v)
    except ValueError:
        return 0xFFFF
    return int(round(d)) % 360


def oneway_of(t, cls):
    ow = t.get('oneway', '')
    rb = t.get('junction') in ('roundabout', 'circular')
    if ow == '-1':
        return -1, rb
    if ow in ('yes', '1', 'true') or rb:
        return 1, rb
    if cls == 0 and ow != 'no' and t.get('highway') in ('motorway', 'motorway_link'):
        return 1, rb
    return 0, rb


# ---------------------------------------------------------------- settlements
class Urban:
    """A raster of the places that are inside a settlement: landuse areas and circles round place nodes."""

    def __init__(self, bbox_m):
        x0, y0, x1, y1 = bbox_m
        self.x0 = math.floor(x0 / URBAN_CELL) * URBAN_CELL
        self.y0 = math.floor(y0 / URBAN_CELL) * URBAN_CELL
        self.cols = int(math.ceil((x1 - self.x0) / URBAN_CELL)) + 1
        self.rows = int(math.ceil((y1 - self.y0) / URBAN_CELL)) + 1
        self.bits = bytearray(self.cols * self.rows)

    def fill_ring(self, ring):
        """Scan-line fill of a ring of mercator points (cell centres inside)."""
        ys = [p[1] for p in ring]
        r0 = max(0, int((min(ys) - self.y0) / URBAN_CELL))
        r1 = min(self.rows - 1, int((max(ys) - self.y0) / URBAN_CELL))
        n = len(ring)
        for row in range(r0, r1 + 1):
            cy = self.y0 + (row + 0.5) * URBAN_CELL
            xs = []
            for i in range(n):
                ax, ay = ring[i]
                bx, by = ring[i - 1]
                if (ay > cy) != (by > cy):
                    xs.append(ax + (cy - ay) * (bx - ax) / (by - ay))
            xs.sort()
            base = row * self.cols
            for k in range(0, len(xs) - 1, 2):
                c0 = max(0, int(math.ceil((xs[k] - self.x0) / URBAN_CELL - 0.5)))
                c1 = min(self.cols - 1, int(math.floor((xs[k + 1] - self.x0) / URBAN_CELL - 0.5)))
                if c1 >= c0:
                    self.bits[base + c0:base + c1 + 1] = b'\x01' * (c1 - c0 + 1)

    def fill_disc(self, x, y, r):
        r0 = max(0, int((y - r - self.y0) / URBAN_CELL))
        r1 = min(self.rows - 1, int((y + r - self.y0) / URBAN_CELL))
        for row in range(r0, r1 + 1):
            cy = self.y0 + (row + 0.5) * URBAN_CELL
            h = r * r - (cy - y) ** 2
            if h <= 0:
                continue
            w = math.sqrt(h)
            c0 = max(0, int((x - w - self.x0) / URBAN_CELL))
            c1 = min(self.cols - 1, int((x + w - self.x0) / URBAN_CELL))
            if c1 >= c0:
                self.bits[row * self.cols + c0:row * self.cols + c1 + 1] = b'\x01' * (c1 - c0 + 1)

    def at(self, x, y):
        c = int((x - self.x0) / URBAN_CELL)
        r = int((y - self.y0) / URBAN_CELL)
        if c < 0 or r < 0 or c >= self.cols or r >= self.rows:
            return False
        return self.bits[r * self.cols + c] == 1

    def share(self):
        return sum(self.bits) / float(len(self.bits))


def is_urban_area(t):
    return t.get('landuse') in URBAN_LANDUSE or t.get('place') in ('city', 'town', 'village', 'suburb', 'quarter',
                                                                    'neighbourhood', 'hamlet')


# ---------------------------------------------------------------- reading
def read(path, log):
    t0 = time.time()
    rel_areas = []          # [(member way ids outer)]
    member_ways = set()
    devices = set()         # speed cameras of enforcement=maxspeed relations
    for kind, raw in _blocks(path):
        if kind != 'data':
            continue
        for _, rid, mm, t in _block(raw, {'rels'}):
            if t.get('type') == 'enforcement' and t.get('enforcement') == 'maxspeed':
                devices.update(m[1] for m in mm if m[0] == 'node' and m[2] == 'device')
            if t.get('type') in ('multipolygon', 'boundary') and is_urban_area(t):
                outer = [m[1] for m in mm if m[0] == 'way' and m[2] in ('outer', '')]
                rel_areas.append(outer)
                member_ways.update(outer)
    log('  pass 1: %d settlement relations (%.0f s)' % (len(rel_areas), time.time() - t0))

    roads, areas, way_refs = [], [], {}
    need = array('q')
    for kind, raw in _blocks(path):
        if kind != 'data':
            continue
        for _, wid, refs, t in _block(raw, {'ways'}):
            cls = road_class(t)
            if cls >= 0 and len(refs) >= 2:
                roads.append((wid, refs, t, cls))
                need.extend(refs)
            elif is_urban_area(t) and len(refs) >= 4 and refs[0] == refs[-1]:
                areas.append(refs)
                need.extend(refs)
            if wid in member_ways:
                way_refs[wid] = refs
                need.extend(refs)
    log('  pass 2: %d roads, %d settlement areas (%.0f s)' % (len(roads), len(areas), time.time() - t0))

    ids = array('q', sorted(set(need)))
    del need
    lat = array('i', bytes(4 * len(ids)))
    lon = array('i', bytes(4 * len(ids)))
    places = []
    cameras = []            # (lat, lon, direction, maxspeed)
    k, n = 0, len(ids)
    for kind, raw in _blocks(path):
        if kind != 'data':
            continue
        for _, nid, la, lo, tags in _block(raw, {'nodes'}):
            if tags and tags.get('place') in PLACE_RADIUS:
                places.append((la, lo, tags['place']))
            if tags and tags.get('highway') == 'speed_camera' or nid in devices:
                t = tags or {}
                cameras.append((la, lo, camera_direction(t.get('direction')), parse_limit(t.get('maxspeed'))[0]))
            while k < n and ids[k] < nid:
                k += 1
            if k < n and ids[k] == nid:
                lat[k] = int(round(la * 1e7))
                lon[k] = int(round(lo * 1e7))
    log('  pass 3: %d nodes, %d places, %d speed cameras (%.0f s)' % (n, len(places), len(cameras), time.time() - t0))

    def coords(refs):
        out = []
        for r in refs:
            i = bisect.bisect_left(ids, r)
            if i < n and ids[i] == r and (lat[i] or lon[i]):
                out.append(merc(lat[i] * 1e-7, lon[i] * 1e-7))
        return out

    rings = [coords(a) for a in areas]
    for outer in rel_areas:
        rings += assemble_rings([coords(way_refs[w]) for w in outer if w in way_refs])
    return roads, rings, places, coords, cameras


# ---------------------------------------------------------------- compiling
def densify(pts):
    out = [pts[0]]
    for i in range(1, len(pts)):
        ax, ay = out[-1]
        bx, by = pts[i]
        d = math.hypot(bx - ax, by - ay)
        k = int(d // SEG_MAX)
        for j in range(1, k + 1):
            f = j / float(k + 1)
            out.append((ax + (bx - ax) * f, ay + (by - ay) * f))
        out.append((bx, by))
    return out


def compile_pack(roads, rings, places, coords, log):
    t0 = time.time()
    geo = []
    xmin = ymin = float('inf')
    xmax = ymax = float('-inf')
    for wid, refs, t, cls in roads:
        pts = coords(refs)
        if len(pts) < 2:
            continue
        geo.append((wid, pts, t, cls))
        for x, y in pts:
            xmin, ymin, xmax, ymax = min(xmin, x), min(ymin, y), max(xmax, x), max(ymax, y)
    urban = Urban((xmin, ymin, xmax, ymax))
    for ring in rings:
        if len(ring) >= 3:
            urban.fill_ring(ring)
    for la, lo, kind in places:
        x, y = merc(la, lo)
        urban.fill_disc(x, y, PLACE_RADIUS[kind] * merc_scale(y))
    log('  settlements: %.1f %% of the area (%.0f s)' % (100 * urban.share(), time.time() - t0))

    pieces = []      # (x0, y0, [(dx, dy)...], cls, flags, limF, limB, src, wid)
    stats = {'roads': 0, 'km': 0.0, 'km_tagged': 0.0, 'km_zone': 0.0, 'km_urban_untagged': 0.0,
             'km_rural_untagged': 0.0, 'by_class_km': [0.0] * 9, 'by_class_tagged_km': [0.0] * 9}
    for wid, pts, t, cls in geo:
        ow, rb = oneway_of(t, cls)
        lf, sf, lb, sb = limits(t)
        if ow == -1:
            pts = pts[::-1]
            lf, sf, lb, sb = lb, sb, lf, sf
        flags = F_ONEWAY if ow else 0
        if rb:
            flags |= F_ROUNDABOUT
        if t.get('tunnel') not in (None, 'no'):
            flags |= F_TUNNEL
        if t.get('bridge') not in (None, 'no'):
            flags |= F_BRIDGE
        if t.get('highway', '').endswith('_link'):
            flags |= F_LINK
        if cls == 8 and (sf == SRC_NONE and sb == SRC_NONE or t.get('service') in ('parking_aisle', 'driveway')):
            continue        # service roads without a limit, car parks, driveways: no sign to show, and they pull a
            #                 match off the street beside them (the app shows nothing there)
        if ow:
            lb, sb = 0, SRC_NONE
        src = (sf & 3) | ((sb & 3) << 2)
        pts = densify(simplify(pts, SIMPLIFY))
        stats['roads'] += 1
        # split where the road enters or leaves a settlement, and every PIECE_MAX metres
        cur = [pts[0]]
        cur_urban = None
        length = 0.0

        def flush(cur, u):
            if len(cur) < 2:
                return
            x0, y0 = int(round(cur[0][0] * 10)), int(round(cur[0][1] * 10))
            d = [(int(round(p[0] * 10)) - x0, int(round(p[1] * 10)) - y0) for p in cur[1:]]
            pieces.append((x0, y0, d, cls, flags | (F_URBAN if u else 0), lf, lb, src, wid, cur))

        for i in range(1, len(pts)):
            a, b = pts[i - 1], pts[i]
            seg = math.hypot(b[0] - a[0], b[1] - a[1])
            u = urban.at((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            if cur_urban is None:
                cur_urban = u
            if u != cur_urban or length + seg > PIECE_MAX and len(cur) >= 2:
                flush(cur, cur_urban)
                cur, length, cur_urban = [a], 0.0, u
            cur.append(b)
            length += seg
            km = seg / merc_scale(a[1]) / 1000.0
            stats['km'] += km
            stats['by_class_km'][cls] += km
            if sf == SRC_NUM:
                stats['km_tagged'] += km
                stats['by_class_tagged_km'][cls] += km
            elif sf == SRC_ZONE:
                stats['km_zone'] += km
                stats['by_class_tagged_km'][cls] += km
            elif u:
                stats['km_urban_untagged'] += km
            else:
                stats['km_rural_untagged'] += km
        flush(cur, cur_urban)
    log('  %d pieces (%.0f s)' % (len(pieces), time.time() - t0))

    col0 = int(math.floor(xmin / CELL)) - 1
    row0 = int(math.floor(ymin / CELL)) - 1
    cols = int(math.ceil(xmax / CELL)) - col0 + 2
    rows = int(math.ceil(ymax / CELL)) - row0 + 2

    # pieces (and so their points) in Z-order of the cell they start in: the roads near one place sit together in
    # the file, so the app reads a few small pages of it per place instead of holding all of it in memory
    def zkey(p):
        c, r = int(p[0] / 10 // CELL) - col0, int(p[1] / 10 // CELL) - row0
        k = 0
        for b in range(16):
            k |= ((c >> b) & 1) << (2 * b) | ((r >> b) & 1) << (2 * b + 1)
        return k
    pieces.sort(key=zkey)
    cells = {}
    for i, p in enumerate(pieces):
        pts = p[9]
        seen = set()
        for j in range(1, len(pts)):
            a, b = pts[j - 1], pts[j]
            for c in range(int(math.floor(min(a[0], b[0]) / CELL)), int(math.floor(max(a[0], b[0]) / CELL)) + 1):
                for r in range(int(math.floor(min(a[1], b[1]) / CELL)), int(math.floor(max(a[1], b[1]) / CELL)) + 1):
                    key = (r - row0) * cols + (c - col0)
                    if key not in seen:
                        seen.add(key)
                        cells.setdefault(key, []).append(i)
    log('  grid: %d cells (%.0f s)' % (len(cells), time.time() - t0))
    grid = {'cell': CELL, 'col0': col0, 'row0': row0, 'cols': cols, 'rows': rows}
    bbox = [unmerc_lat(ymin), xmin / R_EARTH * 180 / math.pi, unmerc_lat(ymax), xmax / R_EARTH * 180 / math.pi]
    return pieces, cells, grid, bbox, stats


def unmerc_lat(y):
    return math.degrees(2 * math.atan(math.exp(y / R_EARTH)) - math.pi / 2)


def cams_section(cameras):
    out = bytearray(struct.pack('<I', len(cameras)))
    for la, lo, d, ms in cameras:
        x, y = merc(la, lo)
        out += struct.pack('<iiHBB', int(round(x * 10)), int(round(y * 10)), d, min(255, ms), 0)
    return bytes(out)


def write(path, pieces, cells, grid, bbox, meta_extra, cameras=None):
    piec = bytearray(struct.pack('<I', len(pieces)))
    pnts = array('h')
    for x0, y0, d, cls, flags, lf, lb, src, wid, _ in pieces:
        piec += struct.pack('<iiIHBBBBBBI', x0, y0, len(pnts) // 2, len(d) + 1, cls, flags, lf, lb, src, 0, wid)
        for dx, dy in d:
            if not (-32768 <= dx <= 32767 and -32768 <= dy <= 32767):
                raise ValueError('piece of way %d is too long for i16 offsets' % wid)
            pnts.append(dx)
            pnts.append(dy)
    pnts_b = struct.pack('<I', len(pnts) // 2) + pnts.tobytes()
    keys = sorted(cells)
    first, ids = array('I'), array('I')
    for k in keys:
        first.append(len(ids))
        ids.extend(cells[k])
    first.append(len(ids))
    grid_b = struct.pack('<I', len(keys)) + array('I', keys).tobytes() + first.tobytes() + ids.tobytes()
    meta = dict(meta_extra, bbox=[round(v, 6) for v in bbox], grid=grid, pieces=len(pieces), points=len(pnts) // 2,
                cameras=len(cameras or []), attribution='© OpenStreetMap contributors (ODbL)')
    meta_b = json.dumps(meta, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    secs = [(b'META', meta_b), (b'PIEC', bytes(piec)), (b'PNTS', pnts_b), (b'GRID', grid_b), (b'CAMS', cams_section(cameras or []))]
    off = 16 + 12 * len(secs)
    table, body = b'', b''
    for sid, data in secs:
        off_al = (off + 3) & ~3
        body += b'\0' * (off_al - off) + data
        table += struct.pack('<4sII', sid, off_al, len(data))
        off = off_al + len(data)
    head = b'SLIP' + struct.pack('<HHII', VERSION, len(secs), len(meta_b), 0)
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(head + table + body)
    os.replace(tmp, path)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('pbf')
    ap.add_argument('-o', '--out', required=True)
    ap.add_argument('--region', default='Georgia')
    a = ap.parse_args(argv)
    log = lambda s: print(s, flush=True)
    t0 = time.time()
    log('reading ' + a.pbf)
    ts = header_timestamp(a.pbf)
    roads, rings, places, coords, cameras = read(a.pbf, log)
    pieces, cells, grid, bbox, stats = compile_pack(roads, rings, places, coords, log)
    data_date = time.strftime('%Y-%m-%d', time.gmtime(ts)) if ts else None
    write(a.out, pieces, cells, grid, bbox, {'region': a.region, 'source': os.path.basename(a.pbf),
                                              'data': data_date, 'built': time.strftime('%Y-%m-%d')}, cameras)
    km = stats['km'] or 1
    log('%s: %.1f MB, %d pieces, %.0f km of road (%.0f s)' % (a.out, os.path.getsize(a.out) / 1e6, len(pieces), km,
                                                               time.time() - t0))
    log('  limit tagged: %.1f %% (zones %.1f %%), untagged in settlements %.1f %%, outside %.1f %%' % (
        100 * stats['km_tagged'] / km, 100 * stats['km_zone'] / km, 100 * stats['km_urban_untagged'] / km,
        100 * stats['km_rural_untagged'] / km))
    names = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living', 'service']
    for i, nm in enumerate(names):
        if stats['by_class_km'][i]:
            log('    %-13s %8.0f km, %5.1f %% tagged' % (nm, stats['by_class_km'][i],
                                                      100 * stats['by_class_tagged_km'][i] / stats['by_class_km'][i]))


if __name__ == '__main__':
    main()
