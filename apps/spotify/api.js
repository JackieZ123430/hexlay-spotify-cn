'use strict';
/**
 * Spotify Web API Client + Offline/Demo Engine for BMW iDrive 7 MGU.
 *
 * Supports:
 * - Live Spotify Connect integration: auto-detects real playback, tracks, playlists & devices
 * - Remote control commands: play, pause, next, prev, seek, shuffle, repeat
 * - Token auto-refresh & persistence in spotify_auth.json
 * - Fallback to demo simulation when offline or unauthenticated
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');
const tlsDates = require('./kit/tls_dates');

// how long a failed token refresh (network, 5xx, a non-definitive 4xx) waits before the next try
const REFRESH_RETRY_MS = 30000;

if (!Promise.prototype.finally) {
    Promise.prototype.finally = function(callback) {
        const P = this.constructor || Promise;
        return this.then(
            value => P.resolve(callback()).then(() => value),
            reason => P.resolve(callback()).then(() => { throw reason; })
        );
    };
}

/* Rewrites the JSON file at p with mutate(its contents), atomically (temp file + rename). */
function updateAuthFile(p, mutate) {
    let existing = {};
    try {
        if (fs.existsSync(p)) existing = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
    } catch (e) {}
    const out = mutate(existing) || existing;
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, p);
}

function decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .replace(/&amp;/g, '&')
        .replace(/&#x2F;/g, '/')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        // typographic punctuation the car's fonts do not have (drawn as "?"): its ASCII look-alike
        .replace(/[\u2018\u2019\u201A\u2032\u00B4]/g, "'")
        .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
        .replace(/[\u2010-\u2015\u2212]/g, '-')
        .replace(/\u2026/g, '...')
        .replace(/[\u00A0\u2007\u202F]/g, ' ');
}

const CACHE_TRACKS = 100;            // songs kept per playlist in the library cache
const CACHE_LIKED = 200;             // liked songs kept in it

const DEMO_DEVICE_NAME = 'BMW iDrive 7';     // "plays on" in the demo

const DEMO_ART = 'https://i.scdn.co/image/ab67616d00001e02ba5db46f4b838ef6027e6f96';

