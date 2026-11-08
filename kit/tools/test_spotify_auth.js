'use strict';
// Spotify's login file: one copy, in the app's data folder; an old copy next to the code (Spotify before
// 1.0.23) moves there once, and a logout clears both. Runs a COPY of apps/spotify/api.js in a temp folder,
// so no developer's spotify_auth.json is read or rewritten:
//   node kit/tools/test_spotify_auth.js
const path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert'), Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'spotify-auth-'));
const APP = path.join(base, 'app');
fs.mkdirSync(APP);
fs.copyFileSync(path.join(ROOT, 'apps', 'spotify', 'api.js'), path.join(APP, 'api.js'));
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, p, ...x) {
    const m = p && p.filename && p.filename.startsWith(APP) && /^\.\/kit\/(.+)$/.exec(r);
    return orig.call(this, m ? path.join(KIT, m[1]) : r, p, ...x);
};
const { SpotifyClient } = require(path.join(APP, 'api.js'));
SpotifyClient.prototype.initialFetch = function () {};
SpotifyClient.prototype._loadCache = function () {};
global.setInterval = () => ({ unref() {} });
const log = { info() {}, warn: (s) => console.log('  warn: ' + s), error() {} };
const settings = { get: (k) => (k === 'net' ? 'off' : null) };
const LEGACY = path.join(APP, 'spotify_auth.json');
const json = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
let n = 0;
function client(files) {
    const data = path.join(base, 'data' + (n++));
    fs.mkdirSync(data);
    try { fs.unlinkSync(LEGACY); } catch (e) { /* none */ }
    if (files.data) fs.writeFileSync(path.join(data, 'spotify_auth.json'), JSON.stringify(files.data));
    if (files.legacy) fs.writeFileSync(LEGACY, JSON.stringify(files.legacy));
    return { s: new SpotifyClient({ log, dataDir: data, settings }), file: path.join(data, 'spotify_auth.json') };
}
const pairing = { channel: 'bmw_spot_' + 'ab'.repeat(12), secretKey: 'cd'.repeat(32) };

// 1. an older version's login next to the code, the data folder has only the pairing
let c = client({ data: pairing, legacy: { token: 'tokOld', refreshToken: 'refOld', expiresAt: 5, lastDeviceId: 'dev1' } });
assert.strictEqual(c.s.refreshToken, 'refOld', 'the old copy is read');
let d = json(c.file);
assert(d.refreshToken === 'refOld' && d.lastDeviceId === 'dev1' && d.channel === pairing.channel && d.secretKey === pairing.secretKey, 'moved into the data folder, the pairing kept');
assert(!fs.existsSync(LEGACY), 'and the copy next to the code is gone');
console.log('ok   an old copy next to the code moves to the data folder');

// 2. the data folder has the login, a stale copy next to the code
c = client({ data: Object.assign({ token: 'tokNew', refreshToken: 'refNew' }, pairing), legacy: { token: 'tokOld', refreshToken: 'refOld' } });
assert.strictEqual(c.s.refreshToken, 'refNew', 'the data folder wins');
assert(!fs.existsSync(LEGACY), 'the stale copy goes');
console.log('ok   the data folder wins, a stale copy next to the code goes');

// 3. a new login is written to the data folder only
c = client({ data: pairing });
c.s.saveAuthTokens({ token: 't3', refreshToken: 'r3', expiresAt: 9 });
assert.strictEqual(json(c.file).refreshToken, 'r3', 'saved in the data folder');
assert(!fs.existsSync(LEGACY), 'no copy next to the code');
console.log('ok   a new login goes to the data folder only');

// 4. logout clears every copy (a read-only old copy that could not be moved too)
c = client({ data: Object.assign({ token: 'a', refreshToken: 'b' }, pairing) });
fs.writeFileSync(LEGACY, JSON.stringify({ token: 'x', refreshToken: 'y', clientId: 'id' }));
c.s.logout();
assert(!json(c.file).refreshToken && json(c.file).channel === pairing.channel, 'data folder: login gone, pairing kept');
assert(!json(LEGACY).refreshToken, 'old copy: login gone');
console.log('ok   logout clears the login everywhere');

// 5. no login anywhere: nothing read, nothing written
c = client({ data: pairing });
assert(!c.s.isAuthenticated() && !fs.existsSync(LEGACY) && !json(c.file).token, 'nothing');
console.log('ok   no login: nothing');

fs.rmSync(base, { recursive: true, force: true });
console.log('all passed');
process.exit(0);
