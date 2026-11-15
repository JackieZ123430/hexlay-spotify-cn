'use strict';
/**
 * System Monitor - what uses the head unit's memory (and processor), on the central display.
 *
 *   Overview   memory in use and free, split into iDrive apps, other programs and the system; a live history
 *              of memory and processor use; the apps and programs using the most memory
 *   Processes  every app and program with its own memory, share of RAM, how much it grew in the last
 *              3 minutes (a memory leak shows as a steady rise) and its processor use; a row per app (its
 *              processes added up) or per process (setting "Group processes by app"); tap a heading to sort,
 *              a row for its details
 *
 * A viewer: it reads Linux /proc and the MGU Store's records (procs.js) and nothing else. It never writes a
 * file of its own besides what the kit keeps for every app (settings, log), never starts a program, signals or
 * ends a process, and opens no connection (kit/tools/test_sys_monitor.js fails the build if it ever does). It
 * runs as its own unprivileged uid, so the kernel would refuse it anyway. Foreground only: nothing is read
 * while the app is off screen. On a computer without /proc (the emulator on Windows) it shows sample data,
 * and says so.
 */
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { Sampler, group, sortRows, breakdown, fmtBytes, fmtAge } = require('./procs');
const { SampleSampler } = require('./sample');

const W = 1600, H = 520;
const PAGES = ['Overview', 'Processes'];
const HISTORY_S = 180;                 // the chart's span, and the span growth is measured over
const TREND_MIN_S = 30;                // growth is shown once a row has been seen this long
const MB = 1024 * 1024;
const TOP = 44;                        // panels start under the tab bar

/* Sizes on this display (kit/runtime/panel.js), as in Spotify: sz(cv, n) is n at the reference size. */
const kOf = (cv) => (cv.ui && cv.ui.k) || 1.44;
const sz = (cv, n) => Math.round(n * kOf(cv));
const ROW = { font: 'label', spacing: 0.6 };
const NUM = { font: 'num' };
const faint = (t) => t.faint || withAlpha(t.dim, 0.7);

/** Memory use's colour: fine, getting full, nearly full. */
function pressure(t, frac) { return frac >= 0.9 ? t.crit : frac >= 0.75 ? t.warn : t.ok; }
function pct(n) { return n == null ? '--' : n < 10 ? n.toFixed(1) : String(Math.round(n)); }
/** Growth over the last minutes: "+12.0 MB", "0" (under 1 MB either way: a heap's usual ups and downs), "--" (not seen long enough). */
function fmtGrow(d) { return d == null ? '--' : Math.abs(d) < MB ? '0' : (d > 0 ? '+' : '') + fmtBytes(d); }
function growCol(t, d, base) { return d == null || d < 10 * MB ? base : d >= 50 * MB ? t.crit : t.warn; }
/** The three parts of the memory in use (breakdown): their colours. */
const PARTS = (t) => [t.sel || t.accent, t.cold, withAlpha(t.dim, 0.55)];

/** str cut (with "..") to fit maxW pixels at this size. */
function fitText(cv, str, maxW, size, opts) {
    str = String(str || '');
    if (cv.textWidth(str, size, opts) <= maxW) return str;
    let lo = 0, hi = str.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cv.textWidth(str.slice(0, mid).replace(/\s+$/, '') + '..', size, opts) <= maxW) lo = mid; else hi = mid - 1;
    }
    return str.slice(0, lo).replace(/\s+$/, '') + '..';
}

/** A small chevron pointing down (the column the list is sorted by), its tip at x, y. */
function downMark(cv, x, y, s, c) {
    cv.line(x - s, y - s * 0.55, x, y, 2, c);
    cv.line(x, y, x + s, y - s * 0.55, 2, c);
}

/** A button in the HMI's style, pressed by a tap or the controller (target key). */
function drawButton(cv, t, x, y, w, h, label, key, run, o) {
    o = o || {};
    G.pushButton(cv, t, x, y, w, h, { primary: !!o.primary, focus: G.isFocus(cv, key) });
    const size = Math.round(Math.min(sz(cv, 14), h * 0.44)), opts = { align: 'center', font: 'label', spacing: 0.5 };
    // a "go on" chevron after the label; a "back" one (chevron 'left') before it
    const back = o.chevron === 'left', lw = cv.textWidth(label, size, opts);
    const cx = x + w / 2 + (o.chevron ? (back ? 1 : -1) * size * 0.45 : 0);
    cv.text(label, cx, y + h / 2 + size * 0.36, size, t.text, opts);
    if (back) G.chevron(cv, cx - lw / 2 - size * 0.85, y + h / 2, size * 0.42, t.dim, 'left');
    else if (o.chevron) G.chevron(cv, cx + lw / 2 + size * 0.85, y + h / 2, size * 0.42, t.dim);
    cv.target(x, y, w, h, run, key, 3, { own: true });
}

