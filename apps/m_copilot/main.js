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
 *     plus an on-screen keyboard for any question, locked while the car moves (follow-up questions keep the context).
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
const S = require('./kit/scene');
const { AiBridge } = require('./ai');
const { CloudPairManager } = require('./cloud_pair');
const qrcodegen = require('./kit/qrcodegen');

const W = 1600, H = 520;
const PAGES = ['Answer', 'Topics', 'Data check', 'Connect'];

/*
 * Sizes on this display (kit/runtime/panel.js): k = 1.2 on a 12.3" display, 1.44 on a 10.25" one, so keys,
 * chips and text come out the same size in millimetres on both (as CarPlay sizes its own). sz(cv, n): n at the
 * reference size (k = 1), rounded.
 */
const kOf = (cv) => (cv.ui && cv.ui.k) || 1.44;
const sz = (cv, n) => Math.round(n * kOf(cv));
/** str cut with '...' to fit maxW at size (the text's start shows). */
function fitText(cv, str, maxW, size, opts) {
    str = String(str || '');
    if (cv.textWidth(str, size, opts) <= maxW) return str;
    while (str.length > 1 && cv.textWidth(str + '...', size, opts) > maxW) str = str.slice(0, -1);
    return str + '...';
}
/** The end of str that fits maxW at size, '...' before it (what is being typed shows). */
function fitTail(cv, str, maxW, size, opts) {
    str = String(str || '');
    if (cv.textWidth(str, size, opts) <= maxW) return str;
    while (str.length > 1 && cv.textWidth('...' + str, size, opts) > maxW) str = str.slice(1);
    return '...' + str;
}

