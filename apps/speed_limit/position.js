'use strict';
/**
 * position.js - where the car is and how fast it goes, from the car's own SOME/IP services (read only). Node 8.
 *
 *   const pos = new Position(signals, log);
 *   await pos.start();  pos.fix(now) -> { x, y, lat, lon, heading, speed, source, age } | null;  await pos.stop()
 *
 * Sources, best first (ids from the head unit's catalog, 030_016_002 = P18_23w44.2; conversions from BMW's own
 * CDC app on the head unit, oap-cdc-2018 3.31.43):
 *   nav    de.bmw.infotainment.navigation.positioning.Positioning (Main_Instance) currentLocation: degrees (Double),
 *          used only with coordinatesValid; heading (Double, degrees) when the car moves
 *   gnss   de.bmw.infotainment.GPSData (1) GPSPositionCAN: deg = (0.001 * raw - 2147483.648) / 3600, raw >=
 *          4294967293 = no value; GPSPositionExtendedCAN.statusQualityPositionGPSCAN bits: 5 dead reckoning,
 *          6 differential, 7 2D fix, 8 3D fix (4095 = no value). Its heading's scale is not known: the matcher
 *          takes the heading from the way the car moves instead.
 * Speed: de.bmw.infotainment.vehicle.Vehicle2 (1) statusCarSpeed2: km/h = 0.015625 * speedVehicleCentreOfGravity
 * (65535 = no value).
 *
 * Only notifications are subscribed. A source that has gone quiet for 2 s is read once (its getter) at most every
 * 2 s while the app is active; nothing is ever written to the car.
 */
const { merc, unmerc } = require('./limitpack');

const NAV = 'de.bmw.infotainment.navigation.positioning.Positioning';
const GPS = 'de.bmw.infotainment.GPSData';
const V2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const FRESH_MS = 2500;
const RAW_INVALID = 4294967293;
const Q_DR = 1 << 5, Q_DIFF = 1 << 6, Q_2D = 1 << 7, Q_3D = 1 << 8;

function canDeg(raw) { return (0.001 * raw - 2147483.648) / 3600; }
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

class Position {
    constructor(signals, log) {
        this.signals = signals;
        this.log = log || { info() {}, warn() {} };
        this.subs = [];
        this.nav = null;            // { lat, lon, heading, status, at }
        this.gnss = null;           // { lat, lon, at }
        this.quality = null;        // raw quality bits
        this.speed = null;          // { kmh, at }
        this.raw = {};              // the last raw values, for the diagnostic page
        this.counts = { nav: 0, navInvalid: 0, gnss: 0, gnssInvalid: 0, speed: 0 };
        this.avail = { nav: false, gnss: false, speed: false };
        this.errors = {};
        this.lastRead = {};
        this.running = false;
    }

    async start() {
        if (this.running) return;
        this.running = true;
        const w = (key, iface, inst, handlers) => Promise.resolve(this.signals.watch(iface, inst, handlers, this.log)).then((sub) => {
            if (!this.running) { sub.shutdown(); return; }
            sub.key = key;
            this.subs.push(sub);
            if (sub.error) this.errors[key] = sub.error;
        }).catch((e) => { this.errors[key] = String(e && e.message || e); });
        await Promise.all([
            w('nav', NAV, 'Main_Instance', { currentLocation: (v) => this._nav(v) }),
            w('gnss', GPS, '1', { GPSPositionCAN: (v) => this._gnss(v), GPSPositionExtendedCAN: (v) => this._gnssExt(v) }),
            w('speed', V2, '1', { statusCarSpeed2: (v) => this._speed(v) }),
        ]);
    }

    async stop() {
        this.running = false;
        const subs = this.subs;
        this.subs = [];
        await Promise.all(subs.map((s) => Promise.resolve(s.shutdown()).catch(() => {})));
        this.nav = this.gnss = this.speed = null;
        this.quality = null;
    }

