'use strict';

// Spotify's client (apps/spotify/api.js) against a fake Spotify Web API: playing (Liked Songs as a
// context, the no-device fallback), what a failure tells the driver, a phone that stopped, shuffle /
// repeat holding the tapped state, paging, the library cache and text the fonts can draw.
// No network, account or car needed:
//   node kit/tools/test_spotify.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
// in a package the kit is at ./kit next to the app's files (build.py); here it is kit/runtime
const KIT = path.resolve(__dirname, '..', 'runtime'), APPS = path.resolve(__dirname, '..', '..', 'apps');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    const m = parent && parent.filename && parent.filename.indexOf(APPS) === 0 && /^\.\/kit\/(.+)$/.exec(request);
    return origResolve.call(this, m ? path.join(KIT, m[1]) : request, parent, ...rest);
};
const { SpotifyClient } = require('../../apps/spotify/api');

// No login is read or cleaned: a stored one would start real requests at construction, and logout
// would rewrite the developer's spotify_auth.json files
SpotifyClient.prototype._loadAuth = function () {};
SpotifyClient.prototype._forgetAuthFiles = function () {};

const quiet = { info() {}, warn() {}, error() {} };
const noNet = { get: (k) => (k === 'net' ? 'off' : null) };       // no internet probe at construction

function apiError(status, reason, message) {
    const e = new Error('Spotify API ' + status + ': ' + message);
    e.status = status;
    e.reason = reason;
    return e;
}

/** A logged-in client whose requests go to route(method, path, body) (a throw is Spotify's error). */
function client(route, dataDir) {
    const s = new SpotifyClient({ dataDir: dataDir || '/nonexistent', log: quiet, settings: noNet });
    s.token = 'token';
    s.isOnline = true;
    s._userId = 'me';
    s._pollSoon = () => {};
    s.calls = [];
    s._request = async (method, p, body) => {
        s.calls.push([method, p, body]);
        return route(method, p, body);
    };
    return s;
}

function playerState(o) {
    return Object.assign({
        device: { id: 'iph', is_active: true, name: 'iPhone', type: 'Smartphone' },
        is_playing: true, progress_ms: 0, shuffle_state: false, repeat_state: 'off',
        item: { id: 'x', name: 'X', duration_ms: 200000, artists: [], album: { name: '', images: [] } },
    }, o);
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ---------- playing ---------- */

test('Liked Songs plays as the collection, from the tapped song', async () => {
    const s = client(() => null);
    s.likedSongs = [{ id: 'a', uri: 'spotify:track:a' }, { id: 'b', uri: 'spotify:track:b' }];
    await s.playLikedSong(1);
    const play = s.calls.find((c) => c[1].startsWith('/v1/me/player/play'));
    assert.deepStrictEqual(play[2], { context_uri: 'spotify:user:me:collection', offset: { uri: 'spotify:track:b' } });
});

test('Liked Songs falls back to a track list when the collection is refused', async () => {
    const s = client((m, p, body) => {
        if (p.startsWith('/v1/me/player/play') && body.context_uri) throw apiError(400, '', 'bad context');
        return null;
    });
    s.likedSongs = [{ id: 'a', uri: 'spotify:track:a' }, { id: 'b', uri: 'spotify:track:b' }];
    await s.playLikedSong(0);
    const plays = s.calls.filter((c) => c[1].startsWith('/v1/me/player/play'));
    assert.strictEqual(plays.length, 2);
    assert.deepStrictEqual(plays[1][2], { uris: ['spotify:track:a', 'spotify:track:b'] });
    assert.strictEqual(s.notice, undefined);
});

test('no active device: the device list again, then the phone that played last', async () => {
    const s = client((m, p) => {
        if (p === '/v1/me/player/devices') {
            return { devices: [{ id: 'mac', name: 'Mac', type: 'Computer', is_active: false },
                { id: 'iph', name: 'iPhone', type: 'Smartphone', is_active: false }] };
        }
        if (p.startsWith('/v1/me/player/play') && !p.includes('device_id')) throw apiError(404, 'NO_ACTIVE_DEVICE', 'Player command failed: No active device found');
        return null;
    });
    s.devices = [];
    s._lastDeviceId = 'iph';
    await s.playTrack({ uri: 'spotify:playlist:p', tracks: [{ id: 't', uri: 'spotify:track:t' }] }, 0);
    const plays = s.calls.filter((c) => c[1].startsWith('/v1/me/player/play')).map((c) => c[1]);
    assert.deepStrictEqual(plays, ['/v1/me/player/play', '/v1/me/player/play?device_id=iph']);
    assert.strictEqual(s.notice, undefined);
});

test('no device at all: the driver is told to open Spotify, nothing shown as playing', async () => {
    const s = client((m, p) => {
        if (p === '/v1/me/player/devices') return { devices: [] };
        if (p.startsWith('/v1/me/player/play')) throw apiError(404, 'NO_ACTIVE_DEVICE', 'Player command failed: No active device found');
        return null;
    });
    s.likedSongs = [{ id: 'a', uri: 'spotify:track:a' }];
    await s.playLikedSong(0);
    assert.match(s.notice.text, /open Spotify on your phone/);
    assert.strictEqual(s.isPlaying, false);
});

test('Up Next plays on in what plays, from that song', async () => {
    const s = client(() => null);
    s.contextUri = 'spotify:playlist:p';
    await s.playQueued({ id: 'q', uri: 'spotify:track:q' });
    const play = s.calls.find((c) => c[1].startsWith('/v1/me/player/play'));
    assert.deepStrictEqual(play[2], { context_uri: 'spotify:playlist:p', offset: { uri: 'spotify:track:q' } });
});

test('seek goes to the position, never past the song', async () => {
    const s = client(() => null);
    s.currentTrack = { id: 'x', durationMs: 200000 };
    await s.seek(90000);
    await s.seek(999999);
    assert.deepStrictEqual(s.calls.map((c) => c[1]), ['/v1/me/player/seek?position_ms=90000', '/v1/me/player/seek?position_ms=199000']);
});

/* ---------- failures, in words ---------- */

test('errors are explained in plain words', () => {
    const s = client(() => null);
    const said = (e) => s._explain('Skip', e);
    assert.match(said(apiError(403, 'PREMIUM_REQUIRED', 'Premium required')), /Premium is needed/);
    assert.match(said(apiError(403, 'UNKNOWN', 'Restriction violated')), /Skip is not possible here/);
    assert.match(said(apiError(404, 'NO_ACTIVE_DEVICE', 'No active device found')), /open Spotify on your phone/);
    assert.match(said(apiError(429, '', 'rate limited')), /busy/);
    assert.match(said(apiError(502, '', 'bad gateway')), /Spotify had a problem/);
    assert.match(said(new Error('Timeout')), /No connection to Spotify/);
    assert.match(said(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })), /No connection/);
    assert.match(said(new Error('Spotify session expired. Please re-authenticate.')), /pair again/);
});

