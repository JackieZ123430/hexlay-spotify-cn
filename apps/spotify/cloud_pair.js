'use strict';
/**
 * Cloud Pairing Manager for BMW iDrive 7 Spotify.
 *
 * Replaces localhost / 127.0.0.1 with a real cloud relay flow:
 *   1. Car generates a unique pairing session and displays QR code to:
 *      https://hexlay.github.io/idrive7-custom-apps/pair.html?channel=<CHANNEL>&client_id=<CLIENT_ID>
 *   2. Driver scans QR code with any smartphone (over 4G, 5G, or Wi-Fi).
 *   3. Driver logs into Spotify -> Spotify authorizes and passes token.
 *   4. Mobile browser publishes token to secure session channel.
 *   5. Car head unit receives token, saves to persistent storage, and connects!
 *   6. Zero terminal, zero node commands, zero localhost 127.0.0.1 URLs.
 */
const https = require('https');

let crypto;
try { crypto = require('crypto'); } catch (e) {}

function generateEntropyHex(bytes) {
    if (crypto && crypto.randomBytes) {
        return crypto.randomBytes(bytes).toString('hex');
    }
    let s = '';
    while (s.length < bytes * 2) {
        s += Math.random().toString(36).substring(2);
    }
    return s.substring(0, bytes * 2);
}

function formatShortCode(channel) {
    if (!channel) return '--------';
    const raw = channel.replace('bmw_spot_', '').toUpperCase();
    if (raw.length >= 8) {
        return raw.substring(0, 4) + '-' + raw.substring(4, 8);
    }
    return raw;
}

class CloudPairManager {
    constructor(ctx, spotifyClient) {
        this.ctx = ctx;
        this.log = ctx.log || console;
        this.spotify = spotifyClient;
        this.channel = 'bmw_spot_' + generateEntropyHex(12);
        this.shortCode = formatShortCode(this.channel);
        this.pollInterval = null;
        this.isPolling = false;
    }

    getPairingUrl() {
        const clientId = this.spotify.clientId || '';
        const clientParam = clientId ? `&client_id=${clientId}` : '';
        return `https://hexlay.github.io/idrive7-custom-apps/pair.html?channel=${this.channel}${clientParam}`;
    }

    getShortCode() {
        return this.shortCode;
    }

    reset() {
        this.channel = 'bmw_spot_' + generateEntropyHex(12);
        this.shortCode = formatShortCode(this.channel);
    }

    startPolling() {
        if (this.isPolling) return;
        this.isPolling = true;

        const check = () => {
            if (!this.isPolling) return;
            if (this.spotify && this.spotify.isOnline && this.spotify.token) {
                this.stopPolling();
                return;
            }

            const url = `https://ntfy.sh/${this.channel}/raw?poll=1`;
            const req = https.get(url, { timeout: 4000 }, (res) => {
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => {
                    const trimmed = data.trim();
                    if (trimmed && trimmed.length > 10) {
                        try {
                            const parsed = JSON.parse(trimmed);
                            if (parsed.token) {
                                this.log.info('CloudPair: Received Spotify token via cloud pairing channel!');
                                this.spotify.saveAuthTokens({
                                    token: parsed.token,
                                    refreshToken: parsed.refreshToken,
                                    expiresAt: parsed.expiresAt || (Date.now() + 3600000),
                                    clientId: parsed.clientId
                                });
                                this.stopPolling();
                            }
                        } catch (e) {
                            if (trimmed.startsWith('BQC') || trimmed.length > 40) {
                                this.spotify.saveAuthTokens({
                                    token: trimmed,
                                    expiresAt: Date.now() + 3600000
                                });
                                this.stopPolling();
                            }
                        }
                    }
                });
            });
            req.on('error', () => {});
            req.on('timeout', () => { req.destroy(); });
        };

        this.pollInterval = setInterval(check, 2500);
        check();
    }

    stopPolling() {
        this.isPolling = false;
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }
}

module.exports = { CloudPairManager };
