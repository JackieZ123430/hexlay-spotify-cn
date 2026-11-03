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
        this.channel = 'bmw_copilot_' + Math.random().toString(36).substring(2, 10);
        this.shortCode = this.channel.replace('bmw_copilot_', '').toUpperCase();
        this.pollInterval = null;
        this.isPolling = false;
        this.onPaired = null;
    }

    getPairingUrl() {
        return `https://hexlay.github.io/idrive7-custom-apps/copilot.html?channel=${this.channel}`;
    }

    getShortCode() {
        return this.shortCode;
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

            const url = `https://ntfy.sh/${this.channel}/raw?poll=1`;
            const req = https.get(url, { timeout: 4000 }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    const trimmed = data.trim();
                    if (trimmed && trimmed.length > 5) {
                        try {
                            const parsed = JSON.parse(trimmed);
                            if (parsed.geminiApiKey || parsed.apiKey || parsed.sessionToken) {
                                this.log.info('CloudPair: Received AI credentials via cloud relay!');
                                this.ai.saveCredentials(parsed);
                                this.stopPolling();
                                if (this.onPaired) this.onPaired();
                            }
                        } catch (e) {
                            if (trimmed.startsWith('AIzaSy') || trimmed.startsWith('sk-')) {
                                this.ai.saveCredentials({
                                    mode: trimmed.startsWith('AIzaSy') ? 'gemini' : 'custom_api',
                                    geminiApiKey: trimmed.startsWith('AIzaSy') ? trimmed : null,
                                    apiKey: trimmed.startsWith('sk-') ? trimmed : null
                                });
                                this.stopPolling();
                                if (this.onPaired) this.onPaired();
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
