'use strict';

// M-Copilot's engine reads (apps/m_copilot/engine_snapshot.js, vehicle.js) against stand-in control units
// of the engines iDrive 7 cars have: a B48 and a B58 (one Bosch MG1 engine unit), the twin-turbo V8s
// (N63 / S63: an engine unit per cylinder bank, 0x12 and 0x13; their misfires from either unit, a G06 N63
// whose engine units don't give the 12 V) and a B57 diesel (no F4xx boost identifiers, no ignition timing).
// The units answer what the app.json identifiers ask, scaled as app.json says. No car needed:
//   node kit/tools/test_copilot_engines.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// in a package the kit is at ./kit next to the app's files (build.py); here it is kit/runtime
const KIT = path.resolve(__dirname, '..', 'runtime'), APPS = path.resolve(__dirname, '..', '..', 'apps');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent) {
    const m = parent && parent.filename && parent.filename.indexOf(APPS) === 0 && /^\.\/kit\/(.+)$/.exec(request);
    return origResolve.apply(this, [m ? path.join(KIT, m[1]) : request].concat([].slice.call(arguments, 1)));
};
const EngineSnapshot = require(path.join(APPS, 'm_copilot', 'engine_snapshot'));
const Vehicle = require(path.join(APPS, 'm_copilot', 'vehicle'));
const CONFIG = JSON.parse(fs.readFileSync(path.join(APPS, 'm_copilot', 'app.json'), 'utf8')).config;
const near = (a, b, what) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 0.05, what + ': ' + a + ' is not ' + b);
const quiet = { info() {}, warn() {}, error() {} };

/** a value as the candidate c's reply bytes: raw = (v - offset) / factor, 'bytes' big-endian at 'at' */
function encode(c, v) {
    const raw = Math.round((v - (c.offset || 0)) / (c.factor == null ? 1 : c.factor)), n = c.bytes || 1, out = [];
    for (let i = 0; i < (c.at || 0); i++) out.push(0);
    for (let i = n - 1; i >= 0; i--) out.push((raw >> (8 * i)) & 0xFF);
    return out;
}

/**
 * A car's diagnostic units. units = { ecu: { f150: 'idx', values: { name: value } (answered by the first
 * candidate of that name whose ecu / kind the unit takes), refuse: /pattern of candidate labels/,
 * misfire: { mids: [counts by MID A2..], uds: false } } }; anything else: NRC 31, a unit not listed: silence.
 */
function car(units) {
    const asked = [];
    const cands = {};
    Object.keys(CONFIG.dme).concat(Object.keys(CONFIG.battery).map((k) => 'battery.' + k)).forEach((k) => {
        const list = k.indexOf('battery.') === 0 ? CONFIG.battery[k.slice(8)] : CONFIG.dme[k];
        if (Array.isArray(list)) cands[k.replace('battery.', '')] = list;
    });
    const physical = async (ecu, sid, data) => {
        asked.push(ecu.toString(16) + ':' + sid.toString(16) + ':' + data.map((x) => x.toString(16)).join(','));
        const u = units[ecu];
        if (!u) return null;                                            // no such unit: silence
        const nrc = [0x7F, sid, 0x31];
        if (sid === 0x22 && data[0] === 0xF1 && data[1] === 0x50) {
            if (!u.f150) return nrc;
            const b = u.f150.match(/../g).map((x) => parseInt(x, 16));
            return [0x62, 0xF1, 0x50].concat(b);
        }
        if ((sid === 0x06 || (sid === 0x22 && data[0] === 0xF6)) && u.misfire) {
            const uds = sid === 0x22, mid = uds ? data[1] : data[0];
            if (!!u.misfire.uds !== uds) return nrc;
            const mids = u.misfire.mids, head = uds ? [0x62, 0xF6, mid] : [0x46, mid];
            if (mid === 0xA0) {
                const bits = [0, 0, 0, 0];
                mids.forEach((x, i) => { const k = 1 + i + (u.misfire.from || 0); bits[k >> 3] |= 0x80 >> (k & 7); });
                return head.concat(bits);
            }
            const i = mid - 0xA2 - (u.misfire.from || 0);
            if (i < 0 || i >= mids.length) return nrc;
            const rec = [0x0C, 0x24, mids[i] >> 8, mids[i] & 0xFF, 0, 0, 0xFF, 0xFF];
            return head.concat(rec);                                       // 46 MID TID ... / 62 F6 MID TID ...
        }
        // a value: the unit answers the candidates of its values that it takes
        for (const name of Object.keys(u.values || {})) {
            for (const c of cands[name] || []) {
                if ((c.ecu == null ? (name === 'soc' || name === 'soh' ? 7 : 0x12) : c.ecu) !== ecu) continue;
                const label = c.obd ? 'OBD ' + c.obd.toUpperCase() : c.did;
                if (u.refuse && u.refuse.test(label)) continue;
                if (c.obd && sid === 0x01 && data[0] === parseInt(c.obd, 16)) return [0x41, data[0]].concat(encode(c, u.values[name]));
                if (c.did && sid === 0x22 && ((data[0] << 8) | data[1]) === parseInt(c.did, 16)) return [0x62, data[0], data[1]].concat(encode(c, u.values[name]));
            }
        }
        return nrc;
    };
    return { available: true, physical, asked };
}

