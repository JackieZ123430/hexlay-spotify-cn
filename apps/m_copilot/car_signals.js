'use strict';
/**
 * car_signals.js - what M-Copilot reads from the car's own SOME/IP fields beyond kit/car's groups, decoded
 * as cauliflowermossgrape/idrive7-apps reads them (MIT License): Live Data's signals.js for the enums and
 * scalings, Ambient config / Live Adjustments / Redline for the driving modes, M Vitals for the units, the
 * tyres and the gearbox programme, eDrive for climate and the high-voltage battery, Service for the service
 * list and Fault Scanner for Check Control.
 *
 *   const sig = carSignals(telemetry, { vehicle, Vehicle, log });
 *   new Car(ctx, groups, sig.extra, { poll: sig.poll });
 *   sig.reset()       // back on screen: Check Control's list starts again
 *
 * Enums come as names or as wire numbers, numbers sometimes as digit strings. A name not in a table (another
 * software level) is kept in words, as Live Data shows it; the "no value" names (UNGUELTIG, SIGNAL_UNBEFUELLT,
 * INITIALISIERUNG ...) and the tables' null entries mean nothing is known. Each field's first raw values are
 * logged once, so a log shows what a car sends.
 */

// fields a car may not notify, read again this often (as Live Data, Service and eDrive do: BMW's x_call only reads TPMS)
const POLL = {
    'de.bmw.infotainment.vehicle.TPMS': 10000,
    'de.bmw.infotainment.KombiIF': 10000,
    'de.bmw.infotainment.climate.Climate2': 10000,
    'de.bmw.infotainment.drivingexcitement.Efficiencytainment2': 30000,
    'de.bmw.infotainment.KombiInterface_2': 60000,
};

const NO_ENUM = /UNGUELTIG|UNBEFUELLT|INITIALISIERUNG|NICHT_VERFUEGBAR|NICHT_CODIERT|RESERVIERT|FEHLER|INVALID|SIGNAL_/;
/** an enum name in words: SPORT_INDIVIDUAL -> Sport individual */
function words(x) {
    const s = String(x).replace(/_+/g, ' ').trim().toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
}
/**
 * An enum value -> its text from map, or null (nothing known). Digit strings count as their number; a name
 * not in the map is shown in words, a number not in it (or a "no value" name) is null.
 */
function enumText(map, raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) raw = Number(raw.trim());
    if (Object.prototype.hasOwnProperty.call(map, raw)) return map[raw];
    if (typeof raw !== 'string') return null;
    const up = raw.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(map, up)) return map[up];
    return NO_ENUM.test(up) ? null : words(raw);
}

// actualValueModeDrivingExperience: names and wire numbers (Ambient config, Live Adjustments, Live Data)
const DRIVE_MODES = {
    1: 'Sport', 2: 'Sport plus', 3: 'Sport individual', 4: 'Comfort', 5: 'Comfort plus', 6: 'Comfort individual',
    7: 'Eco pro', 8: 'Eco pro plus', 9: 'Eco pro individual', 10: 'Adaptive',
    // the plug-in hybrids' own modes (330e, X5 45e ...)
    15: 'Sport (hybrid)', 16: 'Sport individual (hybrid)', 17: 'Hybrid', 18: 'Hybrid eco pro', 19: 'Hybrid comfort',
    20: 'Electric', 21: 'Electric individual', 22: 'Battery control', 23: 'Sport plus (hybrid)', 28: 'Sport boost',
    0: null, 61: null, 62: null, 63: null,
    SPORT_DYNAMIC: 'Sport', SPORT_EXPERT: 'Sport plus', SPORT_INDIVIDUAL: 'Sport individual', COMFORT: 'Comfort', COMFORT_PLUS: 'Comfort plus',
    COMFORT_INDIVIDUAL: 'Comfort individual', ECO_PRO_EFFICIENT: 'Eco pro', ECO_PRO_PLUS: 'Eco pro plus', ECO_PRO_INDIVIDUAL: 'Eco pro individual',
    ADAPTIVE: 'Adaptive', PHEV_SPORT_STANDARD: 'Sport (hybrid)', PHEV_SPORT_INDIVIDUAL: 'Sport individual (hybrid)', PHEV_HYBRID_STANDARD: 'Hybrid',
    PHEV_HYBRID_ECO: 'Hybrid eco pro', PHEV_HYBRID_COMFORT: 'Hybrid comfort', PHEV_ELECTRIC_STANDARD: 'Electric', PHEV_ELECTRIC_INDIVIDUAL: 'Electric individual',
    PHEV_SPORT_PLUS: 'Sport plus (hybrid)', BOOST: 'Sport boost',
};
const OIL_LEVELS = { MOTOROELSTAND_UNTER_MINIMUM: 'below minimum', MOTOROELSTAND_AM_MINIMUM: 'at minimum', MOTOROELSTAND_1_4: '1/4', MOTOROELSTAND_2_4: '2/4',
    MOTOROELSTAND_3_4: '3/4', MOTOROELSTAND_4_4: 'full', MOTOROELSTAND_5_4: 'above full', MOTOROELSTAND_UEBERFUELLT: 'overfilled', MOTOROELSTAND_OK: 'OK',
    SERVICEFUNKTION_AKTIV: 'measuring now', 0: 'below minimum', 1: 'at minimum', 2: '1/4', 3: '2/4', 4: '3/4', 5: 'full', 6: 'above full', 7: 'overfilled',
    13: 'OK', 14: 'measuring now', 15: null };
