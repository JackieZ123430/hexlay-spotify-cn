'use strict';
/**
 * scene.js - the Afterglow look's drawing parts: a quiet charcoal ground, BMW blue for what is
 * selected, the M colours for marks, and depth made of light: soft shadows and pools, a 3D extruded
 * band of a signal's recent history whose far end fades away.
 *
 * Everything here is triangles with a colour per corner (Recorder.mesh), lines and flat pictures,
 * which the GPU renderer draws as they are. On the software path (cv.place === null), heavy soft
 * meshes are skipped and the layout and crisp linework stay clean and fast.
 */
const { rgba } = require('./canvas');

const BLUE = '#1c8fe0';                       // BMW focus blue
const M1 = '#0a9cdb', M2 = '#2b3c8f', M3 = '#e3242b';   // M light blue, dark blue, red
const AMBER = '#ffb000';
const OK = '#43d68b';

const sel = (t) => (t && (t.sel || t.accent)) || BLUE;
const acc = (t) => (t && (t.accent2 || t.accent)) || M1;
const warnC = (t) => (t && t.warn) || AMBER;
const critC = (t) => (t && t.crit) || M3;
const isGpu = (cv) => cv && cv.place !== null;

const RGB_WHITE = [255, 255, 255, 255];
const RGB_BLACK = [0, 0, 0, 255];

/** packed 0xRRGGBBAA from a colour (hex or RGBA array) and an alpha 0..1 */
function pk(c, a) {
    const v = Array.isArray(c) ? c : rgba(c);
    const al = Math.max(0, Math.min(255, Math.round((a === undefined ? 1 : a) * v[3])));
    return (((v[0] & 255) << 24) | ((v[1] & 255) << 16) | ((v[2] & 255) << 8) | al) >>> 0;
}
const lerp = (a, b, t) => a + (b - a) * t;
function mixRGB(a, b, t) {
    if (!Array.isArray(a)) a = rgba(a);
    if (!Array.isArray(b)) b = rgba(b);
    return [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t)), 255];
}

/* ---------------- soft shapes ---------------- */

const ELLIPSE_R = [0, 0.14, 0.28, 0.42, 0.56, 0.7, 0.84, 0.94, 1];
const ELLIPSE_W = ELLIPSE_R.map((r) => { const u = 1 - r; return u * u * (3 - 2 * u); });
const TRIG_CACHE = Object.create(null);
function unitCircle(N) {
    let t = TRIG_CACHE[N];
    if (t) return t;
    const c = new Float32Array(N + 1), s = new Float32Array(N + 1);
    const step = (Math.PI * 2) / N;
    for (let k = 0; k < N; k++) { c[k] = Math.cos(k * step); s[k] = Math.sin(k * step); }
    c[N] = c[0]; s[N] = s[0];
    t = { c, s };
    TRIG_CACHE[N] = t;
    return t;
}
// Precomputed quarter-circle offsets for softRect's 4 corners (6 segments each)
const CORNER_ARC = [Math.PI, Math.PI * 1.5, 0, Math.PI * 0.5].map((a0) => {
    const n = 6, c = new Float32Array(n + 1), s = new Float32Array(n + 1);
    for (let k = 0; k <= n; k++) {
        const ang = a0 + (Math.PI * 0.5 * k) / n;
        c[k] = Math.cos(ang); s[k] = Math.sin(ang);
    }
    return { c, s };
});

