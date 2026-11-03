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

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 8000 }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve(data.trim()));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

function httpsPost(url, postData) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const options = {
            hostname: u.hostname,
            path: u.pathname + u.search,
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

class YouTubeLoungeReceiver {
    constructor(callbacks, log) {
        this.cb = callbacks || {};
        this.log = log || console;
        this.screenId = null;
        this.loungeToken = null;
        this.deviceId = null;
        this.pairingCode = null;
        this.sid = null;
        this.gsessionid = null;
        this.rid = 10;
        this.aid = 3;
        this.streamReq = null;
        this.isConnected = false;
        this.isStarted = false;
        this.refreshTimer = null;
        this.lastCastVid = null;
    }

    getPairingCode() {
        return this.pairingCode || 'INITIALIZING...';
    }

    async start() {
        if (this.isStarted) return;
        this.isStarted = true;

        try {
            await this.initSession();
        } catch (e) {
            this.log.warn('YouTube Lounge init error: ' + e.message);
            // Retry after 8s if network was momentarily down
            setTimeout(() => {
                if (!this.pairingCode) this.start().catch(() => {});
            }, 8000);
        }

        // Periodically refresh pairing code (every 5 minutes)
        this.refreshTimer = setInterval(() => {
            this.refreshPairingCode().catch(() => {});
        }, 5 * 60 * 1000);
    }

    async initSession() {
        // Step 1: Generate screen ID
        this.screenId = await httpsGet('https://www.youtube.com/api/lounge/pairing/generate_screen_id');
        this.deviceId = 'bmw-idrive7-' + this.screenId;

        // Step 2: Fetch Lounge Token Batch via POST
        const tokenRes = await httpsPost(
            'https://www.youtube.com/api/lounge/pairing/get_lounge_token_batch',
            querystring.stringify({ screen_ids: this.screenId })
        );
        const tokenObj = JSON.parse(tokenRes.data);
        if (tokenObj && tokenObj.screens && tokenObj.screens[0]) {
            this.loungeToken = tokenObj.screens[0].loungeToken;
        }

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
        const rawCode = (res.data || '').trim();
        if (rawCode && /^\d{12}$/.test(rawCode)) {
            // Format as XXX XXX XXX XXX for easy entry on phone
            this.pairingCode = rawCode.replace(/(\d{3})(?=\d)/g, '$1 ');
            this.log.info('YouTube on TV Pairing Code: ' + this.pairingCode);
            if (this.cb.onCodeUpdated) this.cb.onCodeUpdated(this.pairingCode);
        }
    }

    async bindSession() {
        if (!this.screenId || !this.loungeToken) return;

        const postData = querystring.stringify({ count: '0' });
        const bindUrl = `https://www.youtube.com/api/lounge/bc/bind?device=LOUNGE_SCREEN&name=${encodeURIComponent('BMW iDrive 7')}&app=youtube-desktop&loungeIdToken=${encodeURIComponent(this.loungeToken)}&id=${this.deviceId}&VER=8&RID=1&CVER=1`;

        try {
            const res = await httpsPost(bindUrl, postData);
            this.parseInitialBind(res.data);
            if (this.sid && this.gsessionid) {
                this.startEventStream();
            }
        } catch (err) {
            this.log.warn('Lounge bind error: ' + err.message);
        }
    }

    parseInitialBind(text) {
        // Look for SID and gsessionid
        const sidMatch = text.match(/\[0,\["c","([^"]+)"/);
        if (sidMatch) this.sid = sidMatch[1];

        const gsessionMatch = text.match(/\[1,\["S","([^"]+)"/);
        if (gsessionMatch) this.gsessionid = gsessionMatch[1];
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
            AID: '3',
            gsessionid: this.gsessionid,
            TYPE: 'xmlhttp'
        });

        const streamUrl = `https://www.youtube.com/api/lounge/bc/bind?${rpcParams}`;

        this.streamReq = https.get(streamUrl, { timeout: 60000 }, (res) => {
            this.isConnected = true;
            let buffer = '';

            res.on('data', chunk => {
                buffer += chunk;
                this.handleStreamChunks(buffer);
            });

            res.on('end', () => {
                this.isConnected = false;
                // Auto-reconnect stream
                setTimeout(() => this.startEventStream(), 2000);
            });
        });

        this.streamReq.on('error', () => {
            this.isConnected = false;
            setTimeout(() => this.startEventStream(), 4000);
        });

        this.streamReq.on('timeout', () => {
            if (this.streamReq) this.streamReq.destroy();
        });
    }

    handleStreamChunks(raw) {
        // Look for nowPlaying or setPlaylist video events
        // E.g. ["nowPlaying", {"videoId": "AvCt8Ggtupc"}] or ["setPlaylist", {"videoId": "..."}]
        const matches = raw.matchAll(/\["(?:nowPlaying|setPlaylist)",\s*\{([^}]+)\}/g);
        for (const m of matches) {
            const body = m[1];
            const vidMatch = body.match(/"videoId":\s*"([^"]+)"/);
            if (vidMatch && vidMatch[1]) {
                const vidId = vidMatch[1];
                if (vidId !== this.lastCastVid) {
                    this.lastCastVid = vidId;
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
        }

        // Look for playback commands: pause / play / seek
        if (/\["(?:pause|stop)"/.test(raw)) {
            if (this.cb.onControl) this.cb.onControl('pause');
        } else if (/\["(?:play)"/.test(raw)) {
            if (this.cb.onControl) this.cb.onControl('play');
        }
    }

    async sendPlayVideo(videoId) {
        if (!this.sid || !this.gsessionid || !this.loungeToken) return;
        this.aid++;
        this.rid++;

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
            AID: this.aid,
            gsessionid: this.gsessionid
        });
        const url = `https://www.youtube.com/api/lounge/bc/bind?${sendParams}`;
        const postData = querystring.stringify({
            count: '1',
            ofs: '0',
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
        if (this.streamReq) {
            this.streamReq.destroy();
            this.streamReq = null;
        }
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.isStarted = false;
    }
}

module.exports = {
    YouTubeLoungeReceiver
};
