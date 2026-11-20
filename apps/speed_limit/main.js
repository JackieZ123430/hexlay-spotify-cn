'use strict';
/**
 * Speed Limit - the speed limit of the road the car is on, on the head-up display and the cluster's map, from an
 * offline OpenStreetMap pack (georgia.pack, kit/tools/pack_sli.py). Read only: it subscribes to the car's position,
 * speed and power state and writes nothing to any unit.
 *
 * Starts with the car (app.json "autostart": background() runs without screens). While the car is on (power state
 * 7 ignition, 8 starting, 10 drive-ready, 12 ending) it matches the position to a road twice a second and shows
 * the limit. Parked or locked (WOHNEN, PARKEN...), it stops: the position and speed subscriptions are dropped, the
 * cluster-render layers go (the HUD and the cluster are given back) and no timer runs; only the power state stays
 * subscribed, so it wakes with the car.
 *
 * The app's page: the limit now, where it comes from, and a Details tab (sources, the matched road, the outputs).
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const Car = require('./kit/car');
const { LimitPack, F, CLASS } = require('./limitpack');
const { Matcher } = require('./matcher');
const { Position, DemoDrive } = require('./position');
const { Outputs } = require('./outputs');
const { paintSign } = require('./sign');

const APP_ID = 'speed_limit';
const TICK_MS = 500;
const VIEW_HOLD_MS = 8000;
const ACTIVE = { 7: true, 8: true, 10: true, 12: true };
const COND_NAMES = { 1: 'parked (bus off)', 2: 'parked', 3: 'stand-by', 5: 'parked, living', 7: 'ignition on', 8: 'starting', 10: 'drive-ready', 12: 'switching off' };
const W = 1600, H = 520;

/* ---------- the engine: runs with or without the app's screens ---------- */
class Engine {
    constructor(bg) {
        this.log = bg.log;
        this.settings = bg.settings;
        this.signals = bg.signals;
        this.dataDir = bg.dataDir;
        this.pack = null;
        this.packError = '';
        try { this.pack = LimitPack.open(path.join(__dirname, 'georgia.pack')); this.log.info('map: ' + this.pack.describe()); } catch (e) { this.packError = String(e.message || e); this.log.error('map: ' + this.packError); }
        this.matcher = this.pack ? new Matcher(this.pack, { defaults: this.defaults() }) : null;
        this.position = new Position(this.signals, this.log);
        // the PC's emulator and preview (setting "demo", never set in a car): a drive on the Tbilisi Bypass Road
        this.demo = this.settings.get('demo') === 'on' && this.pack ? new DemoDrive(this.pack, { way: this.settings.get('demoWay'), speed: this.settings.get('demoSpeed') }) : null;
        this.outputs = new Outputs(APP_ID, this.log, this.settings);
        this.condition = undefined;
        this.active = false;
        this.timer = null;
        this.res = null;
        this.view = null;
        this.viewAt = 0;
        this.speed = null;
        this.fix = null;
        this.stats = { ticks: 0, msMax: 0, msSum: 0 };
        this.listeners = [];
        this.rec = null;
        this.settings.onChange((k) => {
            if (/^def/.test(k) && this.matcher) this.matcher.setDefaults(this.defaults());
            if (k === 'record' && this.settings.get('record') !== 'on') this._recClose();
            this.outputs.update(this.view, Date.now());
        });
    }

    defaults() {
        const s = this.settings, n = (k, d) => Number(s.get(k)) || d;
        return { living: n('defLiving', 20), urban: n('defUrban', 60), rural: n('defRural', 90), motorway: n('defMotorway', 110) };
    }

    async start() {
        // the power state: the one subscription kept while the car is off
        const sub = await Promise.resolve(this.signals.watch('de.bmw.infrastructure.VehicleCondition', '1', {
            VehicleCondition: (v) => this._condition(Car.conditionOf(v && v.statusConditionVehicle)),
        }, this.log)).catch((e) => ({ error: String(e) }));
        this.condSub = sub;
        if (this.demo) { this.log.info('demo drive (no car)'); this._setActive(true); return; }
        if (sub && sub.error) this.log.warn('power state not available (' + sub.error + '): running while the app runs');
        // no power state yet: start; the first value stops it again if the car is parked
        if (this.condition === undefined) this._setActive(true);
    }