    _nav(v) {
        if (!v) return;
        const lat = num(v.latitude), lon = num(v.longitude);
        this.raw.nav = { valid: v.coordinatesValid, lat, lon, heading: v.heading, status: v.status };
        if (!v.coordinatesValid || lat === null || lon === null || (lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { this.counts.navInvalid++; return; }
        const h = num(v.heading);
        this.nav = { lat, lon, heading: h !== null && h >= 0 && h <= 360 ? h : null, status: v.status, at: Date.now() };
        this.counts.nav++;
    }

    _gnss(v) {
        if (!v) return;
        const la = v.statusGPSLatitudeCAN, lo = v.statusGPSLongitudeCAN;
        this.raw.gnss = { lat: la, lon: lo };
        if (typeof la !== 'number' || typeof lo !== 'number' || la >= RAW_INVALID || lo >= RAW_INVALID || la === 2147483647 || lo === 2147483647) { this.counts.gnssInvalid++; return; }
        const lat = canDeg(la), lon = canDeg(lo);
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) { this.counts.gnssInvalid++; return; }
        this.gnss = { lat, lon, at: Date.now() };
        this.counts.gnss++;
    }

    _gnssExt(v) {
        if (!v) return;
        this.raw.gnssExt = { heading: v.statusHeadingGPSCAN, height: v.statusHeightGPSCAN, quality: v.statusQualityPositionGPSCAN, speed: v.speedGPSCAN };
        const q = v.statusQualityPositionGPSCAN;
        this.quality = typeof q === 'number' && q !== 4095 ? q : null;
    }

    _speed(v) {
        const s = v && v.speedVehicleCentreOfGravity;
        this.raw.speed = s;
        if (typeof s !== 'number' || s === 65535) return;
        const kmh = 0.015625 * s;
        if (kmh < 0 || kmh > 400) return;
        this.speed = { kmh, at: Date.now() };
        this.counts.speed++;
    }

    gnssUsable() {
        // a fix (2D, 3D) or the car's dead reckoning; unknown quality counts as usable (not every car sends it)
        return this.quality === null || (this.quality & (Q_2D | Q_3D | Q_DR)) !== 0;
    }

    /** Read a quiet source once (its getter), at most every 2 s: a provider that does not notify. */
    poll(now) {
        this.subs.forEach((s) => {
            this.avail[s.key] = !!s.available;
            if (!s.available || !s.proxy) return;
            const last = s.key === 'nav' ? this.nav : s.key === 'gnss' ? this.gnss : this.speed;
            if (last && now - last.at < 2000) return;
            if (now - (this.lastRead[s.key] || 0) < 2000) return;
            this.lastRead[s.key] = now;
            const field = s.key === 'nav' ? 'currentLocation' : s.key === 'gnss' ? 'GPSPositionCAN' : 'statusCarSpeed2';
            // from a fresh tick, as kit/signals.js reads (the native binding must not be entered inline)
            setImmediate(() => {
                if (!this.running) return;
                let p;
                try { p = s.proxy.getValue(field, 1500); } catch (e) { return; }
                Promise.resolve(p).then((v) => {
                    if (!this.running) return;
                    if (s.key === 'nav') this._nav(v); else if (s.key === 'gnss') this._gnss(v); else this._speed(v);
                }).catch(() => {});
            });
        });
    }

    speedKmh(now) { return this.speed && now - this.speed.at < FRESH_MS ? this.speed.kmh : null; }

    /** The best fix now, or null. */
    fix(now) {
        const t = now || Date.now(), speed = this.speedKmh(t);
        let f = null;
        if (this.nav && t - this.nav.at < FRESH_MS) f = { lat: this.nav.lat, lon: this.nav.lon, heading: this.nav.heading, source: 'nav', at: this.nav.at };
        else if (this.gnss && t - this.gnss.at < FRESH_MS && this.gnssUsable()) f = { lat: this.gnss.lat, lon: this.gnss.lon, heading: null, source: 'gnss', at: this.gnss.at };
        if (!f) return null;
        const p = merc(f.lat, f.lon);
        return { x: p[0], y: p[1], lat: f.lat, lon: f.lon, heading: f.heading, speed, source: f.source, age: t - f.at };
    }

    diag() {
        return { raw: this.raw, counts: this.counts, avail: this.avail, errors: this.errors, quality: this.quality };
    }
}

/**
 * The PC's demo drive (the emulator and preview set "demo" on; a car never has it): up and down the Tbilisi Bypass
 * Road (OSM way 20647951, 90 km/h) at 70-100 km/h, so the page and the sign can be seen working without a car.
 * opts.way, opts.speed (the preview's --set demoWay=... demoSpeed=...): another way, a steady speed.
 */
class DemoDrive {
    constructor(pack, opts) {
        const o = opts || {}, way = Number(o.way) || 0;
        this.steady = Number(o.speed) || 0;
        this.pts = [];
        if (!pack) return;
        for (let i = 0; i < pack.count; i++) {
            const P = pack.piece(i);
            if (P.way !== (way || 20647951)) continue;
            const p = pack.points(i, P);
            for (let k = this.pts.length ? 2 : 0; k < p.length; k += 2) this.pts.push([p[k], p[k + 1]]);
        }
        this.len = [0];
        for (let i = 1; i < this.pts.length; i++) this.len.push(this.len[i - 1] + Math.hypot(this.pts[i][0] - this.pts[i - 1][0], this.pts[i][1] - this.pts[i - 1][1]));
        this.t0 = Date.now();
    }

    speedKmh(now) { return this.steady || 85 + 15 * Math.sin((now - this.t0) / 9000); }

    fix(now) {
        if (this.pts.length < 2) return null;
        const total = this.len[this.len.length - 1];
        // distance driven (mercator metres; about 1.34 per ground metre here), there and back again
        let s = ((now - this.t0) / 1000) * ((this.steady || 85) / 3.6) * 1.34 % (2 * total);
        const back = s > total;
        if (back) s = 2 * total - s;
        let i = 1;
        while (i < this.len.length - 1 && this.len[i] < s) i++;
        const a = this.pts[i - 1], b = this.pts[i], f = (s - this.len[i - 1]) / Math.max(1e-6, this.len[i] - this.len[i - 1]);
        const x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f;
        let h = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI + 360) % 360;
        if (back) h = (h + 180) % 360;
        const ll = unmerc(x, y);
        return { x, y, lat: ll[0], lon: ll[1], heading: h, speed: this.speedKmh(now), source: 'demo', age: 0 };
    }
}

module.exports = { Position, DemoDrive, canDeg, NAV, GPS, V2 };
