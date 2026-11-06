'use strict';
/**
 * vehicle.js - who this car is, for the AI's context.
 *
 *   - The VIN: MainApp starts every app with "--VIN <vin>" (and oap-sdk reads process.env.VIN);
 *     only when neither has it, one UDS 22 F190 to the engine unit. From it: maker, brand, model
 *     year and BMW's type code. Only characters 1-11 (the same for every car of that type and
 *     plant) are ever used; the serial number (12-17) never leaves the car.
 *   - The engine and gearbox control unit types (UDS 22 F150, once per VIN), which name the
 *     engine family (e.g. the B58 petrol's Bosch unit) and the gearbox (ZF 8-speed, Aisin, DCT...).
 *   - The owner's profile, sent from the phone page: model, tune, modifications, tyres, fuel, use.
 *
 * Read-only and light: the UDS reads are ReadDataByIdentifier in the default session (what any
 * scan tool asks first), run only when the app asks (identify()), only while the car is in a
 * steady state (the caller checks: never while the engine is starting or the car shuts down),
 * and the answers are kept in data/vehicle.json, so a car is asked once, not every start.
 */
const fs = require('fs');
const path = require('path');

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

// World manufacturer identifiers (VIN 1-3) of BMW group cars
const WMI = {
    WBA: { brand: 'BMW', maker: 'BMW AG, Germany' },
    WBS: { brand: 'BMW M', maker: 'BMW M GmbH, Germany' },
    WBY: { brand: 'BMW i', maker: 'BMW AG, Germany' },
    WBX: { brand: 'BMW', maker: 'BMW AG (X model)' },
    '5UX': { brand: 'BMW', maker: 'BMW Manufacturing, Spartanburg USA (X model)' },
    '5UJ': { brand: 'BMW', maker: 'BMW Manufacturing, Spartanburg USA' },
    '5YM': { brand: 'BMW M', maker: 'BMW Manufacturing, Spartanburg USA (X M model)' },
    '3MW': { brand: 'BMW', maker: 'BMW Mexico, San Luis Potosi' },
    '3MF': { brand: 'BMW M', maker: 'BMW Mexico, San Luis Potosi (M model)' },
    LBV: { brand: 'BMW', maker: 'BMW Brilliance, China' },
    X4X: { brand: 'BMW', maker: 'Avtotor, Russia' },
    WMW: { brand: 'MINI', maker: 'MINI (BMW group)' },
    WMZ: { brand: 'MINI', maker: 'MINI (BMW group)' },
};
// VIN 10 = model year; iDrive 7 cars are 2018 on, so only the letters of 2016-2030 count
const YEARS = { G: 2016, H: 2017, J: 2018, K: 2019, L: 2020, M: 2021, N: 2022, P: 2023, R: 2024, S: 2025, T: 2026, V: 2027, W: 2028, X: 2029, Y: 2030 };