    _condition(c) {
        if (c === undefined || c === this.condition) return;
        this.condition = c;
        this.log.info('power state ' + c + ' (' + (COND_NAMES[c] || '?') + ')');
        this._setActive(!!ACTIVE[c]);
    }

    _setActive(on) {
        if (on === this.active) return;
        this.active = on;
        if (on) {
            this.log.info('car on: matching');
            this.position.start().catch((e) => this.log.warn('position: ' + e));
            this.outputs.start();
            if (this.matcher) this.matcher.reset();
            this.timer = setInterval(() => this._tick(), TICK_MS);
        } else {
            this.log.info('car off: idle (subscriptions dropped, HUD and cluster given back)');
            clearInterval(this.timer); this.timer = null;
            this.position.stop().catch(() => {});
            this.outputs.stop();
            this.view = null; this.res = null; this.fix = null;
            this._recClose();
        }
        this._changed();
    }

    _tick() {
        const now = Date.now();
        this.position.poll(now);
        this.outputs.tick(now);
        const fix = this.fix = this.demo ? this.demo.fix(now) : this.position.fix(now);
        this.speed = this.demo ? this.demo.speedKmh(now) : this.position.speedKmh(now);
        if (this.matcher) {
            const res = this.res = this.matcher.update(fix, now);
            this.stats.ticks++; this.stats.msSum += res.ms; this.stats.msMax = Math.max(this.stats.msMax, res.ms);
        }
        this._decide(now);
        this.outputs.update(this.view, now);
        this._record(now, fix);
        this._changed();
    }

    _decide(now) {
        const r = this.res, s = this.settings;
        const thr = Number(s.get('overspeed')) || 0;
        const over = (lim) => thr > 0 && this.speed !== null && lim > 0 && this.speed > lim + thr;
        if (r && r.limit && !(r.inferred && s.get('untagged') === 'hide')) {
            this.view = { limit: r.limit, inferred: r.inferred, over: over(r.limit) };
            this.viewAt = now;
        } else if (this.view && now - this.viewAt < VIEW_HOLD_MS) {
            this.view = Object.assign({}, this.view, { over: over(this.view.limit) });
        } else this.view = null;
    }

    /* ---------- the drive log (setting "record"): one CSV per drive, for kit/tools/test_speed_limit.js --log ---------- */
    _record(now, fix) {
        if (this.settings.get('record') !== 'on') return;
        if (!this.rec) {
            const name = 'drive-' + new Date(now).toISOString().replace(/[:T]/g, '-').slice(0, 16) + '.csv';
            this.rec = { file: path.join(this.dataDir, name), buf: ['t,lat,lon,heading,speed,source,state,way,limit,inferred,dist'], at: now, bytes: 0 };
            this._recPrune();
        }
        const r = this.res || {};
        this.rec.buf.push([now, fix ? fix.lat.toFixed(7) : '', fix ? fix.lon.toFixed(7) : '', fix && fix.heading != null ? fix.heading.toFixed(1) : '',
            this.speed != null ? this.speed.toFixed(1) : '', fix ? fix.source : '', r.state || '', r.way || '', r.limit || '', r.inferred ? 1 : 0, r.dist != null ? r.dist.toFixed(1) : ''].join(','));
        if (now - this.rec.at >= 10000) this._recFlush(now);
    }

    _recFlush(now) {
        const R = this.rec;
        if (!R || !R.buf.length) return;
        const text = R.buf.join('\n') + '\n';
        R.buf = []; R.at = now || Date.now(); R.bytes += text.length;
        fs.appendFile(R.file, text, () => {});
        if (R.bytes > 4e6) this.rec = null;          // a new file after 4 MB
    }

    _recClose() { if (this.rec) { this._recFlush(); this.rec = null; } }

    _recPrune() {
        try {
            const old = fs.readdirSync(this.dataDir).filter((f) => /^drive-.*\.csv$/.test(f)).sort();
            old.slice(0, Math.max(0, old.length - 5)).forEach((f) => { try { fs.unlinkSync(path.join(this.dataDir, f)); } catch (e) { /* in use */ } });
        } catch (e) { /* no data dir */ }
    }

