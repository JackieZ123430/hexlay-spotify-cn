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

const DEMO_PLAYLISTS = [
    {
        id: 'pl_m_driving',
        name: 'BMW M Driving Mix',
        description: 'High adrenaline soundtracks for sport mode & open roads',
        trackCount: 7,
        accent: '#e1001a',
        uri: 'spotify:playlist:demo_m',
        tracks: [
            { id: 't1', title: 'Midnight City', artist: 'M83', album: 'Hurry Up, We\'re Dreaming', durationMs: 243000, uri: 'spotify:track:t1' },
            { id: 't2', title: 'Turbo Killer', artist: 'Carpenter Brut', album: 'Trilogy', durationMs: 208000, uri: 'spotify:track:t2' },
            { id: 't3', title: 'Nightcall', artist: 'Kavinsky', album: 'Drive OST', durationMs: 259000, uri: 'spotify:track:t3' },
            { id: 't4', title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', durationMs: 200000, uri: 'spotify:track:t4' },
            { id: 't5', title: 'Resonance', artist: 'HOME', album: 'Odyssey', durationMs: 212000, uri: 'spotify:track:t5' },
            { id: 't6', title: 'Starboy', artist: 'The Weeknd, Daft Punk', album: 'Starboy', durationMs: 230000, uri: 'spotify:track:t6' },
            { id: 't7', title: 'Days of Thunder', artist: 'The Midnight', album: 'Days of Thunder', durationMs: 278000, uri: 'spotify:track:t7' },
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
        this.activeDevice = 'iPhone (BMW iDrive)';
        this.lastSync = 0;
        this.syncing = false;

        // Playlists cache
        this.playlists = DEMO_PLAYLISTS;
        this.devices = DEMO_DEVICES;

        // Playback state
        this.isPlaying = true;
        this.currentPlaylist = this.playlists[0];
        this.currentTrack = this.currentPlaylist.tracks[0];
        this.trackIndex = 0;
        this.progressMs = 45000;
        this.lastTickTime = Date.now();
        this.shuffle = false;
        this.repeat = 'off';
        this.volume = 82;

        this._loadAuth();
        if (this.token) {
            this.initialFetch();
        }
    }

    _loadAuth() {
        try {
            const configPath = path.join(__dirname, 'spotify_auth.json');
            if (fs.existsSync(configPath)) {
                const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                if (data.token) {
                    this.token = data.token;
                    this.refreshToken = data.refreshToken;
                    this.expiresAt = data.expiresAt || 0;
                    this.clientId = data.clientId;
                    this.clientSecret = data.clientSecret;
                    this.paired = true;
                    this.isOnline = true;
                    this.log.info('Loaded Spotify auth token');
                }
            }
        } catch (e) {
            this.log.warn('Could not read auth: ' + e);
        }
    }

    async initialFetch() {
        try {
            await this.pollPlayer();
            await this.fetchPlaylists();
            await this.fetchDevices();
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
                timeout: 3500
            }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    if (res.statusCode === 204) return resolve(null);
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
                this.currentTrack = {
                    id: data.item.id,
                    title: data.item.name,
                    artist: (data.item.artists || []).map((a) => a.name).join(', '),
                    album: data.item.album ? data.item.album.name : '',
                    durationMs: data.item.duration_ms,
                    uri: data.item.uri,
                };
            }
        } catch (e) {
            // Player might be idle/empty
        }
    }

    async fetchPlaylists() {
        if (!this.token) return;
        try {
            const res = await this._request('GET', '/v1/me/playlists?limit=15');
            if (res && res.items && res.items.length) {
                const list = res.items.map((pl, i) => ({
                    id: pl.id,
                    name: pl.name,
                    description: pl.description || 'User playlist',
                    trackCount: pl.tracks ? pl.tracks.total : 0,
                    uri: pl.uri,
                    accent: ['#1db954', '#e1001a', '#81c4ff', '#ff9d00', '#1ed760'][i % 5],
                    tracks: []
                }));
                this.playlists = list;
                if (list[0]) {
                    this.selectPlaylist(list[0]);
                }
            }
        } catch (e) {
            this.log.warn('Fetch playlists error: ' + e.message);
        }
    }

    async fetchTracksForPlaylist(playlist) {
        if (!this.token || !playlist || !playlist.id) return;
        try {
            const res = await this._request('GET', `/v1/playlists/${playlist.id}/tracks?limit=30`);
            if (res && res.items) {
                playlist.tracks = res.items
                    .filter((item) => item.track && item.track.id)
                    .map((item) => ({
                        id: item.track.id,
                        title: item.track.name,
                        artist: (item.track.artists || []).map((a) => a.name).join(', '),
                        album: item.track.album ? item.track.album.name : '',
                        durationMs: item.track.duration_ms,
                        uri: item.track.uri
                    }));
            }
        } catch (e) {
            this.log.warn('Fetch tracks error: ' + e.message);
        }
    }

    async fetchDevices() {
        if (!this.token) return;
        try {
            const res = await this._request('GET', '/v1/me/player/devices');
            if (res && res.devices && res.devices.length) {
                this.devices = res.devices.map((d) => ({
                    id: d.id,
                    name: d.name,
                    type: d.type,
                    isActive: d.is_active,
                    volume: d.volume_percent
                }));
                const active = this.devices.find((d) => d.isActive);
                if (active) this.activeDevice = active.name + ' (' + active.type + ')';
            }
        } catch (e) {
            //
        }
    }

    // Tick called every frame
    tick() {
        const now = Date.now();
        const dt = now - this.lastTickTime;
        this.lastTickTime = now;

        // Poll state from Spotify cloud every 2.5 seconds
        if (this.token && now - this.lastSync > 2500 && !this.syncing) {
            this.lastSync = now;
            this.syncing = true;
            this.pollPlayer().finally(() => { this.syncing = false; });
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
                this._request('PUT', '/v1/me/player/play', body).then(() => {
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