test('a refused skip is shown', async () => {
    const s = client(() => { throw apiError(403, 'UNKNOWN', 'Player command failed: Restriction violated'); });
    await s.nextTrack();
    assert.match(s.notice.text, /Skip is not possible here/);
});

test('a refused like puts the heart back and says why', async () => {
    const s = client(() => { throw apiError(502, '', 'bad gateway'); });
    s.currentTrack = { id: 'x' };
    s.isCurrentLiked = false;
    await s.toggleLikeCurrent();
    assert.strictEqual(s.isCurrentLiked, false);
    assert.match(s.notice.text, /Spotify had a problem/);
});

test('the heart is read from the library by URI', async () => {
    const s = client((m, p) => (p.startsWith('/v1/me/library/contains') ? [true] : null));
    s.currentTrack = { id: 'x' };
    await s.checkTrackLiked('x');
    assert.strictEqual(s.isCurrentLiked, true);
    assert.strictEqual(s.calls[0][1], '/v1/me/library/contains?uris=' + encodeURIComponent('spotify:track:x'));
});

/* ---------- the player's state ---------- */

test('a position that stands still 4 s is shown as paused; moving again, as playing', async () => {
    let pos = 50000;
    const s = client((m, p) => (p.startsWith('/v1/me/player?') ? playerState({ progress_ms: pos }) : null));
    s.checkTrackLiked = async () => {};
    s.fetchQueue = async () => {};
    const realNow = Date.now, t0 = realNow();
    let now = t0;
    Date.now = () => now;
    try {
        const shown = [];
        for (let i = 0; i < 7; i++) { now = t0 + i * 1000; await s.pollPlayer(); shown.push(s.isPlaying ? 'P' : '-'); }
        assert.strictEqual(shown.join(''), 'PPPP---');
        assert.strictEqual(s.stalled, true);
        pos = 60000; now += 1000; await s.pollPlayer();
        assert.strictEqual(s.isPlaying, true);
        pos = 205000; now += 1000; await s.pollPlayer();           // past the song's end
        assert.strictEqual(s.isPlaying, false);
        assert.strictEqual(s.progressMs, 200000);
    } finally {
        Date.now = realNow;
    }
});

test('a tapped repeat holds against polls that still bring the old state', async () => {
    let server = 'off';
    const s = client((m, p) => (p.startsWith('/v1/me/player?') ? playerState({ repeat_state: server, progress_ms: Math.random() * 1e5 }) : null));
    s.checkTrackLiked = async () => {};
    s.fetchQueue = async () => {};
    s.repeat = 'off';
    await s.toggleRepeat();
    await s.pollPlayer();
    assert.strictEqual(s.repeat, 'context');                       // Spotify still says off
    server = 'context';
    await s.pollPlayer();
    assert.strictEqual(s._holdRepeat, null);
});

/* ---------- paging ---------- */

