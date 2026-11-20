'use strict';
/**
 * Speed Limit - the speed limit of the road the car is on, on the cluster's map and the head-up display, from an
 * offline OpenStreetMap pack (georgia.pack, kit/tools/pack_sli.py). Read only: it subscribes to the car's position,
 * speed and power state and writes nothing to any unit.
 *
 * Starts with the car (app.json "autostart": background() runs without screens). It works only while it is shown
 * somewhere (setting "Show on": Cluster, HUD, or both) and the car is on (power state 7 ignition, 8 starting,
 * 10 drive-ready, 12 ending): then it matches the position to a road twice a second (every 2 s, without matching
 * again, while standing still) and
 * shows the limit. Otherwise it idles: the position and speed subscriptions are dropped, the map file is closed,
 * the cluster-render connection goes (the HUD and the cluster are given back) and no timer runs; only the power
 * state stays subscribed, so it wakes with the car.
 *
 * The app's page is the HMI's own list (no GPU renderer), laid out as Maps on cluster's (below). Its settings are
 * app.json "hidden" ones: the page itself shows and changes them.
 */
const path = require('path');
const mgu = require('./kit/mgu');
const Car = require('./kit/car');
const { LimitPack } = require('./limitpack');
const { Matcher } = require('./matcher');
const { Position, DemoDrive } = require('./position');
const { Outputs, TARGETS } = require('./outputs');

const APP_ID = 'speed_limit';
const PACK = path.join(__dirname, 'georgia.pack');
const TICK_MS = 500;            // driving: twice a second
const STILL_MS = 2000;          // standing still (a light, a jam): every 2 s
const BOOT_WAIT_MS = 5000;      // at start-up, the time the power state has to arrive before the app runs without it
const VIEW_HOLD_MS = 8000;
const ACTIVE = { 7: true, 8: true, 10: true, 12: true };

/* ---------- the engine: runs with or without the app's screens ---------- */
class Engine {
    constructor(bg) {
        this.log = bg.log;
        this.settings = bg.settings;
        this.signals = bg.signals;
        this.pack = null;               // open only while active
        this.matcher = null;
        this.meta = null;               // the map's META (its date, for the page), read once
        this.packError = '';
        try { const p = LimitPack.open(PACK); this.meta = p.meta; this.log.info('map: ' + p.describe()); p.close(); } catch (e) { this.packError = String(e.message || e); this.log.error('map: ' + this.packError); }
        this.position = new Position(this.signals, this.log);
        this.outputs = new Outputs(APP_ID, this.log, this.settings);
        this.demoOn = this.settings.get('demo') === 'on';   // the PC's emulator and preview; never set in a car
        this.demo = null;
        this.condition = undefined;
        this.carOn = undefined;         // from the power state; undefined: not known (then it runs)
        this.active = false;
        this.timer = null;
        this.bootTimer = null;
        this.res = null;
        this.view = null;
        this.viewAt = 0;
        this.speed = null;
        this.fix = null;
        this.listeners = [];
        this.settings.onChange((k) => {
            if (k === 'show') this._evaluate();
            if (/^def/.test(k) && this.matcher) this.matcher.setDefaults(this.defaults());
            if (this.active) this.outputs.update(this.view, Date.now());
            this._changed();
        });
    }

    defaults() {
        const s = this.settings, n = (k, d) => Number(s.get(k)) || d;
        return { living: n('defLiving', 20), urban: n('defUrban', 60), rural: n('defRural', 90), motorway: n('defMotorway', 110) };
    }

    async start() {
        // the power state: the one subscription kept while idle
        const sub = await Promise.resolve(this.signals.watch('de.bmw.infrastructure.VehicleCondition', '1', {
            VehicleCondition: (v) => this._condition(Car.conditionOf(v && v.statusConditionVehicle)),
        }, this.log)).catch((e) => ({ error: String(e) }));
        if (this.demoOn) { this.log.info('demo drive (no car)'); this.carOn = true; } else if (sub && sub.error) this.log.warn('power state not available (' + sub.error + '): running while the app runs');
        else if (this.condition === undefined) {
            // the head unit starting up: wait for the power state before running (a parked car's start-up then never
            // opens the map or subscribes to anything); without one after BOOT_WAIT_MS, run while the app runs
            this.bootTimer = setTimeout(() => { this.bootTimer = null; this._evaluate(); }, BOOT_WAIT_MS);
            return;
        }
        this._evaluate();
    }

