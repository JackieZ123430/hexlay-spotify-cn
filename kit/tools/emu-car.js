'use strict';
/**
 * emu-car.js - a sample car for the emulator: what a car's signals send and what its control units answer
 * over the diagnostic link (TASU), so an app's pages can be seen filled as in a car (screenshots, layout).
 * Made-up values of a parked car with the engine idling in P; the VIN is a made-up one (serial all zeros).
 *
 *   MGU_EMU_CAR=b58 node kit/tools/emu.js m_copilot     (b58: one engine unit; n63: a V8, an engine unit per bank)
 *
 * hu-stub.js takes it in place of its "no SOME/IP" stubs: signals.proxy / call / on for the TASU interface
 * answer as the units would; the signals are fed every second (rpm / speed 20 a second); the emulator's
 * demo / manual signal panel is left out while it runs.
 */
const VIN = 'WBA000000M0000000';             // (VIN 10 = model year: M = 2021)
const CDS = 'de.bmw.infotainment.vehicle.CDS', CDS2 = 'de.bmw.infotainment.vehicle.CDS2', V2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const KOMBI = 'de.bmw.infotainment.KombiIF', FES = 'de.bmw.infotainment.drivingexcitement.FES', TPMS = 'de.bmw.infotainment.vehicle.TPMS';
const VI = 'de.bmw.infrastructure.VehicleInformation', ENV = 'de.bmw.infrastructure.EnvironmentalInformation', K2 = 'de.bmw.infotainment.KombiInterface_2';

// the engine units' answers (kPa absolute for pressures, as app.json "config.dme" scales them)
// (a function: read at each request, so a page that reads live is seen moving)
const wobble = (mid, amp, ms) => () => mid + amp * Math.sin(Date.now() / ms);
const IDLE = { baro: 100.8, boostTarget: 101.5, boostActual: wobble(101.2, 0.4, 2300), iat: wobble(31, 2, 5000), loadTarget: 18.75, loadActual: wobble(18, 1.5, 1700),
    timing: wobble(6, 1.5, 1300), hpfp: wobble(52, 4, 2900), lpfp: 5.5, v12: wobble(14.32, 0.05, 3100) };
const PROFILES = {
    b58: { 0x12: { f150: '0F2424', values: IDLE, misfire: [0, 0, 0, 0, 0, 0] } },
    n63: { 0x12: { f150: '0F242C', values: IDLE, misfire: [0, 0, 0, 0] }, 0x13: { f150: '0F242C', misfire: [0, 0, 0, 0] } },
};
const GEARBOX = { f150: '0F2D60', values: { egs: 71 } };
// the units that answer a fault memory read (none with a fault)
const UNITS = [0x01, 0x10, 0x12, 0x18, 0x29, 0x30, 0x40, 0x56, 0x60, 0x63, 0x67, 0x72, 0x78];

/** a value as candidate c's reply bytes: raw = (v - offset) / factor, 'bytes' big-endian at 'at' */
function encode(c, v) {
    const raw = Math.round((v - (c.offset || 0)) / (c.factor == null ? 1 : c.factor)), n = c.bytes || 1, out = [];
    for (let i = 0; i < (c.at || 0); i++) out.push(0);
    for (let i = n - 1; i >= 0; i--) out.push((raw >> (8 * i)) & 0xFF);
    return out;
}

