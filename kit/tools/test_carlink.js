'use strict';

// The phone <-> car link end to end, without network, phone or car: the real page library
// (docs/carlink.js, WebCrypto) against the real car modules (kit/runtime/link_crypto.js,
// apps/*/cloud_pair.js). Checks that:
//   - each side opens what the other sealed, and nothing else (tampering, plaintext, its own
//     messages, another car's key, re-posted or repeated messages);
//   - only this site's own pairing links are accepted;
//   - the pairing managers act only on authentic, fresh messages;
//   - the relay's daily quota is said as it is, and the car's hello fits one relay message.
//   node kit/tools/test_carlink.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');

// the apps require './kit/<x>' (copied from kit/runtime by the build) (tls_dates among them)
const requests = [];          // every HTTPS request the car modules make
const fakeTls = {
    request(opts, cb) { return fakeRequest(opts, cb); },
    get(opts, cb) { const r = fakeRequest(Object.assign({ method: 'GET' }, opts), cb); r.end(); return r; },
};
let respond = () => ({ status: 201, date: null });
function fakeRequest(opts, cb) {
    const chunks = [];
    const handlers = {};
    const req = {
        on(ev, fn) { handlers[ev] = fn; return req; },
        write(b) { chunks.push(Buffer.from(b)); },
        end(b) {
            if (b) chunks.push(Buffer.from(b));
            const entry = { opts, body: Buffer.concat(chunks) };
            requests.push(entry);
            setImmediate(() => {
                const r = respond(entry);
                cb({ statusCode: r.status, headers: r.date ? { date: new Date(r.date).toUTCString() } : {}, resume() {}, on(ev, fn) { if (ev === 'end') setImmediate(fn); } });
            });
        },
        destroy() {},
    };
    return req;
}
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.indexOf(path.join(ROOT, 'apps')) === 0) {
        if (request === './kit/tls_dates') return 'fake-tls';
        const m = /^\.\/kit\/(.+)$/.exec(request);
        if (m) return origResolve.call(this, path.join(ROOT, 'kit', 'runtime', m[1]), parent, ...rest);
    }
    // the shared pairing channel (kit/runtime/cloud_pair.js) posts to the relay through it too
    if (request === './tls_dates' && parent && parent.filename === path.join(ROOT, 'kit', 'runtime', 'cloud_pair.js')) return 'fake-tls';
    return origResolve.call(this, request, parent, ...rest);
};
require.cache['fake-tls'] = { id: 'fake-tls', filename: 'fake-tls', loaded: true, exports: fakeTls };

const link = require('../runtime/link_crypto');
const { RelayStream } = require('../runtime/relay_stream');
const { EventEmitter } = require('events');
const CopilotPair = require('../../apps/m_copilot/cloud_pair').CloudPairManager;
const SpotifyPair = require('../../apps/spotify/cloud_pair').CloudPairManager;

const quiet = { info() {}, warn() {}, error() {} };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carlink-test-'));

