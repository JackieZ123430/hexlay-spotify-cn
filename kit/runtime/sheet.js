'use strict';
/**
 * sheet.js - pages the kit draws over an app's own page with the GPU renderer (full-screen
 * layout, mgu-render/1): the settings and cards such as the Service app's item details.
 *
 * A sheet is driven by the display (display.js openSheet):
 *   draw(r, t)  draw on r (a 1600 x 520 Recorder, the app's page coordinates); returns the touch
 *               targets [{ x, y, w, h, act }] (act(): what a tap does; 'close' closes the sheet)
 *   move(d)     controller knob: d clicks (+ = clockwise)
 *   press()     controller press; back(): tilt left. Both return 'close' to close the sheet.
 *   top()       (optional) the controller is at the sheet's top: pushed up, it goes to the header's tabs
 *   title       the header's text
 *
 *   listSheet(settings)     the app's settings: a row per setting, a list of values to pick from
 *   cardSheet(spec)         a card: title, rows of label and value, action buttons
 */
const { withAlpha } = require('./canvas');
const S = require('./scene');

const W = 1600, TOP = 46, BOTTOM = 512;
const ROW_H = 66, GAP = 8;

/* ---------------- drawing helpers ---------------- */
// buttons: a thin frame, lit in the theme's blue from below when focused or primary (scene.js)
function pill(r, t, x, y, w, h, label, on, opts) {
    const o = opts || {}, c = o.color || t.sel || t.accent;
    if (on) S.lit(r, t, x, y, w, h, 1.3);
    r.strokeRoundRect(x + 0.5, y + 0.5, w - 1, h - 1, 3, 1, on ? withAlpha(c, 0.7) : withAlpha(o.color || '#ffffff', o.color ? 0.7 : 0.24));
    r.text(label, x + w / 2, y + h / 2 + 9, 24, o.color && !on ? o.color : '#ffffff', { align: 'center' });
}
// a switch: a square-cornered track, the knob at the right and the track in the theme's blue when on
function toggle(r, t, x, y, on) {
    const c = t.sel || t.accent, w = 76, h = 38;
    r.roundRect(x, y, w, h, 4, on ? c : withAlpha('#ffffff', 0.14));
    r.roundRect(on ? x + w - h + 4 : x + 4, y + 4, h - 8, h - 8, 3, '#ffffff');
}
function chevron(r, t, x, y, c) {
    r.line(x, y - 9, x + 9, y, 3, c);
    r.line(x + 9, y, x, y + 9, 3, c);
}
function fit(r, s, size, w, font) {
    s = String(s);
    if (r.textWidth(s, size, { font }) <= w) return s;
    while (s.length > 1 && r.textWidth(s + '...', size, { font }) > w) s = s.slice(0, -1);
    return s + '...';
}

/** Shorten verbose parenthetical labels like "Online Mode (Default)" -> "Online Mode" for inline segments. */
function shortLabel(s) {
    return String(s || '').replace(/\s*\([^)]*\)\s*/g, '').replace(/-inch$/i, '"').trim() || String(s || '');
}

/**
 * A scrolling list of rows: rows = [{ label, value, kind: 'toggle'|'more'|'radio'|'seg'|'step', on, options, cur, onPick, onStep, canPrev, canNext }].
 * Draws them from y0, keeps row `focus` in view (smooth), returns touch targets [{ x, y, w, h, i, act? }].
 */