/** A soft ellipse: colour c at alpha a in the middle, fading to nothing at rx, ry (a pool of light, a shadow). */
function softEllipse(cv, cx, cy, rx, ry, c, a) {
    if (!isGpu(cv) || rx <= 0 || ry <= 0 || a <= 0) return;
    // smoothstep rings + adaptive angular segments: precomputed trig & zero temp point arrays
    const N = Math.max(20, Math.min(64, Math.round(Math.max(rx, ry) / 12)));
    const trig = unitCircle(N), cos = trig.c, sin = trig.s;
    const baseRgb = Array.isArray(c) ? c : rgba(c);
    const ringCount = ELLIPSE_R.length;
    const C = new Uint32Array(ringCount);
    const rxR = new Float32Array(ringCount), ryR = new Float32Array(ringCount);
    for (let ri = 0; ri < ringCount; ri++) {
        C[ri] = pk(baseRgb, a * ELLIPSE_W[ri]);
        rxR[ri] = rx * ELLIPSE_R[ri];
        ryR[ri] = ry * ELLIPSE_R[ri];
    }
    const v = new Array(N * (1 + (ringCount - 2) * 2) * 9);
    let o = 0;
    const c0 = C[0], c1 = C[1], rx1 = rxR[1], ry1 = ryR[1];
    for (let k = 0; k < N; k++) {
        const ck0 = cos[k], sk0 = sin[k], ck1 = cos[k + 1], sk1 = sin[k + 1];
        v[o++] = cx; v[o++] = cy; v[o++] = c0;
        v[o++] = cx + ck0 * rx1; v[o++] = cy + sk0 * ry1; v[o++] = c1;
        v[o++] = cx + ck1 * rx1; v[o++] = cy + sk1 * ry1; v[o++] = c1;
        for (let ri = 1; ri < ringCount - 1; ri++) {
            const rxa = rxR[ri], rya = ryR[ri], rxb = rxR[ri + 1], ryb = ryR[ri + 1];
            const ca = C[ri], cb = C[ri + 1];
            const a0x = cx + ck0 * rxa, a0y = cy + sk0 * rya;
            const b0x = cx + ck1 * rxa, b0y = cy + sk1 * rya;
            const a2x = cx + ck0 * rxb, a2y = cy + sk0 * ryb;
            const b2x = cx + ck1 * rxb, b2y = cy + sk1 * ryb;
            v[o++] = a0x; v[o++] = a0y; v[o++] = ca;
            v[o++] = b0x; v[o++] = b0y; v[o++] = ca;
            v[o++] = b2x; v[o++] = b2y; v[o++] = cb;
            v[o++] = a0x; v[o++] = a0y; v[o++] = ca;
            v[o++] = b2x; v[o++] = b2y; v[o++] = cb;
            v[o++] = a2x; v[o++] = a2y; v[o++] = cb;
        }
    }
    cv.mesh(v);
}

/** A soft rectangle: solid inside (x, y, w, h), fading out over `spread` px around it (a picture's shadow). */
function softRect(cv, x, y, w, h, spread, c, a) {
    if (!isGpu(cv) || w <= 0 || h <= 0 || a <= 0) return;
    const baseRgb = Array.isArray(c) ? c : rgba(c);
    const s = spread, I = pk(baseRgb, a), O = pk(baseRgb, 0);
    const x0 = x - s, y0 = y - s, x1 = x + w, y1 = y + h, x2 = x1 + s, y2 = y1 + s;
    const v = new Array((5 * 2 + 4 * 6) * 9);
    let o = 0;
    const quad = (ax, ay, ac, bx, by, bc, cx2, cy2, cc, dx, dy, dc) => {
        v[o++] = ax; v[o++] = ay; v[o++] = ac; v[o++] = bx; v[o++] = by; v[o++] = bc; v[o++] = cx2; v[o++] = cy2; v[o++] = cc;
        v[o++] = ax; v[o++] = ay; v[o++] = ac; v[o++] = cx2; v[o++] = cy2; v[o++] = cc; v[o++] = dx; v[o++] = dy; v[o++] = dc;
    };
    quad(x, y, I, x1, y, I, x1, y1, I, x, y1, I);                       // inside
    quad(x, y0, O, x1, y0, O, x1, y, I, x, y, I);                       // top
    quad(x, y1, I, x1, y1, I, x1, y2, O, x, y2, O);                     // bottom
    quad(x0, y, O, x, y, I, x, y1, I, x0, y1, O);                       // left
    quad(x1, y, I, x2, y, O, x2, y1, O, x1, y1, I);                     // right
    const corner = (cx2, cy2, arc) => {
        const cs = arc.c, sn = arc.s;
        for (let k = 0; k < 6; k++) {
            v[o++] = cx2; v[o++] = cy2; v[o++] = I;
            v[o++] = cx2 + cs[k] * s; v[o++] = cy2 + sn[k] * s; v[o++] = O;
            v[o++] = cx2 + cs[k + 1] * s; v[o++] = cy2 + sn[k + 1] * s; v[o++] = O;
        }
    };
    corner(x, y, CORNER_ARC[0]); corner(x1, y, CORNER_ARC[1]);
    corner(x1, y1, CORNER_ARC[2]); corner(x, y1, CORNER_ARC[3]);
    cv.mesh(v);
}

