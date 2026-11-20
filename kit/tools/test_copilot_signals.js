'use strict';

// M-Copilot's car signals (apps/m_copilot/car_signals.js) against what cars send: the structs of
// idrive7-apps Live Data's demo, enums as names, wire numbers and digit strings, plug-in hybrid driving
// modes, names of another software level, "no value" names, a car in psi. Then the kit: car.js hands
// each interface's poll interval to signals.watch, and a subscription's shutdown ends its poll timer.
// No car needed:
//   node kit/tools/test_copilot_signals.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..');
const carSignals = require(path.join(ROOT, 'apps', 'm_copilot', 'car_signals'));
const Vehicle = { engineTypeOf: (r) => ({ BENZIN_DIREKTEINSPRITZUNG: 'petrol (direct injection)', 6: 'diesel' })[r] || null };
const near = (a, b, what) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 0.01, what + ': ' + a + ' is not ' + b);

const CDS = 'de.bmw.infotainment.vehicle.CDS', CDS2 = 'de.bmw.infotainment.vehicle.CDS2', V2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const KOMBI = 'de.bmw.infotainment.KombiIF', FES = 'de.bmw.infotainment.drivingexcitement.FES', TPMS = 'de.bmw.infotainment.vehicle.TPMS';
const ENV = 'de.bmw.infrastructure.EnvironmentalInformation', VEH = 'de.bmw.infotainment.vehicle.Vehicle', MD = 'de.bmw.infotainment.misc.MDrive';
const K2 = 'de.bmw.infotainment.KombiInterface_2', CC = 'de.bmw.infotainment.checkcontrol.CheckControlMaster';

function fresh() {
    const t = { units: {} }, vehicle = {};
    const sig = carSignals(t, { vehicle, Vehicle, log: { info() {} } });
    const feed = (iface, field, v) => sig.extra[iface][field](v);
    return { t, vehicle, sig, feed };
}

// 1. Live Data's demo: everything a car sends, as names
{
    const { t, vehicle, feed } = fresh();
    feed(CDS, 'statusEngineStatus', { statusEngineRunDrive: 'MOTOR_LAEUFT' });
    feed(CDS, 'statusHandBrake', { statusContactHandBrake: 'HANDBREMSE_GELOEST' });
    feed(CDS, 'statusBattery2', { conditionBatteryChargingCondition: 84 });
    feed(CDS2, 'statusPushButtonMSA2', { statusFunctionMSA: 'MSA_DEAKTIVIERT' });
    feed(V2, 'statusOilDipstick2', { fluidLevelEngineOilRelative: 'MOTOROELSTAND_OK' });
    feed(V2, 'statusVehiclePartType', { typeEngine: 'BENZIN_DIREKTEINSPRITZUNG' });
    feed(KOMBI, 'statusRangeTankStatus', { fluidLevelFuelTank: 41, range: 452, mileageKilometre: 23817 });
    feed(KOMBI, 'statusBordcomputerAverage', { consumptionAverage1BC1: 98, statusUnitOfMeasurementConsumptionBC: 'VERBRAUCH_IN_L_S_100KM', statusUnitOfMeasurementSpeedBC: 'KM_S_H__KM' });
    feed(FES, 'statusVehicleDynamicEngine', { displaySportEnginePower: 40, displaySportEngineTorque: 55 });
    feed(FES, 'statusSwitchDriveDynamicSport2', { displayBoostPressure: 110 });
    feed(FES, 'statusFESVehicleDynamicSwitchHMI', { actualValueModeDrivingExperience: 'SPORT_DYNAMIC' });
    feed(ENV, 'ExteriorTemperature', { temperatureExterior: 103 });
    feed(TPMS, 'statusTyrePressure', { actualValuePressureTyreFLH: 25, actualValuePressureTyreFRH: 25, actualValuePressureTyreRLH: 27, actualValuePressureTyreRRH: 26 });
    feed(TPMS, 'statusTyreTemperature', { actualValueTemperatureTyreFLH: 62, actualValueTemperatureTyreFRH: 63, actualValueTemperatureTyreRLH: 60, actualValueTemperatureTyreRRH: 61 });
    assert.strictEqual(t.engine, 'running');
    assert.strictEqual(t.handbrake, 'released');
    assert.strictEqual(t.batteryPct, 84);
    assert.strictEqual(t.msa, 'off');
    assert.strictEqual(t.oilLevel, 'OK');
    assert.strictEqual(vehicle.engineType, 'petrol (direct injection)');
    assert.deepStrictEqual([t.fuelL, t.rangeKm, t.odoKm], [41, 452, 23817]);
    near(t.avgCons.value, 9.8, 'trip average'); assert.strictEqual(t.avgCons.unit, 'l/100 km'); assert.strictEqual(t.units.speed, 'km/h');
    assert.deepStrictEqual([t.powerPct, t.torquePct], [40, 55]);
    near(t.boost, 1.1, 'boost');
    assert.strictEqual(t.mode, 'Sport');
    near(t.ambient, 11.5, 'outside');
    near(t.tyres.fl, 2.5, 'tyre fl'); near(t.tyres.rl, 2.7, 'tyre rl');
    assert.strictEqual(t.tyreTemps.fr, 23);
}