function list(r, t, key, rows, focus, y0, controller) {
    // (r.extra: the page reaches lower on screen, display.js)
    const SC = t.sel || t.accent, bottom = BOTTOM + (r.extra || 0), H = bottom - y0;
    const total = rows.length * (ROW_H + GAP) - GAP;
    const fy = focus * (ROW_H + GAP);
    const st = list.scroll[key] || (list.scroll[key] = { y: 0, show: 0, focus: -1, drag: false });
    if (st.focus !== focus) {
        st.focus = focus;
        if (fy < st.y) st.y = fy;
        if (fy + ROW_H > st.y + H) st.y = fy + ROW_H - H;
    }
    st.y = Math.max(0, Math.min(st.y, Math.max(0, total - H)));
    st.show = st.drag || Math.abs(st.y - st.show) < 0.5 ? st.y : st.show + (st.y - st.show) * 0.35;
    const sy = st.show;
    const rects = [];
    // subtle recessed surface card behind the rows
    const cardH = Math.min(H, total + 12);
    if (rows.length) {
        r.roundRect(40, y0 - 6, W - 80, cardH, 4, '#101218');
        r.strokeRoundRect(40.5, y0 - 5.5, W - 81, cardH - 1, 4, 1, withAlpha('#ffffff', 0.08));
    }
    r.clip(0, y0 - 6, W, H + 6);
    rows.forEach((row, i) => {
        const y = y0 + i * (ROW_H + GAP) - sy;
        if (y + ROW_H < y0 || y > bottom) return;
        const x = 40, w = W - 80, on = i === focus && controller;
        if (i > 0) S.hairline(r, x + 20, y - GAP / 2, w - 40, 0.07);
        if (on) S.lit(r, t, x + 1, y, w - 2, ROW_H);
        if (row.kind === 'radio' && row.on) S.mark(r, x + 6, y + ROW_H * 0.26, ROW_H * 0.48, SC);
        const cy = y + ROW_H / 2;
        let right = x + w - 24;
        const visTop = Math.max(y, y0), visH = Math.min(y + ROW_H, bottom) - visTop;

        if (row.kind === 'seg' && row.options) {
            // Inline Afterglow segmented control: one tap switches immediately
            const opts = row.options, sh = 44, sy0 = cy - sh / 2, fontSz = 21;
            const maxSegW = 720, minItemW = 112;
            const natWs = opts.map((o) => Math.max(minItemW, Math.round(r.textWidth(shortLabel(o[1]), fontSz) + 38)));
            const sumW = natWs.reduce((a, b) => a + b, 0);
            const segW = Math.min(maxSegW, Math.max(360, sumW));
            const sx0 = right - segW;
            r.roundRect(sx0, sy0, segW, sh, 3, withAlpha('#ffffff', 0.03));
            r.strokeRoundRect(sx0 + 0.5, sy0 + 0.5, segW - 1, sh - 1, 3, 1, withAlpha('#ffffff', 0.14));
            let cx = sx0;
            opts.forEach((opt, oi) => {
                const sw = Math.round(segW * (oi + 1) / opts.length) - Math.round(segW * oi / opts.length);
                const active = opt[0] === row.cur;
                if (active) {
                    S.shadeY(r, cx + 1, sy0 + 1, sw - 2, sh - 2, SC, 0.02, 0.34);
                    r.fillRect(cx + 1, sy0 + sh - 3, sw - 2, 2, SC);
                }
                if (oi) r.fillRect(cx, sy0 + 1, 1, sh - 2, withAlpha('#ffffff', 0.1));
                const txt = fit(r, shortLabel(opt[1]), fontSz, sw - 16, active ? 'bold' : 'label');
                r.text(txt, cx + sw / 2, cy + fontSz * 0.35, fontSz, active ? '#ffffff' : t.dim, { align: 'center', font: active ? 'bold' : 'label' });
                rects.push({ i, x: cx, y: Math.max(sy0, y0), w: sw, h: Math.min(sy0 + sh, bottom) - Math.max(sy0, y0), act: () => { row.onPick(opt[0]); return null; } });
                cx += sw;
            });
            r.text(fit(r, row.label, 26, sx0 - 36 - (x + 28)), x + 28, cy + 9, 26, t.text);
            return;
        }

        if (row.kind === 'step') {
            // Inline < value > stepper
            const btnW = 54, sh = 44, sy0 = cy - sh / 2, valW = 148, totW = btnW * 2 + valW;
            const sx0 = right - totW;
            r.roundRect(sx0, sy0, totW, sh, 3, withAlpha('#ffffff', 0.03));
            r.strokeRoundRect(sx0 + 0.5, sy0 + 0.5, totW - 1, sh - 1, 3, 1, withAlpha('#ffffff', 0.14));
            r.fillRect(sx0 + btnW, sy0 + 1, 1, sh - 2, withAlpha('#ffffff', 0.1));
            r.fillRect(sx0 + btnW + valW, sy0 + 1, 1, sh - 2, withAlpha('#ffffff', 0.1));
            // left chevron
            const lc = row.canPrev ? '#ffffff' : withAlpha('#ffffff', 0.22);
            r.line(sx0 + btnW / 2 + 4, cy - 8, sx0 + btnW / 2 - 4, cy, 2.4, lc);
            r.line(sx0 + btnW / 2 - 4, cy, sx0 + btnW / 2 + 4, cy + 8, 2.4, lc);
            // right chevron
            const rc = row.canNext ? '#ffffff' : withAlpha('#ffffff', 0.22);
            const rxm = sx0 + btnW + valW + btnW / 2;
            r.line(rxm - 4, cy - 8, rxm + 4, cy, 2.4, rc);
            r.line(rxm + 4, cy, rxm - 4, cy + 8, 2.4, rc);
            // value
            r.text(fit(r, row.value || '', 23, valW - 16, 'bold'), sx0 + btnW + valW / 2, cy + 8, 23, t.text, { align: 'center', font: 'bold', literal: true });
            rects.push({ i, x: sx0, y: Math.max(sy0, y0), w: btnW, h: Math.min(sy0 + sh, bottom) - Math.max(sy0, y0), act: () => { row.onStep(-1); return null; } });
            rects.push({ i, x: sx0 + btnW + valW, y: Math.max(sy0, y0), w: btnW, h: Math.min(sy0 + sh, bottom) - Math.max(sy0, y0), act: () => { row.onStep(1); return null; } });
            r.text(fit(r, row.label, 26, sx0 - 36 - (x + 28)), x + 28, cy + 9, 26, t.text);
            return;
        }

        if (row.kind === 'toggle') { toggle(r, t, right - 76, cy - 19, row.on); right -= 100; }
        else if (row.kind === 'more') { chevron(r, t, right - 9, cy, t.dim); right -= 34; }
        else if (row.kind === 'radio') {
            if (row.on) r.polyline([[right - 26, cy], [right - 17, cy + 9], [right, cy - 10]], 3.5, SC);
            right -= 44;
        }
        const vw = row.value != null ? Math.min(560, r.textWidth(String(row.value), 25)) : 0;
        if (row.value != null) r.text(fit(r, row.value, 25, 560), right, cy + 9, 25, row.on && row.kind === 'radio' ? t.text : t.dim, { align: 'right' });
        r.text(fit(r, row.label, 26, right - vw - 40 - (x + 28)), x + 28, cy + 9, 26, t.text);
        rects.push({ i, x, y: visTop, w, h: visH });
    });
    r.noclip();
    if (total > H) {
        const bh = Math.max(40, H * H / total), by = y0 + (H - bh) * (sy / (total - H));
        r.fillRect(W - 21, y0, 2, H, withAlpha('#ffffff', 0.1));
        r.fillRect(W - 21, by, 2, bh, SC);
    }
    return rects;
}
list.scroll = {};