    onChange(fn) { this.listeners.push(fn); }
    _changed() { this.listeners.forEach((fn) => { try { fn(); } catch (e) { /* page */ } }); }
}

async function background(bg) {
    const engine = new Engine(bg);
    await engine.start();
    return engine;
}

/* ---------- the page ---------- */
function fmt(v, d) { return v == null || !isFinite(v) ? '-' : Number(v).toFixed(d == null ? 0 : d); }
function ago(ms) { return ms == null ? '-' : ms < 1000 ? 'now' : (ms / 1000).toFixed(0) + ' s ago'; }

function describe(engine) {
    const r = engine.res;
    if (!engine.pack) return { title: 'No map', sub: engine.packError };
    if (!engine.active) return { title: 'Car off', sub: 'Idle: nothing is read or shown until the car is switched on.' };
    if (!r) return { title: 'Starting', sub: '' };
    const road = r.cls >= 0 ? CLASS[r.cls].replace('_', ' ') + (r.flags & F.URBAN ? ', in a settlement' : '') + (r.flags & F.TUNNEL ? ', tunnel' : '') : '';
    switch (r.state) {
    case 'match': return { title: r.inferred ? 'Default for this road' : 'Signposted limit', sub: road + (r.inferred ? ': no limit on the map, the ' + (r.cls === 7 ? 'living street' : r.cls === 0 ? 'motorway' : r.flags & F.URBAN ? 'settlement' : 'outside settlements') + ' default' : '') };
    case 'hold': return { title: 'Holding the last limit', sub: road + ': no position for a moment' };
    case 'none': return { title: 'No road here', sub: 'No road on the map within 25 m in the direction of travel.' };
    case 'outside': return { title: 'Outside the map', sub: 'The map covers ' + (engine.pack.meta.region || 'one region') + ' only.' };
    default: return { title: 'Waiting for a position', sub: 'The car has not given a position yet.' };
    }
}

function drawNow(cv, t, engine) {
    const v = engine.view, d = describe(engine);
    const cx = 330, cy = 250, r = 150;
    if (v) paintSign(cv, cx, cy, r, v.limit, v);
    else { cv.circle(cx, cy, r, withAlpha('#ffffff', 0.06)); cv.arc(cx, cy, r * 0.8, r, 0, 360, withAlpha('#ffffff', 0.18)); cv.text('--', cx, cy + 40, 110, t.dim, { literal: true, font: 'bold', align: 'center' }); }
    const x = 620;
    cv.text(d.title, x, 170, 44, t.text, { font: 'bold' });
    if (d.sub) cv.text(d.sub, x, 222, 24, t.dim, { literal: true });
    const sp = engine.speed;
    cv.text('Speed', x, 300, 22, t.dim);
    cv.text(sp == null ? '-' : fmt(sp) + ' km/h', x, 345, 40, v && v.over ? '#ff4d4f' : t.text, { font: 'bold', literal: true });
    const f = engine.fix;
    cv.text('Position', x + 360, 300, 22, t.dim);
    cv.text(f ? ({ nav: 'Navigation', gnss: 'GPS', demo: 'Demo drive' }[f.source] || f.source) : 'none', x + 360, 345, 40, t.text, { font: 'bold', literal: true });
    const o = engine.outputs.diag(), s = engine.settings;
    const hud = s.get('hud') === 'off' ? 'off' : o.connected ? 'on' : 'waiting for cluster-render';
    const map = s.get('cluster') === 'off' ? 'off' : s.get('cluster') === 'always' ? 'always' : o.mapBusy ? 'with the phone map' : 'when the phone map shows';
    cv.text('HUD: ' + hud + '      Cluster: ' + map, x, 420, 22, t.dim, { literal: true });
    cv.text('Map data: ' + (engine.pack ? engine.pack.describe() + ', OpenStreetMap contributors (ODbL)' : '-'), x, 456, 18, t.dim, { literal: true });
}

