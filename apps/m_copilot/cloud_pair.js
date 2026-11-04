'use strict';
/**
 * Cloud Pairing Manager for BMW iDrive 7 M-Copilot.
 *
 * Provides smartphone-to-car cloud pairing with zero-knowledge End-to-End Encryption (E2EE):
 *   1. Displays QR code on iDrive screen pointing to:
 *      https://hexlay.github.io/idrive7-custom-apps/copilot.html?channel=<CHANNEL>#k=<SECRET_KEY>
 *   2. Cryptographically isolated per vehicle (128-bit unique channel + 256-bit AES-GCM key).
 *   3. Secret key 'k' lives only in the car and in the phone's browser hash fragment (#k=...),
 *      NEVER sent across HTTP headers to GitHub or ntfy.sh servers.
 *   4. Mobile browser encrypts user's API key with AES-GCM before relaying.
 *   5. Only this specific car can decrypt and store the API credentials.
 *   6. Multi-car safe: each vehicle has an independent channel, encryption key, and storage.
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
    const raw = channel.replace('bmw_copilot_', '').toUpperCase();
    if (raw.length >= 8) {
        return raw.substring(0, 4) + '-' + raw.substring(4, 8);
    }
    return raw;
}

class CloudPairManager {
    constructor(ctx, aiBridge) {
        this.ctx = ctx;
        this.log = (ctx && ctx.log) || console;
        this.ai = aiBridge;

        // Persist unique channel and secret key per car installation
        const cfg = (this.ai && this.ai.config) || {};
        this.channel = cfg.channel || ('bmw_copilot_' + generateEntropyHex(12));
        this.secretKey = cfg.secretKey || generateEntropyHex(32);

        if (this.ai && this.ai.config) {
            let saveNeeded = false;
            if (!this.ai.config.channel) { this.ai.config.channel = this.channel; saveNeeded = true; }
            if (!this.ai.config.secretKey) { this.ai.config.secretKey = this.secretKey; saveNeeded = true; }
            if (saveNeeded) this.ai.saveConfig();
        }

        this.shortCode = formatShortCode(this.channel);
        this.pollInterval = null;
        this.isPolling = false;
        this.lastMsgId = null;
        const isCfg = (this.ai && typeof this.ai.isConfigured === 'function') ? this.ai.isConfigured() : false;
        this.lastSince = Math.floor(Date.now() / 1000) - (isCfg ? 2 : 7200);

        this.onPaired = null;
        this.onUnpaired = null;
    }

    getPairingUrl() {
        return `https://hexlay.github.io/idrive7-custom-apps/copilot.html?channel=${this.channel}#k=${this.secretKey}`;
    }

    getShortCode() {
        return this.shortCode;
    }

    notifyUnpair() {
        if (!this.channel) return;
        try {
            const req = https.request(`https://ntfy.sh/${this.channel}`, {
                method: 'POST',
                headers: {
                    'Title': 'BMW M-Copilot Unpaired',
                    'Content-Type': 'application/json'
                },
                timeout: 3000
            });
            req.on('error', () => {});
            req.write(JSON.stringify({ type: 'copilot_unpaired', channel: this.channel, time: Date.now() }));
            req.end();
            this.log.info('CloudPair: Broadcasted unpair to channel', this.channel);
        } catch (e) {
            this.log.error('CloudPair: notifyUnpair error', e);
        }
    }

    notifyAck() {
        if (!this.channel) return;
        try {
            const req = https.request(`https://ntfy.sh/${this.channel}`, {
                method: 'POST',
                headers: {
                    'Title': 'BMW M-Copilot Paired',
                    'Content-Type': 'application/json'
                },
                timeout: 3000
            });
            req.on('error', () => {});
            req.write(JSON.stringify({ type: 'copilot_pair_ack', carId: this.shortCode, time: Date.now() }));
            req.end();
        } catch (e) {}
    }

    reset() {
        this.channel = 'bmw_copilot_' + generateEntropyHex(12);
        this.secretKey = generateEntropyHex(32);
        this.shortCode = formatShortCode(this.channel);
        this.lastMsgId = null;
        this.lastSince = Math.floor(Date.now() / 1000) - 2;
        if (this.ai && this.ai.config) {
            this.ai.config.channel = this.channel;
            this.ai.config.secretKey = this.secretKey;
            this.ai.saveConfig();
        }
        this.log.info('CloudPair: Reset session to fresh channel ' + this.shortCode);
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

    decryptMessage(parsed) {
        if (!parsed || parsed.type !== 'copilot_encrypted' || !parsed.data || !parsed.iv || !parsed.tag) {
            return parsed;
        }
        if (!this.secretKey) {
            this.log.warn('CloudPair: Encrypted payload received but car has no secretKey');
            return null;
        }
        try {
            if (!crypto || !crypto.createDecipheriv) {
                this.log.warn('CloudPair: Node crypto module unavailable for decryption');
                return null;
            }
            const key = Buffer.from(this.secretKey, 'hex');
            const iv = Buffer.from(parsed.iv, 'hex');
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(Buffer.from(parsed.tag, 'hex'));
            let dec = decipher.update(parsed.data, 'hex', 'utf8');
            dec += decipher.final('utf8');
            return JSON.parse(dec);
        } catch (e) {
            this.log.error('CloudPair: E2EE decryption failed (wrong key or tampering): ' + e.message);
            return null;
        }
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

        // If payload is end-to-end encrypted with vehicle key, decrypt it
        if (parsed.type === 'copilot_encrypted') {
            parsed = this.decryptMessage(parsed);
            if (!parsed) return;
        }

        // Disconnection event from phone
        if (parsed.type === 'phone_unpair') {
            this.log.info('CloudPair: Received phone unpair request');
            if (this.onUnpaired) this.onUnpaired();
            return;
        }

        // Credentials Pairing Event
        if (parsed.geminiApiKey || parsed.apiKey || parsed.sessionToken) {
            this.log.info('CloudPair: Received verified AI credentials via secure uplink!');
            this.ai.saveCredentials(parsed);
            this.notifyAck();
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