function start(hu, name) {
    const prof = PROFILES[String(name).toLowerCase()] || PROFILES.b58;
    const units = Object.assign({ 0x18: GEARBOX }, prof);
    const config = (hu.spec && hu.spec.config) || {};
    const cands = {};
    [config.dme || {}, config.battery || {}].forEach((sec) => Object.keys(sec).forEach((k) => { if (Array.isArray(sec[k])) cands[k] = sec[k]; }));

    /** one unit's UDS reply to a request, or null (a unit not there stays silent) */
    function answer(ecu, sid, data) {
        const u = units[ecu], nrc = [0x7F, sid, 0x31];
        if (sid === 0x19) return UNITS.indexOf(ecu) >= 0 ? [0x59, data[0], 0xFF] : null;
        if (!u) return null;
        if (sid === 0x22 && data[0] === 0xF1 && data[1] === 0x50) return [0x62, 0xF1, 0x50].concat(u.f150.match(/../g).map((x) => parseInt(x, 16)));
        if (sid === 0x22 && data[0] === 0xF1 && data[1] === 0x90 && ecu === 0x12) return [0x62, 0xF1, 0x90].concat(Array.from(Buffer.from(VIN)));
        if (sid === 0x06 && u.misfire) {
            const mid = data[0], m = u.misfire;
            if (mid === 0xA0) { const b = [0, 0, 0, 0]; m.forEach((x, i) => { b[(i + 1) >> 3] |= 0x80 >> ((i + 1) & 7); }); return [0x46, 0xA0].concat(b); }
            const i = mid - 0xA2;
            return i >= 0 && i < m.length ? [0x46, mid, 0x0C, 0x24, m[i] >> 8, m[i] & 0xFF, 0, 0, 0xFF, 0xFF] : nrc;
        }
        for (const k of Object.keys(u.values || {})) {
            for (const c of cands[k] || []) {
                if ((c.ecu == null ? 0x12 : c.ecu) !== ecu) continue;
                const val = typeof u.values[k] === 'function' ? u.values[k]() : u.values[k];
                if (c.obd && sid === 0x01 && data[0] === parseInt(c.obd, 16)) return [0x41, data[0]].concat(encode(c, val));
                if (c.did && sid === 0x22 && ((data[0] << 8) | data[1]) === parseInt(c.did, 16)) return [0x62, data[0], data[1]].concat(encode(c, val));
            }
        }
        return nrc;
    }

    // the TASU interface: a request is taken, the unit's reply comes as a sendTasuResponse frame
    let onResponse = null;
    const frame = (ecu, uds) => onResponse && onResponse({ errorCode: 'NO_ERROR', udsResponse: [0, 0, 0, 0, 0, 0, ecu, 0, 0].concat(uds) });
    const proxy = async () => ({ sampleCar: true });
    const call = async (p, method, req) => {
        const target = req.targetAddress, sid = req.serviceID, data = Array.from(req.udsData || []);
        const to = target === 0xDF ? UNITS.concat(Object.keys(units).map(Number)).filter((x, i, a) => a.indexOf(x) === i) : [target];
        to.forEach((ecu, i) => {
            const r = answer(ecu, sid, data);
            if (r) setTimeout(() => frame(ecu, r), 15 + i * 5);
        });
        return { TasuErrorEnum: 'NO_ERROR' };
    };
    const on = async (p, name, fn) => { if (name === 'sendTasuResponse') onResponse = fn; };
    const onAvailable = async (p, fn) => fn(true);

    // the signals: a parked car, engine idling in P, Comfort
    hu.sampleCar = true;
    hu.settings.values.demo = 'off';
    const r = (x, k, o) => Math.max(0, Math.round((x - (o || 0)) / k));
    const slow = () => [
        [CDS, 'statusEngineTemperature', { temperatureEngineDrive: r(91, 1, -48), temperatureEngineOilDrive: r(94, 1, -48) }],
        [CDS, 'statusEngineStatus', { statusEngineRunDrive: 'MOTOR_LAEUFT' }],
        [CDS, 'statusHandBrake', { statusContactHandBrake: 'HANDBREMSE_ANGEZOGEN' }],
        [CDS, 'statusBattery2', { conditionBatteryChargingCondition: 86 }],
        [CDS2, 'statusPushButtonMSA2', { statusFunctionMSA: 'MSA_DEAKTIVIERT' }],
        [V2, 'statusOilDipstick2', { fluidLevelEngineOilRelative: 'MOTOROELSTAND_OK' }],
        [V2, 'statusVehiclePartType', { typeEngine: 'BENZIN_DIREKTEINSPRITZUNG' }],
        [FES, 'statusFESVehicleDynamicSwitchHMI', { actualValueModeDrivingExperience: 'COMFORT' }],
        [FES, 'statusVehicleDynamicEngine', { displaySportEnginePower: 2, displaySportEngineTorque: 6 }],
        [FES, 'statusSwitchDriveDynamicSport2', { displayBoostPressure: 0 }],
        [FES, 'statusActualValueTorque2', { actualValueTorqueCrankshaft: r(28, 0.5, -1023.5) }],
        [VI, 'DataPowerTrain2', { statusGearSelectionDrive: 'P' }],
        ['de.bmw.infrastructure.VehicleCondition', 'VehicleCondition', { statusConditionVehicle: 'FAHREN' }],
        ['de.bmw.infotainment.vehicle.Vehicle', 'statusNewCurrentUnitsStatusExt', { unitOfMeasurementAirPressure: 'BAR', unitOfMeasurementTemperature: 'C' }],
        [ENV, 'ExteriorTemperature', { temperatureExterior: r(12.5, 0.5, -40) }],
        [TPMS, 'statusTyrePressure', { actualValuePressureTyreFLH: 25, actualValuePressureTyreFRH: 25, actualValuePressureTyreRLH: 28, actualValuePressureTyreRRH: 28 }],
        [TPMS, 'statusTargetTyrePressure', { targetPressureTyreFLH: 25, targetPressureTyreFRH: 25, targetPressureTyreRLH: 28, targetPressureTyreRRH: 28 }],
        [TPMS, 'statusTyreTemperature', { actualValueTemperatureTyreFLH: 56, actualValueTemperatureTyreFRH: 56, actualValueTemperatureTyreRLH: 55, actualValueTemperatureTyreRRH: 55 }],
        [KOMBI, 'statusRangeTankStatus', { fluidLevelFuelTank: 47, range: 512, mileageKilometre: 41280 }],
        [KOMBI, 'statusBordcomputerAverage', { consumptionAverage1BC1: 94, statusUnitOfMeasurementConsumptionBC: 'VERBRAUCH_IN_L_S_100KM', statusUnitOfMeasurementSpeedBC: 'KM_S_H__KM' }],
        ['de.bmw.infotainment.checkcontrol.CheckControlMaster', 'basicList', []],
        [K2, 'cbsDataServiceList', [{ cbsData: { cBSIdentifier: 1, cBSColor: 'GREEN', cBSServiceName: 'Engine oil', cBSServiceWay: '11800 km', cBSServiceDate: '06/2027' } },
            { cbsData: { cBSIdentifier: 2, cBSColor: 'GREEN', cBSServiceName: 'Front brakes', cBSServiceWay: '24000 km', cBSServiceDate: '' } },
            { cbsData: { cBSIdentifier: 6, cBSColor: 'GREEN', cBSServiceName: 'Rear brakes', cBSServiceWay: '38000 km', cBSServiceDate: '' } },
            { cbsData: { cBSIdentifier: 3, cBSColor: 'GREEN', cBSServiceName: 'Brake fluid', cBSServiceWay: '', cBSServiceDate: '04/2027' } },
            { cbsData: { cBSIdentifier: 17, cBSColor: 'GREEN', cBSServiceName: 'Vehicle check', cBSServiceWay: '', cBSServiceDate: '06/2027' } }]],
        [K2, 'cbsDataSBA', { value: { cBSDataSBAText: 'Brake fluid', cBSDataSBADistance: '', cBSDataSBADate: '04/2027' } }],
    ];
    let n = 0;
    setInterval(() => {
        hu.feed(CDS, 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: r(690 + 10 * Math.sin(n / 7), 0.25) });
        hu.feed(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: 0 });
        if (n++ % 20 === 0) slow().forEach((x) => hu.feed(x[0], x[1], x[2]));
    }, 50);
    hu.log.info('sample car: ' + (PROFILES[String(name).toLowerCase()] ? name : 'b58') + ' (kit/tools/emu-car.js)');
    return { proxy, call, on, onAvailable };
}

module.exports = { start, VIN, encode };
