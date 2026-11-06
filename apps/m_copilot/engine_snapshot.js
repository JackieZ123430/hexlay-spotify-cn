'use strict';
/**
 * engine_snapshot.js - one read-only look into the engine (and hybrid battery) control units for the
 * AI's context: what M Vitals and eDrive (cauliflowermossgrape/idrive7-apps) show live, read once
 * when a question is asked.
 *
 *   intake air temperature, boost actual / target, outside air pressure, air charge (load) actual /
 *   target, ignition timing, high / low pressure fuel, misfires per cylinder (this driving cycle),
 *   gearbox oil temperature, 12 V voltage, engine oil temperature (when the car's signal has none),
 *   hybrids: high-voltage battery charge and health
 *
 * Requests: UDS 0x22 ReadDataByIdentifier, OBD service 01 (current data) and 06 (monitor results) to
 * the engine unit (0x12), and 0x22 to the high-voltage battery unit (0x07) on hybrids - read services
 * only, in the default session, the same ones M Vitals and eDrive poll continuously. The identifiers
 * and scalings are app.json "config.dme" (M Vitals' table) and "config.battery" (eDrive's); each
 * value has candidates, the first plausible answer wins and is asked first next time (kit/dids.js).
 *
 *   const snap = new EngineSnapshot(diag, ctx.spec.config, log);
 *   await snap.read({ budgetMs: 3500, steady, hybrid })  -> { at, values: { iat: 31, ... } } (cached 20 s)
 */
const { DidReader } = require('./kit/dids');

const CACHE_MS = 20000;
const TIMEOUT_MS = 1500;            // per request: a unit that is silent costs this, not 4 s
const GIVE_UP = 3;                  // a value that failed this often in a row is not asked again this session

class EngineSnapshot {
    constructor(diag, config, log) {
        this.log = log || console;
        this.dme = (config && config.dme) || {};
        this.battery = (config && config.battery) || {};
        this.rd = new DidReader(diag, { ecu: this.dme.ecu || 0x12 });
        this.hv = new DidReader(diag, { ecu: this.battery.ecu || 0x07 });
        this.fails = {};
        this.last = null;
        this.busy = null;
        this.baro = null;
        this.misMode = null; this.misCyl = 0;
        this.hvMissing = false;
    }

    /** candidates with the short timeout */
    static quick(list) { return (list || []).map((c) => Object.assign({ timeoutMs: TIMEOUT_MS }, c)); }

    /**
     * DidReader.value with the time budget checked before each candidate (a silent unit costs a
     * candidate's timeout each, and a value can have four): the one that answered last goes first.
     */
    static async within(rd, name, list, ok) {
        const l = EngineSnapshot.quick(list), start = rd.pick[name] || 0;
        for (let k = 0; k < l.length; k++) {
            if (!ok()) return null;
            const i = (start + k) % l.length;
            const v = await rd.read(l[i]);
            if (v !== null) { rd.pick[name] = i; return v; }
        }
        return null;
    }

    read(opts) {
        if (this.last && Date.now() - this.last.at < CACHE_MS) return Promise.resolve(this.last);
        if (this.busy) return this.busy;
        this.busy = this._read(opts || {}).then((r) => { this.busy = null; if (r) this.last = r; return r; }, (e) => { this.busy = null; this.log.warn('M-Copilot: engine snapshot: ' + (e.message || e)); return this.last; });
        return this.busy;
    }