// UDS 22 F150 (control unit type index) -> BMW's unit name, for the engine (0x12) and gearbox (0x18)
// units (from idrive7-apps Live Data's sgbd_index.json)
const UNITS = {
    0x12: {
        '0F1090': 'MSD85L6', '0F10A0': 'D73N57A0', '0F1370': 'MSD87', '0F1380': 'MSD87_R0', '0F13E0': 'MSV90', '0F13F0': 'MEVD172',
        '0F1740': 'D72N47A0', '0F1780': 'MSD85YL6', '0F17B0': 'D73N57E0', '0F17B4': 'D73N57E0', '0F17B8': 'D73N57E0', '0F17BC': 'D73N57E0',
        '0F17F0': 'MEVD1725', '0F1810': 'MEVD1724', '0F18A0': 'D72N47A0', '0F1910': 'MEVD172Y', '0F1920': 'D72N47A0', '0F19E0': 'EDMEI1',
        '0F1A10': 'S63TU_R0', '0F1A20': 'N63TU_R0', '0F1D20': 'DME_BX8', '0F1D22': 'DME_BX8', '0F1D24': 'DME_BX8', '0F1D26': 'DME_BX8',
        '0F1EA0': 'S55', '0F1EF0': 'D73N57E0', '0F1F70': 'D75BX7A0', '0F1F80': 'D75BX7A0', '0F1F90': 'D70BX7A0', '0F1FA0': 'D70BX7A0',
        '0F1FE8': 'D83BX7C0', '0F1FF0': 'D83BX7C0', '0F1FF4': 'D83BX7C0', '0F1FF8': 'D83BX7C0', '0F2220': 'N55_ALP',
        '0F2422': 'DME8FF_R', '0F2424': 'DME8FF_R', '0F2426': 'DME8FF_R', '0F2427': 'DME8FF_R', '0F2428': 'DME8FF_R', '0F2429': 'DME8FF_R',
        '0F242A': 'DME8FF_R', '0F242C': 'DME8FF_R', '0F242E': 'DME8FF_R', '0F2460': 'DME8FF_R', '0F25A0': 'DME8FF_R', '0F25A2': 'DME8FF_R',
        '0F2670': 'D83BX7C0', '0F2674': 'D83BX7C0', '0F2678': 'D83BX7C0', '0F267C': 'D83BX7C0', '0F26B4': 'DME8FF_R', '0F26B8': 'DME8FF_R',
        '0F26BC': 'DME8FF_R', '0F26E0': 'DME8FF_R', '0F26E4': 'DME8FF_R', '0F26E8': 'DME8FF_R', '0F28E0': 'DME9FF_R', '0F2930': 'DME8FF_R',
        '0F2C80': 'D94BX7A0', '0F2E00': 'DME98_R',
    },
    0x18: {
        '0F1270': 'GS100A', '0F14B0': 'GSB231', '0F1870': 'DKG_10', '0F1C80': 'GSAW01', '0F21D0': 'GSZFB1', '0F21E0': 'GSZFBHY1',
        '0F2380': 'GSGE01QT', '0F2388': 'GSGE01QW', '0F23A0': 'GSAW02FH', '0F23A8': 'GSAW02FP', '0F25D0': 'GSZFBCE', '0F28F8': 'GSMA02QZ',
        '0F2908': 'GSMA02PU', '0F290C': 'GSMA02PU', '0F2D60': 'GSZF04GF', '0F2D70': 'GSZF04GD', '0F2D80': 'GSZF04GF', '0F2E98': 'GSMA02QZ',
        '0F3530': 'GSZF04GF', '0F3540': 'GSZF04GF',
    },
};
// what a unit name says in words; names not listed are passed on as they are
const FAMILIES = [
    [/^DME8FF_R|^DME9FF_R/, 'Bosch MG1 petrol engine computer of BMW\'s modular B-series engines (B38 / B48 / B58 and their derivatives)'],
    [/^D(70|75|83|94)BX7/, 'Bosch diesel engine computer of BMW\'s modular B-series diesels (B37 / B47 / B57)'],
    [/^D7\dN57/, 'N57 six-cylinder diesel'],
    [/^D7\dN47/, 'N47 four-cylinder diesel'],
    [/^MEVD172/, 'Bosch MEVD17.2 petrol engine computer (N20 / N26 / N55 era)'],
    [/^N55/, 'N55 six-cylinder petrol'],
    [/^S55/, 'S55 M six-cylinder twin-turbo petrol'],
    [/^S63TU/, 'S63 M V8 twin-turbo petrol'],
    [/^N63TU/, 'N63 V8 twin-turbo petrol'],
    [/^GSZF/, 'ZF 8-speed automatic (8HP)'],
    [/^GSAW/, 'Aisin automatic (front-wheel-drive based models)'],
    [/^DKG/, 'dual-clutch gearbox (DCT)'],
];
const describe = (name) => { const f = FAMILIES.find((x) => x[0].test(name)); return f ? name + ' = ' + f[1] : name; };

/** The VIN MainApp started the app with: "--VIN <vin>", "--VIN=<vin>", or the VIN variable. */
function vinFromLaunch(argv, env) {
    argv = argv || [];
    for (let i = 0; i < argv.length; i++) {
        const a = String(argv[i]);
        const v = a === '--VIN' ? argv[i + 1] : a.indexOf('--VIN=') === 0 ? a.slice(6) : null;
        if (v && VIN_RE.test(String(v).trim().toUpperCase())) return String(v).trim().toUpperCase();
    }
    const e = env && env.VIN && String(env.VIN).trim().toUpperCase();
    return e && VIN_RE.test(e) ? e : null;
}