/** Where the apps are installed: the folder above this app's own (oap_<uid>/data), else the head unit's. */
function oapDirOf(dataDir) {
    const own = path.resolve(dataDir, '..');
    if (/^oap_\d+$/.test(path.basename(own))) return path.dirname(own);
    return '/var/opt/public/oap';
}

/** What a row is, in a few words: for its details. */
function kindText(r) {
    if (r.kind === 'tool') return 'a program of the MGU Store';
    if (r.kind !== 'app') return 'a program of the head unit';
    if (r.label === 'MainApp') return 'the app manager, which runs the iDrive apps';
    if (r.store) return 'an iDrive app installed by the MGU Store';
    return r.procs[0] && r.procs[0].named === false
        ? 'an iDrive app (BMW\'s own, or installed without the MGU Store): its name can\'t be read from another app'
        : 'an iDrive app';
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log, dataDir } = ctx;

        let sampler = new Sampler({ oapDir: oapDirOf(dataDir), self: { title: ctx.spec.title } });
        const sample = !sampler.available();
        if (sample) {
            sampler = new SampleSampler();
            log.info('no Linux /proc here: showing sample data');
        } else log.info('reading /proc; apps in ' + oapDirOf(dataDir));

        let snap = null, seq = 0, timer = null;
        const history = [];                 // [at, memory used %, processor busy % or null]
        const trend = new Map();            // row key (both groupings) -> [[at, own memory]]
        let page = 0, sortBy = 'mem', scroll = 0;
        let detail = null;                  // { key, label }: a row's details are shown

        /* ---------- sampling: only while the screen shows ---------- */
        // (shown: the HMI says the screen is visible, or the frame loop runs - it runs only then)
        let shown = false;
        function takeSample() {
            try {
                const t0 = Date.now();
                snap = sampler.sample();
                seq++;
                const m = snap.mem, now = snap.at;
                history.push([now, m ? m.used / m.total * 100 : null, snap.cpu ? snap.cpu.busy : null]);
                while (history.length && now - history[0][0] > (HISTORY_S + 10) * 1000) history.shift();
                // each row's memory over the last minutes (an app or program that ended is forgotten)
                const seen = new Set();
                group(snap.procs, true).concat(group(snap.procs, false)).forEach((r) => {
                    seen.add(r.key);
                    const a = trend.get(r.key) || [];
                    a.push([now, r.mem]);
                    while (a.length && now - a[0][0] > HISTORY_S * 1000) a.shift();
                    trend.set(r.key, a);
                });
                trend.forEach((a, k) => { if (!seen.has(k)) trend.delete(k); });
                if (seq === 1) log.info('first sample: ' + snap.procs.length + ' processes (' + snap.hidden + ' not readable) in ' + (Date.now() - t0) + ' ms');
            } catch (e) { log.warn('sample: ' + (e && e.stack || e)); }
            redraw();
        }
        /** How much a row's own memory grew over the last minutes; null until it has been seen TREND_MIN_S. */
        function growth(key) {
            const a = trend.get(key);
            if (!a || a.length < 2 || a[a.length - 1][0] - a[0][0] < TREND_MIN_S * 1000) return null;
            return a[a.length - 1][1] - a[0][1];
        }
        const interval = () => (Number(settings.get('interval')) || 2) * 1000;
        function schedule(ms) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                if (!shown) return;
                takeSample();
                schedule(interval());
            }, ms);
        }
        function startSampling() {
            shown = true;
            if (timer) return;
            // back after a while off screen: the history starts again (no line drawn across the gap)
            const last = history[history.length - 1];
            if (last && Date.now() - last[0] > interval() * 3) { history.length = 0; trend.clear(); }
            takeSample();
            // processor use needs two samples: the second comes after a second
            schedule(Math.min(1000, interval()));
        }
        if (ui.onVisible) ui.onVisible((name, visible) => {
            if (name !== 'MAIN') return;
            if (visible) startSampling();
            else {
                shown = false;
                if (timer) { clearTimeout(timer); timer = null; }
            }
        });
        settings.onChange((k) => {
            if (k === 'interval' && timer) schedule(interval());
            if (k === 'group') { detail = null; scroll = 0; }
            redraw();
        });

        /** Rows (grouped as set, or by app), each with its growth, sorted. */
        function rows(byApp, by) {
            if (!snap) return [];
            const list = group(snap.procs, byApp);
            list.forEach((r) => { r.grow = growth(r.key); });
            return sortRows(list, by);
        }
        function openDetail(r) { detail = { key: r.key, label: r.label }; redraw(); }
        function closeDetail() { detail = null; redraw(); }
        /** The head unit lets an app see only its own processes: say so where the list would be. */
        function drawRestricted(cv, t, x, y) {
            cv.text('This head unit lets an app see only its own processes.', x, y, sz(cv, 14), t.dim, ROW);
            cv.text(page === 0 ? 'The memory figures above are the whole head unit\'s.' : 'The memory figures on Overview are the whole head unit\'s.',
                x, y + sz(cv, 24), sz(cv, 12), faint(t), ROW);
        }
        /** A row's name, with "(this app)" and an "MGU Store" mark; cut to w. */
        function drawName(cv, t, r, x, y, w, size, col, focus) {
            const name = fitText(cv, r.label + (r.self ? '  (this app)' : ''), w, size, ROW);
            cv.text(name, x, y, size, col, ROW);
            if (r.store && r.kind === 'app' && !r.self) {
                const nx = x + cv.textWidth(name, size, ROW) + sz(cv, 10), ts = sz(cv, 10);
                if (nx + cv.textWidth('MGU Store', ts, ROW) < x + w) cv.text('MGU Store', nx, y, ts, focus ? withAlpha('#ffffff', 0.75) : faint(t), ROW);
            }
        }

        /* ---------- Overview ---------- */
        function drawOverview(cv, t) {
            const m = snap.mem, ex = cv.extra || 0;
            const panelH = 508 + ex - TOP;
            const LX = 24, LW = 760, RX = 800, RW = 776;

            // left: memory now, where it goes, and what uses the most
            G.panelExact(cv, t, LX, TOP, LW, panelH, 'Memory');
            const x = LX + 26, iw = LW - 52;
            let y = TOP + 48;
            if (!m) {
                cv.text('This head unit doesn\'t say how much memory it has.', x, y + sz(cv, 30), sz(cv, 14), t.dim);
                y += sz(cv, 60);
            } else {
                const frac = m.used / m.total, col = pressure(t, frac);
                const big = sz(cv, 24);
                y += big + sz(cv, 10);
                const used = fmtBytes(m.used), uw = cv.textWidth(used, big, { font: 'light' });
                cv.text(used, x, y, big, t.text, { font: 'light' });
                cv.text('in use of ' + fmtBytes(m.total) + (m.approx ? ' (approximate)' : ''), x + uw + sz(cv, 10), y, sz(cv, 13), t.dim);
                cv.text(pct(frac * 100) + ' %', x + iw, y, sz(cv, 19), col, { align: 'right', font: 'label' });
                // the bar: what is in use, in its three parts, over the whole RAM
                y += sz(cv, 11);
                const bh = sz(cv, 9), parts = breakdown(snap), cols = PARTS(t);
                cv.roundRect(x, y, iw, bh, bh / 2, withAlpha('#ffffff', 0.14));
                let bx = x;
                [parts.apps, parts.programs, parts.system].forEach((v, i) => {
                    const w = Math.max(0, Math.min(x + iw - bx, v / m.total * iw));
                    if (w >= 1) cv.fillRect(bx, y, w, bh, cols[i]);
                    bx += w;
                });
                y += bh + sz(cv, 20);
                let lx = x;
                [['iDrive apps', parts.apps], ['Other programs', parts.programs], ['System and shared', parts.system]].forEach((p, i) => {
                    lx += G.status(cv, t, lx, y, p[0] + '  ' + fmtBytes(p[1]), cols[i], sz(cv, 11)) + sz(cv, 22);
                });
                y += sz(cv, 30);
                const stats = [
                    ['Available', fmtBytes(m.available)],
                    ['Cache', fmtBytes(m.cache)],
                    ['Swap', m.swapTotal ? fmtBytes(m.swapUsed) + ' of ' + fmtBytes(m.swapTotal) : 'None'],
                ];
                const cw = iw / stats.length;
                stats.forEach((c, i) => {
                    cv.text(c[0], x + i * cw, y, sz(cv, 10), t.dim, { font: 'label', spacing: 0.4 });
                    cv.text(fitText(cv, c[1], cw - 12, sz(cv, 14), ROW), x + i * cw, y + sz(cv, 19), sz(cv, 14), t.text, ROW);
                });
                y += sz(cv, 19) + sz(cv, 26);
            }
            G.sectionTitle(cv, t, x, y, iw, 'Using the most memory', sz(cv, 13));
            y += sz(cv, 12);
            if (snap.restricted) { drawRestricted(cv, t, x, y + sz(cv, 28)); return drawHistory(cv, t, m, panelH, RX, RW); }
            const top = rows(true, 'mem');
            const rowH = sz(cv, 27), bottom = TOP + panelH - 8;
            const n = Math.max(0, Math.min(top.length, Math.floor((bottom - y) / rowH)));
            const most = top.length ? top[0].mem : 1;
            top.slice(0, n).forEach((r, i) => {
                const ry = y + i * rowH, key = 'top_' + r.key, focus = G.isFocus(cv, key), cy = ry + rowH / 2;
                G.listRow(cv, t, x - 10, ry, iw + 20, rowH, { focus, active: r.self });
                const vs = sz(cv, 12);
                const valX = x + iw - 4, growX = valX - sz(cv, 92), barW = sz(cv, 80), barX = growX - sz(cv, 70) - barW;
                drawName(cv, t, r, x + 4, cy + vs * 0.36, barX - x - sz(cv, 16), vs, t.text, focus);
                G.progress(cv, t, barX, cy - 2, barW, r.mem / most, 4, focus ? '#ffffff' : t.sel || t.accent);
                cv.text(fmtGrow(r.grow), growX, cy + vs * 0.36, sz(cv, 11), growCol(t, r.grow, focus ? withAlpha('#ffffff', 0.75) : faint(t)), { align: 'right', font: 'num' });
                cv.text(fmtBytes(r.mem), valX, cy + vs * 0.36, vs, focus ? '#ffffff' : t.dim, { align: 'right', font: 'num' });
                cv.target(x - 10, ry, iw + 20, rowH, () => openDetail(r), key, 3, { own: true });
            });
            drawHistory(cv, t, m, panelH, RX, RW);
        }

        /** The Overview's right panel: the history of memory and processor use, and a few facts. */
        function drawHistory(cv, t, m, panelH, RX, RW) {
            G.panelExact(cv, t, RX, TOP, RW, panelH, 'Last ' + Math.round(HISTORY_S / 60) + ' minutes');
            const now = snap.at;
            const memPts = history.filter((h) => h[1] != null).map((h) => [(h[0] - now) / 1000, h[1]]);
            const cpuPts = history.filter((h) => h[2] != null).map((h) => [(h[0] - now) / 1000, h[2]]);
            const legendH = sz(cv, 64);
            const chartY = TOP + 60, chartH = TOP + panelH - chartY - legendH;
            G.chart(cv, t, RX + 16, chartY, RW - 36, chartH, {
                xMin: -HISTORY_S, xMax: 0, yMin: 0, yMax: 100, xStep: 60, yStep: 25,
                // (no label at the left end: it would sit on the 0 %)
                xFmt: (v) => (v === 0 ? 'now' : v <= -HISTORY_S ? '' : Math.round(-v / 60) + ' min'), yFmt: (v) => v + '%',
                series: [
                    { pts: memPts, color: m ? pressure(t, m.used / m.total) : t.accent, fill: 0.18, width: 2.5 },
                    { pts: cpuPts, color: t.cold, width: 2 },
                ],
                empty: 'Collecting...',
            });
            let ly = TOP + panelH - legendH + sz(cv, 30);
            const ls = sz(cv, 13);
            let lx = RX + 26;
            lx += G.status(cv, t, lx, ly, 'Memory  ' + (m ? pct(m.used / m.total * 100) + ' %' : '--'), m ? pressure(t, m.used / m.total) : t.dim, ls) + sz(cv, 30);
            G.status(cv, t, lx, ly, 'Processor  ' + (snap.cpu ? pct(snap.cpu.busy) + ' %' : '--'), t.cold, ls);
            ly += sz(cv, 24);
            const facts = [snap.procs.length + (snap.procs.length === 1 ? ' process' : ' processes')];
            if (snap.ncpu) facts.push(snap.ncpu + ' cores');
            if (snap.uptime != null) facts.push('up ' + fmtAge(snap.uptime));
            cv.text(facts.join('   ·   '), RX + 26, ly, sz(cv, 12), faint(t));
        }

        /* ---------- Processes ---------- */
        const listGeo = { rowH: 1, count: 0, visible: 1 };
        let scrollAcc = 0;
        ctx.onScroll((dy) => {
            if (page !== 1 || detail) return false;
            const max = Math.max(0, listGeo.count - listGeo.visible);
            scrollAcc += dy;
            const n = scrollAcc > 0 ? Math.floor(scrollAcc / listGeo.rowH) : Math.ceil(scrollAcc / listGeo.rowH);
            if (!n) return (dy > 0 && scroll < max) || (dy < 0 && scroll > 0);
            scrollAcc -= n * listGeo.rowH;
            const next = Math.max(0, Math.min(max, scroll + n));
            const moved = next !== scroll;
            scroll = next;
            redraw();
            return moved;
        });

        function drawProcesses(cv, t) {
            const grouped = !!settings.get('group'), list = rows(grouped, sortBy), total = snap.mem ? snap.mem.total : null;
            const ex = cv.extra || 0, panelH = 508 + ex - TOP;
            const title = (grouped ? 'Apps and programs' : 'Processes') + '  ·  ' + list.length;
            G.panelExact(cv, t, 24, TOP, 1552, panelH, title);
            const note = 'Memory: each one\'s own, without shared files' + (snap.hidden ? '   ·   ' + snap.hidden + ' not readable' : '');
            cv.text(note, 1552, TOP + 33, sz(cv, 11), faint(t), { align: 'right' });

            // the headings: tap one to sort by it
            const hs = sz(cv, 12), hy = TOP + 48 + sz(cv, 26);
            const X = { name: 60, count: 760, mem: 960, pct: 1110, grow: 1280, cpu: 1440 };
            const heading = (label, x, align, by) => {
                const on = by && sortBy === by, key = 'sort_' + by;
                const w = cv.textWidth(label, hs, { font: 'label' }) + (on ? hs : 0);
                const x0 = align === 'right' ? x - w : x;
                if (by && G.isFocus(cv, key)) G.focusBar(cv, t, x0 - 10, hy - hs - 8, w + 20, hs + 18, 3);
                cv.text(label, align === 'right' && on ? x - hs : x, hy, hs, on ? t.text : t.dim, { align, font: 'label', spacing: 0.4 });
                if (on) downMark(cv, align === 'right' ? x - hs * 0.4 : x0 + w - hs * 0.4, hy - hs * 0.2, hs * 0.3, t.text);
                if (by) cv.target(x0 - 10, hy - hs - 12, w + 20, hs + 26, () => { sortBy = by; scroll = 0; redraw(); }, key, 3, { own: true });
            };
            heading('Name', X.name, 'left', 'name');
            heading(grouped ? 'Processes' : 'PID', X.count, 'right', null);
            heading('Memory', X.mem, 'right', 'mem');
            heading('% of RAM', X.pct, 'right', null);
            heading('Last 3 min', X.grow, 'right', 'grow');
            heading('Processor', X.cpu, 'right', 'cpu');

            const listTop = hy + sz(cv, 14), rowH = sz(cv, 33), listBottom = TOP + panelH - 8;
            const visible = Math.max(1, Math.floor((listBottom - listTop) / rowH));
            scroll = Math.max(0, Math.min(scroll, Math.max(0, list.length - visible)));
            listGeo.rowH = rowH; listGeo.count = list.length; listGeo.visible = visible;
            cv.scroll = true;
            const vs = sz(cv, 14), by = (y) => y + vs * 0.36;
            list.slice(scroll, scroll + visible).forEach((r, vi) => {
                const y = listTop + vi * rowH, cy = y + rowH / 2, key = 'row_' + r.key, focus = G.isFocus(cv, key);
                G.listRow(cv, t, 40, y, 1500, rowH, { focus, active: r.self });
                const val = focus ? '#ffffff' : t.text, dim = focus ? withAlpha('#ffffff', 0.8) : t.dim;
                drawName(cv, t, r, X.name, by(cy), X.count - 150 - X.name, vs, val, focus);
                cv.text(grouped ? String(r.count) : String(r.pids[0]), X.count, by(cy), vs, dim, { align: 'right', font: 'num' });
                cv.text(fmtBytes(r.mem), X.mem, by(cy), vs, val, { align: 'right', font: 'num' });
                cv.text(total ? pct(r.mem / total * 100) + ' %' : '--', X.pct, by(cy), vs, dim, { align: 'right', font: 'num' });
                cv.text(fmtGrow(r.grow), X.grow, by(cy), vs, growCol(t, r.grow, dim), { align: 'right', font: 'num' });
                cv.text(r.cpu == null ? '--' : pct(r.cpu) + ' %', X.cpu, by(cy), vs, dim, { align: 'right', font: 'num' });
                G.chevron(cv, 1516, cy, sz(cv, 6), dim);
                cv.target(40, y, 1500, rowH, () => openDetail(r), key, 3, { list: 'procs', row: scroll + vi, step: rowH, own: true });
            });
            if (snap.restricted && list.length <= visible) drawRestricted(cv, t, 60, listTop + list.length * rowH + sz(cv, 34));
            else if (!list.length) cv.text('No processes could be read.', 800, listTop + sz(cv, 40), sz(cv, 15), t.dim, { align: 'center' });
            G.scrollbar(cv, t, 1556, listTop, listBottom - listTop, list.length, visible, scroll);
        }

        /* ---------- a row's details ---------- */
        function tile(cv, t, x, y, w, h, label, value, color) {
            cv.roundRect(x, y, w, h, 10, withAlpha('#ffffff', 0.06));
            cv.text(label.toUpperCase(), x + sz(cv, 14), y + sz(cv, 22), sz(cv, 10), t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(fitText(cv, value, w - sz(cv, 28), sz(cv, 22), { font: 'bold' }), x + sz(cv, 14), y + h - sz(cv, 16), sz(cv, 22), color || t.text, { font: 'bold' });
        }
        function drawDetail(cv, t) {
            const ex = cv.extra || 0, panelH = 508 + ex - TOP;
            const r = rows(detail.key.indexOf('pid:') !== 0, 'mem').find((g) => g.key === detail.key);
            G.panelExact(cv, t, 24, TOP, 1552, panelH, r ? r.label + (r.self ? '  (this app)' : '') : detail.label);
            const bw = sz(cv, 110), bh = sz(cv, 30);
            drawButton(cv, t, 1552 - bw, TOP + 6, bw, bh, 'Back', 'btn_back', closeDetail, { chevron: 'left' });
            const x = 50, iw = 1500;
            if (!r) {
                cv.text('This ' + (detail.key.indexOf('pid:') === 0 ? 'process' : 'program') + ' has ended.', x, TOP + 48 + sz(cv, 36), sz(cv, 16), t.dim);
                return;
            }
            const total = snap.mem ? snap.mem.total : null;
            let y = TOP + 48 + sz(cv, 10);
            const th = sz(cv, 62), gap = 18;
            const tiles = [
                ['Its own memory', fmtBytes(r.mem)],
                ['Share of RAM', total ? pct(r.mem / total * 100) + ' %' : '--'],
                ['Last 3 minutes', fmtGrow(r.grow), growCol(t, r.grow, null)],
                ['Processor', r.cpu == null ? '--' : pct(r.cpu) + ' %'],
                r.count > 1 ? ['Processes', String(r.count)] : ['Threads', String(r.threads)],
            ];
            const tw = (iw - gap * (tiles.length - 1)) / tiles.length;
            tiles.forEach((d, i) => tile(cv, t, x + i * (tw + gap), y, tw, th, d[0], d[1], d[2]));
            y += th + sz(cv, 28);
            const ls = sz(cv, 13), lh = sz(cv, 22);
            const uid = r.procs[0] ? r.procs[0].uid : null;
            cv.text('This is ' + kindText(r) + (uid != null && r.kind ? ' (user ' + uid + ')' : '') + '.', x, y, ls, t.text, ROW);
            y += lh + 4;
            cv.text('With the program and library files it shares with others ' + fmtBytes(r.rss) + '   ·   swapped out ' + fmtBytes(r.swap), x, y, ls, t.dim, ROW);
            y += lh + 4;
            if (r.count === 1) {
                const p = r.procs[0];
                const states = { R: 'running', S: 'sleeping', D: 'waiting on a device', T: 'stopped', Z: 'ended (zombie)', I: 'idle' };
                const facts = ['PID ' + p.pid, 'parent ' + p.ppid, states[p.state] || p.state];
                if (p.age != null) facts.push('running for ' + fmtAge(p.age));
                if (p.file != null) facts.push('files ' + fmtBytes(p.file), 'shared memory ' + fmtBytes(p.shm));
                cv.text(facts.join('   ·   '), x, y, ls, t.dim, ROW);
                y += lh + 2;
                const cmd = sampler.command(p.pid);
                if (cmd) {
                    G.sectionTitle(cv, t, x, y + sz(cv, 10), iw, 'Command', sz(cv, 13));
                    y += sz(cv, 32);
                    cv.text(fitText(cv, cmd, iw, sz(cv, 12), NUM), x, y, sz(cv, 12), t.dim, NUM);
                }
                return;
            }
            // a group: its processes, the largest first
            G.sectionTitle(cv, t, x, y + sz(cv, 4), iw, 'Its processes', sz(cv, 13));
            y += sz(cv, 16);
            const procRow = sz(cv, 26), bottom = TOP + panelH - 8;
            const procs = r.procs.slice().sort((a, b) => b.mem - a.mem);
            const n = Math.max(0, Math.floor((bottom - y) / procRow));
            procs.slice(0, n).forEach((p, i) => {
                const ry = y + i * procRow, cy = ry + procRow / 2, s = sz(cv, 12);
                G.listRow(cv, t, x - 10, ry, iw + 20, procRow, { active: p.self });
                cv.text('PID ' + p.pid, x, cy + s * 0.36, s, t.dim, NUM);
                cv.text(fmtBytes(p.mem), x + 360, cy + s * 0.36, s, t.text, { align: 'right', font: 'num' });
                cv.text(p.cpu == null ? '--' : pct(p.cpu) + ' %', x + 500, cy + s * 0.36, s, t.dim, { align: 'right', font: 'num' });
                cv.text(fitText(cv, sampler.command(p.pid) || p.name, iw - 560, s, NUM), x + 560, cy + s * 0.36, s, t.dim, NUM);
            });
            if (procs.length > n) cv.text('and ' + (procs.length - n) + ' more', x + iw - sz(cv, 130), TOP + 33, sz(cv, 12), faint(t), { align: 'right' });
        }

        /* ---------- frame ---------- */
        function frameSig() {
            return [page, detail && detail.key, ctx.display && ctx.display.focusKey, scroll, seq, sortBy,
                settings.get('theme'), settings.get('group')].join('|');
        }
        let lastSig = '', lastDrawAt = 0;
        function loopFrame() {
            if (!shown) startSampling();
            if (Date.now() - lastDrawAt < 1000 && frameSig() === lastSig) return Promise.resolve();
            return render();
        }
        async function render() {
            lastSig = frameSig();
            lastDrawAt = Date.now();
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            G.background(cv, t, 0, 0, W, H + (cv.extra || 0));
            if (!snap) cv.text('Reading memory...', 800, 260, sz(cv, 16), t.dim, { align: 'center' });
            else if (detail) drawDetail(cv, t);
            else if (page === 0) drawOverview(cv, t);
            else drawProcesses(cv, t);
            const m = snap && snap.mem;
            G.frame(cv, t, PAGES, page, [
                sample ? { text: 'Sample data', color: t.warn }
                    : m ? { text: 'Memory ' + pct(m.used / m.total * 100) + ' %', color: pressure(t, m.used / m.total) } : null,
            ]);
            await ui.image('MAIN_GFX', cv);
        }
        /** Draw now (after a tap, a sample, a setting); a failed frame is logged, the next one tries again. */
        function redraw() { render().catch((e) => log.error('render', e)); }

        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; detail = null; return render(); });
        ctx.onTab((i) => { page = i; detail = null; return render(); });
        ctx.loop('MAIN', 4, loopFrame, { maxFps: 15 });
        if (ctx.onLayout) ctx.onLayout(redraw);
        if (ui.isVisible && ui.isVisible('MAIN')) startSampling();
        await render();
        log.info('System Monitor ready (' + (sample ? 'sample data' : '/proc') + ')');
    },
});
