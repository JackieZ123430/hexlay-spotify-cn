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
 * Engines: the B38 / B48 / B58 (one engine unit, 0x12), the twin-turbo V8s and V12s (an engine unit per cylinder
 * bank: 0x12 for bank 1, 0x13 for bank 2; misfires of the cylinders a unit doesn't report are asked of the other)
 * and the diesels (no ignition timing; their units refuse the F4xx boost identifiers, OBD PID 70 answers).
 *
 *   const snap = new EngineSnapshot(diag, ctx.spec.config, log, () => vehicle.engineKind());
 *     engineKind() -> { dme2: 0x13 or null, diesel }
 *   await snap.read({ live: true, misfire: false, ... })   the Data check page's live rounds (as M Vitals polls):
 *     no cache; misfire / hv: false leaves those out this round and keeps their last values
 *   await snap.read({ budgetMs: 3500, steady, hybrid })  -> { at, values: { iat: 31, ... } } (cached 20 s)
 */
const { DidReader } = require('./kit/dids');

const CACHE_MS = 20000;
const TIMEOUT_MS = 1500;            // per request: a unit that is silent costs this, not 4 s
const GIVE_UP = 3;                  // a value that failed this often in a row is only asked again after RETRY_MS
const RETRY_MS = 30000;             // (as M Vitals: a refusal under load, a unit slow to wake)

class EngineSnapshot {
    constructor(diag, config, log, engineKind) {
        this.log = log || console;
        this.kind = () => { try { return (engineKind && engineKind()) || {}; } catch (e) { return {}; } };
        this.dme = (config && config.dme) || {};
        this.battery = (config && config.battery) || {};
        this.rd = new DidReader(diag, { ecu: this.dme.ecu || 0x12 });
        this.hv = new DidReader(diag, { ecu: this.battery.ecu || 0x07 });
        this.fails = {};
        this.failT = {};                // when each value last failed
        this.last = null;
        this.busy = null;
        this.baro = null;
        this.mis1 = { mode: null, mids: null };              // the engine unit's misfire monitors: OBD 06 / UDS, their MIDs
        this.mis2 = { mode: null, mids: null, none: false }; // the second engine unit's (V8 / V12)
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
        // kept 20 s, unless the engine started or stopped since (its values then mean something else); a live round reads anew
        const live = !!(opts && opts.live);
        if (!live && this.last && Date.now() - this.last.at < CACHE_MS && this.last.engine === ((opts && opts.engine) || null)) return Promise.resolve(this.last);
        if (this.busy) return this.busy;
        this.busy = this._read(opts || {}).then((r) => {
            this.busy = null;
            if (r) {
                // what this round left out (misfires, the HV battery: not every round) keeps its last value, same engine state
                const prev = this.last;
                if (prev && prev.engine === r.engine) (r.skipped || []).forEach((k) => { if (prev.values[k] !== undefined && r.values[k] === undefined) r.values[k] = prev.values[k]; });
                if (r.values.misfire && prev && prev.values.misfirePartial && (r.skipped || []).indexOf('misfire') >= 0) r.values.misfirePartial = true;
                this.last = r;
            }
            return r;
        }, (e) => { this.busy = null; this.log.warn('M-Copilot: engine snapshot: ' + (e.message || e)); return this.last; });
        return this.busy;
    }

    /** A value that failed GIVE_UP times in a row rests: asked again RETRY_MS after its last failure. */
    _resting(name) { return (this.fails[name] || 0) >= GIVE_UP && Date.now() - (this.failT[name] || 0) < RETRY_MS; }

    /** Every 10 minutes the values given up on are asked again (a refusal under load, a unit slow to wake). */
    _refresh() {
        if (Date.now() - (this.failsAt || 0) < 600000) return;
        this.failsAt = Date.now();
        this.fails = {};
        this.hvMissing = false;
        this.mis2.none = false;
    }

    async _read(opts) {
        this._refresh();
        const until = Date.now() + (opts.budgetMs || 3500);
        const ok = () => Date.now() < until && (!opts.steady || opts.steady());
        const values = {}, skipped = [];
        const one = async (name, list, rd) => {
            if (!list || !list.length || this._resting(name) || !ok()) return null;
            const v = await EngineSnapshot.within(rd || this.rd, name, list, ok);
            this.fails[name] = v === null ? (this.fails[name] || 0) + 1 : 0;
            if (v === null) this.failT[name] = Date.now();
            return v;
        };
        const d = this.dme;
        // the outside air pressure first: boost is absolute pressure minus it (kPa -> bar)
        const b = await one('baro', d.baro);
        if (b !== null) this.baro = b;
        const baro = this.baro !== null ? this.baro : 101.3;
        if (b !== null) values.baro = b;
        // engine off: boost, load, timing and misfires mean nothing (boost = the outside air): not asked
        const running = opts.engine !== 'off';
        if (running) {
            const bt = await one('boostTarget', d.boostTarget), ba = await one('boostActual', d.boostActual);
            if (bt !== null) values.boostTarget = (bt - baro) / 100;
            if (ba !== null) values.boostActual = (ba - baro) / 100;
            if (ba === null) { const m = await one('boost', d.boost); if (m !== null) values.boostActual = (m - baro) / 100; }
        }
        // a diesel has no ignition timing (compression ignition): not asked
        const diesel = !!this.kind().diesel;
        for (const k of (running ? ['iat', 'loadTarget', 'loadActual', 'timing', 'hpfp', 'lpfp'] : ['iat', 'hpfp', 'lpfp']).filter((x) => !(diesel && x === 'timing'))) {
            const v = await one(k, d[k]);
            if (v !== null) values[k] = v;
        }
        const egs = await one('egs', d.egs);
        if (egs !== null) values.gearboxOil = egs;
        if (opts.needOil) { const o = await one('oil', d.oil); if (o !== null) values.oil = o; }
        const v12 = await one('v12', this.battery.v12);
        if (v12 !== null) values.v12 = v12;
        // misfire counts change slowly: a live round may leave them out (opts.misfire false), keeping the last
        if (running && d.misfire && opts.misfire === false) skipped.push('misfire');
        else if (running && ok() && d.misfire) {
            const m = await this._misfire(ok);
            if (m) { values.misfire = m.counts; if (m.partial) values.misfirePartial = true; }
        }
        // the high-voltage battery: hybrids / EVs only (a car whose unit never answers is not asked again)
        if (opts.hybrid && !this.hvMissing && opts.hv === false) skipped.push('hvSoc', 'hvSoh');
        else if (opts.hybrid && !this.hvMissing) {
            const soc = await one('hvSoc', this.battery.soc, this.hv);
            if (soc === null && (this.fails.hvSoc || 0) >= GIVE_UP) this.hvMissing = true;
            if (soc !== null) values.hvSoc = soc;
            const soh = await one('hvSoh', this.battery.soh, this.hv);
            if (soh !== null) values.hvSoh = soh;
        }
        return { at: Date.now(), values, engine: opts.engine || null, skipped };
    }

    /**
     * A light sample under load for the drive memory: boost actual / target, intake air and timing
     * only, within budgetMs (default 900). Not kept; never while a full read runs.
     * Resolves { boostActual, boostTarget, iat, timing } (bar above outside air pressure) or null.
     */
    async sample(opts) {
        if (this.busy || this.sampling) return null;
        this._refresh();
        this.sampling = true;
        try {
            const until = Date.now() + ((opts && opts.budgetMs) || 900);
            const ok = () => Date.now() < until && (!opts || !opts.steady || opts.steady());
            const out = {};
            const baro = this.baro !== null ? this.baro : 101.3, d = this.dme;
            const diesel = !!this.kind().diesel;
            for (const k of ['boostTarget', 'boostActual', 'iat', 'timing'].filter((x) => !(diesel && x === 'timing'))) {
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

    /**
     * For the Data check page: per value, what the last read gave - { name, value, via, why }.
     * via: the identifier that answered ('DID 580B', 'OBD 0F'); why: the latest refusal or silence.
     */
    report() {
        const v = (this.last && this.last.values) || {}, d = this.dme, b = this.battery;
        const rows = [['boostActual', d.boostActual || d.boost, this.rd], ['boostTarget', d.boostTarget, this.rd], ['baro', d.baro, this.rd], ['iat', d.iat, this.rd],
            ['loadActual', d.loadActual, this.rd], ['loadTarget', d.loadTarget, this.rd], ['timing', d.timing, this.rd], ['hpfp', d.hpfp, this.rd], ['lpfp', d.lpfp, this.rd],
            ['gearboxOil', d.egs, this.rd, 'egs'], ['oil', d.oil, this.rd], ['v12', b.v12, this.rd], ['misfire', null, this.rd], ['hvSoc', b.soc, this.hv], ['hvSoh', b.soh, this.hv]];
        const label = (c) => (c.obd ? 'OBD ' + String(c.obd).toUpperCase() : 'DID ' + c.did);
        return rows.map(([name, list, rd, key]) => {
            key = key || name;
            const out = { name, value: v[name], via: null, why: null, fails: this.fails[key] || 0 };
            // what this engine doesn't have: said so, not asked
            if (name === 'timing' && this.kind().diesel) { out.na = 'diesel: no spark ignition'; return out; }
            if (list && list.length) {
                if (out.value !== undefined) out.via = label(list[rd.pick[key] || 0] || list[0]);
                let last = null;
                list.forEach((c) => { const r = rd.raws[rd.key(Object.assign({ timeoutMs: TIMEOUT_MS }, c))]; if (r && !r.ok && (!last || r.t > last.t)) last = r; });
                if (last) out.why = last.why;
            }
            if (name === 'misfire' && this.mis1.mode !== null) out.via = this.mis1.mode ? 'UDS F6A2..' : 'OBD 06 A2..';
            return out;
        });
    }

    /**
     * Misfires per cylinder in this driving cycle (OBD 06, MIDs A2.. = cylinder 1..), as M Vitals reads them.
     * A V8 / V12 has an engine unit per cylinder bank: when the first reports 6 cylinders or fewer, the second
     * (0x13) is asked too. MIDs it has past the first unit's are those cylinders; the same MIDs again are its
     * own bank, numbered on (BMW counts bank 1 as cylinders 1-4, bank 2 as 5-8). When the second unit gives
     * none, the counts are bank 1's, marked partial.
     * Resolves { counts, partial } or null.
     */
    async _misfire(ok) {
        const m = this.dme.misfire || {}, ecu = m.ecu == null ? (this.dme.ecu || 0x12) : m.ecu, tid = parseInt(m.tid || '0C', 16);
        if (this._resting('misfire')) return null;
        const one = await this._misfireUnit(ecu, this.mis1, tid, ok);
        if (!one) {
            if (this.mis1.mode === null) { this.fails.misfire = (this.fails.misfire || 0) + 1; this.failT.misfire = Date.now(); }
            return null;
        }
        this.fails.misfire = 0;
        const counts = one.first ? new Array(one.first).fill(null).concat(one.counts) : one.counts;
        const dme2 = this.kind().dme2;
        if (!dme2 || counts.length > 6 || this.mis2.none) return { counts, partial: !!dme2 && counts.length <= 6 };
        const two = await this._misfireUnit(dme2, this.mis2, tid, ok);
        if (!two) {
            if (!ok()) return null;                                      // out of time: the whole engine next time
            if (this.mis2.mode === null) this.mis2.none = true;           // the second unit has no misfire monitors
            return { counts, partial: true };
        }
        let all;
        if (two.first >= counts.length) {                                 // numbered on: its cylinders where they are
            all = counts.slice();
            while (all.length < two.first) all.push(null);
            all = all.concat(two.counts);
        } else if (two.first === 0 && two.counts.length > counts.length) all = counts.concat(two.counts.slice(counts.length));
        else all = counts.concat(two.counts);                             // its own bank, from its cylinder 1
        return { counts: all, partial: false };
    }

    /**
     * One unit's misfire counts. st = { mode, mids } kept for it: mode false = OBD 06, true = UDS 22 F6xx;
     * mids = the cylinder MIDs it has (A2..AD, from its supported list A0), or null when it gives no list (then
     * A2, A3 ... until one is refused). Resolves { first: cylinder index of the first count, counts } or null.
     */
    async _misfireUnit(ecu, st, tid, ok) {
        const rd = this.rd;
        const cylMids = (sup) => { const l = (sup || []).filter((x) => x >= 0xA2 && x <= 0xAD).sort((a, b) => a - b); return l.length ? l : null; };
        if (st.mode === null) {
            // the unit's list of monitors first (a bank 2 unit may have no cylinder 1), then cylinder 1 itself
            for (const mode of [false, true]) {
                if (!ok()) return null;
                const mids = cylMids(await rd.supported(ecu, 0xA0, mode));
                if (mids) { st.mode = mode; st.mids = mids; break; }
            }
            if (st.mode === null) {
                if (await rd.monitor(ecu, 0xA2, false)) st.mode = false;
                else if (await rd.monitor(ecu, 0xA2, true)) st.mode = true;
                else return null;
            }
        }
        const counts = [];
        const list = st.mids || [];
        for (let c = 0; c < (st.mids ? list.length : 12); c++) {
            if (!ok()) return null;                   // out of time / the engine started: the counts are skipped
            const mid = st.mids ? list[c] : 0xA2 + c;
            const res = await rd.monitor(ecu, mid, st.mode);
            if (!res) {
                if (st.mids || !c || !/^NRC/.test(rd.raws[rd.monitorKey(ecu, mid, st.mode)].why)) return null;
                break;
            }
            const tr = res.find((x) => x.tid === tid) || res[0];
            counts.push(tr.value >= 65535 ? null : tr.value);
        }
        if (!counts.length) return null;
        if (!st.mids) st.mids = counts.map((x, i) => 0xA2 + i);
        return { first: st.mids[0] - 0xA2, counts };
    }
}

module.exports = EngineSnapshot;
