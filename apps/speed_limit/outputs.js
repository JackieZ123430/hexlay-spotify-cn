'use strict';
/**
 * outputs.js - the sign on the head-up display and on the instrument cluster, through cluster-render. Node 8.
 *
 *   const out = new Outputs('speed_limit', log, settings).start();
 *   out.update({ limit, inferred, over } | { limit: null, unknown: true } | null, now);   out.tick(now);   out.stop()
 *
 * Setting "show": cluster | hud | both | off (as Maps on cluster's Show on).
 * Cluster: the map target (1088 x 480, the centre under the dials), only while another app (Maps on cluster) shows
 * its picture there: cluster-render's status lists every client's layers ("layer 3 video of <app> on map, content
 * z 0: shown"); asked every 3 s while the sign is on the map, else every 10 s and at once on a map target event. The
 * sign never makes the map target wanted by itself (never takes the centre from the stock map). (Not the panel
 * target, beside the speed: it is the slot BMW's own trip and board computer content uses, one content at a time,
 * so the sign there hid it.)
 * A view with camera: '350 m' (a speed camera ahead) adds the camera pill to the sign's right (sign.js).
 * HUD (800 x 480): beside BMW's own speed (transparent pixels are see-through); it gives way to BMW's pop-ups on the
 * HUD (yield 1), unless setting "hudKeep" keeps it over them (yield 0).
 * Each place has its size and offset settings: hudSize/X/Y, clusterSize/X/Y (the map). A view
 * { limit: null, unknown: true } shows the "---" sign (setting "noLimit"). A layer with nothing to show is hidden
 * (visible 0): the display is given back after cluster-render's linger (3 s). stop() drops the layers and closes the
 * connection: cluster-render releases the surfaces at once.
 */
const { ClusterRender } = require('./crclient');
const { drawSign, signWidth } = require('./sign');

const TARGETS = {
    hud: { w: 800, h: 480, cx: 175, cy: 290, size: 'hudSize', x: 'hudX', y: 'hudY', def: 88 },
    // the bottom of the phone map, left of the car's arrow (bottom centre): the area narrows towards the bottom
    // between the dials, and its corners sit behind them
    map: { w: 1088, h: 480, cx: 400, cy: 405, size: 'clusterSize', x: 'clusterX', y: 'clusterY', def: 110, pillLeft: true },
};
const LAYER_RX = /^layer \d+ (\S+) of (.+) on (\w+), (\w+) z -?\d+[^:]*: (\w+)/;
const STATUS_MS = 3000;          // while the sign is on the cluster's map: notice soon that the phone map went
const STATUS_IDLE_MS = 10000;    // otherwise (a map target event asks at once)

class Outputs {
    /** opts.cr: options for the cluster-render client ({ path, check }: tests) */
    constructor(appId, log, settings, opts) {
        this.appId = appId;
        this.crOpts = (opts && opts.cr) || undefined;
        this.log = log || { info() {}, warn() {} };
        this.settings = settings;
        this.cr = null;
        this.layers = {};           // hud | map -> { ref, size, x, y, key, visible, yld }
        this.mapBusy = false;       // another app shows a picture on the map target
        this.mapBusyBy = '';
        this.lastStatus = 0;
        this.statusAt = 0;
        this.targets = {};          // target -> { state, holder, reason }
        this.layerStates = {};      // ref -> state
        this.view = null;
        this.refused = '';
    }

    start() {
        if (this.cr) return this;
        const cr = this.cr = new ClusterRender(this.appId, this.log, this.crOpts).start();
        cr.on('ready', () => { this.layers = {}; this._apply(Date.now()); });
        cr.on('down', () => { this.layers = {}; });
        cr.on('status', (text) => this._status(text));
        cr.on('target', (m) => {
            const was = this.targets[m.target];
            this.targets[m.target] = { state: m.state, holder: m.holder || '', reason: m.reason || '' };
            if (m.target === 'map' && (!was || was.state !== m.state)) this.lastStatus = 0;     // the map changed: ask now
        });
        cr.on('layer', (m) => { this.layerStates[m.ref] = m.state + (m.reason ? ' (' + m.reason + ')' : ''); });
        cr.on('refused', (m) => { this.refused = (m.op || '') + ': ' + (m.reason || ''); this.log.warn('cluster-render refused ' + this.refused); });
        return this;
    }

    stop() {
        if (!this.cr) return;
        const cr = this.cr;
        this.cr = null;
        Object.keys(this.layers).forEach((k) => { try { cr.drop(this.layers[k].ref); } catch (e) { /* gone */ } });
        this.layers = {};
        this.mapBusy = false;
        try { cr.close(); } catch (e) { /* gone */ }
    }

