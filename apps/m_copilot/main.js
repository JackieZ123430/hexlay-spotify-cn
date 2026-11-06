'use strict';
/**
 * M-Copilot - an AI co-driver for BMW iDrive 7 that answers with this car's own data.
 *
 *   - One screen: the phone pairing QR code until an AI key is paired, then the co-driver.
 *   - Pairing over the internet (ntfy relay, end-to-end encrypted with the car's own key): the phone
 *     page sends the AI key, and optionally the owner's car profile (model, tune, mods, tyres, fuel).
 *   - 24 topic chips in 4 categories, worded for a stock daily car as well as a tuned one:
 *       CHECK     health check, warning lights / fault memory, service due, tyres, brakes, 12 V battery
 *       DRIVE     ready for full power, fuel and range, weather grip, how was that drive, running hot, cool-down
 *       PERFORM   launch, track day prep, tune health, heat soak, gearbox and clutch load, mods
 *       KNOW-HOW  oil spec, gearbox care, fuel and octane, known weak points, due at this mileage, trip prep
 *     plus an on-screen keyboard for any question (follow-up questions keep the context).
 *   - What the AI is told (ai.js buildVehicleContext): only what the car reported - live driving
 *     signals, temperatures, tyres, fuel, odometer, the cluster's service list, the fault memory
 *     when asked about - and who the car is (vehicle.js: make, model year and type from the VIN,
 *     engine and gearbox unit types, the owner's profile). Anything unknown is said to be unknown.
 *   - Read-only. Signals are passive subscriptions, only while the screen is shown. Diagnostic reads
 *     (fault memory, VIN / unit types once) run only when a question needs them and only while the car
 *     is in a steady state: never while the engine is starting or the car is shutting down.
 *   - Foreground only: signals, pairing polls and timers stop when the screen is left.
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { AiBridge } = require('./ai');
const { CloudPairManager } = require('./cloud_pair');
const tlsDates = require('./tls_dates');
const qrcodegen = require('./qrcodegen');

const W = 1600, H = 520;
const PAGES = ['M-Copilot', 'Data check', 'Connect'];

// Topic chips. Each question leans on what the car reports (the AI gets it with every question) and
// on the car profile, so the same chip fits a stock daily car and a tuned one. faults: read the
// fault memory first (a few seconds).
const TOPIC_CATEGORIES = [
    {
        id: 'check',
        name: 'CHECK',
        label: 'Health & Service',
        topics: [
            { title: 'Quick Health Check', faults: true, query: 'Do a health check of my car from every reading you have, the warning messages in the cluster, the service list and the fault memory. Start with anything that needs attention and how urgent it is; if all is fine, say so in one line.' },
            { title: 'Warning Lights & Faults', faults: true, query: 'Which warning messages is my car showing and what is stored in its fault memory, in which units? How serious is it, and can I keep driving normally?' },
            { title: 'Service Due', query: 'From my car\'s service list: what is due next and when, what does each item involve for my engine, and what can I check or do myself?' },
            { title: 'Tyres & Pressures', query: 'Compare my tyre pressures and temperatures with the targets set in the car, taking the outside temperature and my tyre type into account. Should I adjust anything, cold or hot?' },
            { title: 'Brakes & Pads', query: 'How are my brakes from the service list (front and rear pads, brake fluid due date), and which warning signs can I check myself before the next service?' },
            { title: '12V Battery & Start-Stop', query: 'How is my 12 V battery from its charge level, and what does that mean for auto start-stop, short trips and the car standing for a few days?' },
        ],
    },
    {
        id: 'drive',
        name: 'DRIVE',
        label: 'Right Now',
        topics: [
            { title: 'Ready for Full Power?', query: 'Is my engine warm enough for full throttle and high revs right now? Use the oil and coolant temperatures, and say what threshold you use for my engine and tune.' },
            { title: 'Fuel & Range', query: 'How far can I go on the fuel I have, how does my consumption look, and what would make the biggest difference to it on this trip?' },
            { title: 'Weather & Grip', query: 'With the outside temperature and my tyres as they are now, how much grip should I expect, is there a risk of ice or cold tyres, and what should I change in how I drive?' },
            { title: 'How Was That Drive?', query: 'Look at this drive so far: how hard was the car driven, was the engine warm before it was pushed, any heat soak, boost falling short or timing pulled? Anything to change next time?' },
            { title: 'Running Hot? What Now', query: 'Look at my temperatures right now: is anything running too hot (coolant, oil, gearbox, intake air)? If so, exactly what should I do on the road right now to protect the engine?' },
            { title: 'Cool-Down & Parking', query: 'After how I have been driving, should I let the engine idle or drive gently before switching off? Use the oil and coolant temperatures and say why it matters for my engine and tune.' },
        ],
    },
    {
        id: 'perform',
        name: 'PERFORM',
        label: 'Spirited, Track & Tuned',
        topics: [
            { title: 'Launch & 0-100', query: 'How do I use launch control on my car (gearbox and drivetrain), what must be met for it to work, are my temperatures ready for it now, and how hard is it on the drivetrain with my tune?' },
            { title: 'Track Day Prep', query: 'Get my car ready for a track day: tyre pressures cold and hot for my tyres, brake fluid and pads from the service list, oil level and cooling, and the settings to use. Use my readings.' },
            { title: 'Tune Health Check', query: 'Look at my boost, torque and temperatures for signs of heat soak, an engine running too hard or a weak point of my tune. For a stock car, say what is normal for it and what headroom it has.' },
            { title: 'Heat Soak & Cooling', query: 'Are my oil and coolant temperatures OK for hard driving right now? At what temperatures does my engine pull power, and how do I manage heat on back-to-back pulls or laps?' },
            { title: 'Gearbox & Clutch Load', query: 'With my engine\'s torque and my tune, how close is my gearbox (and its clutch or torque converter) to its limits, what does its oil temperature say right now, and how do I avoid hurting it?' },
            { title: 'Mods & Upgrade Path', query: 'For my car and its current modifications, what is the most sensible next upgrade, what supporting parts does it need, and what does it risk (reliability, warranty, inspection)?' },
        ],
    },
    {
        id: 'knowhow',
        name: 'KNOW-HOW',
        label: 'Ownership',
        topics: [
            { title: 'Oil Spec & Level', query: 'Which BMW oil approval and viscosity does my engine need (and with my tune and use), how much does it hold, what does my oil level reading say, and how do I top up correctly?' },
            { title: 'Gearbox Care', query: 'What gearbox does my car have, when should its fluid be changed (BMW says lifetime; what is realistic for my use and tune), and what is an adaptation reset for?' },
            { title: 'Fuel & Octane', query: 'Which fuel should my engine and tune run on, what happens on lower octane (knock, timing pulled, power), and is an ethanol blend an option?' },
            { title: 'Known Weak Points', query: 'What are the known weak points of my engine and model at my mileage, what are their early signs, and what should I check or replace before it fails?' },
            { title: 'Due at This Mileage', query: 'At my mileage and the car\'s age, what maintenance is due or coming up beyond the service list (spark plugs, coolant, gearbox and differential oil, brake fluid, belts), and roughly when?' },
            { title: 'Long Trip Prep', query: 'I am about to go on a long trip: check my readings (oil level, tyres, fuel, battery, service list, faults if read) and tell me what to sort out before leaving.' },
        ],
    },
];

mgu.run({
    async start(ctx) {
        const { ui, settings, log, signals } = ctx;
        const ai = new AiBridge(ctx);
        const cloudPair = new CloudPairManager(ctx, ai);
        // Foreground only: vehicle data, pairing polls, internet checks and the thinking animation
        // run while the screen is shown. The pairing itself (keys, channel) is kept; messages the
        // phone sends meanwhile wait on the channel and are read when the app is opened again.
        const onScreen = () => !ctx.ui.isVisible || ctx.ui.isVisible('MAIN');
        ai.isOnScreen = onScreen;
        cloudPair.isOnScreen = onScreen;

        /*
         * The car's hello to the phone pages (encrypted, like everything the car tells the phone):
         * paired, its version, and what the phone pages set - AI provider and model, car profile,
         * never the AI key - so a page opened in another browser shows the same. Sent on pairing,
         * when a page asks, after each change, and when opened at most every 6 hours (the relay
         * keeps it 12 h, for a page opened while the car is off).
         */
        let lastHello = 0;
        function hello() {
            lastHello = Date.now();
            cloudPair.tellPhone({ type: 'car_hello', app: 'm_copilot', paired: true, version: (ctx.spec && ctx.spec.version) || '',
                settings: { provider: providerId(), model: ai.config.model || '', profile: vehicle.profile || null } }, 'BMW M-Copilot');
        }
        cloudPair.onHelloRequest = () => hello();
        // phone notifications were dropped in 1.0.17: the push keys and phone list they kept go
        try { require('fs').unlinkSync(require('path').join(ctx.dataDir, 'copilot_push.json')); } catch (e) { /* none */ }

        let isThinking = false;
        let thinkTimer = null;
        let thinkStart = 0;
        let lastRenderTime = 0;
        let dialogueScroll = 0;
        let dialogueRows = { count: 0, visible: 11 };
        let dialogueAcc = 0;
        let rowH = 26;                      // the dialogue's line height (bigger while moving)
        ctx.onScroll((dy) => {
            const max = Math.max(0, dialogueRows.count - dialogueRows.visible);
            dialogueAcc += dy;
            const rows = dialogueAcc > 0 ? Math.floor(dialogueAcc / rowH) : Math.ceil(dialogueAcc / rowH);
            if (!rows) return (dy > 0 && dialogueScroll < max) || (dy < 0 && dialogueScroll > 0);
            dialogueAcc -= rows * rowH;
            const next = Math.max(0, Math.min(max, dialogueScroll + rows)), moved = next !== dialogueScroll;
            dialogueScroll = next;
            render(true).catch(() => {});
            return moved;
        });

        let activeCategory = 0;
        let selectedTopicIdx = 0;
        let showKeyboard = false;
        let customQuery = '';
        const QUERY_MAX = 160;
        const tail = (s, n) => (s.length > n ? '…' + s.slice(-(n - 1)) : s);

        let currentPrompt = TOPIC_CATEGORIES[0].topics[0].title;
        let currentResponse = 'M-Copilot ready. Select a category & topic chip or ask a custom question.';
        let statusMsg = null;
        let statusTime = 0;

        // What the car reported (null = not known: the AI is told so, it never gets a placeholder)
        const telemetry = {
            speed: null, rpm: null, gear: null, stage: null, torque: null, boost: null, mode: null,
            oilTemp: null, coolantTemp: null, oilLevel: null, ambient: null, gLat: null, gLong: null,
            tyres: null, tyreTargets: null, tyreTemps: null, fuelL: null, rangeKm: null, batteryPct: null,
            engine: null, msa: null, handbrake: null, odoKm: null, avgCons: null, powerPct: null, torquePct: null,
            awd: null, condition: null, service: null, serviceNext: null, checkControl: null, programme: null, ac: null, hvTemp: null, hvVolt: null,
            engineSnap: null, dtcScan: null, vehicle: null, units: {}, drive: null, moving: null,
        };
        const Vehicle = require('./vehicle');
        const vehicle = new Vehicle({ dataDir: ctx.dataDir, log });
        telemetry.vehicle = vehicle;
        const DRIVE_MODES = { SPORT_DYNAMIC: 'Sport', SPORT_EXPERT: 'Sport plus', ECO_PRO_EFFICIENT: 'Eco pro', 1: 'Sport', 2: 'Sport plus',
            3: 'Sport individual', 4: 'Comfort', 5: 'Comfort plus', 6: 'Comfort individual', 7: 'Eco pro', 8: 'Eco pro plus', 9: 'Eco pro individual', 10: 'Adaptive' };
        const OIL_LEVELS = { MOTOROELSTAND_UNTER_MINIMUM: 'below minimum', MOTOROELSTAND_AM_MINIMUM: 'at minimum', MOTOROELSTAND_1_4: '1/4', MOTOROELSTAND_2_4: '2/4',
            MOTOROELSTAND_3_4: '3/4', MOTOROELSTAND_4_4: 'full', MOTOROELSTAND_5_4: 'above full', MOTOROELSTAND_UEBERFUELLT: 'overfilled', MOTOROELSTAND_OK: 'OK',
            SERVICEFUNKTION_AKTIV: 'measuring now', 0: 'below minimum', 1: 'at minimum', 2: '1/4', 3: '2/4', 4: '3/4', 5: 'full', 6: 'above full', 7: 'overfilled', 13: 'OK', 14: 'measuring now' };
        const ENGINE_STATES = { MOTOR_AUS: 'off', MOTOR_STARTET: 'starting', MOTOR_LAEUFT: 'running', 0: 'off', 1: 'starting', 2: 'running' };
        const HANDBRAKE = { HANDBREMSE_ANGEZOGEN: 'applied', HANDBREMSE_GELOEST: 'released', 1: 'released', 2: 'applied' };
        const MSA = { MSA_AKTIVIERT: 'on', MSA_DEAKTIVIERT: 'off', 0: 'off', 1: 'on' };
        const AWD = { _4WD_STANDARD: '4WD', _4WD_ALTERNATIV: '4WD Sport', _2WD: '2WD (rear-wheel drive)', AWDSAND: 'Sand' };
        const CONS_UNITS = { VERBRAUCH_IN_L_S_100KM: 'l/100 km', VERBRAUCH_IN_MPG_UK: 'mpg (UK)', VERBRAUCH_IN_MPG_US: 'mpg (US)', VERBRAUCH_IN_KM_S_L: 'km/l',
            1: 'l/100 km', 2: 'mpg (UK)', 3: 'mpg (US)', 4: 'km/l' };
        // service list (as idrive7-apps Service reads it): ids in English, colours as states
        const CBS_NAMES = { 1: 'Engine oil', 2: 'Front brake pads', 3: 'Brake fluid', 6: 'Rear brake pads', 7: 'Particulate filter', 10: 'Spark plugs',
            13: 'NOx additive (AdBlue)', 17: 'Vehicle check', 32: 'Statutory inspection', 33: 'Emissions test', 35: 'Transmission oil', 100: 'Vehicle check' };
        const CBS_STATES = { RED: 'overdue', YELLOW: 'due soon', ORANGE: 'due soon', GREEN: 'OK', 1: 'overdue', 2: 'due soon', 4: 'due soon', 3: 'OK' };
        const findKey = (v, key) => {
            if (!v || typeof v !== 'object') return null;
            if (key in v) return v;
            for (const k of Object.keys(v)) { const r = findKey(v[k], key); if (r) return r; }
            return null;
        };
        const carText = (x) => String(x === undefined || x === null ? '' : x).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60);
        const UNIT_PRESS = { 1: 'BAR', 2: 'KPA', 3: 'PSI', BAR: 'BAR', KPA: 'KPA', PSI: 'PSI' }, UNIT_TEMP = { 1: 'C', 2: 'F', C: 'C', F: 'F' };
        const SPEED_UNITS = { KM_S_H__KM: 'km/h', MPH__MLS: 'mph', 1: 'km/h', 2: 'mph' };
        const PROGRAMMES = { S_MINUS_PROGRAMM: 'S (sport)', M_MINUS_PROGRAMM: 'M (manual)', 1: 'S (sport)', 2: 'M (manual)' };
        const AC_ON = { 1: true, KLIMAANLAGE_EIN: true, 0: false, KLIMAANLAGE_AUS: false };
        const pick = (v, key) => { const o = findKey(v, key); return o ? o[key] : undefined; };
        // Check Control: active message ids (CheckControlMaster) and their texts (the cluster's lists)
        const ccActive = new Map(), ccNames = new Map();
        const ccWalk = (o, fn) => {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o)) { o.forEach((x) => ccWalk(x, fn)); return; }
            fn(o);
            Object.keys(o).forEach((k) => { if (o[k] && typeof o[k] === 'object') ccWalk(o[k], fn); });
        };
        const ccUpdate = () => {
            telemetry.checkControl = Array.from(ccActive.keys()).map((id) => (ccNames.get(id) || 'Check Control message ' + id));
        };
        const ccNamesFrom = (v) => {
            ccWalk(v, (o) => {
                const id = o.cCIdentifer !== undefined ? o.cCIdentifer : o.cCIdentifier, nm = o.cCShortName || o.cCName;
                if (id !== undefined && nm) ccNames.set(id, carText(nm));
            });
            if (telemetry.checkControl) ccUpdate();
        };
        // tyre pressures come as 0.1 x the car's own unit; each unit's plausible range is apart (as M Vitals reads them)
        let tyreFahrenheit = false;
        const tyreBar = (raw) => {
            if (typeof raw !== 'number' || raw >= 65532) return null;
            const v = raw * 0.1, known = telemetry.units.press;
            if (known === 'PSI') return v / 14.5038;
            if (known === 'KPA') return v / 100;
            if (known === 'BAR') return v >= 0.5 && v <= 6 ? v : null;
            if (v >= 0.5 && v <= 6) return v;
            if (v >= 7 && v < 60) { tyreFahrenheit = true; return v / 14.5038; }     // psi (the car then uses deg F too)
            if (v >= 60 && v <= 600) return v / 100;                                 // kPa
            return null;
        };
        const tyreC = (raw) => {
            if (typeof raw !== 'number' || raw >= 65535) return null;
            const v = raw - 40;
            return tyreFahrenheit ? (v - 32) * 5 / 9 : v;
        };
        const corners4 = (v, keys, fn) => {
            const o = { fl: fn(v[keys[0]]), fr: fn(v[keys[1]]), rl: fn(v[keys[2]]), rr: fn(v[keys[3]]) };
            return [o.fl, o.fr, o.rl, o.rr].every((x) => x !== null) ? o : null;
        };
        // signals beyond kit/car's groups, decoded as in idrive7-apps (Live Data, M Vitals)
        const EXTRA = {
            'de.bmw.infotainment.vehicle.TPMS': {
                statusTyrePressure: (v) => { telemetry.tyres = corners4(v || {}, ['actualValuePressureTyreFLH', 'actualValuePressureTyreFRH', 'actualValuePressureTyreRLH', 'actualValuePressureTyreRRH'], tyreBar); },
                statusTargetTyrePressure: (v) => { telemetry.tyreTargets = corners4(v || {}, ['targetPressureTyreFLH', 'targetPressureTyreFRH', 'targetPressureTyreRLH', 'targetPressureTyreRRH'], tyreBar); },
                statusTyreTemperature: (v) => { telemetry.tyreTemps = corners4(v || {}, ['actualValueTemperatureTyreFLH', 'actualValueTemperatureTyreFRH', 'actualValueTemperatureTyreRLH', 'actualValueTemperatureTyreRRH'], tyreC); },
            },
            'de.bmw.infrastructure.EnvironmentalInformation': {
                ExteriorTemperature: (v) => { const r = v && v.temperatureExterior; telemetry.ambient = typeof r === 'number' && r !== 255 ? r * 0.5 - 40 : null; },
            },
            'de.bmw.infotainment.KombiIF': {
                statusRangeTankStatus: (v) => {
                    v = v || {};
                    telemetry.fuelL = typeof v.fluidLevelFuelTank === 'number' && v.fluidLevelFuelTank < 255 ? v.fluidLevelFuelTank : null;
                    telemetry.rangeKm = typeof v.range === 'number' && v.range < 4095 ? v.range : null;
                    telemetry.odoKm = typeof v.mileageKilometre === 'number' && v.mileageKilometre > 0 && v.mileageKilometre < 16777215 ? v.mileageKilometre : null;
                },
                // trip computer 1 (scaling as Live Data reads it: 0.1 a step, in the cluster's unit)
                statusBordcomputerAverage: (v) => {
                    const r = v && v.consumptionAverage1BC1, unit = v && CONS_UNITS[v.statusUnitOfMeasurementConsumptionBC];
                    telemetry.avgCons = typeof r === 'number' && r > 0 && r < 65535 && unit ? { value: r * 0.1, unit } : null;
                    if (unit) telemetry.units.cons = unit;
                    const sp = v && SPEED_UNITS[v.statusUnitOfMeasurementSpeedBC];
                    if (sp) telemetry.units.speed = sp;
                },
            },
            'de.bmw.infotainment.vehicle.CDS': {
                statusBattery2: (v) => { const r = v && v.conditionBatteryChargingCondition; telemetry.batteryPct = typeof r === 'number' && r <= 100 ? r : null; },
                statusEngineStatus: (v) => { const r = v && v.statusEngineRunDrive; telemetry.engine = (r !== undefined && ENGINE_STATES[r]) || null; },
                statusHandBrake: (v) => { const r = v && v.statusContactHandBrake; telemetry.handbrake = (r !== undefined && HANDBRAKE[r]) || null; },
            },
            'de.bmw.infotainment.vehicle.CDS2': {
                statusPushButtonMSA2: (v) => { const r = v && v.statusFunctionMSA; telemetry.msa = (r !== undefined && MSA[r]) || null; },
            },
            'de.bmw.infotainment.vehicle.Vehicle2': {
                statusOilDipstick2: (v) => { const r = v && v.fluidLevelEngineOilRelative; telemetry.oilLevel = (r !== undefined && OIL_LEVELS[r]) || null; },
                statusVehiclePartType: (v) => { const t = Vehicle.engineTypeOf(v && v.typeEngine); if (t) vehicle.engineType = t; },
            },
            'de.bmw.infotainment.drivingexcitement.FES': {
                statusFESVehicleDynamicSwitchHMI: (v) => { const r = v && v.actualValueModeDrivingExperience; telemetry.mode = (r !== undefined && DRIVE_MODES[r]) || null; },
                statusSwitchDriveDynamicSport2: (v) => { const r = v && v.displayBoostPressure; telemetry.boost = typeof r === 'number' && r !== 255 ? r * 0.01 : null; },
                // the sport display's share of the engine's maximum power and torque
                statusVehicleDynamicEngine: (v) => {
                    v = v || {};
                    telemetry.powerPct = typeof v.displaySportEnginePower === 'number' && v.displaySportEnginePower <= 100 ? v.displaySportEnginePower : null;
                    telemetry.torquePct = typeof v.displaySportEngineTorque === 'number' && v.displaySportEngineTorque <= 100 ? v.displaySportEngineTorque : null;
                },
            },
            // the car's display units (as BMW's x_call / M Vitals read them): answers use them
            'de.bmw.infotainment.vehicle.Vehicle': {
                statusNewCurrentUnitsStatusExt: (v) => {
                    const pr = UNIT_PRESS[v && v.unitOfMeasurementAirPressure], tp = UNIT_TEMP[v && v.unitOfMeasurementTemperature];
                    if (pr) telemetry.units.press = pr;
                    if (tp) { telemetry.units.temp = tp; tyreFahrenheit = tp === 'F'; }
                },
            },
            // M xDrive setting (M models only); the S / M programme the cluster shows next to the gear (M Vitals)
            'de.bmw.infotainment.misc.MDrive': {
                statusMSystem: (v) => { const r = v && v.statusAllWheelSetup; telemetry.awd = (r !== undefined && AWD[r]) || null; },
                dataDisplayGearbox: (v) => { const r = v && v.displayProgramGearbox; telemetry.programme = (r !== undefined && PROGRAMMES[r]) || null; },
            },
            // climate and the high-voltage battery, as eDrive reads them
            'de.bmw.infotainment.climate.Climate2': {
                statusACFront: (v) => { const r = pick(v, 'statusAircon'); telemetry.ac = r === undefined ? null : AC_ON[r] === undefined ? null : AC_ON[r]; },
            },
            'de.bmw.infotainment.drivingexcitement.Efficiencytainment2': {
                statusBatteryTemperature: (v) => {
                    const r = pick(v, 'actualValueTemperatureHighVoltageStorage');
                    telemetry.hvTemp = typeof r === 'number' && r !== 255 && r - 50 > -30 && r - 50 < 70 ? r - 50 : null;
                },
            },
            'de.bmw.infotainment.lsc.LSCDataSink': {
                statusHighVoltageStorage: (v) => {
                    const x = pick(v, 'actualValueVoltageHighVoltageStorage'), volts = typeof x === 'number' ? (x > 1500 ? x / 10 : x) : null;
                    telemetry.hvVolt = volts !== null && volts > 150 && volts < 500 ? volts : null;
                },
            },
            // Check Control: the warning messages active in the cluster now (as idrive7-apps Fault Scanner reads them)
            'de.bmw.infotainment.checkcontrol.CheckControlMaster': {
                basicList: (v) => {
                    ccWalk(v, (o) => {
                        if (o.ccmId === undefined) return;
                        if (o.activeState === 'AKTIV' || o.activeState === 0) ccActive.set(o.ccmId, true); else ccActive.delete(o.ccmId);
                    });
                    ccUpdate();
                },
            },
            // the cluster's service list: what the iDrive's Service requirements page shows
            'de.bmw.infotainment.KombiInterface_2': {
                ccList: (v) => ccNamesFrom(v),
                // the summary: the next service the car asks for (as idrive7-apps Service reads it)
                cbsDataSBA: (v) => {
                    const c = findKey(v, 'cBSDataSBAText') || {};
                    const text = carText(c.cBSDataSBAText);
                    telemetry.serviceNext = text ? { text, way: carText(c.cBSDataSBADistance), date: carText(c.cBSDataSBADate) } : null;
                },
                newCCMessage: (v) => ccNamesFrom(v),
                cbsDataServiceList: (v) => {
                    const arr = Array.isArray(v) ? v : (v && (v.cbsDataServiceList || v.value)) || [];
                    const items = arr.map((e) => {
                        const c = findKey(e, 'cBSIdentifier') || {};
                        const carName = carText(c.cBSServcieName || c.cBSServiceName);
                        return { name: CBS_NAMES[c.cBSIdentifier] || carName, way: carText(c.cBSServiceWay), date: carText(c.cBSServiceDate),
                            state: CBS_STATES[c.cBSColor] || null };
                    }).filter((i) => i.name);
                    telemetry.service = items.length ? items : null;
                },
            },
        };

        // Real car driving signals, subscribed only while the screen is shown (startCar / stopCar)
        let car = null;
        function stopCar() {
            if (car) { car.stop(); car = null; }
        }
        function startCar() {
            if (car) return;
            try {
                const Car = require('./kit/car');
                car = new Car(ctx, ['rpm', 'speed', 'accel', 'temps', 'gear', 'torque', 'condition'], EXTRA);
                car.onSample(onCarSample);
            } catch (e) {
                car = null;
                log.warn('M-Copilot: Car telemetry init fallback: ' + e.message);
            }
        }
        function onCarSample(data) {
            // kit/car feeds a simulator while no car answers: that must never reach the AI as the car's state
            if (data.demo) return;
            driveFeed(data);
            // moving or parked (with a gap, so stop-and-go doesn't flicker): answer length and text size follow it
            if (typeof data.speed === 'number') {
                telemetry.moving = data.speed > 8 ? true : data.speed < 3 ? false : telemetry.moving;
                telemetry.speed = Math.round(data.speed);
                // standing still: the outside temperature sensor warms up (sun, traffic)
                if (data.speed < 3) { if (!standingSince) standingSince = Date.now(); } else if (data.speed > 10) standingSince = 0;
            }
            if (typeof data.rpm === 'number') {
                telemetry.rpm = Math.round(data.rpm);
                // the engine's running time (misfire counts are per driving cycle): known from its start
                // only when M-Copilot saw it off before
                if (data.rpm >= 450) { if (!engineOnSince) { engineOnSince = Date.now(); engineStartSeen = engineOffSeen; } }
                else if (data.rpm < 100) { engineOnSince = 0; engineOffSeen = true; }
            }
            if (typeof data.oil === 'number') telemetry.oilTemp = Math.round(data.oil);
            if (typeof data.coolant === 'number') telemetry.coolantTemp = Math.round(data.coolant);
            if (data.gLat !== undefined) telemetry.gLat = data.gLat;
            if (data.gLong !== undefined) telemetry.gLong = data.gLong;
            if (data.gear !== undefined) telemetry.gear = data.gear;
            if (data.stage !== undefined) telemetry.stage = data.stage;
            if (typeof data.torque === 'number') telemetry.torque = Math.round(data.torque);
            if (data.condition !== undefined) telemetry.condition = data.condition;
            // no redraw from here: the loop redraws when something on screen changed (render)
        }

        /**
         * Coming back on screen: values that are only sent on change may be old, so they are cleared,
         * Check Control and the service list too: each subscription sends the current value again
         * (its getter), and the warnings come as changes to the list kept here (ccActive).
         */
        let standingSince = 0, engineOnSince = 0, engineStartSeen = false, engineOffSeen = false;
        function clearLive() {
            standingSince = 0; engineOnSince = 0; engineStartSeen = false; engineOffSeen = false;
            ccActive.clear();
            ['checkControl', 'service', 'serviceNext'].forEach((k) => { telemetry[k] = null; });
            ['speed', 'rpm', 'gear', 'stage', 'torque', 'boost', 'mode', 'oilTemp', 'coolantTemp', 'ambient', 'gLat', 'gLong', 'tyres', 'tyreTargets', 'tyreTemps',
                'fuelL', 'rangeKm', 'batteryPct', 'engine', 'msa', 'handbrake', 'powerPct', 'torquePct', 'awd', 'condition', 'programme', 'ac', 'hvTemp', 'hvVolt',
                'moving'].forEach((k) => { telemetry[k] = null; });
        }

        // the car's state for reading it: 'asleep' (parked, no ignition: many units don't answer),
        // 'awake' (ignition on or drive-ready), null (the car doesn't say)
        const carAwake = () => {
            // the latest state from the car itself: the state alone sends no sample
            if (car) { const d = car.data(); if (!d.demo && d.condition !== undefined) telemetry.condition = d.condition; }
            return telemetry.condition === null || telemetry.condition === undefined ? null : telemetry.condition <= 5 ? 'asleep' : 'awake';
        };
        // the engine: 'on', 'off' or null (not known)
        const engineState = () => (telemetry.engine === 'running' || (typeof telemetry.rpm === 'number' && telemetry.rpm >= 450) ? 'on'
            : telemetry.engine === 'off' || telemetry.rpm === 0 || carAwake() === 'asleep' ? 'off' : null);

        // the owner's car profile from the phone page (model, tune, mods, tyres, fuel, use)
        cloudPair.onProfile = (profile, time) => {
            if (!vehicle.setProfile(profile, time)) return;
            ai.resetHistory();
            notify(vehicle.profile ? 'Car profile updated from your phone.' : 'Car profile cleared.');
            hello();                // the phone pages (other browsers too) show the car's new state
            render(true).catch(() => {});
        };

        /*
         * Drive memory: what happened on this drive while M-Copilot was on screen, as a few running
         * figures (no trace is kept): top speed and rpm, oil / coolant range, cold revving, time at high
         * rpm, peak g, hottest tyre, and - from light engine unit samples under load - intake air heat,
         * boost short of its target and the lowest timing. A new drive starts after 15 minutes without
         * data (the screen was left, or the car stood switched off).
         */
        let drive = null;
        function driveNew() {
            return { start: Date.now(), last: Date.now(), ms: 0, seenMs: 0, km: 0, vmax: null, rpmMax: null, torqueMax: null, powerPctMax: null, boostMax: null,
                oilMin: null, oilMax: null, coolMax: null, coldRevMs: 0, coldRevRpm: 0, highRpmMs: 0, gLatMax: null, gAccMax: null, gBrakeMax: null,
                tyreTempMax: null, loadSamples: 0, iatMax: null, boostShort: 0, boostShortWorst: null, boostShortRpm: null, timingMin: null, timingMinRpm: null };
        }
        const hi = (a, b) => (typeof b !== 'number' || !isFinite(b) ? a : a === null || b > a ? b : a);
        const lo = (a, b) => (typeof b !== 'number' || !isFinite(b) ? a : a === null || b < a ? b : a);
        function driveFeed(d) {
            const now = Date.now();
            if (!drive || now - drive.last > 15 * 60 * 1000) drive = driveNew();
            const dt = Math.min(3000, now - drive.last);       // a steady cruise sends few updates
            drive.last = now;
            drive.seenMs += dt;
            const sp = d.speed, rpm = d.rpm;
            if (typeof sp === 'number' && sp >= 0 && sp < 400) { drive.km += sp * dt / 3600000; drive.vmax = hi(drive.vmax, sp); }
            if (typeof rpm === 'number' && rpm > 0 && rpm < 12000) {
                drive.ms += dt;
                drive.rpmMax = hi(drive.rpmMax, rpm);
                if (rpm > 5500) drive.highRpmMs += dt;
                if (typeof d.oil === 'number' && d.oil < 70 && rpm > 4500) { drive.coldRevMs += dt; drive.coldRevRpm = Math.max(drive.coldRevRpm, rpm); }
            }
            if (typeof d.oil === 'number' && rpm > 0) { drive.oilMin = lo(drive.oilMin, d.oil); drive.oilMax = hi(drive.oilMax, d.oil); }
            if (typeof d.coolant === 'number') drive.coolMax = hi(drive.coolMax, d.coolant);
            drive.torqueMax = hi(drive.torqueMax, d.torque);
            if (typeof d.gLat === 'number' && Math.abs(d.gLat) < 2) drive.gLatMax = hi(drive.gLatMax, Math.abs(d.gLat));
            if (typeof d.gLong === 'number' && Math.abs(d.gLong) < 2) { if (d.gLong > 0) drive.gAccMax = hi(drive.gAccMax, d.gLong); else drive.gBrakeMax = hi(drive.gBrakeMax, -d.gLong); }
            drive.powerPctMax = hi(drive.powerPctMax, telemetry.powerPct);
            drive.boostMax = hi(drive.boostMax, telemetry.boost);
            if (telemetry.tyreTemps) ['fl', 'fr', 'rl', 'rr'].forEach((k) => { drive.tyreTempMax = hi(drive.tyreTempMax, telemetry.tyreTemps[k]); });
        }
        /** Under load (high rpm and torque), every 2 s: a light engine unit sample for the drive memory. */
        let loadTimer = null;
        function loadSampling(on) {
            if (!on) { if (loadTimer) { clearInterval(loadTimer); loadTimer = null; } return; }
            if (loadTimer) return;
            loadTimer = setInterval(async () => {
                const rpm = telemetry.rpm;
                const load = typeof rpm === 'number' && rpm > 2500 && ((typeof telemetry.torquePct === 'number' && telemetry.torquePct >= 50) || (typeof telemetry.torque === 'number' && telemetry.torque >= 250));
                if (!load || !drive || isThinking || !steady()) return;
                try {
                    const d = await diagLink();
                    if (!d.available) return;
                    if (!snapshot) { const EngineSnapshot = require('./engine_snapshot'); snapshot = new EngineSnapshot(d, ctx.spec && ctx.spec.config, log); }
                    const x = await snapshot.sample({ budgetMs: 900, steady });
                    if (!x || !drive) return;
                    drive.loadSamples++;
                    drive.iatMax = hi(drive.iatMax, x.iat);
                    if (typeof x.boostTarget === 'number' && typeof x.boostActual === 'number' && x.boostTarget > 0.3) {
                        const gap = x.boostTarget - x.boostActual;
                        if (gap > 0.15) { drive.boostShort++; if (drive.boostShortWorst === null || gap > drive.boostShortWorst) { drive.boostShortWorst = gap; drive.boostShortRpm = rpm; } }
                    }
                    if (typeof x.timing === 'number' && (drive.timingMin === null || x.timing < drive.timingMin)) { drive.timingMin = x.timing; drive.timingMinRpm = rpm; }
                } catch (e) { /* the next sample */ }
            }, 2000);
        }
        /** The drive memory as the AI gets it (ai.js buildVehicleContext). */
        function driveSummary() {
            if (!drive) return null;
            return Object.assign({}, drive, { min: (Date.now() - drive.start) / 60000, seenMin: drive.seenMs / 60000, coldRevSec: drive.coldRevMs / 1000, highRpmSec: drive.highRpmMs / 1000 });
        }

        // the AI model picked on the phone page
        cloudPair.onModel = (provider, model, time) => {
            if (!ai.setModel(provider, model, time)) return;
            notify('AI model: ' + (model || 'default') + '.');
            hello();
            render(true).catch(() => {});
        };

        cloudPair.onPaired = () => {
            page = 0;
            hello();                // the phone page shows "Connected" and the car's settings
            notify('AI paired from your phone: ' + providerName() + ' ready.');
            render(true).catch(() => {});
        };

        /**
         * Disconnected from the phone: the AI key and everything the phone set go - the car
         * profile, the AI model choice, the conversation. What the car told about
         * itself (VIN, engine and gearbox units) stays. The phone page keeps its entries to send again.
         */
        function forgetPhone() {
            ai.config.geminiApiKey = null;
            ai.config.apiKey = null;
            ai.config.sessionToken = null;
            ai.config.paired = false;
            ai.config.model = null;
            ai.config.modelAt = 0;
            ai.config.geminiModel = null;
            ai.lastModel = null;
            ai.saveConfig();
            ai.resetHistory();
            vehicle.clearProfile();
            canFollowUp = false;
        }

        cloudPair.onUnpaired = () => {
            forgetPhone();
            cachedQr = null;
            cachedQrUrl = null;
            cloudPair.reset();
            cloudPair.startPolling();
            page = 2;
            notify('Phone disconnected AI. Scan QR code to re-pair.');
            render(true).catch(() => {});
        };

        const fmtNum = (v, unit) => (typeof v === 'number' && isFinite(v) ? Math.round(v) + unit : '--');
        function vitalsLine() {
            // no car (emulator, bench): kit/car's simulator, marked DEMO - shown here only, never sent to the AI
            const d = car ? car.data() : null, demo = !!(d && d.demo);
            const oil = demo ? d.oil : telemetry.oilTemp, coolant = demo ? d.coolant : telemetry.coolantTemp;
            return 'OIL ' + fmtNum(oil, '°C') + '  ·  COOLANT ' + fmtNum(coolant, '°C') + '  ·  BATTERY ' + fmtNum(demo ? null : telemetry.batteryPct, '%') + (demo ? '  ·  DEMO' : '');
        }

        /** The paired AI provider's name, for the status pill and messages. */
        const PROVIDERS = { gemini: 'Gemini', claude: 'Claude', openai: 'OpenAI', groq: 'Groq', openrouter: 'OpenRouter' };
        function providerId() {
            const p = ai.config.provider || (ai.config.mode === 'gemini' ? 'gemini' : ai.config.mode === 'claude' ? 'claude' : null);
            return PROVIDERS[p] ? p : null;
        }
        function providerName() {
            return PROVIDERS[providerId()] || 'AI';
        }

        function notify(msg) {
            statusMsg = msg;
            statusTime = Date.now();
            log.info('M-Copilot: ' + msg);
        }

        function setThinking(active) {
            if (isThinking === active) return;
            isThinking = active;
            if (isThinking) {
                if (!thinkTimer) {
                    thinkStart = Date.now();
                    thinkTimer = setInterval(() => {
                        if (onScreen()) render(true).catch(() => {});
                    }, 500); // the seconds counter, on screen only
                }
            } else {
                if (thinkTimer) {
                    clearInterval(thinkTimer);
                    thinkTimer = null;
                }
                render(true).catch(() => {});
            }
        }

        /**
         * Diagnostic reads only in a steady state: not while drive readiness is being made or ended
         * (vehicle state 8 / 12), not while the engine is starting or cranking. Signals alone (passive)
         * never need this. Unknown state (the car doesn't send it) counts as steady.
         */
        function steady() {
            // the car's latest state, not the last tick's (the state alone sends no tick)
            if (car) onCarSample(car.data());
            if (telemetry.condition === 8 || telemetry.condition === 12) return false;
            if (telemetry.engine === 'starting') return false;
            if (typeof telemetry.rpm === 'number' && telemetry.rpm > 0 && telemetry.rpm < 450) return false;   // cranking
            return true;
        }
        /** Up to waitMs for a steady state (an engine start takes a second or two). */
        async function whenSteady(waitMs) {
            const until = Date.now() + waitMs;
            while (!steady() && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
            return steady();
        }

        // the diagnostic link: made once, and again (at most every 30 s) when it could not be made - the
        // head unit's diagnostic service may not be up yet right after it starts
        let diag = null, diagMaking = null, diagAt = 0;
        function diagLink() {
            if (diag && !(diag.error && Date.now() - diagAt > 30000)) return Promise.resolve(diag);
            if (diagMaking) return diagMaking;
            const { Diag } = require('./kit/diag');
            diagAt = Date.now();
            diagMaking = new Diag(signals, log).init().then((d) => { diag = d; diagMaking = null; return d; }, (e) => { diagMaking = null; throw e; });
            return diagMaking;
        }

        /** Once per car: the VIN (if MainApp didn't pass it) and the engine / gearbox unit types. */
        async function identifyCar() {
            try {
                const d = await diagLink();
                if (d.available) await vehicle.identify(d, steady, () => carAwake() === 'asleep');
            } catch (e) {
                log.warn('M-Copilot: identification skipped: ' + (e.message || e));
            }
        }

        /**
         * The type index (UDS 22 F150) of the units that reported faults, which picks their exact
         * fault texts: asked once per unit and kept in data/ecu_ids.json (with the VIN: another car,
         * asked again), only while steady. { 'hex address': 'index' or '' (asked, none) }.
         */
        const IDS_FILE = require('path').join(ctx.dataDir, 'ecu_ids.json');
        let unitIds = null;
        async function unitTypes(d, addrs, useful) {
            if (!unitIds) {
                try { const j = JSON.parse(require('fs').readFileSync(IDS_FILE, 'utf8')); unitIds = j.vin === vehicle.vin ? j.ids || {} : {}; } catch (e) { unitIds = {}; }
            }
            const h = (a) => a.toString(16).toUpperCase().padStart(2, '0');
            const todo = useful ? addrs.filter((a) => unitIds[h(a)] === undefined) : [];
            for (const a of todo) {
                if (!steady()) break;                      // the engine started: the rest next time
                try {
                    const r = await d.physical(a, 0x22, [0xF1, 0x50], 3000);
                    if (!r) continue;                      // no answer: asked again next time
                    unitIds[h(a)] = r[0] === 0x62 && r.length >= 6 ? [r[3], r[4], r[5]].map(h).join('') : '';
                } catch (e) { break; }
            }
            if (todo.length) {
                try { require('fs').writeFileSync(IDS_FILE, JSON.stringify({ vin: vehicle.vin, ids: unitIds })); } catch (e) { /* next time */ }
            }
            return unitIds;
        }

        /**
         * The engine snapshot (engine_snapshot.js): read-only values from the engine unit (and a hybrid's
         * battery unit) at the moment of asking - boost, intake air, load, timing, fuel pressures, misfires,
         * gearbox oil, 12 V. Only while steady, within a time budget; kept 20 s.
         */
        let snapshot = null;
        async function engineSnapshot() {
            try {
                // parked without ignition the engine unit sleeps: nothing to read (and its silence is not a failure)
                if (carAwake() === 'asleep') { telemetry.engineSnap = null; return; }
                const d = await diagLink();
                if (!d.available || !steady()) return;
                if (!snapshot) { const EngineSnapshot = require('./engine_snapshot'); snapshot = new EngineSnapshot(d, ctx.spec && ctx.spec.config, log); }
                const hybrid = /hybrid|electric/.test(vehicle.engineType || '') || telemetry.hvVolt !== null || telemetry.hvTemp !== null;
                const r = await snapshot.read({ budgetMs: 3500, steady, hybrid, needOil: telemetry.oilTemp === null, engine: engineState() });
                if (r) telemetry.engineSnap = r;
            } catch (e) {
                log.warn('M-Copilot: engine snapshot skipped: ' + (e.message || e));
            }
        }

        /**
         * Read the fault memory of every control unit (UDS 0x19 02 0C over TASU, read-only) so the AI
         * talks about real stored faults. Kept for 5 minutes.
         */
        async function scanFaults() {
            const ccNow = JSON.stringify(telemetry.checkControl || []);
            if (telemetry.dtcScan && !telemetry.dtcScan.error && !telemetry.dtcScan.partial && telemetry.dtcScan.cc === ccNow
                && Date.now() - telemetry.dtcScan.at < 5 * 60 * 1000) return;
            try {
                const { parseDtcReply } = require('./kit/diag');
                const { ECU } = require('./kit/ecus');
                if (!(await whenSteady(8000))) {
                    // not cached: the next question tries again
                    telemetry.dtcScan = { at: 0, error: 'the engine was starting or stopping; the fault memory is read once the car is steady' };
                    return;
                }
                const d = await diagLink();
                if (!d.available) throw new Error('diagnostic link not available');
                currentResponse = 'Reading the fault memory of all control units...';
                render(true).catch(() => {});
                const res = await d.functional(0x19, [0x02, 0x0C]);
                const found = [];
                res.forEach((uds, addr) => {
                    const p = parseDtcReply(uds, [0x02, 0x0C]);
                    found.push({ addr, codes: p.ok ? p.dtcs : [] });
                });
                // the texts: for the units with faults, their exact type first (once per unit, kept)
                const T = require('./dtc_text');
                const ids = await unitTypes(d, found.filter((u) => u.codes.length).map((u) => u.addr), T.hasDb);
                let total = 0;
                const units = found.map((u) => {
                    total += u.codes.length;
                    return { addr: u.addr, name: T.unitName(u.addr, ids) || ECU[u.addr] || ('ECU 0x' + u.addr.toString(16).toUpperCase()),
                        codes: u.codes.map((x) => ({ code: x.code, status: x.status, text: T.describe(u.addr, x.code, ids) })) };
                });
                // parked without ignition, units that sleep don't answer: said so, and read again next time
                telemetry.dtcScan = { at: Date.now(), answered: units.length, total, units, partial: carAwake() === 'asleep', cc: JSON.stringify(telemetry.checkControl || []) };
                log.info('M-Copilot: fault memory read: ' + units.length + ' units, ' + total + ' faults');
            } catch (e) {
                telemetry.dtcScan = { at: Date.now(), error: e.message || String(e) };
                log.warn('M-Copilot: fault memory read failed: ' + (e.message || e));
            }
        }

        const simulated = (d) => {
            const r = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v) : null);
            return Object.assign({}, telemetry, { demo: true, moving: typeof d.speed === 'number' ? d.speed > 8 : null, speed: r(d.speed), rpm: r(d.rpm), oilTemp: r(d.oil), coolantTemp: r(d.coolant),
                torque: r(d.torque), gear: typeof d.gear === 'number' ? d.gear : null, gLat: d.gLat, gLong: d.gLong });
        };

        let askSeq = 0;
        let canFollowUp = false;            // the last answer was a real one: follow-up chips under it
        // one tap instead of typing: they go on in the same conversation (ai.js keeps the last exchanges)
        const FOLLOW_UPS = [
            { title: 'What should I do?', query: 'Based on that, what exactly should I do now, step by step?' },
            { title: 'Safe to keep driving?', query: 'Is it safe to keep driving the car normally as it is now? Say what to watch for.' },
            { title: 'Explain more', query: 'Explain that in more detail for my car.' },
        ];
        async function askCopilot(queryText, title, opts) {
            if (isThinking) { notify('M-Copilot is still answering...'); return; }
            if (!ai.hasInternet) {
                notify('No Internet: Please verify phone hotspot or cellular uplink.');
                return;
            }
            if (!ai.isConfigured()) {
                page = 2;
                render(true).catch(() => {});
                return;
            }

            currentPrompt = title || 'Custom Query';
            dialogueScroll = 0;
            canFollowUp = false;
            const seq = ++askSeq;
            setThinking(true);
            currentResponse = 'Asking M-Copilot with your car\'s live data...';
            try {
                // who the car is (once per car), then the fault memory for the topics and questions about it
                await identifyCar();
                if ((opts && opts.faults) || /\b(fault|dtc|error code|check engine|warning light|engine light)/i.test(queryText)) await scanFaults();
                // the engine unit's own values at the moment of asking (a few hundred ms once known)
                await engineSnapshot();
                // the latest live values at the moment of asking (not demo data: onCarSample drops those)
                if (car) onCarSample(car.data());
                // demo switched on by hand (emulator, bench): the simulator's readings, labelled as such.
                // On "auto" (the car's default) simulated values never reach the AI.
                const d = car ? car.data() : null;
                telemetry.drive = driveSummary();
                telemetry.engineNow = engineState();
                telemetry.standingMin = standingSince ? (Date.now() - standingSince) / 60000 : null;
                telemetry.engineRunMin = engineOnSince ? (Date.now() - engineOnSince) / 60000 : null;
                telemetry.engineRunFromStart = !!engineOnSince && engineStartSeen;
                const t = d && d.demo && settings.get('demo') === 'on' ? simulated(d) : telemetry;
                ai.lastOk = false;
                const answer = await ai.ask(queryText, t, { fresh: !!(opts && opts.fresh) });
                if (seq === askSeq) { currentResponse = answer; canFollowUp = !!ai.lastOk; }
            } catch (e) {
                if (seq === askSeq) currentResponse = 'Error: ' + e.message;
            } finally {
                if (seq === askSeq) setThinking(false);
            }
        }

        /* ---------- QR Matrix for Smartphone Cloud Pairing ---------- */
        let cachedQr = null;
        let cachedQrUrl = null;
        function getPairingQr() {
            const url = cloudPair.getPairingUrl();
            if (cachedQr && cachedQrUrl === url) return cachedQr;
            try {
                const qr = qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.MEDIUM);
                cachedQr = qr;
                cachedQrUrl = url;
                return qr;
            } catch (e) {
                return null;
            }
        }

        /* ---------- Helper: Text Formatting & Wrapping ---------- */
        // The baked fonts draw ASCII, a few symbols and Georgian: accented letters lose their accents
        // (German umlauts as ae / oe / ue), other letters without a glyph are left out, never shown as "?".
        const DRAWABLE = new Set(Array.from('°±²³·×μ–—…€←↑→↓│✓✕'));
        const FOLD = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss', 'ı': 'i', 'İ': 'I', 'ł': 'l', 'Ł': 'L',
            'ø': 'o', 'Ø': 'O', 'æ': 'ae', 'Æ': 'Ae', 'œ': 'oe', 'Œ': 'Oe', 'đ': 'd', 'Đ': 'D', '’': "'", '‘': "'", '“': '"', '”': '"', '„': '"',
            '«': '"', '»': '"', '•': '-', '\u00a0': ' ', '\u202f': ' ', '−': '-', '≈': '~', '≥': '>=', '≤': '<=', '→': '→' };
        function drawable(text) {
            let out = '';
            for (const ch of text) {
                const c = ch.codePointAt(0);
                if (c < 128 || DRAWABLE.has(ch) || (c >= 0x10d0 && c <= 0x10ff) || (c >= 0x1c90 && c <= 0x1cbf)) out += ch;
                else if (FOLD[ch] !== undefined) out += FOLD[ch];
                else {
                    const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                    if (base && Array.from(base).every((x) => x.codePointAt(0) < 128)) out += base;
                }
            }
            return out;
        }

        const wrapCache = { key: null, lines: null };
        function wrapLines(text, maxChars = 62) {
            if (!text) return [];
            const key = maxChars + '|' + text;
            if (wrapCache.key === key) return wrapCache.lines;
            wrapCache.key = key;
            return (wrapCache.lines = wrapLinesNow(text, maxChars));
        }
        function wrapLinesNow(text, maxChars) {
            // Clean markdown syntax & sanitize characters into atlas-supported glyphs
            const cleaned = text
                .replace(/\*\*(.*?)\*\*/g, '$1')   // bold asterisks removed
                .replace(/^#{1,6}\s*/gm, '')          // markdown headings
                .replace(/`([^`]*)`/g, '$1')          // inline code
                .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1$2')   // *italic*
                .replace(/^\s*\d+[.)]\s+/gm, (m) => '- ')   // numbered lists as bullets
                .replace(/^[\*\-]\s+/gm, '- ')     // list bullet prefix to '- '
                .replace(/[•\u2022]/g, '- ')       // bullet dot to '- '
                .replace(/[≥]/g, '>=')
                .replace(/[≤]/g, '<=')
                .replace(/[✔]/g, '✓')
                .replace(/[⚠️⚠]/g, '[!]')
                .replace(/[“”]/g, '"')
                .replace(/[‘’]/g, "'")
                .replace(/\n{3,}/g, '\n\n');       // collapse excessive blank lines

            const rawLines = drawable(cleaned).split('\n');
            const lines = [];
            let lastEmpty = false;

            rawLines.forEach(rl => {
                const trimmed = rl.trim();
                if (!trimmed) {
                    if (!lastEmpty && lines.length > 0) {
                        lines.push('');
                        lastEmpty = true;
                    }
                    return;
                }
                lastEmpty = false;

                if (trimmed.length <= maxChars) {
                    lines.push(trimmed);
                } else {
                    const words = trimmed.split(' ');
                    let cur = '';
                    words.forEach(w => {
                        if ((cur + ' ' + w).length <= maxChars) {
                            cur = cur ? cur + ' ' + w : w;
                        } else {
                            if (cur) lines.push(cur);
                            cur = w;
                        }
                    });
                    if (cur) lines.push(cur);
                }
            });
            return lines;
        }

        /* ---------- Offline Screen: No Internet Connection ---------- */
        function drawNoInternet(cv, t) {
            G.panelExact(cv, t, 40, 52, 1520, 458 + (cv.extra || 0), 'Network Status: Offline');

            cv.roundRect(80, 110, 1440, 358 + (cv.extra || 0), 16, '#0f141f');
            cv.strokeRoundRect(80, 110, 1440, 358 + (cv.extra || 0), 16, 2, '#e1001a');

            cv.circle(180, 240, 44, withAlpha('#e1001a', 0.2));
            cv.text('!', 180, 255, 46, '#e1001a', { align: 'center', font: 'bold' });

            cv.text('NO INTERNET CONNECTION', 260, 180, 26, '#e1001a', { font: 'bold', spacing: 1 });
            cv.text('M-Copilot Cloud AI requires an active internet connection on your vehicle.', 260, 218, 18, '#ffffff');
            cv.text('Please verify that your BMW has cellular data or is connected to a mobile Wi-Fi hotspot.', 260, 248, 16, '#94a3b8');

            // Retry Button
            const btnW = 280, btnH = 48, btnY = 320;
            const b1X = 260;
            cv.roundRect(b1X, btnY, btnW, btnH, 10, '#004e8c');
            cv.strokeRoundRect(b1X, btnY, btnW, btnH, 10, 1.5, '#00a3e0');
            cv.text('RETRY CONNECTION', b1X + btnW / 2, btnY + 30, 16, '#ffffff', { align: 'center', font: 'bold' });
            cv.target(b1X, btnY, btnW, btnH, () => {
                notify('Re-checking uplink connectivity...');
                ai.checkInternetConnection().then(() => render(true));
            }, 'btn_retry_net', 10);
        }

        /* ---------- Connect: pairing the phone, and what is set from it (as Spotify's Connect tab) ---------- */
        function drawQr(cv, url, x, y, size) {
            const qr = getPairingQr(url);
            if (!qr) return;
            const n = qr.size, px = Math.floor(size / n), real = px * n, ox = x + Math.floor((size - real) / 2), oy = y + Math.floor((size - real) / 2);
            cv.roundRect(ox - 10, oy - 10, real + 20, real + 20, 10, '#ffffff');
            for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.getModule(c, r)) cv.fillRect(ox + c * px, oy + r * px, px, px, '#000000');
        }
        const LANG_NAMES = { ka: 'Georgian', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', nl: 'Dutch', pt: 'Portuguese', tr: 'Turkish', pl: 'Polish' };
        function drawConnect(cv, t) {
            const ex = cv.extra || 0, paired = ai.isConfigured(), now = Date.now();
            // left: connected, or the pairing QR
            G.panelExact(cv, t, 40, 52, 640, 458 + ex, paired ? 'AI Connection' : 'Scan to Connect Your Phone');
            const cx = 360;
            if (paired) {
                const C = '#00a3e0';
                cv.roundRect(64, 100, 592, 330 + ex, 14, '#0a1218');
                cv.strokeRoundRect(64, 100, 592, 330 + ex, 14, 1.5, withAlpha(C, 0.55));
                const sh = Math.floor(ex * 0.45);        // taller page (no bar): the card's contents move to its middle
                const by = 150 + sh;
                cv.circle(cx, by, 36, withAlpha(C, 0.12));
                cv.arc(cx, by, 30, 32, 0, 360, withAlpha(C, 0.45));
                cv.circle(cx, by, 25, C);
                cv.polyline([[cx - 11, by + 1], [cx - 4, by + 8], [cx + 11, by - 8]], 4.5, '#04101a');
                cv.text('CONNECTED TO ' + providerName().toUpperCase(), cx, 212 + sh, 20, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });
                const ml = ai.modelLabel();
                cv.text('Model: ' + (ml || ai.config.model || 'default') + (ml ? ' (answered last)' : ''), cx, 238 + sh, 16, '#cbd5e1', { align: 'center' });
                const pill = (y, on, text) => {
                    const w = 440, x = cx - w / 2;
                    cv.roundRect(x, y, w, 32, 16, withAlpha(on ? '#2af575' : '#ffffff', on ? 0.12 : 0.06));
                    cv.circle(x + 22, y + 16, 5, on ? '#2af575' : '#94a3b8');
                    cv.text(text, x + 38, y + 21, 14, on ? '#2af575' : '#94a3b8', { font: 'bold' });
                };
                pill(278 + sh, ai.hasInternet, ai.hasInternet ? 'Internet: online' : 'Internet: offline (phone hotspot?)');
                // disconnecting (or a new AI key) is the phone's: the car follows it live
                cv.text('Disconnect or change the AI key on your phone.', cx, 380 + ex, 14, '#64748b', { align: 'center' });
            } else {
                // the QR code grows into the room a taller page has (no bar), the block centred in the panel
                const qs = Math.min(320, 210 + Math.round(ex * 0.9)), top = 92, bottom = 52 + 458 + ex - 12;
                const block = qs + 20 + 108, y0 = top + Math.max(0, Math.floor((bottom - top - block) / 2));
                drawQr(cv, cloudPair.getPairingUrl(), cx - qs / 2, y0 + 10, qs);
                const ty = y0 + qs + 56;
                cv.text('Scan with your phone to connect an AI', cx, ty, 18, t.text, { align: 'center', font: 'bold' });
                cv.text('PAIRING CODE: ' + cloudPair.getShortCode(), cx, ty + 26, 15, '#00f0ff', { align: 'center', font: 'bold', spacing: 1 });
                cv.text('Google Gemini (free), Claude, OpenAI, Groq or OpenRouter', cx, ty + 50, 14, '#94a3b8', { align: 'center' });
                cv.text('hexlay.github.io/idrive7-custom-apps/copilot.html', cx, ty + 72, 12, '#64748b', { align: 'center' });
            }

            // right: what is set from the phone (the only place it can be changed)
            G.panelExact(cv, t, 700, 52, 860, 458 + ex, 'Set From Your Phone');
            if (showPhoneQr && paired) {
                const qs2 = Math.min(280, 180 + Math.round(ex * 0.8)), y2 = 96 + Math.max(0, Math.floor((410 + ex - 96 - qs2 - 92) / 2));
                drawQr(cv, cloudPair.getPairingUrl(), 1130 - qs2 / 2, y2 + 10, qs2);
                cv.text('Open the phone page for this car', 1130, y2 + qs2 + 48, 17, t.text, { align: 'center', font: 'bold' });
                cv.text('Car profile, AI model, Disconnect', 1130, y2 + qs2 + 72, 14, '#94a3b8', { align: 'center' });
                // the camera opens the browser; on iPhone the Home Screen app keeps its own cars
                cv.text('Installed the phone app? Scan with its Scan car QR, not the camera.', 1130, y2 + qs2 + 94, 13, '#64748b', { align: 'center' });
            } else {
                const p = vehicle.profile || {};
                const lines = Vehicle.profileLines(p).filter((l) => !/^Country|^Model \(owner\)/.test(l));
                const rows = [['Model', p.model || 'not set']].concat(lines.map((l) => { const i = l.indexOf(': '); return [l.slice(0, i), l.slice(i + 2)]; }));
                rows.push(['Country', p.country || 'not set'], ['Answer language', LANG_NAMES[p.lang] || 'English'], ['AI model', ai.config.model || 'default']);
                const rstep = 26 + Math.min(12, Math.floor(ex / 8));
                rows.slice(0, 10).forEach(([k, v], i) => {
                    const y = 134 + i * rstep;
                    cv.text(k, 730, y, 14, t.dim);
                    cv.text(v.length > 52 ? v.slice(0, 51) + '…' : v, 1530, y, 14, /not set|default/.test(v) ? t.dim : '#e2e8f0', { align: 'right' });
                });
                cv.text('Change these on the phone page: Your car and AI model.', 730, 408 + ex, 13, '#64748b');
            }
            if (paired) {
                const bw = 300, bx = 1130 - bw / 2, by = 424 + ex, bh = 40;
                cv.roundRect(bx, by, bw, bh, 10, '#004e8c');
                cv.strokeRoundRect(bx, by, bw, bh, 10, 1.5, '#00a3e0');
                cv.text(showPhoneQr ? 'BACK TO THE SETTINGS' : 'SHOW QR FOR THE PHONE PAGE', 1130, by + 26, 13, '#ffffff', { align: 'center', font: 'bold' });
                cv.target(bx, by, bw, bh, () => { showPhoneQr = !showPhoneQr; render(true); }, 'btn_phone_qr', 10);
            }
        }
        /** The co-driver before an AI is paired: where to pair. */
        function drawNeedsConnect(cv, t) {
            G.panelExact(cv, t, 40, 52, 1520, 458 + (cv.extra || 0), '');
            const sh = Math.floor((cv.extra || 0) / 2);
            cv.text('M-COPILOT NEEDS AN AI KEY FROM YOUR PHONE', 800, 210 + sh, 24, '#00a3e0', { align: 'center', font: 'bold', spacing: 1 });
            cv.text('Pair once on the Connect tab: scan its QR code with your phone and choose a provider (Google Gemini is free).', 800, 248 + sh, 16, '#cbd5e1', { align: 'center' });
            const bw = 320, bx = 800 - bw / 2, by = 290 + sh, bh = 50;
            cv.roundRect(bx, by, bw, bh, 10, '#004e8c');
            cv.strokeRoundRect(bx, by, bw, bh, 10, 1.5, '#00a3e0');
            cv.text('OPEN CONNECT', 800, by + 32, 17, '#ffffff', { align: 'center', font: 'bold' });
            cv.target(bx, by, bw, bh, () => { page = 2; render(true); }, 'btn_open_connect', 10);
        }

        /* ---------- On-Screen Touch Keyboard (Panel 2) ---------- */
        function drawKeyboard(cv, t, now) {
            G.panelExact(cv, t, 510, 52, 1050, 458 + (cv.extra || 0), 'Ask Custom Question');

            // Live Engine Vitals in header
            cv.text(vitalsLine(), 1530, 80, 13, t.dim, { align: 'right', font: 'num' });

            const kx = 540, kw = 990;

            // 1. Query Input Display Box
            const qBoxY = 104, qBoxH = 46;
            cv.roundRect(kx, qBoxY, kw, qBoxH, 8, '#080d14');
            cv.strokeRoundRect(kx, qBoxY, kw, qBoxH, 8, 1.5, '#00a3e0');

            const hasText = !!customQuery.trim();
            const displayText = hasText ? tail(customQuery, 100) + '_' : 'Type your question with touch keyboard or tap a preset below...';
            cv.text(displayText, kx + 18, qBoxY + 30, 15, hasText ? '#ffffff' : '#64748b', { font: hasText ? 'bold' : 'normal' });

            // Clear button inside input bar
            if (hasText) {
                const clrW = 70, clrH = 32, clrX = kx + kw - 78, clrY = qBoxY + 7;
                cv.roundRect(clrX, clrY, clrW, clrH, 6, withAlpha('#e1001a', 0.22));
                cv.strokeRoundRect(clrX, clrY, clrW, clrH, 6, 1, '#e1001a');
                cv.text('CLEAR', clrX + clrW / 2, clrY + 21, 12, '#ff6b6b', { align: 'center', font: 'bold' });
                cv.target(clrX, clrY, clrW, clrH, () => {
                    customQuery = '';
                    render(true);
                }, 'kb_btn_clear', 8);
            }

            // 2. Quick Preset Chips Row
            const presetY = 158, presetH = 26;
            const presets = [
                'What is my boost?',
                'Brake pad health',
                'Cold start high idle',
                'Recommended oil spec',
                'Scan active fault codes'
            ];
            let px = kx;
            presets.forEach((pr, pIdx) => {
                const pw = pr.length * 8 + 20;
                cv.roundRect(px, presetY, pw, presetH, 13, '#101a28');
                cv.strokeRoundRect(px, presetY, pw, presetH, 13, 1, '#1e324c');
                cv.text(pr, px + pw / 2, presetY + 17, 12, '#cbd5e1', { align: 'center' });
                cv.target(px, presetY, pw, presetH, () => {
                    customQuery = pr;
                    render(true);
                }, 'kb_preset_' + pIdx, 6);
                px += pw + 10;
            });

            // 3. Speller Keyboard Key Rows
            const kbY = 194;
            const keyH = 38;
            const keyGap = 6;

            const rows = [
                ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '?'],
                ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
                ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
                ['Z', 'X', 'C', 'V', 'B', 'N', 'M', '.', ',']
            ];

            rows.forEach((row, rIdx) => {
                const ry = kbY + rIdx * (keyH + keyGap);
                const count = row.length;
                const keyW = Math.floor((kw - (count - 1) * keyGap) / count);

                row.forEach((k, cIdx) => {
                    const kxPos = kx + cIdx * (keyW + keyGap);
                    cv.roundRect(kxPos, ry, keyW, keyH, 6, '#0f1724');
                    cv.strokeRoundRect(kxPos, ry, keyW, keyH, 6, 1, '#1e2d42');
                    cv.text(k, kxPos + keyW / 2, ry + 25, 16, '#ffffff', { align: 'center', font: 'bold' });

                    cv.target(kxPos, ry, keyW, keyH, () => {
                        if (customQuery.length < QUERY_MAX) customQuery += k;
                        render(true);
                    }, 'kb_k_' + rIdx + '_' + cIdx, 6);
                });
            });

            // 4. Action Row (Row 5)
            const aY = kbY + 4 * (keyH + keyGap);
            const aH = 42;

            // Cancel button
            const canW = 140, canX = kx;
            cv.roundRect(canX, aY, canW, aH, 8, '#141f2e');
            cv.strokeRoundRect(canX, aY, canW, aH, 8, 1, '#253347');
            cv.text('CANCEL', canX + canW / 2, aY + 27, 14, '#94a3b8', { align: 'center', font: 'bold' });
            cv.target(canX, aY, canW, aH, () => {
                showKeyboard = false;
                render(true);
            }, 'kb_act_cancel', 8);

            // Spacebar
            const spW = 410, spX = canX + canW + keyGap;
            cv.roundRect(spX, aY, spW, aH, 8, '#0f1724');
            cv.strokeRoundRect(spX, aY, spW, aH, 8, 1, '#1e2d42');
            cv.text('SPACEBAR', spX + spW / 2, aY + 27, 14, '#cbd5e1', { align: 'center', font: 'bold' });
            cv.target(spX, aY, spW, aH, () => {
                if (customQuery.length < QUERY_MAX) customQuery += ' ';
                render(true);
            }, 'kb_act_space', 8);

            // Backspace / Del
            const delW = 150, delX = spX + spW + keyGap;
            cv.roundRect(delX, aY, delW, aH, 8, '#1f1418');
            cv.strokeRoundRect(delX, aY, delW, aH, 8, 1, '#421a22');
            cv.text('BACKSPACE', delX + delW / 2, aY + 27, 13, '#ff8080', { align: 'center', font: 'bold' });
            cv.target(delX, aY, delW, aH, () => {
                customQuery = customQuery.slice(0, -1);
                render(true);
            }, 'kb_act_del', 8);

            // Ask Copilot / Submit
            const askW = 270, askX = delX + delW + keyGap;
            cv.roundRect(askX, aY, askW, aH, 8, hasText ? '#00a3e0' : '#1e293b');
            if (hasText) cv.strokeRoundRect(askX, aY, askW, aH, 8, 1.5, '#00f0ff');
            cv.text('ASK M-COPILOT >', askX + askW / 2, aY + 27, 15, hasText ? '#ffffff' : '#64748b', { align: 'center', font: 'bold', spacing: 1 });
            cv.target(askX, aY, askW, aH, () => {
                if (hasText) {
                    const q = customQuery.trim();
                    customQuery = '';
                    showKeyboard = false;
                    askCopilot(q, 'Custom: ' + (q.length > 25 ? q.slice(0, 25) + '...' : q));
                }
            }, 'kb_act_go', 10);
        }

        /* ---------- M-Copilot AI Main Screen (2-Panel Wide Architecture) ---------- */
        function drawMainCopilot(cv, t, now) {
            const curCat = TOPIC_CATEGORIES[activeCategory] || TOPIC_CATEGORIES[0];
            const topics = curCat.topics;

            // Panel 1 (Left): Quick Topics & Custom Query Action (No header text)
            G.panelExact(cv, t, 40, 52, 440, 458 + (cv.extra || 0), '');

            // category tabs
            const ex = cv.extra || 0;
            const tabY = 64, tabH = 34;
            TOPIC_CATEGORIES.forEach((cat, cIdx) => {
                const tabW = 96, tabX = 60 + cIdx * 101, isCurCat = activeCategory === cIdx;
                cv.roundRect(tabX, tabY, tabW, tabH, 7, isCurCat ? '#004e8c' : t.track);
                cv.strokeRoundRect(tabX, tabY, tabW, tabH, 7, 1, isCurCat ? '#00a3e0' : t.panelEdge);
                cv.text(cat.name, tabX + tabW / 2, tabY + 22, 12, isCurCat ? '#00f0ff' : '#94a3b8', { align: 'center', font: isCurCat ? 'bold' : 'normal' });
                cv.target(tabX, tabY, tabW, tabH, () => {
                    activeCategory = cIdx;
                    selectedTopicIdx = 0;
                    currentPrompt = cat.topics[0].title;
                    render(true);
                }, 'cat_' + cIdx, 6);
            });

            // the question box at the bottom, the topic chips filling the room above it (taller on bigger screens)
            const inputH = 60, inputX = 60, inputW = 400, inputY = 52 + 458 + ex - 14 - inputH;
            const chipTop = 110, step = Math.floor((inputY - 12 - chipTop) / topics.length), topicH = Math.min(64, step - 6);
            topics.forEach((p, idx) => {
                const py = chipTop + idx * step;
                const isSelected = selectedTopicIdx === idx, isCur = currentPrompt === p.title;
                cv.roundRect(60, py, 400, topicH, 9, isSelected ? withAlpha('#00a3e0', 0.22) : t.track);
                cv.strokeRoundRect(60, py, 400, topicH, 9, isSelected ? 1.5 : 1, isSelected ? '#00a3e0' : t.panelEdge);
                cv.circle(82, py + topicH / 2, 5, isCur ? '#00f0ff' : (isSelected ? '#00a3e0' : t.dim));
                cv.text(p.title, 102, py + topicH / 2 + 5, 15, isSelected ? '#ffffff' : '#cbd5e1', { font: isSelected ? 'bold' : 'normal' });
                cv.target(60, py, 400, topicH, () => {
                    selectedTopicIdx = idx;
                    showKeyboard = false;
                    askCopilot(p.query, p.title, { fresh: true, faults: !!p.faults });
                }, 'chip_' + idx, 8);
            });

            cv.roundRect(inputX, inputY, inputW, inputH, 10, showKeyboard ? withAlpha('#00a3e0', 0.25) : '#0b111a');
            cv.strokeRoundRect(inputX, inputY, inputW, inputH, 10, showKeyboard ? 1.5 : 1, showKeyboard ? '#00f0ff' : '#1e2d42');
            const hasCustom = !!customQuery.trim();
            const inputLabel = hasCustom ? (tail(customQuery, 38) + (showKeyboard ? '_' : '')) : (showKeyboard ? 'Typing custom question..._' : 'Ask Custom Question...');
            cv.text(inputLabel, inputX + 18, inputY + inputH / 2 + 6, 16, hasCustom ? '#ffffff' : (showKeyboard ? '#00f0ff' : '#94a3b8'), { font: (hasCustom || showKeyboard) ? 'bold' : 'normal' });
            cv.target(inputX, inputY, inputW, inputH, () => {
                showKeyboard = !showKeyboard;
                render(true);
            }, 'btn_custom_input', 10);

            // Panel 2 (Right): Interactive Touch Keyboard OR Dialogue Stream
            if (showKeyboard) {
                drawKeyboard(cv, t, now);
                return;
            }

            const dEx = 48 + (cv.extra || 0);   // the dialogue grows down to the page's bottom
            G.panelExact(cv, t, 510, 52, 1050, 410 + dEx, 'Dialogue: ' + currentPrompt);

            // Live Engine Vitals in header
            cv.text(vitalsLine(), 1530, 80, 13, t.dim, { align: 'right', font: 'num' });

            // Response Box Card
            const rx = 530, ry = 104, rw = 1010, rh = 340 + dEx;
            cv.roundRect(rx, ry, rw, rh, 12, '#090e15');
            cv.strokeRoundRect(rx, ry, rw, rh, 12, 1, t.panelEdge);

            // Left decorative M stripe on response card
            cv.fillRect(rx + 2, ry + 12, 4, rh - 24, '#00a3e0');

            // follow-up chips along the bottom of the card after a real answer
            const chips = canFollowUp && !isThinking, chipH = 36, chipY = ry + rh - chipH - 12;
            if (chips) {
                let cx = rx + 24;
                FOLLOW_UPS.forEach((f, i) => {
                    const w = 32 + f.title.length * 9;
                    cv.roundRect(cx, chipY, w, chipH, 8, withAlpha('#00a3e0', 0.15));
                    cv.strokeRoundRect(cx, chipY, w, chipH, 8, 1, '#00a3e0');
                    cv.text(f.title, cx + w / 2, chipY + 24, 15, '#e2e8f0', { align: 'center', font: 'bold' });
                    cv.target(cx, chipY, w, chipH, () => askCopilot(f.query, f.title, { fresh: false }), 'follow_' + i, 8);
                    cx += w + 12;
                });
            }

            // Render Response text with wrap and scroll: bigger while the car is moving (a glance, not a read)
            const big = telemetry.moving === true, lineH = big ? 34 : 26, size = big ? 21 : 16;
            rowH = lineH;
            const shown = isThinking ? currentResponse + '  ' + Math.floor((Date.now() - thinkStart) / 1000) + ' s' : currentResponse;
            const lines = wrapLines(shown, big ? 66 : 88);
            const maxVisibleLines = Math.floor((rh - 24 - (chips ? chipH + 18 : 0)) / lineH);
            dialogueRows = { count: lines.length, visible: maxVisibleLines };
            cv.scroll = true;
            const maxScroll = Math.max(0, lines.length - maxVisibleLines);
            if (dialogueScroll > maxScroll) dialogueScroll = maxScroll;

            const visible = lines.slice(dialogueScroll, dialogueScroll + maxVisibleLines);
            visible.forEach((line, idx) => {
                const ly = ry + 36 + idx * lineH;
                let col = '#e2e8f0';
                let isBold = false;

                if (line.startsWith('[OK]') || line.startsWith('✓') || line.includes('PASS') || line.includes('OPTIMAL')) col = '#2af575';
                else if (line.startsWith('[!]') || line.includes('CAUTION') || line.includes('FAIL') || line.includes('Warning')) col = '#ffb703';
                else if ((line.startsWith('[') && line.endsWith(']')) || (line.startsWith('- ') && line.includes(':'))) {
                    isBold = true;
                    col = '#ffffff';
                } else if (/^\d+\./.test(line)) col = '#ffffff';

                cv.text(line, rx + 24, ly, size, col, { font: isBold ? 'bold' : 'normal' });
            });

            // Scrollbar & Page indicator when content exceeds card
            if (lines.length > maxVisibleLines) {
                const sbX = rx + rw - 14, sbY = ry + 20, sbH = (chips ? chipY - ry - 6 : rh) - 40;
                cv.roundRect(sbX, sbY, 4, sbH, 2, withAlpha(t.panelEdge, 0.4));
                const thumbH = Math.max(24, Math.floor((maxVisibleLines / lines.length) * sbH));
                const thumbY = sbY + Math.floor((dialogueScroll / maxScroll) * (sbH - thumbH));
                cv.roundRect(sbX, thumbY, 4, thumbH, 2, '#00a3e0');

                // Page badge
                const curPage = Math.floor(dialogueScroll / maxVisibleLines) + 1;
                const totPages = Math.ceil(lines.length / maxVisibleLines);
                const textH = chips ? chipY - ry - 6 : rh;
                cv.text(`PAGE ${curPage}/${totPages}`, rx + rw - 24, ry + textH - 12, 12, t.dim, { align: 'right', font: 'num' });

                // Touch targets to scroll
                cv.target(rx, ry, rw, textH / 2, () => {
                    dialogueScroll = Math.max(0, dialogueScroll - 4);
                    render(true);
                }, 'card_scroll_up', 4);

                cv.target(rx, ry + textH / 2, rw, textH / 2, () => {
                    dialogueScroll = Math.min(maxScroll, dialogueScroll + 4);
                    render(true);
                }, 'card_scroll_down', 4);
            }
        }

        /* ---------- Data check: what this car gives, source by source ---------- */
        let missingAtInstall = null;
        const missingList = () => {
            if (missingAtInstall === null) {
                missingAtInstall = Vehicle.missingAtInstall();
            }
            return missingAtInstall;
        };
        const IF = { cds: 'de.bmw.infotainment.vehicle.CDS', cds2: 'de.bmw.infotainment.vehicle.CDS2', v2: 'de.bmw.infotainment.vehicle.Vehicle2', fes: 'de.bmw.infotainment.drivingexcitement.FES',
            vi: 'de.bmw.infrastructure.VehicleInformation', tpms: 'de.bmw.infotainment.vehicle.TPMS', env: 'de.bmw.infrastructure.EnvironmentalInformation', kombi: 'de.bmw.infotainment.KombiIF',
            cond: 'de.bmw.infrastructure.VehicleCondition', veh: 'de.bmw.infotainment.vehicle.Vehicle', cc: 'de.bmw.infotainment.checkcontrol.CheckControlMaster', k2: 'de.bmw.infotainment.KombiInterface_2',
            tasu: 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu' };
        const fix = (v, d) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d || 0) : null);
        let checking = null;                // 'engine' / 'faults' while a button's read runs
        /** a signal row: green with the value, or why there is none */
        function sigState(value, iface, field) {
            const miss = missingList();
            if (miss[iface] || (field && miss[iface + ' ' + field])) return { c: 'grey', v: 'not on this car (firmware)' };
            if (value !== null && value !== undefined && value !== '') return { c: 'green', v: String(value) };
            const subs = car ? car.subs || [] : [];
            const sub = subs.find((x) => x && x.iface === iface);
            if (!car && !sub) return { c: 'amber', v: 'not subscribed' };
            if (sub && sub.error) return { c: 'red', v: 'error: ' + String(sub.error).slice(0, 24) };
            if (sub && !sub.available) return { c: 'amber', v: 'waiting for the car' };
            return { c: 'amber', v: 'no data yet' };
        }
        function drawDataCheck(cv, t) {
            const ex = cv.extra || 0;
            G.panelExact(cv, t, 40, 52, 1520, 458 + ex, '');
            const COL = { green: '#2af575', amber: '#ffb703', red: '#ef4444', grey: t.dim };
            const step = 22 + Math.min(10, Math.floor(ex / 16)), top = 100;
            const row = (x, w, i, label, st) => {
                const y = top + i * step;
                cv.circle(x + 6, y - 4, 4, COL[st.c] || t.dim);
                cv.text(label, x + 18, y, 13, t.dim);
                const v = st.v.length > 34 ? st.v.slice(0, 33) + '…' : st.v;
                cv.text(v, x + w, y, 13, st.c === 'grey' ? t.dim : '#e2e8f0', { align: 'right' });
            };
            const head = (x, label) => cv.text(label, x, top - 26, 14, '#00a3e0', { font: 'bold', spacing: 1 });
            const g = (v) => (v === null || v === undefined || v === '' ? null : v);
            const ok = (v, why) => (g(v) !== null ? { c: 'green', v: String(v) } : { c: why && why.c ? why.c : 'amber', v: (why && why.v) || 'not known yet' });

            // 1. the car and the links
            const x1 = 60, w1 = 460;
            head(x1, 'CAR & LINKS');
            const d = vehicle.vin ? Vehicle.decodeVin(vehicle.vin) : null, u = vehicle.unitTypes();
            const CONDS = { 1: 'parked', 2: 'parked', 3: 'parked, driver away', 5: 'parked, no ignition', 7: 'ignition on', 8: 'getting ready', 10: 'drive-ready', 12: 'switching off' };
            const dtc = telemetry.dtcScan, units = telemetry.units || {};
            const miss = Object.keys(missingList());
            const link = diag ? (diag.available ? { c: 'green', v: 'ready' } : diag.error ? { c: 'red', v: 'not available' } : { c: 'amber', v: 'waiting' }) : { c: 'amber', v: 'not opened yet' };
            [
                ['VIN (type part)', ok(d && d.descriptor + (vehicle.vinFrom ? ' · ' + vehicle.vinFrom : ''), { c: 'amber', v: 'not received' })],
                ['Make, model year', ok(d && [d.brand, d.year].filter(Boolean).join(', '))],
                ['Engine type', sigState(vehicle.engineType, IF.v2, 'statusVehiclePartType')],
                ['Engine unit', ok(u[0x12], { c: vehicle.tried ? 'grey' : 'amber', v: vehicle.tried ? 'not in the table' : 'not read yet' })],
                ['Gearbox unit', ok(u[0x18], { c: vehicle.tried ? 'grey' : 'amber', v: vehicle.tried ? 'not in the table' : 'not read yet' })],
                ['Vehicle state', sigState(CONDS[telemetry.condition], IF.cond, 'VehicleCondition')],
                ['Engine', ok(engineState(), { v: 'not known' })],
                ['Units', sigState(units.press || units.temp ? [units.press, units.temp, units.speed].filter(Boolean).join(' / ') : null, IF.veh, 'statusNewCurrentUnitsStatusExt')],
                ['Diagnostic link', link],
                ['Fault memory', dtc ? (dtc.error ? { c: 'red', v: dtc.error.slice(0, 34) } : { c: dtc.partial ? 'amber' : 'green', v: dtc.answered + ' units, ' + dtc.total + ' faults' + (dtc.partial ? ', partial' : '') }) : { c: 'amber', v: 'not read yet' }],
                ['Check Control', sigState(Array.isArray(telemetry.checkControl) ? (telemetry.checkControl.length ? telemetry.checkControl.length + ' active' : 'none active') : null, IF.cc, 'basicList')],
                ['Service list', sigState(Array.isArray(telemetry.service) ? telemetry.service.length + ' items' : null, IF.k2, 'cbsDataServiceList')],
                ['AI', ai.isConfigured() ? { c: 'green', v: providerName() + (ai.modelLabel() ? ' · ' + ai.modelLabel() : '') } : { c: 'amber', v: 'not paired' }],
                ['Internet', ai.hasInternet ? { c: 'green', v: 'online' } : { c: 'red', v: 'offline' }],
                ['Left out at install', miss.length ? { c: 'grey', v: miss.length + ': ' + miss.map((k) => k.split('.').pop()).join(', ') } : { c: 'green', v: 'nothing' }],
            ].forEach((r, i) => row(x1, w1, i, r[0], r[1]));

            // 2. live signals
            const x2 = 560, w2 = 460;
            head(x2, 'LIVE SIGNALS');
            const tt = telemetry, c4 = (o, f) => (o ? ['fl', 'fr', 'rl', 'rr'].map((k) => fix(o[k], f)).join(' ') : null);
            [
                ['Speed', sigState(tt.speed !== null ? tt.speed + ' km/h' : null, IF.v2, 'statusCarSpeed2')],
                ['Engine speed', sigState(tt.rpm !== null ? tt.rpm + ' rpm' : null, IF.cds, 'statusEngineSpeed2')],
                ['Gear', sigState(tt.stage || (tt.gear !== null ? String(tt.gear) : null), IF.vi)],
                ['Engine torque', sigState(tt.torque !== null ? tt.torque + ' Nm' : null, IF.fes, 'statusActualValueTorque2')],
                ['Sport display (power, boost)', sigState(tt.powerPct !== null || tt.boost !== null ? [tt.powerPct !== null ? tt.powerPct + ' %' : '', tt.boost !== null ? fix(tt.boost, 2) + ' bar' : ''].filter(Boolean).join(', ') : null, IF.fes, 'statusVehicleDynamicEngine')],
                ['Driving mode', sigState(tt.mode, IF.fes, 'statusFESVehicleDynamicSwitchHMI')],
                ['Oil / coolant temperature', sigState(tt.oilTemp !== null ? tt.oilTemp + ' / ' + tt.coolantTemp + ' °C' : null, IF.cds, 'statusEngineTemperature')],
                ['Oil level', sigState(tt.oilLevel, IF.v2, 'statusOilDipstick2')],
                ['Outside temperature', sigState(tt.ambient !== null ? fix(tt.ambient, 1) + ' °C' : null, IF.env, 'ExteriorTemperature')],
                ['Tyre pressures (bar)', sigState(c4(tt.tyres, 1), IF.tpms, 'statusTyrePressure')],
                ['Tyre temperatures (°C)', sigState(c4(tt.tyreTemps, 0), IF.tpms, 'statusTyreTemperature')],
                ['Fuel / range', sigState(tt.fuelL !== null ? tt.fuelL + ' l / ' + tt.rangeKm + ' km' : null, IF.kombi, 'statusRangeTankStatus')],
                ['Odometer', sigState(tt.odoKm !== null ? tt.odoKm + ' km' : null, IF.kombi, 'statusRangeTankStatus')],
                ['Trip average', sigState(tt.avgCons ? fix(tt.avgCons.value, 1) + ' ' + tt.avgCons.unit : null, IF.kombi, 'statusBordcomputerAverage')],
                ['12 V battery charge', sigState(tt.batteryPct !== null ? tt.batteryPct + ' %' : null, IF.cds, 'statusBattery2')],
                ['Start-stop / parking brake', sigState(tt.msa || tt.handbrake ? [tt.msa ? 'start-stop ' + tt.msa : '', tt.handbrake ? 'brake ' + tt.handbrake : ''].filter(Boolean).join(', ') : null, IF.cds2, 'statusPushButtonMSA2')],
                ['Engine state signal', sigState(tt.engine, IF.cds, 'statusEngineStatus')],
            ].forEach((r, i) => row(x2, w2, i, r[0], r[1]));

            // 3. the engine computer (engine_snapshot.js)
            const x3 = 1060, w3 = 470;
            head(x3, 'ENGINE COMPUTER');
            const NAMES = { boostActual: 'Boost actual', boostTarget: 'Boost target', baro: 'Outside air pressure', iat: 'Intake air', loadActual: 'Load actual', loadTarget: 'Load target',
                timing: 'Ignition timing', hpfp: 'High-pressure fuel', lpfp: 'Low-pressure fuel', gearboxOil: 'Gearbox oil', oil: 'Engine oil (unit)', v12: '12 V voltage', misfire: 'Misfires',
                hvSoc: 'HV battery charge', hvSoh: 'HV battery health' };
            const FMT = { boostActual: (v) => fix(v, 2) + ' bar', boostTarget: (v) => fix(v, 2) + ' bar', baro: (v) => fix(v) + ' kPa', iat: (v) => fix(v) + ' °C', loadActual: (v) => fix(v) + ' %',
                loadTarget: (v) => fix(v) + ' %', timing: (v) => fix(v, 1) + '°', hpfp: (v) => fix(v) + ' bar', lpfp: (v) => fix(v, 1) + ' bar', gearboxOil: (v) => fix(v) + ' °C', oil: (v) => fix(v) + ' °C',
                v12: (v) => fix(v, 2) + ' V', misfire: (v) => v.join(' '), hvSoc: (v) => fix(v) + ' %', hvSoh: (v) => fix(v) + ' %' };
            const RUN_ONLY = ['boostActual', 'boostTarget', 'loadActual', 'loadTarget', 'timing', 'misfire'];
            const snapOff = telemetry.engineSnap && telemetry.engineSnap.engine === 'off';
            const rep = snapshot ? snapshot.report() : Object.keys(NAMES).map((name) => ({ name }));
            rep.forEach((r, i) => {
                let st;
                if (r.value !== undefined && r.value !== null) st = { c: 'green', v: FMT[r.name](r.value) + (r.via ? ' · ' + r.via : '') };
                else if (carAwake() === 'asleep') st = { c: 'grey', v: 'car asleep (ignition off)' };
                else if (!diag || !diag.available) st = { c: diag && diag.error ? 'red' : 'amber', v: 'no diagnostic link' + (diag && diag.error ? '' : ' yet') };
                else if (snapOff && RUN_ONLY.indexOf(r.name) >= 0) st = { c: 'grey', v: 'engine off: not read' };
                else if ((r.name === 'hvSoc' || r.name === 'hvSoh') && snapshot && snapshot.hvMissing) st = { c: 'grey', v: 'no HV battery' };
                else if (r.why) st = { c: r.fails >= 3 ? 'red' : 'amber', v: r.why + (r.fails ? ' (' + r.fails + 'x)' : '') };
                else st = { c: 'amber', v: 'not read yet' };
                row(x3, w3, i, NAMES[r.name], st);
            });

            // buttons: read now (the same safety rules: steady car, never while asleep)
            const by = top + 15 * step + 6, bw = 225, bh = 38;
            [['engine', 'READ ENGINE NOW', x3], ['faults', 'READ FAULTS NOW', x3 + bw + 20]].forEach(([what, label, bx]) => {
                const busy = checking === what;
                cv.roundRect(bx, by, bw, bh, 8, busy ? withAlpha('#00a3e0', 0.35) : '#004e8c');
                cv.strokeRoundRect(bx, by, bw, bh, 8, 1.5, '#00a3e0');
                cv.text(busy ? 'READING...' : label, bx + bw / 2, by + 25, 14, '#ffffff', { align: 'center', font: 'bold' });
                cv.target(bx, by, bw, bh, () => checkNow(what), 'dc_' + what, 8);
            });
        }
        async function checkNow(what) {
            if (checking || isThinking) return;
            checking = what;
            render(true).catch(() => {});
            try {
                if (carAwake() === 'asleep') notify('The car is asleep: switch the ignition on (the engine can stay off).');
                else if (!steady()) notify('The engine is starting or stopping: try again in a moment.');
                else if (what === 'engine') {
                    if (snapshot) snapshot.last = null;
                    await identifyCar();
                    await engineSnapshot();
                    const n = telemetry.engineSnap ? Object.keys(telemetry.engineSnap.values).length : 0;
                    notify(!diag || !diag.available ? 'No diagnostic link to the car: nothing could be read.'
                        : n ? 'Engine computer: ' + n + ' values read.' : 'The engine computer gave no values.');
                } else {
                    if (telemetry.dtcScan) telemetry.dtcScan = null;
                    const keep = currentResponse;
                    await scanFaults();
                    currentResponse = keep;
                    const dd = telemetry.dtcScan;
                    notify(dd && !dd.error ? 'Fault memory: ' + dd.answered + ' units, ' + dd.total + ' faults.' : 'Fault memory: ' + ((dd && dd.error) || 'not read'));
                }
            } catch (e) {
                notify('Data check: ' + (e.message || e));
            } finally {
                checking = null;
                render(true).catch(() => {});
            }
        }

        /* ---------- Adaptive Pacing Render Loop ---------- */
        let lastSig = '';
        let page = ai.isConfigured() ? 0 : 2;   // 0 the co-driver, 1 Data check, 2 Connect (first, until paired)
        let showPhoneQr = false;            // Connect: the phone page's QR in place of the settings list
        async function render(force = false) {
            const now = Date.now();
            if (!force && now - lastRenderTime < 250) return;
            const cv = ctx.canvas(W, H);
            // what the frame shows: unchanged, the frame isn't drawn again (a safety redraw every 2 s)
            const sig = [ai.hasInternet, ai.isConfigured(), showPhoneQr, showKeyboard, customQuery, activeCategory, selectedTopicIdx, currentPrompt, currentResponse,
                dialogueScroll, canFollowUp, isThinking, telemetry.moving, vitalsLine(), statusMsg && now - statusTime < 3500 ? statusMsg : '', ai.modelLabel(), providerName(),
                cv.extra || 0, page === 2 ? cloudPair.getPairingUrl() + JSON.stringify(vehicle.profile || {}) + (ai.config.model || '') : '', page, page === 1 ? Math.floor(now / 1000) + (checking || '') : ''].join('|');
            if (!force && sig === lastSig && now - lastRenderTime < 2000) return;
            lastSig = sig;
            lastRenderTime = now;

            const t = ctx.theme();
            cv.clear(t.bg);

            // Mandatory Online & Config Checks (the Data check page works without internet or pairing)
            if (page === 1) {
                drawDataCheck(cv, t);
            } else if (page === 2) {
                drawConnect(cv, t);
            } else if (!ai.hasInternet) {
                drawNoInternet(cv, t);
            } else if (!ai.isConfigured()) {
                drawNeedsConnect(cv, t);
            } else {
                drawMainCopilot(cv, t, now);
            }

            // G-Series Live Cockpit frame tabs along the top: clean single title + live status badges
            const ml = ai.modelLabel();
            const provName = providerName().toUpperCase() + (ml ? ' · ' + ml : '');
            G.frame(cv, t, PAGES, page, [
                { text: 'READ-ONLY SAFE', color: '#2af575' },
                { text: ai.isConfigured() ? `${provName} ONLINE` : 'SETUP REQUIRED', color: ai.isConfigured() ? '#00a3e0' : '#ffb703' }
            ]);

            // Global Notification banner
            if (statusMsg && (now - statusTime < 3500)) {
                const sy = H + (cv.extra || 0);
                cv.roundRect(W / 2 - 320, sy - 56, 640, 42, 10, '#00a3e0');
                cv.text(statusMsg, W / 2, sy - 29, 18, '#ffffff', { align: 'center', font: 'bold' });
            }

            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- HMI Button & Touch Interactions ---------- */
        ui.onClick('BTN_PROMPT', () => {
            if (showKeyboard && customQuery.trim()) {
                const q = customQuery.trim();
                customQuery = '';
                showKeyboard = false;
                askCopilot(q, 'Custom: ' + (q.length > 25 ? q.slice(0, 25) + '...' : q));
            } else {
                const currentCat = TOPIC_CATEGORIES[activeCategory] || TOPIC_CATEGORIES[0];
                const currentTopic = currentCat.topics[selectedTopicIdx] || currentCat.topics[0];
                askCopilot(currentTopic.query, currentTopic.title, { fresh: true, faults: !!currentTopic.faults });
            }
            return render(true);
        });

        // Where the kit runs the screen, no bottom bar: the topic chips ask and Connect is a tab, so both bar
        // buttons are left out (the kit then drops the empty bar and gives the page its height). On the
        // HMI's own path they stay, so the controller can still reach both actions there.
        if (ctx.hideButton) { ctx.hideButton('BTN_PROMPT'); ctx.hideButton('BTN_REPAIR'); }

        ui.onClick('BTN_REPAIR', () => {
            page = 2;
            showKeyboard = false;
            return render(true);
        });

        ctx.onTab((i) => {
            page = i === 1 || i === 2 ? i : 0;
            showKeyboard = false;
            return render(true);
        });

        // Run low-frequency idle loop (4 fps) to minimize CPU/GPU load by >85%
        // ---- lifecycle: nothing runs while M-Copilot is not on screen; everything stops on exit
        function foreground() {
            clearLive();
            startCar();
            loadSampling(true);
            cloudPair.startPolling();
            // a fresh hello on the channel (the relay keeps it 12 h) shows the car's settings on a
            // phone page opened while the car is off; at most every 6 hours
            if (ai.isConfigured() && Date.now() - lastHello > 6 * 3600 * 1000) hello();
            ai.checkInternetConnection().catch(() => {});
            render(true).catch(() => {});
        }
        function background() {
            stopCar();
            loadSampling(false);
            cloudPair.stopPolling();
            if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; }   // an answer still lands
        }
        ui.onVisible((name, visible) => {
            if (name !== 'MAIN') return;
            log.info('M-Copilot: ' + (visible ? 'on screen' : 'left the screen: background work stopped'));
            if (visible) foreground(); else background();
        });
        if (onScreen()) foreground();
        let exiting = false;
        const exitNow = () => {
            if (exiting) return;
            exiting = true;
            try { background(); } catch (e) {}
            process.exit(0);
        };
        process.on('SIGTERM', exitNow);
        process.on('SIGINT', exitNow);

        ctx.loop('MAIN', 4, render, { maxFps: 10 });
        render(true).then(() => log.info('M-Copilot ready')).catch((e) => log.warn('M-Copilot render error: ' + e));
    }
});
