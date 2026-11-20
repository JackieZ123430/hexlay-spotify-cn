'use strict';
/**
 * test_speed_limit_power.js - what the Speed Limit app does to the head unit over a drive: its wake-ups (every timer
 * it schedules) and subscriptions, from start-up through parked, driving, stopped and parked again. Real time, about
 * 30 s; the built app on the PC stub (kit/tools/hu-stub.js), started as with the car (no screen open).
 *
 *   python3 kit/tools/build.py speed_limit && node kit/tools/test_speed_limit_power.js [dist/speed_limit]
 *
 * Fails when, at start-up, it runs before the power state arrives; when parked it schedules any timer; when driving
 * it wakes more than 3 times a second; when stopped more than once a second; or when parked again anything keeps
 * running.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const stage = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'dist', 'speed_limit'));
const { headUnit } = require('./hu-stub');

// every timer the process schedules from here on (the test's own use the originals)
const real = { setTimeout: global.setTimeout, setInterval: global.setInterval, setImmediate: global.setImmediate };
let count = { timeout: 0, interval: 0, immediate: 0 };
global.setTimeout = function () { count.timeout++; return real.setTimeout.apply(this, arguments); };
global.setInterval = function () { count.interval++; return real.setInterval.apply(this, arguments); };
const wait = (ms) => new Promise((r) => real.setTimeout(r, ms));
const take = () => { const c = count; count = { timeout: 0, interval: 0, immediate: 0 }; return c; };
const total = (c) => c.timeout + c.interval;

const lines = [];
const log = { info: (s) => lines.push(String(s)), warn: (s) => lines.push(String(s)), error: (s) => lines.push(String(s)), debug: () => {} };
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speed_limit_power_'));
const hu = headUnit(stage, { live: true, dataDir, log, fresh: true, sets: { demo: 'off' }, closed: true });
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const said = (re) => lines.some((l) => re.test(l));
const subs = (iface) => ((hu.subs || {})[iface] || []).length;

const V2 = 'de.bmw.infotainment.vehicle.Vehicle2', VC = 'de.bmw.infrastructure.VehicleCondition', NAV = 'de.bmw.infotainment.navigation.positioning.Positioning';
const power = (name) => hu.feed(VC, 'VehicleCondition', { statusConditionVehicle: name });
const speed = (kmh) => hu.feed(V2, 'statusCarSpeed2', { speedVehicleCentreOfGravity: Math.round(kmh / 0.015625) });
// Tbilisi Bypass Road (OSM way 20647951, 90 km/h), driving north-west along it
let lat = 41.782626, lon = 44.961565;
const position = (moveM) => {
    lat += moveM * Math.cos(308 * Math.PI / 180) / 111320;
    lon += moveM * Math.sin(308 * Math.PI / 180) / (111320 * Math.cos(lat * Math.PI / 180));
    hu.feed(NAV, 'currentLocation', { coordinatesValid: true, latitude: lat, longitude: lon, heading: 308, status: 'ON_ROAD' });
};

async function feedFor(ms, kmh) {
    const end = Date.now() + ms;
    while (Date.now() < end) { speed(kmh); position(kmh / 3.6 / 2); await wait(500); }
}

(async () => {
    hu.start();
    await wait(1500);
    take();
    check(!said(/on: matching/) && subs(NAV) === 0, 'start-up: waits for the power state (no map, no position subscription yet)');

    power('WOHNEN');                                     // parked, the head unit on (doors, sitting in it)
    await wait(1000); take();
    await wait(10000);
    let c = take();
    check(!said(/on: matching/) && total(c) === 0, 'parked (WOHNEN), 10 s: idle, ' + total(c) + ' timers scheduled (want 0)');

    power('FAHREN');                                     // drive-ready
    await wait(300);
    check(said(/on: matching/) && subs(NAV) === 1 && subs(V2) === 1, 'drive-ready: matching, position and speed subscribed');
    take();
    await feedFor(6000, 60);
    c = take();
    check(total(c) <= 6 * 3, 'driving 60 km/h, 6 s: ' + total(c) + ' timers (' + (total(c) / 6).toFixed(1) + ' a second; want at most 3)');

    await feedFor(1000, 0); take();
    await feedFor(8000, 0);
    c = take();
    check(total(c) <= 8, 'stopped, 8 s: ' + total(c) + ' timers (' + (total(c) / 8).toFixed(1) + ' a second; want at most 1)');

    power('WOHNEN');
    await wait(1000); take();
    await wait(8000);
    c = take();
    check(said(/car off: idle/) && total(c) === 0, 'parked again, 8 s: idle, ' + total(c) + ' timers (want 0)');

    if (fails) { console.log('\n' + fails + ' failed'); console.log(lines.slice(-15).join('\n')); process.exit(1); }
    console.log('\nok');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