test('Liked Songs and a playlist load page after page', async () => {
    const page = (offset, total) => ({
        total,
        items: Array.from({ length: Math.min(50, total - offset) }, (_, i) => ({ track: { id: 't' + (offset + i), name: 'T', artists: [], uri: 'spotify:track:t' + (offset + i) } })),
    });
    const s = client((m, p) => {
        const off = Number((p.match(/offset=(\d+)/) || [0, 0])[1]);
        if (p.startsWith('/v1/me/tracks')) return page(off, 120);
        if (p.startsWith('/v1/playlists/pl/items')) return page(off, 73);
        return null;
    });
    await s.fetchLikedSongs();
    while (s.hasMoreLiked()) await s.loadMoreLiked();
    assert.strictEqual(s.likedSongs.length, 120);
    assert.strictEqual(new Set(s.likedSongs.map((t) => t.id)).size, 120);
    const pl = { id: 'pl', name: 'P', tracks: [] };
    await s.fetchTracksForPlaylist(pl);
    while (s.hasMoreTracks(pl)) await s.loadMoreTracks(pl);
    assert.strictEqual(pl.tracks.length, 73);
});

/* ---------- the library cache ---------- */

test('the cache shows the library at start, holds no tokens, goes with logout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotify-test-'));
    try {
        const a = client(() => null, dir);
        a.token = 'tok-secret';
        a.refreshToken = 'ref-secret';
        a.profile = { name: 'Driver', product: 'premium' };
        a.playlists = [{ id: 'p1', name: 'Road', uri: 'spotify:playlist:p1', trackCount: 1, tracksLoaded: true, tracks: [{ id: 's', title: 'Song', uri: 'spotify:track:s' }] }];
        a.likedSongs = [{ id: 'l', title: 'Liked', uri: 'spotify:track:l' }];
        a.likedTotal = 1;
        a._saveCache();
        const raw = fs.readFileSync(path.join(dir, 'spotify_cache.json'), 'utf8');
        assert.ok(!/tok-secret|ref-secret/.test(raw), 'no tokens in the cache');

        const b = new SpotifyClient({ dataDir: dir, log: quiet, settings: noNet });
        b._loadCache();                                 // (as at start with a login)
        assert.strictEqual(b.playlists[0].name, 'Road');
        assert.strictEqual(b.playlists[0].tracks[0].title, 'Song');
        assert.strictEqual(b.playlists[0]._refresh, true, 'cached songs are fetched again when shown');
        assert.strictEqual(b.likedSongs[0].title, 'Liked');
        assert.strictEqual(b.profile.name, 'Driver');

        b.logout();
        assert.ok(!fs.existsSync(path.join(dir, 'spotify_cache.json')));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('another account drops the cached library', async () => {
    const s = client((m, p) => (p === '/v1/me' ? { id: 'someone-else', display_name: 'Other' } : null));
    s._cacheUser = 'me';
    s.playlists = [{ id: 'p1', name: 'Mine' }];
    s.likedSongs = [{ id: 'l' }];
    await s.fetchProfile();
    assert.deepStrictEqual(s.playlists, []);
    assert.deepStrictEqual(s.likedSongs, []);
    assert.strictEqual(s._userId, 'someone-else');
});

/* ---------- the demo setting, switched while running ---------- */

test('demo off: every demo trace goes; on again: the demo is back', () => {
    const demoOn = { get: (k) => (k === 'net' ? 'off' : k === 'demo' ? 'on' : null) };
    const s = new SpotifyClient({ dataDir: '/nonexistent', log: quiet, settings: demoOn });
    assert.ok(s.playlists.length && s.devices.length && s.currentTrack && s.activeDevice, 'demo data at start');
    s.setDemoMode(false);
    assert.deepStrictEqual([s.playlists.length, s.devices.length, s.currentTrack, s.activeDevice, s.currentPlaylist],
        [0, 0, null, null, null]);
    s.setDemoMode(true);
    assert.ok(s.playlists.length && s.devices.length && s.currentTrack, 'demo data again');
    assert.strictEqual(s.activeDevice, 'BMW iDrive 7');
});

test('demo on with an account paired: its own library stays', () => {
    const s = client(() => null);
    s.isDemoMode = false;
    s.playlists = [{ id: 'mine', name: 'Mine', tracks: [] }];
    s.setDemoMode(true);
    assert.strictEqual(s.playlists[0].id, 'mine');
});

/* ---------- text ---------- */

test('typographic punctuation becomes what the fonts have', async () => {
    const s = client(() => ({ items: [{ track: { id: 'x', name: 'Other People’s Heartache – Pt. III…', artists: [{ name: '“Quoted”' }], uri: 'spotify:track:x' } }], total: 1 }));
    await s.fetchLikedSongs();
    assert.strictEqual(s.likedSongs[0].title, "Other People's Heartache - Pt. III...");
    assert.strictEqual(s.likedSongs[0].artist, '"Quoted"');
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log('ok   ' + name);
        } catch (e) {
            failed++;
            console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e));
        }
    }
    console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
