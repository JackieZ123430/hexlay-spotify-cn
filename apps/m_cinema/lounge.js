'use strict';
/**
 * lounge.js - Official YouTube on TV / Lounge Receiver for BMW iDrive 7.
 *
 * Implements Google's official YouTube on TV Lounge pairing protocol:
 *   1. Generates screen ID and official 12-digit TV pairing code.
 *   2. Displays code in iDrive: "In YouTube app: Settings > Watch on TV > Link with TV code".
 *   3. Driver enters 12-digit code once in YouTube app on iPhone or Android.
 *   4. Vehicle permanently appears as a Cast target ("BMW iDrive 7") in the official YouTube mobile app!
 *   5. When driver taps Cast in the YouTube app, video streams directly to the car.
 */
const https = require('https');
const querystring = require('querystring');

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 6000 }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve(data.trim()));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

class YouTubeLoungeReceiver {
    constructor(callbacks, log) {
        this.cb = callbacks || {};
        this.log = log || console;
        this.screenId = null;
        this.loungeToken = null;
        this.pairingCode = null;
        this.sid = null;
        this.gsessionid = null;
        this.streamReq = null;
        this.isConnected = false;
        this.isStarted = false;
        this.refreshTimer = null;
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
            // Retry after 10s if network was momentarily down
            setTimeout(() => {
                if (!this.pairingCode) this.start().catch(() => {});
            }, 10000);
        }
    }

    async initSession() {
        // Step 1: Generate screen ID
        this.screenId = await httpsGet('https://www.youtube.com/api/lounge/pairing/generate_screen_id');

        // Step 2: Fetch Lounge Token Batch
        const tokenResStr = await httpsGet(`https://www.youtube.com/api/lounge/pairing/get_lounge_token_batch?screen_ids=${this.screenId}`);
        const tokenRes = JSON.parse(tokenResStr);
        if (tokenRes && tokenRes.screens && tokenRes.screens[0]) {
            this.loungeToken = tokenRes.screens[0].loungeToken;
        }

        // Step 3: Fetch 12-digit TV Pairing Code
        const rawCode = await httpsGet(`https://www.youtube.com/api/lounge/pairing/get_pairing_code?ctx=pair&screen_id=${this.screenId}&access_type=permanent`);
        if (rawCode && /^\d{12}$/.test(rawCode)) {
            // Format as XXX XXX XXX XXX
            this.pairingCode = rawCode.replace(/(\d{3})(?=\d)/g, '$1 ');
            this.log.info('YouTube on TV Pairing Code: ' + this.pairingCode);
        }

        // Step 4: Initial Bind Session
        await this.bindSession();
    }

    async bindSession() {
        if (!this.screenId || !this.loungeToken) return;

        const postData = querystring.stringify({ count: '0' });
        const bindUrl = `https://www.youtube.com/api/lounge/bc/bind?device=LOUNGE_SCREEN&name=${encodeURIComponent('BMW iDrive 7')}&app=youtube-desktop&loungeIdToken=${encodeURIComponent(this.loungeToken)}&id=${this.screenId}&VER=8&RID=1&CVER=1`;

        const req = https.request(bindUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 8000
        }, (res) => {
            let buf = '';
            res.on('data', c => { buf += c; });
            res.on('end', () => {
                this.parseInitialBind(buf);
                if (this.sid && this.gsessionid) {
                    this.startEventStream();
                }
            });
        });

        req.on('error', (err) => {
            this.log.warn('Lounge bind error: ' + err.message);
        });

        req.write(postData);
        req.end();
    }

    parseInitialBind(text) {
        // Look for SID and gsessionid
        const sidMatch = text.match(/\[0,\["c","([^"]+)"/);
        if (sidMatch) this.sid = sidMatch[1];

        const gsessionMatch = text.match(/\[1,\["S","([^"]+)"/);
        if (gsessionMatch) this.gsessionid = gsessionMatch[1];
    }

    startEventStream() {
        if (!this.sid || !this.gsessionid) return;

        const streamUrl = `https://www.youtube.com/api/lounge/bc/bind?device=LOUNGE_SCREEN&app=youtube-desktop&SID=${this.sid}&gsessionid=${this.gsessionid}&VER=8&RID=rpc&CI=0&AID=3`;

        this.streamReq = https.get(streamUrl, { timeout: 45000 }, (res) => {
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
        // E.g. ["nowPlaying", {"videoId": "AvCt8Ggtupc"}]
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
                            channel: 'YouTube App Cast',
                            duration: '00:00',
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