const ENGINE_STATES = { MOTOR_AUS: 'off', MOTOR_STARTET: 'starting', MOTOR_LAEUFT: 'running', 0: 'off', 1: 'starting', 2: 'running', 3: null };
const HANDBRAKE = { HANDBREMSE_ANGEZOGEN: 'applied', HANDBREMSE_GELOEST: 'released', 1: 'released', 2: 'applied', 0: null, 3: null };
const MSA = { MSA_AKTIVIERT: 'on', MSA_DEAKTIVIERT: 'off', 0: 'off', 1: 'on', 3: null };
const AWD = { _4WD_STANDARD: '4WD', _4WD_ALTERNATIV: '4WD Sport', _2WD: '2WD (rear-wheel drive)', AWDSAND: 'Sand' };
// MDrive.dataDisplayGearbox: the programme the cluster shows next to the gear (M Vitals, Redline: 0 = D)
const PROGRAMMES = { S_MINUS_PROGRAMM: 'S (sport)', M_MINUS_PROGRAMM: 'M (manual)', D_MINUS_PROGRAMM: 'D', 0: 'D', 1: 'S (sport)', 2: 'M (manual)' };
const CONS_UNITS = { VERBRAUCH_IN_L_S_100KM: 'l/100 km', VERBRAUCH_IN_MPG_UK: 'mpg (UK)', VERBRAUCH_IN_MPG_US: 'mpg (US)', VERBRAUCH_IN_KM_S_L: 'km/l',
    1: 'l/100 km', 2: 'mpg (UK)', 3: 'mpg (US)', 4: 'km/l' };
const SPEED_UNITS = { KM_S_H__KM: 'km/h', MPH__MLS: 'mph', 1: 'km/h', 2: 'mph' };
const UNIT_PRESS = { 1: 'BAR', 2: 'KPA', 3: 'PSI', BAR: 'BAR', KPA: 'KPA', PSI: 'PSI' }, UNIT_TEMP = { 1: 'C', 2: 'F', C: 'C', F: 'F' };
const AC_ON = { 1: true, KLIMAANLAGE_EIN: true, 0: false, KLIMAANLAGE_AUS: false };
// service list (as idrive7-apps Service reads it): ids in English, colours as states
const CBS_NAMES = { 1: 'Engine oil', 2: 'Front brake pads', 3: 'Brake fluid', 6: 'Rear brake pads', 7: 'Particulate filter', 10: 'Spark plugs',
    13: 'NOx additive (AdBlue)', 17: 'Vehicle check', 32: 'Statutory inspection', 33: 'Emissions test', 35: 'Transmission oil', 100: 'Vehicle check' };
const CBS_STATES = { RED: 'overdue', YELLOW: 'due soon', ORANGE: 'due soon', GREEN: 'OK', 1: 'overdue', 2: 'due soon', 4: 'due soon', 3: 'OK' };

