'use strict';
/**
 * limitpack.js - reads a speed-limit pack (kit/tools/pack_sli.py: road pieces, their limits and a grid). Node 8.
 *
 *   const pack = LimitPack.open(file);   ...   pack.close();
 *   pack.near(x, y, r)      ids of the pieces with a part within r Web Mercator metres of x, y (a superset)
 *   pack.piece(i)           { id, x0, y0, pt, n, cls, flags, limF, limB, src, way }
 *   pack.points(i)          [x0, y0, x1, y1, ...] in Web Mercator metres, along the piece
 *   pack.chain(ids)         a way's pieces in driving order (the pack keeps them by place, not by way)
 *   pack.cameras            speed cameras { n, x[], y[] (Web Mercator metres), dir[] (degrees, -1 not known), ms[] } (the
 *                           pack's CAMS section, a few KB, read whole; none in an older pack)
 *   merc(lat, lon)          [x, y] Web Mercator metres; groundScale(y): ground metres per mercator metre
 *
 * The file is not read into memory: everything is read from it in 8 KB pages, of which the last 96 (768 KB) are
 * kept. The pack keeps a place's roads together, so a drive reads a few new pages a minute.
 */
const fs = require('fs');

const R = 6378137;
const F = { ONEWAY: 1, TUNNEL: 2, LINK: 4, ROUNDABOUT: 8, URBAN: 16, BRIDGE: 32 };
const SRC = { NONE: 0, NUM: 1, ZONE: 2, VAR: 3 };
const CLASS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service'];
const REC = 24;
const PAGE_BITS = 13, PAGE = 1 << PAGE_BITS, PAGES = 96;

