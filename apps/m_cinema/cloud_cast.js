'use strict';
/**
 * Cloud Cast Manager for BMW iDrive 7 M-Cinema.
 *
 * Replaces localhost / 127.0.0.1 with a real cloud relay flow:
 *   1. Displays QR code pointing to:
 *      https://hexlay.github.io/idrive7-custom-apps/cinema.html?channel=<CHANNEL>
 *   2. User scans QR code with iPhone or Android over 4G, 5G, or Wi-Fi (zero 127.0.0.1 / localhost).
 *   3. Mobile browser opens instant YouTube Search & Cast Remote.
 *   4. User searches any YouTube video or 1-taps paste & cast.
 *   5. Mobile browser sends video cast payload to secure cloud relay.
 *   6. Car head unit receives YouTube stream metadata, displays video art & playback.
 *   7. Full touch & rotary control from cockpit and phone.
 */
const https = require('https');

function parseYouTubeId(url) {
    if (!url) return null;
    const trimmed = String(url).trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
        return trimmed;
    }
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=|&v=)([^#&?]*).*/;
    const match = trimmed.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

class CloudCastManager {
    constructor(ctx, callbacks) {
        this.ctx = ctx;
        this.log = ctx.log || console;
        this.cb = callbacks || {};
        this.channel = 'bmw_cinema_' + Math.random().toString(36).substring(2, 10);
        this.shortCode = this.channel.replace('bmw_cinema_', '').toUpperCase();
        this.seenIds = new Set();
        this.lastMsgId = null;
        this.pollInterval = null;
        this.isPolling = false;
        this.isOnline = true;
        this.lastMessageTime = 0;
    }

    getCastUrl() {
        return `https://hexlay.github.io/idrive7-custom-apps/cinema.html?channel=${this.channel}`;
    }

    getShortCode() {
        return this.shortCode;
    }

    getChannel() {
        return this.channel;
    }

    reset() {
        this.channel = 'bmw_cinema_' + Math.random().toString(36).substring(2, 10);
        this.shortCode = this.channel.replace('bmw_cinema_', '').toUpperCase();
        this.seenIds.clear();
        this.lastMsgId = null;
    }

    startPolling() {
        if (this.isPolling) return;
        this.isPolling = true;

        const check = () => {
            if (!this.isPolling) return;

            let url = `https://ntfy.sh/${this.channel}/json?poll=1`;
            if (this.lastMsgId) {
                url += `&since=${encodeURIComponent(this.lastMsgId)}`;
            } else {
                url += `&since=120s`;
            }

            const req = https.get(url, { timeout: 3500 }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    this.isOnline = true;
                    const lines = data.trim().split('\n');
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed.length < 5) continue;

                        try {
                            const item = JSON.parse(trimmed);
                            if (item.id) {
                                this.lastMsgId = item.id;
                            }

                            if (item.event === 'message' && item.message) {
                                this.handleMessage(item.message);
                            } else if (item.action) {
                                this.handleMessage(trimmed);
                            }
                        } catch (e) {
                            // Non-JSON fallback
                            this.handleMessage(trimmed);
                        }
                    }
                });
            });

            req.on('error', () => {
                // Non-blocking network drop
            });

            req.on('timeout', () => {
                req.destroy();
            });
        };

        this.pollInterval = setInterval(check, 1800);
        check();
    }

    handleMessage(rawMsg) {
        if (!rawMsg) return;
        let parsed = null;
        try {
            parsed = JSON.parse(rawMsg);
        } catch (e) {
            // Raw YouTube ID or URL
            const ytId = parseYouTubeId(rawMsg);
            if (ytId) {
                parsed = { action: 'cast', ytId: ytId };
            }
        }

        if (!parsed || !parsed.action) return;

        // Deduplication by client message id
        if (parsed.id && this.seenIds.has(parsed.id)) return;
        if (parsed.id) {
            this.seenIds.add(parsed.id);
            if (this.seenIds.size > 250) {
                const arr = Array.from(this.seenIds);
                this.seenIds = new Set(arr.slice(arr.length - 120));
            }
        }

        // Action: Cast YouTube Video
        if (parsed.action === 'cast') {
            const ytId = parsed.ytId || parseYouTubeId(parsed.url);
            let title = parsed.title;
            if (!title) {
                title = ytId ? `YouTube [${ytId}]` : 'YouTube Video';
            }

            const streamQuality = (parsed.quality === '1080p') ? '1080p 60' : '720p 60';
            const video = {
                title: title,
                channel: parsed.channel || 'YouTube Stream',
                duration: parsed.duration || '00:00',
                quality: streamQuality,
                glow: '#ff0000',
                views: parsed.views || 'Casting from Phone',
                desc: parsed.url || (ytId ? `https://youtu.be/${ytId}` : 'YouTube Video'),
                ytId: ytId,
                url: parsed.url || (ytId ? `https://www.youtube.com/watch?v=${ytId}` : null),
                thumbnail: parsed.thumbnail || (ytId ? `https://img.youtube.com/vi/${ytId}/hqdefault.jpg` : null)
            };

            this.log.info('CloudCast: Received YouTube video: ' + title);
            if (this.cb.onCast) this.cb.onCast(video);
        }
        // Action: Cockpit Remote Control
        else if (parsed.action === 'control') {
            const cmd = parsed.cmd || parsed.actionType;
            this.log.info('CloudCast: Control action: ' + cmd + ' ' + (parsed.val !== undefined ? parsed.val : ''));
            if (this.cb.onControl) this.cb.onControl(cmd, parsed.val);
        }
    }

    stopPolling() {
        this.isPolling = false;
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }
}

module.exports = {
    CloudCastManager,
    parseYouTubeId
};