/* ---------------- settings ---------------- */
function values(s) {
    if (s.type === 'choice') return (s.options || []).map((o) => [o[0], o[1]]);
    if (s.type === 'number') return (s.steps || []).map((v) => [v, String(v) + (s.unit ? ' ' + s.unit : '') + (s.markDefault && v === s.default ? ' (default)' : '')]);
    return null;
}

/** opts: { version } (the app's, shown at the settings' top) */
function listSheet(settings, title, opts) {
    const version = opts && opts.version;
    const schema = settings.schema.filter((s) => !s.hidden);
    const sh = {
        title: title || 'Settings',
        focus: 0, open: null, sub: 0,        // open: the setting whose values are listed
        controller: false,                  // the controller was used: show where it is
        rows() {
            if (this.open) {
                const cur = settings.get(this.open.key);
                return values(this.open).map((v) => ({ label: v[1], kind: 'radio', on: v[0] === cur }));
            }
            return schema.map((s) => {
                if (s.type === 'bool') return { label: s.label, kind: 'toggle', on: !!settings.get(s.key) };
                if (s.type === 'choice' && s.options && s.options.length >= 2 && s.options.length <= 4) {
                    return {
                        label: s.label, kind: 'seg', options: s.options, cur: settings.get(s.key),
                        onPick: (val) => { if (val !== settings.get(s.key)) settings.set(s.key, val); },
                    };
                }
                if (s.type === 'number' && s.steps && s.steps.length >= 2) {
                    const cur = settings.get(s.key), idx = s.steps.indexOf(cur);
                    return {
                        label: s.label, kind: 'step', value: settings.display(s.key),
                        canPrev: idx > 0, canNext: idx >= 0 ? idx < s.steps.length - 1 : true,
                        onStep: (d) => {
                            const i = s.steps.indexOf(settings.get(s.key));
                            const next = Math.max(0, Math.min(s.steps.length - 1, (i < 0 ? 0 : i) + d));
                            if (s.steps[next] !== settings.get(s.key)) settings.set(s.key, s.steps[next]);
                        },
                    };
                }
                return { label: s.label, value: settings.display(s.key), kind: values(s) ? 'more' : null };
            });
        },
        draw(r, t) {
            r.clear(t.bg);
            const rows = this.rows();
            const bw0 = S.badge(r, 42, TOP + 22, 17, t), ttl = this.open ? this.open.label : this.title;
            const tw = r.text(ttl, 42 + bw0 + 14, TOP + 39, 24, t.text, { font: 'bold' });
            if (!this.open && version) r.text('Version ' + version, 42 + bw0 + 14 + tw + 24, TOP + 39, 20, t.dim);
            S.hairline(r, 40, TOP + 58, W - 80, 0.1);
            const targets = [];
            // Back (a value list) / Done (the settings): top right
            const bw = 150, bx = W - 40 - bw, by = TOP + 8;
            pill(r, t, bx, by, bw, 46, this.open ? 'Back' : 'Done', !this.controller || (this.open ? this.sub : this.focus) === -1);
            targets.push({ x: bx - 10, y: by - 6, w: bw + 20, h: 58, act: () => this.back() });
            const rects = list(r, t, this.key(), rows, this.open ? this.sub : this.focus, TOP + 78, this.controller);
            rects.forEach((q) => {
                if (q.act) targets.push(q);
                else targets.push(Object.assign(q, { act: () => { if (this.open) this.sub = q.i; else this.focus = q.i; return this.choose(); } }));
            });
            return targets;
        },
        key() { return this.open ? 'v_' + this.open.key : 'settings'; },
        top() { return (this.open ? this.sub : this.focus) === -1; },
        scroll(dy) {
            const st = list.scroll[this.key()];
            if (st) { st.y += dy; st.drag = true; }
        },
        release() { const st = list.scroll[this.key()]; if (st) st.drag = false; },
        moving() { const st = list.scroll[this.key()]; return !!st && (st.drag || Math.abs(st.y - st.show) >= 0.5); },
        move(d) {
            this.controller = true;
            const n = this.rows().length;
            if (this.open) this.sub = Math.max(-1, Math.min(n - 1, this.sub + d));
            else this.focus = Math.max(-1, Math.min(n - 1, this.focus + d));
        },
        press() {
            this.controller = true;
            if ((this.open ? this.sub : this.focus) === -1) { const r = this.back(); if (this.open === null) this.focus = Math.max(0, this.focus); return r; }
            return this.choose();
        },
        choose() {
            if (this.open) {
                const v = values(this.open)[this.sub];
                if (v && v[0] !== settings.get(this.open.key)) settings.set(this.open.key, v[0]);
                this.open = null;
                return null;
            }
            const s = schema[this.focus];
            if (!s) return null;
            if (s.type === 'bool') settings.set(s.key, !settings.get(s.key));
            else if ((s.type === 'choice' && s.options && s.options.length <= 4) || (s.type === 'number' && s.steps && s.steps.length >= 2)) {
                settings.cycle(s.key);
            } else if (values(s)) {
                this.open = s;
                this.sub = Math.max(0, values(s).findIndex((v) => v[0] === settings.get(s.key)));
            } else settings.cycle(s.key);
            return null;
        },
        back() {
            if (this.open) { this.open = null; return null; }
            return 'close';
        },
    };
    return sh;
}