// what a running engine's unit says: kPa absolute for the pressures, as app.json scales them
const PETROL = { baro: 100, boostTarget: 250, boostActual: 245, iat: 35, loadTarget: 120, loadActual: 117.75, timing: 12, hpfp: 200, lpfp: 5.5, v12: 14.2 };
const EGS = { f150: '0F2D60', values: { egs: 80 } };

async function run(name, units, kindOverride) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-eng-'));
    try {
        const d = car(units);
        const v = new Vehicle({ dataDir: dir, log: quiet });
        v.vin = 'WBA00000000000000';
        await v.identify(d, () => true, () => false);
        const kind = kindOverride || v.engineKind();
        const snap = new EngineSnapshot(d, CONFIG, quiet, () => kind);
        const r = await snap.read({ budgetMs: 20000, engine: 'on', steady: () => true });
        return { name, v, kind, values: r.values, report: snap.report(), asked: d.asked, lines: v.lines() };
    } finally {
        fs.readdirSync(dir).forEach((f) => fs.unlinkSync(path.join(dir, f)));
        fs.rmdirSync(dir);
    }
}

const checkPetrol = (r) => {
    near(r.values.baro, 100, r.name + ' baro');
    near(r.values.boostTarget, 1.5, r.name + ' boost target');
    near(r.values.boostActual, 1.45, r.name + ' boost actual');
    near(r.values.iat, 35, r.name + ' intake air');
    near(r.values.loadActual, 117.75, r.name + ' load');
    near(r.values.timing, 12, r.name + ' timing');
    near(r.values.hpfp, 200, r.name + ' high-pressure fuel');
    near(r.values.gearboxOil, 80, r.name + ' gearbox oil');
};

