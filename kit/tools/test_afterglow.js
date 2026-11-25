'use strict';
/**
 * test_afterglow.js - unit checks for the Afterglow theme, scene.js 3D band & soft primitives,
 * Recorder.mesh() GPU/software playback, gauges.js Afterglow chrome, and Spotify art processing.
 */
const assert = require('assert');
const path = require('path');
const { Recorder, OP, play, imageById } = require('../runtime/record');
const { Canvas } = require('../runtime/canvas');
const S = require('../runtime/scene');
const G = require('../runtime/gauges');
const { theme } = require('../runtime/themes');

function countOp(rec, op) {
    const u = rec.words();
    let n = 0, i = 0;
    while (i < u.length) {
        const cur = u[i++];
        if (cur === op) n++;
        switch (cur) {
        case OP.CLEAR: case OP.ALPHA: i += 1; break;
        case OP.RECT: i += 5; break;
        case OP.GRAD: i += 5 + u[i + 4] * 2; break;
        case OP.CARD: i += 6 + u[i + 5] * 2; break;
        case OP.RRECT: case OP.LINE: case OP.IMAGE: i += 6; break;
        case OP.RSTROKE: i += 7; break;
        case OP.RAMPRECT: i += 8; break;
        case OP.QUAD: i += 9; break;
        case OP.ARC: i += 11; break;
        case OP.TRIS: i += 1 + u[i] * 9; break;
        case OP.GLYPHS: i += 3 + u[i + 2] * 8; break;
        case OP.LAYER: case OP.XF: i += 3; break;
        case OP.CLIP: i += 4; break;
        case OP.NOCLIP: break;
        default: return n;
        }
    }
    return n;
}

// 1. Recorder.mesh() + software playback
{
    const r = new Recorder(200, 100);
    r.clear('#0b0c0f');
    r.mesh([10, 10, '#0a9cdb', 190, 10, '#1c8fe0', 100, 90, '#e3242b']);
    assert.strictEqual(countOp(r, OP.TRIS), 1, 'mesh emits one TRIS op');
    const cv = new Canvas(200, 100);
    play(r.words(), cv);
    // centre of the triangle should be painted (not background #0b0c0f)
    const idx = (40 * 200 + 100) * 4;
    assert(cv.d[idx] !== 11 || cv.d[idx + 1] !== 12 || cv.d[idx + 2] !== 15, 'software play renders mesh triangle');
    console.log('ok   Recorder.mesh records TRIS and plays back in software');
}

// 2. scene.js GPU vs software fallback (softEllipse skipped when cv.place === null)
{
    const t = theme('afterglow');
    const gpu = new Recorder(800, 400);
    gpu.place = { scale: 1 };
    S.softEllipse(gpu, 400, 200, 200, 100, S.M2, 0.4);
    assert.strictEqual(countOp(gpu, OP.TRIS), 1, 'GPU softEllipse emits TRIS mesh');

    const soft = new Recorder(800, 400);
    soft.place = null;
    S.softEllipse(soft, 400, 200, 200, 100, S.M2, 0.4);
    S.softRect(soft, 50, 50, 100, 100, 20, '#000000', 0.6);
    assert.strictEqual(countOp(soft, OP.TRIS), 0, 'software path skips heavy softEllipse/softRect meshes');
    console.log('ok   scene.js soft shapes draw on GPU and skip on software fallback');
}

// 3. scene.js 3D extruded band (GPU emits shadow + pool + top + front + end-cap + glow + beacon)
{
    const t = theme('afterglow');
    const samples = [];
    for (let i = 0; i <= 30; i++) samples.push({ t: 1 - i / 30, v: 65 + i * 1.4 });
    const r = new Recorder(1600, 520);
    r.place = { scale: 1 };
    S.band(r, t, {
        x: 700, y: 200, w: 860, h: 300, min: 50, max: 135, samples,
        limit: 120, limitText: 'Limit 120 °C',
        marks: [[0, 'now'], [1 / 3, '-5 min'], [2 / 3, '-10 min'], [1, '-15 min']],
    });
    const trisOps = countOp(r, OP.TRIS);
    // shadow + pool + topMesh + frontMesh + endCap + edgeGlow + beaconGlow = 7 TRIS ops
    assert(trisOps >= 6, '3D extruded band emits top face, front face, shadow, glow and beacon (got ' + trisOps + ')');
    // Also verify software fallback plays without error
    const soft = new Recorder(1600, 520);
    soft.place = null;
    S.band(soft, theme('amber'), { x: 700, y: 200, w: 860, h: 300, min: 50, max: 135, samples, limit: 120, limitText: 'Limit 120 °C' });
    const cv = new Canvas(1600, 520);
    play(soft.words(), cv);
    console.log('ok   scene.js 3D extruded band renders on GPU and plays back cleanly in software');
}