/** a number from a field (digit strings too), else null */
const num = (x) => (typeof x === 'number' && isFinite(x) ? x : typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x.trim()) ? Number(x) : null);
/** the first struct (depth first) holding key */
function findKey(v, key) {
    if (!v || typeof v !== 'object') return null;
    if (key in v) return v;
    for (const k of Object.keys(v)) { const r = findKey(v[k], key); if (r) return r; }
    return null;
}
const pick = (v, key) => { const o = findKey(v, key); return o ? o[key] : undefined; };
const carText = (x) => String(x === undefined || x === null ? '' : x).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60);
const walk = (o, fn) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach((x) => walk(x, fn)); return; }
    fn(o);
    Object.keys(o).forEach((k) => { if (o[k] && typeof o[k] === 'object') walk(o[k], fn); });
};

/**
 * The handlers for kit/car's extra watches, writing into telemetry (null = not known). opts.vehicle gets the
 * engine type; opts.Vehicle.engineTypeOf decodes it.
 */
function carSignals(telemetry, opts) {
    opts = opts || {};
    const log = opts.log || { info() {} };
    const seen = {};
    /** each field's first different raw values in the log (up to 8), to see what a car sends */
    const logRaw = (what, raw) => {
        const k = JSON.stringify(raw), l = seen[what] || (seen[what] = []);
        if (l.length >= 8 || l.indexOf(k) >= 0) return;
        l.push(k);
        log.info('car ' + what + ': ' + (k && k.length > 160 ? k.slice(0, 160) + '...' : k));
    };
    const units = () => telemetry.units || (telemetry.units = {});

    // Check Control: active message ids (CheckControlMaster) and their texts (the cluster's lists)
    const ccActive = new Map(), ccNames = new Map();
    const ccUpdate = () => {
        telemetry.checkControl = Array.from(ccActive.keys()).map((id) => (ccNames.get(id) || 'Check Control message ' + id));
    };
    const ccNamesFrom = (v) => {
        walk(v, (o) => {
            const id = o.cCIdentifer !== undefined ? o.cCIdentifer : o.cCIdentifier, nm = o.cCShortName || o.cCName;
            if (id !== undefined && nm) ccNames.set(id, carText(nm));
        });
        if (telemetry.checkControl) ccUpdate();
    };

    // tyre pressures come as 0.1 x the car's own unit; each unit's plausible range is apart (as M Vitals reads them)
    let tyreFahrenheit = false;
    const tyreBar = (x) => {
        const raw = num(x);
        if (raw === null || raw >= 65532) return null;
        const v = raw * 0.1, known = units().press;
        if (known === 'PSI') return v >= 7 && v < 90 ? v / 14.5038 : null;
        if (known === 'KPA') return v >= 50 && v <= 600 ? v / 100 : null;
        if (known === 'BAR') return v >= 0.5 && v <= 6 ? v : null;
        if (v >= 0.5 && v <= 6) return v;
        if (v >= 7 && v < 60) { tyreFahrenheit = true; return v / 14.5038; }     // psi (the car then uses deg F too)
        if (v >= 60 && v <= 600) return v / 100;                                 // kPa
        return null;
    };
    const tyreC = (x) => {
        const raw = num(x);
        if (raw === null || raw >= 65535) return null;
        const v = raw - 40, c = tyreFahrenheit ? (v - 32) * 5 / 9 : v;
        return c >= -40 && c <= 150 ? c : null;
    };
    const corners4 = (v, keys, fn) => {
        v = v || {};
        const o = { fl: fn(v[keys[0]]), fr: fn(v[keys[1]]), rl: fn(v[keys[2]]), rr: fn(v[keys[3]]) };
        return [o.fl, o.fr, o.rl, o.rr].every((x) => x !== null) ? o : null;
    };
    // an enum field: logged, decoded; a value that says nothing keeps the last one when keep (the driving mode
    // as the car switches off: Redline)
    const en = (key, map, what, keep) => (raw) => {
        logRaw(what, raw);
        const t = enumText(map, raw);
        if (t !== null || !keep) telemetry[key] = t;
    };

    const extra = {
        'de.bmw.infotainment.vehicle.TPMS': {
            statusTyrePressure: (v) => {
                logRaw('tyre pressure', v);
                telemetry.tyres = corners4(v, ['actualValuePressureTyreFLH', 'actualValuePressureTyreFRH', 'actualValuePressureTyreRLH', 'actualValuePressureTyreRRH'], tyreBar);
            },
            statusTargetTyrePressure: (v) => { telemetry.tyreTargets = corners4(v, ['targetPressureTyreFLH', 'targetPressureTyreFRH', 'targetPressureTyreRLH', 'targetPressureTyreRRH'], tyreBar); },
            statusTyreTemperature: (v) => {
                logRaw('tyre temperature', v);
                telemetry.tyreTemps = corners4(v, ['actualValueTemperatureTyreFLH', 'actualValueTemperatureTyreFRH', 'actualValueTemperatureTyreRLH', 'actualValueTemperatureTyreRRH'], tyreC);
            },
        },
        'de.bmw.infrastructure.EnvironmentalInformation': {
            ExteriorTemperature: (v) => {
                const r = num(v && v.temperatureExterior), c = r === null || r === 255 ? null : r * 0.5 - 40;
                telemetry.ambient = c !== null && c >= -50 && c <= 60 ? c : null;
            },
        },
        'de.bmw.infotainment.KombiIF': {
            statusRangeTankStatus: (v) => {
                v = v || {};
                logRaw('tank', [v.fluidLevelFuelTank, v.range, v.mileageKilometre]);
                const tank = num(v.fluidLevelFuelTank), range = num(v.range), odo = num(v.mileageKilometre);
                telemetry.fuelL = tank !== null && tank < 255 ? tank : null;
                telemetry.rangeKm = range !== null && range < 4095 ? range : null;
                if (odo !== null && odo > 0 && odo < 16777215) telemetry.odoKm = odo;
            },
            // trip computer 1 (scaling as Live Data reads it: 0.1 a step, in the cluster's unit)
            statusBordcomputerAverage: (v) => {
                v = v || {};
                const r = num(v.consumptionAverage1BC1), unit = enumText(CONS_UNITS, v.statusUnitOfMeasurementConsumptionBC);
                telemetry.avgCons = r !== null && r > 0 && r < 65535 && unit ? { value: r * 0.1, unit } : null;
                if (unit) units().cons = unit;
                const sp = enumText(SPEED_UNITS, v.statusUnitOfMeasurementSpeedBC);
                if (sp) units().speed = sp;
            },
        },
        'de.bmw.infotainment.vehicle.CDS': {
            statusBattery2: (v) => { const r = num(v && v.conditionBatteryChargingCondition); telemetry.batteryPct = r !== null && r >= 0 && r <= 100 ? r : null; },
            statusEngineStatus: (v) => en('engine', ENGINE_STATES, 'engine state')(v && v.statusEngineRunDrive),
            statusHandBrake: (v) => en('handbrake', HANDBRAKE, 'parking brake')(v && v.statusContactHandBrake),
        },
        'de.bmw.infotainment.vehicle.CDS2': {
            statusPushButtonMSA2: (v) => en('msa', MSA, 'start-stop')(v && v.statusFunctionMSA),
        },
        'de.bmw.infotainment.vehicle.Vehicle2': {
            statusOilDipstick2: (v) => en('oilLevel', OIL_LEVELS, 'oil level')(v && v.fluidLevelEngineOilRelative),
            statusVehiclePartType: (v) => {
                logRaw('engine type', v && v.typeEngine);
                const t = opts.Vehicle && opts.Vehicle.engineTypeOf(v && v.typeEngine);
                if (t && opts.vehicle) opts.vehicle.engineType = t;
            },
        },
        'de.bmw.infotainment.drivingexcitement.FES': {
            statusFESVehicleDynamicSwitchHMI: (v) => en('mode', DRIVE_MODES, 'driving mode', true)(v && v.actualValueModeDrivingExperience),
            // in the car's pressure unit, as BMW's sport display shows it: 0.01 bar (or 1 kPa) a step, 0.1 psi a step on a
            // car set to psi (idrive7-apps #186: 20 psi sent as raw 200 was read as 2.0 bar)
            statusSwitchDriveDynamicSport2: (v) => {
                const r = num(v && v.displayBoostPressure);
                telemetry.boost = r !== null && r !== 255 && r >= 0 ? (units().press === 'PSI' ? r * 0.1 / 14.5038 : r * 0.01) : null;
            },
            // the sport display's share of the engine's maximum power and torque
            statusVehicleDynamicEngine: (v) => {
                v = v || {};
                const p = num(v.displaySportEnginePower), q = num(v.displaySportEngineTorque);
                telemetry.powerPct = p !== null && p >= 0 && p <= 100 ? p : null;
                telemetry.torquePct = q !== null && q >= 0 && q <= 100 ? q : null;
            },
        },
        // the car's display units (as BMW's x_call / M Vitals read them): answers use them
        'de.bmw.infotainment.vehicle.Vehicle': {
            statusNewCurrentUnitsStatusExt: (v) => {
                logRaw('units', v && [v.unitOfMeasurementAirPressure, v.unitOfMeasurementTemperature]);
                const pr = UNIT_PRESS[v && v.unitOfMeasurementAirPressure], tp = UNIT_TEMP[v && v.unitOfMeasurementTemperature];
                if (pr) units().press = pr;
                if (tp) { units().temp = tp; tyreFahrenheit = tp === 'F'; }
            },
        },
        // M xDrive setting (M models only); the S / M programme the cluster shows next to the gear (M Vitals)
        'de.bmw.infotainment.misc.MDrive': {
            statusMSystem: (v) => en('awd', AWD, 'M xDrive')(v && v.statusAllWheelSetup),
            dataDisplayGearbox: (v) => en('programme', PROGRAMMES, 'gearbox programme')(v && v.displayProgramGearbox),
        },
        // climate and the high-voltage battery, as eDrive reads them
        'de.bmw.infotainment.climate.Climate2': {
            statusACFront: (v) => { const r = pick(v, 'statusAircon'); logRaw('A/C', r); telemetry.ac = r === undefined || AC_ON[r] === undefined ? null : AC_ON[r]; },
        },
        'de.bmw.infotainment.drivingexcitement.Efficiencytainment2': {
            statusBatteryTemperature: (v) => {
                const r = num(pick(v, 'actualValueTemperatureHighVoltageStorage'));
                telemetry.hvTemp = r !== null && r !== 255 && r - 50 > -30 && r - 50 < 70 ? r - 50 : null;
            },
        },
        'de.bmw.infotainment.lsc.LSCDataSink': {
            statusHighVoltageStorage: (v) => {
                const x = num(pick(v, 'actualValueVoltageHighVoltageStorage')), volts = x === null ? null : x > 1500 ? x / 10 : x;     // 0.1 V on the X5 45e
                telemetry.hvVolt = volts !== null && volts > 150 && volts < 500 ? volts : null;
            },
        },
        // Check Control: the warning messages active in the cluster now (as idrive7-apps Fault Scanner reads them)
        'de.bmw.infotainment.checkcontrol.CheckControlMaster': {
            basicList: (v) => {
                walk(v, (o) => {
                    if (o.ccmId === undefined) return;
                    if (o.activeState === 'AKTIV' || o.activeState === 0) ccActive.set(o.ccmId, true); else ccActive.delete(o.ccmId);
                });
                ccUpdate();
            },
        },
        // the cluster's lists: Check Control texts, the service list the iDrive's Service requirements page shows
        'de.bmw.infotainment.KombiInterface_2': {
            ccList: (v) => ccNamesFrom(v),
            newCCMessage: (v) => ccNamesFrom(v),
            // the summary: the next service the car asks for (as idrive7-apps Service reads it)
            cbsDataSBA: (v) => {
                const c = findKey(v, 'cBSDataSBAText') || {};
                const text = carText(c.cBSDataSBAText);
                telemetry.serviceNext = text ? { text, way: carText(c.cBSDataSBADistance), date: carText(c.cBSDataSBADate) } : null;
            },
            cbsDataServiceList: (v) => {
                const arr = Array.isArray(v) ? v : (v && (v.cbsDataServiceList || v.value)) || [];
                const items = (Array.isArray(arr) ? arr : []).map((e) => {
                    const c = findKey(e, 'cBSIdentifier') || {};
                    const carName = carText(c.cBSServcieName || c.cBSServiceName);
                    return { name: CBS_NAMES[c.cBSIdentifier] || carName, way: carText(c.cBSServiceWay), date: carText(c.cBSServiceDate),
                        state: CBS_STATES[c.cBSColor] || null };
                }).filter((i) => i.name);
                // an empty list is an answer too: nothing due
                telemetry.service = items;
            },
        },
    };

    return {
        extra,
        poll: POLL,
        /** back on screen: Check Control's active list starts again (each subscription sends it again) */
        reset() { ccActive.clear(); },
    };
}

carSignals.enumText = enumText;
carSignals.words = words;
carSignals.DRIVE_MODES = DRIVE_MODES;
carSignals.POLL = POLL;
module.exports = carSignals;
