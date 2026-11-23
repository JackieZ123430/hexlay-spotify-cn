'use strict';
/**
 * matcher.js - which road the car is on, and its speed limit. Node 8.
 *
 *   const m = new Matcher(pack, { defaults: { living: 20, urban: 60, rural: 90, motorway: 110 }, fixes });
 *   m.update({ x, y, heading, speed }, now)  -> result (below); fix null when there is no position
 *
 * Each update looks at the road pieces within `radius` ground metres (25 by default) and keeps those the car can be
 * driving along: within `gate` degrees (40) of its heading, the right way along a one-way road. The nearest wins,
 * with a small bonus for staying on the way it was on. Another way takes over only when it has won `switchTicks`
 * updates in a row (2), or at once when the way it was on is no longer a candidate (a turn). Without a position the
 * last road is held: in a tunnel until a position comes back, elsewhere for `holdMs` (15 s).
 *
 * The heading is the position source's when the car moves, else the bearing of the last few metres driven.
 *
 * fixes (fixes.js, optional): the driver's own limits for a road; they win over the map's. One the map has caught
 * up with (a newer map tags the same limit) is removed by itself the first time the car is on that road.
 *
 * result: { state: 'match' | 'hold' | 'none' | 'nofix' | 'outside', limit (km/h or null), inferred (no limit tagged:
 *   the class / settlement default), variable (signs that change), way, piece, cls, flags, dir (1 along the piece,
 *   -1 against, 0 unknown), dist (m), heading, candidates, ms (time spent), corrected (the driver's own limit),
 *   mapLimit / mapInferred (what the map alone says, while corrected) }
 */
const { F, SRC, groundScale } = require('./limitpack');

const DEFAULTS = { living: 20, urban: 60, rural: 90, motorway: 110 };

function angDiff(a, b) {
    let d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}
/** Bearing of dx, dy (Web Mercator is conformal: angles are true), degrees from north, clockwise. */
function bearing(dx, dy) { return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360; }

/** The limit of a piece driven in direction dir: { limit, inferred, variable, src }. */
function limitOf(P, dir, defaults) {
    const d = defaults || DEFAULTS;
    let lim, src;
    if (dir >= 0) { lim = P.limF; src = P.src & 3; } else { lim = P.limB; src = (P.src >> 2) & 3; }
    if (dir === 0 && P.limF !== P.limB) {
        // the direction is not known yet and the two ways differ: the lower one, and only if both are tagged
        const sf = P.src & 3, sb = (P.src >> 2) & 3;
        if ((sf === SRC.NUM || sf === SRC.ZONE) && (sb === SRC.NUM || sb === SRC.ZONE)) return { limit: Math.min(P.limF, P.limB), inferred: false, variable: false, src: sf };
        lim = 0; src = SRC.NONE;
    }
    if ((src === SRC.NUM || src === SRC.ZONE) && lim > 0) return { limit: lim, inferred: false, variable: false, src };
    let def;
    if (P.cls === 7) def = d.living;
    else if (P.cls === 0 && !(P.flags & F.LINK)) def = d.motorway;     // (its ramps: the settlement / rural one)
    else if (P.flags & F.URBAN) def = d.urban;
    else def = d.rural;
    return { limit: def || null, inferred: true, variable: src === SRC.VAR, src };
}

class Matcher {
    constructor(pack, opts) {
        const o = opts || {};
        this.pack = pack;
        this.radius = o.radius || 25;
        this.gate = o.gate || 40;
        this.switchTicks = o.switchTicks || 2;
        this.holdMs = o.holdMs == null ? 15000 : o.holdMs;
        this.tunnelHoldMs = o.tunnelHoldMs == null ? 600000 : o.tunnelHoldMs;
        this.defaults = Object.assign({}, DEFAULTS, o.defaults || {});
        this.fixes = o.fixes || null;
        this.reset();
    }

    setDefaults(d) { Object.assign(this.defaults, d || {}); }