    /** Where the picture goes: the sign centred on its place, a camera pill (width W) running on to its right, or on
     * the phone map to its left (clear of the car's arrow, TARGETS pillLeft). */
    _where(t, camera) {
        const s = this.settings, T = TARGETS[t];
        const size = Number(s.get(T.size)) || T.def, W = signWidth(size, camera);
        const dx = Number(s.get(T.x)) || 0, dy = Number(s.get(T.y)) || 0;
        const left = T.pillLeft ? W - size : 0;
        const x = Math.max(0, Math.min(T.w - W, Math.round(T.cx + dx - size / 2 - left)));
        const y = Math.max(0, Math.min(T.h - size, Math.round(T.cy + dy - size / 2)));
        return { size, W, x, y };
    }

    _wanted(t) {
        const show = this.settings.get('show');
        if (t === 'hud') return show === 'hud' || show === 'both';
        return (show === 'cluster' || show === 'both') && this.mapBusy;
    }

    /** Show this (or nothing). */
    update(view, now) {
        this.view = view;
        this._apply(now || Date.now());
    }

    _apply() {
        const cr = this.cr;
        if (!cr || !cr.ready) return;
        ['hud', 'map'].forEach((t) => {
            let L = this.layers[t];
            const show = !!(this.view && (this.view.limit || this.view.unknown) && this._wanted(t));
            if (!show) {
                if (L && L.visible) { cr.set(L.ref, { visible: 0 }); L.visible = false; }
                return;
            }
            const cam = this.view.camera || '', w = this._where(t, cam);
            // the pixels only when the picture changes (limit, size, default, over, the camera's distance step): not
            // on every tick
            const key = [this.view.limit, w.size, !!this.view.inferred, !!this.view.over, cam].join(':');
            const sign = L && L.size === w.size && L.W === w.W && L.key === key ? null
                : drawSign(this.view.limit, { size: w.size, inferred: this.view.inferred, over: this.view.over, camera: cam, pillLeft: !!TARGETS[t].pillLeft });
            if (L && (L.size !== w.size || L.W !== w.W)) { cr.drop(L.ref); L = null; }      // (a camera came or went)
            const yld = t === 'hud' && this.settings.get('hudKeep') ? 0 : 1;
            if (!L) {
                const ref = cr.image({ target: t, class: 'overlay', z: 20, x: w.x, y: w.y, w: w.W, h: w.size, iw: w.W, ih: w.size, fps: 4, visible: 1, yield: yld });
                L = this.layers[t] = { ref, size: w.size, W: w.W, x: w.x, y: w.y, key: '', visible: true, yld };
            } else {
                if (L.x !== w.x || L.y !== w.y) { cr.set(L.ref, { x: w.x, y: w.y }); L.x = w.x; L.y = w.y; }
                if (L.yld !== yld) { cr.set(L.ref, { yield: yld }); L.yld = yld; }
                if (!L.visible) { cr.set(L.ref, { visible: 1 }); L.visible = true; }
            }
            if (sign && L.key !== sign.key) { cr.pixels(L.ref, sign.px); L.key = sign.key; }
        });
    }

    /** Now and then: ask cluster-render who draws on the map target (only while there is a limit to show, or the sign
     * is on the map: nothing to ask otherwise). */
    tick(now) {
        if (!this.view && !this.mapBusy) return;
        const cr = this.cr;
        const show = this.settings.get('show');
        if (!cr || !cr.ready || (show !== 'cluster' && show !== 'both')) return;
        if (now - this.lastStatus < (this.mapBusy ? STATUS_MS : STATUS_IDLE_MS)) return;
        this.lastStatus = now;
        cr.status();
        // no answer for two rounds: assume the map is not shown (never hold the cluster's centre on a guess)
        if (this.mapBusy && now - this.statusAt > 2 * STATUS_MS + 1000) { this.mapBusy = false; this._apply(now); }
    }

    _status(text) {
        this.statusAt = Date.now();
        let busy = false, by = '';
        String(text || '').split('\n').forEach((line) => {
            const m = LAYER_RX.exec(line.trim());
            if (!m || m[2] === this.appId || m[3] !== 'map') return;
            if (m[5] === 'shown' && m[1] !== 'effect' && m[1] !== 'mesh') { busy = true; by = m[2]; }
        });
        if (busy !== this.mapBusy) this.log.info('cluster map ' + (busy ? 'shown by ' + by : 'not shown') + ': the sign ' + (busy ? 'joins it' : 'leaves it'));
        this.mapBusy = busy;
        this.mapBusyBy = by;
        this._apply(Date.now());
    }

    diag() {
        const cr = this.cr, L = this.layers;
        const st = (t) => (L[t] ? (L[t].visible ? this.layerStates[L[t].ref] || 'sent' : 'hidden') : 'none');
        return {
            connected: !!(cr && cr.ready), unsupported: cr ? cr.unsupported : '', targetsOffered: cr ? cr.targets : '',
            hud: st('hud'), map: st('map'), cluster: st('map'), mapBusy: this.mapBusy, mapBusyBy: this.mapBusyBy, targets: this.targets, refused: this.refused,
        };
    }
}

module.exports = { Outputs, LAYER_RX, TARGETS };
