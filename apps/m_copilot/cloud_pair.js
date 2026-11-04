'use strict';
/**
 * Cloud Pairing Manager for BMW iDrive 7 M-Copilot.
 *
 * Provides smartphone-to-car cloud pairing:
 *   1. Displays QR code pointing to:
 *      https://hexlay.github.io/idrive7-custom-apps/copilot.html?channel=<CHANNEL>
 *   2. User scans QR code with smartphone over 4G, 5G, or Wi-Fi (no 127.0.0.1 / localhost).
 *   3. User enters free Google Gemini API Key or custom key and taps Connect.
 *   4. Mobile browser publishes payload to secure relay channel.
 *   5. Car head unit receives configuration, verifies uplink, saves to copilot_auth.json.
 */
const https = require('https');

class CloudPairManager {
    constructor(ctx, aiBridge) {
        this.ctx = ctx;
        this.log = ctx.log || console;
        this.ai = aiBridge;

        // Persist channel across restarts so driver doesn't need to re-pair every ignition cycle
        const savedChannel = (this.ai && this.ai.config && this.ai.config.channel);
        this.channel = savedChannel || ('bmw_copilot_' + Math.random().toString(36).substring(2, 10));
        if (this.ai && this.ai.config && !this.ai.config.channel) {
            this.ai.config.channel = this.channel;
            this.ai.saveConfig();
        }

        this.shortCode = this.channel.replace('bmw_copilot_', '').toUpperCase();
        this.pollInterval = null;
        this.isPolling = false;
        this.lastMsgId = null;
        this.lastSince = Math.floor(Date.now() / 1000) - (this.ai && this.ai.isConfigured() ? 2 : 7200);

        this.onPaired = null;
    }

    getPairingUrl() {
        return `https://hexlay.github.io/idrive7-custom-apps/copilot.html?channel=${this.channel}`;
    }

    getShortCode() {
        return this.shortCode;
    }

    reset() {
        this.channel = 'bmw_copilot_' + Math.random().toString(36).substring(2, 10);
        this.shortCode = this.channel.replace('bmw_copilot_', '').toUpperCase();
        this.lastMsgId = null;
        this.lastSince = Math.floor(Date.now() / 1000) - 2;
        if (this.ai && this.ai.config) {
            this.ai.config.channel = this.channel;
            this.ai.saveConfig();
        }
    }

    startPolling() {
        if (this.isPolling) return;
        this.isPolling = true;

        const check = () => {
            if (!this.isPolling) return;
            if (this.ai && this.ai.isConfigured()) {
                this.stopPolling();
                return;
            }

            let url = `https://ntfy.sh/${this.channel}/json?poll=1`;
            if (this.lastMsgId) {
                url += `&since=${encodeURIComponent(this.lastMsgId)}`;
            } else if (this.lastSince) {
                url += `&since=${this.lastSince}`;
            }

            const req = https.get(url, { timeout: 4000 }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    const trimmed = data.trim();
                    if (!trimmed) return;

                    const lines = trimmed.split('\n');
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const item = JSON.parse(line);
                            if (item.id) {
                                this.lastMsgId = item.id;
                            }
                            if (item.event === 'message' && item.message) {
                                this.handleIncomingMessage(item.message);
                            }
                        } catch (e) {
                            this.handleIncomingMessage(line);
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

    handleIncomingMessage(rawMsg) {
        if (!rawMsg || typeof rawMsg !== 'string') return;
        const trimmed = rawMsg.trim();
        if (trimmed.length < 3) return;

        let parsed = null;
        try {
            parsed = JSON.parse(trimmed);
        } catch (e) {
            if (trimmed.startsWith('AIzaSy') || trimmed.startsWith('sk-')) {
                parsed = {
                    mode: trimmed.startsWith('AIzaSy') ? 'gemini' : 'custom_api',
                    geminiApiKey: trimmed.startsWith('AIzaSy') ? trimmed : null,
                    apiKey: trimmed.startsWith('sk-') ? trimmed : null
                };
            }
        }

        if (!parsed) return;

        // Credentials Pairing Event
        if (parsed.geminiApiKey || parsed.apiKey || parsed.sessionToken) {
            this.log.info('CloudPair: Received AI credentials via cloud relay!');
            this.ai.saveCredentials(parsed);
            this.stopPolling();
            if (this.onPaired) this.onPaired();
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

module.exports = { CloudPairManager };