// 2. the driving mode: every way a car says it, and what says nothing
{
    const { t, feed } = fresh();
    const mode = (raw) => { feed(FES, 'statusFESVehicleDynamicSwitchHMI', { actualValueModeDrivingExperience: raw }); return t.mode; };
    assert.strictEqual(mode('COMFORT'), 'Comfort');
    assert.strictEqual(mode(4), 'Comfort');
    assert.strictEqual(mode('5'), 'Comfort plus');
    assert.strictEqual(mode('ADAPTIVE'), 'Adaptive');
    assert.strictEqual(mode(10), 'Adaptive');
    assert.strictEqual(mode('ECO_PRO_EFFICIENT'), 'Eco pro');
    assert.strictEqual(mode('SPORT_EXPERT'), 'Sport plus');
    assert.strictEqual(mode('SPORT_INDIVIDUAL'), 'Sport individual');
    assert.strictEqual(mode('PHEV_HYBRID_ECO'), 'Hybrid eco pro');
    assert.strictEqual(mode(20), 'Electric');
    assert.strictEqual(mode('BOOST'), 'Sport boost');
    assert.strictEqual(mode('TRAFFIC_COMFORT'), 'Traffic comfort');          // another software level: in words
    // initialising / invalid as the car switches off: the last mode stays (as Redline keeps it)
    assert.strictEqual(mode(0), 'Traffic comfort');
    assert.strictEqual(mode(63), 'Traffic comfort');
    assert.strictEqual(mode('INITIALISIERUNG'), 'Traffic comfort');
    assert.strictEqual(mode('SIGNAL_UNGUELTIG'), 'Traffic comfort');
    assert.strictEqual(mode(99), 'Traffic comfort');                         // a number nobody knows
    assert.strictEqual(mode(undefined), 'Traffic comfort');
}

// 3. the other enums: wire numbers, digit strings, unknown names, "no value"
{
    const { t, feed } = fresh();
    feed(V2, 'statusOilDipstick2', { fluidLevelEngineOilRelative: '4' });
    assert.strictEqual(t.oilLevel, '3/4');
    feed(V2, 'statusOilDipstick2', { fluidLevelEngineOilRelative: 15 });
    assert.strictEqual(t.oilLevel, null);
    feed(CDS, 'statusHandBrake', { statusContactHandBrake: 'NICHT_CODIERT' });
    assert.strictEqual(t.handbrake, null);
    feed(CDS, 'statusHandBrake', { statusContactHandBrake: 2 });
    assert.strictEqual(t.handbrake, 'applied');
    feed(CDS, 'statusEngineStatus', { statusEngineRunDrive: '0' });
    assert.strictEqual(t.engine, 'off');
    feed(CDS2, 'statusPushButtonMSA2', { statusFunctionMSA: 1 });
    assert.strictEqual(t.msa, 'on');
    feed(MD, 'statusMSystem', { statusAllWheelSetup: '_4WD_ALTERNATIV' });
    assert.strictEqual(t.awd, '4WD Sport');
    feed(MD, 'statusMSystem', { statusAllWheelSetup: 'SIGNAL_UNBEFUELLT' });
    assert.strictEqual(t.awd, null);
    feed(MD, 'dataDisplayGearbox', { displayProgramGearbox: 'M_MINUS_PROGRAMM' });
    assert.strictEqual(t.programme, 'M (manual)');
    feed(MD, 'dataDisplayGearbox', { displayProgramGearbox: 0 });
    assert.strictEqual(t.programme, 'D');
    feed(KOMBI, 'statusRangeTankStatus', { fluidLevelFuelTank: '38', range: 4095, mileageKilometre: 16777215 });
    assert.deepStrictEqual([t.fuelL, t.rangeKm, t.odoKm], [38, null, undefined]);
    feed(CDS, 'statusBattery2', { conditionBatteryChargingCondition: 255 });
    assert.strictEqual(t.batteryPct, null);
    feed(ENV, 'ExteriorTemperature', { temperatureExterior: 255 });
    assert.strictEqual(t.ambient, null);
}

