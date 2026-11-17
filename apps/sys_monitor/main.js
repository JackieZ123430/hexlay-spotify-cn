'use strict';
/**
 * System Monitor - what uses the head unit's memory (and processor), on the central display.
 *
 *   Overview   memory in use and free, split into iDrive apps, other programs and the system; the processor;
 *              a live history of memory and processor use; the apps and programs using the most memory
 *   Processor  how busy it is, its load, temperature and clock (where the head unit lets an app read them),
 *              each core, what the time went to, and the apps and programs keeping it busy
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
const PAGES = ['Overview', 'Processor', 'Processes'];
const PG_OVERVIEW = 0, PG_CPU = 1, PG_PROCS = 2;
const HISTORY_S = 180;                 // the chart's span, and the span growth is measured over
const TREND_MIN_S = 30;                // growth is shown once a row has been seen this long
const MB = 1024 * 1024;
const TOP = 44;                        // panels start under the tab bar

/** Memory use's colour: fine, getting full, nearly full. */
function pressure(t, frac) { return frac >= 0.9 ? t.crit : frac >= 0.75 ? t.warn : t.ok; }
function pct(n) { return n == null ? '--' : n < 10 ? n.toFixed(1) : String(Math.round(n)); }
/** Growth over the last minutes: "+12.0 MB", "0" (under 1 MB either way: a heap's usual ups and downs), "--" (not seen long enough). */
function fmtGrow(d) { return d == null ? '--' : Math.abs(d) < MB ? '0' : (d > 0 ? '+' : '') + fmtBytes(d); }
function growCol(t, d, base) { return d == null || d < 10 * MB ? base : d >= 50 * MB ? t.crit : t.warn; }

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
            cv.text('This head unit lets an app see only its own processes.', x, y, 26, t.dim);
            cv.text(page === PG_PROCS ? 'The memory and processor figures on Overview are the whole head unit\'s.'
                : 'The figures above are the whole head unit\'s.', x, y + 36, 22, t.dim);
        }
        /** A row's name in bold, with "(this app)" and an "MGU Store" tag; cut to w. */
        function drawName(cv, t, r, x, y, w, size) {
            const tag = r.store && r.kind === 'app' && !r.self, tw = tag ? 150 : 0;
            const name = fitText(cv, r.label + (r.self ? '  (this app)' : ''), w - tw, size, { font: 'bold' });
            cv.text(name, x, y, size, t.text, { font: 'bold' });
            if (tag) {
                const nx = x + cv.textWidth(name, size, { font: 'bold' }) + 14;
                cv.roundRect(nx, y - size * 0.8, 130, size * 0.95, 6, withAlpha(t.accent, 0.22));
                cv.text('MGU STORE', nx + 65, y - size * 0.12, 16, t.accent, { align: 'center', font: 'bold', spacing: 0.5 });
            }
        }

        /** Tile i of n across the top (as Fault Scanner's): its label, a big value and a note under the label's right. */
        function tile(cv, t, i, n, label, value, sub, col) {
            const w = (1552 - (n - 1) * 16) / n, x = 24 + i * (w + 16);
            G.panel(cv, t, x, 44, w, 115, label);
            // the number in the number font (it has no letters), its unit after it in the text's
            const size = n > 4 ? 44 : 52, m = /^([+-]?[\d.,]+)\s*(.*)$/.exec(String(value));
            const num = m ? m[1] : String(value), unit = m ? m[2] : '';
            cv.text(num, x + 18, 142, size, col || t.text, { font: m ? 'num' : 'bold' });
            let used = 18 + cv.textWidth(num, size, { font: m ? 'num' : 'bold' });
            if (unit) {
                cv.text(unit, x + used + 8, 142, Math.round(size * 0.5), t.dim, { font: 'bold' });
                used += 8 + cv.textWidth(unit, Math.round(size * 0.5), { font: 'bold' });
            }
            // the note: in what the number leaves free
            if (sub) cv.text(fitText(cv, sub, w - used - 36, 22), x + w - 18, 142, 22, t.dim, { align: 'right' });
        }

        /** A coloured dot and its text (legends): returns the width taken. */
        function legend(cv, t, x, y, text, col) {
            cv.circle(x + 7, y - 7, 7, col);
            cv.text(text, x + 22, y, 22, t.text);
            return 22 + cv.textWidth(text, 22);
        }

        /* ---------- Overview ---------- */
        function drawOverview(cv, t) {
            const m = snap.mem, ex = G.pageBottom(cv) - G.BOTTOM;
            if (m) {
                const frac = m.used / m.total, parts = breakdown(snap);
                tile(cv, t, 0, 5, 'Memory in use', pct(frac * 100) + ' %', fmtBytes(m.used) + ' of ' + fmtBytes(m.total), pressure(t, frac));
                tile(cv, t, 1, 5, 'iDrive apps', fmtBytes(parts.apps), 'and MainApp', t.text);
                tile(cv, t, 2, 5, 'Other programs', fmtBytes(parts.programs), 'HMI, nav', t.text);
                tile(cv, t, 3, 5, 'Available', fmtBytes(m.available), m.swapTotal ? 'swap ' + fmtBytes(m.swapUsed) : 'no swap', t.text);
            } else {
                tile(cv, t, 0, 5, 'Memory', '--', 'not reported', t.dim);
                tile(cv, t, 1, 5, 'Processes', String(snap.procs.length), '', t.text);
            }
            // the processor, in the colour of its line in the chart below (a tap or press: the Processor page)
            tile(cv, t, 4, 5, 'Processor', snap.cpu ? pct(snap.cpu.busy) + ' %' : '--', cpuNote(), t.cold);
            if (cv.own) cv.target(24 + 4 * ((1552 - 64) / 5 + 16), 44, (1552 - 64) / 5, 115, () => { page = PG_CPU; redraw(); }, 'tile_cpu', 8);

            // left: what uses the most memory (a tap or press: its details)
            const p = G.panel(cv, t, 24, 176, 760, 336, 'Using the most memory');
            if (snap.restricted) drawRestricted(cv, t, 48, 270);
            else {
                const top = rows(true, 'mem'), most = top.length ? top[0].mem : 1;
                const n = Math.max(0, Math.min(top.length, Math.floor((p.y + p.h - 12 - 232) / 46)));
                top.slice(0, n).forEach((r, i) => {
                    const y = 232 + i * 46;
                    if (cv.own) cv.target(40, y - 4, 728, 42, () => openDetail(r), 'top_' + r.key, 8);
                    cv.roundRect(48, y + 3, 8, 30, 4, r.self ? t.accent : growCol(t, r.grow, withAlpha(t.dim, 0.5)));
                    drawName(cv, t, r, 72, y + 28, 340, 24);
                    cv.roundRect(430, y + 14, 150, 8, 4, t.track);
                    cv.roundRect(430, y + 14, Math.max(8, 150 * r.mem / most), 8, 4, t.bar || t.accent);
                    cv.text(fmtGrow(r.grow), 660, y + 27, 20, growCol(t, r.grow, t.dim), { align: 'right', font: 'num' });
                    cv.text(fmtBytes(r.mem), 760, y + 28, 26, t.text, { align: 'right', font: 'bold' });
                    if (i < n - 1) cv.fillRect(48, y + 40, 712, 1, withAlpha(t.tick, 0.25));
                });
            }

            // right: memory and processor over the last minutes
            const q = G.panel(cv, t, 804, 176, 772, 336, 'Last ' + Math.round(HISTORY_S / 60) + ' minutes');
            const now = snap.at;
            const memPts = history.filter((h) => h[1] != null).map((h) => [(h[0] - now) / 1000, h[1]]);
            const cpuPts = history.filter((h) => h[2] != null).map((h) => [(h[0] - now) / 1000, h[2]]);
            const memCol = m ? pressure(t, m.used / m.total) : t.accent;
            G.chart(cv, t, 820, 226, 740, q.y + q.h - 226 - 52, {
                xMin: -HISTORY_S, xMax: 0, yMin: 0, yMax: 100, xStep: 60, yStep: 25,
                // (no label at the left end: it would sit on the 0 %)
                xFmt: (v) => (v === 0 ? 'now' : v <= -HISTORY_S ? '' : Math.round(-v / 60) + ' min'), yFmt: (v) => v + '%',
                series: [
                    { pts: memPts, color: memCol, fill: 0.18, width: 2.5 },
                    { pts: cpuPts, color: t.cold, width: 2 },
                ],
                empty: 'Collecting...',
            });
            const ly = q.y + q.h - 18;
            let lx = 830;
            lx += legend(cv, t, lx, ly, 'Memory  ' + (m ? pct(m.used / m.total * 100) + ' %' : '--'), memCol) + 30;
            legend(cv, t, lx, ly, 'Processor  ' + (snap.cpu ? pct(snap.cpu.busy) + ' %' : '--'), t.cold);
            const facts = [snap.procs.length + (snap.procs.length === 1 ? ' process' : ' processes')];
            if (snap.ncpu) facts.push(snap.ncpu + ' cores');
            if (snap.uptime != null) facts.push('up ' + fmtAge(snap.uptime));
            cv.text(facts.join('  ·  '), 1552, ly, 20, t.dim, { align: 'right' });
            return ex;
        }

        /** The processor in a few words, under its tile: its load, else its cores. */
        function cpuNote() {
            return snap.load ? 'load ' + snap.load.one.toFixed(1) : snap.ncpu ? snap.ncpu + ' cores' : '';
        }
        /** A list of rows (the busiest, the largest) in panel p, from y: name, a bar, a value; a tap or press opens its details. */
        function topList(cv, t, p, list, value, frac, keyPrefix) {
            const n = Math.max(0, Math.min(list.length, Math.floor((p.y + p.h - 12 - 232) / 46)));
            list.slice(0, n).forEach((r, i) => {
                const y = 232 + i * 46, x = p.x + 24, w = p.w - 48;
                if (cv.own) cv.target(x - 8, y - 4, w + 16, 42, () => openDetail(r), keyPrefix + r.key, 8);
                cv.roundRect(x, y + 3, 8, 30, 4, r.self ? t.accent : withAlpha(t.dim, 0.5));
                drawName(cv, t, r, x + 24, y + 28, w * 0.48, 24);
                const bx = x + w * 0.56, bw = w * 0.24;
                cv.roundRect(bx, y + 14, bw, 8, 4, t.track);
                cv.roundRect(bx, y + 14, Math.max(8, bw * Math.max(0, Math.min(1, frac(r)))), 8, 4, t.bar || t.accent);
                cv.text(value(r), x + w, y + 28, 26, t.text, { align: 'right', font: 'bold' });
                if (i < n - 1) cv.fillRect(x, y + 40, w, 1, withAlpha(t.tick, 0.25));
            });
            return n;
        }

        /* ---------- Processor ---------- */
        function drawProcessor(cv, t) {
            const c = snap.cpu, load = snap.load, tiles = [];
            tiles.push(['Processor', c ? pct(c.busy) + ' %' : '--', snap.ncpu ? snap.ncpu + ' cores' : '', t.cold]);
            if (load) tiles.push(['Load', load.one.toFixed(2), '15 min ' + load.fifteen.toFixed(2), t.text]);
            // (the head unit may keep its sensors from apps: then no tile, rather than a blank one)
            if (snap.temp) tiles.push(['Temperature', Math.round(snap.temp.c) + ' °C', '', snap.temp.c >= 90 ? t.crit : snap.temp.c >= 80 ? t.warn : t.text]);
            if (snap.freq) tiles.push(['Clock', (snap.freq.hz / 1e9).toFixed(2) + ' GHz', snap.freq.max ? 'max ' + (snap.freq.max / 1e9).toFixed(1) + ' GHz' : '', t.text]);
            if (load && load.threads) tiles.push(['Threads', String(load.threads), load.running != null ? load.running + ' running' : '', t.text]);
            tiles.forEach((d, i) => tile(cv, t, i, tiles.length, d[0], d[1], d[2], d[3]));

            // left: each core, and what the time went to
            const p = G.panel(cv, t, 24, 176, 760, 336, 'Cores');
            const cores = c && c.cores ? c.cores : [], foot = 84;
            if (!cores.length) cv.text(c ? 'This head unit doesn\'t say how busy each core is.' : 'Measuring...', 48, 260, 24, t.dim);
            const rowH = Math.min(54, (p.y + p.h - foot - 226) / Math.max(1, cores.length));
            cores.forEach((v, i) => {
                const y = 226 + i * rowH, cy = y + rowH / 2;
                cv.text('Core ' + (i + 1), 48, cy + 8, 22, t.dim, { font: 'bold' });
                cv.roundRect(170, cy - 5, 480, 10, 5, t.track);
                if (v != null) cv.roundRect(170, cy - 5, Math.max(10, 480 * v / 100), 10, 5, v >= 90 ? t.warn : t.cold);
                cv.text(v == null ? '--' : pct(v) + ' %', 760, cy + 9, 24, t.text, { align: 'right', font: 'num' });
            });
            if (c) {
                // the whole processor's time: apps' and programs' own work, the kernel's, waiting on storage
                // as one bar over the whole processor's time (the rest: idle), its legend under it
                const ly = p.y + p.h - 18, by = ly - 46, cols = [t.cold, withAlpha(t.text, 0.75), t.warn];
                const parts = [['Programs', c.user], ['System', c.system], ['Waiting on storage', c.iowait]];
                cv.roundRect(48, by, 712, 10, 5, t.track);
                let bx = 48;
                parts.forEach((d, i) => {
                    const w = Math.max(0, Math.min(48 + 712 - bx, 712 * d[1] / 100));
                    if (w >= 1) cv.fillRect(bx, by, w, 10, cols[i]);
                    bx += w;
                });
                let lx = 48;
                parts.forEach((d, i) => { lx += legend(cv, t, lx, ly, d[0] + '  ' + pct(d[1]) + ' %', cols[i]) + 28; });
            }

            // right: what keeps it busy
            const q = G.panel(cv, t, 804, 176, 772, 336, 'Using the most processor');
            if (snap.restricted) return drawRestricted(cv, t, 828, 270);
            const busy = rows(true, 'cpu').filter((r) => r.cpu != null);
            if (!busy.length) { cv.text(c ? 'Nothing is busy right now.' : 'Measuring...', 828, 270, 24, t.dim); return; }
            const most = Math.max(1, busy[0].cpu);
            topList(cv, t, q, busy, (r) => pct(r.cpu) + ' %', (r) => r.cpu / most, 'cpu_');
        }

        /* ---------- Processes ---------- */
        const listGeo = { rowH: 46, count: 0, visible: 1 };
        let scrollAcc = 0;
        ctx.onScroll((dy) => {
            if (page !== PG_PROCS || detail) return false;
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
            const title = (grouped ? 'Apps and programs' : 'Processes') + '  ' + list.length;
            const p = G.panel(cv, t, 24, 44, 1552, 468, title);
            const note = 'Memory: each one\'s own, without shared files' + (snap.hidden ? '  ·  ' + snap.hidden + ' not readable' : '');
            cv.text(note, 1552, 80, 20, t.dim, { align: 'right' });

            // the column headings: tap one to sort by it (the one sorted by in the theme's colour)
            const hy = 128;
            const X = { name: 72, count: 760, mem: 960, pct: 1120, grow: 1300, cpu: 1470 };
            const heading = (label, x, align, by) => {
                const on = by && sortBy === by, opt = { align, font: 'bold', spacing: 1.2 };
                const text = label.toUpperCase() + (on ? '  v' : ''), w = cv.textWidth(text, 18, opt);
                cv.text(text, x, hy, 18, on ? t.sel || t.accent : t.dim, opt);
                if (by && cv.own) cv.target((align === 'right' ? x - w : x) - 12, hy - 30, w + 24, 44, () => { sortBy = by; scroll = 0; redraw(); }, 'sort_' + by, 8);
            };
            heading('Name', X.name, 'left', 'name');
            heading(grouped ? 'Processes' : 'PID', X.count, 'right', null);
            heading('Memory', X.mem, 'right', 'mem');
            heading('% of RAM', X.pct, 'right', null);
            heading('Last 3 min', X.grow, 'right', 'grow');
            heading('Processor', X.cpu, 'right', 'cpu');
            cv.fillRect(48, hy + 12, 1504, 2, withAlpha(t.tick, 0.5));

            const listTop = hy + 22, rowH = 46, listBottom = p.y + p.h - 12;
            const visible = Math.max(1, Math.floor((listBottom - listTop) / rowH));
            scroll = Math.max(0, Math.min(scroll, Math.max(0, list.length - visible)));
            listGeo.rowH = rowH; listGeo.count = list.length; listGeo.visible = visible;
            if (list.length > visible) cv.scroll = true;
            list.slice(scroll, scroll + visible).forEach((r, vi) => {
                const y = listTop + vi * rowH, ty = y + 30;
                if (cv.own) cv.target(40, y, 1504, rowH - 4, () => openDetail(r), 'row_' + r.key, 8);
                cv.roundRect(48, y + 6, 8, 30, 4, r.self ? t.accent : growCol(t, r.grow, withAlpha(t.dim, 0.5)));
                drawName(cv, t, r, X.name, ty, X.count - 160 - X.name, 26);
                cv.text(grouped ? String(r.count) : String(r.pids[0]), X.count, ty, 24, t.dim, { align: 'right', font: 'num' });
                cv.text(fmtBytes(r.mem), X.mem, ty, 26, t.text, { align: 'right', font: 'bold' });
                cv.text(total ? pct(r.mem / total * 100) + ' %' : '--', X.pct, ty, 24, t.dim, { align: 'right', font: 'num' });
                cv.text(fmtGrow(r.grow), X.grow, ty, 24, growCol(t, r.grow, t.dim), { align: 'right', font: 'num' });
                cv.text(r.cpu == null ? '--' : pct(r.cpu) + ' %', X.cpu, ty, 24, t.dim, { align: 'right', font: 'num' });
                if (vi < visible - 1 && scroll + vi < list.length - 1) cv.fillRect(48, y + rowH - 3, 1504, 1, withAlpha(t.tick, 0.25));
            });
            if (snap.restricted && list.length <= visible) drawRestricted(cv, t, 72, listTop + list.length * rowH + 44);
            else if (!list.length) cv.text('No processes could be read.', 800, listTop + 60, 28, t.dim, { align: 'center' });
            // where the list is: a bar at the panel's right edge
            if (list.length > visible) {
                const vis = listBottom - listTop, bh = Math.max(40, vis * visible / list.length);
                cv.roundRect(1561, listTop + (vis - bh) * scroll / Math.max(1, list.length - visible), 6, bh, 3, withAlpha(t.text, 0.3));
            }
        }

        /* ---------- a row's details ---------- */
        function drawDetail(cv, t) {
            const r = rows(detail.key.indexOf('pid:') !== 0, 'mem').find((g) => g.key === detail.key);
            const name = r ? r.label + (r.self ? '  (this app)' : '') : detail.label;
            if (!r) {
                const p = G.panel(cv, t, 24, 44, 1552, 468, name);
                G.button(cv, t, 42 + cv.textWidth(name, 26, { font: 'bold' }) + 28, 57, 0, 40, 'Back', closeDetail, { key: 'back' });
                cv.text('This ' + (detail.key.indexOf('pid:') === 0 ? 'process' : 'program') + ' has ended.', 800, p.y + p.h / 2, 30, t.dim, { align: 'center' });
                return;
            }
            const total = snap.mem ? snap.mem.total : null;
            tile(cv, t, 0, 5, 'Own memory', fmtBytes(r.mem), '', t.text);
            tile(cv, t, 1, 5, 'Share of RAM', total ? pct(r.mem / total * 100) + ' %' : '--', '', t.text);
            tile(cv, t, 2, 5, 'Last 3 minutes', fmtGrow(r.grow), '', growCol(t, r.grow, t.text));
            tile(cv, t, 3, 5, 'Processor', r.cpu == null ? '--' : pct(r.cpu) + ' %', '', t.cold);
            tile(cv, t, 4, 5, r.count > 1 ? 'Processes' : 'Threads', String(r.count > 1 ? r.count : r.threads), '', t.text);

            const p = G.panel(cv, t, 24, 176, 1552, 336, name);
            // Back right after the title, as Fault Scanner puts its buttons (where the kit runs the screen; else the bar's page button)
            G.button(cv, t, 42 + cv.textWidth(fitText(cv, name, 900, 26, { font: 'bold' }), 26, { font: 'bold' }) + 28, 189, 0, 40, 'Back', closeDetail, { key: 'back' });
            const x = 48, iw = 1504, row = (y, label, value) => {
                cv.text(label.toUpperCase(), x, y, 20, t.dim, { font: 'bold', spacing: 1.2 });
                cv.text(fitText(cv, value, iw - 300, 24), x + 280, y, 24, t.text);
            };
            const uid = r.procs[0] ? r.procs[0].uid : null;
            let y = 262;
            row(y, 'What it is', kindText(r) + (uid != null && r.kind ? ' (user ' + uid + ')' : ''));
            y += 40;
            row(y, 'With shared files', fmtBytes(r.rss) + '  ·  swapped out ' + fmtBytes(r.swap));
            y += 40;
            if (r.count === 1) {
                const pr = r.procs[0];
                const states = { R: 'running', S: 'sleeping', D: 'waiting on a device', T: 'stopped', Z: 'ended (zombie)', I: 'idle' };
                const facts = ['PID ' + pr.pid, 'parent ' + pr.ppid, states[pr.state] || pr.state];
                if (pr.age != null) facts.push('running for ' + fmtAge(pr.age));
                row(y, 'Process', facts.join('  ·  '));
                y += 40;
                if (pr.file != null) { row(y, 'Files, shared', fmtBytes(pr.file) + '  ·  shared memory ' + fmtBytes(pr.shm)); y += 40; }
                const cmd = sampler.command(pr.pid);
                if (cmd) row(y, 'Command', cmd);
                return;
            }
            // a group: its processes, the largest first
            cv.fillRect(x, y - 16, iw, 1, withAlpha(t.tick, 0.25));
            const procs = r.procs.slice().sort((a, b) => b.mem - a.mem), bottom = p.y + p.h - 12;
            const n = Math.max(0, Math.floor((bottom - y) / 34));
            procs.slice(0, n).forEach((pr, i) => {
                const ry = y + i * 34;
                cv.text('PID ' + pr.pid, x, ry, 22, t.dim, { font: 'num' });
                cv.text(fmtBytes(pr.mem), x + 360, ry, 24, t.text, { align: 'right', font: 'bold' });
                cv.text(pr.cpu == null ? '--' : pct(pr.cpu) + ' %', x + 500, ry, 22, t.dim, { align: 'right', font: 'num' });
                cv.text(fitText(cv, sampler.command(pr.pid) || pr.name, iw - 560, 22), x + 560, ry, 22, t.dim);
            });
            if (procs.length > n) cv.text('and ' + (procs.length - n) + ' more', 1552, 212, 22, t.dim, { align: 'right' });
        }

        /* ---------- frame ---------- */
        function frameSig() {
            return [page, detail && detail.key, scroll, seq, sortBy, settings.get('theme'), settings.get('group')].join('|');
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
            if (!snap) cv.text('Reading memory...', 800, 280, 32, t.dim, { align: 'center' });
            else if (detail) drawDetail(cv, t);
            else if (page === PG_OVERVIEW) drawOverview(cv, t);
            else if (page === PG_CPU) drawProcessor(cv, t);
            else drawProcesses(cv, t);
            G.frame(cv, t, PAGES, page);   // no status chips: the pages show memory themselves
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