/* ---------------- card ---------------- */
/**
 * spec: { title, heading, subtitle, color, rows: [[label, value]], note, actions: [{ label, run, color, primary }] }
 * (rows / note / actions may be functions, read on each frame). An action's run() may return
 * 'close' (or a promise of it).
 */
function cardSheet(spec) {
    const get = (k) => (typeof spec[k] === 'function' ? spec[k]() : spec[k]);
    const sh = {
        title: spec.title || '',
        focus: 0, controller: false, onClose: null,
        draw(r, t) {
            r.clear(t.bg);
            const targets = [];
            const actions = get('actions') || [];
            this.focus = Math.max(-1, Math.min(this.focus, actions.length - 1));
            const x = 40, y = TOP + 6, w = W - 80, h = BOTTOM + (r.extra || 0) - y - 4;
            const accent = get('color') || t.sel || t.accent;
            S.mark(r, x + 4, y + 30, 46, accent);
            r.text(fit(r, get('heading') || '', 40, w - 260, 'bold'), x + 44, y + 64, 40, t.text, { font: 'bold' });
            const sub = get('subtitle');
            if (sub) r.text(fit(r, sub, 24, w - 90), x + 44, y + 102, 24, accent);
            // close: top right
            const cw = 150, cx = x + w - cw - 24, cy = y + 24;
            pill(r, t, cx, cy, cw, 46, 'Close', this.controller && this.focus === -1);
            targets.push({ x: cx - 10, y: cy - 6, w: cw + 20, h: 58, act: () => 'close' });
            // label / value tiles
            const rows = (get('rows') || []).filter(Boolean);
            const tw = (w - 88 - (rows.length - 1) * 20) / Math.max(1, rows.length), ty = y + 136, th = 132;
            rows.forEach((rw, i) => {
                const tx = x + 44 + i * (tw + 20);
                S.hairline(r, tx, ty, tw, 0.12);
                r.text(String(rw[0]), tx, ty + 40, 22, t.dim);
                r.text(fit(r, rw[1] == null ? '--' : rw[1], 44, tw - 24, 'bold'), tx, ty + 102, 44, rw[2] || t.text, { font: 'bold' });
            });
            const note = get('note');
            if (note) r.text(fit(r, note, 24, w - 88), x + 44, ty + th + 50, 24, t.dim);
            // actions: bottom right
            let ax = x + w - 24;
            const ay = y + h - 24 - 58;
            for (let i = actions.length - 1; i >= 0; i--) {
                const a = actions[i], aw = Math.max(200, r.textWidth(a.label, 24, { font: 'bold' }) + 80);
                ax -= aw;
                pill(r, t, ax, ay, aw, 58, a.label, this.controller ? i === this.focus : !!a.primary, { color: a.color });   // (-1: Close)
                targets.push({ x: ax, y: ay, w: aw, h: 58, act: () => a.run && a.run() });
                ax -= 20;
            }
            return targets;
        },
        move(d) {
            this.controller = true;
            const n = (get('actions') || []).length;
            this.focus = Math.max(-1, Math.min(n - 1, this.focus + d));     // -1: Close
        },
        press() {
            this.controller = true;
            if (this.focus === -1) return 'close';
            const a = (get('actions') || [])[this.focus];
            return a && a.run ? a.run() : null;
        },
        back() { return 'close'; },
        /** on Close: pushed up, the controller goes to the header's tabs */
        top() { return this.focus === -1; },
    };
    return sh;
}

module.exports = { listSheet, cardSheet };