/** A rectangle shaded left to right: colour c from alpha a0 at x to a1 at x + w (darkening a side of the ground). */
function shadeX(cv, x, y, w, h, c, a0, a1) {
    if (w <= 0 || h <= 0) return;
    if (!isGpu(cv)) {
        const avg = (a0 + a1) * 0.5;
        if (avg > 0.01) cv.fillRect(x, y, w, h, pk(c, avg));
        return;
    }
    const A = pk(c, a0), B = pk(c, a1);
    cv.mesh([x, y, A, x + w, y, B, x + w, y + h, B, x, y, A, x + w, y + h, B, x, y + h, A]);
}
/** The same, top to bottom. */
function shadeY(cv, x, y, w, h, c, a0, a1) {
    if (w <= 0 || h <= 0) return;
    if (!isGpu(cv)) {
        cv.gradientRect(x, y, w, h, [[0, pk(c, a0)], [1, pk(c, a1)]]);
        return;
    }
    const A = pk(c, a0), B = pk(c, a1);
    cv.mesh([x, y, A, x + w, y, A, x + w, y + h, B, x, y, A, x + w, y + h, B, x, y + h, B]);
}

/* ---------------- marks ---------------- */

/**
 * The M badge: three slanted bars, h high, at x, y (top left). Uses the theme's stripes when t is passed
 * (Afterglow / M Tricolour: light blue, dark blue, red; single-colour themes: three stepped tones).
 * Returns its width.
 */
function badge(cv, x, y, h, t) {
    const bw = h * 0.47, gap = h * 0.18, sl = h * 0.32;
    let cols;
    if (t && Array.isArray(t.stripes) && t.stripes.length >= 3) {
        cols = t.stripes.slice(0, 3);
    } else if (t && Array.isArray(t.stripes) && t.stripes.length === 1) {
        const base = t.stripes[0];
        cols = [pk(base, 0.45), pk(base, 0.72), base];
    } else {
        cols = [M1, M2, M3];
    }
    cols.forEach((c, i) => {
        const bx = x + i * (bw + gap);
        cv.quad([[bx + sl, y], [bx + sl + bw, y], [bx + bw, y + h], [bx, y + h]], c);
    });
    return 3 * bw + 2 * gap + sl;
}

/** A small label: dim text at x, baseline y. */
function label(cv, t, str, x, y, size, opts) {
    return cv.text(str, x, y, size, t.dim, opts);
}

/**
 * A segmented control: items side by side in a thin frame, the selected one lit in the theme's focus
 * colour from below with a line under it. Each is a target (run(i)). totalW: that wide, the items
 * sharing it equally (else each as wide as its text). Returns the total width.
 */
function segmented(cv, t, x, y, h, items, selected, run, key, size, totalW) {
    size = size || Math.round(h * 0.42);
    const pad = Math.round(h * 0.55);
    const ws = totalW ? items.map((s, i) => Math.round(totalW * (i + 1) / items.length) - Math.round(totalW * i / items.length))
        : items.map((s) => Math.round(cv.textWidth(s, size) + pad * 2));
    const W = ws.reduce((a, b) => a + b, 0);
    cv.strokeRoundRect(x, y, W, h, 3, 1, pk('#ffffff', 0.14));
    let cx = x;
    items.forEach((s, i) => {
        const w = ws[i], on = i === selected;
        if (on) {
            shadeY(cv, cx + 1, y + 1, w - 2, h - 2, sel(t), 0, 0.32);
            cv.fillRect(cx + 1, y + h - 3, w - 2, 2, sel(t));
        }
        if (i) cv.fillRect(cx, y + 1, 1, h - 2, pk('#ffffff', 0.1));
        cv.text(s, cx + w / 2, y + h / 2 + size * 0.36, size, on ? (t.selText || '#ffffff') : t.dim, { align: 'center' });
        if (run) cv.target(cx, y, w, h, () => run(i), key + '_' + i, 3);
        cx += w;
    });
    return W;
}