function drawDetails(cv, t, engine) {
    const p = engine.position.diag(), r = engine.res || {}, f = engine.fix, o = engine.outputs.diag(), now = Date.now();
    const rows = [
        ['Power state', engine.condition === undefined ? 'not known' : engine.condition + ' (' + (COND_NAMES[engine.condition] || '?') + ')', engine.active ? 'active' : 'idle'],
        ['Navigation position', p.avail.nav ? 'available' : 'not available', p.counts.nav + ' ok, ' + p.counts.navInvalid + ' invalid' + (p.errors.nav ? ' - ' + p.errors.nav : '')],
        ['GPS (GPSData)', p.avail.gnss ? 'available' : 'not available', p.counts.gnss + ' ok, ' + p.counts.gnssInvalid + ' invalid, quality ' + (p.quality == null ? '-' : '0x' + p.quality.toString(16)) + (p.errors.gnss ? ' - ' + p.errors.gnss : '')],
        ['Speed', engine.speed == null ? '-' : fmt(engine.speed, 1) + ' km/h', p.counts.speed + ' values' + (p.errors.speed ? ' - ' + p.errors.speed : '')],
        ['Fix', f ? fmt(f.lat, 6) + ', ' + fmt(f.lon, 6) : '-', f ? f.source + ', ' + ago(f.age) + ', heading ' + fmt(engine.matcher && engine.matcher.heading) : ''],
        ['Road', r.state || '-', r.way ? 'way ' + r.way + ', ' + CLASS[r.cls] + ', ' + fmt(r.dist, 1) + ' m, ' + (r.dir > 0 ? 'along' : r.dir < 0 ? 'against' : 'either way') + (r.flags & F.ONEWAY ? ', one-way' : '') : ''],
        ['Limit', r.limit ? r.limit + ' km/h' : '-', r.limit ? (r.inferred ? 'default' + (r.variable ? ' (variable signs)' : '') : 'tagged') + ', ' + (r.candidates || 0) + ' candidates' : ''],
        ['Matching', engine.stats.ticks + ' updates', 'avg ' + fmt(engine.stats.msSum / Math.max(1, engine.stats.ticks), 2) + ' ms, max ' + fmt(engine.stats.msMax, 2) + ' ms'],
        ['cluster-render', o.connected ? 'connected' : o.unsupported || 'not connected', 'HUD ' + o.hud + ', map ' + o.map + (o.mapBusy ? ' (shown by ' + o.mapBusyBy + ')' : '') + (o.refused ? ', refused ' + o.refused : '')],
    ];
    const x0 = 60, x1 = 400, x2 = 760;
    let y = 120;
    rows.forEach((row, i) => {
        if (i % 2 === 0) cv.fillRect(x0 - 20, y - 30, W - 2 * (x0 - 20), 42, withAlpha('#ffffff', 0.035));
        cv.text(row[0], x0, y, 22, t.dim, { literal: true });
        cv.text(String(row[1]), x1, y, 22, t.text, { literal: true, font: 'bold' });
        cv.text(String(row[2] || ''), x2, y, 20, t.dim, { literal: true });
        y += 42;
    });
    const raw = p.raw;
    const line = 'raw: nav ' + JSON.stringify(raw.nav || null) + '   gps ' + JSON.stringify(raw.gnss || null) + ' ' + JSON.stringify(raw.gnssExt || null);
    cv.text(line.length > 170 ? line.slice(0, 167) + '...' : line, x0, y + 10, 16, t.dim, { literal: true });
}

mgu.run({
    background,
    async start(ctx) {
        const { ui } = ctx;
        const engine = ctx.background || await background(ctx);
        const PAGES = ['Now', 'Details'];
        let page = 0;
        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            if (page === 0) drawNow(cv, t, engine); else drawDetails(cv, t, engine);
            G.frame(cv, t, PAGES, page);
            await ui.image('MAIN_GFX', cv);
        }
        ctx.onTab((i) => { page = i; return render(); });
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; return render(); });
        ctx.loop('MAIN', 4, render, { maxFps: 4 });
        if (ctx.onLayout) ctx.onLayout(() => { render().catch(() => {}); });
        await render();
    },
});