// 4. gauges.js Afterglow header & panel chrome (mixed case + M badge, fits within width)
{
    const ag = theme('afterglow');
    const r = new Recorder(1920, 80);
    const end = G.header(r, ag, 84, 0, 1256, 80, 'Spotify', ['Playlists', 'Liked Songs', 'Now Playing', 'Connect', 'Settings'], 2, [], true, true, 1.35);
    assert(end <= 1340, 'Afterglow header fits before HMI status strip (end=' + end + ')');
    assert.strictEqual(r.tabRects.length, 5, 'all 5 Spotify tabs fit in compact Afterglow header');
    assert(countOp(r, OP.QUAD) >= 3, 'Afterglow header draws the 3-stripe M badge');

    const r2 = new Recorder(1920, 80);
    const end2 = G.header(r2, ag, 84, 0, 1256, 80, 'M-Copilot', ['Answer', 'Topics', 'Data check', 'Connect', 'Settings'], 0, [], true, true, 1.35);
    assert(end2 <= 1340, 'M-Copilot header fits before HMI status strip (end=' + end2 + ')');
    assert.strictEqual(r2.tabRects.length, 5, 'all 5 M-Copilot tabs fit in compact Afterglow header');
    console.log('ok   gauges.js Afterglow header fits title, M badge and all 5 tabs before status strip');
}

// 5. Spotify art.js demo procedural covers, shrink, blur, full-bleed RGBA (no jagged corner holes)
{
    // art.js requires ./kit/record and ./kit/tls_dates (built tree layout); test with a tiny Module._resolveFilename hook
    const Module = require('module');
    const origResolve = Module._resolveFilename;
    const runtimeDir = path.resolve(__dirname, '../runtime');
    Module._resolveFilename = function (req, parent, isMain, opts) {
        if (req.startsWith('./kit/')) return origResolve.call(this, path.join(runtimeDir, req.slice(6)), parent, isMain, opts);
        return origResolve.call(this, req, parent, isMain, opts);
    };
    let art;
    try {
        art = require('../../apps/spotify/art');
    } finally {
        Module._resolveFilename = origResolve;
    }
    const cov = art.makeDemoCover('t1');
    assert.strictEqual(cov.width, 128);
    assert.strictEqual(cov.height, 128);
    assert.strictEqual(cov.data[3], 255, 'cover corner pixel stays opaque (GPU SDF rounds corners cleanly)');
    const shrunk = art.shrink(cov, 32, 0.5);
    assert.strictEqual(shrunk.length, 32 * 32 * 4);
    art.blur(shrunk, 32, 3);

    const mgr = new art.AlbumArtManager({ warn: () => {}, info: () => {} });
    mgr.load('demo:t1');
    assert.strictEqual(mgr.hasArt, true, 'demo cover loads synchronously');
    assert(imageById.get(art.ART_IMG_ID), 'ART_IMG_ID registered');
    assert(imageById.get(art.ART_GROUND_ID), 'ART_GROUND_ID registered');
    mgr.loadQueue(['demo:t2', 'demo:t3', 'demo:t4', 'demo:t5']);
    for (let k = 0; k < 4; k++) {
        assert.strictEqual(mgr.hasQueueArt(k), true, 'queue slot ' + k + ' loaded');
        assert(imageById.get(art.ART_QUEUE_ID + k), 'ART_QUEUE_ID+' + k + ' registered');
    }
    mgr.loadThumbs(['demo:t1', 'demo:t8', 'demo:t13']);
    assert(mgr.thumbId('demo:t1') >= art.ART_THUMB_ID, 'thumb slot allocated for demo:t1');
    assert(imageById.get(mgr.thumbId('demo:t1')), '64x64 thumbnail registered');
    assert(mgr.thumbSig() >= 3, 'thumbSig increments as thumbnails load');
    console.log('ok   Spotify art.js procedural covers, shrink/blur, depth queue and LRU thumbnails');
}