/** A progress line: track, the played part in the theme's ramp (M blues in Afterglow), and a slanted white head. frac 0..1. */
function progress(cv, x, y, w, frac, t) {
    frac = Math.max(0, Math.min(1, frac || 0));
    cv.fillRect(x, y, w, 4, pk('#ffffff', 0.14));
    const pw = Math.round(w * frac);
    const stops = (t && t.style !== 'afterglow' && t.ramp && t.ramp.length >= 2) ? [t.ramp[0], t.ramp[1]] : [M2, M1];
    if (pw > 0) cv.rampRect(x, y, pw, 4, 0, stops, x, Math.max(pw, 1));
    const hx = x + pw;
    if (isGpu(cv)) softEllipse(cv, hx, y + 2, 12, 12, stops[1], 0.45);
    cv.quad([[hx + 1, y - 6], [hx + 5, y - 6], [hx - 1, y + 10], [hx - 5, y + 10]], '#ffffff');
}

/* ---------------- lists, buttons, states ---------------- */

/** A thin line across (rows, sections). */
function hairline(cv, x, y, w, a) { cv.fillRect(x, y, w, 1, pk('#ffffff', a === undefined ? 0.08 : a)); }

/** The selection: lit from below in the theme's focus colour, a line under it (rows, keys, tabs). */
function lit(cv, t, x, y, w, h, strength) {
    const k = strength === undefined ? 1 : strength;
    shadeY(cv, x, y, w, h, sel(t), 0.02 * k, 0.28 * k);
    cv.fillRect(x, y + h - 2, w, 2, sel(t));
}

/** The slanted mark for "this one plays / was asked": M light blue (or c), h high, top left at x, y. */
function mark(cv, x, y, h, c) {
    const w = Math.max(3, h * 0.16), sl = h * 0.28;
    cv.quad([[x + sl, y], [x + sl + w, y], [x + w, y + h], [x, y + h]], c || M1);
}

/** A status light: a small dot with a soft halo (the GPU) in colour c. */
function led(cv, x, y, c, glow) {
    if (glow) softEllipse(cv, x, y, 10, 10, c, 0.6);
    cv.circle(x, y, 4, c);
}

/**
 * A button: a thin frame, its label in mixed case; primary: lit in the theme's focus colour with the
 * line under it; danger: the label in the theme's crit/red. busy: dimmed, nothing to press. Returns its width.
 * o = { w, h, size, primary, danger, busy, key, literal }
 */
function button(cv, t, x, y, text, run, o) {
    o = o || {};
    const h = o.h || 44, size = o.size || Math.round(h * 0.4);
    const w = o.w || Math.round(cv.textWidth(text, size, { literal: o.literal }) + h * 1.05);
    if (o.primary) {
        lit(cv, t, x, y, w, h, o.busy ? 0.5 : 1.3);
        cv.strokeRoundRect(x + 0.5, y + 0.5, w - 1, h - 1, 3, 1, pk(sel(t), o.busy ? 0.3 : 0.6));
    } else {
        cv.strokeRoundRect(x + 0.5, y + 0.5, w - 1, h - 1, 3, 1, pk('#ffffff', o.busy ? 0.1 : 0.24));
    }
    cv.text(text, x + w / 2, y + h / 2 + size * 0.36, size, o.busy ? t.dim : o.danger ? critC(t) : (t.text || '#ffffff'), { align: 'center', literal: o.literal });
    if (run && !o.busy) cv.target(x, y, w, h, run, o.key || text, 3);
    return w;
}

/**
 * A state the page is in (offline, not paired, empty, loading): a light, a headline and a few
 * plain lines, left-aligned at x from y. tone: 'info', 'warn', 'error', 'none'. Returns y under the last line.
 */
function state(cv, t, x, y, w, o) {
    const hs = o.size || 34, ls = o.lineSize || Math.round(hs * 0.55);
    const c = o.tone === 'error' ? critC(t) : o.tone === 'warn' ? warnC(t) : o.tone === 'none' ? null : acc(t);
    let tx = x;
    if (c) { led(cv, x + 5, y + hs * 0.62, c, o.glow); tx += 24; }
    cv.text(o.title, tx, y + hs, hs, t.text, { font: 'bold' });
    let ly = y + hs + 16;
    (o.lines || []).forEach((l, i) => {
        ly += ls * 1.45;
        cv.text(l, x, ly, ls, i === 0 ? (t.text || '#d4d5da') : t.dim);
    });
    return ly + 10;
}