/** docs/carlink.js in a sandbox with the browser parts it needs (no IndexedDB: its memory store). */
function loadPage(href) {
    const win = {
        crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, atob, btoa, setTimeout, clearTimeout,
        location: new URL(href), history: { state: null, replaceState(st, t, u) { win.location = new URL(u, win.location.href); } },
        localStorage: memStorage(), sessionStorage: memStorage(), navigator: { userAgent: 'test', platform: 'test' },
        document: { title: '', currentScript: { src: new URL('carlink.js', href).href }, documentElement: { style: {} } },
        fetch: async (url, init) => { win.posts.push({ url, init }); return { ok: true, text: async () => '' }; },
        posts: [],
    };
    win.window = win;
    win.top = win;
    win.self = win;
    const ctx = vm.createContext(win);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs', 'carlink.js'), 'utf8'), ctx, { filename: 'carlink.js' });
    return win;
}
function memStorage() {
    const m = new Map();
    return { get length() { return m.size; }, key: (i) => Array.from(m.keys())[i], getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const nowSec = () => Math.floor(Date.now() / 1000);
const item = (wire, t) => ({ event: 'message', time: t === undefined ? nowSec() : t, message: JSON.stringify(wire) });

async function main() {
    const key = link.nonce(32);
    const chC = 'bmw_copilot_' + link.nonce(12), chS = 'bmw_spot_' + link.nonce(12);
    const page = loadPage('https://hexlay.github.io/idrive7-custom-apps/copilot.html?channel=' + chC + '#k=' + key);
    const CL = page.CarLink;

    // ---- the key leaves the address bar; non-extractable keys stay ----
    const car = await CL.carFromAddress('copilot', chC);
    assert(car && car.app === 'copilot', 'car from the QR link');
    assert.strictEqual(page.location.hash, '', '#k= removed from the address');
    assert.strictEqual(car.toCar.extractable, false, 'phone->car key not extractable');
    assert.strictEqual(car.fromCar.extractable, false, 'car->phone key not extractable');
    assert.strictEqual(await CL.carFromAddress('copilot', 'bmw_copilot_xyz'), null, 'a malformed channel is no car');

    // ---- phone -> car ----
    await CL.sendToCar(car, { type: 'copilot_profile', profile: { model: 'test' } });
    const wire = JSON.parse(page.posts.pop().init.body);
    assert.strictEqual(wire.type, 'copilot_encrypted');
    assert(!JSON.stringify(wire).includes('test'), 'nothing readable on the channel');
    const inner = link.openFromPhone(key, wire);
    assert.strictEqual(inner.profile.model, 'test', 'the car opens what the phone sealed');
    assert(typeof inner.time === 'number' && /^[0-9a-f]{16}$/.test(inner.n), 'send time and nonce inside');
    assert.strictEqual(link.openFromPhone(link.nonce(32), wire), null, 'another key opens nothing');
    const bad = Object.assign({}, wire, { data: wire.data.slice(0, -2) + (wire.data.slice(-2) === '00' ? '01' : '00') });
    assert.strictEqual(link.openFromPhone(key, bad), null, 'tampered data fails');
    assert.strictEqual(link.openFromPhone(key, Object.assign({}, wire, { tag: wire.tag.slice(0, 16) })), null, 'a truncated tag fails');

    // ---- freshness ----
    const fr = new link.Freshness();
    assert(fr.accept(inner, wire, nowSec()), 'fresh message accepted');
    assert(!fr.accept(inner, wire, nowSec()), 'the same message again is dropped');
    assert(!new link.Freshness().accept(inner, wire, nowSec() + 20 * 60), 'a re-post 20 min later is dropped');
    assert(!new link.Freshness().accept({}, wire, nowSec()), 'no send time: dropped');

    // ---- car -> phone ----
    const out = link.sealForPhone(key, 'copilot_car', { type: 'car_hello', vapid: 'x' });
    const got = await CL.openFromCar(car, item(out));
    assert(got && got.type === 'car_hello', 'the phone opens what the car sealed');
    assert.strictEqual(await CL.openFromCar(car, item(out)), null, 'the same car message twice: dropped');
    const out2 = link.sealForPhone(key, 'copilot_car', { type: 'unpaired' });
    assert.strictEqual(await CL.openFromCar(car, item(out2, nowSec() + 3600)), null, 'an old car message re-posted: dropped');
    assert.strictEqual(link.openFromPhone(key, out), null, 'the car can\'t be fooled by its own message (other key)');
    assert.strictEqual(await CL.openFromCar(car, item({ type: 'copilot_pair_ack', carId: 'X' })), null, 'plaintext from the channel: ignored');
    assert.strictEqual(await CL.openFromCar(car, item(link.sealForPhone(link.nonce(32), 'copilot_car', { type: 'unpaired' }))), null, 'another car\'s key: ignored');
    assert.strictEqual(await CL.openFromCar(car, item(link.sealForPhone(key, 'spotify_car', { type: 'unpaired' }))), null, 'another app\'s message: ignored');

    // ---- pairing links ----
    const ok = CL.parsePairingLink('https://hexlay.github.io/idrive7-custom-apps/copilot.html?channel=' + chC + '#k=' + key);
    assert(ok && ok.app === 'copilot' && ok.key === key, 'our own link');
    assert(CL.parsePairingLink('https://hexlay.github.io/idrive7-custom-apps/pair.html?channel=' + chS + '&client_id=abc#k=' + key), 'the Spotify link');
    [
        'https://evil.example/idrive7-custom-apps/copilot.html?channel=' + chC + '#k=' + key,
        'http://hexlay.github.io/idrive7-custom-apps/copilot.html?channel=' + chC + '#k=' + key,
        'https://hexlay.github.io/other/copilot.html?channel=' + chC + '#k=' + key,
        'https://hexlay.github.io/idrive7-custom-apps/pair.html?channel=' + chC + '#k=' + key,
        'https://hexlay.github.io/idrive7-custom-apps/copilot.html?channel=' + chC + '#k=' + key.slice(2),
        'https://hexlay.github.io/idrive7-custom-apps/copilot.html?channel=' + chC + 'x#k=' + key,
        'javascript:alert(1)//?channel=' + chC + '#k=' + key,
    ].forEach((u) => assert.strictEqual(CL.parsePairingLink(u), null, 'refused: ' + u.slice(0, 60)));

    // ---- legacy plain-text keys move into the key store and are wiped ----
    const page2 = loadPage('https://hexlay.github.io/idrive7-custom-apps/pair.html');
    page2.localStorage.setItem('bmw_spot_k_' + chS, key);
    page2.sessionStorage.setItem('copilot_k_' + chC, key);
    await page2.CarLink.migrateLegacy();
    assert.strictEqual(page2.localStorage.length + page2.sessionStorage.length, 0, 'plain-text keys wiped');
    assert.strictEqual((await page2.CarLink.listCars()).length, 2, 'both cars kept');

    // ---- a send is a plain POST: no custom header, so no CORS preflight ----
    await CL.sendToCar(car, { type: 'hello_request' });
    const plain = page.posts.pop();
    assert(!plain.init.headers, 'no headers (a header would make Safari send a preflight first)');

    // ---- new cars wait for proof of a connection before they show in My cars ----
    const chP = 'bmw_spot_' + link.nonce(12);
    await CL.saveCar(chP, link.nonce(32));
    assert(!(await CL.listCars()).some((c) => c.channel === chP), 'a scanned but unconnected car is not listed');
    assert((await CL.listCars({ all: true })).some((c) => c.channel === chP && c.pending), 'it is kept as pending');
    await CL.confirmCar(chP);
    assert((await CL.listCars()).some((c) => c.channel === chP), 'listed once confirmed');
    await CL.saveCar(chP, link.nonce(32));
    assert((await CL.listCars()).some((c) => c.channel === chP), 'scanning a confirmed car again keeps it confirmed');
    await CL.forgetCar(chP);

    // ---- the relay briefly unreachable: tried again, then a clear failure ----
    const realFetch = page.fetch;
    let calls = 0;
    page.fetch = async () => { calls++; if (calls < 3) throw new TypeError('Load failed'); return { ok: true }; };
    assert.strictEqual(await CL.sendToCar(car, { type: 'copilot_profile', profile: {} }), true, 'two network errors, then sent');
    assert.strictEqual(calls, 3);
    calls = 0;
    page.fetch = async () => { calls++; return { ok: false, status: 400 }; };
    assert.strictEqual(await CL.sendToCar(car, { type: 'copilot_profile', profile: {} }), false, 'refused by the relay: not retried');
    assert.strictEqual(calls, 1);
    calls = 0;
    page.fetch = async () => { calls++; throw new TypeError('Load failed'); };
    assert.strictEqual(await CL.sendToCar(car, { type: 'copilot_profile', profile: {} }), false, 'still down after 3 tries: false, no throw');
    assert.strictEqual(calls, 3);
    assert(/ntfy\.sh/.test(CL.RELAY_DOWN) && /3 tries/.test(CL.RELAY_DOWN), 'the message names the relay');
    // the daily message quota: not tried again, and said as it is (with the reset time when known)
    calls = 0;
    const quota = { code: 42908, http: 429, error: 'limit reached: daily message quota reached; increase your limits with a paid plan, see https://ntfy.sh' };
    const resetAt = Math.floor(Date.now() / 1000) + 3600;
    page.fetch = async (url) => {
        if (/\/v1\/account$/.test(url)) return { ok: true, json: async () => ({ stats: { messages_remaining: 0, reset_at: resetAt } }) };
        calls++;
        return { ok: false, status: 429, json: async () => quota };
    };
    assert.strictEqual(await CL.sendToCar(car, { type: 'copilot_profile', profile: {} }), false, 'daily quota: false');
    assert.strictEqual(calls, 1, 'daily quota: not tried again');
    assert(/daily limit/.test(CL.RELAY_DOWN) && /mobile data/.test(CL.RELAY_DOWN) && /resets at /.test(CL.RELAY_DOWN), 'daily quota: said as it is');
    // the short burst limit (another 429) is still tried again
    calls = 0;
    page.fetch = async () => { calls++; if (calls < 2) return { ok: false, status: 429, json: async () => ({ code: 42901, error: 'limit reached: too many requests' }) }; return { ok: true }; };
    assert.strictEqual(await CL.sendToCar(car, { type: 'copilot_profile', profile: {} }), true, 'burst limit: tried again, then sent');
    assert.strictEqual(calls, 2);
    page.fetch = realFetch;

    // ---- forgetting a car: only this phone, or disconnecting the car too ----
    const chF = 'bmw_copilot_' + link.nonce(12), keyF = link.nonce(32);
    const carF = await CL.saveCar(chF, keyF);
    ['copilot_paired_', 'copilot_profile_', 'copilot_provider_'].forEach((p) => page.localStorage.setItem(p + chF, 'x'));
    page.localStorage.setItem('copilot_model_' + chF + '_gemini', 'x');
    page.localStorage.setItem('copilot_paired_' + chC, 'true');
    page.posts.length = 0;
    await CL.forget(carF, false);
    assert.strictEqual(page.posts.length, 0, 'only this phone: nothing sent to the car');
    assert.strictEqual(await CL.getCar(chF), null, 'the key is gone');
    assert(!Array.from({ length: page.localStorage.length }, (_, i) => page.localStorage.key(i)).some((k) => k.indexOf(chF) >= 0), 'what the pages kept about it is gone');
    assert.strictEqual(page.localStorage.getItem('copilot_paired_' + chC), 'true', 'other cars untouched');
    const carF2 = await CL.saveCar(chF, keyF);
    const r = await CL.forget(carF2, true);
    const unpair = link.openFromPhone(keyF, JSON.parse(page.posts.pop().init.body));
    assert(r.told && unpair && unpair.type === 'phone_unpair', 'forget & disconnect sends the car an authentic unpair');
    assert.strictEqual(await CL.getCar(chF), null, 'and forgets the key');

    // ---- M-Copilot's pairing manager ----
    const ai = { config: { channel: chC, secretKey: key, paired: true }, saveConfig() {}, isConfigured: () => true, saveCredentials(p) { ai.saved = p; } };
    const cp = new CopilotPair({ log: quiet }, ai);
    assert.strictEqual(cp.channel, chC, 'saved pairing kept');
    let hellos = 0;
    cp.onHelloRequest = () => { hellos++; };
    const send = async (obj, t) => { await CL.sendToCar(car, obj); const w = page.posts.pop().init.body; cp.handleIncomingMessage(w, false, t === undefined ? nowSec() : t); return w; };
    const w1 = await send({ type: 'hello_request' });
    assert.strictEqual(hellos, 1, 'hello_request reaches the car app');
    cp.handleIncomingMessage(w1, false, nowSec());
    assert.strictEqual(hellos, 1, 'the same message again: dropped');
    await send({ type: 'hello_request' }, nowSec() - 3600);
    assert.strictEqual(hellos, 1, 'a re-post an hour late: dropped');
    await send({ type: 'push_subscribe', sub: {} });
    assert.strictEqual(hellos, 1, 'an older page\'s notification set-up: ignored');
    cp.handleIncomingMessage(JSON.stringify({ type: 'copilot_encrypted', iv: 'aa', tag: 'bb', data: 'cc' }), false, nowSec());
    cp.handleIncomingMessage(JSON.stringify({ type: 'hello_request' }), false, nowSec());
    assert.strictEqual(hellos, 1, 'malformed / plaintext: nothing');
    // the largest hello the car sends (main.js: every profile text full of 4-byte characters) fits
    // ntfy's 4096-byte message (a bigger one would become an attachment the page can't read)
    const car4 = '\u{1F697}';
    const bigHello = link.sealForPhone(key, 'copilot_car', { type: 'car_hello', app: 'm_copilot', paired: true, version: '1.0.17',
        settings: { provider: 'openrouter', model: 'x'.repeat(80), profile: { model: car4.repeat(60), power: car4.repeat(40), mods: car4.repeat(160), country: car4.repeat(40),
            tune: 'stage2plus', tyres: 'semislick', fuel: 'ron100', use: 'spirited', lang: 'pt' } } });
    assert(JSON.stringify(bigHello).length < 4096, 'the largest hello fits one relay message (' + JSON.stringify(bigHello).length + ')');
    const openedHello = await CL.openFromCar(car, { message: JSON.stringify(bigHello), time: nowSec() });
    assert(openedHello && openedHello.settings && openedHello.settings.profile.lang === 'pt', 'and the page opens it with the settings');
    let profile = null;
    cp.onProfile = (p) => { profile = p; };
    await send({ type: 'copilot_profile', profile: { tune: 'stock' } });
    assert.strictEqual(profile.tune, 'stock', 'profile accepted');
    requests.length = 0;
    cp.notifyAck();
    const ack = JSON.parse(requests[0].body.toString());
    assert.strictEqual(ack.type, 'copilot_car', 'the ack is encrypted');
    assert.strictEqual((await CL.openFromCar(car, item(ack))).type, 'pair_ack', 'and the phone reads it');
    const bad2 = new CopilotPair({ log: quiet }, { config: { channel: 'bmw_copilot_short', secretKey: key }, saveConfig() {}, isConfigured: () => false });
    assert(link.validChannel(bad2.channel, 'bmw_copilot_') && bad2.secretKey !== key, 'a malformed saved pairing is replaced as a whole');

    // ---- Spotify's pairing manager ----
    const spotify = { isAuthenticated: () => false, saveAuthTokens(t) { spotify.tokens = t; }, clientId: null };
    const spDir = path.join(tmp, 'spotify');
    fs.mkdirSync(spDir);
    fs.writeFileSync(path.join(spDir, 'spotify_auth.json'), JSON.stringify({ channel: chS, secretKey: key }));
    const sp = new SpotifyPair({ log: quiet, dataDir: spDir }, spotify);
    const spCar = await CL.saveCar(chS, key);
    await CL.sendToCar(spCar, { token: 'tok', refreshToken: 'ref', clientId: 'c'.repeat(32) });
    const tw = page.posts.pop().init.body;
    sp.handleIncomingMessage(tw, false, nowSec() - 7200);
    assert(!spotify.tokens, 'a token message re-posted 2 h later: not used');
    sp.handleIncomingMessage(tw, false, nowSec());
    assert.strictEqual(spotify.tokens && spotify.tokens.token, 'tok', 'a fresh token message is used');

    // the phone asks whether the car is paired: an encrypted answer
    requests.length = 0;
    await CL.sendToCar(spCar, { type: 'hello_request' });
    sp.handleIncomingMessage(page.posts.pop().init.body, false, nowSec());
    const hello2 = await CL.openFromCar(spCar, item(JSON.parse(requests.pop().body.toString())));
    assert(hello2 && hello2.type === 'car_hello' && hello2.paired === false, 'Spotify answers hello with its paired state');

    // ---- the relay subscription: one long-lived request, resumed after a drop ----
    const paths = [];
    let res = null;
    const streamGet = (opts, cb) => {
        paths.push(opts.path);
        const req = new EventEmitter();
        req.destroy = () => {};
        setImmediate(() => {
            res = new EventEmitter();
            res.statusCode = paths.length === 3 ? 429 : 200;
            res.headers = { date: new Date().toUTCString() };
            res.resume = () => {};
            res.setEncoding = () => {};
            cb(res);
        });
        return req;
    };
    const got2 = [];
    const rs = new RelayStream({ get: streamGet, log: quiet });
    rs.start('bmw_spot_x', 'all', (it) => got2.push(it.message));
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(paths[0], '/bmw_spot_x/json?since=all', 'subscribes from the given point');
    res.emit('data', '{"event":"open","time":1}\n{"event":"keepalive","time":2}\n{"id":"m1","event":"mes');
    res.emit('data', 'sage","time":3,"message":"a"}\n{"id":"m2","event":"message","time":4,"message":"b"}\n');
    assert.deepStrictEqual(got2, ['a', 'b'], 'messages split across chunks; open / keepalive are not messages');
    res.emit('end');
    await new Promise((r) => setTimeout(r, 3200));
    assert.strictEqual(paths[1], '/bmw_spot_x/json?since=m2', 'a dropped stream resumes after the last message');
    res.emit('end');
    await new Promise((r) => setTimeout(r, 6300));
    assert.strictEqual(paths.length, 3, 'reconnects with a growing wait');
    await new Promise((r) => setTimeout(r, 200));
    assert(rs.retryTimer, 'after a 429 it waits before trying again');
    rs.stop();
    assert(!rs.running && !rs.retryTimer, 'stopped: no retry left');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('carlink: all checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