// 6. sheet.js inline segmented choices & numeric steppers
{
    const { listSheet } = require('../runtime/sheet');
    const state = { screen: 'auto', pollRate: 2 };
    const fakeSettings = {
        schema: [
            { key: 'screen', label: 'Screen size', type: 'choice', default: 'auto', options: [['auto', 'Automatic'], ['10.25', '10.25-inch'], ['12.3', '12.3-inch'], ['8.8', '8.8-inch']] },
            { key: 'pollRate', label: 'Sync rate', type: 'number', unit: 's', default: 2, steps: [1, 2, 3, 5] },
        ],
        get: (k) => state[k],
        set: (k, v) => { state[k] = v; },
        display: (k) => (k === 'pollRate' ? state[k] + ' s' : state[k]),
        cycle: (k) => { state[k] = k === 'screen' ? '10.25' : 3; },
    };
    const sh = listSheet(fakeSettings, 'Settings', { version: '1.0.33' });
    const r = new Recorder(1600, 520);
    const targets = sh.draw(r, theme('afterglow'));
    // Done (1) + 4 inline screen segments + 2 inline stepper buttons = 7 targets
    assert.strictEqual(targets.length, 7, 'inline segmented & stepper settings emit direct touch targets (got ' + targets.length + ')');
    targets[4].act(); // pick 4th segment ('8.8')
    assert.strictEqual(state.screen, '8.8', 'tapping inline segment sets choice immediately');
    targets[6].act(); // step '+' on pollRate (2 -> 3)
    assert.strictEqual(state.pollRate, 3, 'tapping inline + stepper advances numeric setting');
    console.log('ok   sheet.js inline segmented choices and numeric steppers work in one tap');
}

// 7. diag.js hard read-only UDS guard (blocks clear/write/session/reset before TASU)
{
    const { Diag, assertReadOnly, ALL } = require('../runtime/diag');
    // Allowed strictly read-only requests
    assertReadOnly(0x12, 0x22, [0xF1, 0x50]);
    assertReadOnly(0x12, 0x22, [0x58, 0x0B]);
    assertReadOnly(ALL, 0x19, [0x02, 0x0C]);
    assertReadOnly(ALL, 0x22, [0xF1, 0x50]);
    assertReadOnly(0x12, 0x01, [0x0F]);
    assertReadOnly(0x12, 0x06, [0xA2]);
    // Blocked write / clear / session / reset / routine / security / functional-non-read
    const blocked = [
        [ALL, 0x14, [0xFF, 0xFF, 0xFF]],   // ClearDTC (functional)
        [0x12, 0x14, [0xFF, 0xFF, 0xFF]],  // ClearDTC (physical)
        [0x12, 0x10, [0x03]],              // DiagnosticSessionControl
        [0x12, 0x11, [0x01]],              // ECUReset
        [0x12, 0x27, [0x01]],              // SecurityAccess
        [0x12, 0x2E, [0xF1, 0x90, 0x00]],  // WriteDataByIdentifier
        [0x12, 0x2F, [0x60, 0xFD, 0x03]],  // IOControl
        [0x12, 0x31, [0x01, 0x02, 0x03]],  // RoutineControl
        [ALL, 0x19, [0x04, 0x00]],         // 0x19 non-02 sub-function
        [ALL, 0x22, [0x58, 0x0B]],         // functional 0x22 other than F1 50
    ];
    blocked.forEach(([t2, sid, d]) => {
        assert.throws(() => assertReadOnly(t2, sid, d), /read-only/, 'must block 0x' + sid.toString(16));
    });
    // Verify Diag.send with readOnly=true never invokes signals.call on a blocked SID
    let called = 0;
    const fakeSig = { call: () => { called++; return Promise.resolve('NO_ERROR'); } };
    const d = new Diag(fakeSig, { info() {}, warn() {} });
    d.p = {};
    d.readOnly = true;
    d.send(ALL, 0x14, [0xFF, 0xFF, 0xFF]).then(() => { throw new Error('should have rejected'); }, (err) => {
        assert(/read-only/.test(err.message));
        assert.strictEqual(called, 0, 'TASU must never be called for blocked write/clear');
    });
    console.log('ok   diag.js hard read-only guard blocks all write/clear/session/reset UDS services');
}

console.log('all Afterglow checks passed');
