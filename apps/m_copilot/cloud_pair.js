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
const tlsDates = require('./tls_dates');
let crypto;
try { crypto = require('crypto'); } catch (e) {}

// polling the channel: quickly while waiting to be paired, slowly once paired (for the phone's unpair)
const PAIRING_POLL_MS = 2500;
const PAIRED_POLL_MS = 60000;
const BACKGROUND_POLL_MS = 30000;   // not paired, app not on screen

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
        this.pollInFlight = false;
        this.lastPollAt = 0;
        this.lastMsgId = null;
        this.primed = false;
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
            const req = tlsDates.request({
                hostname: 'ntfy.sh',
                port: 443,
                path: '/' + this.channel,
                method: 'POST',
                headers: {
                    'Title': 'BMW M-Copilot Unpaired',
                    'Content-Type': 'application/json'
                },
                timeout: 3000
            }, (res) => res.resume());
            req.on('error', () => {});
            req.on('timeout', () => req.destroy());
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
            const req = tlsDates.request({
                hostname: 'ntfy.sh',
                port: 443,
                path: '/' + this.channel,
                method: 'POST',
                headers: {
                    'Title': 'BMW M-Copilot Paired',
                    'Content-Type': 'application/json'
                },
                timeout: 3000
            }, (res) => res.resume());
            req.on('error', () => {});
            req.on('timeout', () => req.destroy());
            req.write(JSON.stringify({ type: 'copilot_pair_ack', carId: this.shortCode, time: Date.now() }));
            req.end();
        } catch (e) {}
    }

    reset() {
        this.channel = 'bmw_copilot_' + generateEntropyHex(12);
        this.secretKey = generateEntropyHex(32);
        this.shortCode = formatShortCode(this.channel);
        this.lastMsgId = null;
        this.primed = false;
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
            // one poll at a time (a stalled one is given up after 20 s)
            if (this.pollInFlight && Date.now() - this.lastPollAt < 20000) return;
            // Once paired, keep polling slowly so a phone-side (authenticated) unpair still arrives
            const paired = this.isPaired();
            if (paired && Date.now() - this.lastPollAt < PAIRED_POLL_MS) return;
            if (!paired && this.isOnScreen && !this.isOnScreen() && Date.now() - this.lastPollAt < BACKGROUND_POLL_MS) return;
            this.lastPollAt = Date.now();
            // The first poll of a channel we are already paired on returns the cached history,
            // the original pairing message included: that is not acted on again.
            const replay = paired && !this.primed;
            const channel = this.channel;

            let pathStr = `/${channel}/json?poll=1`;
            if (this.lastMsgId) {
                pathStr += `&since=${encodeURIComponent(this.lastMsgId)}`;
            } else if (this.lastSince && !paired) {
                pathStr += `&since=${this.lastSince}`;
            }

            try {
                this.pollInFlight = true;
                const req = tlsDates.get({
                    hostname: 'ntfy.sh',
                    port: 443,
                    path: pathStr,
                    timeout: 4000
                }, (res) => {
                    let data = '';
                    res.on('data', (c) => { data += c; });
                    res.on('end', () => {
                        this.pollInFlight = false;
                        if (channel !== this.channel || res.statusCode !== 200) return;
                        this.primed = true;
                        const trimmed = data.trim();
                        if (!trimmed) return;

                        const lines = trimmed.split('\n');
                        for (const line of lines) {
                            // an unpair just moved us to a fresh channel: the rest belongs to the old one
                            if (channel !== this.channel) break;
                            if (!line.trim()) continue;
                            try {
                                const item = JSON.parse(line);
                                if (item.id) {
                                    this.lastMsgId = item.id;
                                }
                                if (item.event === 'message' && item.message) {
                                    this.handleIncomingMessage(item.message, replay);
                                }
                            } catch (e) {
                                // not ntfy JSON: nothing authenticated in it
                            }
                        }
                    });
                });
                req.on('error', () => { this.pollInFlight = false; });
                req.on('timeout', () => { req.destroy(); this.pollInFlight = false; });
            } catch (e) {
                this.pollInFlight = false;
                this.log.warn('CloudPair check error: ' + e.message);
            }
        };

        this.pollInterval = setInterval(check, PAIRING_POLL_MS);
        check();
    }

    isPaired() {
        return !!(this.ai && this.ai.isConfigured());
    }

    decryptMessage(parsed) {
        if (!parsed || parsed.type !== 'copilot_encrypted' || typeof parsed.data !== 'string' ||
            typeof parsed.iv !== 'string' || typeof parsed.tag !== 'string') {
            return null;
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
            const tag = Buffer.from(parsed.tag, 'hex');
            // Node 8 accepts truncated GCM tags; only a full 128-bit tag authenticates
            if (key.length !== 32 || iv.length !== 12 || tag.length !== 16) {
                this.log.warn('CloudPair: Malformed encrypted payload ignored');
                return null;
            }
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(tag);
            let dec = decipher.update(parsed.data, 'hex', 'utf8');
            dec += decipher.final('utf8');
            return JSON.parse(dec);
        } catch (e) {
            this.log.error('CloudPair: E2EE decryption failed (wrong key or tampering): ' + e.message);
            return null;
        }
    }

    handleIncomingMessage(rawMsg, replay) {
        if (!rawMsg || typeof rawMsg !== 'string') return;
        const trimmed = rawMsg.trim();
        if (trimmed.length < 3) return;

        let parsed = null;
        try {
            parsed = JSON.parse(trimmed);
        } catch (e) {}

        // The ntfy channel is public: only messages that decrypt and authenticate with this
        // car's pairing key (AES-256-GCM) are acted upon; plaintext pair/unpair is dropped.
        if (!parsed || parsed.type !== 'copilot_encrypted') {
            const own = parsed && (parsed.type === 'copilot_pair_ack' || parsed.type === 'copilot_unpaired');
            if (!own) this.log.warn('CloudPair: Ignoring unauthenticated plaintext message on pairing channel');
            return;
        }
        parsed = this.decryptMessage(parsed);
        if (!parsed || typeof parsed !== 'object') return;

        // Disconnection event from phone
        if (parsed.type === 'phone_unpair') {
            if (!this.isPaired()) return;
            this.log.info('CloudPair: Received phone unpair request');
            if (this.onUnpaired) this.onUnpaired();
            return;
        }

        // The AI model picked on the phone page (also on a replay: AiBridge.setModel keeps only the newest)
        if (parsed.type === 'copilot_model') {
            if (this.onModel) this.onModel(parsed.provider, parsed.model, parsed.time);
            return;
        }

        // The owner's car profile (also on a replay: Vehicle.setProfile keeps only the newest)
        if (parsed.type === 'copilot_profile') {
            if (this.onProfile) this.onProfile(parsed.profile, parsed.time);
            return;
        }

        // Credentials Pairing Event
        if (parsed.geminiApiKey || parsed.apiKey || parsed.sessionToken) {
            if (replay) return;
            this.log.info('CloudPair: Received verified AI credentials via secure uplink!');
            this.ai.saveCredentials(parsed);
            this.notifyAck();
            this.lastPollAt = Date.now();
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