// 4. tyres in psi: the car's units say so, or the values do (and then deg F)
{
    const { t, feed } = fresh();
    feed(VEH, 'statusNewCurrentUnitsStatusExt', { unitOfMeasurementAirPressure: 3, unitOfMeasurementTemperature: 2 });
    assert.deepStrictEqual([t.units.press, t.units.temp], ['PSI', 'F']);
    feed(TPMS, 'statusTyrePressure', { actualValuePressureTyreFLH: 410, actualValuePressureTyreFRH: 410, actualValuePressureTyreRLH: 420, actualValuePressureTyreRRH: 65535 });
    assert.strictEqual(t.tyres, null);                                          // one corner without a value: none shown
    feed(TPMS, 'statusTyrePressure', { actualValuePressureTyreFLH: 410, actualValuePressureTyreFRH: 410, actualValuePressureTyreRLH: 420, actualValuePressureTyreRRH: 420 });
    near(t.tyres.fl, 41 / 14.5038, 'psi tyre');
    // the sport display's boost in psi too: 0.1 psi a step (idrive7-apps #186)
    feed(FES, 'statusSwitchDriveDynamicSport2', { displayBoostPressure: 200 });
    near(t.boost, 20 / 14.5038, 'psi boost');
    feed(TPMS, 'statusTyreTemperature', { actualValueTemperatureTyreFLH: 122, actualValueTemperatureTyreFRH: 122, actualValueTemperatureTyreRLH: 122, actualValueTemperatureTyreRRH: 122 });
    near(t.tyreTemps.fl, (82 - 32) * 5 / 9, 'deg F tyre');
    const g = fresh();
    g.feed(TPMS, 'statusTyrePressure', { actualValuePressureTyreFLH: 330, actualValuePressureTyreFRH: 330, actualValuePressureTyreRLH: 330, actualValuePressureTyreRRH: 330 });
    near(g.t.tyres.fl, 33 / 14.5038, 'psi told from the value');
}

// 5. service list, its summary and Check Control
{
    const { t, sig, feed } = fresh();
    feed(K2, 'cbsDataServiceList', []);
    assert.deepStrictEqual(t.service, []);                                      // an answer: nothing listed
    feed(K2, 'cbsDataServiceList', [{ cbsData: { cBSIdentifier: 1, cBSColor: 'GREEN', cBSServcieName: 'Motoroel', cBSServiceWay: '12000 km', cBSServiceDate: '05/2027' } },
        { cbsData: { cBSIdentifier: 3, cBSColor: 2, cBSServiceName: 'Brake fluid', cBSServiceDate: '01/2026' } }]);
    assert.deepStrictEqual(t.service.map((i) => [i.name, i.state]), [['Engine oil', 'OK'], ['Brake fluid', 'due soon']]);
    feed(K2, 'cbsDataSBA', { value: { cBSDataSBAText: 'Oil service', cBSDataSBADistance: '12000 km', cBSDataSBADate: '05/2027' } });
    assert.strictEqual(t.serviceNext.text, 'Oil service');
    feed(CC, 'basicList', [{ ccmId: 229, activeState: 'AKTIV' }, { ccmId: 50, activeState: 'INAKTIV' }]);
    assert.deepStrictEqual(t.checkControl, ['Check Control message 229']);
    feed(K2, 'ccList', [{ cCIdentifer: 229, cCShortName: 'Tyre pressure low' }]);
    assert.deepStrictEqual(t.checkControl, ['Tyre pressure low']);
    feed(CC, 'basicList', [{ ccmId: 229, activeState: 1 }]);
    assert.deepStrictEqual(t.checkControl, []);
    sig.reset();
}

