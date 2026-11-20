'use strict';
/**
 * outputs.js - the sign on the head-up display and on the cluster's map, through cluster-render. Node 8.
 *
 *   const out = new Outputs('speed_limit', log, settings).start();
 *   out.update({ limit, inferred, over } | null, now);   out.tick(now);   out.stop();   out.diag()
 *
 * HUD (800 x 480): an image layer, class overlay, where the settings put it (BMW's own speed stays in its slot below;
 * transparent pixels are see-through). It gives way to the stock HUD lists like every layer (yield 1).
 * Cluster map (1088 x 480, under the gauges): settings "cluster"
 *   map      only while another app (Maps on cluster) is showing its picture on the map target: cluster-render's
 *            status lists every client's layers ("layer 3 video of <app> on map, content z 0: shown"); asked for
 *            every 3 s while the car is on. This app never makes the map target wanted by itself in this mode, so
 *            it never takes the cluster's centre from the stock map.
 *   always   the sign makes the target wanted (the cluster's centre then shows it whenever there is a limit)
 *   off
 * A layer without a limit to show is hidden (visible 0); the HUD is given back after cluster-render's linger (3 s).
 * stop() drops the layers and closes the connection: cluster-render releases the surfaces at once.
 */
const { ClusterRender } = require('./crclient');
const { drawSign } = require('./sign');

const TARGETS = {
    hud: { w: 800, h: 480, cx: 175, cy: 290 },
    map: { w: 1088, h: 480, cx: 80, cy: 80 },
};
const LAYER_RX = /^layer \d+ (\S+) of (.+) on (\w+), (\w+) z -?\d+[^:]*: (\w+)/;
const STATUS_MS = 3000;

class Outputs {
    /** opts.cr: options for the cluster-render client ({ path, check }: tests) */
    constructor(appId, log, settings, opts) {
        this.appId = appId;
        this.crOpts = (opts && opts.cr) || undefined;
        this.log = log || { info() {}, warn() {} };
        this.settings = settings;
        this.cr = null;
        this.layers = {};           // hud | map -> { ref, size, x, y, key, visible }
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
        cr.on('target', (m) => { this.targets[m.target] = { state: m.state, holder: m.holder || '', reason: m.reason || '' }; });
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

    _where(t) {
        const s = this.settings, T = TARGETS[t];
        const size = Number(s.get(t === 'hud' ? 'hudSize' : 'clusterSize')) || (t === 'hud' ? 88 : 110);
        const dx = Number(s.get(t === 'hud' ? 'hudX' : 'clusterX')) || 0, dy = Number(s.get(t === 'hud' ? 'hudY' : 'clusterY')) || 0;
        const x = Math.max(0, Math.min(T.w - size, Math.round(T.cx + dx - size / 2)));
        const y = Math.max(0, Math.min(T.h - size, Math.round(T.cy + dy - size / 2)));
        return { size, x, y };
    }

    _wanted(t) {
        const s = this.settings;
        if (t === 'hud') return s.get('hud') !== 'off';
        const mode = s.get('cluster');
        return mode === 'always' || (mode === 'map' && this.mapBusy);
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
            const show = !!(this.view && this.view.limit && this._wanted(t));
            if (!show) {
                if (L && L.visible) { cr.set(L.ref, { visible: 0 }); L.visible = false; }
                return;
            }
            const w = this._where(t);
            const sign = drawSign(this.view.limit, { size: w.size, inferred: this.view.inferred, over: this.view.over });
            if (L && L.size !== w.size) { cr.drop(L.ref); L = null; }
            if (!L) {
                const ref = cr.image({ target: t, class: 'overlay', z: 20, x: w.x, y: w.y, w: w.size, h: w.size, iw: w.size, ih: w.size, fps: 4, visible: 1 });
                L = this.layers[t] = { ref, size: w.size, x: w.x, y: w.y, key: '', visible: true };
            } else {
                if (L.x !== w.x || L.y !== w.y) { cr.set(L.ref, { x: w.x, y: w.y }); L.x = w.x; L.y = w.y; }
                if (!L.visible) { cr.set(L.ref, { visible: 1 }); L.visible = true; }
            }
            if (L.key !== sign.key) { cr.pixels(L.ref, sign.px); L.key = sign.key; }
        });
    }

    /** Now and then: ask cluster-render who draws on the map target (cluster "map" mode only). */
    tick(now) {
        const cr = this.cr;
        if (!cr || !cr.ready || this.settings.get('cluster') !== 'map') return;
        if (now - this.lastStatus < STATUS_MS) return;
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
            hud: st('hud'), map: st('map'), mapBusy: this.mapBusy, mapBusyBy: this.mapBusyBy, targets: this.targets, refused: this.refused,
        };
    }
}

module.exports = { Outputs, LAYER_RX, TARGETS };
