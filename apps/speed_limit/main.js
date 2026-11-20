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
 * subscribed, so it wakes with the car. Switched off on its page, it idles the same way whatever the car does.
 *
 * The app's page is the HMI's own list (no GPU renderer), as Maps on cluster's: what it shows now, where the
 * position comes from and where the sign goes, the map's date, and the one switch. The rest of the settings (sign
 * sizes and places, the over-the-limit colour, the defaults for roads without a limit) are kept hidden with their
 * defaults (app.json "hidden").
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const Car = require('./kit/car');
const { LimitPack, F, CLASS } = require('./limitpack');
const { Matcher } = require('./matcher');
const { Position, DemoDrive } = require('./position');
const { Outputs } = require('./outputs');

const APP_ID = 'speed_limit';
const TICK_MS = 500;
const VIEW_HOLD_MS = 8000;
const ACTIVE = { 7: true, 8: true, 10: true, 12: true };
const COND_NAMES = { 1: 'parked (bus off)', 2: 'parked', 3: 'stand-by', 5: 'parked, living', 7: 'ignition on', 8: 'starting', 10: 'drive-ready', 12: 'switching off' };

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
        this.carOn = undefined;     // from the power state; undefined: not known (then it runs)
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
            if (k === 'enabled') this._evaluate();
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
        if (this.demo) { this.log.info('demo drive (no car)'); this.carOn = true; }
        else if (sub && sub.error) this.log.warn('power state not available (' + sub.error + '): running while the app runs');
        // no power state yet: start; the first value stops it again if the car is parked
        this._evaluate();
    }

    enabled() { return this.settings.get('enabled') !== false; }

    /** Run while switched on and the car is on (or its state is not known). */
    _evaluate() { this._setActive(this.enabled() && this.carOn !== false); }

    _condition(c) {
        if (c === undefined || c === this.condition) return;
        this.condition = c;
        this.log.info('power state ' + c + ' (' + (COND_NAMES[c] || '?') + ')');
        if (!this.demo) this.carOn = !!ACTIVE[c];
        this._evaluate();
    }

    _setActive(on) {
        if (on === this.active) return;
        this.active = on;
        if (on) {
            this.log.info('on: matching');
            this.position.start().catch((e) => this.log.warn('position: ' + e));
            this.outputs.start();
            if (this.matcher) this.matcher.reset();
            this.timer = setInterval(() => this._tick(), TICK_MS);
        } else {
            this.log.info((this.enabled() ? 'car off' : 'switched off') + ': idle (subscriptions dropped, HUD and cluster given back)');
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

/* ---------- the page: the HMI's own list (app.json screen "menu") ---------- */
// (ASCII: the HMI's list rows take the app's strings; the kit's fonts are not used here)
function nowText(engine) {
    const r = engine.res, v = engine.view;
    if (!engine.pack) return 'No map: ' + engine.packError;
    if (!engine.enabled()) return 'Off';
    if (!engine.active) return 'Car off: nothing is read or shown';
    if (v) {
        const road = r && r.cls >= 0 ? ', ' + CLASS[r.cls].replace('_', ' ') + (r.flags & F.URBAN ? ' in a settlement' : '') : '';
        return 'Now: ' + v.limit + ' km/h' + (v.inferred ? ' (default, no limit on the map)' : '') + road;
    }
    if (!r || r.state === 'nofix') return 'Waiting for a position';
    if (r.state === 'outside') return 'Outside the map (' + (engine.pack.meta.region || '') + ')';
    return 'No road here';
}

function whereText(engine) {
    if (!engine.enabled() || !engine.active) return '';
    const f = engine.fix, o = engine.outputs.diag(), s = engine.settings;
    const src = f ? ({ nav: 'navigation', gnss: 'GPS', demo: 'demo drive' }[f.source] || f.source) : 'none';
    let out;
    if (!o.connected) out = 'cluster-render not running (install Maps on cluster)';
    else {
        const parts = [];
        if (s.get('hud') !== 'off') parts.push('HUD');
        if (s.get('cluster') === 'always' || (s.get('cluster') === 'map' && o.mapBusy)) parts.push('cluster');
        else if (s.get('cluster') === 'map') parts.push('cluster with the phone map');
        out = parts.join(', ') || 'nowhere';
    }
    return 'Position: ' + src + '. Shown on: ' + out;
}

function mapText(engine) {
    const m = engine.pack && engine.pack.meta;
    return m ? 'Map: ' + (m.region || '') + ', OpenStreetMap ' + (m.data || '') + ' (c) OpenStreetMap contributors, ODbL' : '';
}

mgu.run({
    background,
    async start(ctx) {
        const { ui } = ctx;
        const engine = ctx.background || await background(ctx);
        const last = {};
        const put = (name, text) => {
            if (last[name] === text) return null;
            last[name] = text;
            return ui.text(name, text);
        };
        let pending = null;
        const refresh = () => {
            if (pending) return;
            // at most once a second, and only while the page is open
            pending = setTimeout(() => {
                pending = null;
                if (!ui.isVisible('MAIN')) return;
                Promise.all([put('SL_NOW', nowText(engine)), put('SL_WHERE', whereText(engine)), put('SL_MAP', mapText(engine))]).catch(() => {});
            }, 1000);
        };
        engine.onChange(refresh);
        ui.onVisible((name, v) => { if (name === 'MAIN' && v) { Object.keys(last).forEach((k) => delete last[k]); refresh(); } });
        await Promise.all([put('SL_NOW', nowText(engine)), put('SL_WHERE', whereText(engine)), put('SL_MAP', mapText(engine))]);
    },
});