// 6. the kit: car.js passes the poll intervals, a watch's shutdown ends its poll timer
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-sig-'));
try {
    const KIT = path.join(ROOT, 'kit', 'runtime');
    const watched = {};
    const Car = require(path.join(KIT, 'car'));
    const ctx = { log: { info() {}, warn() {} }, spec: { config: {} }, settings: { get: () => 'off' },
        signals: { watch: (iface, inst, h, log, opts) => { watched[iface] = { fields: Object.keys(h), opts }; return Promise.resolve({ iface, available: false, shutdown: () => Promise.resolve() }); } } };
    const t = { units: {} };
    const sig = carSignals(t, { log: { info() {} } });
    const car = new Car(ctx, ['rpm', 'speed', 'temps', 'torque'], sig.extra, { poll: sig.poll });
    car.stop();
    assert.deepStrictEqual(watched[TPMS].opts, { pollMs: 10000 });
    assert.deepStrictEqual(watched[KOMBI].opts, { pollMs: 10000 });
    assert.deepStrictEqual(watched[K2].opts, { pollMs: 60000 });
    assert.strictEqual(watched[CDS].opts, undefined);
    assert.ok(watched[FES].fields.indexOf('statusActualValueTorque2') >= 0 && watched[FES].fields.indexOf('statusFESVehicleDynamicSwitchHMI') >= 0, 'one FES proxy for both');

    // signals.js with a stand-in for the native binding: its config dir is ../../someipdefs from the kit
    const kit = path.join(tmp, 'a', 'b', 'kit'), defs = path.join(tmp, 'a', 'someipdefs');
    [path.join(tmp, 'a'), path.join(tmp, 'a', 'b'), kit, defs].forEach((d) => fs.mkdirSync(d));
    fs.copyFileSync(path.join(KIT, 'signals.js'), path.join(kit, 'signals.js'));
    fs.writeFileSync(path.join(defs, 'x_Y.json'), JSON.stringify({ fields: { f: { getter: {} } } }));
    let gets = 0;
    const fake = { buildProxy: () => Promise.resolve({
        init: () => Promise.resolve(), subscribeToAvailability: () => {}, subscribe: () => {}, isAvailable: () => true,
        getValue: () => { gets++; return Promise.resolve({}); }, shutdown: () => {},
    }) };
    const realLoad = Module._load;
    Module._load = function (req) { return req === 'someip' ? fake : realLoad.apply(this, arguments); };
    const signals = require(path.join(kit, 'signals.js'));
    Module._load = realLoad;
    signals.watch('x.Y', '1', { f: () => {} }, null, { pollMs: 20 }).then((res) => {
        setTimeout(() => {
            assert.ok(gets >= 3, 'polled: ' + gets + ' reads');
            res.shutdown().then(() => {
                const at = gets;
                setTimeout(() => {
                    assert.strictEqual(gets, at, 'no reads after shutdown');
                    console.log('test_copilot_signals: all passed');
                    rmTmp();
                }, 100);
            });
        }, 120);
    }).catch((e) => { rmTmp(); throw e; });
} catch (e) { rmTmp(); throw e; }

function rmTmp() {
    (function rm(p) {
        let st;
        try { st = fs.lstatSync(p); } catch (e) { return; }
        if (st.isDirectory()) { fs.readdirSync(p).forEach((f) => rm(path.join(p, f))); fs.rmdirSync(p); } else fs.unlinkSync(p);
    })(tmp);
}