    enabled() { return this.settings.get('show') !== 'off'; }

    /** Run while shown somewhere and the car is on (or its state is not known). */
    _evaluate() { if (!this.bootTimer) this._setActive(this.enabled() && this.carOn !== false && !this.packError); }

    _condition(c) {
        if (c === undefined || c === this.condition) return;
        this.condition = c;
        if (this.bootTimer) { clearTimeout(this.bootTimer); this.bootTimer = null; }
        if (!this.demoOn) this.carOn = !!ACTIVE[c];
        this._evaluate();
    }

    _setActive(on) {
        if (on === this.active) return;
        this.active = on;
        if (on) {
            this.log.info('on: matching');
            try {
                this.pack = LimitPack.open(PACK);
                this.matcher = new Matcher(this.pack, { defaults: this.defaults() });
                if (this.demoOn) this.demo = new DemoDrive(this.pack, { way: this.settings.get('demoWay'), speed: this.settings.get('demoSpeed') });
            } catch (e) { this.packError = String(e.message || e); this.log.error('map: ' + this.packError); this.active = false; return; }
            if (!this.demoOn) this.position.start().catch((e) => this.log.warn('position: ' + e));
            this.outputs.start();
            this._schedule(0);
        } else {
            this.log.info((this.enabled() ? 'car off' : 'switched off') + ': idle (subscriptions dropped, map closed, HUD and cluster given back)');
            clearTimeout(this.timer); this.timer = null;
            this.position.stop().catch(() => {});
            this.outputs.stop();
            if (this.pack) this.pack.close();
            this.pack = null; this.matcher = null; this.demo = null;
            this.view = null; this.res = null; this.fix = null; this.speed = null;
        }
        this._changed();
    }

    /** The next tick: twice a second while driving, every 2 s while standing still; none while idle. */
    _schedule(ms) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; if (this.active) { this._tick(); if (this.active) this._schedule(this._still() ? STILL_MS : TICK_MS); } }, ms);
    }

    /** Standing still on a matched road: nothing to match again (the position only wanders). */
    _still() { return this.speed !== null && this.speed < 2 && !!this.fix && !!this.res && this.res.state === 'match'; }

    _tick() {
        const now = Date.now();
        if (!this.demo) { this.position.poll(now); this.outputs.tick(now); } else this.outputs.tick(now);
        this.fix = this.demo ? this.demo.fix(now) : this.position.fix(now);
        this.speed = this.demo ? this.demo.speedKmh(now) : this.position.speedKmh(now);
        if (!this._still()) this.res = this.matcher.update(this.fix, now);
        this._decide(now);
        this.outputs.update(this.view, now);
        this._changed();
    }

    _decide(now) {
        const r = this.res, s = this.settings;
        const thr = Number(s.get('overspeed')) || 0;
        // over from limit + threshold, back under 2 km/h below it: a speed right at it does not flip the sign (and
        // send its pixels) again and again
        const wasOver = !!(this.view && this.view.over);
        const over = (lim) => thr > 0 && this.speed !== null && lim > 0 && this.speed > lim + thr - (wasOver ? 2 : 0);
        if (r && r.limit && !(r.inferred && s.get('untagged') === 'hide')) {
            this.view = { limit: r.limit, inferred: r.inferred, over: over(r.limit) };
            this.viewAt = now;
        } else if (this.view && this.view.limit && now - this.viewAt < VIEW_HOLD_MS) {
            this.view = { limit: this.view.limit, inferred: this.view.inferred, over: over(this.view.limit) };
        } else if (s.get('noLimit') === 'dashes') {
            this.view = { limit: null, unknown: true, inferred: false, over: false };     // "---", as BMW's own
        } else this.view = null;
    }

    onChange(fn) { this.listeners.push(fn); }
    _changed() { for (let i = 0; i < this.listeners.length; i++) this.listeners[i](); }
}

async function background(bg) {
    const engine = new Engine(bg);
    await engine.start();
    return engine;
}

/* ---------- the page: the HMI's own list, laid out as Maps on cluster's (app.json screen "menu") ----------
 * General: Show on (Cluster, HUD, Cluster and HUD, Off), Red sign over the limit, When there's no limit (nothing, or
 * "---" as BMW's own), Speed limit.
 * Cluster (on the phone map, Maps on cluster's): Cluster sign, Size (a slider), Position with Move left / right / up /
 * down and Default position.
 * HUD: HUD sign, Keep HUD sign over BMW's pop-ups, Size, Position, the moves and Default position.
 * A section's controls are greyed while Show on leaves its display out. Map: the data's date and licence. Info rows
 * read "Name: Value"; a row is written only when it changes, and only while the page shows. ASCII only. */
