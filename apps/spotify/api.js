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

if (!Promise.prototype.finally) {
    Promise.prototype.finally = function(callback) {
        const P = this.constructor || Promise;
        return this.then(
            value => P.resolve(callback()).then(() => value),
            reason => P.resolve(callback()).then(() => { throw reason; })
        );
    };
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
        this.currentTrack = this.currentPlaylist && this.currentPlaylist.tracks ? this.currentPlaylist.tracks[0] : null;
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

        this._loadAuth();
        if (this.token || this.refreshToken) {
            this.initialFetch();
        }

        // Run initial internet check and schedule periodic check
        this.checkInternetConnection().catch(() => {});
        setInterval(() => {
            this.checkInternetConnection().catch(() => {});
        }, 12000);
    }

    async checkInternetConnection() {
        if (this.ctx.settings && this.ctx.settings.get('net') === 'off') {
            this.hasInternet = false;
            this.lastInternetCheck = Date.now();
            return false;
        }

        const probe = (host) => {
            return new Promise((resolve) => {
                const req = https.request({
                    hostname: host,
                    port: 443,
                    path: '/',
                    method: 'HEAD',
                    timeout: 6000,
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

        let ok = await probe('api.spotify.com');
        if (!ok) {
            ok = await probe('ntfy.sh');
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

        const paths = [
            this.ctx && this.ctx.dataDir ? path.join(this.ctx.dataDir, 'spotify_auth.json') : null,
            path.join(__dirname, 'spotify_auth.json')
        ].filter(Boolean);

        paths.forEach(p => {
            try {
                let existing = {};
                try {
                    if (fs.existsSync(p)) existing = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
                } catch (err) {}
                const out = Object.assign({}, existing, {
                    token: this.token,
                    refreshToken: this.refreshToken,
                    expiresAt: this.expiresAt,
                    clientId: this.clientId,
                    clientSecret: this.clientSecret,
                    savedAt: new Date().toISOString()
                });
                fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf8');
                this.log.info('SpotifyClient: Saved auth tokens to ' + p);
            } catch (e) {
                this.log.warn('SpotifyClient: Could not save tokens to ' + p + ': ' + e.message);
            }
        });

        this.initialFetch();
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
        if (this.token) {
            this.initialFetch();
        }
    }

    logout() {
        this.token = null;
        this.refreshToken = null;
        this.isOnline = false;
        this.playlists = DEMO_PLAYLISTS;
        this.currentPlaylist = this.playlists[0];
        this.currentTrack = this.currentPlaylist.tracks[0];

        const paths = [
            this.ctx && this.ctx.dataDir ? path.join(this.ctx.dataDir, 'spotify_auth.json') : null,
            path.join(__dirname, 'spotify_auth.json')
        ].filter(Boolean);

        paths.forEach(p => {
            try {
                if (fs.existsSync(p)) {
                    let existing = {};
                    try { existing = JSON.parse(fs.readFileSync(p, 'utf8')) || {}; } catch (e) {}
                    delete existing.token;
                    delete existing.refreshToken;
                    delete existing.expiresAt;
                    fs.writeFileSync(p, JSON.stringify(existing, null, 2), 'utf8');
                }
            } catch (e) {}
        });

        this.log.info('Logged out from Spotify');
    }

    async refreshAccessToken() {
        if (!this.refreshToken || !this.clientId) return false;
        try {
            const params = {
                grant_type: 'refresh_token',
                refresh_token: this.refreshToken,
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
                const req = https.request({
                    hostname: 'accounts.spotify.com',
                    port: 443,
                    path: '/api/token',
                    method: 'POST',
                    headers: headers,
                    timeout: 8000,
                    rejectUnauthorized: false
                }, (res) => {
                    let data = '';
                    res.on('data', c => { data += c; });
                    res.on('end', () => {
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.access_token) {
                                this.token = parsed.access_token;
                                this.expiresAt = Date.now() + (parsed.expires_in * 1000);
                                if (parsed.refresh_token) this.refreshToken = parsed.refresh_token;
                                this.paired = true;
                                this.isOnline = true;

                                // Persist updated tokens
                                const paths = [
                                    this.ctx && this.ctx.dataDir ? path.join(this.ctx.dataDir, 'spotify_auth.json') : null,
                                    path.join(__dirname, 'spotify_auth.json')
                                ].filter(Boolean);
                                const out = {
                                    token: this.token,
                                    refreshToken: this.refreshToken,
                                    expiresAt: this.expiresAt,
                                    clientId: this.clientId,
                                    clientSecret: this.clientSecret,
                                    savedAt: new Date().toISOString()
                                };
                                paths.forEach(p => {
                                    try { fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf8'); } catch (e) {}
                                });
                                this.log.info('Successfully refreshed Spotify access token');
                                return resolve(true);
                            } else {
                                this.log.warn('Spotify token refresh rejected: ' + data);
                                if (parsed.error === 'invalid_grant' || res.statusCode === 400) {
                                    this.token = null;
                                    this.paired = false;
                                }
                            }
                        } catch (e) {
                            this.log.warn('Spotify token refresh parse error: ' + e.message);
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
        } catch (e) {
            return false;
        }
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
    async _request(method, endpoint, body) {
        if (!this.token) throw new Error('Not authenticated');
        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'api.spotify.com',
                port: 443,
                path: endpoint,
                method: method,
                headers: {
                    'Authorization': 'Bearer ' + this.token,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                timeout: 6000,
                rejectUnauthorized: false
            }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    if (res.statusCode === 204) return resolve(null);
                    if (res.statusCode === 401 && this.refreshToken) {
                        return this.refreshAccessToken().then((refreshed) => {
                            if (refreshed) {
                                return this._request(method, endpoint, body).then(resolve).catch(reject);
                            }
                            if (!this.token) {
                                reject(new Error('Spotify session expired. Please re-authenticate.'));
                            } else {
                                reject(new Error('Spotify token refresh temporarily unavailable.'));
                            }
                        }).catch(reject);
                    }
                    if (res.statusCode === 401 && !this.refreshToken) {
                        this.token = null;
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
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }

    async pollPlayer() {
        if (!this.token) return;
        try {
            const data = await this._request('GET', '/v1/me/player');
            if (data && data.item) {
                this.isOnline = true;
                this.isPlaying = data.is_playing;
                this.progressMs = data.progress_ms;
                this.lastTickTime = Date.now();
                this.shuffle = data.shuffle_state;
                this.repeat = data.repeat_state;
                if (data.device) {
                    this.activeDevice = data.device.name + ' (' + data.device.type + ')';
                    this.volume = data.device.volume_percent;
                }
                const albumImages = (data.item.album && data.item.album.images) || [];
                const bestArt = albumImages.find((img) => img.width >= 200 && img.width <= 400) || albumImages[0];
                this.currentTrack = {
                    id: data.item.id,
                    title: decodeHtmlEntities(data.item.name),
                    artist: decodeHtmlEntities((data.item.artists || []).map((a) => a.name).join(', ')),
                    album: decodeHtmlEntities(data.item.album ? data.item.album.name : ''),
                    albumArt: bestArt ? bestArt.url : '',
                    durationMs: data.item.duration_ms,
                    uri: data.item.uri,
                };
                if (data.item.id && data.item.id !== this._lastCheckedTrackId) {
                    this._lastCheckedTrackId = data.item.id;
                    this.checkTrackLiked(data.item.id);
                }
            }
        } catch (e) {
            // Player might be idle/empty
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
                if (!this.currentTrack && playlist.tracks[0]) {
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
                const active = this.devices.find((d) => d.isActive);
                if (active) {
                    this.activeDevice = active.name + ' (' + active.type + ')';
                } else if (this.devices.length > 0) {
                    this.activeDevice = this.devices[0].name;
                } else {
                    this.activeDevice = 'No Active Target';
                }
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
            this._request('PUT', `/v1/me/player/play${deviceParam}`, { uris }).then(() => {
                setTimeout(() => this.pollPlayer(), 400);
            }).catch(() => {});
        }
    }

    // Tick called every frame
    tick() {
        const now = Date.now();
        const dt = now - this.lastTickTime;
        this.lastTickTime = now;

        // Auto-refresh token if expiring within 2 minutes
        if (this.token && this.refreshToken && this.expiresAt && (now >= this.expiresAt - 120000) && !this.refreshing) {
            this.refreshing = true;
            this.refreshAccessToken().then(() => {
                this.refreshing = false;
            }).catch(() => {
                this.refreshing = false;
            });
        }

        // Poll state from Spotify cloud every 2.5 seconds
        if (this.token && now - this.lastSync > 2500 && !this.syncing) {
            this.lastSync = now;
            this.syncing = true;
            Promise.all([
                this.pollPlayer(),
                this.fetchDevices()
            ]).then(() => {
                this.syncing = false;
            }).catch(() => {
                this.syncing = false;
            });
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
            this._request('PUT', '/v1/me/player/play').catch(() => {});
        }
    }

    pause() {
        this.isPlaying = false;
        if (this.isOnline) {
            this._request('PUT', '/v1/me/player/pause').catch(() => {});
        }
    }

    togglePlay() {
        if (this.isPlaying) this.pause();
        else this.play();
    }

    nextTrack() {
        if (this.isOnline) {
            this._request('POST', '/v1/me/player/next').then(() => {
                setTimeout(() => this.pollPlayer(), 300);
            }).catch(() => {});
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
            this._request('POST', '/v1/me/player/previous').then(() => {
                setTimeout(() => this.pollPlayer(), 300);
            }).catch(() => {});
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
            this._request('PUT', '/v1/me/player/seek?position_ms=' + pos).catch(() => {});
        }
    }

    toggleShuffle() {
        this.shuffle = !this.shuffle;
        if (this.isOnline) {
            this._request('PUT', '/v1/me/player/shuffle?state=' + this.shuffle).catch(() => {});
        }
    }

    toggleRepeat() {
        const modes = ['off', 'context', 'track'];
        const next = modes[(modes.indexOf(this.repeat) + 1) % modes.length];
        this.repeat = next;
        if (this.isOnline) {
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
                this._request('PUT', `/v1/me/player/play${deviceParam}`, body).then(() => {
                    setTimeout(() => this.pollPlayer(), 400);
                }).catch(() => {});
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
    DEMO_PLAYLISTS,
    DEMO_DEVICES
};
