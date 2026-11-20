'use strict';
/**
 * cameras.js - the speed camera ahead, from the pack's cameras (OpenStreetMap highway=speed_camera). Node 8.
 *
 *   const cams = new Cameras(pack.cameras);
 *   cams.update({ x, y }, heading, now)  -> { dist (ground metres, along the way the car heads), ms } | null
 *
 * A camera counts when it is ahead (up to RANGE metres along the car's heading), close to the line the car drives
 * (CROSS metres either side: on this road, not one beside it), and, when OpenStreetMap says which traffic it checks
 * (direction=*), checking the car's direction (within GATE degrees). The nearest such camera is warned about until the
 * car has passed it (or it has fallen well off the car's line: a turn). Without a heading (standing still before the
 * first metres) the camera warned about stays.
 *
 * Cost: a box test per camera (Georgia has about 260), then a few multiplications for those within RANGE.
 */
const { groundScale } = require('./limitpack');

const RANGE = 400, CROSS = 30, GATE = 60, PASSED = 10, KEEP_CROSS = 60;

function angDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

class Cameras {
    constructor(cams) {
        this.c = cams || { n: 0 };
        this.cur = -1;              // the camera warned about
    }

    /** Along (ahead +) and across (either side) the car's heading, in ground metres, from x, y to camera i. */
    _rel(i, x, y, hx, hy, gs) {
        const dx = (this.c.x[i] - x) * gs, dy = (this.c.y[i] - y) * gs;
        return { along: dx * hx + dy * hy, cross: Math.abs(dx * hy - dy * hx) };
    }

    update(fix, heading, now) {
        const c = this.c;
        if (!c.n || !fix) return this.cur >= 0 && this.last != null ? this._out(this.last) : null;
        if (heading == null) return this.cur >= 0 && this.last ? this._out(this.last) : null;
        const gs = groundScale(fix.y), hr = heading * Math.PI / 180, hx = Math.sin(hr), hy = Math.cos(hr);
        // the one warned about: until passed, or well off the car's line (it turned away)
        if (this.cur >= 0) {
            const r = this._rel(this.cur, fix.x, fix.y, hx, hy, gs);
            if (r.along < -PASSED || r.along > RANGE + 150 || r.cross > KEEP_CROSS) this.cur = -1;
            else { this.last = r.along; return this._out(r.along); }
        }
        const box = RANGE / gs;
        let best = -1, bestAlong = Infinity;
        for (let i = 0; i < c.n; i++) {
            if (Math.abs(c.x[i] - fix.x) > box || Math.abs(c.y[i] - fix.y) > box) continue;
            const r = this._rel(i, fix.x, fix.y, hx, hy, gs);
            if (r.along < 0 || r.along > RANGE || r.cross > CROSS) continue;
            if (c.dir[i] >= 0 && angDiff(heading, c.dir[i]) > GATE) continue;
            if (r.along < bestAlong) { best = i; bestAlong = r.along; }
        }
        this.cur = best;
        this.last = best >= 0 ? bestAlong : null;
        return best >= 0 ? this._out(bestAlong) : null;
    }

    _out(along) { return { dist: Math.max(0, along), ms: this.cur >= 0 ? this.c.ms[this.cur] || 0 : 0 }; }

    reset() { this.cur = -1; this.last = null; }
}

/** The distance as the badge shows it: 50 m steps (10 m under 100 m), so the picture changes every few seconds. */
function camText(dist) {
    const d = dist < 100 ? Math.max(0, Math.round(dist / 10) * 10) : Math.round(dist / 50) * 50;
    return d + ' m';
}

module.exports = { Cameras, camText, RANGE };