const SHOW = ['cluster', 'hud', 'both', 'off'];
const OVER = ['0', '5', '10', '15', '20'];
const NOLIMIT = ['nothing', 'dashes'];
// the slider's sizes (positions 0..10) and the move step on each target
const SIZES = {
    hud: [64, 72, 80, 88, 96, 104, 112, 120, 128, 136, 144],
    map: [70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180],
};
const STEP = { hud: 10, map: 20 };
/** A section's place: the HUD's, or the cluster's (the phone map). */
function placeOf(k) {
    const target = k === 'hud' ? 'hud' : 'map', T = TARGETS[target];
    return { target, show: k, size: T.size, x: T.x, y: T.y, def: T.def, sizes: SIZES[target], step: STEP[target], row: k === 'hud' ? 'SL_HUD' : 'SL_CL' };
}

function limitText(e) {
    const r = e.res, v = e.view;
    if (e.packError) return 'Speed limit: no map';
    if (!e.active) return 'Speed limit: ' + (e.enabled() ? 'car off' : 'off');
    if (v && v.limit) return 'Speed limit: ' + v.limit + ' km/h' + (v.inferred ? ' (default for this road)' : '');
    if (!r || r.state === 'nofix') return 'Speed limit: waiting for a position';
    if (r.state === 'outside') return 'Speed limit: outside the map';
    return 'Speed limit: no road here';
}

function signState(e, t) {
    const show = e.settings.get('show'), o = e.outputs.diag();
    if (show !== t && show !== 'both') return 'Off';
    if (!e.active) return e.enabled() ? 'Car off' : 'Off';
    if (!o.connected) return 'Unavailable (no cluster-render)';
    if (t === 'cluster' && !o.mapBusy) return 'Waiting for the phone map';
    if (!e.view) return 'No limit to show';
    const st = o[t === 'cluster' ? 'cluster' : 'hud'];
    return /^shown/.test(st) ? 'Shown' : /^waiting|^parked/.test(st) ? 'Waiting (' + st + ')' : 'Waiting';
}

/** How far a sign may move from its default place and stay on its display (outputs.js TARGETS). */
function room(P, s) {
    const T = TARGETS[P.target], z = Number(s.get(P.size)) || P.def;
    return { x0: z / 2 - T.cx, x1: T.w - T.cx - z / 2, y0: z / 2 - T.cy, y1: T.h - T.cy - z / 2 };
}

function posText(x, y) {
    if (!x && !y) return 'Position: Default';
    const h = x > 0 ? x + ' px right' : x < 0 ? -x + ' px left' : '', v = y > 0 ? y + ' px down' : y < 0 ? -y + ' px up' : '';
    return 'Position: ' + (h && v ? h + ', ' + v : h || v);
}