    async _read(opts) {
        const until = Date.now() + (opts.budgetMs || 3500);
        const ok = () => Date.now() < until && (!opts.steady || opts.steady());
        const values = {};
        const one = async (name, list, rd) => {
            if (!list || !list.length || (this.fails[name] || 0) >= GIVE_UP || !ok()) return null;
            const v = await EngineSnapshot.within(rd || this.rd, name, list, ok);
            this.fails[name] = v === null ? (this.fails[name] || 0) + 1 : 0;
            return v;
        };
        const d = this.dme;
        // the outside air pressure first: boost is absolute pressure minus it (kPa -> bar)
        const b = await one('baro', d.baro);
        if (b !== null) this.baro = b;
        const baro = this.baro !== null ? this.baro : 101.3;
        if (b !== null) values.baro = b;
        const bt = await one('boostTarget', d.boostTarget), ba = await one('boostActual', d.boostActual);
        if (bt !== null) values.boostTarget = (bt - baro) / 100;
        if (ba !== null) values.boostActual = (ba - baro) / 100;
        if (ba === null) { const m = await one('boost', d.boost); if (m !== null) values.boostActual = (m - baro) / 100; }
        for (const k of ['iat', 'loadTarget', 'loadActual', 'timing', 'hpfp', 'lpfp']) {
            const v = await one(k, d[k]);
            if (v !== null) values[k] = v;
        }
        const egs = await one('egs', d.egs);
        if (egs !== null) values.gearboxOil = egs;
        if (opts.needOil) { const o = await one('oil', d.oil); if (o !== null) values.oil = o; }
        const v12 = await one('v12', this.battery.v12);
        if (v12 !== null) values.v12 = v12;
        if (ok() && d.misfire) {
            const m = await this._misfire(ok);
            if (m) values.misfire = m;
        }
        // the high-voltage battery: hybrids / EVs only (a car whose unit never answers is not asked again)
        if (opts.hybrid && !this.hvMissing) {
            const soc = await one('hvSoc', this.battery.soc, this.hv);
            if (soc === null && (this.fails.hvSoc || 0) >= GIVE_UP) this.hvMissing = true;
            if (soc !== null) values.hvSoc = soc;
            const soh = await one('hvSoh', this.battery.soh, this.hv);
            if (soh !== null) values.hvSoh = soh;
        }
        return { at: Date.now(), values };
    }

    /**
     * A light sample under load for the drive memory: boost actual / target, intake air and timing
     * only, within budgetMs (default 900). Not kept; never while a full read runs.
     * Resolves { boostActual, boostTarget, iat, timing } (bar above outside air pressure) or null.
     */
    async sample(opts) {
        if (this.busy || this.sampling) return null;
        this.sampling = true;
        try {
            const until = Date.now() + ((opts && opts.budgetMs) || 900);
            const ok = () => Date.now() < until && (!opts || !opts.steady || opts.steady());
            const out = {};
            const baro = this.baro !== null ? this.baro : 101.3, d = this.dme;
            for (const k of ['boostTarget', 'boostActual', 'iat', 'timing']) {
                if (!ok() || !d[k] || (this.fails[k] || 0) >= GIVE_UP) continue;
                const v = await EngineSnapshot.within(this.rd, k, d[k], ok);
                this.fails[k] = v === null ? (this.fails[k] || 0) + 1 : 0;
                if (v === null) continue;
                out[k] = k === 'boostTarget' || k === 'boostActual' ? (v - baro) / 100 : v;
            }
            return Object.keys(out).length ? out : null;
        } finally {
            this.sampling = false;
        }
    }

    /** misfires per cylinder in this driving cycle (OBD 06, MIDs A2.. = cylinder 1..), as M Vitals reads them */
    async _misfire(ok) {
        const m = this.dme.misfire || {}, ecu = m.ecu == null ? (this.dme.ecu || 0x12) : m.ecu, tid = parseInt(m.tid || '0C', 16), rd = this.rd;
        if ((this.fails.misfire || 0) >= GIVE_UP) return null;
        if (this.misMode === null) {
            if (await rd.monitor(ecu, 0xA2, false)) this.misMode = false;
            else if (await rd.monitor(ecu, 0xA2, true)) this.misMode = true;
            else { this.fails.misfire = (this.fails.misfire || 0) + 1; return null; }
        }
        if (!this.misCyl) {
            const sup = await rd.supported(ecu, 0xA0, this.misMode);
            let n = 0;
            while (sup && n < 12 && sup.indexOf(0xA2 + n) >= 0) n++;
            if (n) this.misCyl = n;
        }
        const counts = [];
        for (let c = 0; c < (this.misCyl || 12); c++) {
            if (!ok()) return null;                   // out of time / the engine started: the counts are skipped
            const res = await rd.monitor(ecu, 0xA2 + c, this.misMode);
            if (!res) {
                if (this.misCyl || !c || !/^NRC/.test(rd.raws[rd.monitorKey(ecu, 0xA2 + c, this.misMode)].why)) return null;
                break;
            }
            const tr = res.find((x) => x.tid === tid) || res[0];
            counts.push(tr.value >= 65535 ? null : tr.value);
        }
        if (!this.misCyl) this.misCyl = counts.length;
        this.fails.misfire = 0;
        return counts.length === this.misCyl ? counts : null;
    }
}

module.exports = EngineSnapshot;
