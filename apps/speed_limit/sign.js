'use strict';
/**
 * sign.js - the speed limit sign. Node 8.
 *
 *   drawSign(60, { size: 96, inferred, over })     -> { w, h, px (straight-alpha RGBA Buffer), key }  (cluster-render)
 *   paintSign(surface, cx, cy, r, 60, { inferred, over })  on a kit canvas.js Canvas or record.js Recorder (the page)
 *
 * The European sign: a white disc, a red ring, the limit in black. A limit that is only the road's default (no
 * limit tagged on the map) has a grey ring and a grey dot under the number, so it reads as a guess. Over the limit
 * (the threshold set): the disc turns red and the number white. No limit known (limit null): three dashes in a grey
 * ring, as BMW's Speed Limit Info shows then. Outside the disc everything is transparent (on the
 * HUD, black and transparent are both see-through).
 */
const { Canvas } = require('./kit/canvas');

const RED = '#d0021b', GREY = '#8a9099', WHITE = '#ffffff', BLACK = '#111111';

function paintSign(c, cx, cy, r, limit, opts) {
    const o = opts || {};
    if (!limit) {
        // no limit known (as BMW's Speed Limit Info): the sign with three dashes, grey ring (not a sign on the road)
        c.circle(cx, cy, r, WHITE);
        c.arc(cx, cy, r * 0.8, r, 0, 360, GREY);
        const w = r * 0.3, h = Math.max(2, r * 0.13), gap = r * 0.09, x0 = cx - (3 * w + 2 * gap) / 2;
        for (let i = 0; i < 3; i++) c.fillRect(x0 + i * (w + gap), cy - h / 2, w, h, BLACK);
        return;
    }
    if (o.over) {
        c.circle(cx, cy, r, RED);
        c.arc(cx, cy, r * 0.8, r * 0.86, 0, 360, WHITE);
    } else {
        c.circle(cx, cy, r, WHITE);
        c.arc(cx, cy, r * 0.8, r, 0, 360, o.inferred ? GREY : RED);
    }
    const t = String(limit), sz = r * (t.length >= 3 ? 0.78 : 1.0);
    c.text(t, cx, cy + sz * 0.36, sz, o.over ? WHITE : BLACK, { literal: true, font: 'bold', align: 'center' });
    if (o.inferred && !o.over) c.circle(cx, cy + r * 0.56, Math.max(2, r * 0.07), GREY);
}

function drawSign(limit, opts) {
    const o = opts || {};
    const size = Math.max(32, Math.round(o.size || 96)), c = new Canvas(size, size);
    paintSign(c, size / 2, size / 2, size / 2 - 1.5, limit, o);
    return { w: size, h: size, px: Buffer.from(c.d.buffer, c.d.byteOffset, c.d.length), key: [limit, size, !!o.inferred, !!o.over].join(':') };
}

module.exports = { drawSign, paintSign };
