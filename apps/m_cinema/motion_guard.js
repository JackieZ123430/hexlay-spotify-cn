'use strict';
/**
 * motion_guard.js - "parked only" for video: locked unless the car is clearly standing.
 *
 * Locked (fail closed) when any of these holds:
 *   - the car moves faster than parked.MAX_KMH (Vehicle2.statusCarSpeed2, via kit/parked)
 *   - the gearbox reports D or R (stopped at a light in D is still driving)
 *   - on a real car, no valid speed has been read yet (unknown = not known to be parked)
 * On a VM / bench (no native signals) an unknown speed counts as parked, so the emulator works.
 *
 * Needs in app.json "signals":
 *   "de.bmw.infotainment.vehicle.Vehicle2": { "statusCarSpeed2": "rs" }
 *   "de.bmw.infrastructure.VehicleInformation": { "statusGearboxDrive": "s", "DataPowerTrain2": "s" }
 */
const parkedKit = require('./kit/parked');
let selectionOf = null;
try { selectionOf = require('./kit/car').selectionOf; } catch (e) {}

// statusActualStageDrive: names or wire numbers (P = 1, R = 2, N = 3, D = 4)
const STAGES = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };

function watch(ctx, log) {
    const parked = parkedKit.watch(ctx, log);
    let stage;
    const setStage = (s) => {
        if (!s || s === stage) return;
        stage = s;
        if (log) log.info('[M-Cinema] Gear selector: ' + s);
    };
    ctx.signals.watch('de.bmw.infrastructure.VehicleInformation', '1', {
        statusGearboxDrive: (v) => setStage(STAGES[v && v.statusActualStageDrive]),
        DataPowerTrain2: (v) => {
            const sel = selectionOf ? selectionOf(v && v.statusGearSelectionDrive) : null;
            if (sel) setStage(sel.stage);
        },
    }, log).then((s) => log && log.info('gear check: ' + (s.error ? 'error: ' + s.error : 'subscribed')));

    const onCar = () => !ctx.signals.hasNative || ctx.signals.hasNative();

    return {
        speed: () => parked.speed(),
        stage: () => stage,
        /** { locked, reason } - reason is shown to the driver. */
        state() {
            const kmh = parked.speed();
            if (kmh !== null && kmh > parkedKit.MAX_KMH) return { locked: true, reason: 'moving' };
            if (stage === 'D' || stage === 'R') return { locked: true, reason: 'in gear ' + stage };
            if (kmh === null && onCar()) return { locked: true, reason: 'speed unknown' };
            return { locked: false, reason: '' };
        },
    };
}

module.exports = { watch };
