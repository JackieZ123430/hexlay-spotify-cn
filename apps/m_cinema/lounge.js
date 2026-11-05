'use strict';
/**
 * lounge.js - Official YouTube on TV / Lounge Receiver for BMW iDrive 7.
 *
 * Implements Google's official YouTube on TV Lounge pairing protocol:
 *   1. Generates screen ID and official 12-digit TV pairing code with proper POST parameters.
 *   2. Displays code in iDrive: "In YouTube app: Settings > Watch on TV > Link with TV code".
 *   3. Driver enters 12-digit code once in YouTube app on iPhone or Android.
 *   4. Vehicle permanently pairs and appears as a Cast target ("BMW iDrive 7") in the official YouTube mobile app!
 *   5. Maintains bidirectional RPC bind stream for play/pause, seek, and nowPlaying events.
 */
const https = require('https');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');
const url = require('url');

function httpsGet(urlStr) {
    return new Promise((resolve, reject) => {
        const u = url.parse(urlStr);
        const options = {
            hostname: u.hostname,
            port: u.port || 443,
            path: u.path,
            headers: { 'User-Agent': 'Mozilla/5.0 (BMW iDrive 7)' },
            timeout: 8000
        };
        const req = https.get(options, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode > 299) {
                    const err = new Error('HTTP ' + res.statusCode);
                    err.status = res.statusCode;
                    return reject(err);
                }
                resolve(data.trim());
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

function httpsPost(urlStr, postData) {
    return new Promise((resolve, reject) => {
        const u = url.parse(urlStr);
        const options = {
            hostname: u.hostname,
            port: u.port || 443,
            path: u.path || (u.pathname + (u.search || '')),
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 8000
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, data: data.trim() }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(postData);
        req.end();
    });
}

/**
 * Incremental parser for the Lounge (BrowserChannel) bind stream: a decimal length line, then
 * that many characters of JSON - an array of [arrayId, [event, ...args]]. Complete chunks are
 * consumed and dropped from the buffer, so every event is seen exactly once. The length is
 * tried as UTF-8 bytes and as characters (servers differ).
 */
class LoungeStreamParser {
    constructor() {
        this.buf = '';
    }

    /** Feed text; returns the complete events: [{ aid, name, args }] */
    push(text) {
        this.buf += text;
        const out = [];
        for (;;) {
            const nl = this.buf.indexOf('\n');
            if (nl < 0) break;
            const head = this.buf.slice(0, nl).trim();
            if (!head) { this.buf = this.buf.slice(nl + 1); continue; }
            if (!/^\d+$/.test(head)) {
                // not a length line: resync at the next line
                this.buf = this.buf.slice(nl + 1);
                continue;
            }
            const len = parseInt(head, 10);
            const rest = this.buf.slice(nl + 1);
            let used = -1, arr = null;
            const bytes = Buffer.from(rest, 'utf8');
            if (bytes.length >= len) {
                const cand = bytes.slice(0, len).toString('utf8');
                arr = LoungeStreamParser.tryJson(cand);
                if (arr) used = cand.length;
            }
            if (!arr && rest.length >= len) {
                arr = LoungeStreamParser.tryJson(rest.slice(0, len));
                used = len;           // a malformed chunk is dropped, not retried forever
            }
            if (used < 0) break;      // wait for more data
            this.buf = rest.slice(used);
            if (!Array.isArray(arr)) continue;
            for (const item of arr) {
                if (!Array.isArray(item) || typeof item[0] !== 'number' || !Array.isArray(item[1])) continue;
                out.push({ aid: item[0], name: item[1][0], args: item[1].slice(1) });
            }
        }
        return out;
    }

    static tryJson(str) {
        try { return JSON.parse(str); } catch (e) { return null; }
    }
}

const BACKOFF_MIN_MS = 2000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

class YouTubeLoungeReceiver {
    constructor(callbacks, log, ctx) {
        this.cb = callbacks || {};
        this.log = log || this.cb.log || console;
        this.ctx = ctx || null;
        this.screenId = null;
        this.loungeToken = null;
        this.deviceId = null;
        this.pairingCode = null;
        this.sid = null;
        this.gsessionid = null;
        this.rid = 10;
        this.aid = -1;               // last processed event (array) id, sent back as AID
        this.ofs = 0;                // outgoing map count
        this.streamReq = null;
        this.isConnected = false;
        this.isStarted = false;
        this.refreshTimer = null;
        this.initTimer = null;
        this.reconnectTimer = null;
        this.initBackoff = BACKOFF_MIN_MS;
        this.streamBackoff = BACKOFF_MIN_MS;
        this.tokenExpiry = 0;
        this.lastCastVid = null;
        this.lastCastAt = 0;

        const baseDir = (this.ctx && this.ctx.dataDir) ? this.ctx.dataDir : __dirname;
        this.authFile = path.join(baseDir, 'lounge_auth.json');
    }

    getPairingCode() {
        return this.pairingCode || 'INITIALIZING...';
    }

    async start() {
        if (this.isStarted) return;
        this.isStarted = true;

        // Periodically refresh pairing code (every 5 minutes)
        this.refreshTimer = setInterval(() => {
            this.refreshPairingCode().catch((e) => this.log.warn('Lounge pairing refresh: ' + e.message));
        }, 5 * 60 * 1000);

        await this._initWithRetry();
    }

    /** initSession, retried with backoff (network down at start-up) until it binds. */
    async _initWithRetry() {
        this.initTimer = null;
        if (!this.isStarted) return;
        try {
            await this.initSession();
            this.initBackoff = BACKOFF_MIN_MS;
            if (!this.sid) throw new Error('bind returned no session');
        } catch (e) {
            if (!this.isStarted) return;
            this.log.warn('YouTube Lounge init error: ' + e.message + ' (retry in ' + Math.round(this.initBackoff / 1000) + ' s)');
            this.initTimer = setTimeout(() => this._initWithRetry(), this.initBackoff);
            this.initBackoff = Math.min(BACKOFF_MAX_MS, this.initBackoff * 2);
        }
    }

    _saveAuth() {
        try {
            fs.writeFileSync(this.authFile, JSON.stringify({
                screenId: this.screenId,
                loungeToken: this.loungeToken,
                tokenExpiry: this.tokenExpiry,
                savedAt: new Date().toISOString()
            }, null, 2), 'utf8');
        } catch (e) {}
    }

    /** New lounge token for the screen (on start, on expiry, or after a 401/403). */
    async fetchLoungeToken() {
        const tokenRes = await httpsPost(
            'https://www.youtube.com/api/lounge/pairing/get_lounge_token_batch',
            querystring.stringify({ screen_ids: this.screenId })
        );
        if (tokenRes.status < 200 || tokenRes.status > 299) throw new Error('lounge token HTTP ' + tokenRes.status);
        const tokenObj = JSON.parse(tokenRes.data);
        const scr = tokenObj && tokenObj.screens && tokenObj.screens[0];
        if (!scr || !scr.loungeToken) throw new Error('no lounge token');
        this.loungeToken = scr.loungeToken;
        this.tokenExpiry = Number(scr.expiration) || 0;
        this._saveAuth();
        this.log.info('YouTube Lounge token refreshed');
    }

    _tokenExpired() {
        return !this.loungeToken || (this.tokenExpiry > 0 && Date.now() > this.tokenExpiry - 60000);
    }

    async initSession() {
        // Step 0: Try loading persisted screenId and loungeToken
        try {
            if (fs.existsSync(this.authFile)) {
                const data = JSON.parse(fs.readFileSync(this.authFile, 'utf8'));
                if (data && data.screenId) this.screenId = data.screenId;
                if (data && data.loungeToken) this.loungeToken = data.loungeToken;
                if (data && data.tokenExpiry) this.tokenExpiry = Number(data.tokenExpiry) || 0;
            }
        } catch (e) {}

        // Step 1: Generate unique screen ID for this vehicle if not already saved
        if (!this.screenId) {
            this.screenId = await httpsGet('https://www.youtube.com/api/lounge/pairing/generate_screen_id');
        }
        this.deviceId = 'bmw-idrive7-' + this.screenId;

        // Step 2: Fetch Lounge Token Batch via POST if not saved or expired
        if (this._tokenExpired()) {
            await this.fetchLoungeToken();
        }

        // Persist to car internal disk
        this._saveAuth();

        // Step 3: Fetch 12-digit TV Pairing Code via POST with full device registration
        await this.refreshPairingCode();

        // Step 4: Initial Bind Session
        await this.bindSession();
    }

    async refreshPairingCode() {
        if (!this.screenId || !this.loungeToken) return;

        const pairBody = querystring.stringify({
            access_type: 'permanent',
            app: 'youtube-desktop',
            lounge_token: this.loungeToken,
            screen_id: this.screenId,
            screen_name: 'BMW iDrive 7',
            device_id: this.deviceId
        });

        const res = await httpsPost('https://www.youtube.com/api/lounge/pairing/get_pairing_code?ctx=pair', pairBody);
        if (res.status === 401 || res.status === 403) {
            await this.fetchLoungeToken();
            return;
        }
        const rawCode = (res.data || '').trim();
        if (rawCode && /^\d{12}$/.test(rawCode)) {
            // Format as XXX XXX XXX XXX for easy entry on phone
            this.pairingCode = rawCode.replace(/(\d{3})(?=\d)/g, '$1 ');
            this.log.info('YouTube on TV Pairing Code: ' + this.pairingCode);
            if (this.cb.onCodeUpdated) this.cb.onCodeUpdated(this.pairingCode);
        }
    }

    /** New bind session (new SID). Throws when the bind fails. */
    async bindSession() {
        if (!this.screenId) return;
        if (this._tokenExpired()) await this.fetchLoungeToken();

        this.sid = null;
        this.gsessionid = null;
        this.aid = -1;
        this.ofs = 0;
        this.rid = 1;
        const postData = querystring.stringify({ count: '0' });
        const bindUrl = () => `https://www.youtube.com/api/lounge/bc/bind?device=LOUNGE_SCREEN&name=${encodeURIComponent('BMW iDrive 7')}&app=youtube-desktop&loungeIdToken=${encodeURIComponent(this.loungeToken)}&id=${this.deviceId}&VER=8&RID=${this.rid++}&CVER=1`;

        let res = await httpsPost(bindUrl(), postData);
        if (res.status === 401 || res.status === 403) {
            await this.fetchLoungeToken();
            res = await httpsPost(bindUrl(), postData);
        }
        if (res.status < 200 || res.status > 299) throw new Error('Lounge bind HTTP ' + res.status);
        this.parseInitialBind(res.data);
        if (!this.sid || !this.gsessionid) throw new Error('Lounge bind: no SID');
        this.streamBackoff = BACKOFF_MIN_MS;
        this.startEventStream();
    }

    parseInitialBind(text) {
        // c (SID) and S (gsessionid); other events of the bind reply are only acknowledged (AID),
        // so a phone's earlier session doesn't start a video at start-up
        const events = new LoungeStreamParser().push(text + '\n');
        for (const ev of events) {
            if (ev.aid > this.aid) this.aid = ev.aid;
            if (ev.name === 'c' && ev.args[0]) this.sid = ev.args[0];
            if (ev.name === 'S' && ev.args[0]) this.gsessionid = ev.args[0];
        }
        if (!this.sid) {
            const sidMatch = text.match(/\["c","([^"]+)"/);
            if (sidMatch) this.sid = sidMatch[1];
        }
        if (!this.gsessionid) {
            const gsessionMatch = text.match(/\["S","([^"]+)"/);
            if (gsessionMatch) this.gsessionid = gsessionMatch[1];
        }
    }

    _scheduleReconnect(rebind, reason) {
        if (!this.isStarted || this.reconnectTimer) return;
        const delay = this.streamBackoff;
        this.streamBackoff = Math.min(BACKOFF_MAX_MS, this.streamBackoff * 2);
        this.log.info('Lounge stream ' + reason + ' -> ' + (rebind ? 'rebind' : 'reconnect') + ' in ' + Math.round(delay / 1000) + ' s');
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.isStarted) return;
            if (!rebind && this.sid) return this.startEventStream();
            this.bindSession().catch((e) => this._scheduleReconnect(true, 'bind failed: ' + e.message));
        }, delay);
    }

    startEventStream() {
        if (!this.sid || !this.gsessionid || !this.loungeToken) return;

        const rpcParams = querystring.stringify({
            device: 'LOUNGE_SCREEN',
            id: this.deviceId,
            name: 'BMW iDrive 7',
            app: 'youtube-desktop',
            theme: 'cl',
            capabilities: 'dsp,mic,dpa,ntb',
            cst: 'm',
            mdxVersion: '2',
            loungeIdToken: this.loungeToken,
            VER: '8',
            v: '2',
            zx: Math.random().toString(36).substring(2, 14),
            t: '1',
            RID: 'rpc',
            SID: this.sid,
            CI: '0',
            AID: String(Math.max(0, this.aid)),
            gsessionid: this.gsessionid,
            TYPE: 'xmlhttp'
        });

        const streamUrl = `https://www.youtube.com/api/lounge/bc/bind?${rpcParams}`;
        const u = url.parse(streamUrl);
        const options = {
            hostname: u.hostname,
            port: u.port || 443,
            path: u.path,
            headers: { 'User-Agent': 'Mozilla/5.0 (BMW iDrive 7)' },
            timeout: 60000
        };

        if (this.streamReq) {
            const old = this.streamReq;
            this.streamReq = null;
            try { old.abort(); } catch (e) {}
        }
        const startedAt = Date.now();
        let done = false;
        let req = null;
        // exactly one reconnect per request, whatever ends it
        const ended = (rebind, reason) => {
            if (done) return;
            done = true;
            if (this.streamReq === req) this.streamReq = null;
            this.isConnected = false;
            // a long poll that ran a while is normal: reconnect at once
            if (!rebind && Date.now() - startedAt > 20000) this.streamBackoff = 500;
            this._scheduleReconnect(rebind, reason);
        };

        req = https.get(options, (res) => {
            if (res.statusCode === 401 || res.statusCode === 403) {
                res.resume();
                this.loungeToken = null;          // refreshed by the rebind
                return ended(true, 'HTTP ' + res.statusCode + ' (token)');
            }
            if (res.statusCode === 400 || res.statusCode === 404 || res.statusCode === 410) {
                res.resume();
                this.sid = null;                  // unknown / stale SID: new session
                return ended(true, 'HTTP ' + res.statusCode + ' (stale SID)');
            }
            if (res.statusCode < 200 || res.statusCode > 299) {
                res.resume();
                return ended(false, 'HTTP ' + res.statusCode);
            }
            this.isConnected = true;
            const parser = new LoungeStreamParser();
            res.setEncoding('utf8');

            res.on('data', chunk => {
                if (done) return;
                const events = parser.push(chunk);
                if (events.length) this.streamBackoff = BACKOFF_MIN_MS / 4;
                this.handleEvents(events);
            });
            res.on('aborted', () => ended(false, 'aborted'));
            res.on('error', (e) => ended(false, e.message));
            res.on('end', () => ended(false, 'ended'));
        });
        this.streamReq = req;

        req.on('error', (e) => ended(false, 'error: ' + e.message));
        req.on('timeout', () => {
            try { req.abort(); } catch (e) {}
            ended(false, 'timeout');
        });
    }

    /** Events from the stream parser; each array id is processed once. */
    handleEvents(events) {
        for (const ev of events) {
            if (ev.aid <= this.aid) continue;   // already seen (replayed after a reconnect)
            this.aid = ev.aid;
            this.handleEvent(ev.name, ev.args);
        }
    }

    handleEvent(name, args) {
        const payload = (args && args[0] && typeof args[0] === 'object') ? args[0] : {};
        if (name === 'nowPlaying' || name === 'setPlaylist') {
            const vidId = payload.videoId;
            if (vidId) {
                // nowPlaying repeats the current video; a setPlaylist of the same video (a deliberate
                // re-cast) plays it again, unless it is the echo of our own sendPlayVideo
                if (vidId !== this.lastCastVid || (name === 'setPlaylist' && Date.now() - this.lastCastAt > 3000)) {
                    this.lastCastVid = vidId;
                    this.lastCastAt = Date.now();
                    this.log.info('YouTube Lounge: Received Cast Video from phone: ' + vidId);
                    if (this.cb.onCast) {
                        this.cb.onCast({
                            ytId: vidId,
                            title: `YouTube [${vidId}]`,
                            channel: 'YouTube Mobile Cast',
                            duration: '00:00',
                            durationSec: 0,
                            quality: '720p 60',
                            glow: '#0066b1',
                            views: 'YouTube on TV',
                            desc: `https://youtu.be/${vidId}`,
                            url: `https://www.youtube.com/watch?v=${vidId}`,
                            thumbnail: `https://img.youtube.com/vi/${vidId}/hqdefault.jpg`
                        });
                    }
                }
            }
        } else if (name === 'pause' || name === 'stop') {
            if (this.cb.onControl) this.cb.onControl('pause');
        } else if (name === 'play') {
            if (this.cb.onControl) this.cb.onControl('play');
        } else if (name === 'setVolume') {
            if (this.cb.onVolume && payload.volume !== undefined) this.cb.onVolume(Number(payload.volume));
        }
    }

    async sendPlayVideo(videoId) {
        if (!this.sid || !this.gsessionid || !this.loungeToken) return;
        this.rid++;
        this.lastCastVid = videoId;
        this.lastCastAt = Date.now();

        const sendParams = querystring.stringify({
            device: 'LOUNGE_SCREEN',
            id: this.deviceId,
            name: 'BMW iDrive 7',
            app: 'youtube-desktop',
            theme: 'cl',
            capabilities: 'dsp,mic,dpa,ntb',
            cst: 'm',
            mdxVersion: '2',
            loungeIdToken: this.loungeToken,
            VER: '8',
            v: '2',
            zx: Math.random().toString(36).substring(2, 14),
            t: '1',
            RID: this.rid,
            SID: this.sid,
            AID: Math.max(0, this.aid),
            gsessionid: this.gsessionid
        });
        const url = `https://www.youtube.com/api/lounge/bc/bind?${sendParams}`;
        const postData = querystring.stringify({
            count: '1',
            ofs: String(this.ofs++),
            req0__sc: 'setPlaylist',
            req0_videoId: videoId,
            req0_currentTime: '0'
        });

        try {
            await httpsPost(url, postData);
            this.log.info('Sent setPlaylist to Lounge session: ' + videoId);
        } catch (e) {
            this.log.warn('Failed to send setPlaylist to Lounge: ' + e.message);
        }
    }

    stop() {
        this.isStarted = false;
        if (this.streamReq) {
            const r = this.streamReq;
            this.streamReq = null;
            try { r.abort(); } catch (e) {}
        }
        [this.initTimer, this.reconnectTimer].forEach((t) => t && clearTimeout(t));
        this.initTimer = null;
        this.reconnectTimer = null;
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.isStarted = false;
    }
}

module.exports = {
    YouTubeLoungeReceiver,
    LoungeStreamParser
};