/** What the VIN says, without its serial number. */
function decodeVin(vin) {
    if (!vin || !VIN_RE.test(vin)) return null;
    const w = WMI[vin.slice(0, 3)] || null;
    return {
        descriptor: vin.slice(0, 11),             // type and plant, the same for many cars
        brand: w ? w.brand : null,
        maker: w ? w.maker : null,
        typeCode: vin.slice(3, 7),                // BMW's type code: model, engine, body, market
        year: YEARS[vin[9]] || null,
    };
}

// owner profile fields: free texts (length-capped) and choices (only these values)
const PROFILE_TEXT = { model: 60, power: 40, mods: 160 };
const PROFILE_CHOICE = {
    tune: ['stock', 'stage1', 'stage2', 'stage2plus', 'custom'],
    tyres: ['summer', 'allseason', 'winter', 'semislick', 'runflat'],
    fuel: ['ron95', 'ron98', 'ron100', 'e85', 'diesel'],
    use: ['daily', 'spirited', 'track', 'towing', 'touring'],
    lang: ['en', 'ka', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'tr', 'pl'],    // the answer language (ai.js LANGUAGES)
};
const PROFILE_WORDS = {
    tune: { stock: 'stock (no tune)', stage1: 'Stage 1 software tune', stage2: 'Stage 2 tune (software + hardware)', stage2plus: 'beyond Stage 2 (turbo / fuel upgrades)', custom: 'custom tune' },
    tyres: { summer: 'summer tyres', allseason: 'all-season tyres', winter: 'winter tyres', semislick: 'semi-slick track tyres', runflat: 'run-flat tyres' },
    fuel: { ron95: '95 RON / 91 AKI', ron98: '98 RON / 93 AKI', ron100: '100+ RON', e85: 'ethanol blend (E30-E85)', diesel: 'diesel' },
    use: { daily: 'daily driving', spirited: 'spirited road driving', track: 'track days', towing: 'towing', touring: 'long trips' },
};
const clean = (s, max) => String(s === undefined || s === null ? '' : s).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Only known fields, texts cut to their length, choices from their list; null when empty. */
function cleanProfile(p) {
    if (!p || typeof p !== 'object') return null;
    const out = {};
    Object.keys(PROFILE_TEXT).forEach((k) => { const v = clean(p[k], PROFILE_TEXT[k]); if (v) out[k] = v; });
    Object.keys(PROFILE_CHOICE).forEach((k) => { if (PROFILE_CHOICE[k].indexOf(p[k]) >= 0) out[k] = p[k]; });
    return Object.keys(out).length ? out : null;
}

/** The profile in words for the AI, one line per field. */
function profileLines(p) {
    if (!p) return [];
    const l = [];
    if (p.model) l.push('Model (owner): ' + p.model);
    if (p.tune) l.push('Tune: ' + PROFILE_WORDS.tune[p.tune]);
    if (p.power) l.push('Power (owner): ' + p.power);
    if (p.mods) l.push('Modifications: ' + p.mods);
    if (p.tyres) l.push('Tyres: ' + PROFILE_WORDS.tyres[p.tyres]);
    if (p.fuel) l.push('Fuel used: ' + PROFILE_WORDS.fuel[p.fuel]);
    if (p.use) l.push('Mostly used for: ' + PROFILE_WORDS.use[p.use]);
    return l;
}