/** A thin scrollbar: a line and the shown part on it in the theme's focus colour. */
function scrollbar(cv, t, x, y, h, total, visible, pos) {
    if (total <= visible) return;
    cv.fillRect(x, y, 2, h, pk('#ffffff', 0.1));
    const th = Math.max(24, Math.round(h * visible / total)), max = Math.max(1, total - visible);
    cv.fillRect(x, y + Math.round((h - th) * Math.min(1, pos / max)), 2, th, sel(t));
}

/** A label and a value on one line, the value right-aligned, a hairline over them (tables). */
function pair(cv, t, x, y, w, h, lbl, value, o) {
    o = o || {};
    const s = o.size || Math.round(h * 0.42);
    hairline(cv, x, y, w);
    cv.text(lbl, x, y + h / 2 + s * 0.36, s, t.dim);
    const vw = cv.textWidth(value, s, { literal: true });
    if (o.dot) cv.circle(x + w - vw - 13, y + h / 2, 3.5, o.dot);
    cv.text(value, x + w, y + h / 2 + s * 0.36, s, o.color || t.text || '#ffffff', { align: 'right', literal: true });
}

/* ---------------- the 3D extruded band ---------------- */

/** Colour for a value along stops [[v, colour], ...] (sorted by v). */
function rampColour(stops, v) {
    if (v <= stops[0][0]) return rgba(stops[0][1]);
    for (let i = 1; i < stops.length; i++) {
        if (v <= stops[i][0]) return mixRGB(stops[i - 1][1], stops[i][1], (v - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]));
    }
    return rgba(stops[stops.length - 1][1]);
}
const TEMP_STOPS = [[30, M2], [75, M1], [96, '#7cc8f0'], [108, AMBER], [120, M3]];

/**
 * A signal's recent history as an extruded 3D ribbon: "now" near the viewer at the right, the oldest
 * sample further away to the left, the ribbon's height the value. Has a lit top surface, shaded front
 * face, receding floor grid/ticks, projected shadow, colour-matched floor reflection pool, dashed
 * perspective limit line, and a glowing "now" beacon with vertical drop-line.
 *
 * o = { x, y, w, h        the box it stands in (floor near its bottom)
 *       samples           [{ t: 0 (now) .. 1 (oldest shown), v }], oldest first
 *       min, max          the value range for the height
 *       stops             colour ramp [[v, colour]] (default: temperatures)
 *       limit, limitText  the dashed red line's value and label (optional)
 *       marks             [[t, text]] under the floor (e.g. now, -5 min)
 *       bg                the ground colour the far end fades into
 *       poolColor         optional floor pool colour (defaults to live value colour)
 *       pulse             optional 0..1 breathing factor for the live beacon }
 */