(async () => {
    // B48: four cylinders, one engine unit
    const b48 = await run('B48', { 0x12: { f150: '0F2422', values: PETROL, misfire: { mids: [0, 2, 0, 0] } }, 0x18: EGS });
    checkPetrol(b48);
    assert.deepStrictEqual(b48.values.misfire, [0, 2, 0, 0]);
    assert.ok(!b48.values.misfirePartial);
    assert.deepStrictEqual(b48.kind, { dme2: null, diesel: false });
    assert.ok(b48.asked.every((a) => a.indexOf('13:') !== 0), 'a B48 never asks a second engine unit');
    assert.ok(/B38 \/ B48 \/ B58/.test(b48.lines.join('\n')), b48.lines.join(' | '));

    // B58: six cylinders
    const b58 = await run('B58', { 0x12: { f150: '0F2424', values: PETROL, misfire: { mids: [0, 0, 0, 1, 0, 0] } }, 0x18: EGS });
    checkPetrol(b58);
    assert.deepStrictEqual(b58.values.misfire, [0, 0, 0, 1, 0, 0]);
    assert.ok(b58.asked.every((a) => a.indexOf('13:') !== 0));

    // V8 (N63 / S63, DME8FF_R + DME8FF_L): each unit reports its own bank as MIDs A2..A5
    const v8 = await run('V8 per bank', { 0x12: { f150: '0F242C', values: PETROL, misfire: { mids: [0, 1, 0, 0] } },
        0x13: { f150: '0F242C', misfire: { mids: [3, 0, 0, 0] } }, 0x18: EGS });
    checkPetrol(v8);
    assert.deepStrictEqual(v8.kind, { dme2: 0x13, diesel: false });
    assert.deepStrictEqual(v8.values.misfire, [0, 1, 0, 0, 3, 0, 0, 0]);
    assert.ok(!v8.values.misfirePartial);
    const vl = v8.lines.join('\n');
    assert.ok(/Engine control units: DME8FF_R \+ DME8FF_L/.test(vl) && /V8 \(N63 \/ S63\)/.test(vl) && !/B48/.test(vl), vl);
    assert.strictEqual(Vehicle.engineUnitName(v8.v.unitTypes()), 'DME8FF_R + DME8FF_L (V8)');

    // V8 whose second unit numbers its cylinders on (MIDs A6..A9)
    const v8b = await run('V8 numbered on', { 0x12: { f150: '0F2460', values: PETROL, misfire: { mids: [0, 0, 0, 0] } },
        0x13: { f150: '0F2460', misfire: { mids: [0, 0, 5, 0], from: 4 } }, 0x18: EGS });
    assert.deepStrictEqual(v8b.values.misfire, [0, 0, 0, 0, 0, 0, 5, 0]);

    // V8 whose first unit reports all eight: the second is not asked for misfires
    const v8c = await run('V8 all on bank 1', { 0x12: { f150: '0F26B8', values: PETROL, misfire: { mids: [0, 0, 0, 0, 0, 0, 0, 4] } },
        0x13: { f150: '0F26B8', misfire: { mids: [9, 9, 9, 9] } }, 0x18: EGS });
    assert.deepStrictEqual(v8c.values.misfire, [0, 0, 0, 0, 0, 0, 0, 4]);
    assert.ok(v8c.asked.every((a) => !/^13:6:/.test(a)), 'no misfire request to the second unit');

    // V8 whose second unit gives no misfires: bank 1's, said so; a G06 N63: its engine units refuse the 12 V, the gearbox unit gives it
    const n63 = await run('G06 N63', { 0x12: { f150: '0F242E', values: Object.assign({}, PETROL), refuse: /F442|OBD 42/, misfire: { mids: [0, 0, 0, 0] } },
        0x13: { f150: '0F242E' }, 0x18: { f150: '0F2D60', values: { egs: 80, v12: 14.1 } } });
    assert.deepStrictEqual(n63.values.misfire, [0, 0, 0, 0]);
    assert.strictEqual(n63.values.misfirePartial, true);
    near(n63.values.v12, 14.1, 'N63 12 V from the gearbox unit');
    assert.strictEqual(n63.report.find((x) => x.name === 'v12').via, 'DID F442');

    // a V8 whose second unit doesn't answer F150: known from the first unit's type
    const v8d = await run('V8 silent bank 2', { 0x12: { f150: '0F242C', values: PETROL, misfire: { mids: [0, 0, 0, 0] } }, 0x18: EGS });
    assert.strictEqual(v8d.v.unitTypes()[0x13], 'DME8FF_L');
    assert.strictEqual(v8d.values.misfirePartial, true);

    // B57 diesel: refuses the F4xx identifiers, answers the OBD PIDs; no ignition timing asked or shown
    const b57 = await run('B57 diesel', { 0x12: { f150: '0F1FE8', values: { baro: 100, boostActual: 230, iat: 40, hpfp: 1800, v12: 14 }, refuse: /^F4/ }, 0x18: EGS });
    assert.deepStrictEqual(b57.kind, { dme2: null, diesel: true });
    near(b57.values.boostActual, 1.3, 'B57 boost (OBD PID 70)');
    near(b57.values.iat, 40, 'B57 intake air (OBD PID 0F)');
    assert.strictEqual(b57.values.timing, undefined);
    assert.ok(b57.asked.every((a) => !/^12:1:e$/.test(a) && !/^12:22:f4,e$/.test(a)), 'timing not asked on a diesel');
    assert.strictEqual(b57.report.find((x) => x.name === 'timing').na, 'diesel: no spark ignition');
    assert.ok(/diesel/.test(b57.lines.join('\n')));

    // live rounds (the Data check page, as M Vitals polls): no cache, misfires / HV every 4th round keeping their last
    // values, a value the unit refuses rests 30 s after its third refusal
    {
        const units = { 0x12: { f150: '0F2424', values: Object.assign({}, PETROL), misfire: { mids: [0, 0, 1, 0, 0, 0] }, refuse: /^4AB0$|^F470$|^OBD 70$/ } };
        const d = car(units);
        const snap = new EngineSnapshot(d, CONFIG, quiet, () => ({ dme2: null, diesel: false }));
        const round = (misfire) => snap.read({ live: true, budgetMs: 20000, engine: 'on', steady: () => true, misfire, hv: misfire });
        const r1 = await round(true);
        assert.deepStrictEqual(r1.values.misfire, [0, 0, 1, 0, 0, 0]);
        units[0x12].values.iat = 41;                                  // the engine unit's value moves
        units[0x12].misfire.mids = [0, 0, 7, 0, 0, 0];
        const asked = d.asked.length;
        const r2 = await round(false);
        assert.ok(d.asked.length > asked, 'a live round reads anew (no 20 s cache)');
        near(r2.values.iat, 41, 'live intake air');
        assert.deepStrictEqual(r2.values.misfire, [0, 0, 1, 0, 0, 0], 'misfires left out this round: the last counts kept');
        assert.ok(d.asked.slice(asked).every((x) => !/^12:6:/.test(x)), 'no misfire request in a round without them');
        const r3 = await round(true);
        assert.deepStrictEqual(r3.values.misfire, [0, 0, 7, 0, 0, 0]);
        // boost target refused three times: then left alone for 30 s, asked again after
        await round(false);
        const before = d.asked.length;
        await round(false);
        assert.ok(d.asked.slice(before).every((x) => !/^12:22:4a,b0$/.test(x)), 'a refused value rests');
        snap.failT.boostTarget -= 31000;
        const before2 = d.asked.length;
        await round(false);
        assert.ok(d.asked.slice(before2).some((x) => /^12:22:4a,b0$/.test(x)), 'asked again after 30 s');
        // a plain read (a question) within 20 s takes the live round's values
        const n = d.asked.length;
        await snap.read({ budgetMs: 20000, engine: 'on', steady: () => true });
        assert.strictEqual(d.asked.length, n, 'a question uses the fresh live values');
    }

    // an older vehicle.json (before the second unit was known) is read again once
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-eng-'));
    try {
        fs.writeFileSync(path.join(dir, 'vehicle.json'), JSON.stringify({ vin: 'WBA00000000000000', units: { 18: 'DME8FF_R' } }));
        const v = new Vehicle({ dataDir: dir, log: quiet });
        v.vin = 'WBA00000000000000';
        await v.identify(car({ 0x12: { f150: '0F242C' }, 0x13: { f150: '0F242C' } }), () => true, () => false);
        assert.deepStrictEqual(v.engineKind(), { dme2: 0x13, diesel: false });
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'vehicle.json'), 'utf8')).v, 2);
    } finally {
        fs.readdirSync(dir).forEach((f) => fs.unlinkSync(path.join(dir, f)));
        fs.rmdirSync(dir);
    }
    console.log('test_copilot_engines: all passed (B48, B58, V8 x5, B57, live rounds)');
})().catch((e) => { console.error(e); process.exit(1); });