class Vehicle {
    constructor(opts) {
        this.log = opts.log || console;
        this.file = path.join(opts.dataDir || __dirname, 'vehicle.json');
        this.profileFile = path.join(opts.dataDir || __dirname, 'car_profile.json');
        this.cache = {};
        try { this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch (e) { /* first start */ }
        this.profile = null; this.profileAt = 0;
        try { const p = JSON.parse(fs.readFileSync(this.profileFile, 'utf8')); this.profile = cleanProfile(p.profile); this.profileAt = p.time || 0; } catch (e) { /* none yet */ }
        this.vin = vinFromLaunch(opts.argv || process.argv, opts.env || process.env) || (VIN_RE.test(this.cache.vin || '') ? this.cache.vin : null);
        this.engineType = null;          // 'petrol' / 'diesel' / 'hybrid' / 'electric' (Vehicle2.statusVehiclePartType)
        this.busy = null;
        this.tried = false;
    }

    _save() {
        try { fs.writeFileSync(this.file, JSON.stringify(this.cache)); } catch (e) { this.log.warn('vehicle.json: ' + e.message); }
    }

    /**
     * Ask the car what the start arguments didn't tell (VIN, engine and gearbox unit types): once
     * per VIN, while steady() says the car is in a steady state. diag = a kit/diag Diag (available).
     */
    identify(diag, steady) {
        if (this.busy) return this.busy;
        const sameCar = this.cache.vin && this.vin && this.cache.vin === this.vin;
        if (this.tried || (this.vin && sameCar && this.cache.units)) return Promise.resolve();
        if (!diag || !diag.available || (steady && !steady())) return Promise.resolve();
        const read = async (ecu, did) => {
            const r = await diag.physical(ecu, 0x22, [did >> 8, did & 0xFF], 3000);
            return r && r[0] === 0x62 ? r.slice(3) : null;
        };
        this.busy = (async () => {
            try {
                if (!this.vin) {
                    const b = await read(0x12, 0xF190);
                    const v = b ? String.fromCharCode.apply(null, b.slice(0, 17)).toUpperCase() : '';
                    if (VIN_RE.test(v)) this.vin = v;
                }
                const units = {};
                let complete = true;
                for (const ecu of [0x12, 0x18]) {
                    if (steady && !steady()) { complete = false; break; }   // the engine started meanwhile: next time
                    const b = await read(ecu, 0xF150);
                    const idx = b && b.length >= 3 ? b.slice(0, 3).map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('') : null;
                    if (idx && UNITS[ecu][idx]) units[ecu] = UNITS[ecu][idx];
                }
                if (!complete) return;
                this.tried = true;
                this.cache = { vin: this.vin, units };
                this._save();
                this.log.info('M-Copilot: vehicle: ' + (this.vin ? this.vin.slice(0, 11) : 'no VIN') + ', units ' + JSON.stringify(units));
            } catch (e) {
                this.log.warn('M-Copilot: vehicle identification: ' + (e.message || e));
            } finally {
                this.busy = null;
            }
        })();
        return this.busy;
    }

    /** The phone's profile; an older message (a replay) never replaces a newer one. */
    setProfile(p, time) {
        time = typeof time === 'number' ? time : Date.now();
        if (time <= this.profileAt) return false;
        this.profile = cleanProfile(p);
        this.profileAt = time;
        try { fs.writeFileSync(this.profileFile, JSON.stringify({ time, profile: this.profile })); } catch (e) { this.log.warn('car_profile.json: ' + e.message); }
        return true;
    }

    /** Identity lines for the AI (no serial number). */
    lines() {
        const l = [];
        const d = decodeVin(this.vin);
        if (d) {
            l.push('Make: ' + (d.brand || 'BMW group') + (d.maker ? ' (' + d.maker + ')' : ''));
            if (d.year) l.push('Model year (from the VIN): ' + d.year);
            l.push('BMW type code (VIN characters 4-7): ' + d.typeCode + '; VIN without serial: ' + d.descriptor);
        }
        if (this.engineType) l.push('Engine type (car signal): ' + this.engineType);
        const units = (this.vin && this.cache.vin === this.vin && this.cache.units) || {};
        if (units[0x12]) l.push('Engine control unit: ' + describe(units[0x12]));
        if (units[0x18]) l.push('Gearbox control unit: ' + describe(units[0x18]));
        return l.concat(profileLines(this.profile));
    }
}

// Vehicle2.statusVehiclePartType typeEngine: names, or the wire numbers known for sure
const ENGINE_TYPES = {
    BENZIN_DIREKTEINSPRITZUNG: 'petrol (direct injection)', BENZIN_KONVENTIONELL: 'petrol', DIESEL_DIREKTEINSPRITZUNG: 'diesel',
    DIESEL_KONVENTIONELL: 'diesel', ELEKTROMOTOR: 'electric', HYBRIDMOTOR: 'hybrid', 4: 'petrol', 5: 'petrol', 6: 'diesel', 7: 'diesel',
};
Vehicle.engineTypeOf = (raw) => (raw !== undefined && raw !== null && Object.prototype.hasOwnProperty.call(ENGINE_TYPES, raw) ? ENGINE_TYPES[raw] : null);
Vehicle.vinFromLaunch = vinFromLaunch;
Vehicle.decodeVin = decodeVin;
Vehicle.cleanProfile = cleanProfile;
Vehicle.PROFILE_CHOICE = PROFILE_CHOICE;
module.exports = Vehicle;