function band(cv, t, o) {
    const S = o.samples || [];
    if (S.length < 2) return;
    const gpu = isGpu(cv);
    const stops = o.stops || TEMP_STOPS, bg = o.bg || t.bg;
    const crit = critC(t);

    // 3D perspective projection: front plane runs from near-right (t=0, Z0=1) to far-left (t=1, Z1=2.25);
    // back edge recedes cleanly behind and slightly above the front curve (sleek 3D thickness that stays
    // crisp even on steep Boost spikes, scaling with 1/Z into perspective).
    const nearX = o.x + o.w * 0.96, farX = o.x + o.w * 0.03;
    const floorNear = o.y + o.h - 30, floorFar = floorNear - o.h * 0.14;
    const Z0 = 1.0, Z1 = 2.25;
    const H_PX = Math.max(40, (floorNear - (o.y + 18)) * 0.92);

    const inv0 = 1 / Z0, inv1 = 1 / Z1, invSpan = inv0 - inv1;
    const uOf = (z) => (1 / z - inv1) / invSpan;
    const depthX = Math.min(26, o.w * 0.03), depthY = Math.min(14, o.h * 0.055);

    const proj = (tt, valNorm, back) => {
        const z0 = lerp(Z0, Z1, tt), u0 = uOf(z0);
        const fx = lerp(farX, nearX, u0);
        const fFloor = lerp(floorFar, floorNear, u0);
        const fY = fFloor - valNorm * H_PX / z0;
        if (!back) return [fx, fY];
        // Pull subtly toward the receding left-upper vanishing direction, scaled by 1/z0
        const k = 1 / z0;
        return [fx - depthX * k * (0.45 + 0.55 * u0), fY - depthY * k];
    };
    const normV = (v) => 0.06 + Math.max(0, Math.min(1.06, (v - o.min) / Math.max(1e-6, o.max - o.min))) * 0.87;
    const fade = (tt) => 1 - 0.78 * Math.pow(Math.max(0, Math.min(1, tt)), 1.25);

    const bgRgb = Array.isArray(bg) ? bg : rgba(bg);
    const critRgb = Array.isArray(crit) ? crit : rgba(crit);
    const P = S.map((s) => {
        const c = rampColour(stops, s.v), f = fade(s.t), cb = mixRGB(c, bgRgb, 1 - f);
        const nv = normV(s.v);
        const ft = proj(s.t, nv, false);
        const bt = proj(s.t, nv, true);
        const fg = proj(s.t, 0, false);
        const bgp = proj(s.t, 0, true);
        return {
            t: s.t, v: s.v, ft, bt, fg, bgp, c, f, cb,
            shIn: pk(RGB_BLACK, 0.55 * f),
            topF: pk(mixRGB(cb, RGB_WHITE, 0.22 * f), 0.94 * f),
            topB: pk(mixRGB(cb, RGB_BLACK, 0.14), 0.62 * f),
            curtT: pk(mixRGB(cb, RGB_BLACK, 0.24), 0.86 * f),
            curtB: pk(mixRGB(cb, RGB_BLACK, 0.68), 0.16 * f),
            glowC: pk(c, 0.42 * f),
            glowZ: pk(c, 0),
        };
    });
    const last = P[P.length - 1];
    const segs = P.length - 1;
    const zBlack = pk(RGB_BLACK, 0);

    // 1. Projected ground shadow + colour-matched soft pool (GPU only)
    if (gpu) {
        const sh = new Array(segs * 36);
        let so = 0;
        const pad = 14;
        for (let i = 0; i < segs; i++) {
            const a = P[i], b = P[i + 1];
            const afx = a.fg[0], afy = a.fg[1] + 2, bfx = b.fg[0], bfy = b.fg[1] + 2;
            const abx = a.bgp[0], aby = a.bgp[1] + 2, bbx = b.bgp[0], bby = b.bgp[1] + 2;
            const aIn = a.shIn, bIn = b.shIn;
            sh[so++] = afx; sh[so++] = afy; sh[so++] = aIn; sh[so++] = bfx; sh[so++] = bfy; sh[so++] = bIn; sh[so++] = bbx; sh[so++] = bby; sh[so++] = bIn;
            sh[so++] = afx; sh[so++] = afy; sh[so++] = aIn; sh[so++] = bbx; sh[so++] = bby; sh[so++] = bIn; sh[so++] = abx; sh[so++] = aby; sh[so++] = aIn;
            sh[so++] = afx; sh[so++] = afy; sh[so++] = aIn; sh[so++] = bfx; sh[so++] = bfy; sh[so++] = bIn; sh[so++] = bfx; sh[so++] = b.fg[1] + pad; sh[so++] = zBlack;
            sh[so++] = afx; sh[so++] = afy; sh[so++] = aIn; sh[so++] = bfx; sh[so++] = b.fg[1] + pad; sh[so++] = zBlack; sh[so++] = afx; sh[so++] = a.fg[1] + pad; sh[so++] = zBlack;
        }
        cv.mesh(sh);
        const poolCol = o.poolColor || last.c;
        softEllipse(cv, lerp(farX, nearX, 0.78), floorNear - 6, o.w * 0.34, 42, poolCol, 0.24);
    }

    // 2. Subtle perspective floor grid + optional operating-range reference plane (gives true HUD depth)
    const f0 = proj(0, 0, false), f1 = proj(1, 0, false), b0 = proj(0, 0, true), b1 = proj(1, 0, true);
    cv.line(b1[0], b1[1], b0[0], b0[1], 1, pk(RGB_WHITE, 0.07));
    // Mid-depth grid line and faint intermediate time ribs
    const m0 = [lerp(f0[0], b0[0], 0.5), lerp(f0[1], b0[1], 0.5)];
    const m1 = [lerp(f1[0], b1[0], 0.5), lerp(f1[1], b1[1], 0.5)];
    cv.line(m1[0], m1[1], m0[0], m0[1], 1, pk(RGB_WHITE, 0.035));
    for (let g = 0; g <= 6; g++) {
        const gt = g / 6, pf = proj(gt, 0, false), pb = proj(gt, 0, true);
        cv.line(pf[0], pf[1], pb[0], pb[1], 1, pk(RGB_WHITE, (g % 2 === 0 ? 0.11 : 0.045) * fade(gt) + 0.015));
    }
    if (typeof o.ref === 'number') {
        const rn = normV(o.ref), r0 = proj(0, rn, true), r1 = proj(1, rn, true);
        cv.line(r1[0], r1[1], r0[0], r0[1], 1, pk(RGB_WHITE, 0.1));
        if (o.refText) {
            const rp = proj(0.95, rn, true);
            cv.text(o.refText, rp[0], Math.max(o.y + 14, rp[1] - 6), 12, pk(RGB_WHITE, 0.34), { literal: true });
        }
    }

    // 3. The 3D ribbon: lit top surface first, then shaded front face (painter's order, back to front)
    const topMesh = new Array(segs * 18), frontMesh = new Array(segs * 18);
    let to = 0, fo = 0;
    for (let i = 0; i < segs; i++) {
        const a = P[i], b = P[i + 1];
        topMesh[to++] = a.ft[0]; topMesh[to++] = a.ft[1]; topMesh[to++] = a.topF;
        topMesh[to++] = b.ft[0]; topMesh[to++] = b.ft[1]; topMesh[to++] = b.topF;
        topMesh[to++] = b.bt[0]; topMesh[to++] = b.bt[1]; topMesh[to++] = b.topB;
        topMesh[to++] = a.ft[0]; topMesh[to++] = a.ft[1]; topMesh[to++] = a.topF;
        topMesh[to++] = b.bt[0]; topMesh[to++] = b.bt[1]; topMesh[to++] = b.topB;
        topMesh[to++] = a.bt[0]; topMesh[to++] = a.bt[1]; topMesh[to++] = a.topB;

        frontMesh[fo++] = a.ft[0]; frontMesh[fo++] = a.ft[1]; frontMesh[fo++] = a.curtT;
        frontMesh[fo++] = b.ft[0]; frontMesh[fo++] = b.ft[1]; frontMesh[fo++] = b.curtT;
        frontMesh[fo++] = b.fg[0]; frontMesh[fo++] = b.fg[1]; frontMesh[fo++] = b.curtB;
        frontMesh[fo++] = a.ft[0]; frontMesh[fo++] = a.ft[1]; frontMesh[fo++] = a.curtT;
        frontMesh[fo++] = b.fg[0]; frontMesh[fo++] = b.fg[1]; frontMesh[fo++] = b.curtB;
        frontMesh[fo++] = a.fg[0]; frontMesh[fo++] = a.fg[1]; frontMesh[fo++] = a.curtB;
    }
    cv.mesh(topMesh);
    cv.mesh(frontMesh);

    // Subtle back-edge rim along the top face for crisp 3D depth separation
    for (let i = 0; i < segs; i++) {
        const a = P[i], b = P[i + 1];
        cv.line(a.bt[0], a.bt[1], b.bt[0], b.bt[1], 1, pk(mixRGB(a.cb, RGB_WHITE, 0.35), 0.28 * a.f));
    }
    // End-cap face at the near ("now") edge closes the 3D prism cleanly
    const capT = pk(mixRGB(last.c, RGB_WHITE, 0.12), 0.72), capB = pk(mixRGB(last.c, RGB_BLACK, 0.55), 0.22);
    cv.mesh([last.ft[0], last.ft[1], capT, last.bt[0], last.bt[1], capT, last.bgp[0], last.bgp[1], capB,
        last.ft[0], last.ft[1], capT, last.bgp[0], last.bgp[1], capB, last.fg[0], last.fg[1], capB]);

    // 4. Floor hairline along the full span
    cv.line(f1[0], f1[1], f0[0], f0[1], 1, pk(RGB_WHITE, 0.16));

    // 5. Dashed perspective limit line + label (clamped inside the box so it never clips the readout)
    if (typeof o.limit === 'number') {
        const ln = normV(o.limit), n = 36;
        for (let k = 0; k < n; k += 2) {
            const t0 = k / n, t1 = (k + 1) / n;
            const p0 = proj(t0, ln, 0), p1 = proj(t1, ln, 0);
            cv.line(p0[0], p0[1], p1[0], p1[1], 1.6, pk(critRgb, 0.85 * fade(t0) + 0.12));
        }
        if (o.limitText) {
            const lp = proj(0.92, ln, 0);
            const ly = Math.max(o.y + 14, Math.min(floorFar - 12, lp[1] - 9));
            cv.text(o.limitText, lp[0], ly, 14, pk(critRgb, 0.95), { literal: true });
        }
    }

    // 6. Top front edge: soft neon glow (GPU) + crisp white-core highlight line
    if (gpu) {
        const glow = new Array(segs * 36);
        let go = 0;
        const gw = 7;
        for (let i = 0; i < segs; i++) {
            const a = P[i], b = P[i + 1];
            const ax = a.ft[0], ay = a.ft[1], bx = b.ft[0], by = b.ft[1];
            const ca = a.glowC, cb = b.glowC, za = a.glowZ, zb = b.glowZ;
            glow[go++] = ax; glow[go++] = ay - gw; glow[go++] = za; glow[go++] = bx; glow[go++] = by - gw; glow[go++] = zb; glow[go++] = bx; glow[go++] = by; glow[go++] = cb;
            glow[go++] = ax; glow[go++] = ay - gw; glow[go++] = za; glow[go++] = bx; glow[go++] = by; glow[go++] = cb; glow[go++] = ax; glow[go++] = ay; glow[go++] = ca;
            glow[go++] = ax; glow[go++] = ay; glow[go++] = ca; glow[go++] = bx; glow[go++] = by; glow[go++] = cb; glow[go++] = bx; glow[go++] = by + gw; glow[go++] = zb;
            glow[go++] = ax; glow[go++] = ay; glow[go++] = ca; glow[go++] = bx; glow[go++] = by + gw; glow[go++] = zb; glow[go++] = ax; glow[go++] = ay + gw; glow[go++] = za;
        }
        cv.mesh(glow);
    }
    for (let i = 0; i < segs; i++) {
        const a = P[i], b = P[i + 1];
        cv.line(a.ft[0], a.ft[1], b.ft[0], b.ft[1], 1.4 + 1.3 * a.f, pk(mixRGB(a.c, RGB_WHITE, 0.65), 0.25 + 0.75 * a.f));
    }

    // 7. Live "now" vertical drop-line + floor anchor + breathing beacon
    cv.line(last.ft[0], last.ft[1] + 5, last.fg[0], last.fg[1], 1.2, pk(RGB_WHITE, 0.22));
    cv.circle(last.fg[0], last.fg[1], 2.5, pk(last.c, 0.85));
    const pulse = typeof o.pulse === 'number' ? o.pulse : 0.5;
    if (gpu) softEllipse(cv, last.ft[0], last.ft[1], 15 + pulse * 5, 15 + pulse * 5, last.c, 0.72 + pulse * 0.2);
    cv.circle(last.ft[0], last.ft[1], 4.5, '#ffffff');

    // 8. Time marks under the floor
    (o.marks || []).forEach((m) => {
        const p = proj(m[0], 0, 0);
        cv.fillRect(p[0] - 0.5, p[1] + 5, 1, 7, pk(RGB_WHITE, 0.35));
        cv.text(m[1], p[0], p[1] + 26, 14, pk(RGB_WHITE, 0.48), { align: 'center', literal: true });
    });
}

module.exports = {
    BLUE, M1, M2, M3, AMBER, OK, TEMP_STOPS,
    sel, acc, warnC, critC, pk, mixRGB,
    softEllipse, softRect, shadeX, shadeY,
    badge, label, segmented, progress, hairline, lit, mark, led, button, state, scrollbar, pair,
    rampColour, band,
};