    reset() {
        this.cur = null;            // { way, piece P, dir, dist, at }
        this.pending = null;        // { way, n, cand }
        this.lastPos = null;        // { x, y } where the derived heading was last taken
        this.heading = null;
        this.lastFixAt = 0;
        this.misses = 0;
    }

    _heading(fix) {
        const moving = fix.speed == null || fix.speed >= 6;
        if (fix.heading != null && isFinite(fix.heading) && moving) {
            this.heading = ((fix.heading % 360) + 360) % 360;
            this.lastPos = { x: fix.x, y: fix.y };
            return this.heading;
        }
        // from the way the car moved: once it is at least 6 m (ground) from where the last heading was taken
        if (this.lastPos) {
            const gs = groundScale(fix.y), dx = fix.x - this.lastPos.x, dy = fix.y - this.lastPos.y;
            if (Math.hypot(dx, dy) * gs >= 6) { this.heading = bearing(dx, dy); this.lastPos = { x: fix.x, y: fix.y }; }
        } else this.lastPos = { x: fix.x, y: fix.y };
        // standing still: the heading it had is kept (a parked car's GNSS heading means nothing)
        return this.heading;
    }

    /** Candidates near the fix: [{ P, dir, dist, diff, score }]. */
    _candidates(fix, heading) {
        const gs = groundScale(fix.y), rM = this.radius / gs;
        const ids = this.pack.near(fix.x, fix.y, rM), out = [];
        const slow = fix.speed != null && fix.speed < 12;
        for (let k = 0; k < ids.length; k++) {
            const P = this.pack.piece(ids[k]);
            const pts = this.pack.points(ids[k], P);
            let best = Infinity, bx = 0, by = 0, bu = 0, bi = 0;
            for (let i = 2; i < pts.length; i += 2) {
                const ax = pts[i - 2], ay = pts[i - 1], dx = pts[i] - ax, dy = pts[i + 1] - ay;
                const l2 = dx * dx + dy * dy;
                const uRaw = l2 > 0 ? ((fix.x - ax) * dx + (fix.y - ay) * dy) / l2 : 0;
                const u = uRaw < 0 ? 0 : uRaw > 1 ? 1 : uRaw;
                const ex = fix.x - (ax + dx * u), ey = fix.y - (ay + dy * u), d2 = ex * ex + ey * ey;
                if (d2 < best) { best = d2; bx = dx; by = dy; bu = uRaw; bi = i; }
            }
            const dist = Math.sqrt(best) * gs;
            if (dist > this.radius) continue;
            // how far the car is past the piece's end (start, driven against it): a road it has left at a junction
            const segM = Math.hypot(bx, by) * gs;
            const pastEnd = bi === pts.length - 2 && bu > 1 ? (bu - 1) * segM : 0;
            const pastStart = bi === 2 && bu < 0 ? -bu * segM : 0;
            const b = bearing(bx, by), oneway = (P.flags & F.ONEWAY) !== 0;
            const gate = (P.flags & F.ROUNDABOUT) || slow ? Math.max(this.gate, 70) : this.gate;
            let dir, diff;
            if (heading == null) { dir = oneway ? 1 : 0; diff = 0; } else {
                const dF = angDiff(heading, b), dB = angDiff(heading, b + 180);
                if (oneway || dF <= dB) { dir = 1; diff = dF; } else { dir = -1; diff = dB; }
                if (diff > gate) continue;
            }
            const past = dir > 0 ? pastEnd : dir < 0 ? pastStart : Math.max(pastEnd, pastStart);
            let score = dist + diff * 0.25;
            if (past > 2) score += 8 + past;
            else if (this.cur && P.way === this.cur.way) score -= 4;
            if (P.flags & F.LINK) score += 2;
            out.push({ P, dir, dist, diff, score, past: past > 2 });
        }
        out.sort((a, b) => a.score - b.score);
        return out;
    }

