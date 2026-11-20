'use strict';
/**
 * sign.js - the speed limit sign. Node 8.
 *
 *   drawSign(60, { size: 96, inferred, over, camera: '350 m' })  -> { w, h, px (straight-alpha RGBA Buffer), key }
 *   paintSign(surface, cx, cy, r, 60, { inferred, over })  on a kit canvas.js Canvas or record.js Recorder (the page)
 *
 * The European sign: a white disc, a red ring, the limit in black. A limit that is only the road's default (no
 * limit tagged on the map) has a grey ring and a grey dot under the number, so it reads as a guess. Over the limit
 * (the threshold set): the disc turns red and the number white. No limit known (limit null): three dashes in a grey
 * ring, as BMW's Speed Limit Info shows then. A speed camera ahead (opts.camera, its distance): a pill tucked behind
 * the sign's right edge, as one with it: a camera and the distance, white like the disc (red when over the limit);
 * the picture is then wider than tall, the sign at its left. Outside the shapes everything is transparent (on the
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

/** A camera (body, lens, the flash on top) centred at cx, cy, s wide, in colour col on a background bg. */
function camGlyph(c, cx, cy, s, col, bg) {
    const w = s, h = s * 0.62, x = cx - w / 2, y = cy - h / 2 + s * 0.06;
    c.roundRect(x + w * 0.16, y - s * 0.14, w * 0.3, s * 0.18, s * 0.05, col);
    c.roundRect(x, y, w, h, s * 0.12, col);
    c.circle(cx, y + h / 2, h * 0.34, bg);
    c.circle(cx, y + h / 2, h * 0.2, col);
}

/** The pill's parts for a sign of this size: its height, the glyph's width, the text's size and where they start. */
function pill(size) {
    const h = Math.round(size * 0.64), g = h * 0.62;
    return { h, y: Math.round((size - h) / 2), x: Math.round(size * 0.5), g, gx: size + 2 + g * 0.55, ts: h * 0.5 };
}
let measure = null;
/** The width of the picture: the sign alone, or with the camera pill (one width for every distance: sized for the
 * widest, "400 m", so the picture keeps its size while the distance counts down). */
function signWidth(size, camera) {
    if (!camera) return size;
    const P = pill(size);
    if (!measure) measure = new Canvas(1, 1);
    const tw = measure.textWidth('400 m', P.ts, { literal: true, font: 'bold' });
    return Math.ceil(P.gx + P.g * 0.62 + 2 + tw + P.h * 0.38);
}

/** opts.pillLeft: the pill runs to the sign's left (the sign at the picture's right end), e.g. clear of the car's
 * arrow on the phone map. */
function drawSign(limit, opts) {
    const o = opts || {};
    const size = Math.max(32, Math.round(o.size || 96)), W = signWidth(size, o.camera), c = new Canvas(W, size);
    const left = !!(o.camera && o.pillLeft), sx = left ? W - size / 2 : size / 2;
    if (o.camera) {
        // the pill: from under the sign's inner half to the picture's far edge, 64 % of the sign's height; the camera
        // next to the sign, the distance after it
        const P = pill(size), fill = o.over ? RED : WHITE, ink = o.over ? WHITE : BLACK;
        const ts = { literal: true, font: 'bold' }, text = String(o.camera);
        if (left) {
            c.roundRect(1, P.y, W - P.x - 1, P.h, P.h / 2, fill);
            const gx = W - P.gx;
            camGlyph(c, gx, size / 2, P.g, ink, fill);
            c.text(text, gx - P.g * 0.62 - 2, size / 2 + P.ts * 0.36, P.ts, ink, Object.assign({ align: 'right' }, ts));
        } else {
            c.roundRect(P.x, P.y, W - P.x - 1, P.h, P.h / 2, fill);
            camGlyph(c, P.gx, size / 2, P.g, ink, fill);
            c.text(text, P.gx + P.g * 0.62 + 2, size / 2 + P.ts * 0.36, P.ts, ink, ts);
        }
    }
    paintSign(c, sx, size / 2, size / 2 - 1.5, limit, o);
    return { w: W, h: size, px: Buffer.from(c.d.buffer, c.d.byteOffset, c.d.length),
        key: [limit, size, !!o.inferred, !!o.over, o.camera || '', left ? 'L' : 'R'].join(':') };
}

module.exports = { drawSign, paintSign, signWidth };
