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
const tlsDates = require('./tls_dates');

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
        .replace(/&gt;/g, '>');
}

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
        this.activeDevice = 'BMW iDrive 7';
        this.lastSync = 0;
        this.syncing = false;

        // Internet connection monitoring
        this.hasInternet = (ctx.settings && ctx.settings.get('net') === 'off') ? false : true;
        this.lastInternetCheck = 0;

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
            this.initialFetch();
        }

        // Run initial internet check and schedule periodic check
        this.checkInternetConnection().catch(() => {});
        // re-checked only while the app is on screen (main.js sets isOnScreen)
        if (!this.isOnScreen) this.isOnScreen = () => true;
        setInterval(() => {
            if (this.isOnScreen()) this.checkInternetConnection().catch(() => {});
        }, 12000);
    }

    async checkInternetConnection() {
        if (this.ctx.settings && this.ctx.settings.get('net') === 'off') {
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

    _authPaths() {
        return [
            this.ctx && this.ctx.dataDir ? path.join(this.ctx.dataDir, 'spotify_auth.json') : null,
            path.join(__dirname, 'spotify_auth.json')
        ].filter(Boolean);
    }

    /* Merges the tokens into each spotify_auth.json, keeping what else it holds
     * (the cloud pairing channel and secretKey), written atomically. */
    _persistAuth() {
        this._authPaths().forEach(p => {
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
            } catch (e) {
                this.log.warn('SpotifyClient: Could not save tokens to ' + p + ': ' + e.message);
            }
        });
    }

    _loadAuth() {
        try {
            const dataPath = this.ctx && this.ctx.dataDir ? path.join(this.ctx.dataDir, 'spotify_auth.json') : null;
            const localPath = path.join(__dirname, 'spotify_auth.json');

            // Check dataPath first; if dataPath has no valid tokens, fall back to localPath
            let configPath = null;
            if (dataPath && fs.existsSync(dataPath)) {
                try {
                    const d = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
                    if (d && (d.token || d.refreshToken)) configPath = dataPath;
                } catch (e) {}
            }
            if (!configPath && fs.existsSync(localPath)) {
                configPath = localPath;
            }

            if (configPath && fs.existsSync(configPath)) {
                const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                if (data.token || data.refreshToken) {
                    this.token = data.token;
                    this.refreshToken = data.refreshToken;
                    this.expiresAt = data.expiresAt || 0;
                    this.clientId = data.clientId;
                    this.clientSecret = data.clientSecret;
                    this.isOnline = true;
                    this.log.info('Loaded Spotify auth token from ' + configPath);
                }
            }
        } catch (e) {
            this.log.warn('Could not read auth: ' + e);
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

        this.log.info('Logged out from Spotify');
    }

    /** Nothing is playing any more (no active device, or logged out): clear "now playing". */
    clearPlayback(reason) {
        const had = !!(this.currentTrack || this.isPlaying || this.activeDevice);
        this.isPlaying = false;
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
                        else reject(new Error('Spotify API ' + res.statusCode + ': ' + (json.error ? json.error.message : data)));
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
        this.isPlaying = playing;
        this.progressMs = data.progress_ms || 0;
        this.lastTickTime = Date.now();
        this.shuffle = data.shuffle_state;
        this.repeat = data.repeat_state;
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
            const res = await this._request('GET', '/v1/me/playlists?limit=25');
            if (res && res.items) {
                const list = res.items.map((pl, i) => {
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
                this.playlists = list;
                if (list[0] && (!this.currentPlaylist || !this.currentPlaylist.tracks)) {
                    this.selectPlaylist(list[0]);
                }
            }
        } catch (e) {
            this.log.warn('Fetch playlists error: ' + e.message);
        } finally {
            this.isLoadingPlaylists = false;
        }
    }

    async fetchTracksForPlaylist(playlist) {
        if (!this.token || !playlist || !playlist.id) return;
        try {
            let res = null;
            try {
                res = await this._request('GET', `/v1/playlists/${playlist.id}/items?limit=50`);
            } catch (err) {
                res = await this._request('GET', `/v1/playlists/${playlist.id}/tracks?limit=50`);
            }
            if (res && res.items) {
                playlist.tracks = res.items
                    .map((item) => {
                        const t = item.item || item.track;
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
                    })
                    .filter(Boolean);

                if ((!playlist.trackCount || playlist.trackCount === 0) && playlist.tracks.length > 0) {
                    playlist.trackCount = playlist.tracks.length;
                }
                if (this.isDemoMode && !this.currentTrack && playlist.tracks[0]) {
                    this.currentTrack = playlist.tracks[0];
                }
            }
        } catch (e) {
            this.log.warn('Fetch tracks error: ' + e.message);
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

    async fetchLikedSongs() {
        if (!this.token) return;
        this.isLoadingLiked = true;
        this.lastLikedFetch = Date.now();
        try {
            const res = await this._request('GET', '/v1/me/tracks?limit=50');
            if (res && res.items) {
                this.likedTotal = res.total || res.items.length;
                this.likedSongs = res.items
                    .filter((item) => item.track && item.track.id)
                    .map((item) => {
                        const t = item.track;
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
            this.log.warn('Fetch liked songs error: ' + e.message);
        } finally {
            this.isLoadingLiked = false;
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
            const targetDev = this.devices.find((d) => d.isActive) || this.devices[0];
            const deviceParam = (targetDev && targetDev.id) ? `?device_id=${targetDev.id}` : '';
            const uris = this.likedSongs.slice(index, index + 30).map((t) => t.uri);
            this._cmd();
            this._request('PUT', `/v1/me/player/play${deviceParam}`, { uris }).then(() => this._pollSoon(400), () => {});
        }
    }

    // Tick called every frame
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

        // Player state every second, devices every 5 s. tick() runs from the render loop, which
        // runs only while the Spotify screen is shown: nothing is polled in the background.
        if (this.token && now - this.lastSync > 1000 && !this.syncing) {
            this.lastSync = now;
            this.syncing = true;
            const done = () => { this.syncing = false; };
            this.pollPlayer().then(done, done);
        }
        if (this.token && now - this.lastDeviceSync > 5000 && !this.syncingDevices) {
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
            }
        }
    }

    // Remote Commands
    play() {
        this.isPlaying = true;
        this.lastTickTime = Date.now();
        if (this.isOnline) {
            this._cmd({ playing: true });
            this._request('PUT', '/v1/me/player/play').then(() => this._pollSoon(), () => {});
        }
    }

    pause() {
        this.isPlaying = false;
        if (this.isOnline) {
            this._cmd({ playing: false });
            this._request('PUT', '/v1/me/player/pause').then(() => this._pollSoon(), () => {});
        }
    }

    togglePlay() {
        if (this.isPlaying) this.pause();
        else this.play();
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
            this._request('POST', '/v1/me/player/next').then(() => this._pollSoon(), () => {});
            return;
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
            this._request('POST', '/v1/me/player/previous').then(() => this._pollSoon(), () => {});
            return;
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

    seek(fraction) {
        if (!this.currentTrack) return;
        const pos = Math.round(Math.max(0, Math.min(1, fraction)) * this.currentTrack.durationMs);
        this.progressMs = pos;
        this.lastTickTime = Date.now();
        if (this.isOnline) {
            this._cmd();
            this._request('PUT', '/v1/me/player/seek?position_ms=' + pos).then(() => this._pollSoon(400), () => {});
        }
    }

    toggleShuffle() {
        this.shuffle = !this.shuffle;
        if (this.isOnline) {
            this._cmd();
            this._request('PUT', '/v1/me/player/shuffle?state=' + this.shuffle).catch(() => {});
        }
    }

    toggleRepeat() {
        const modes = ['off', 'context', 'track'];
        const next = modes[(modes.indexOf(this.repeat) + 1) % modes.length];
        this.repeat = next;
        if (this.isOnline) {
            this._cmd();
            this._request('PUT', '/v1/me/player/repeat?state=' + this.repeat).catch(() => {});
        }
    }

    async checkTrackLiked(trackId) {
        if (!this.token || !trackId) return;
        try {
            const res = await this._request('GET', `/v1/me/tracks/contains?ids=${trackId}`);
            if (Array.isArray(res)) {
                this.isCurrentLiked = !!res[0];
            }
        } catch (e) {
            // ignore
        }
    }

    async toggleLikeCurrent() {
        if (!this.currentTrack || !this.currentTrack.id) return;
        const id = this.currentTrack.id;
        this.isCurrentLiked = !this.isCurrentLiked;
        if (this.isOnline) {
            const method = this.isCurrentLiked ? 'PUT' : 'DELETE';
            this._request(method, `/v1/me/tracks?ids=${id}`).then(() => {
                this.fetchLikedSongs();
            }).catch(() => {});
        }
    }

    selectPlaylist(playlist) {
        this.currentPlaylist = playlist;
        if (this.isOnline && (!playlist.tracks || !playlist.tracks.length)) {
            this.fetchTracksForPlaylist(playlist);
        }
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
                const targetDev = this.devices.find((d) => d.isActive) || this.devices[0];
                const deviceParam = (targetDev && targetDev.id) ? `?device_id=${targetDev.id}` : '';
                this._cmd();
                this._request('PUT', `/v1/me/player/play${deviceParam}`, body).then(() => this._pollSoon(400), () => {});
            }
        }
    }

    transferToDevice(deviceId) {
        if (this.isOnline) {
            this._request('PUT', '/v1/me/player', { device_ids: [deviceId], play: true }).then(() => {
                setTimeout(() => {
                    this.fetchDevices();
                    this.pollPlayer();
                }, 500);
            }).catch(() => {});
        }
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
