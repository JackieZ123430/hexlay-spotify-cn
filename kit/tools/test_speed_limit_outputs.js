'use strict';
/**
 * test_speed_limit_outputs.js - the Speed Limit app's cluster-render side against a fake service (no car).
 *
 *   node kit/tools/test_speed_limit_outputs.js [dist/speed_limit]
 *
 * Runs the app's outputs.js (from the sources with the kit beside them, as build.py lays them out; or a built
 * stage) against a socket that speaks cluster-render's
 * protocol 1 (PROTOCOL.md): hello, then the layers, frames, sets, drops and status requests it gets. Checks:
 * the HUD layer and its pixels; no map layer while no other app shows the map; the map layer once the status lists
 * another app's shown layer on "map", hidden when it goes; nothing shown without a limit; the connection closed on
 * stop() (cluster-render removes a client's layers with its connection).
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// the app's modules beside the kit, as build.py lays them out (no build, no SDK: CI); or a built stage's
function assemble() {
    const root = path.join(__dirname, '..', '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speed_limit_'));
    const copy = (from, to) => {
        if (fs.statSync(from).isDirectory()) { fs.mkdirSync(to); fs.readdirSync(from).forEach((f) => { if (f !== 'locales') copy(path.join(from, f), path.join(to, f)); }); } else fs.writeFileSync(to, fs.readFileSync(from));
    };
    fs.readdirSync(path.join(root, 'apps', 'speed_limit')).filter((f) => /\.js$/.test(f)).forEach((f) => copy(path.join(root, 'apps', 'speed_limit', f), path.join(dir, f)));
    copy(path.join(root, 'kit', 'runtime'), path.join(dir, 'kit'));
    return dir;
}
const js = process.argv[2] ? path.join(path.resolve(process.argv[2]), 'source', 'javascript') : assemble();
const { Outputs } = require(path.join(js, 'outputs'));
const sock = process.platform === 'win32' ? '\\\\.\\pipe\\speed_limit_test_' + process.pid : path.join(os.tmpdir(), 'speed_limit_test_' + process.pid + '.sock');

const got = [];                 // messages the app sent: { t: 'J', m } or { t: 'F', ref, bytes }
let statusText = 'upload: cap 4000 KB/s\n';
let client = null, closed = false;
const server = net.createServer((s) => {
    client = s;
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 5) {
            const n = buf.readUInt32LE(0);
            if (buf.length < 4 + n) break;
            const type = buf[4], body = buf.slice(5, 4 + n);
            buf = buf.slice(4 + n);
            if (type === 0x4A) {
                const m = JSON.parse(body.toString('utf8'));
                got.push({ t: 'J', m });
                if (m.op === 'hello') send(s, { ev: 'hello', proto: 1, backend: 'id7', targets: 'map:1088x480,panel:1920x720,hud:800x480' });
                if (m.op === 'status') send(s, { ev: 'status', text: statusText });
            } else if (type === 0x46) got.push({ t: 'F', ref: body.readUInt32LE(0), bytes: body.length - 14 });
        }
    });
    s.on('close', () => { closed = true; });
    s.on('error', () => {});
});
function send(s, obj) {
    const j = Buffer.from(JSON.stringify(obj)), h = Buffer.alloc(5);
    h.writeUInt32LE(j.length + 1, 0); h[4] = 0x4A;
    s.write(Buffer.concat([h, j]));
}

const settings = { v: { show: 'both', hudSize: 88, hudX: 0, hudY: 0, clusterSize: 110, clusterX: 0, clusterY: 0 }, get(k) { return this.v[k]; } };
const log = { info() {}, warn() {}, error() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
function check(ok, what) { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; }
const ops = (op) => got.filter((g) => g.t === 'J' && g.m.op === op).map((g) => g.m);

(async () => {
    if (process.platform !== 'win32') { try { fs.unlinkSync(sock); } catch (e) { /* none */ } }
    await new Promise((r) => server.listen(sock, r));
    const out = new Outputs('speed_limit', log, settings, { cr: { path: sock, check: false } }).start();
    await wait(300);
    check(ops('hello').length === 1 && ops('hello')[0].app === 'speed_limit', 'hello as speed_limit');

    out.update({ limit: 60, inferred: false, over: false }, Date.now());
    await wait(200);
    const hud = ops('layer').filter((m) => m.target === 'hud');
    check(hud.length === 1 && hud[0].kind === 'image' && hud[0].class === 'overlay' && hud[0].w === 88 && hud[0].iw === 88, 'HUD layer: an 88 px image, class overlay');
    const hx = hud[0] || {};
    check(hx.x >= 0 && hx.x + 88 <= 800 && hx.y >= 0 && hx.y + 88 <= 480, 'HUD layer inside the 800x480 target (' + hx.x + ',' + hx.y + ')');
    check(got.some((g) => g.t === 'F' && g.ref === hx.ref && g.bytes === 88 * 88 * 4), 'HUD pixels sent whole (88x88 RGBA)');
    check(ops('layer').filter((m) => m.target === 'map').length === 0, 'no map layer while no other app shows the map');

    const framesBefore = got.filter((g) => g.t === 'F').length;
    out.update({ limit: 60, inferred: false, over: false }, Date.now());
    await wait(100);
    check(got.filter((g) => g.t === 'F').length === framesBefore, 'the same sign is not sent again');

    // Maps on cluster shows its picture on "map": the sign joins it
    statusText = 'upload: cap 4000 KB/s\ntarget map: slot 0x100 scene 0x10004f0 1088x480: shown\nlayer 4 video of robertn_waze_cluster on map, content z 0: shown\n';
    out.tick(Date.now());
    await wait(200);
    const map = ops('layer').filter((m) => m.target === 'map');
    check(map.length === 1 && map[0].w === 110 && out.diag().mapBusyBy === 'robertn_waze_cluster', 'map layer once robertn_waze_cluster shows the map');

    // over the limit: new pixels (red sign)
    const f0 = got.filter((g) => g.t === 'F').length;
    out.update({ limit: 60, inferred: false, over: true }, Date.now());
    await wait(150);
    check(got.filter((g) => g.t === 'F').length === f0 + 2, 'over the limit: both signs drawn again');

    // the phone map goes (its video stalls): the sign leaves the map
    statusText = 'layer 4 video of robertn_waze_cluster on map, content z 0: stalled - no frames\nlayer 1 image of speed_limit on map, overlay z 20: shown\n';
    out.tick(Date.now() + 4000);
    await wait(200);
    const mref = map[0] && map[0].ref;
    check(ops('set').some((m) => m.ref === mref && m.visible === 0), 'map layer hidden when the phone map goes (its own layer does not count)');

    // no limit: the HUD layer is hidden too
    out.update(null, Date.now());
    await wait(100);
    check(ops('set').some((m) => m.ref === hx.ref && m.visible === 0), 'no limit: HUD layer hidden');

    // settings: kept over BMW's pop-ups; the HUD sign moved; then "cluster": the HUD sign hidden
    settings.v.hudKeep = true;
    out.update({ limit: 90, inferred: true, over: false }, Date.now());
    await wait(100);
    check(ops('set').some((m) => m.ref === hx.ref && m.yield === 0), "kept over BMW's pop-ups: yield 0");
    settings.v.hudX = 40;
    out.update({ limit: 90, inferred: true, over: false }, Date.now());
    await wait(100);
    check(ops('set').some((m) => m.ref === hx.ref && m.x === hx.x + 40), 'HUD sign moved by the setting');
    const hiddenBefore = ops('set').filter((m) => m.ref === hx.ref && m.visible === 0).length;
    settings.v.show = 'cluster';
    out.update({ limit: 90, inferred: true, over: false }, Date.now());
    await wait(100);
    check(ops('set').filter((m) => m.ref === hx.ref && m.visible === 0).length === hiddenBefore + 1, '"Cluster": HUD sign hidden');

    // never the panel (the whole-cluster slot BMW's trip and board computer content uses)
    check(!ops('layer').some((m) => m.target === 'panel'), 'nothing on the panel target (BMW\'s trip info keeps its slot)');

    // a speed camera ahead: the pill joined to the sign, a wider picture; resent only when the distance step changes
    settings.v.show = 'both';
    out.update({ limit: 60, inferred: false, over: false, camera: '350 m' }, Date.now());
    await wait(150);
    const camL = ops('layer').filter((m) => m.target === 'hud').slice(-1)[0];
    const camF = got.filter((g) => g.t === 'F' && g.ref === camL.ref);
    check(camL.w > camL.h && camL.iw === camL.w && camF.length === 1 && camF[0].bytes === camL.w * camL.h * 4, 'camera ahead: the sign with its pill (' + camL.w + 'x' + camL.h + ')');
    out.update({ limit: 60, inferred: false, over: false, camera: '350 m' }, Date.now());
    out.update({ limit: 60, inferred: false, over: false, camera: '300 m' }, Date.now());
    await wait(150);
    check(got.filter((g) => g.t === 'F' && g.ref === camL.ref).length === 2 && ops('layer').filter((m) => m.target === 'hud').slice(-1)[0].ref === camL.ref,
        'the distance counts down: the same layer, pixels only for the new step');
    out.update({ limit: 60, inferred: false, over: false }, Date.now());
    await wait(150);
    const back = ops('layer').filter((m) => m.target === 'hud').slice(-1)[0];
    check(back.ref !== camL.ref && back.w === back.h, 'camera passed: the sign alone again');

    // "Show ---" (no limit known): the dash sign on the HUD again
    settings.v.show = 'both';
    const hl = ops('layer').filter((m) => m.target === 'hud').slice(-1)[0];      // (the HUD layer now)
    const framesNow = got.filter((g) => g.t === 'F' && g.ref === hl.ref).length;
    out.update({ limit: null, unknown: true, inferred: false, over: false }, Date.now());
    await wait(150);
    check(got.filter((g) => g.t === 'F' && g.ref === hl.ref).length === framesNow + 1, '"---" (no limit known): HUD sign shown, its pixels sent once');
    out.update({ limit: null, unknown: true, inferred: false, over: false }, Date.now());
    await wait(100);
    check(got.filter((g) => g.t === 'F' && g.ref === hl.ref).length === framesNow + 1, '"---" again: nothing sent again');

    out.stop();
    await wait(200);
    // (cluster-render removes a client's layers with its connection: the close is what gives the HUD and map back)
    check(closed && out.diag().hud === 'none' && out.diag().map === 'none', 'stop(): connection closed, no layers kept');
    server.close();
    if (fails) { console.log('\n' + fails + ' failed'); process.exit(1); }
    console.log('\nok');
})().catch((e) => { console.error(e); process.exit(1); });