    update(fix, now) {
        const t0 = process.hrtime();
        const at = now == null ? Date.now() : now;
        const res = this._update(fix, at);
        const dt = process.hrtime(t0);
        res.ms = dt[0] * 1e3 + dt[1] / 1e6;
        return res;
    }

    _result(state, c, extra) {
        const r = Object.assign({ state, limit: null, inferred: false, variable: false, way: 0, piece: -1, cls: -1, flags: 0, dir: 0, dist: null, heading: this.heading, candidates: 0 }, extra || {});
        if (c) {
            const L = limitOf(c.P, c.dir, this.defaults);
            Object.assign(r, { limit: L.limit, inferred: L.inferred, variable: L.variable, way: c.P.way, piece: c.P.id, cls: c.P.cls, flags: c.P.flags, dir: c.dir, dist: c.dist });
            const fx = this.fixes && this.fixes.get(c.P.way);
            if (fx) this._fixed(r, c, fx, L);
        }
        return r;
    }

    /** The driver's correction of this road (fx { f, b }): its limit for the direction driven; the correction goes once
     * the map tags the same limits itself. */
    _fixed(r, c, fx, L) {
        const tagged = (d) => { const M = limitOf(c.P, d, this.defaults); return M.inferred ? 0 : M.limit; };
        const oneway = (c.P.flags & F.ONEWAY) !== 0;      // (driven only along its pieces: the other way is no road)
        if ((!fx.f || fx.f === tagged(1)) && (oneway || !fx.b || fx.b === tagged(-1))) { this.fixes.remove(c.P.way, 'the map has it now'); return; }
        const v = c.dir > 0 ? fx.f : c.dir < 0 ? fx.b : fx.f === fx.b ? fx.f : 0;
        if (!v) return;
        Object.assign(r, { limit: v, inferred: false, variable: false, corrected: true, mapLimit: L.limit, mapInferred: L.inferred });
    }

    _update(fix, at) {
        if (!fix || !isFinite(fix.x) || !isFinite(fix.y)) {
            // no position: hold the road the car was on (a tunnel holds until a position comes back)
            if (this.cur) {
                const tunnel = (this.cur.P.flags & F.TUNNEL) !== 0;
                if (at - this.lastFixAt <= (tunnel ? this.tunnelHoldMs : this.holdMs)) return this._result('hold', this.cur);
                this.cur = null;
            }
            return this._result('nofix', null);
        }
        if (!this.pack.covers(fix.x, fix.y, 2000)) { this.cur = null; this.lastFixAt = at; return this._result('outside', null); }
        this.lastFixAt = at;
        const heading = this._heading(fix);
        const cands = this._candidates(fix, heading);
        const best = cands[0] || null;
        if (!best) {
            // off every road the pack knows (a car park, a new road): a short gap keeps the last one
            this.misses++;
            this.pending = null;
            if (this.cur && this.misses <= this.switchTicks) return this._result('hold', this.cur, { candidates: 0 });
            this.cur = null;
            return this._result('none', null, { candidates: 0 });
        }
        this.misses = 0;
        if (!this.cur || best.P.way === this.cur.way) {
            this.cur = { way: best.P.way, P: best.P, dir: best.dir, dist: best.dist };
            this.pending = null;
        } else {
            // the way it was on, unless the car has driven past its end (it turned off at a junction)
            const stay = cands.find((c) => c.P.way === this.cur.way && !c.past);
            if (this.pending && this.pending.way === best.P.way) this.pending.n++; else this.pending = { way: best.P.way, n: 1 };
            if (!stay || this.pending.n >= this.switchTicks) {
                this.cur = { way: best.P.way, P: best.P, dir: best.dir, dist: best.dist };
                this.pending = null;
            } else this.cur = { way: stay.P.way, P: stay.P, dir: stay.dir, dist: stay.dist };
        }
        return this._result('match', this.cur, { candidates: cands.length });
    }
}

module.exports = { Matcher, limitOf, angDiff, bearing, DEFAULTS };