const DEMO_PLAYLISTS = [
    {
        id: 'pl_m_driving',
        name: 'BMW M Driving Mix',
        description: 'High adrenaline soundtracks for sport mode & open roads',
        trackCount: 7,
        accent: '#e1001a',
        uri: 'spotify:playlist:demo_m',
        tracks: [
            { id: 't1', title: 'Midnight City', artist: 'M83', album: 'Hurry Up, We\'re Dreaming', durationMs: 243000, uri: 'spotify:track:t1', albumArt: DEMO_ART },
            { id: 't2', title: 'Turbo Killer', artist: 'Carpenter Brut', album: 'Trilogy', durationMs: 208000, uri: 'spotify:track:t2', albumArt: DEMO_ART },
            { id: 't3', title: 'Nightcall', artist: 'Kavinsky', album: 'Drive OST', durationMs: 259000, uri: 'spotify:track:t3', albumArt: DEMO_ART },
            { id: 't4', title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', durationMs: 200000, uri: 'spotify:track:t4', albumArt: DEMO_ART },
            { id: 't5', title: 'Resonance', artist: 'HOME', album: 'Odyssey', durationMs: 212000, uri: 'spotify:track:t5', albumArt: DEMO_ART },
            { id: 't6', title: 'Starboy', artist: 'The Weeknd, Daft Punk', album: 'Starboy', durationMs: 230000, uri: 'spotify:track:t6', albumArt: DEMO_ART },
            { id: 't7', title: 'Days of Thunder', artist: 'The Midnight', album: 'Days of Thunder', durationMs: 278000, uri: 'spotify:track:t7', albumArt: DEMO_ART },
        ]
    },
    {
        id: 'pl_synthwave',
        name: 'Night Cruising',
        description: 'Ambient neon vibes for late night highway drives',
        trackCount: 5,
        accent: '#81c4ff',
        uri: 'spotify:playlist:demo_night',
        tracks: [
            { id: 't8', title: 'Sunset', artist: 'The Midnight', album: 'Endless Summer', durationMs: 326000, uri: 'spotify:track:t8' },
            { id: 't9', title: 'Tech Noir', artist: 'Gunship', album: 'GUNSHIP', durationMs: 297000, uri: 'spotify:track:t9' },
            { id: 't10', title: 'Running in the 90s', artist: 'Maurizio De Jorio', album: 'Initial D', durationMs: 282000, uri: 'spotify:track:t10' },
            { id: 't11', title: 'Crockett\'s Theme', artist: 'Jan Hammer', album: 'Miami Vice', durationMs: 215000, uri: 'spotify:track:t11' },
            { id: 't12', title: 'Far Away', artist: 'Power Glove', album: 'Far Away', durationMs: 252000, uri: 'spotify:track:t12' },
        ]
    },
    {
        id: 'pl_autobahn',
        name: 'Autobahn Speed',
        description: 'V8 roar & electronic energy for unrestricted lanes',
        trackCount: 4,
        accent: '#1db954',
        uri: 'spotify:playlist:demo_speed',
        tracks: [
            { id: 't13', title: 'Strobe', artist: 'deadmau5', album: 'For Lack of a Better Name', durationMs: 637000, uri: 'spotify:track:t13' },
            { id: 't14', title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', durationMs: 329000, uri: 'spotify:track:t14' },
            { id: 't15', title: 'Fast Car', artist: 'Jonas Blue, Dakota', album: 'Blue', durationMs: 212000, uri: 'spotify:track:t15' },
            { id: 't16', title: 'Speed King', artist: 'Deep Purple', album: 'In Rock', durationMs: 349000, uri: 'spotify:track:t16' },
        ]
    },
    {
        id: 'pl_liked',
        name: 'Liked Songs',
        description: 'Your favorite tracks saved to your library',
        trackCount: 142,
        accent: '#1ed760',
        uri: 'spotify:playlist:demo_liked',
        tracks: [
            { id: 't1', title: 'Midnight City', artist: 'M83', album: 'Hurry Up, We\'re Dreaming', durationMs: 243000, uri: 'spotify:track:t1' },
            { id: 't3', title: 'Nightcall', artist: 'Kavinsky', album: 'Drive OST', durationMs: 259000, uri: 'spotify:track:t3' },
            { id: 't4', title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', durationMs: 200000, uri: 'spotify:track:t4' },
            { id: 't8', title: 'Sunset', artist: 'The Midnight', album: 'Endless Summer', durationMs: 326000, uri: 'spotify:track:t8' },
        ]
    }
];

const DEMO_DEVICES = [
    { id: 'dev_phone', name: 'iPhone (iDrive Bluetooth)', type: 'Smartphone', isActive: true, volume: 82 },
    { id: 'dev_car', name: 'BMW M850i ConnectedDrive', type: 'Automobile', isActive: false, volume: 100 },
    { id: 'dev_mac', name: 'MacBook Pro', type: 'Computer', isActive: false, volume: 65 },
];

/** A Spotify track object as the screen's track (null for a local file, an episode without id, a gap). */
function mapTrack(t) {
    if (!t || !t.id) return null;
    const albumImages = (t.album && t.album.images) || [];
    const bestArt = albumImages.find((img) => img.width >= 200 && img.width <= 400) || albumImages[0];
    return {
        id: t.id,
        title: decodeHtmlEntities(t.name),
        artist: decodeHtmlEntities((t.artists || []).map((a) => a.name).join(', ')),
        album: decodeHtmlEntities(t.album ? t.album.name : ''),
        albumArt: bestArt ? bestArt.url : '',
        durationMs: t.duration_ms,
        uri: t.uri
    };
}

class SpotifyClient {
    isAuthenticated() {
        return !!(this.token || this.refreshToken);
    }

    get paired() {
        return !!(this.token || this.refreshToken);
    }

    set paired(val) {
        this._paired = !!val;
    }

    constructor(ctx) {
        this.ctx = ctx;
        this.log = ctx.log;
        this.token = null;
        this.refreshToken = null;
        this.expiresAt = 0;
        this.clientId = null;
        this.clientSecret = null;
        this.paired = false;
        this.isOnline = false;
        this.activeDevice = null;           // the demo's own: set with its data below
        this.lastSync = 0;
        this.syncing = false;

        // Internet connection monitoring
        // settings.get('net') === 'off': no internet probes (not an app setting: the tests' switch, kit/tools/test_spotify.js)
        this.noNet = !!(ctx.settings && ctx.settings.get('net') === 'off');
        this.hasInternet = !this.noNet;
        this.lastInternetCheck = 0;
        this.lastAnswerAt = 0;              // the last answer from api.spotify.com (the internet works)

        // Mode: Default is Online (demo is off)
        this.isDemoMode = ctx.settings ? (ctx.settings.get('demo') === 'on') : false;

        // Playlists & Library cache
        this.playlists = this.isDemoMode ? DEMO_PLAYLISTS : [];
        this.devices = this.isDemoMode ? DEMO_DEVICES : [];
        this.likedSongs = [];
        this.likedTotal = 0;
        this.remoteQueue = [];

        // Playback state
        this.isPlaying = false;
        this.currentPlaylist = this.playlists[0] || null;
        // online, "now playing" only ever comes from Spotify's player; the demo shows its first track
        this.currentTrack = this.isDemoMode && this.currentPlaylist && this.currentPlaylist.tracks ? this.currentPlaylist.tracks[0] : null;
        if (this.isDemoMode) this.activeDevice = DEMO_DEVICE_NAME;
        this.trackIndex = 0;
        this.progressMs = 0;
        this.lastTickTime = Date.now();
        this.shuffle = false;
        this.repeat = 'off';
        this.volume = 80;
        this.isCurrentLiked = false;
        this._lastCheckedTrackId = null;

        this.isLoadingPlaylists = false;
        this.isLoadingLiked = false;
        this.lastPlaylistsFetch = 0;
        this.lastLikedFetch = 0;
        this.refreshing = false;
        this._refreshPromise = null;
        this._refreshFailedAt = 0;

        // one kept-alive, certificate-checked connection to api.spotify.com: no handshake per call
        this.agent = tlsDates.agent();
        this.lastDeviceSync = 0;
        this.syncingDevices = false;
        this._lastCmdAt = 0;          // polls that started before the last command are not applied
        this._noSession = 0;          // consecutive polls without an active device

        this._loadAuth();
        if (this.token || this.refreshToken) {
            this._loadCache();              // the library as last seen, at once; refreshed right after
            this.initialFetch();
        }

        // Run initial internet check and schedule periodic check
        this.checkInternetConnection().catch(() => {});
        // re-checked only while the app is on screen (main.js sets isOnScreen)
        if (!this.isOnScreen) this.isOnScreen = () => true;
        // the player is polled every few seconds: an answer from Spotify in the last 30 s already
        // showed the uplink works, so the extra HTTPS check runs only when Spotify went quiet
        setInterval(() => {
            if (this.isOnScreen() && Date.now() - this.lastAnswerAt > 30000) this.checkInternetConnection().catch(() => {});
        }, 12000);
    }

    async checkInternetConnection() {
        if (this.noNet) {
            this.hasInternet = false;
            this.lastInternetCheck = Date.now();
            return false;
        }

        let ok = false;
        if (this.ctx.uplink && typeof this.ctx.uplink.checkInternet === 'function') {
            try {
                ok = await this.ctx.uplink.checkInternet({ timeout: 3500 });
            } catch (e) {}
        }

        if (!ok) {
            const probe = (host) => {
                return new Promise((resolve) => {
                    const req = https.request({
                        hostname: host,
                        port: 443,
                        path: '/',
                        method: 'HEAD',
                        timeout: 3500,
                        // reachability probe only: a HEAD with no credentials, so any certificate will do
                        rejectUnauthorized: false
                    }, (res) => {
                        res.resume();
                        resolve(true);
                    });
                    req.on('error', () => resolve(false));
                    req.on('timeout', () => {
                        req.destroy();
                        resolve(false);
                    });
                    req.end();
                });
            };

            ok = await probe('1.1.1.1');
            if (!ok) ok = await probe('api.spotify.com');
            if (!ok) ok = await probe('ntfy.sh');
        }

        const wasOffline = !this.hasInternet;
        this.hasInternet = ok;
        this.lastInternetCheck = Date.now();

        if (ok && wasOffline) {
            this.log.info('SpotifyClient: Internet uplink active.');
            if (this.isAuthenticated()) {
                this.initialFetch();
            }
        }

        return ok;
    }

    saveAuthTokens(data) {
        if (!data || (!data.token && !data.refreshToken)) return;
        if (data.token) this.token = data.token;
        if (data.refreshToken) this.refreshToken = data.refreshToken;
        if (data.expiresAt) this.expiresAt = data.expiresAt;
        if (data.clientId) this.clientId = data.clientId;
        this.isOnline = true;
        this._refreshFailedAt = 0;
        this._persistAuth();
        this.initialFetch();
    }

    /**
     * The login's one file: spotify_auth.json in the app's data folder (readable by the app only), with the
     * pairing channel and key (cloud_pair.js). Without a data folder (a test, a bench run) next to the code.
     */
    _authPath() {
        return this.ctx && this.ctx.dataDir ? path.join(this.ctx.dataDir, 'spotify_auth.json') : path.join(__dirname, 'spotify_auth.json');
    }

    /** Where Spotify before 1.0.23 also kept a copy of the login: next to the code (moved by _loadAuth). */
    _legacyAuthPath() {
        const p = path.join(__dirname, 'spotify_auth.json');
        return p !== this._authPath() ? p : null;
    }

    /** Every place a login may be: a logout clears them all. */
    _authPaths() {
        return [this._authPath(), this._legacyAuthPath()].filter(Boolean);
    }

    /* Merges the tokens into spotify_auth.json, keeping what else it holds (the cloud pairing
     * channel and secretKey), written atomically. */
    _persistAuth() {
        const p = this._authPath();
        try {
            updateAuthFile(p, (existing) => Object.assign(existing, {
                token: this.token,
                refreshToken: this.refreshToken,
                expiresAt: this.expiresAt,
                clientId: this.clientId,
                clientSecret: this.clientSecret,
                savedAt: new Date().toISOString()
            }));
            this.log.info('SpotifyClient: Saved auth tokens to ' + p);
            return true;
        } catch (e) {
            this.log.warn('SpotifyClient: Could not save tokens to ' + p + ': ' + e.message);
            return false;
        }
    }

    _loadAuth() {
        const read = (p) => {
            try { return p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) || {} : null; } catch (e) { return null; }
        };
        const signedIn = (d) => !!(d && (d.token || d.refreshToken));
        const main = this._authPath(), legacy = this._legacyAuthPath();
        let data = read(main), from = main;
        // an older version's copy next to the code, and none in the data folder: it moves there once
        const old = legacy ? read(legacy) : null;
        if (!signedIn(data) && signedIn(old)) { data = old; from = legacy; }
        if (!signedIn(data)) return;
        this.token = data.token;
        this.refreshToken = data.refreshToken;
        this.expiresAt = data.expiresAt || 0;
        this.clientId = data.clientId;
        this.clientSecret = data.clientSecret;
        this._lastDeviceId = data.lastDeviceId || null;
        this.isOnline = true;
        this.log.info('Loaded Spotify auth token from ' + from);
        if (from === legacy) {
            if (data.lastDeviceId) { try { updateAuthFile(main, (ex) => { ex.lastDeviceId = data.lastDeviceId; return ex; }); } catch (e) { /* below */ } }
            if (this._persistAuth()) {
                try { fs.unlinkSync(legacy); this.log.info('SpotifyClient: moved the login from ' + legacy + ' to the data folder'); } catch (e) { /* read-only: left there */ }
            }
        } else if (signedIn(old)) {
            // the data folder has the login: a stale copy next to the code goes
            try { fs.unlinkSync(legacy); } catch (e) { /* read-only: left there */ }
        }
    }

    /* ---------- The library cache (spotify_cache.json in the app's data folder) ----------
     * The profile, the playlists with the songs loaded (up to CACHE_TRACKS each) and Liked Songs
     * (up to CACHE_LIKED), as last seen: shown at once at start, so the lists are there before
     * Spotify answers, and refreshed from Spotify right after. Tied to the account (its user id),
     * dropped at logout. No tokens in it. */

    _cachePath() {
        return this.ctx && this.ctx.dataDir ? path.join(this.ctx.dataDir, 'spotify_cache.json') : null;
    }

    _loadCache() {
        const p = this._cachePath();
        if (!p || !fs.existsSync(p)) return;
        try {
            const c = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!c || c.v !== 1 || !c.userId) return;
            this._cacheUser = c.userId;
            this._userId = c.userId;
            if (c.profile) this.profile = c.profile;
            if (Array.isArray(c.playlists) && c.playlists.length) {
                // songs from the cache are fetched again when shown (_refresh); no "more" until then
                this.playlists = c.playlists.map((pl) => Object.assign({}, pl, {
                    tracks: pl.tracks || [], tracksLoaded: !!pl.tracks, _refresh: true, _offset: 0, _total: 0,
                }));
                this.currentPlaylist = this.playlists[0];
            }
            if (Array.isArray(c.likedSongs) && c.likedSongs.length) {
                this.likedSongs = c.likedSongs;
                this.likedTotal = c.likedTotal || c.likedSongs.length;
                this._likedOffset = this.likedTotal;        // the next pages come after the refresh
            }
            this.log.info('Spotify: library from the cache (' + this.playlists.length + ' playlists, '
                + this.likedSongs.length + ' liked songs, ' + Math.round((Date.now() - (c.savedAt || 0)) / 60000) + ' min old)');
        } catch (e) {
            this.log.warn('Spotify cache unreadable: ' + e.message);
        }
    }

    _saveCacheSoon() {
        if (this._cacheTimer || !this._cachePath()) return;
        this._cacheTimer = setTimeout(() => { this._cacheTimer = null; this._saveCache(); }, 3000);
    }

    _saveCache() {
        const p = this._cachePath();
        if (!p || !this.token || !this._userId) return;
        const slim = (t) => ({ id: t.id, title: t.title, artist: t.artist, album: t.album, albumArt: t.albumArt, durationMs: t.durationMs, uri: t.uri });
        const data = {
            v: 1, savedAt: Date.now(), userId: this._userId, profile: this.profile || null,
            playlists: this.playlists
                .filter((pl) => pl && pl.id && !String(pl.uri || '').startsWith('spotify:playlist:demo'))
                .map((pl) => ({
                    id: pl.id, name: pl.name, description: pl.description, trackCount: pl.trackCount, uri: pl.uri, accent: pl.accent,
                    tracks: pl.tracksLoaded ? pl.tracks.slice(0, CACHE_TRACKS).map(slim) : undefined,
                })),
            likedTotal: this.likedTotal || 0,
            likedSongs: (this.likedSongs || []).slice(0, CACHE_LIKED).map(slim),
        };
        try {
            const tmp = p + '.tmp-' + process.pid;
            fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(tmp, p);
        } catch (e) {
            this.log.warn('Spotify cache not saved: ' + e.message);
        }
    }

    _dropCache() {
        clearTimeout(this._cacheTimer);
        this._cacheTimer = null;
        this._cacheUser = null;
        const p = this._cachePath();
        try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
    }

    /**
     * The demo setting changed while the app runs. On: the demo's playlists, devices and song,
     * unless an account is paired (its own library shows then, as at start). Off: every trace of the
     * demo goes (its playlists, devices, song and device name); a paired account's library comes in.
     */
    setDemoMode(on) {
        on = !!on;
        if (on === this.isDemoMode) return;
        this.isDemoMode = on;
        const demoTracks = DEMO_PLAYLISTS.reduce((all, p) => all.concat(p.tracks), []);
        if (on) {
            if (this.isAuthenticated()) return;
            this.playlists = DEMO_PLAYLISTS;
            this.devices = DEMO_DEVICES;
            this.currentPlaylist = this.playlists[0];
            this.currentTrack = this.currentPlaylist.tracks[0];
            this.trackIndex = 0;
            this.progressMs = 0;
            this.activeDevice = DEMO_DEVICE_NAME;
            this.log.info('Spotify: demo mode on');
            return;
        }
        if (this.playlists === DEMO_PLAYLISTS) { this.playlists = []; this.currentPlaylist = null; }
        if (this.devices === DEMO_DEVICES) this.devices = [];
        const demoPlays = this.currentTrack && demoTracks.indexOf(this.currentTrack) >= 0;
        if (demoPlays || !this.isAuthenticated()) this.clearPlayback('demo mode off');
        this.trackIndex = 0;
        this.log.info('Spotify: demo mode off');
        if (this.isAuthenticated()) {
            if (!this.playlists.length) this._loadCache();
            this.initialFetch();
        }
    }

    reloadAuth() {
        this._loadAuth();
        if (this.isAuthenticated()) {
            this.initialFetch();
        }
    }

    logout() {
        this.token = null;
        this.refreshToken = null;
        this.expiresAt = 0;
        this.isOnline = false;
        this.clearPlayback('logged out');
        // nothing of the account stays on screen (the demo keeps its own data)
        this.playlists = this.isDemoMode ? DEMO_PLAYLISTS : [];
        this.likedSongs = [];
        this.likedTotal = 0;
        this._userId = null;
        this.profile = null;
        this._lastDeviceId = null;
        this.devices = this.isDemoMode ? DEMO_DEVICES : [];
        this.currentPlaylist = this.playlists[0] || null;
        this.currentTrack = this.isDemoMode && this.currentPlaylist ? this.currentPlaylist.tracks[0] : null;
        this.trackIndex = 0;
        this.shuffle = false;
        this.repeat = 'off';
        this.lastPlaylistsFetch = 0;
        this.lastLikedFetch = 0;
        try { this.agent.destroy(); } catch (e) {}
        this.agent = tlsDates.agent();

        this._forgetAuthFiles();
        this._dropCache();

        this.log.info('Logged out from Spotify');
    }

    /** Nothing is playing any more (no active device, or logged out): clear "now playing". */
    clearPlayback(reason) {
        const had = !!(this.currentTrack || this.isPlaying || this.activeDevice);
        this.isPlaying = false;
        this.stalled = false;
        this._stall = null;
        this.currentTrack = null;
        this.contextUri = null;
        this.progressMs = 0;
        this.activeDevice = null;
        this.remoteQueue = [];
        this.isCurrentLiked = false;
        this._lastCheckedTrackId = null;
        this.devices = (this.devices || []).map((d) => Object.assign({}, d, { isActive: false }));
        if (had) this.log.info('Spotify: now playing cleared (' + reason + ')');
    }

    /**
     * A command was sent: polls already on the way would show the old state, and Spotify itself
     * may answer with the old state for a moment. expect: { playing } or { notTrackId } to hold
     * for HOLD_MS unless Spotify confirms it sooner.
     */
    _cmd(expect) {
        this._lastCmdAt = Date.now();
        this._expect = expect ? Object.assign({ until: Date.now() + 1500 }, expect) : null;
    }

    _pollSoon(ms) {
        setTimeout(() => this.pollPlayer(), ms || 250);
    }

    _forgetAuthFiles() {
        this._authPaths().forEach(p => {
            try {
                if (fs.existsSync(p)) {
                    updateAuthFile(p, (existing) => {
                        delete existing.token;
                        delete existing.refreshToken;
                        delete existing.expiresAt;
                        delete existing.lastDeviceId;      // the account's device: gone with it
                        return existing;
                    });
                }
            } catch (e) {}
        });
    }

    /* One refresh at a time: pollPlayer and fetchDevices both hit 401 together, and a
     * second refresh with the same (possibly rotated) refresh token would be refused. */
    refreshAccessToken() {
        if (this._refreshPromise) return this._refreshPromise;
        if (!this.refreshToken || !this.clientId) return Promise.resolve(false);
        if (this._refreshFailedAt && Date.now() - this._refreshFailedAt < REFRESH_RETRY_MS) return Promise.resolve(false);
        const p = this._refreshOnce().then((ok) => {
            this._refreshPromise = null;
            this._refreshFailedAt = ok ? 0 : Date.now();
            return ok;
        }, () => {
            this._refreshPromise = null;
            this._refreshFailedAt = Date.now();
            return false;
        });
        this._refreshPromise = p;
        return p;
    }

    _refreshOnce() {
        const usedRefreshToken = this.refreshToken;
        const params = {
            grant_type: 'refresh_token',
            refresh_token: usedRefreshToken,
            client_id: this.clientId
        };
        const postData = querystring.stringify(params);

        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData)
        };

        // Basic auth is only used if a clientSecret was explicitly provided (standard OAuth).
        // For PKCE mobile pairing, no secret is used and Spotify expects client_id in the body.
        if (this.clientSecret) {
            headers['Authorization'] = 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
        }

        return new Promise((resolve) => {
            const req = tlsDates.request({
                hostname: 'accounts.spotify.com',
                port: 443,
                path: '/api/token',
                method: 'POST',
                headers: headers,
                timeout: 8000
            }, (res) => {
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => {
                    let parsed = null;
                    try {
                        parsed = JSON.parse(data);
                    } catch (e) {
                        this.log.warn('Spotify token refresh parse error (HTTP ' + res.statusCode + '): ' + e.message);
                        return resolve(false);
                    }
                    if (parsed && parsed.access_token) {
                        this.token = parsed.access_token;
                        this.expiresAt = Date.now() + ((parsed.expires_in || 3600) * 1000);
                        // Spotify may rotate the refresh token; otherwise the old one stays valid
                        if (parsed.refresh_token) this.refreshToken = parsed.refresh_token;
                        this.paired = true;
                        this.isOnline = true;
                        this._persistAuth();
                        this.log.info('Successfully refreshed Spotify access token');
                        return resolve(true);
                    }
                    this.log.warn('Spotify token refresh rejected (HTTP ' + res.statusCode + '): ' + data.slice(0, 200));
                    // Only a definitive invalid_grant for the refresh token still in use ends the session;
                    // anything else (or a token replaced meanwhile by a new pairing) keeps what we have.
                    if (parsed && parsed.error === 'invalid_grant' && this.refreshToken === usedRefreshToken) {
                        this.log.warn('Spotify refresh token revoked; pairing required.');
                        this.token = null;
                        this.refreshToken = null;
                        this.expiresAt = 0;
                        this.paired = false;
                        this._forgetAuthFiles();
                    }
                    resolve(false);
                });
            });
            req.on('error', (err) => {
                this.log.warn('Spotify token refresh network error: ' + err.message);
                resolve(false);
            });
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
            req.write(postData);
            req.end();
        });
    }

    async initialFetch() {
        try {
            // If token is missing, expired, or expiring in less than 60s, refresh first
            if (this.refreshToken && (!this.token || (this.expiresAt && Date.now() >= this.expiresAt - 60000))) {
                await this.refreshAccessToken();
            }
            await this.pollPlayer();
            await this.fetchProfile();
            await this.fetchPlaylists();
            await this.fetchLikedSongs();
            await this.fetchDevices();
            await this.fetchQueue();
        } catch (e) {
            this.log.warn('Initial fetch error: ' + e.message);
        }
    }

    // Call Spotify Web API with Bearer token
    async _request(method, endpoint, body, isRetry, netRetried) {
        if (!this.token) throw new Error('Not authenticated');
        const usedToken = this.token;
        return new Promise((resolve, reject) => {
            const req = tlsDates.request({
                hostname: 'api.spotify.com',
                port: 443,
                path: endpoint,
                method: method,
                agent: this.agent,
                headers: {
                    'Authorization': 'Bearer ' + usedToken,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                timeout: 6000
            }, (res) => {
                this.lastAnswerAt = Date.now();
                if (!this.hasInternet) { this.hasInternet = true; this.lastInternetCheck = this.lastAnswerAt; }
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    if (res.statusCode === 204) return resolve(null);
                    if (res.statusCode === 401 && !isRetry && this.token && this.token !== usedToken) {
                        // refreshed by another caller while this request was out
                        return this._request(method, endpoint, body, true).then(resolve).catch(reject);
                    }
                    if (res.statusCode === 401 && this.refreshToken && !isRetry) {
                        return this.refreshAccessToken().then((refreshed) => {
                            if (refreshed && this.token) {
                                return this._request(method, endpoint, body, true).then(resolve).catch(reject);
                            }
                            if (!this.token) {
                                reject(new Error('Spotify session expired. Please re-authenticate.'));
                            } else {
                                reject(new Error('Spotify token refresh temporarily unavailable.'));
                            }
                        }).catch(reject);
                    }
                    if (res.statusCode === 401 && !this.refreshToken) {
                        if (this.token === usedToken) this.token = null;
                        return reject(new Error('Spotify session expired. Please re-authenticate.'));
                    }
                    try {
                        const json = data ? JSON.parse(data) : {};
                        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
                        else {
                            const err = new Error('Spotify API ' + res.statusCode + ': ' + (json.error ? json.error.message : data));
                            err.status = res.statusCode;
                            err.reason = (json.error && json.error.reason) || '';     // NO_ACTIVE_DEVICE, PREMIUM_REQUIRED...
                            reject(err);
                        }
                    } catch (err) {
                        reject(err);
                    }
                });
            });
            // a kept-alive connection the server closed meanwhile: try once more on a fresh one
            // (not for POST: next / previous must not run twice)
            req.on('error', (err) => {
                const stale = /ECONNRESET|EPIPE|ECONNABORTED|socket hang up/i.test(String((err && (err.code || err.message)) || ''));
                if (stale && !netRetried && method !== 'POST') {
                    this._request(method, endpoint, body, isRetry, true).then(resolve, reject);
                } else {
                    reject(err);
                }
            });
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }

    async pollPlayer() {
        if (!this.token) return;
        const startedAt = Date.now();
        let data;
        try {
            data = await this._request('GET', '/v1/me/player?additional_types=episode');
        } catch (e) {
            return;              // network trouble says nothing about the phone: keep the state
        }
        // a command was sent while this poll was on the way: its answer shows the old state
        if (startedAt < this._lastCmdAt) return;
        this.isOnline = true;
        // 204 (no body) or no active device: the phone left Spotify Connect / went offline.
        // Two polls in a row, so a device switch doesn't blank the screen for a moment.
        if (!data || !data.device || data.device.is_active === false) {
            if (++this._noSession >= 2) this.clearPlayback('no active Spotify device');
            return;
        }
        this._noSession = 0;
        const ex = this._expect && Date.now() < this._expect.until ? this._expect : null;
        const playing = !!data.is_playing;
        const staleTrack = ex && ex.notTrackId && data.item && data.item.id === ex.notTrackId;
        if (ex && ex.playing !== undefined && playing !== ex.playing) return;   // not applied yet
        if (staleTrack) return;
        this._expect = null;
        const now = Date.now();
        const pos = data.progress_ms || 0;
        /*
         * Spotify can report "playing" for a phone that stopped (iOS suspends Spotify in the
         * background, the phone went out of range): its position then stands still, or runs on
         * past the song's end. Shown as paused, so the progress bar does not run on alone.
         */
        let stalled = false;
        const item = data.item;
        if (playing && item) {
            const st = this._stall;
            if (st && st.id === item.id && Math.abs(pos - st.pos) < 300) stalled = now - st.since >= 4000;
            else this._stall = { id: item.id, pos, since: now };
            if (item.duration_ms && pos > item.duration_ms + 3000) stalled = true;
        } else {
            this._stall = null;
        }
        if (stalled && !this.stalled) this.log.info('Spotify: playback stands still on ' + data.device.name + ', shown as paused');
        this.stalled = stalled;
        this.isPlaying = playing && !stalled;
        this.progressMs = item && item.duration_ms ? Math.min(pos, item.duration_ms) : pos;
        this.lastTickTime = now;
        // the device that plays: play commands go to it again when none is active
        if (data.device.id && data.device.id !== this._lastDeviceId) this._rememberDevice(data.device.id);
        // a shuffle / repeat just tapped holds until Spotify reports it (it lags a second or two)
        const hS = this._holdShuffle, hR = this._holdRepeat;
        if (hS && now < hS.until && data.shuffle_state !== hS.v) { /* keep the tapped state */ }
        else { this._holdShuffle = null; this.shuffle = data.shuffle_state; }
        if (hR && now < hR.until && data.repeat_state !== hR.v) { /* keep the tapped state */ }
        else { this._holdRepeat = null; this.repeat = data.repeat_state; }
        this.activeDevice = decodeHtmlEntities(data.device.name) + ' (' + data.device.type + ')';
        // what plays: the playlist / album / liked songs (its URI), for the "playing" marks
        this.contextUri = (data.context && data.context.uri) || null;
        if (typeof data.device.volume_percent === 'number') this.volume = data.device.volume_percent;
        const it = data.item;
        if (!it) return;         // an ad or a private session: keep the last track shown
        const images = (it.album && it.album.images) || it.images || (it.show && it.show.images) || [];
        const bestArt = images.find((img) => img.width >= 200 && img.width <= 400) || images[0];
        this.currentTrack = {
            id: it.id,
            title: decodeHtmlEntities(it.name),
            artist: decodeHtmlEntities(it.artists ? it.artists.map((a) => a.name).join(', ') : (it.show ? it.show.name : '')),
            album: decodeHtmlEntities(it.album ? it.album.name : (it.show ? it.show.name : '')),
            albumArt: bestArt ? bestArt.url : '',
            durationMs: it.duration_ms,
            uri: it.uri,
        };
        if (it.id && it.id !== this._lastCheckedTrackId) {
            this._lastCheckedTrackId = it.id;
            if (it.type !== 'episode') this.checkTrackLiked(it.id); else this.isCurrentLiked = false;
            this.fetchQueue().catch(() => {});        // the queue changes with the track
        }
    }

    async fetchPlaylists() {
        if (!this.token) return;
        this.isLoadingPlaylists = true;
        this.lastPlaylistsFetch = Date.now();
        try {
            // every page (50 a page, up to 300 playlists), not only the first 25
            let items = [], offset = 0, total = 0, got = false;
            do {
                const res = await this._request('GET', '/v1/me/playlists?limit=50&offset=' + offset);
                if (!res || !res.items) break;
                got = true;
                items = items.concat(res.items.filter(Boolean));
                total = res.total || items.length;
                offset += res.items.length;
                if (!res.next || !res.items.length) break;
            } while (offset < Math.min(total, 300));
            if (got) {
                const list = items.map((pl, i) => {
                    const count = pl.tracks ? (pl.tracks.total != null ? pl.tracks.total : 0) : (pl.items ? (pl.items.total != null ? pl.items.total : 0) : 0);
                    return {
                        id: pl.id,
                        name: decodeHtmlEntities(pl.name),
                        description: decodeHtmlEntities(pl.description || 'User playlist'),
                        trackCount: count,
                        uri: pl.uri,
                        accent: ['#1db954', '#e1001a', '#81c4ff', '#ff9d00', '#1ed760'][i % 5],
                        tracks: []
                    };
                });
                // a refetch keeps the songs already loaded (the screen may show one of them)
                const old = {};
                (this.playlists || []).forEach((p) => { if (p && p.id) old[p.id] = p; });
                list.forEach((p) => {
                    const o = old[p.id];
                    if (o && o.tracksLoaded) {
                        p.tracks = o.tracks; p.tracksLoaded = true; p._refresh = o._refresh;
                        p._offset = o._offset; p._total = o._total; p._itemsPath = o._itemsPath;
                    }
                });
                this.playlists = list;
                const cur = this.currentPlaylist && list.find((p) => p.id === this.currentPlaylist.id);
                if (list.length) this.selectPlaylist(cur || list[0]);
                this._saveCacheSoon();
            }
        } catch (e) {
            this.log.warn('Fetch playlists error: ' + e.message);
        } finally {
            this.isLoadingPlaylists = false;
        }
    }

    /**
     * The songs of a playlist the screen shows: fetched when missing, once at a time, and again
     * 5 s after a failure (at startup the first one can fail while the token is refreshed).
     */
    ensureTracks(playlist) {
        if (!this.token || !playlist || !playlist.id) return;
        // the built-in demo playlists come with their songs (the demo setting itself says nothing:
        // logged in, the account's own playlists show with it on too)
        if (playlist.uri && playlist.uri.startsWith('spotify:playlist:demo')) return;
        // loaded (a list from the cache: loaded again once, shown meanwhile), or loading
        if ((playlist.tracksLoaded && !playlist._refresh) || playlist._loadingTracks) return;
        if (playlist._tracksFailedAt && Date.now() - playlist._tracksFailedAt < 5000) return;
        this.fetchTracksForPlaylist(playlist);
    }

    /** A page of a playlist's songs (/items, or /tracks where /items is not served). */
    async _playlistPage(playlist, offset) {
        const q = '?limit=50&offset=' + offset;
        if (playlist._itemsPath) return this._request('GET', playlist._itemsPath + q);
        try {
            const res = await this._request('GET', `/v1/playlists/${playlist.id}/items` + q);
            playlist._itemsPath = `/v1/playlists/${playlist.id}/items`;
            return res;
        } catch (err) {
            const res = await this._request('GET', `/v1/playlists/${playlist.id}/tracks` + q);
            playlist._itemsPath = `/v1/playlists/${playlist.id}/tracks`;
            return res;
        }
    }

    async fetchTracksForPlaylist(playlist) {
        if (!this.token || !playlist || !playlist.id) return;
        playlist._loadingTracks = true;
        try {
            const res = await this._playlistPage(playlist, 0);
            if (res && res.items) {
                playlist.tracks = res.items.map((item) => mapTrack(item.item || item.track)).filter(Boolean);
                playlist._offset = res.items.length;
                playlist._total = res.total != null ? res.total : res.items.length;
                if ((!playlist.trackCount || playlist.trackCount === 0) && playlist.tracks.length > 0) {
                    playlist.trackCount = playlist._total || playlist.tracks.length;
                }
                if (this.isDemoMode && !this.currentTrack && playlist.tracks[0]) {
                    this.currentTrack = playlist.tracks[0];
                }
                playlist.tracksLoaded = true;
                playlist._refresh = false;
                playlist._tracksFailedAt = 0;
                this._saveCacheSoon();
            } else {
                playlist._tracksFailedAt = Date.now();
            }
        } catch (e) {
            playlist._tracksFailedAt = Date.now();
            this.log.warn('Fetch tracks error (' + playlist.name + '): ' + e.message);
        } finally {
            playlist._loadingTracks = false;
        }
    }

    /** The playlist has more songs than loaded. */
    hasMoreTracks(playlist) {
        return !!(playlist && playlist.tracksLoaded && this.token && (playlist._offset || 0) < (playlist._total || 0));
    }

    /** The playlist's next page of songs (its list scrolled near the end): once at a time. */
    async loadMoreTracks(playlist) {
        if (!this.hasMoreTracks(playlist) || playlist._loadingMore) return;
        if (playlist._moreFailedAt && Date.now() - playlist._moreFailedAt < 5000) return;
        playlist._loadingMore = true;
        const offset = playlist._offset;
        try {
            const res = await this._playlistPage(playlist, offset);
            if (res && res.items && playlist._offset === offset) {
                playlist.tracks = playlist.tracks.concat(res.items.map((item) => mapTrack(item.item || item.track)).filter(Boolean));
                playlist._offset = offset + res.items.length;
                if (res.total != null) playlist._total = res.total;
                if (!res.items.length) playlist._offset = playlist._total;
            }
        } catch (e) {
            playlist._moreFailedAt = Date.now();
            this.log.warn('Fetch more tracks error (' + playlist.name + '): ' + e.message);
        } finally {
            playlist._loadingMore = false;
        }
    }

    async fetchDevices() {
        if (!this.token) return;
        try {
            const res = await this._request('GET', '/v1/me/player/devices');
            if (res && Array.isArray(res.devices)) {
                this.devices = res.devices.map((d) => ({
                    id: d.id,
                    name: decodeHtmlEntities(d.name),
                    type: d.type,
                    isActive: d.is_active,
                    volume: d.volume_percent
                }));
                // the active device comes from the player poll; none active here = nothing playing
                if (!this.devices.some((d) => d.isActive) && this._noSession > 0) this.activeDevice = null;
            }
        } catch (e) {
            //
        }
    }

    /** Liked Songs, the first page (a refetch, after a like, starts over). More come with loadMoreLiked(). */
    async fetchLikedSongs() {
        if (!this.token) return;
        this.isLoadingLiked = true;
        this.lastLikedFetch = Date.now();
        try {
            const res = await this._request('GET', '/v1/me/tracks?limit=50');
            if (res && res.items) {
                this.likedTotal = res.total || res.items.length;
                this.likedSongs = res.items.map((item) => mapTrack(item.track)).filter(Boolean);
                this._likedOffset = res.items.length;
                this._saveCacheSoon();
            }
        } catch (e) {
            this.log.warn('Fetch liked songs error: ' + e.message);
        } finally {
            this.isLoadingLiked = false;
        }
    }

    /** More Liked Songs are there than loaded. */
    hasMoreLiked() {
        // a token means the account's own songs show (the demo setting on or not)
        return !!this.token && (this._likedOffset || 0) < (this.likedTotal || 0);
    }

    /** The next page of Liked Songs (the list scrolled near its end): once at a time. */
    async loadMoreLiked() {
        if (!this.hasMoreLiked() || this.isLoadingMoreLiked || this.isLoadingLiked) return;
        if (this._likedMoreFailedAt && Date.now() - this._likedMoreFailedAt < 5000) return;
        this.isLoadingMoreLiked = true;
        const offset = this._likedOffset;
        try {
            const res = await this._request('GET', '/v1/me/tracks?limit=50&offset=' + offset);
            // a refetch started over meanwhile: this page belongs to the old list
            if (res && res.items && this._likedOffset === offset) {
                const have = new Set(this.likedSongs.map((t) => t.id));
                this.likedSongs = this.likedSongs.concat(res.items.map((item) => mapTrack(item.track)).filter((t) => t && !have.has(t.id)));
                this._likedOffset = offset + res.items.length;
                if (res.total) this.likedTotal = res.total;
                if (!res.items.length) this._likedOffset = this.likedTotal;      // nothing more after all
            }
        } catch (e) {
            this._likedMoreFailedAt = Date.now();
            this.log.warn('Fetch more liked songs error: ' + e.message);
        } finally {
            this.isLoadingMoreLiked = false;
        }
    }

    async fetchQueue() {
        if (!this.token) return;
        try {
            const res = await this._request('GET', '/v1/me/player/queue');
            if (res && res.queue) {
                this.remoteQueue = res.queue
                    .filter((t) => t && t.id)
                    .map((t) => {
                        const albumImages = (t.album && t.album.images) || [];
                        const bestArt = albumImages.find((img) => img.width >= 200 && img.width <= 400) || albumImages[0];
                        return {
                            id: t.id,
                            title: decodeHtmlEntities(t.name),
                            artist: decodeHtmlEntities((t.artists || []).map((a) => a.name).join(', ')),
                            album: decodeHtmlEntities(t.album ? t.album.name : ''),
                            albumArt: bestArt ? bestArt.url : '',
                            durationMs: t.duration_ms,
                            uri: t.uri
                        };
                    });
            }
        } catch (e) {
            //
        }
    }

    playLikedSong(index) {
        if (!this.likedSongs || !this.likedSongs[index]) return;
        const trk = this.likedSongs[index];
        this.currentTrack = trk;
        this.isPlaying = true;
        this.progressMs = 0;
        this.lastTickTime = Date.now();
        if (this.isOnline) {
            const fallback = () => {
                // a bare track list: the phone (iOS) drops this one as often as not
                const uris = this.likedSongs.slice(index, index + 30).map((t) => t.uri);
                return this._play({ uris });
            };
            this._cmd();
            // Liked Songs as a real context, as Spotify's own apps play it: the phone keeps it
            // (a list of URIs made the iPhone stop and drop "now playing") and it plays on
            // past the 50 songs loaded here
            return this._likedContextUri().then((ctx) => ctx
                ? this._play({ context_uri: ctx, offset: { uri: trk.uri } }).catch((e) => {
                    if (this._isNoDevice(e) || e.status === 403 || e.status === 429) throw e;   // a track list would fail too
                    this.log.warn('Liked Songs context refused (' + e.message + '), playing as a track list');
                    return fallback();
                })
                : fallback()
            ).then(() => this._pollSoon(400), (e) => {
                this.isPlaying = false;
                this._fail('Playing the song', e);      // and the poll shows what really plays
            });
        }
    }

    /** The account: its id (for Liked Songs as a context) and, for the Connect page, its name and plan. */
    async fetchProfile() {
        if (!this.token) return null;
        try {
            const me = await this._request('GET', '/v1/me');
            if (me && me.id) {
                // the cache shown at start was another account's (a new pairing): not shown any more
                if (this._cacheUser && this._cacheUser !== me.id) {
                    this.log.info('Spotify: another account - the cached library is dropped');
                    this.playlists = []; this.likedSongs = []; this.likedTotal = 0; this.currentPlaylist = null;
                    this._dropCache();
                }
                this._cacheUser = me.id;
                this._userId = me.id;
                this.profile = {
                    name: decodeHtmlEntities(me.display_name || me.id),
                    product: me.product || '',          // premium | free | open
                };
                this._saveCacheSoon();
            }
        } catch (e) {
            this.log.warn('Fetch profile error: ' + e.message);
        }
        return this.profile;
    }

    /** spotify:user:<id>:collection, the account's Liked Songs as a context (null if the id is unknown). */
    async _likedContextUri() {
        if (!this._userId) await this.fetchProfile();
        return this._userId ? 'spotify:user:' + this._userId + ':collection' : null;
    }

    // Tick called every frame
    /** How often the player is polled: the "pollRate" setting in seconds (1 to 10, default 2). */
    syncMs() {
        const v = Number(this.ctx.settings && this.ctx.settings.get('pollRate'));
        return (isFinite(v) && v > 0 ? Math.max(1, Math.min(10, v)) : 2) * 1000;
    }

    tick() {
        const now = Date.now();
        const dt = now - this.lastTickTime;
        this.lastTickTime = now;

        // Auto-refresh token if missing (only a refresh token is left) or expiring within 2 minutes;
        // refreshAccessToken() is single-flight and backs off after a failure
        if (this.refreshToken && (!this.token || (this.expiresAt && now >= this.expiresAt - 120000)) && !this.refreshing) {
            this.refreshing = true;
            this.refreshAccessToken().then(() => {
                this.refreshing = false;
            }).catch(() => {
                this.refreshing = false;
            });
        }

        // Player state at the "Playback sync rate" setting (1 to 10 s), devices every 5 s (or the sync
        // rate, if slower). tick() runs from the render loop, which runs only while the Spotify screen
        // is shown: nothing is polled in the background.
        const syncMs = this.syncMs();
        if (this.token && now - this.lastSync > syncMs - 50 && !this.syncing) {
            this.lastSync = now;
            this.syncing = true;
            const done = () => { this.syncing = false; };
            this.pollPlayer().then(done, done);
        }
        if (this.token && now - this.lastDeviceSync > Math.max(5000, syncMs) && !this.syncingDevices) {
            this.lastDeviceSync = now;
            this.syncingDevices = true;
            const done = () => { this.syncingDevices = false; };
            this.fetchDevices().then(done, done);
        }

        // Retry playlists if online and authenticated, but none loaded yet
        if (this.token && this.playlists.length === 0 && !this.isLoadingPlaylists && (now - this.lastPlaylistsFetch > 10000)) {
            this.lastPlaylistsFetch = now;
            this.fetchPlaylists().catch(() => {});
        }

        // Retry liked songs if online and authenticated, but none loaded yet
        if (this.token && this.likedSongs.length === 0 && !this.isLoadingLiked && (now - this.lastLikedFetch > 10000)) {
            this.lastLikedFetch = now;
            this.fetchLikedSongs().catch(() => {});
        }

        // Local progress interpolation between poll ticks
        if (this.isPlaying && this.currentTrack) {
            this.progressMs += dt;
            if (this.progressMs >= this.currentTrack.durationMs) {
                if (!this.isOnline) this.nextTrack();
                else this.progressMs = this.currentTrack.durationMs;    // the poll brings the next song
            }
        }
    }

    /* ---------- What the screen tells the driver ---------- */

    /** A short message for the screen (shown a few seconds): what went wrong, in plain words. */
    notify(text) {
        this.notice = { text, at: Date.now() };
        this.log.info('Spotify notice: ' + text);
    }

    /** A failed command: logged, explained on the screen, and the real state polled at once. */
    _fail(what, e) {
        this.log.warn(what + ' failed: ' + (e && e.message));
        this.notify(this._explain(what, e));
        this._pollSoon(100);
    }

    /** Spotify's error as a sentence for the driver. */
    _explain(what, e) {
        const msg = String((e && e.message) || ''), st = (e && e.status) || 0, why = (e && e.reason) || '';
        if (why === 'NO_ACTIVE_DEVICE' || (st === 404 && /no active device/i.test(msg))) return 'No device to play on - open Spotify on your phone';
        if (st === 404 && /device/i.test(msg)) return 'That device is not available any more';
        if (why === 'PREMIUM_REQUIRED' || /premium/i.test(msg)) return 'Spotify Premium is needed to control playback';
        if (st === 403) return what + ' is not possible here (Spotify said no)';
        if (st === 429) return 'Spotify is busy - try again in a moment';
        if (st >= 500) return 'Spotify had a problem - try again';
        if (/session expired|re-authenticate/i.test(msg)) return 'Spotify session expired - pair again on the Connect page';
        if (/timeout|ECONN|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up/i.test(msg + ' ' + ((e && e.code) || ''))) {
            return 'No connection to Spotify - ' + what.toLowerCase() + ' did not go through';
        }
        return what + ' failed';
    }

    _isNoDevice(e) {
        return !!e && (e.reason === 'NO_ACTIVE_DEVICE' || (e.status === 404 && /device/i.test(String(e.message))));
    }

    /** The device that played last, kept with the pairing (not the tokens), for after a restart. */
    _rememberDevice(id) {
        this._lastDeviceId = id;
        const p = this.ctx && this.ctx.dataDir ? path.join(this.ctx.dataDir, 'spotify_auth.json') : null;
        if (!p || !fs.existsSync(p)) return;
        try { updateAuthFile(p, (ex) => { ex.lastDeviceId = id; return ex; }); } catch (e) {}
    }

    /** Where a play command goes: the active device, else the one that played last, else the first listed. */
    _targetDeviceId() {
        const d = this.devices.find((x) => x.isActive)
            || (this._lastDeviceId && this.devices.find((x) => x.id === this._lastDeviceId))
            || this.devices[0];
        return d && d.id ? d.id : null;
    }

    /**
     * PUT /v1/me/player/play (body: what to play, none to resume). With no active device Spotify
     * answers 404: the device list is read again and the command sent once more to a listed device
     * (the phone's Spotify open but idle). Rejects when there is none: the caller explains it.
     */
    async _play(body) {
        const send = (id) => this._request('PUT', '/v1/me/player/play' + (id ? '?device_id=' + encodeURIComponent(id) : ''), body);
        const first = this._targetDeviceId();
        try {
            return await send(first);
        } catch (e) {
            if (!this._isNoDevice(e)) throw e;
            await this.fetchDevices();
            const id = this._targetDeviceId();
            if (!id || (id === first && this.devices.some((d) => d.id === id && d.isActive))) throw e;
            this.log.info('Spotify: no active device, starting on ' + ((this.devices.find((d) => d.id === id) || {}).name || id));
            return send(id);
        }
    }

    // Remote Commands
    play() {
        this.isPlaying = true;
        this.lastTickTime = Date.now();
        if (this.isOnline) {
            this._cmd({ playing: true });
            this._stall = null;
            return this._play().then(() => this._pollSoon(), (e) => { this.isPlaying = false; this._fail('Play', e); });
        }
        return Promise.resolve();
    }

    pause() {
        this.isPlaying = false;
        if (this.isOnline) {
            this._cmd({ playing: false });
            return this._request('PUT', '/v1/me/player/pause').then(() => this._pollSoon(), (e) => this._fail('Pause', e));
        }
        return Promise.resolve();
    }

    /* The commands below return a promise that settles when Spotify has answered (never rejects):
     * the screen shows the button busy until then. */
    togglePlay() {
        return this.isPlaying ? this.pause() : this.play();
    }

    nextTrack() {
        if (this.isOnline) {
            this._cmd(this.currentTrack && this.currentTrack.id ? { notTrackId: this.currentTrack.id } : null);
            // show the next queued track at once; the poll after the command confirms it
            if (this.remoteQueue && this.remoteQueue.length) {
                this.currentTrack = this.remoteQueue.shift();
                this.progressMs = 0;
                this.lastTickTime = Date.now();
            }
            return this._request('POST', '/v1/me/player/next').then(() => this._pollSoon(), (e) => this._fail('Skip', e));
        }
        const pl = this.currentPlaylist;
        if (!pl || !pl.tracks.length) return;
        this.trackIndex = (this.trackIndex + 1) % pl.tracks.length;
        this.currentTrack = pl.tracks[this.trackIndex];
        this.progressMs = 0;
        this.lastTickTime = Date.now();
    }

    prevTrack() {
        if (this.isOnline) {
            this._cmd();
            this.progressMs = 0;
            this.lastTickTime = Date.now();
            return this._request('POST', '/v1/me/player/previous').then(() => this._pollSoon(), (e) => this._fail('Previous', e));
        }
        if (this.progressMs > 3000) {
            this.progressMs = 0;
            return;
        }
        const pl = this.currentPlaylist;
        if (!pl || !pl.tracks.length) return;
        this.trackIndex = (this.trackIndex - 1 + pl.tracks.length) % pl.tracks.length;
        this.currentTrack = pl.tracks[this.trackIndex];
        this.progressMs = 0;
        this.lastTickTime = Date.now();
    }

    /*
     * Shuffle and repeat show the new state at once and keep it (4 s) against polls
     * that still bring the old one: without that a tap seemed to miss, the button flipping back.
     * A refused command (a free account, a device that does not take it) lets the poll put it back.
     */
    toggleShuffle() {
        this.shuffle = !this.shuffle;
        if (this.isOnline) {
            this._holdShuffle = { v: this.shuffle, until: Date.now() + 4000 };
            return this._request('PUT', '/v1/me/player/shuffle?state=' + this.shuffle).then(() => this._pollSoon(600), (e) => {
                this._holdShuffle = null;
                this._fail('Shuffle', e);
            });
        }
    }

    toggleRepeat() {
        const modes = ['off', 'context', 'track'];
        const next = modes[(modes.indexOf(this.repeat) + 1) % modes.length];
        this.repeat = next;
        if (this.isOnline) {
            this._holdRepeat = { v: next, until: Date.now() + 4000 };
            return this._request('PUT', '/v1/me/player/repeat?state=' + next).then(() => this._pollSoon(600), (e) => {
                this._holdRepeat = null;
                this._fail('Repeat', e);
            });
        }
    }

    /* Liked or not: Spotify's library endpoints (/v1/me/library, by URI). The older
     * /v1/me/tracks/contains answers 403 now, which left the heart empty on liked songs. */
    async checkTrackLiked(trackId) {
        if (!this.token || !trackId) return;
        const uri = 'spotify:track:' + trackId;
        try {
            const res = await this._request('GET', '/v1/me/library/contains?uris=' + encodeURIComponent(uri));
            // the track changed meanwhile: this answer is about another song
            if (Array.isArray(res) && this.currentTrack && this.currentTrack.id === trackId) {
                this.isCurrentLiked = !!res[0];
            }
        } catch (e) {
            this.log.warn('Liked check failed: ' + e.message);
        }
    }

    async toggleLikeCurrent() {
        if (!this.currentTrack || !this.currentTrack.id) return;
        const id = this.currentTrack.id;
        const like = !this.isCurrentLiked;
        this.isCurrentLiked = like;
        if (!this.isOnline) return;
        const method = like ? 'PUT' : 'DELETE';
        const uri = 'spotify:track:' + id;
        try {
            await this._request(method, '/v1/me/library?uris=' + encodeURIComponent(uri)).catch((e) => {
                this.log.warn('Library ' + method + ' refused (' + e.message + '), trying /v1/me/tracks');
                return this._request(method, '/v1/me/tracks?ids=' + id);
            });
            this.fetchLikedSongs().catch(() => {});
        } catch (e) {
            if (this.currentTrack && this.currentTrack.id === id) this.isCurrentLiked = !like;   // show the truth
            this.log.warn((like ? 'Like' : 'Unlike') + ' failed: ' + e.message);
            this.notify(this._explain(like ? 'Saving to Liked Songs' : 'Removing from Liked Songs', e));
        }
    }

    selectPlaylist(playlist) {
        this.currentPlaylist = playlist;
        this.ensureTracks(playlist);
    }

    playTrack(playlist, index) {
        this.currentPlaylist = playlist;
        this.trackIndex = index;
        if (playlist.tracks && playlist.tracks[index]) {
            this.currentTrack = playlist.tracks[index];
            this.progressMs = 0;
            this.lastTickTime = Date.now();
            this.isPlaying = true;

            if (this.isOnline && this.currentTrack.uri) {
                // Play specific track in playlist context
                const body = playlist.uri && !playlist.uri.startsWith('spotify:playlist:demo')
                    ? { context_uri: playlist.uri, offset: { position: index } }
                    : { uris: [this.currentTrack.uri] };
                this._cmd();
                return this._play(body).then(() => this._pollSoon(400), (e) => {
                    this.isPlaying = false;
                    this._fail('Playing the song', e);
                });
            }
        }
    }

    /** Jump to positionMs in the song that plays. */
    seek(positionMs) {
        const dur = this.currentTrack && this.currentTrack.durationMs;
        if (!dur) return Promise.resolve();
        const pos = Math.max(0, Math.min(dur - 1000, Math.round(positionMs)));
        this.progressMs = pos;
        this.lastTickTime = Date.now();
        if (!this.isOnline) return Promise.resolve();
        this._cmd();
        return this._request('PUT', '/v1/me/player/seek?position_ms=' + pos)
            .then(() => this._pollSoon(400), (e) => this._fail('Seeking', e));
    }

    /**
     * A song from Up Next: played on in what plays now (its playlist / album / Liked Songs, from that
     * song on), or alone where the context does not have it (a song queued by hand).
     */
    playQueued(trk) {
        if (!trk || !trk.uri) return Promise.resolve();
        this.currentTrack = trk;
        this.isPlaying = true;
        this.progressMs = 0;
        this.lastTickTime = Date.now();
        if (!this.isOnline) return Promise.resolve();
        const ctx = this.contextUri;
        const alone = () => this._play({ uris: [trk.uri] });
        this._cmd();
        return (ctx ? this._play({ context_uri: ctx, offset: { uri: trk.uri } }).catch((e) => {
            if (this._isNoDevice(e) || e.status === 403 || e.status === 429) throw e;
            return alone();
        }) : alone())
            .then(() => this._pollSoon(400), (e) => { this.isPlaying = false; this._fail('Playing the song', e); });
    }

    /* Settles once the device list shows where the music went (busy until then on the screen). */
    transferToDevice(deviceId) {
        if (!this.isOnline) return Promise.resolve();
        return this._request('PUT', '/v1/me/player', { device_ids: [deviceId], play: true })
            .then(() => new Promise((r) => setTimeout(r, 500)))
            .then(() => Promise.all([this.fetchDevices(), this.pollPlayer()]))
            .catch((e) => this._fail('Switching the device', e));
    }

    getPlaylists() {
        return this.playlists;
    }

    getDevices() {
        return this.devices;
    }
}

module.exports = {
    SpotifyClient,
    updateAuthFile,
    DEMO_PLAYLISTS,
    DEMO_DEVICES
};