// Topic chips. Each question leans on what the car reports (the AI gets it with every question) and
// on the car profile, so the same chip fits a stock daily car and a tuned one. faults: read the
// fault memory first (a few seconds).
const TOPIC_CATEGORIES = [
    {
        id: 'check',
        name: 'CHECK',
        label: 'Health & Service',
        topics: [
            { title: 'Quick Health Check', desc: 'All live readings, warnings, service due & stored faults', faults: true, query: 'Do a health check of my car from every reading you have, the warning messages in the cluster, the service list and the fault memory. Start with anything that needs attention and how urgent it is; if all is fine, say so in one line.' },
            { title: 'Warning Lights & Faults', desc: 'Active cluster warnings, ECU fault codes & severity', faults: true, query: 'Which warning messages is my car showing and what is stored in its fault memory, in which units? How serious is it, and can I keep driving normally?' },
            { title: 'Service Due', desc: 'Upcoming CBS items, intervals & what to check yourself', query: 'From my car\'s service list: what is due next and when, what does each item involve for my engine, and what can I check or do myself?' },
            { title: 'Tyres & Pressures', desc: 'Actual vs target pressures & temps for current weather', query: 'Compare my tyre pressures and temperatures with the targets set in the car, taking the outside temperature and my tyre type into account. Should I adjust anything, cold or hot?' },
            { title: 'Brakes & Pads', desc: 'Front & rear pad life, brake fluid due date & wear checks', query: 'How are my brakes from the service list (front and rear pads, brake fluid due date), and which warning signs can I check myself before the next service?' },
            { title: '12V Battery & Start-Stop', desc: 'Charge health, short-trip impact & parking readiness', query: 'How is my 12 V battery from its charge level, and what does that mean for auto start-stop, short trips and the car standing for a few days?' },
        ],
    },
    {
        id: 'drive',
        name: 'DRIVE',
        label: 'Right Now',
        topics: [
            { title: 'Ready for Full Power?', desc: 'Oil & coolant warm-up check before hard acceleration', query: 'Is my engine warm enough for full throttle and high revs right now? Use the oil and coolant temperatures, and say what threshold you use for my engine and tune.' },
            { title: 'Fuel & Range', desc: 'Remaining range, trip consumption & efficiency tips', query: 'How far can I go on the fuel I have, how does my consumption look, and what would make the biggest difference to it on this trip?' },
            { title: 'Weather & Grip', desc: 'Outside temp, tyre grip expectations & ice risk', query: 'With the outside temperature and my tyres as they are now, how much grip should I expect, is there a risk of ice or cold tyres, and what should I change in how I drive?' },
            { title: 'How Was That Drive?', desc: 'Drive summary: warm-up, peaks, heat soak & boost health', query: 'Look at this drive so far: how hard was the car driven, was the engine warm before it was pushed, any heat soak, boost falling short or timing pulled? Anything to change next time?' },
            { title: 'Running Hot? What Now', desc: 'Immediate road steps if coolant, oil or gearbox runs hot', query: 'Look at my temperatures right now: is anything running too hot (coolant, oil, gearbox, intake air)? If so, exactly what should I do on the road right now to protect the engine?' },
            { title: 'Cool-Down & Parking', desc: 'Whether to idle or cruise gently before switching off', query: 'After how I have been driving, should I let the engine idle or drive gently before switching off? Use the oil and coolant temperatures and say why it matters for my engine and tune.' },
        ],
    },
    {
        id: 'perform',
        name: 'PERFORM',
        label: 'Spirited, Track & Tuned',
        topics: [
            { title: 'Launch & 0-100', desc: 'Launch control steps, temp readiness & drivetrain load', query: 'How do I use launch control on my car (gearbox and drivetrain), what must be met for it to work, are my temperatures ready for it now, and how hard is it on the drivetrain with my tune?' },
            { title: 'Track Day Prep', desc: 'Hot/cold pressures, brake fluid, cooling & chassis setup', query: 'Get my car ready for a track day: tyre pressures cold and hot for my tyres, brake fluid and pads from the service list, oil level and cooling, and the settings to use. Use my readings.' },
            { title: 'Tune Health Check', desc: 'Boost vs target, intake temps, timing & headroom', query: 'Look at my boost, torque and temperatures for signs of heat soak, an engine running too hard or a weak point of my tune. For a stock car, say what is normal for it and what headroom it has.' },
            { title: 'Heat Soak & Cooling', desc: 'Thermal limits & managing heat across repeated pulls', query: 'Are my oil and coolant temperatures OK for hard driving right now? At what temperatures does my engine pull power, and how do I manage heat on back-to-back pulls or laps?' },
            { title: 'Gearbox & Clutch Load', desc: 'Torque margin, gearbox oil temp & shift protection', query: 'With my engine\'s torque and my tune, how close is my gearbox (and its clutch or torque converter) to its limits, what does its oil temperature say right now, and how do I avoid hurting it?' },
            { title: 'Mods & Upgrade Path', desc: 'Best next upgrade, supporting mods & reliability trade-offs', query: 'For my car and its current modifications, what is the most sensible next upgrade, what supporting parts does it need, and what does it risk (reliability, warranty, inspection)?' },
        ],
    },
    {
        id: 'knowhow',
        name: 'KNOW-HOW',
        label: 'Ownership',
        topics: [
            { title: 'Oil Spec & Level', desc: 'BMW approval, viscosity, capacity & top-up guidance', query: 'Which BMW oil approval and viscosity does my engine need (and with my tune and use), how much does it hold, what does my oil level reading say, and how do I top up correctly?' },
            { title: 'Gearbox Care', desc: 'Unit ID, realistic fluid intervals & adaptation resets', query: 'What gearbox does my car have, when should its fluid be changed (BMW says lifetime; what is realistic for my use and tune), and what is an adaptation reset for?' },
            { title: 'Fuel & Octane', desc: 'Recommended octane, knock protection & ethanol blends', query: 'Which fuel should my engine and tune run on, what happens on lower octane (knock, timing pulled, power), and is an ethanol blend an option?' },
            { title: 'Known Weak Points', desc: 'Common issues & early warning signs for this engine', query: 'What are the known weak points of my engine and model at my mileage, what are their early signs, and what should I check or replace before it fails?' },
            { title: 'Due at This Mileage', desc: 'Preventive items beyond CBS: plugs, fluids, belts', query: 'At my mileage and the car\'s age, what maintenance is due or coming up beyond the service list (spark plugs, coolant, gearbox and differential oil, brake fluid, belts), and roughly when?' },
            { title: 'Long Trip Prep', desc: 'Pre-trip checklist across oil, tyres, fuel, battery & faults', query: 'I am about to go on a long trip: check my readings (oil level, tyres, fuel, battery, service list, faults if read) and tell me what to sort out before leaving.' },
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
        // no typing while the car moves (telemetry.moving: over 8 km/h, until under 3): the keyboard closes and
        // the question box won't open it; what was typed is kept for when the car stands. Topics and follow-ups
        // are one tap and stay. Unknown speed (no car signal) doesn't lock.
        const typingLocked = () => telemetry.moving === true;
        const lockMsg = () => (customQuery.trim() ? 'Typing locked while driving - your question is kept for when you stop'
            : 'Typing is locked while driving - use a topic, or stop the car');

        let currentPrompt = TOPIC_CATEGORIES[0].topics[0].title;
        let currentResponse = 'Pick a topic under Topics, or ask your own question below.';
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
        // the car's own fields beyond kit/car's groups, decoded as in idrive7-apps (car_signals.js)
        const carSignals = require('./car_signals')(telemetry, { vehicle, Vehicle, log });

        // Real car driving signals, subscribed only while the screen is shown (startCar / stopCar)
        let car = null;
        function stopCar() {
            if (car) { car.stop(); car = null; }
        }
        function startCar() {
            if (car) return;
            try {
                const Car = require('./kit/car');
                car = new Car(ctx, ['rpm', 'speed', 'accel', 'temps', 'gear', 'torque', 'condition'], carSignals.extra, { poll: carSignals.poll });
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
            takeCar(data);
        }
        /**
         * kit/car's latest values into telemetry. Only rpm, speed and acceleration make a sample, so values that
         * came on their own (temperatures, gear, vehicle state on a parked car) are taken from car.data() too.
         */
        function takeCar(data) {
            if (!data || data.demo) return;
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
         * (its getter), and the warnings come as changes to the list kept in car_signals.js. The outside
         * temperature has no getter and changes slowly: it is kept until the car sends a new one.
         */
        let standingSince = 0, engineOnSince = 0, engineStartSeen = false, engineOffSeen = false;
        function clearLive() {
            standingSince = 0; engineOnSince = 0; engineStartSeen = false; engineOffSeen = false;
            carSignals.reset();
            ['checkControl', 'service', 'serviceNext'].forEach((k) => { telemetry[k] = null; });
            ['speed', 'rpm', 'gear', 'stage', 'torque', 'boost', 'mode', 'oilTemp', 'coolantTemp', 'gLat', 'gLong', 'tyres', 'tyreTargets', 'tyreTemps',
                'fuelL', 'rangeKm', 'batteryPct', 'engine', 'msa', 'handbrake', 'powerPct', 'torquePct', 'awd', 'condition', 'programme', 'ac', 'hvTemp', 'hvVolt',
                'moving'].forEach((k) => { telemetry[k] = null; });
        }

        // the car's state for reading it: 'asleep' (parked, no ignition: many units don't answer),
        // 'awake' (ignition on or drive-ready), null (the car doesn't say)
        const carAwake = () => {
            // the latest state from the car itself: the state alone sends no sample
            if (car) takeCar(car.data());
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
        let loadTimer = null, sampling = false;
        function loadSampling(on) {
            if (!on) { if (loadTimer) { clearInterval(loadTimer); loadTimer = null; } return; }
            if (loadTimer) return;
            loadTimer = setInterval(async () => {
                const rpm = telemetry.rpm;
                const load = typeof rpm === 'number' && rpm > 2500 && ((typeof telemetry.torquePct === 'number' && telemetry.torquePct >= 50) || (typeof telemetry.torque === 'number' && telemetry.torque >= 250));
                // one sample at a time: a diagnostic read that hangs doesn't pile up samples behind it
                if (!load || !drive || isThinking || sampling || !steady()) return;
                sampling = true;
                try {
                    const d = await diagLink();
                    if (!d.available) return;
                    if (!snapshot) { const EngineSnapshot = require('./engine_snapshot'); snapshot = new EngineSnapshot(d, ctx.spec && ctx.spec.config, log, () => vehicle.engineKind()); }
                    const x = await snapshot.sample({ budgetMs: 900, steady });
                    if (!x || !drive) return;
                    drive.loadSamples++;
                    drive.iatMax = hi(drive.iatMax, x.iat);
                    if (typeof x.boostTarget === 'number' && typeof x.boostActual === 'number' && x.boostTarget > 0.3) {
                        const gap = x.boostTarget - x.boostActual;
                        if (gap > 0.15) { drive.boostShort++; if (drive.boostShortWorst === null || gap > drive.boostShortWorst) { drive.boostShortWorst = gap; drive.boostShortRpm = rpm; } }
                    }
                    if (typeof x.timing === 'number' && (drive.timingMin === null || x.timing < drive.timingMin)) { drive.timingMin = x.timing; drive.timingMinRpm = rpm; }
                } catch (e) { /* the next sample */ } finally { sampling = false; }
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
            page = 3;
            notify('Phone disconnected AI. Scan QR code to re-pair.');
            render(true).catch(() => {});
        };

        const fmtNum = (v, unit) => (typeof v === 'number' && isFinite(v) ? Math.round(v) + unit : '--');
        function vitalsLine() {
            // no car (emulator, bench): kit/car's simulator, marked DEMO - shown here only, never sent to the AI
            const v = vitalsNow();
            const bst = typeof v.boost === 'number' && isFinite(v.boost) ? (Math.round(v.boost * 20) / 20).toFixed(2) : '--';
            return fmtNum(v.oil, '') + '|' + fmtNum(v.coolant, '') + '|' + bst + '|' + fmtNum(v.battery, '') + (v.demo ? '|D' : '');
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
            if (car) takeCar(car.data());
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
            const link = new Diag(signals, log);
            link.quiet = true;                  // not every request in the log: the Data check page reads all the time (as M Vitals)
            link.readOnly = true;               // hard transport-level guard: M-Copilot can never clear faults or write to any ECU
            diagMaking = link.init().then((d) => { diag = d; diagMaking = null; return d; }, (e) => { diagMaking = null; throw e; });
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
                try { require('./kit/write_whole').writeWhole(IDS_FILE, JSON.stringify({ vin: vehicle.vin, ids: unitIds })); } catch (e) { /* next time */ }
            }
            return unitIds;
        }

        /**
         * The engine snapshot (engine_snapshot.js): read-only values from the engine unit (and a hybrid's
         * battery unit) at the moment of asking - boost, intake air, load, timing, fuel pressures, misfires,
         * gearbox oil, 12 V. Only while steady, within a time budget; kept 20 s.
         */
        let snapshot = null;
        // a plug-in hybrid: the car says so (engine type), or its high-voltage battery sends values
        const hybridCar = () => /hybrid|electric/.test(vehicle.engineType || '') || telemetry.hvVolt !== null || telemetry.hvTemp !== null;
        async function engineSnapshot() {
            try {
                // parked without ignition the engine unit sleeps: nothing to read (and its silence is not a failure)
                if (carAwake() === 'asleep') { telemetry.engineSnap = null; return; }
                const d = await diagLink();
                if (!d.available || !steady()) return;
                if (!snapshot) { const EngineSnapshot = require('./engine_snapshot'); snapshot = new EngineSnapshot(d, ctx.spec && ctx.spec.config, log, () => vehicle.engineKind()); }
                const r = await snapshot.read({ budgetMs: 3500, steady, hybrid: hybridCar(), needOil: telemetry.oilTemp === null, engine: engineState() });
                if (r) telemetry.engineSnap = r;
            } catch (e) {
                log.warn('M-Copilot: engine snapshot skipped: ' + (e.message || e));
            }
        }

        /**
         * The Data check page live, as M Vitals and Live Data read the engine unit while their page is on screen:
         * a round of the engine computer's values, 400 ms rest, the next round (misfires and the HV battery every
         * 4th). Read-only, one request at a time, and only while this page is on screen; never while the car is
         * asleep or the engine is starting or stopping (the round waits a second and looks again). Answers come
         * from these rounds too while they are fresh.
         */
        let liveTimer = null, liveRunning = false, liveRound = 0;
        const liveWanted = () => page === 2 && onScreen();
        // one loop only: a round still reading when the page is left and opened again carries on as the loop
        function engineLive(on) {
            if (!on) { if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; } return; }
            if (!liveTimer && !liveRunning) liveTimer = setTimeout(liveTick, 0);
        }
        const liveOn = () => !!(liveTimer || liveRunning);
        async function liveTick() {
            liveTimer = null;
            if (!liveWanted()) return;
            liveRunning = true;
            let rest = 1000;
            try {
                if (carAwake() !== 'asleep' && steady() && !checking) {
                    const d = await diagLink();
                    if (d.available && liveWanted()) {
                        await identifyCar();
                        if (!snapshot) { const EngineSnapshot = require('./engine_snapshot'); snapshot = new EngineSnapshot(d, ctx.spec && ctx.spec.config, log, () => vehicle.engineKind()); }
                        const every4 = liveRound++ % 4 === 0;
                        const r = await snapshot.read({ live: true, budgetMs: 2500, steady, hybrid: hybridCar(), needOil: telemetry.oilTemp === null,
                            engine: engineState(), misfire: every4, hv: every4 });
                        if (r) telemetry.engineSnap = r;
                        rest = 400;
                    }
                }
            } catch (e) {
                log.warn('M-Copilot: live engine read: ' + (e.message || e));
                rest = 3000;                    // the link not ready: try again in a moment
            }
            liveRunning = false;
            if (liveWanted() && !liveTimer) liveTimer = setTimeout(liveTick, rest);
        }

        /**
         * Read the fault memory of every control unit (UDS 0x19 02 0C over TASU, read-only) so the AI
         * talks about real stored faults. Kept for 5 minutes.
         */
        // one fault memory read at a time: a question asked while one runs (after a Cancel) waits for it
        let faultScan = null;
        function scanFaults() {
            if (!faultScan) { const done = () => { faultScan = null; }; faultScan = readFaults(); faultScan.then(done, done); }
            return faultScan;
        }
        async function readFaults() {
            const ccNow = JSON.stringify(telemetry.checkControl || []);
            if (telemetry.dtcScan && !telemetry.dtcScan.error && !telemetry.dtcScan.partial && telemetry.dtcScan.cc === ccNow
                && Date.now() - telemetry.dtcScan.at < 5 * 60 * 1000) return;
            try {
                const { parseDtcReply, NRC, hex } = require('./kit/diag');
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
                const found = [], refused = [];
                res.forEach((uds, addr) => {
                    const p = parseDtcReply(uds, [0x02, 0x0C]);
                    if (p.ok) found.push({ addr, codes: p.dtcs });
                    else refused.push({ addr, nrc: p.nrc });
                });
                if (!found.length) {
                    // 0 control units answered cleanly (ignition off / asleep): never report this as "0 faults"
                    telemetry.dtcScan = { at: 0, error: refused.length ? 'control units refused fault read (ignition on?)' : 'no control unit answered (ignition on?)' };
                    log.warn('M-Copilot: fault memory read: ' + telemetry.dtcScan.error);
                    return;
                }
                // the texts: for the units with faults, their exact type first (once per unit, kept)
                const T = require('./dtc_text');
                const ids = await unitTypes(d, found.filter((u) => u.codes.length).map((u) => u.addr), T.hasDb);
                let total = 0;
                const units = found.map((u) => {
                    total += u.codes.length;
                    return { addr: u.addr, name: T.unitName(u.addr, ids) || ECU[u.addr] || ('ECU 0x' + u.addr.toString(16).toUpperCase()),
                        codes: u.codes.map((x) => ({ code: x.code, status: x.status, text: T.describe(u.addr, x.code, ids) })) };
                });
                const refusedNamed = refused.map((u) => ({
                    addr: u.addr,
                    name: T.unitName(u.addr, ids) || ECU[u.addr] || ('ECU 0x' + hex(u.addr)),
                    why: u.nrc != null ? 'NRC ' + hex(u.nrc) + (NRC[u.nrc] ? ' ' + NRC[u.nrc] : '') : 'invalid reply',
                }));
                // parked without ignition (or some units refused): marked partial so the AI knows and next scan retries
                telemetry.dtcScan = {
                    at: Date.now(), answered: units.length, total, units, refused: refusedNamed,
                    asleep: carAwake() === 'asleep',
                    partial: carAwake() === 'asleep' || refusedNamed.length > 0,
                    cc: JSON.stringify(telemetry.checkControl || []),
                };
                log.info('M-Copilot: fault memory read: ' + units.length + ' units, ' + total + ' faults'
                    + (refusedNamed.length ? ' (' + refusedNamed.length + ' refused)' : ''));
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
        /**
         * Cancel (the button under a pending answer): the answer is dropped, the request to the AI closed,
         * and what was still being read for it (fault memory, engine computer) stops after its current step.
         * A new question can be asked at once.
         */
        function cancelAnswer() {
            if (!isThinking) return;
            askSeq++;
            ai.cancel();
            setThinking(false);
            canFollowUp = false;
            currentResponse = 'Cancelled. Choose a topic or ask your own question.';
            notify('Answer cancelled.');
            render(true).catch(() => {});
        }
        async function askCopilot(queryText, title, opts) {
            if (isThinking) { notify('M-Copilot is still answering: Cancel stops it.'); return; }
            if (!ai.hasInternet) {
                notify('No Internet: Please verify phone hotspot or cellular uplink.');
                return;
            }
            if (!ai.isConfigured()) {
                page = 3;
                render(true).catch(() => {});
                return;
            }

            currentPrompt = title || 'Custom Query';
            dialogueScroll = 0;
            canFollowUp = false;
            const seq = ++askSeq;
            setThinking(true);
            currentResponse = 'Asking M-Copilot with your car\'s live data...';
            const gone = () => seq !== askSeq;          // cancelled (or a newer question): stop here
            try {
                // who the car is (once per car), then the fault memory for the topics and questions about it
                await identifyCar();
                if (gone()) return;
                if ((opts && opts.faults) || /\b(fault|dtc|error code|check engine|warning light|engine light)/i.test(queryText)) await scanFaults();
                if (gone()) return;
                // the engine unit's own values at the moment of asking (a few hundred ms once known)
                await engineSnapshot();
                if (gone()) return;
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
                if (seq === askSeq && answer !== null) { currentResponse = answer; canFollowUp = !!ai.lastOk; }
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
        function wrapLines(cv, text, maxW, size) {
            if (!text) return [];
            const key = maxW + '|' + size + '|' + text;
            if (wrapCache.key === key) return wrapCache.lines;
            wrapCache.key = key;
            return (wrapCache.lines = wrapLinesNow(cv, text, maxW, size));
        }
        function wrapLinesNow(cv, text, maxW, size) {
            // Clean markdown syntax & sanitize characters into atlas-supported glyphs
            const cleaned = text
                .replace(/\*\*(.*?)\*\*/g, '$1')   // bold asterisks removed
                .replace(/^#{1,6}\s*/gm, '')          // markdown headings
                .replace(/`([^`]*)`/g, '$1')          // inline code
                .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1$2')   // *italic*
                .replace(/^\s*\d+[.)]\s+/gm, () => '- ')   // numbered lists as bullets
                .replace(/^[\*\-]\s+/gm, '- ')     // list bullet prefix to '- '
                .replace(/[•\u2022]/g, '- ')       // bullet dot to '- '
                .replace(/[≥]/g, '>=')
                .replace(/[≤]/g, '<=')
                .replace(/[✔]/g, '✓')
                .replace(/[⚠️⚠]/g, '[!]')
                .replace(/[“”]/g, '"')
                .replace(/[‘’]/g, "'")
                .replace(/\n{3,}/g, '\n\n');       // collapse excessive blank lines

            const measure = (s) => cv.textWidth(s, size, { literal: true });
            const rawLines = drawable(cleaned).split('\n');
            const lines = [];
            let lastEmpty = false;

            rawLines.forEach((rl) => {
                const trimmed = rl.trim();
                if (!trimmed) {
                    if (!lastEmpty && lines.length > 0) {
                        lines.push('');
                        lastEmpty = true;
                    }
                    return;
                }
                lastEmpty = false;

                if (measure(trimmed) <= maxW) {
                    lines.push(trimmed);
                    return;
                }
                const words = trimmed.split(/\s+/);
                let cur = '';
                words.forEach((w) => {
                    const cand = cur ? cur + ' ' + w : w;
                    if (measure(cand) <= maxW) {
                        cur = cand;
                    } else {
                        if (cur) lines.push(cur);
                        // Split an overlong unspaced token (e.g. long code or URL) so it never crosses maxW
                        if (measure(w) > maxW) {
                            let part = '';
                            for (const ch of w) {
                                if (part && measure(part + ch) > maxW) { lines.push(part); part = ch; }
                                else part += ch;
                            }
                            cur = part;
                        } else {
                            cur = w;
                        }
                    }
                });
                if (cur) lines.push(cur);
            });
            return lines;
        }

        /* ---------- Offline: no internet ---------- */
        function drawNoInternet(cv, t) {
            const y = S.state(cv, t, 64, 110, 1000, {
                tone: 'error', glow: !!cv.place, title: 'No internet connection', size: sz(cv, 26),
                lines: ['M-Copilot asks its AI over the internet.', 'Check the phone hotspot, the USB-tethered phone or the LTE stick.'],
            });
            S.button(cv, t, 64, y + 20, 'Try again', () => {
                notify('Checking the connection...');
                ai.checkInternetConnection().then(() => render(true));
            }, { h: sz(cv, 32), primary: true, key: 'btn_retry_net', size: sz(cv, 13) });
        }

        /* ---------- Connect: pairing the phone, and what is set from it ---------- */
        /** The pairing QR code on a white square with a soft shadow under it, size px, top left x, y. */
        function drawQr(cv, url, x, y, size) {
            const qr = getPairingQr(url);
            if (!qr) return;
            const n = qr.size, px = Math.floor(size / n), real = px * n, ox = x + Math.floor((size - real) / 2), oy = y + Math.floor((size - real) / 2);
            if (cv.place) S.softRect(cv, ox, oy + 14, real, real, 26, '#000000', 0.7);
            cv.roundRect(ox - 12, oy - 12, real + 24, real + 24, 4, '#ffffff');
            G.qrCode(cv, qr, url, ox, oy, px);       // drawn once as a layer, not a rectangle per module every frame
        }
        const LANG_NAMES = { ka: 'Georgian', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', nl: 'Dutch', pt: 'Portuguese', tr: 'Turkish', pl: 'Polish' };
        function drawConnect(cv, t) {
            const ex = cv.extra || 0, paired = ai.isConfigured(), bottom = 510 + ex;
            const panelH = bottom - 44, acc = S.acc(t);
            const ds = Math.min(sz(cv, 12), 18), rs = Math.min(sz(cv, 13), 19), rh = Math.min(sz(cv, 26), 38);
            // left: the AI, or the code to pair with
            const lx = 40, lw = 620;
            G.panelExact(cv, t, lx, 44, lw, panelH, paired ? 'AI connection' : 'Connect your phone');
            if (paired) {
                const y = S.state(cv, t, lx, 112, lw, { tone: 'info', glow: !!cv.place, title: 'Connected to ' + providerName(), size: Math.min(sz(cv, 20), 29), lines: [] });
                const ml = ai.modelLabel();
                [['Model', (ml || ai.config.model || 'default') + (ml ? ' (answered last)' : '')],
                 ['Internet', ai.hasInternet ? 'Online' : 'Offline: phone hotspot?']].forEach((r, i) => {
                    S.pair(cv, t, lx, y + 4 + i * rh, lw, rh, r[0], fitText(cv, r[1], lw - 160, rs), { size: rs, dot: i === 1 ? (ai.hasInternet ? S.OK : S.critC(t)) : null });
                });
                // disconnecting (or a new AI key) is the phone's: the car follows it live
                cv.text(fitText(cv, 'Disconnect or change the AI key on your phone.', lw, ds), lx, y + 4 + 2 * rh + 30, ds, t.dim);
            } else {
                const cardY = 104, cardH = Math.max(220, bottom - cardY);
                cv.roundRect(lx, cardY, lw, cardH, 6, '#101218');
                cv.strokeRoundRect(lx + 0.5, cardY + 0.5, lw - 1, cardH - 1, 6, 1, withAlpha('#ffffff', 0.09));
                const qs = Math.max(150, Math.min(236, cardH - 56));
                const qx = lx + 28, qy = cardY + Math.round((cardH - qs) / 2);
                drawQr(cv, cloudPair.getPairingUrl(), qx, qy, qs);
                const tx = qx + qs + 34, tw = lx + lw - tx - 20, ts = Math.min(sz(cv, 15.5), 22), codeSz = Math.min(sz(cv, 21), 28);
                cv.text(fitText(cv, 'Scan with your phone', tw, ts, { font: 'bold' }), tx, qy + ts, ts, t.text, { font: 'bold' });
                ['Choose Gemini (free), Claude,', 'OpenAI, Groq or OpenRouter.'].forEach((l, i) => {
                    cv.text(fitText(cv, l, tw, ds), tx, qy + ts + 14 + (i + 1) * ds * 1.4, ds, t.dim);
                });
                const cy2 = qy + ts + 14 + 3.4 * ds * 1.4;
                cv.text('Pairing code', tx, cy2, ds, t.dim);
                cv.text(cloudPair.getShortCode(), tx, cy2 + codeSz + 4, codeSz, acc, { font: 'bold', literal: true });
                cv.text(fitText(cv, 'hexlay.github.io/.../copilot.html', tw, Math.max(13, ds - 1), { literal: true }), tx, cy2 + codeSz + 26, Math.max(13, ds - 1), t.dim, { literal: true });
            }

            // right: what is set from the phone (the only place it can be changed)
            const rx = 720, rw = 840;
            G.panelExact(cv, t, rx, 44, rw, panelH, showPhoneQr && paired ? 'Phone page' : 'Set from your phone');
            if (showPhoneQr && paired) {
                const bh = Math.min(sz(cv, 30), 42);
                const cardY = 104, cardH = Math.max(200, bottom - bh - 18 - cardY);
                cv.roundRect(rx, cardY, rw, cardH, 6, '#101218');
                cv.strokeRoundRect(rx + 0.5, cardY + 0.5, rw - 1, cardH - 1, 6, 1, withAlpha('#ffffff', 0.09));
                const qs2 = Math.max(150, Math.min(220, cardH - 52)), qx2 = rx + 28, qy = cardY + Math.round((cardH - qs2) / 2);
                drawQr(cv, cloudPair.getPairingUrl(), qx2, qy, qs2);
                const tx = qx2 + qs2 + 36, tw = rx + rw - tx - 24, ts = Math.min(sz(cv, 15.5), 22);
                cv.text(fitText(cv, 'Open this car on your phone', tw, ts, { font: 'bold' }), tx, qy + ts, ts, t.text, { font: 'bold' });
                ['Edit car profile, switch AI model or disconnect.', 'In the phone app, use Scan car QR.'].forEach((l, i) => {
                    cv.text(fitText(cv, l, tw, ds), tx, qy + ts + 16 + (i + 1) * ds * 1.45, ds, t.dim);
                });
            } else {
                const p = vehicle.profile || {};
                const lines = Vehicle.profileLines(p).filter((l) => !/^Country|^Model \(owner\)/.test(l));
                const rows = [['Model', p.model || 'not set']].concat(lines.map((l) => { const i = l.indexOf(': '); return [l.slice(0, i), l.slice(i + 2)]; }));
                rows.push(['Country', p.country || 'not set'], ['Answer language', LANG_NAMES[p.lang] || 'English'], ['AI model', ai.config.model || 'default']);
                const room = bottom - 110 - (paired ? Math.min(sz(cv, 30), 42) + 26 : 16);
                const rRh = Math.min(rh, Math.max(24, Math.floor(room / Math.min(rows.length, 9))));
                rows.slice(0, Math.max(1, Math.floor(room / rRh))).forEach(([k, v], i) => {
                    S.pair(cv, t, rx, 110 + i * rRh, rw, rRh, k, fitText(cv, v, rw - 260, rs), { size: Math.min(rs, Math.round(rRh * 0.5)), color: /not set|default/.test(v) ? t.dim : t.text });
                });
            }
            if (paired) {
                const bh = Math.min(sz(cv, 30), 42), by = bottom - bh;
                const bw = S.button(cv, t, rx, by, showPhoneQr ? 'Back to settings' : 'Show phone QR', () => { showPhoneQr = !showPhoneQr; render(true); },
                    { h: bh, size: Math.min(sz(cv, 12.5), 18), key: 'btn_phone_qr' });
                if (!showPhoneQr) cv.text(fitText(cv, 'Change these on the phone page.', rw - bw - 20, ds), rx + rw, by + bh / 2 + ds * 0.36, ds, t.dim, { align: 'right' });
            }
        }
        /** The answer page before an AI is paired: where to pair. */
        function drawNeedsConnect(cv, t) {
            const y = S.state(cv, t, 64, 110, 1000, {
                tone: 'info', glow: !!cv.place, title: 'Pair an AI from your phone', size: sz(cv, 26),
                lines: ['Scan the code on the Connect tab and choose an AI there (Google Gemini is free).', 'Your answers then show here, with your car\'s own data.'],
            });
            S.button(cv, t, 64, y + 20, 'Open Connect', () => { page = 3; render(true); }, { h: sz(cv, 32), primary: true, key: 'btn_open_connect', size: sz(cv, 13) });
        }

        /* ---------- The on-screen keyboard (in place of the band while the question box is open) ---------- */
        function drawKeyboard(cv, t, now) {
            const ex = cv.extra || 0, bottom = 510 + ex;
            const kx = 700, kw = 860;
            const hasText = !!customQuery.trim();
            const s = Math.min(sz(cv, 11.5), 16);

            // live query bar right above the keyboard so your eyes stay here while typing
            const qH = 42, qY = 58, qSz = 19;
            cv.roundRect(kx, qY, kw, qH, 3, '#101218');
            cv.strokeRoundRect(kx + 0.5, qY + 0.5, kw - 1, qH - 1, 3, 1, withAlpha('#ffffff', hasText ? 0.24 : 0.12));
            cv.fillRect(kx + 1, qY + qH - 2, kw - 2, 2, S.sel(t));
            const previewTxt = hasText ? fitTail(cv, customQuery, kw - 36, qSz, { font: 'bold', literal: true }) + '_' : 'Type a question or tap a preset below...';
            cv.text(previewTxt, kx + 16, qY + qH / 2 + qSz * 0.34, qSz, hasText ? t.text : t.dim, { font: hasText ? 'bold' : 'normal', literal: true });

            // a few ready questions, as many as fit on the row
            const presetH = Math.min(sz(cv, 26), 36), presetY = qY + qH + 10;
            const presets = ['What is my boost?', 'Brake pad health', 'Cold start idle', 'Recommended oil', 'Scan fault codes'];
            let px = kx;
            presets.forEach((pr, pIdx) => {
                const pw = Math.round(cv.textWidth(pr, s) + 24);
                if (px + pw > kx + kw) return;
                S.button(cv, t, px, presetY, pr, () => { if (!typingLocked()) customQuery = pr; render(true); }, { h: presetH, size: s, w: pw, key: 'kb_preset_' + pIdx });
                px += pw + 8;
            });

            // the keys: four rows and the action row share the room down to the page's bottom
            const kbY = presetY + presetH + 12, keyGap = 6;
            const keyH = Math.min(sz(cv, 54), Math.floor((bottom - kbY - 4 * keyGap) / 5));
            const kSize = Math.min(sz(cv, 15), 22);
            const rows = [
                ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '?'],
                ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
                ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
                ['Z', 'X', 'C', 'V', 'B', 'N', 'M', '.', ','],
            ];
            const key = (x, y, w, label, run, k, o) => {
                o = o || {};
                if (o.primary) {
                    S.lit(cv, t, x, y, w, keyH, 1.3);
                    cv.strokeRoundRect(x + 0.5, y + 0.5, w - 1, keyH - 1, 3, 1, withAlpha(S.sel(t), 0.65));
                } else {
                    cv.roundRect(x, y, w, keyH, 3, '#13161e');
                    cv.strokeRoundRect(x + 0.5, y + 0.5, w - 1, keyH - 1, 3, 1, withAlpha('#ffffff', 0.1));
                }
                cv.text(label, x + w / 2, y + keyH / 2 + (o.size || kSize) * 0.36, o.size || kSize, o.color || '#ffffff', { align: 'center', font: o.primary ? 'bold' : 'normal', literal: true });
                cv.target(x, y, w, keyH, run, k, 3);
            };
            rows.forEach((row, rIdx) => {
                const ry = kbY + rIdx * (keyH + keyGap);
                const keyW = Math.floor((kw - (row.length - 1) * keyGap) / row.length);
                row.forEach((k, cIdx) => key(kx + cIdx * (keyW + keyGap), ry, keyW, k, () => {
                    if (customQuery.length < QUERY_MAX && !typingLocked()) customQuery += k;
                    render(true);
                }, 'kb_k_' + rIdx + '_' + cIdx));
            });
            // the action row: Close, space, delete, clear, Ask
            const aY = kbY + 4 * (keyH + keyGap), aS = sz(cv, 12.5);
            let ax = kx;
            const act = (w, label, run, k, o) => { key(ax, aY, w, label, run, k, Object.assign({ size: aS }, o)); ax += w + keyGap; };
            act(120, 'Close', () => { showKeyboard = false; render(true); }, 'kb_act_cancel', { color: t.dim });
            act(260, 'Space', () => { if (customQuery.length < QUERY_MAX && !typingLocked()) customQuery += ' '; render(true); }, 'kb_act_space');
            act(120, 'Delete', () => { customQuery = customQuery.slice(0, -1); render(true); }, 'kb_act_del');
            act(110, 'Clear', () => { customQuery = ''; render(true); }, 'kb_btn_clear', { color: hasText ? S.critC(t) : t.dim });
            act(kx + kw - ax, 'Ask M-Copilot', () => {
                if (!hasText) return;
                const q = customQuery.trim();
                customQuery = '';
                showKeyboard = false;
                askCopilot(q, 'Custom: ' + (q.length > 25 ? q.slice(0, 25) + '...' : q));
            }, 'kb_act_go', { primary: hasText, color: hasText ? '#ffffff' : t.dim });
            void now;
        }

        /* ---------- the band's history ---------- */
        /*
         * History for the 3D band: oil, coolant, boost and the 12 V battery every 2 s while M-Copilot
         * is on screen, up to 15 minutes. Back on screen after more than 5 minutes away it starts again
         * (brief tab or HMI switches keep history intact). No car (emulator, bench): the simulator's
         * values (with a realistic demo warmup seed so the 3D band is immediately visible); never sent
         * to the AI.
         */
        const HIST_MS = 15 * 60 * 1000, HIST_STEP = 2000;
        const BAND_SIGNALS = [
            { key: 'oil', name: 'Oil', label: 'Oil temperature', unit: '°C', dec: 0, min: 20, max: 135, ref: 90, refText: '90 °C', limit: 130, stops: S.TEMP_STOPS },
            { key: 'coolant', name: 'Coolant', label: 'Coolant temperature', unit: '°C', dec: 0, min: 20, max: 125, ref: 90, refText: '90 °C', limit: 120, stops: S.TEMP_STOPS },
            { key: 'boost', name: 'Boost', label: 'Boost pressure', unit: 'bar', dec: 2, min: 0, max: 2.2, ref: 1.0, refText: '1.0 bar', limit: 1.8,
                stops: [[0, S.M2], [0.65, S.M1], [1.25, '#7cc8f0'], [1.6, S.AMBER], [1.95, S.M3]] },
            { key: 'battery', name: 'Battery', label: '12 V battery charge', unit: '%', dec: 0, min: 30, max: 100, ref: 80, refText: '80 %', limit: 50, low: true,
                stops: [[40, S.M3], [55, S.AMBER], [70, S.M1], [100, '#7cc8f0']] },
        ];
        let history = [], histTimer = null, bandSignal = 0, bandSwitchAt = 0, demoSeeded = false;
        const BAND_SWITCH_MS = 320;
        function vitalsNow() {
            const d = car ? car.data() : null, demo = !!(d && d.demo);
            const snapBoost = telemetry.engineSnap && telemetry.engineSnap.values && typeof telemetry.engineSnap.values.boostActual === 'number'
                ? telemetry.engineSnap.values.boostActual : null;
            const demoBoost = demo && typeof d.rpm === 'number'
                ? Math.max(0, Math.min(1.95, ((d.rpm - 1100) / 5200) * 1.4 + (typeof d.torque === 'number' && d.torque > 240 ? 0.25 : 0))) : null;
            return {
                oil: demo ? d.oil : telemetry.oilTemp,
                coolant: demo ? d.coolant : telemetry.coolantTemp,
                boost: demo ? demoBoost : (snapBoost !== null ? snapBoost : telemetry.boost),
                battery: demo ? 86 : telemetry.batteryPct,
                demo,
            };
        }
        function seedDemoHistory(now, v) {
            // In demo/emulator mode only: seed 12 minutes of realistic warmup so the 3D band shows full depth immediately.
            history = [];
            demoSeeded = true;
            const pts = 72, totalMs = 12 * 60 * 1000;
            const curOil = typeof v.oil === 'number' ? v.oil : 94;
            const curCool = typeof v.coolant === 'number' ? v.coolant : 90;
            const curBoost = typeof v.boost === 'number' ? v.boost : 0.72;
            const curBat = typeof v.battery === 'number' ? v.battery : 86;
            const oilStart = Math.max(20, curOil - Math.min(34, Math.max(8, curOil - 20)));
            const coolStart = Math.max(20, curCool - Math.min(28, Math.max(8, curCool - 20)));
            for (let i = pts; i >= 1; i--) {
                const frac = 1 - i / pts; // 0 oldest -> 1 near now
                const ease = frac * frac * (3 - 2 * frac);
                const wave = Math.sin(i * 0.42) * 0.7 * (1 - frac * 0.6);
                const pull = 0.22 + 1.18 * Math.pow(0.5 + 0.5 * Math.sin(i * 0.24 + 0.6), 2.1);
                const boostVal = pull * (1 - Math.pow(frac, 3) * 0.75) + curBoost * (Math.pow(frac, 3) * 0.75);
                history.push({
                    at: now - Math.round((i / pts) * totalMs),
                    oil: oilStart + (curOil - oilStart) * ease + wave,
                    coolant: coolStart + (curCool - coolStart) * ease + Math.cos(i * 0.35) * 0.5 * (1 - frac * 0.6),
                    boost: Math.max(0.08, Math.min(1.85, boostVal)),
                    battery: Math.max(70, Math.min(98, curBat - 4 * (1 - ease) + Math.sin(i * 0.2) * 0.4)),
                });
            }
        }
        function sampleHistory() {
            const now = Date.now(), v = vitalsNow();
            if (history.length && now - history[history.length - 1].at > 5 * 60 * 1000) { history = []; demoSeeded = false; }
            if (!demoSeeded && v.demo && typeof v.oil === 'number') seedDemoHistory(now, v);
            if (!v.demo && demoSeeded) { history = []; demoSeeded = false; }
            if (typeof v.oil === 'number' || typeof v.coolant === 'number' || typeof v.boost === 'number' || typeof v.battery === 'number') {
                history.push({ at: now, oil: v.oil, coolant: v.coolant, boost: v.boost, battery: v.battery });
            }
            while (history.length && now - history[0].at > HIST_MS) history.shift();
        }
        function historyOn(on) {
            if (!on) { if (histTimer) { clearInterval(histTimer); histTimer = null; } return; }
            if (histTimer) return;
            sampleHistory();
            histTimer = setInterval(sampleHistory, HIST_STEP);
        }
        /** Downsample points to at most maxN while preserving first and last samples. */
        function thinSamples(arr, maxN) {
            if (arr.length <= maxN) return arr;
            const out = [arr[0]], step = (arr.length - 1) / (maxN - 1);
            for (let i = 1; i < maxN - 1; i++) out.push(arr[Math.round(i * step)]);
            out.push(arr[arr.length - 1]);
            return out;
        }
        /** Theme-aware colour stops for the 3D band (Afterglow keeps M blues -> amber -> red). */
        function bandStops(t, sig) {
            if (t.style === 'afterglow' || !t.hotRamp) return sig.stops;
            if (sig.low) return [[40, t.crit], [55, t.warn], [70, t.accent], [100, t.accent2 || t.text]];
            const lo = sig.min, hi = sig.limit || sig.max;
            return [[lo, t.ramp ? t.ramp[0] : t.accent], [lo + (hi - lo) * 0.5, t.accent], [lo + (hi - lo) * 0.72, t.accent2 || t.accent], [lo + (hi - lo) * 0.86, t.warn], [hi, t.crit]];
        }

        function drawBand(cv, t, x, y, w, h) {
            const sig = BAND_SIGNALS[bandSignal];
            const small = Math.min(sz(cv, 12), 18);
            const stops = bandStops(t, sig);
            // which signal: a segmented control, right-aligned at the top
            const segH = Math.min(sz(cv, 28), 42), segSz = Math.min(sz(cv, 12.5), 18);
            const segW = Math.min(w, Math.min(480, Math.max(400, sz(cv, 300))));
            S.segmented(cv, t, x + w - segW, y, segH, BAND_SIGNALS.map((s) => s.name), bandSignal, (i) => {
                if (i !== bandSignal) { bandSignal = i; bandSwitchAt = Date.now(); }
                render(true).catch(() => {});
            }, 'band', segSz, segW);

            // the value now, large, right-aligned under it (scaled to h so it never crowds the band on 8.8" standard)
            const v = vitalsNow(), nowVal = v[sig.key];
            const vy = y + segH + 18 + small;
            cv.text(sig.label + (v.demo && typeof nowVal === 'number' ? '  ·  demo' : ''), x + w, vy, small, t.dim, { align: 'right' });
            const big = Math.min(sz(cv, 56), Math.max(46, Math.round(h * 0.175)));
            const uSize = Math.min(sz(cv, 21), Math.round(big * 0.38));
            const num = typeof nowVal === 'number' && isFinite(nowVal) ? (sig.dec ? fix(nowVal, sig.dec) : String(Math.round(nowVal))) : '--';
            const unitW = cv.textWidth(sig.unit, uSize);
            const numY = vy + 6 + big * 0.9;
            cv.text(sig.unit, x + w, numY - 2, uSize, t.dim, { align: 'right' });
            cv.text(num, x + w - unitW - 8, numY, big, t.text, { align: 'right', font: 'num' });

            // delta + peak summary line under the readout
            const pts = history.filter((s) => typeof s[sig.key] === 'number' && isFinite(s[sig.key]));
            const deltaY = numY + 12 + small;
            if (pts.length >= 2) {
                const first = pts[0], last = pts[pts.length - 1];
                const curV = typeof nowVal === 'number' && isFinite(nowVal) ? nowVal : last[sig.key];
                const rawDiff = curV - first[sig.key];
                const dTxt = sig.dec ? fix(rawDiff, sig.dec) : String(Math.round(rawDiff));
                const over = Math.max(1, Math.round((Date.now() - first.at) / 60000));
                const zero = sig.dec ? Math.abs(rawDiff) < 0.05 : Math.round(rawDiff) === 0;
                const peakVal = pts.reduce((m, p) => (sig.low ? Math.min(m, p[sig.key]) : Math.max(m, p[sig.key])), curV);
                const peakTxt = (sig.low ? 'low ' : 'peak ') + (sig.dec ? fix(peakVal, sig.dec) : String(Math.round(peakVal))) + ' ' + sig.unit;
                const diffStr = zero ? 'steady ' + over + ' min' : (rawDiff > 0 ? '+' : '') + dTxt + ' ' + sig.unit + ' in ' + over + ' min';
                cv.text(peakTxt + '  ·  ' + diffStr, x + w, deltaY, small, t.dim, { align: 'right', literal: true });
            } else if (typeof nowVal === 'number') {
                cv.text('live reading · recording history', x + w, deltaY, small, t.dim, { align: 'right' });
            }

            const by = deltaY + 14, bh = Math.max(120, y + h - by);
            if (typeof nowVal !== 'number' && pts.length < 2) {
                cv.text('No ' + sig.name.toLowerCase() + ' value from the car yet',
                    x + w * 0.56, by + bh * 0.55, Math.min(sz(cv, 13), 19), t.dim, { align: 'center' });
                return;
            }

            // Pick a clean multiple-of-3 minute span (3, 6, 9, 12, 15) so all 4 time marks are evenly spaced
            const nowMs = Date.now();
            const ageMin = pts.length ? (nowMs - pts[0].at) / 60000 : 0;
            const mins = Math.min(15, Math.max(3, Math.ceil(ageMin / 3) * 3));
            const span = mins * 60000;
            const third = mins / 3;

            // Build samples oldest-first; if just opened with 1 reading, draw a calm baseline from that reading immediately
            let rawSamples;
            if (pts.length >= 2) {
                rawSamples = thinSamples(pts, 84).map((s) => ({ t: Math.max(0, Math.min(1, (nowMs - s.at) / span)), v: s[sig.key] }));
                if (typeof nowVal === 'number') rawSamples.push({ t: 0, v: nowVal });
            } else {
                rawSamples = [{ t: 0.35, v: nowVal }, { t: 0, v: nowVal }];
            }

            // Smooth vertical rise on signal switch (320 ms ease-out)
            const sw = bandSwitchAt ? Math.max(0, 1 - (nowMs - bandSwitchAt) / BAND_SWITCH_MS) : 0;
            const easeIn = 1 - sw * sw;
            const animSamples = easeIn < 0.999
                ? rawSamples.map((s) => ({ t: s.t, v: sig.min + (s.v - sig.min) * (0.25 + 0.75 * easeIn) }))
                : rawSamples;

            const liveCol = typeof nowVal === 'number' ? S.rampColour(stops, nowVal) : S.M2;
            const pulse = 0.5 + 0.5 * Math.sin(nowMs / 650);
            S.band(cv, t, {
                x, y: by, w, h: bh, min: sig.min, max: sig.max, stops, bg: t.bg,
                samples: animSamples,
                poolColor: liveCol,
                pulse,
                ref: sig.ref, refText: sig.refText,
                limit: sig.limit, limitText: (sig.low ? 'Low ' : 'Limit ') + sig.limit + ' ' + sig.unit,
                marks: [[0, 'now'], [1 / 3, '-' + third + ' min'], [2 / 3, '-' + (2 * third) + ' min'], [1, '-' + mins + ' min']],
            });
        }

        /* ---------- M-Copilot main screen: the answer on the left, a signal's last minutes in 3D on the right ---------- */
        function drawMainCopilot(cv, t, now) {
            const ex = cv.extra || 0, bottom = 510 + ex;
            const gpu = !!cv.place;
            const selC = S.sel(t), acc = S.acc(t), warn = S.warnC(t);

            // a quiet pool of light behind the band: matches the live signal state (cool blue -> amber -> red)
            if (gpu) {
                const sig = BAND_SIGNALS[bandSignal], vNow = vitalsNow()[sig.key];
                const hot = (telemetry.coolantTemp || 0) >= 110 || (telemetry.oilTemp || 0) >= 125;
                const glowCol = hot ? warn : (typeof vNow === 'number' ? S.rampColour(bandStops(t, sig), vNow) : (t.style === 'afterglow' ? S.M2 : selC));
                S.softEllipse(cv, 1180, bottom - 110, 620, 290, glowCol, hot ? 0.16 : 0.24);
            }

            const ax = 56, aw = 608;
            // your own question: a plain box along the bottom (locked while driving)
            const inputH = Math.min(sz(cv, 36), 52), inputY = bottom - inputH;
            const locked = typingLocked(), hasCustom = !!customQuery.trim();
            const inSize = Math.min(sz(cv, 13.5), 19), inOpt = { font: hasCustom ? 'bold' : 'normal' };
            cv.strokeRoundRect(ax + 0.5, inputY + 0.5, aw - 1, inputH - 1, 3, 1, withAlpha('#ffffff', showKeyboard ? 0.32 : 0.16));
            if (showKeyboard) cv.fillRect(ax + 1, inputY + inputH - 3, aw - 2, 2, selC);
            let inText;
            if (locked) {
                const lHead = hasCustom ? 'Locked while driving: ' : 'Typing locked while driving';
                inText = hasCustom ? lHead + fitTail(cv, customQuery.trim(), aw - 60 - cv.textWidth(lHead, inSize, inOpt), inSize, inOpt) : lHead;
            } else {
                inText = hasCustom ? fitTail(cv, customQuery, aw - 70, inSize, inOpt) + (showKeyboard ? '_' : '') : (showKeyboard ? 'Type your question..._' : 'Ask your own question');
            }
            // a keyboard glyph, then the text
            const kx = ax + 20, kcy = inputY + inputH / 2, kc = withAlpha('#ffffff', 0.55);
            cv.strokeRoundRect(kx, kcy - 8, 26, 16, 3, 1.4, kc);
            [0, 1, 2, 3].forEach((i) => cv.fillRect(kx + 4 + i * 5, kcy - 4, 2, 2, kc));
            cv.fillRect(kx + 7, kcy + 2, 12, 2, kc);
            cv.text(fitText(cv, inText, aw - 78, inSize, inOpt), kx + 40, kcy + inSize * 0.36, inSize, locked ? '#5f606a' : hasCustom || showKeyboard ? t.text : t.dim, inOpt);
            cv.target(ax, inputY, aw, inputH, () => {
                if (locked) notify(lockMsg()); else showKeyboard = !showKeyboard;
                render(true);
            }, 'btn_custom_input', 3);

            /* ----- the answer ----- */
            const small = Math.min(sz(cv, 12), 18);
            const topicName = /^Custom: /.test(currentPrompt) ? 'Your question' : currentPrompt;
            // When a real answer starts with a short verdict line (<= 34 chars, no markdown bullet), promote it to the headline
            let head = isThinking ? 'Reading your car' : topicName;
            let bodyText = currentResponse;
            if (!isThinking && canFollowUp && currentResponse) {
                const firstNl = currentResponse.indexOf('\n');
                const firstLine = (firstNl > 0 ? currentResponse.slice(0, firstNl) : currentResponse).replace(/[*#`]/g, '').trim();
                const firstClause = firstLine.split(/[.!]\s/)[0].trim();
                if (firstLine.length >= 4 && firstLine.length <= 34 && firstNl > 0 && !/^[-•\d]/.test(firstLine)) {
                    head = firstLine.replace(/[:.]$/, '');
                    bodyText = currentResponse.slice(firstNl + 1).trim() || currentResponse;
                } else if (firstClause.length >= 4 && firstClause.length <= 30 && firstLine.length > firstClause.length + 2 && !/^[-•\d]/.test(firstClause)) {
                    head = firstClause;
                }
            }
            const meta = (head !== topicName && !isThinking ? topicName + '  ·  ' : '')
                + providerName() + (ai.modelLabel() ? ' · ' + ai.modelLabel() : '')
                + (isThinking ? '  ·  reading your car, ' + Math.floor((Date.now() - thinkStart) / 1000) + ' s' : '');
            let lx = ax;
            if (isThinking) {
                const pulse = 0.5 + 0.5 * Math.sin(now / 320);
                if (gpu) S.softEllipse(cv, ax + 4, 82 - small * 0.36, 9 + pulse * 4, 9 + pulse * 4, acc, 0.55 + pulse * 0.35);
                cv.circle(ax + 4, 82 - small * 0.36, 4, acc);
                lx += 18;
            }
            cv.text(fitText(cv, meta, aw - 20, small), lx, 82, small, t.dim);
            const hSize = Math.min(sz(cv, 36), 48);
            cv.text(fitText(cv, head, aw, hSize, { font: 'bold' }), ax, 90 + hSize * 0.94, hSize, t.text, { font: 'bold' });

            // from the bottom up: the input box, the action chips (Cancel / follow-ups), then the full answer text
            const chips = canFollowUp && !isThinking, bar = chips || isThinking;
            const btnH = Math.min(sz(cv, 28), 40), btnY = inputY - 12 - btnH;
            const big = telemetry.moving === true, size = big ? Math.min(sz(cv, 18), 26) : Math.min(sz(cv, 15), 21), lineH = Math.round(size * 1.42);
            rowH = lineH;
            const top = 90 + hSize + 16;
            const lines = wrapLines(cv, bodyText, aw - 8, size);
            const textBottom = (bar ? btnY : inputY) - 12;
            const maxVisibleLines = Math.max(1, Math.floor((textBottom - top) / lineH));
            dialogueRows = { count: lines.length, visible: maxVisibleLines };
            cv.scroll = true;
            const maxScroll = Math.max(0, lines.length - maxVisibleLines);
            if (dialogueScroll > maxScroll) dialogueScroll = maxScroll;
            lines.slice(dialogueScroll, dialogueScroll + maxVisibleLines).forEach((line, idx) => {
                const ly = top + Math.round(lineH * 0.75) + idx * lineH;
                let col = t.text || '#e6e6ea', isBold = false;
                if (/^(\[OK\]|✓|OK:|PASS:|OPTIMAL:)/.test(line)) col = S.OK;
                else if (/^(\[!\]|WARNING:|CAUTION:|ALERT:|FAIL:)/i.test(line)) col = warn;
                else if ((line.startsWith('[') && line.endsWith(']')) || (line.startsWith('- ') && line.includes(':'))) { isBold = true; col = t.text; }
                else if (/^\d+\./.test(line)) col = t.text;
                cv.text(line, ax, ly, size, col, { font: isBold ? 'bold' : 'normal', literal: true });
            });
            if (lines.length > maxVisibleLines) {
                const sbX = ax + aw + 14, sbH = textBottom - top - 6;
                if (dialogueScroll > 0) S.shadeY(cv, ax, top, aw, 18, t.bg, 0.78, 0);
                if (dialogueScroll < maxScroll) {
                    S.shadeY(cv, ax, textBottom - 26, aw, 26, t.bg, 0, 0.92);
                    const moreSz = Math.min(sz(cv, 11), 15);
                    cv.text('↓ ' + (maxScroll - dialogueScroll) + ' more', ax + aw, textBottom - 4, moreSz, selC, { align: 'right', literal: true });
                }
                cv.fillRect(sbX, top, 2, sbH, withAlpha('#ffffff', 0.1));
                const thumbH = Math.max(24, Math.floor((maxVisibleLines / lines.length) * sbH));
                cv.fillRect(sbX, top + Math.floor((dialogueScroll / maxScroll) * (sbH - thumbH)), 2, thumbH, selC);
                const textH = textBottom - top;
                cv.target(ax, top, aw, textH / 2, () => { dialogueScroll = Math.max(0, dialogueScroll - 4); render(true); }, 'card_scroll_up', 3);
                cv.target(ax, top + textH / 2, aw, textH / 2, () => { dialogueScroll = Math.min(maxScroll, dialogueScroll + 4); render(true); }, 'card_scroll_down', 3);
            }
            // Cancel while it answers; the follow-ups after a real answer (adaptive sizing so all 3 fit even at 8.8")
            let bSize = Math.min(sz(cv, 12), 17), bPad = 24;
            if (chips) {
                while (bSize > 13 && FOLLOW_UPS.reduce((sum, f) => sum + cv.textWidth(f.title, bSize) + bPad, 0) + (FOLLOW_UPS.length - 1) * 8 > aw) {
                    bSize -= 1; bPad = Math.max(16, bPad - 2);
                }
            }
            const btn = (label, bx, run, key) => {
                const w = Math.round(cv.textWidth(label, bSize) + bPad);
                cv.strokeRoundRect(bx + 0.5, btnY + 0.5, w - 1, btnH - 1, 3, 1, withAlpha('#ffffff', 0.24));
                cv.text(label, bx + w / 2, btnY + btnH / 2 + bSize * 0.36, bSize, t.text, { align: 'center' });
                cv.target(bx, btnY, w, btnH, run, key, 3);
                return w;
            };
            if (isThinking) btn('Cancel', ax, cancelAnswer, 'cancel_answer');
            if (chips) {
                let bx = ax;
                FOLLOW_UPS.forEach((f, i) => {
                    if (bx + cv.textWidth(f.title, bSize) + bPad > ax + aw) return;
                    bx += btn(f.title, bx, () => askCopilot(f.query, f.title, { fresh: false }), 'follow_' + i) + 8;
                });
            }

            /* ----- the 3D band, or the keyboard while the question box is open ----- */
            if (showKeyboard) drawKeyboard(cv, t, now);
            else drawBand(cv, t, 700, 58, 860, bottom - 58);
        }

        /* ---------- Topics: the four categories, six topics each; a topic asks at once and shows the answer ---------- */
        function drawTopics(cv, t) {
            const ex = cv.extra || 0, bottom = 510 + ex;
            const x = 56, w = 1488, acc = S.acc(t);
            const segH = Math.min(sz(cv, 30), 44);
            S.segmented(cv, t, x, 60, segH, TOPIC_CATEGORIES.map((c) => c.name.charAt(0) + c.name.slice(1).toLowerCase()), activeCategory, (cIdx) => {
                activeCategory = cIdx;
                selectedTopicIdx = 0;
                render(true);
            }, 'cat', Math.min(sz(cv, 13), 19), Math.min(w, sz(cv, 520)));
            const cat = TOPIC_CATEGORIES[activeCategory] || TOPIC_CATEGORIES[0];
            cv.text(cat.label, x + w, 60 + segH / 2 + sz(cv, 12) * 0.36, Math.min(sz(cv, 12), 18), t.dim, { align: 'right' });
            // two columns of three: elevated dark cards with crisp 1-line descriptions and optional ECU badge
            const top = 60 + segH + 18, colW = (w - 28) / 2, rowH = Math.floor((bottom - top) / 3);
            const tSize = Math.min(sz(cv, 17), 24), dSize = Math.min(sz(cv, 12), 17);
            cat.topics.forEach((p, idx) => {
                const col = idx % 2, row = Math.floor(idx / 2);
                const tx = x + col * (colW + 28), ty = top + row * rowH, th = rowH - 12;
                const isSelected = selectedTopicIdx === idx, isCur = currentPrompt === p.title;
                cv.roundRect(tx, ty, colW, th, 4, '#101218');
                cv.strokeRoundRect(tx + 0.5, ty + 0.5, colW - 1, th - 1, 4, 1, withAlpha('#ffffff', isSelected ? 0.16 : 0.07));
                if (isSelected) S.lit(cv, t, tx + 1, ty + 1, colW - 2, th - 2, 0.9);
                if (isCur) S.mark(cv, tx + 10, ty + Math.round(th * 0.25), Math.round(th * 0.48), acc);
                const padL = isCur ? 42 : 22;
                const badgeTxt = p.faults ? 'ECU SCAN' : '';
                const badgeW = badgeTxt ? Math.round(cv.textWidth(badgeTxt, 12, { font: 'bold' }) + 18) : 0;
                const tY = ty + Math.round(th * 0.42);
                cv.text(fitText(cv, p.title, colW - padL - badgeW - 24, tSize, { font: 'bold' }), tx + padL, tY, tSize, t.text, { font: 'bold' });
                if (badgeTxt) {
                    const bx = tx + colW - 18 - badgeW, by2 = tY - 17;
                    cv.roundRect(bx, by2, badgeW, 22, 3, withAlpha(S.warnC(t), 0.14));
                    cv.strokeRoundRect(bx + 0.5, by2 + 0.5, badgeW - 1, 21, 3, 1, withAlpha(S.warnC(t), 0.42));
                    cv.text(badgeTxt, bx + badgeW / 2, by2 + 15, 12, S.warnC(t), { align: 'center', font: 'bold', literal: true });
                }
                const desc = p.desc || p.query;
                cv.text(fitText(cv, desc, colW - padL - 20, dSize), tx + padL, tY + dSize + 14, dSize, t.dim);
                cv.target(tx, ty, colW, th, () => {
                    selectedTopicIdx = idx;
                    showKeyboard = false;
                    page = 0;
                    engineLive(false);
                    askCopilot(p.query, p.title, { fresh: true, faults: !!p.faults });
                    render(true);
                }, 'topic_' + idx, 4);
            });
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
        // a number with d decimals; a value that rounds to zero has no minus sign (boost a hair under the outside air: "0.00", not "-0.00")
        const fix = (v, d) => { if (typeof v !== 'number' || !isFinite(v)) return null; const s = v.toFixed(d || 0); return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s; };
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
        /**
         * What Data check shows, source by source: { car, live, engine }, each [[label, { c, v }]] - c the state
         * (green: there, amber: waiting, red: failed, grey: not on this car), v the value or why there is none.
         * drawDataCheck draws it.
         */
        function dataCheckData() {
            // the car's latest values: temperatures, gear and vehicle state come without a sample on a parked car
            if (car) takeCar(car.data());
            const g = (v) => (v === null || v === undefined || v === '' ? null : v);
            const ok = (v, why) => (g(v) !== null ? { c: 'green', v: String(v) } : { c: why && why.c ? why.c : 'amber', v: (why && why.v) || 'not known yet' });

            // 1. the car and the links
            const d = vehicle.vin ? Vehicle.decodeVin(vehicle.vin) : null, u = vehicle.unitTypes();
            const CONDS = { 1: 'parked', 2: 'parked', 3: 'parked, driver away', 5: 'parked, no ignition', 7: 'ignition on', 8: 'getting ready', 10: 'drive-ready', 12: 'switching off' };
            const dtc = telemetry.dtcScan, units = telemetry.units || {};
            const miss = Object.keys(missingList());
            const link = diag ? (diag.available ? { c: 'green', v: 'ready' } : diag.error ? { c: 'red', v: 'not available' } : { c: 'amber', v: 'waiting' }) : { c: 'amber', v: 'not opened yet' };
            const carRows = [
                ['VIN (type part)', ok(d && d.descriptor + (vehicle.vinFrom ? ' · ' + vehicle.vinFrom : ''), { c: 'amber', v: 'not received' })],
                ['Make, model year', ok(d && [d.brand, d.year].filter(Boolean).join(', '))],
                ['Engine type', sigState(vehicle.engineType, IF.v2, 'statusVehiclePartType')],
                ['Engine unit', ok(Vehicle.engineUnitName(u), { c: vehicle.tried ? 'grey' : 'amber', v: vehicle.tried ? 'not in the table' : 'not read yet' })],
                ['Gearbox unit', ok(u[0x18], { c: vehicle.tried ? 'grey' : 'amber', v: vehicle.tried ? 'not in the table' : 'not read yet' })],
                ['Vehicle state', sigState(CONDS[telemetry.condition], IF.cond, 'VehicleCondition')],
                ['Engine', ok(engineState(), { v: 'not known' })],
                ['Units', sigState(units.press || units.temp ? [units.press, units.temp, units.speed].filter(Boolean).join(' / ') : null, IF.veh, 'statusNewCurrentUnitsStatusExt')],
                ['Diagnostic link', link],
                ['Fault memory', dtc ? (dtc.error ? { c: 'red', v: dtc.error.slice(0, 34) } : { c: dtc.partial ? 'amber' : 'green', v: dtc.answered + ' units, ' + dtc.total + ' faults' + (dtc.partial ? ', partial' : '') }) : { c: 'amber', v: 'not read yet' }],
                ['Check Control', sigState(Array.isArray(telemetry.checkControl) ? (telemetry.checkControl.length ? telemetry.checkControl.length + ' active' : 'none active') : null, IF.cc, 'basicList')],
                ['Service list', sigState(Array.isArray(telemetry.service) ? (telemetry.service.length ? telemetry.service.length + ' items' : 'nothing listed') : null, IF.k2, 'cbsDataServiceList')],
                ['AI', ai.isConfigured() ? { c: 'green', v: providerName() + (ai.modelLabel() ? ' · ' + ai.modelLabel() : '') } : { c: 'amber', v: 'not paired' }],
                ['Internet', ai.hasInternet ? { c: 'green', v: 'online' } : { c: 'red', v: 'offline' }],
                ['Left out at install', miss.length ? { c: 'grey', v: miss.length + ': ' + miss.map((k) => k.split('.').pop()).join(', ') } : { c: 'green', v: 'nothing' }],
            ];

            // 2. live signals
            const tt = telemetry, c4 = (o, f) => (o ? ['fl', 'fr', 'rl', 'rr'].map((k) => fix(o[k], f)).join(' ') : null);
            const both = (a, b) => (a === null && b === null ? null : [a === null ? '--' : a, b === null ? '--' : b].join(' / '));
            // the selector and the gear, as Live Data shows them: P, R, N, D3; without the selector the gear alone
            const gearText = tt.stage ? tt.stage + (tt.stage === 'D' && tt.gear > 0 ? tt.gear : '')
                : typeof tt.gear === 'number' ? (tt.gear > 0 ? 'gear ' + tt.gear : tt.gear < 0 ? 'R' : 'N or P') : null;
            const live = [
                ['Speed', sigState(tt.speed !== null ? tt.speed + ' km/h' : null, IF.v2, 'statusCarSpeed2')],
                ['Engine speed', sigState(tt.rpm !== null ? tt.rpm + ' rpm' : null, IF.cds, 'statusEngineSpeed2')],
                ['Gear', sigState(gearText, IF.vi)],
                ['Engine torque', sigState(tt.torque !== null ? tt.torque + ' Nm' : null, IF.fes, 'statusActualValueTorque2')],
                ['Sport display (power, boost)', sigState(tt.powerPct !== null || tt.boost !== null ? [tt.powerPct !== null ? tt.powerPct + ' %' : '', tt.boost !== null ? fix(tt.boost, 2) + ' bar' : ''].filter(Boolean).join(', ') : null, IF.fes, 'statusVehicleDynamicEngine')],
                ['Driving mode', sigState(tt.mode, IF.fes, 'statusFESVehicleDynamicSwitchHMI')],
                ['Oil / coolant temperature', sigState(both(tt.oilTemp, tt.coolantTemp) && both(tt.oilTemp, tt.coolantTemp) + ' °C', IF.cds, 'statusEngineTemperature')],
                ['Oil level', sigState(tt.oilLevel, IF.v2, 'statusOilDipstick2')],
                ['Outside temperature', sigState(tt.ambient !== null ? fix(tt.ambient, 1) + ' °C' : null, IF.env, 'ExteriorTemperature')],
                ['Tyre pressures (bar)', sigState(c4(tt.tyres, 1), IF.tpms, 'statusTyrePressure')],
                ['Tyre temperatures (°C)', sigState(c4(tt.tyreTemps, 0), IF.tpms, 'statusTyreTemperature')],
                ['Fuel / range', sigState(both(tt.fuelL !== null ? tt.fuelL + ' l' : null, tt.rangeKm !== null ? tt.rangeKm + ' km' : null), IF.kombi, 'statusRangeTankStatus')],
                ['Odometer', sigState(tt.odoKm !== null ? tt.odoKm + ' km' : null, IF.kombi, 'statusRangeTankStatus')],
                ['Trip average', sigState(tt.avgCons ? fix(tt.avgCons.value, 1) + ' ' + tt.avgCons.unit : null, IF.kombi, 'statusBordcomputerAverage')],
                ['12 V battery charge', sigState(tt.batteryPct !== null ? tt.batteryPct + ' %' : null, IF.cds, 'statusBattery2')],
                ['Start-stop / parking brake', sigState(tt.msa || tt.handbrake ? [tt.msa ? 'start-stop ' + tt.msa : '', tt.handbrake ? 'brake ' + tt.handbrake : ''].filter(Boolean).join(', ') : null, IF.cds2, 'statusPushButtonMSA2')],
                ['Engine state signal', sigState(tt.engine, IF.cds, 'statusEngineStatus')],
            ];

            // 3. the engine computer (engine_snapshot.js)
            const NAMES = { boostActual: 'Boost actual', boostTarget: 'Boost target', baro: 'Outside air pressure', iat: 'Intake air', loadActual: 'Load actual', loadTarget: 'Load target',
                timing: 'Ignition timing', hpfp: 'High-pressure fuel', lpfp: 'Low-pressure fuel', gearboxOil: 'Gearbox oil', oil: 'Engine oil (unit)', v12: '12 V voltage', misfire: 'Misfires',
                hvSoc: 'HV battery charge', hvSoh: 'HV battery health' };
            const FMT = { boostActual: (v) => fix(v, 2) + ' bar', boostTarget: (v) => fix(v, 2) + ' bar', baro: (v) => fix(v) + ' kPa', iat: (v) => fix(v) + ' °C', loadActual: (v) => fix(v) + ' %',
                loadTarget: (v) => fix(v) + ' %', timing: (v) => fix(v, 1) + '°', hpfp: (v) => fix(v) + ' bar', lpfp: (v) => fix(v, 1) + ' bar', gearboxOil: (v) => fix(v) + ' °C', oil: (v) => fix(v) + ' °C',
                v12: (v) => fix(v, 2) + ' V', misfire: (v) => v.map((n) => (n === null ? '?' : n)).join(' ') + (telemetry.engineSnap && telemetry.engineSnap.values.misfirePartial ? ' (bank 1)' : ''), hvSoc: (v) => fix(v) + ' %', hvSoh: (v) => fix(v) + ' %' };
            const RUN_ONLY = ['boostActual', 'boostTarget', 'loadActual', 'loadTarget', 'timing', 'misfire'];
            const snapOff = telemetry.engineSnap && telemetry.engineSnap.engine === 'off';
            const rep = snapshot ? snapshot.report() : Object.keys(NAMES).map((name) => ({ name }));
            const engine = rep.map((r) => {
                let st;
                if (r.na) st = { c: 'grey', v: r.na };
                else if (r.value !== undefined && r.value !== null) st = { c: 'green', v: FMT[r.name](r.value) + (r.via ? ' · ' + r.via : '') };
                // the engine unit's oil temperature is only asked when the car's own signal has none
                else if (r.name === 'oil' && telemetry.oilTemp !== null) st = { c: 'grey', v: 'not needed: car signal has it' };
                else if (carAwake() === 'asleep') st = { c: 'grey', v: 'car asleep (ignition off)' };
                else if (!diag || !diag.available) st = { c: diag && diag.error ? 'red' : 'amber', v: 'no diagnostic link' + (diag && diag.error ? '' : ' yet') };
                else if (snapOff && RUN_ONLY.indexOf(r.name) >= 0) st = { c: 'grey', v: 'engine off: not read' };
                else if ((r.name === 'hvSoc' || r.name === 'hvSoh') && snapshot && (snapshot.hvMissing || (telemetry.engineSnap && !hybridCar()))) st = { c: 'grey', v: 'no HV battery' };
                else if (r.why) st = { c: r.fails >= 3 ? 'red' : 'amber', v: r.why + (r.fails ? ' (' + r.fails + 'x)' : '') };
                else st = { c: 'amber', v: 'not read yet' };
                return [NAMES[r.name], st];
            });
            return { car: carRows, live, engine };
        }
        let dataCheckTab = 0;
        function drawDataCheck(cv, t) {
            const ex = cv.extra || 0, bottom = 510 + ex, gpu = !!cv.place;
            const COL = { green: S.OK, amber: S.warnC(t), red: S.critC(t), grey: '#55565e' };
            const selC = S.sel(t);
            const D = dataCheckData();
            const isLive = !!(liveOn() && diag && diag.available);
            const cats = [
                { title: 'Car & links', panelTitle: 'Car & links', sub: 'VIN, ECUs, faults, AI, internet', list: D.car },
                { title: 'Live signals', panelTitle: 'Live signals', sub: 'Speed, RPM, temps, tyres, fuel', list: D.live },
                { title: 'Engine computer', panelTitle: isLive ? 'Engine computer · live' : 'Engine computer', sub: 'Boost, load, timing, fuel, misfires', list: D.engine },
            ];
            if (dataCheckTab < 0 || dataCheckTab >= cats.length) dataCheckTab = 0;

            const tally = (list) => {
                const n = { green: 0, amber: 0, red: 0, grey: 0, total: list.length };
                list.forEach(([, st]) => { n[st.c] = (n[st.c] || 0) + 1; });
                return n;
            };
            const all = D.car.concat(D.live, D.engine);
            const tot = tally(all);
            const activeTotal = Math.max(1, tot.total - tot.grey);
            const pct = Math.round((tot.green / activeTotal) * 100);

            /** Horizontal segmented status bar (green -> amber -> red -> grey) across w px. */
            const statusBar = (x, y, w, h, counts) => {
                cv.fillRect(x, y, w, h, withAlpha('#ffffff', 0.08));
                let cx = x;
                ['green', 'amber', 'red', 'grey'].forEach((k) => {
                    const cnt = counts[k] || 0;
                    if (!cnt || !counts.total) return;
                    const seg = Math.max(2, Math.round((cnt / counts.total) * w));
                    const drawW = Math.min(seg, x + w - cx);
                    if (drawW > 0) {
                        cv.fillRect(cx, y, drawW, h, k === 'grey' ? withAlpha('#ffffff', 0.16) : COL[k]);
                        cx += drawW + 2;
                    }
                });
            };

            // ----- Left Zone: Readiness summary + 3 category selectors + action buttons -----
            const lx = 56, lw = 436;
            const glowCol = tot.red > 0 && tot.green === 0 ? COL.red : tot.green >= activeTotal * 0.7 ? S.OK : selC;
            if (gpu) S.softEllipse(cv, lx + lw * 0.45, 128, 300, 140, glowCol, 0.15);

            const labSz = Math.min(sz(cv, 11.5), 16);
            if (isLive) {
                S.led(cv, lx + 4, 70 - labSz * 0.35, S.OK, gpu);
                cv.text('Telemetry coverage · live', lx + 18, 70, labSz, t.dim);
            } else {
                cv.text('Telemetry coverage', lx, 70, labSz, t.dim);
            }

            const bigSz = Math.min(sz(cv, 44), 56), subSz = Math.min(sz(cv, 18), 24);
            const numY = 76 + bigSz * 0.96;
            const gw0 = cv.text(String(tot.green), lx, numY, bigSz, t.text, { font: 'num', literal: true });
            cv.text(' / ' + tot.total, lx + gw0 + 4, numY - 2, subSz, t.dim, { font: 'num', literal: true });
            cv.text(pct + '% ready', lx + lw, numY - 2, Math.min(sz(cv, 13), 18), tot.green > 0 ? S.OK : t.dim, { align: 'right', literal: true });

            statusBar(lx, numY + 16, lw, 4, tot);

            // Action buttons anchored at bottom-left
            const bh = Math.min(sz(cv, 28), 40), btnY = bottom - bh;
            const bSize = Math.min(sz(cv, 11.5), 16), bGap = 10;
            const w1 = Math.round(lw * 0.43), w2 = lw - w1 - bGap;
            const b1Busy = checking === 'engine', b2Busy = checking === 'faults';
            S.button(cv, t, lx, btnY, b1Busy ? 'Reading...' : 'Read engine', () => checkNow('engine'),
                { w: w1, h: bh, size: bSize, key: 'dc_engine', busy: !!checking && !b1Busy, primary: b1Busy });
            S.button(cv, t, lx + w1 + bGap, btnY, b2Busy ? 'Reading...' : 'Read fault memory', () => checkNow('faults'),
                { w: w2, h: bh, size: bSize, key: 'dc_faults', busy: !!checking && !b2Busy, primary: b2Busy });

            // 3 category selector cards between summary bar and action buttons
            const catTop = numY + 36, catAvail = btnY - 16 - catTop, catGap = 10;
            const catH = Math.min(82, Math.max(60, Math.floor((catAvail - catGap * 2) / 3)));
            const ctSz = Math.min(sz(cv, 14), 20), csSz = Math.min(sz(cv, 11), 15), cnSz = Math.min(sz(cv, 12.5), 17);
            cats.forEach((cat, idx) => {
                const ry = catTop + idx * (catH + catGap), on = idx === dataCheckTab;
                const c = tally(cat.list);
                S.hairline(cv, lx, ry, lw, 0.1);
                if (on) {
                    S.lit(cv, t, lx, ry + 1, lw, catH - 1, 1.0);
                    S.mark(cv, lx + 8, ry + 16, catH - 36, selC);
                }
                const tx = lx + (on ? 32 : 14);
                const cntTxt = c.green + ' / ' + c.total;
                const cntCol = c.green === c.total ? S.OK : c.red > 0 && c.green === 0 ? COL.red : on ? t.text : t.dim;
                cv.text(cntTxt, lx + lw - 12, ry + Math.round(catH * 0.42), cnSz, cntCol, { align: 'right', font: 'num', literal: true });
                cv.text(cat.title, tx, ry + Math.round(catH * 0.42), ctSz, on ? t.text : '#c8cad0', { font: 'bold' });
                cv.text(fitText(cv, cat.sub, lw - (tx - lx) - 16, csSz), tx, ry + Math.round(catH * 0.72), csSz, t.dim);
                statusBar(tx, ry + catH - 11, lw - (tx - lx) - 12, 3, c);
                cv.target(lx, ry, lw, catH, () => { dataCheckTab = idx; render(true); }, 'dc_cat_' + idx, 3);
            });

            // ----- Right Zone: Selected category in 2 airy, readable columns -----
            const rx = 540, rw = 1016;
            const selCat = cats[dataCheckTab];
            const sc = tally(selCat.list);
            G.panelExact(cv, t, rx, 44, rw, bottom - 44, selCat.panelTitle);

            // Inline status counts right-aligned in the header strip (replaces old bottom legend)
            const pills = [['green', sc.green + ' ready'], ['amber', sc.amber + ' waiting'], ['red', sc.red + ' failed'], ['grey', sc.grey + ' n/a']]
                .filter((p) => sc[p[0]] > 0);
            const ps = Math.min(sz(cv, 11), 16);
            let px = rx + rw;
            for (let i = pills.length - 1; i >= 0; i--) {
                const [k, txt] = pills[i];
                const tw = cv.textWidth(txt, ps, { literal: true });
                cv.text(txt, px, 76, ps, k === 'grey' ? t.dim : '#c8cad0', { align: 'right', literal: true });
                cv.circle(px - tw - 10, 76 - ps * 0.34, 3.5, COL[k]);
                px -= tw + 34;
            }

            // 2 balanced sub-columns (8-9 rows each -> generous row height and legible 18 px text)
            const list = selCat.list;
            const split = Math.ceil(list.length / 2);
            const colGap = 40, colW = Math.floor((rw - colGap) / 2);
            const top = 104, availH = bottom - top;
            const step = Math.min(48, Math.max(32, Math.floor(availH / Math.max(1, split))));
            const rs = Math.min(sz(cv, 12.5), Math.min(18, Math.round(step * 0.44)));
            [list.slice(0, split), list.slice(split)].forEach((part, ci) => {
                const cx = rx + ci * (colW + colGap);
                part.forEach(([label, st], i) => {
                    const y = top + i * step, cy = y + step / 2;
                    S.hairline(cv, cx, y, colW, 0.08);
                    const live = st.c === 'green';
                    if (gpu && (live || st.c === 'red')) S.led(cv, cx + 6, cy, COL[st.c], true);
                    else cv.circle(cx + 6, cy, 3.5, COL[st.c] || t.dim);
                    cv.text(fitText(cv, label, colW * 0.48, rs), cx + 22, cy + rs * 0.35, rs, live ? '#d4d6dc' : t.dim);
                    const valCol = live ? t.text : st.c === 'red' ? COL.red : t.dim;
                    cv.text(fitText(cv, st.v, colW * 0.48, rs, { literal: true }), cx + colW, cy + rs * 0.35, rs, valCol,
                        { align: 'right', font: live ? 'bold' : 'normal', literal: true });
                });
                if (part.length) S.hairline(cv, cx, top + part.length * step, colW, 0.08);
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
        let page = ai.isConfigured() ? 0 : 3;   // 0 the answer, 1 Topics, 2 Data check, 3 Connect (first, until paired)
        let showPhoneQr = false;            // Connect: the phone page's QR in place of the settings list
        async function render(force = false) {
            const now = Date.now();
            const animating = (bandSwitchAt && now - bandSwitchAt < BAND_SWITCH_MS + 60) || isThinking;
            if (!force && !animating && now - lastRenderTime < 250) return;
            // the car started moving with the keyboard open, typing or not: it closes at the next frame (within
            // 250 ms of the speed crossing 8 km/h) and what was typed is kept for when the car stands
            if (showKeyboard && typingLocked()) {
                showKeyboard = false;
                notify(lockMsg());
            }
            const cv = ctx.canvas(W, H);
            // what the frame shows: unchanged, the frame isn't drawn again (a safety redraw every 2 s)
            const sig = [ai.hasInternet, ai.isConfigured(), showPhoneQr, showKeyboard, customQuery, activeCategory, selectedTopicIdx, currentPrompt, currentResponse,
                dialogueScroll, canFollowUp, isThinking, telemetry.moving, vitalsLine(), statusMsg && now - statusTime < 3500 ? statusMsg : '', ai.modelLabel(), providerName(),
                cv.extra || 0, bandSignal, history.length, page === 3 ? cloudPair.getPairingUrl() + JSON.stringify(vehicle.profile || {}) + (ai.config.model || '') : '', page, page === 2 ? dataCheckTab + ':' + Math.floor(now / 1000) + (checking || '') : ''].join('|');
            if (!force && !animating && sig === lastSig && now - lastRenderTime < 2000) return;
            lastSig = sig;
            lastRenderTime = now;

            const t = ctx.theme();
            cv.clear(t.bg);

            // Mandatory Online & Config Checks (the Data check page works without internet or pairing)
            if (page === 1) {
                drawTopics(cv, t);
            } else if (page === 2) {
                drawDataCheck(cv, t);
            } else if (page === 3) {
                drawConnect(cv, t);
            } else if (!ai.hasInternet) {
                drawNoInternet(cv, t);
            } else if (!ai.isConfigured()) {
                drawNeedsConnect(cv, t);
            } else {
                drawMainCopilot(cv, t, now);
            }

            // the page tabs along the top, no status chips: the pages show their own state
            G.frame(cv, t, PAGES, page);

            // Global Notification banner
            if (statusMsg && (now - statusTime < 3500)) {
                const sy = H + (cv.extra || 0);
                cv.roundRect(W / 2 - 320, sy - 56, 640, 42, 3, '#17181d');
                cv.strokeRoundRect(W / 2 - 319.5, sy - 55.5, 639, 41, 3, 1, withAlpha('#ffffff', 0.16));
                S.mark(cv, W / 2 - 302, sy - 46, 22, S.acc(t));
                cv.text(statusMsg, W / 2, sy - 29, 18, t.text, { align: 'center' });
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
            page = 3;
            showKeyboard = false;
            return render(true);
        });

        ctx.onTab((i) => {
            page = i >= 1 && i <= 3 ? i : 0;
            showKeyboard = false;
            engineLive(page === 2);
            return render(true);
        });

        // Run low-frequency idle loop (4 fps) to minimize CPU/GPU load by >85%
        // ---- lifecycle: nothing runs while M-Copilot is not on screen; everything stops on exit
        function foreground() {
            clearLive();
            // back on screen the speed is unknown until the car sends it again: a keyboard left open would take
            // keys meanwhile, perhaps while driving, so it comes back closed (the typed text is kept)
            showKeyboard = false;
            startCar();
            loadSampling(true);
            cloudPair.startPolling();
            historyOn(true);
            // a fresh hello on the channel (the relay keeps it 12 h) shows the car's settings on a
            // phone page opened while the car is off; at most every 6 hours
            if (ai.isConfigured() && Date.now() - lastHello > 6 * 3600 * 1000) hello();
            ai.checkInternetConnection().catch(() => {});
            engineLive(page === 2);
            render(true).catch(() => {});
        }
        function background() {
            engineLive(false);
            stopCar();
            loadSampling(false);
            historyOn(false);
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

        ctx.loop('MAIN', 4, render, { maxFps: () => ((bandSwitchAt && Date.now() - bandSwitchAt < BAND_SWITCH_MS + 60) ? 30 : 10) });
        render(true).then(() => log.info('M-Copilot ready')).catch((e) => log.warn('M-Copilot render error: ' + e));
    }
});
