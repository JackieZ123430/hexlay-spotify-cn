'use strict';
/**
 * limitpack.js - reads a speed-limit pack (kit/tools/pack_sli.py: road pieces, their limits and a grid). Node 8.
 *
 *   const pack = LimitPack.open(file);
 *   pack.near(x, y, r)      ids of the pieces with a part within r Web Mercator metres of x, y (a superset)
 *   pack.piece(i)           { x0, y0, pt, n, cls, flags, limF, limB, src, way }
 *   pack.points(i)          [x0, y0, x1, y1, ...] in Web Mercator metres, along the piece
 *   merc(lat, lon)          [x, y] Web Mercator metres; groundScale(y): ground metres per mercator metre
 *
 * The whole file is read once (14-25 MB): lookups are a few Buffer reads, no parsing.
 */
const fs = require('fs');

const R = 6378137;
const F = { ONEWAY: 1, TUNNEL: 2, LINK: 4, ROUNDABOUT: 8, URBAN: 16, BRIDGE: 32 };
const SRC = { NONE: 0, NUM: 1, ZONE: 2, VAR: 3 };
const CLASS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service'];
const REC = 24;

function merc(lat, lon) {
    const la = Math.max(-85, Math.min(85, lat));
    return [R * lon * Math.PI / 180, R * Math.log(Math.tan(Math.PI / 4 + la * Math.PI / 360))];
}
function unmerc(x, y) { return [(2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI, x / R * 180 / Math.PI]; }
/** Ground metres per Web Mercator metre at mercator y (cos of the latitude). */
function groundScale(y) { return Math.cos(2 * Math.atan(Math.exp(y / R)) - Math.PI / 2); }

class LimitPack {
    static open(file) { return new LimitPack(fs.readFileSync(file), file); }

    constructor(buf, file) {
        if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'SLIP') throw new Error((file || 'pack') + ': not a speed-limit pack');
        const ver = buf.readUInt16LE(4), ns = buf.readUInt16LE(6);
        if (ver !== 1) throw new Error((file || 'pack') + ': pack version ' + ver + ' (this app reads 1)');
        this.buf = buf;
        this.file = file || '';
        this.sec = {};
        for (let i = 0; i < ns; i++) {
            const o = 16 + i * 12;
            this.sec[buf.toString('latin1', o, o + 4)] = { off: buf.readUInt32LE(o + 4), len: buf.readUInt32LE(o + 8) };
        }
        ['META', 'PIEC', 'PNTS', 'GRID'].forEach((s) => { if (!this.sec[s]) throw new Error((file || 'pack') + ': no ' + s + ' section'); });
        this.meta = JSON.parse(buf.toString('utf8', this.sec.META.off, this.sec.META.off + this.sec.META.len));
        this.count = buf.readUInt32LE(this.sec.PIEC.off);
        this.pieceBase = this.sec.PIEC.off + 4;
        this.ptBase = this.sec.PNTS.off + 4;
        const g = this.sec.GRID.off, cells = buf.readUInt32LE(g);
        this.grid = Object.assign({ cells, keys: g + 4, first: g + 4 + cells * 4, ids: g + 8 + cells * 8 }, this.meta.grid);
        const b = this.meta.bbox;                       // [lat0, lon0, lat1, lon1]
        const p0 = merc(b[0], b[1]), p1 = merc(b[2], b[3]);
        this.mbox = [p0[0], p0[1], p1[0], p1[1]];
    }

    /** Is x, y inside the pack's area (with a margin in mercator metres)? */
    covers(x, y, margin) {
        const m = margin || 0, b = this.mbox;
        return x >= b[0] - m && x <= b[2] + m && y >= b[1] - m && y <= b[3] + m;
    }

    _cell(key) {
        const G = this.grid, B = this.buf;
        let lo = 0, hi = G.cells - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1, v = B.readUInt32LE(G.keys + mid * 4);
            if (v === key) return mid;
            if (v < key) lo = mid + 1; else hi = mid - 1;
        }
        return -1;
    }

    /** Pieces in the grid cells within r of x, y (each once). */
    near(x, y, r) {
        const G = this.grid, B = this.buf, out = [];
        const c0 = Math.floor((x - r) / G.cell) - G.col0, c1 = Math.floor((x + r) / G.cell) - G.col0;
        const r0 = Math.floor((y - r) / G.cell) - G.row0, r1 = Math.floor((y + r) / G.cell) - G.row0;
        const many = c1 > c0 || r1 > r0, seen = many ? new Set() : null;
        for (let row = r0; row <= r1; row++) {
            if (row < 0 || row >= G.rows) continue;
            for (let col = c0; col <= c1; col++) {
                if (col < 0 || col >= G.cols) continue;
                const at = this._cell(row * G.cols + col);
                if (at < 0) continue;
                const f0 = B.readUInt32LE(G.first + at * 4), f1 = B.readUInt32LE(G.first + at * 4 + 4);
                for (let k = f0; k < f1; k++) {
                    const id = B.readUInt32LE(G.ids + k * 4);
                    if (seen) { if (seen.has(id)) continue; seen.add(id); }
                    out.push(id);
                }
            }
        }
        return out;
    }

    piece(i) {
        const B = this.buf, o = this.pieceBase + i * REC;
        return {
            id: i, x0: B.readInt32LE(o), y0: B.readInt32LE(o + 4), pt: B.readUInt32LE(o + 8), n: B.readUInt16LE(o + 12),
            cls: B[o + 14], flags: B[o + 15], limF: B[o + 16], limB: B[o + 17], src: B[o + 18], way: B.readUInt32LE(o + 20),
        };
    }

    /** The piece's points, Web Mercator metres: [x0, y0, x1, y1, ...]. */
    points(i, p) {
        const B = this.buf, P = p || this.piece(i), out = new Array(P.n * 2);
        out[0] = P.x0 / 10; out[1] = P.y0 / 10;
        let o = this.ptBase + P.pt * 4;
        for (let k = 1; k < P.n; k++, o += 4) {
            out[k * 2] = (P.x0 + B.readInt16LE(o)) / 10;
            out[k * 2 + 1] = (P.y0 + B.readInt16LE(o + 2)) / 10;
        }
        return out;
    }

    describe() {
        const m = this.meta;
        return (m.region || '?') + ' (OSM ' + (m.data || '?') + ', ' + this.count + ' pieces)';
    }
}

module.exports = { LimitPack, F, SRC, CLASS, merc, unmerc, groundScale };