function mapText(e) {
    return e.meta ? 'Map: OpenStreetMap ' + (e.meta.data || '') + ', (c) OpenStreetMap contributors, ODbL' : 'Map: -';
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings: s } = ctx;
        const engine = ctx.background || await background(ctx);
        const done = {};
        const once = (key, value, fn) => { if (done[key] === value) return; done[key] = value; Promise.resolve().then(fn).catch(() => {}); };
        const on = (P) => s.get('show') === P.show || s.get('show') === 'both';
        const sliders = { hud: ui.comp('SL_HUD_SIZE'), cluster: ui.comp('SL_CL_SIZE') };

        /** A display's section: its status row, size slider, position row and buttons (greyed while it is not chosen). */
        function renderPlace(k) {
            const P = placeOf(k), R = P.row, slider = sliders[k], live = on(P);
            const x = Number(s.get(P.x)) || 0, y = Number(s.get(P.y)) || 0;
            // the slider at the size nearest the setting; its text says the size itself (keyed by the place too: two
            // places can share a slider position with different sizes)
            const size = Number(s.get(P.size)) || P.def;
            let step = 0;
            P.sizes.forEach((v, i) => { if (Math.abs(v - size) < Math.abs(P.sizes[step] - size)) step = i; });
            const st = (k === 'hud' ? 'HUD' : 'Cluster') + ' sign: ' + signState(engine, k);
            once(R, st, () => ui.text(R, st));
            once(R + ':sizeText', P.target + ':' + size, () => ui.cells(R + '_SIZE', 0, { TextDescription: 'Size: ' + size + ' px' }));
            once(R + ':sizeStep', step, () => (slider && slider.setStepValue ? slider.setStepValue(step) : ui.cells(R + '_SIZE', 0, { Value: step })));
            once(R + ':pos', P.target + ':' + x + ',' + y, () => ui.text(R + '_POS', posText(x, y)));
            ['_SIZE', '_LEFT', '_RIGHT', '_UP', '_DOWN'].concat(k === 'hud' ? ['_KEEP'] : []).forEach((n) => once('en:' + R + n, live, () => ui.enabled(R + n, live)));
            const back = live && (x !== 0 || y !== 0);
            once('en:' + R + '_DEFAULT', back, () => ui.enabled(R + '_DEFAULT', back));
        }

        function render() {
            if (!ui.isVisible('MAIN')) return;
            const show = Math.max(0, SHOW.indexOf(s.get('show'))), over = Math.max(0, OVER.indexOf(String(s.get('overspeed'))));
            const nolim = Math.max(0, NOLIMIT.indexOf(s.get('noLimit')));
            const lim = limitText(engine);
            once('show', show, () => ui.selected('SL_SHOW', show));
            once('over', over, () => ui.selected('SL_OVER', over));
            once('nolim', nolim, () => ui.selected('SL_NOLIMIT', nolim));
            once('limit', lim, () => ui.text('SL_LIMIT', lim));
            once('keep', !!s.get('hudKeep'), () => ui.checked('SL_HUD_KEEP', !!s.get('hudKeep')));
            once('map', mapText(engine), () => ui.text('SL_MAP', mapText(engine)));
            renderPlace('cluster');
            renderPlace('hud');
        }

        // the HMI moves a drop-down's choice and the slider itself: only the setting follows
        ui.onClick('SL_SHOW', (ev) => { const v = SHOW[ev.row]; if (v) { done.show = ev.row; s.set('show', v); } });
        ui.onClick('SL_OVER', (ev) => { const v = OVER[ev.row]; if (v != null) { done.over = ev.row; s.set('overspeed', v); } });
        ui.onClick('SL_NOLIMIT', (ev) => { const v = NOLIMIT[ev.row]; if (v) { done.nolim = ev.row; s.set('noLimit', v); } });
        ui.onClick('SL_HUD_KEEP', () => { if (on(placeOf('hud'))) s.set('hudKeep', !s.get('hudKeep')); });
        ['hud', 'cluster'].forEach((k) => {
            const R = k === 'hud' ? 'SL_HUD' : 'SL_CL', slider = sliders[k];
            if (slider && slider.on) slider.on('changed', (step) => { const P = placeOf(k), v = P.sizes[step]; if (v && on(P)) { done[R + ':sizeStep'] = step; s.set(P.size, v); } });
            const move = (dx, dy) => () => {
                const P = placeOf(k);
                if (!on(P)) return;
                const B = room(P, s), x = Number(s.get(P.x)) || 0, y = Number(s.get(P.y)) || 0;
                const nx = Math.round(Math.max(B.x0, Math.min(B.x1, x + dx * P.step))), ny = Math.round(Math.max(B.y0, Math.min(B.y1, y + dy * P.step)));
                if (nx !== x) s.set(P.x, nx);
                if (ny !== y) s.set(P.y, ny);
            };
            ui.onClick(R + '_LEFT', move(-1, 0));
            ui.onClick(R + '_RIGHT', move(1, 0));
            ui.onClick(R + '_UP', move(0, -1));
            ui.onClick(R + '_DOWN', move(0, 1));
            ui.onClick(R + '_DEFAULT', () => { const P = placeOf(k); if (s.get(P.x)) s.set(P.x, 0); if (s.get(P.y)) s.set(P.y, 0); });
        });
        s.onChange(render);
        // the status rows: at most once a second, and only while the page is open
        let timer = null;
        engine.onChange(() => {
            if (timer || !ui.isVisible('MAIN')) return;
            timer = setTimeout(() => { timer = null; render(); }, 1000);
        });
        ui.onVisible((name, v) => { if (name === 'MAIN' && v) { Object.keys(done).forEach((k) => delete done[k]); render(); } });
        render();
    },
});
