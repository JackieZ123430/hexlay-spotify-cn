'use strict';

// The phone <-> car link end to end, without network, phone or car: the real page library
// (docs/carlink.js, WebCrypto) against the real car modules (kit/runtime/link_crypto.js,
// webpush.js, apps/*/cloud_pair.js, apps/m_copilot/phone_push.js). Checks that:
//   - each side opens what the other sealed, and nothing else (tampering, plaintext, its own
//     messages, another car's key, re-posted or repeated messages);
//   - only this site's own pairing links are accepted;
//   - the pairing managers act only on authentic, fresh messages;
//   - notifications: subscribe / unsubscribe, warning lights and service due told once,
//     a gone subscription forgotten, a clock-rejected token retried, unpair forgets all.
//   node kit/tools/test_carlink.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');

// the apps require './kit/<x>' (copied from kit/runtime by the build) and './tls_dates'
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
        const m = /^\.\/kit\/(.+)$/.exec(request);
        if (m) return origResolve.call(this, path.join(ROOT, 'kit', 'runtime', m[1]), parent, ...rest);
        if (request === './tls_dates') return 'fake-tls';
    }
    return origResolve.call(this, request, parent, ...rest);
};
require.cache['fake-tls'] = { id: 'fake-tls', filename: 'fake-tls', loaded: true, exports: fakeTls };

const link = require('../runtime/link_crypto');
const wp = require('../runtime/webpush');
const { PhoneNotifier } = require('../../apps/m_copilot/phone_push');
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

    // ---- M-Copilot's pairing manager ----
    const ai = { config: { channel: chC, secretKey: key, paired: true }, saveConfig() {}, isConfigured: () => true, saveCredentials(p) { ai.saved = p; } };
    const cp = new CopilotPair({ log: quiet }, ai);
    assert.strictEqual(cp.channel, chC, 'saved pairing kept');
    const pushes = [];
    cp.onPush = (m) => pushes.push(m);
    const send = async (obj, t) => { await CL.sendToCar(car, obj); const w = page.posts.pop().init.body; cp.handleIncomingMessage(w, false, t === undefined ? nowSec() : t); return w; };
    const w1 = await send({ type: 'push_subscribe', sub: {} });
    assert.strictEqual(pushes.length, 1, 'push_subscribe reaches the notifier');
    cp.handleIncomingMessage(w1, false, nowSec());
    assert.strictEqual(pushes.length, 1, 'the same message again: dropped');
    await send({ type: 'hello_request' }, nowSec() - 3600);
    assert.strictEqual(pushes.length, 1, 'a re-post an hour late: dropped');
    cp.handleIncomingMessage(JSON.stringify({ type: 'copilot_encrypted', iv: 'aa', tag: 'bb', data: 'cc' }), false, nowSec());
    cp.handleIncomingMessage(JSON.stringify({ type: 'push_subscribe' }), false, nowSec());
    assert.strictEqual(pushes.length, 1, 'malformed / plaintext: nothing');
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

    // ---- notifications ----
    const told = [];
    const pushDir = path.join(tmp, 'push');
    fs.mkdirSync(pushDir);
    const pn = new PhoneNotifier({ dataDir: pushDir, log: quiet, request: fakeTls.request, tellPhone: (o) => told.push(o), version: '9.9', settleMs: 5 });
    pn.hello();
    const hello = told.pop();
    assert(hello.type === 'car_hello' && wp.validVapidKeys(pn.state.vapid) && hello.vapid === pn.state.vapid.publicKey, 'hello carries the car\'s push key');
    const ua = require('crypto').createECDH('prime256v1');
    ua.generateKeys();
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: wp.b64u(ua.getPublicKey()), auth: wp.b64u(require('crypto').randomBytes(16)) } };
    pn.onPhoneMessage({ type: 'push_subscribe', sub, vapid: 'not-the-key', time: Date.now() });
    assert(told.some((m) => m.type === 'push_error' && m.reason === 'stale_key') && told.pop().type === 'car_hello', 'a subscription for another key is refused, and the current key re-sent');
    told.length = 0;
    pn.onPhoneMessage({ type: 'push_subscribe', sub: Object.assign({}, sub, { endpoint: 'https://evil.example/push' }), vapid: hello.vapid, time: Date.now() });
    assert.strictEqual(told.pop().reason, 'unsupported', 'an unknown push service is refused');
    requests.length = 0;
    pn.onPhoneMessage({ type: 'push_subscribe', sub, vapid: hello.vapid, label: 'iPhone', time: Date.now() });
    assert.strictEqual(told.pop().type, 'push_ok', 'subscribed');
    assert.strictEqual(pn.phoneCount(), 1);
    assert.strictEqual((fs.statSync(path.join(pushDir, 'copilot_push.json')).mode & 0o777).toString(8), '600', 'push state readable by the app only');
    await new Promise((r) => setTimeout(r, 20));
    const test = requests.pop();
    assert.strictEqual(test.opts.hostname, 'fcm.googleapis.com', 'the test notification goes to the push service');
    assert(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/.test(test.opts.headers.Authorization) && test.opts.headers['Content-Encoding'] === 'aes128gcm', 'VAPID + aes128gcm');
    assert(!test.body.toString('latin1').includes('Notifications are on'), 'the notification is not readable on the way');

    // warning light: told once, with its text
    const active = new Map([[123, true]]), names = new Map([[123, 'Engine oil level low']]);
    requests.length = 0;
    pn.checkControl(active, names);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(requests.length, 1, 'a new warning is pushed');
    pn.checkControl(active, names);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(requests.length, 1, 'the same warning: not again the same day');
    // service due: once per item and state
    pn.service([{ name: 'Engine oil', state: 'due soon', way: '1500 km' }, { name: 'Brake fluid', state: 'OK' }]);
    pn.service([{ name: 'Engine oil', state: 'due soon', way: '1400 km' }]);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(requests.length, 2, 'service due told once');
    // a token the service rejects (car clock): retried once with the service's time
    let n403 = 0;
    respond = () => (n403++ === 0 ? { status: 403, date: Date.now() + 5 * 86400e3 } : { status: 201 });
    pn.service([{ name: 'Brake pads', state: 'overdue' }]);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(n403, 2, 'retried after the clock fix');
    assert(Math.abs(pn.clockOffset - 5 * 86400e3) < 5000, 'clock offset learned from the push service');
    // a subscription that has ended is forgotten
    respond = () => ({ status: 410 });
    pn.service([{ name: 'Spark plugs', state: 'overdue' }]);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(pn.phoneCount(), 0, 'a gone subscription is dropped');
    // unsubscribe and unpair
    respond = () => ({ status: 201 });
    pn.onPhoneMessage({ type: 'push_subscribe', sub, vapid: hello.vapid, time: Date.now() });
    pn.onPhoneMessage({ type: 'push_unsubscribe', endpoint: sub.endpoint, time: Date.now() });
    assert.strictEqual(pn.phoneCount(), 0, 'unsubscribed');
    pn.onPhoneMessage({ type: 'push_subscribe', sub, vapid: hello.vapid, time: Date.now() });
    const oldKey = pn.state.vapid.publicKey;
    pn.forgetAll();
    assert(pn.phoneCount() === 0 && pn.vapidPublicKey() !== oldKey, 'unpair forgets every phone and makes a new key');
    const saved = fs.readFileSync(path.join(pushDir, 'copilot_push.json'), 'utf8');
    assert(!/vin|WBA|lat|lon/i.test(saved.replace(/"(publicKey|privateKey)":"[^"]+"/g, '')), 'nothing about the car or driver in the push state');
    pn.stop();

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('carlink: all checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