function merc(lat, lon) {
    const la = Math.max(-85, Math.min(85, lat));
    return [R * lon * Math.PI / 180, R * Math.log(Math.tan(Math.PI / 4 + la * Math.PI / 360))];
}
function unmerc(x, y) { return [(2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI, x / R * 180 / Math.PI]; }
/** Ground metres per Web Mercator metre at mercator y (cos of the latitude). */
function groundScale(y) { return Math.cos(2 * Math.atan(Math.exp(y / R)) - Math.PI / 2); }

/** A file read in pages, the most recently used kept. Values never cross a page (the pack's fields are aligned). */
class Pages {
    constructor(fd, size) {
        this.fd = fd; this.size = size;
        this.map = new Map();
        this.lastN = -1; this.last = null;
        this.reads = 0;
    }
    page(off) {
        const n = off >>> PAGE_BITS;
        if (n === this.lastN) return this.last;
        let b = this.map.get(n);
        if (b) { this.map.delete(n); this.map.set(n, b); } else {
            b = Buffer.allocUnsafe(PAGE);
            fs.readSync(this.fd, b, 0, Math.min(PAGE, this.size - n * PAGE), n * PAGE);
            this.reads++;
            this.map.set(n, b);
            if (this.map.size > PAGES) this.map.delete(this.map.keys().next().value);
        }
        this.lastN = n; this.last = b;
        return b;
    }
    u32(off) { return this.page(off).readUInt32LE(off & (PAGE - 1)); }
    i32(off) { return this.page(off).readInt32LE(off & (PAGE - 1)); }
    u16(off) { return this.page(off).readUInt16LE(off & (PAGE - 1)); }
    i16(off) { return this.page(off).readInt16LE(off & (PAGE - 1)); }
    u8(off) { return this.page(off)[off & (PAGE - 1)]; }
    bytes(off, len) {
        const b = Buffer.allocUnsafe(len);
        fs.readSync(this.fd, b, 0, len, off);
        return b;
    }
}

class LimitPack {
    static open(file) {
        const fd = fs.openSync(file, 'r');
        try { return new LimitPack(fd, fs.fstatSync(fd).size, file); } catch (e) { fs.closeSync(fd); throw e; }
    }

    constructor(fd, size, file) {
        const P = this.p = new Pages(fd, size);
        this.size = size;
        this.file = file || '';
        const head = P.bytes(0, 16);
        if (head.toString('latin1', 0, 4) !== 'SLIP') throw new Error(this.file + ': not a speed-limit pack');
        const ver = head.readUInt16LE(4), ns = head.readUInt16LE(6);
        if (ver !== 1) throw new Error(this.file + ': pack version ' + ver + ' (this app reads 1)');
        const table = P.bytes(16, ns * 12);
        this.sec = {};
        for (let i = 0; i < ns; i++) this.sec[table.toString('latin1', i * 12, i * 12 + 4)] = { off: table.readUInt32LE(i * 12 + 4), len: table.readUInt32LE(i * 12 + 8) };
        ['META', 'PIEC', 'PNTS', 'GRID'].forEach((s) => { if (!this.sec[s]) throw new Error(this.file + ': no ' + s + ' section'); });
        this.meta = JSON.parse(P.bytes(this.sec.META.off, this.sec.META.len).toString('utf8'));
        this.count = P.u32(this.sec.PIEC.off);
        this.pieceBase = this.sec.PIEC.off + 4;
        this.ptBase = this.sec.PNTS.off + 4;
        const g = this.sec.GRID.off, cells = P.u32(g);
        this.grid = Object.assign({ cells, keys: g + 4, first: g + 4 + cells * 4, ids: g + 8 + cells * 8 }, this.meta.grid);
        this.cameras = this._cameras();
        const b = this.meta.bbox;                       // [lat0, lon0, lat1, lon1]
        const p0 = merc(b[0], b[1]), p1 = merc(b[2], b[3]);
        this.mbox = [p0[0], p0[1], p1[0], p1[1]];
    }

    _cameras() {
        const c = this.sec.CAMS, out = { n: 0, x: [], y: [], dir: [], ms: [] };
        if (!c || c.len < 4) return out;
        const b = this.p.bytes(c.off, c.len), n = Math.min(b.readUInt32LE(0), Math.floor((c.len - 4) / 12));
        for (let i = 0; i < n; i++) {
            const o = 4 + i * 12, d = b.readUInt16LE(o + 8);
            out.x.push(b.readInt32LE(o) / 10); out.y.push(b.readInt32LE(o + 4) / 10);
            out.dir.push(d === 0xFFFF ? -1 : d); out.ms.push(b[o + 10]);
        }
        out.n = n;
        return out;
    }

    close() {
        if (this.p.fd === null) return;
        try { fs.closeSync(this.p.fd); } catch (e) { /* gone */ }
        this.p.fd = null; this.p.map.clear(); this.p.last = null; this.p.lastN = -1;
    }

    /** Is x, y inside the pack's area (with a margin in mercator metres)? */
    covers(x, y, margin) {
        const m = margin || 0, b = this.mbox;
        return x >= b[0] - m && x <= b[2] + m && y >= b[1] - m && y <= b[3] + m;
    }

    _cell(key) {
        const G = this.grid, P = this.p;
        let lo = 0, hi = G.cells - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1, v = P.u32(G.keys + mid * 4);
            if (v === key) return mid;
            if (v < key) lo = mid + 1; else hi = mid - 1;
        }
        return -1;
    }

    /** Pieces in the grid cells within r of x, y (each once). */
    near(x, y, r) {
        const G = this.grid, P = this.p, out = [];
        const c0 = Math.floor((x - r) / G.cell) - G.col0, c1 = Math.floor((x + r) / G.cell) - G.col0;
        const r0 = Math.floor((y - r) / G.cell) - G.row0, r1 = Math.floor((y + r) / G.cell) - G.row0;
        const seen = c1 > c0 || r1 > r0 ? new Set() : null;
        for (let row = r0; row <= r1; row++) {
            if (row < 0 || row >= G.rows) continue;
            for (let col = c0; col <= c1; col++) {
                if (col < 0 || col >= G.cols) continue;
                const at = this._cell(row * G.cols + col);
                if (at < 0) continue;
                const f0 = P.u32(G.first + at * 4), f1 = P.u32(G.first + at * 4 + 4);
                for (let k = f0; k < f1; k++) {
                    const id = P.u32(G.ids + k * 4);
                    if (seen) { if (seen.has(id)) continue; seen.add(id); }
                    out.push(id);
                }
            }
        }
        return out;
    }

    piece(i) {
        const P = this.p, o = this.pieceBase + i * REC;
        return {
            id: i, x0: P.i32(o), y0: P.i32(o + 4), pt: P.u32(o + 8), n: P.u16(o + 12),
            cls: P.u8(o + 14), flags: P.u8(o + 15), limF: P.u8(o + 16), limB: P.u8(o + 17), src: P.u8(o + 18), way: P.u32(o + 20),
        };
    }

    /** The piece's points, Web Mercator metres: [x0, y0, x1, y1, ...]. */
    points(i, piece) {
        const P = this.p, Q = piece || this.piece(i), out = new Array(Q.n * 2);
        out[0] = Q.x0 / 10; out[1] = Q.y0 / 10;
        let o = this.ptBase + Q.pt * 4;
        for (let k = 1; k < Q.n; k++, o += 4) {
            out[k * 2] = (Q.x0 + P.i16(o)) / 10;
            out[k * 2 + 1] = (Q.y0 + P.i16(o + 2)) / 10;
        }
        return out;
    }

    /** A way's pieces (ids) in driving order: each one starts where the one before it ends. */
    chain(ids) {
        if (ids.length < 2) return ids.slice();
        const key = (x, y) => Math.round(x) + ',' + Math.round(y);
        const firsts = new Map(), lasts = new Set();
        ids.forEach((id) => {
            const p = this.points(id);
            firsts.set(key(p[0], p[1]), id);
            lasts.add(key(p[p.length - 2], p[p.length - 1]));
        });
        let start = ids.find((id) => { const p = this.points(id); return !lasts.has(key(p[0], p[1])); });
        if (start === undefined) start = ids[0];                     // a closed way: anywhere
        const out = [], used = new Set();
        for (let id = start; id !== undefined && !used.has(id); ) {
            out.push(id); used.add(id);
            const p = this.points(id);
            id = firsts.get(key(p[p.length - 2], p[p.length - 1]));
        }
        ids.forEach((id) => { if (!used.has(id)) out.push(id); });   // (a gap: the rest after)
        return out;
    }

    describe() {
        const m = this.meta;
        return (m.region || '?') + ' (OSM ' + (m.data || '?') + ', ' + this.count + ' pieces)';
    }
}

module.exports = { LimitPack, F, SRC, CLASS, merc, unmerc, groundScale };
