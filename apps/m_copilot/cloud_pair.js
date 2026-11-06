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
 *   7. What the car tells the phone (paired, unpaired, its notification key) is encrypted too,
 *      with its own key, and re-posted old messages are dropped (kit/link_crypto.js).
 */
const tlsDates = require('./tls_dates');
const link = require('./kit/link_crypto');
const { RelayStream } = require('./kit/relay_stream');
const crypto = require('crypto');

// The channel is read (while M-Copilot is on screen) through one long-lived subscription
// (kit/relay_stream.js), not polled: ntfy.sh limits requests per internet address, and polling
// used up the allowance the phone shares with the car (its sends were then refused).
const CHANNEL_PREFIX = 'bmw_copilot_';

// pairing keys and channels come only from the system's CSPRNG
function generateEntropyHex(bytes) {
    return crypto.randomBytes(bytes).toString('hex');
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
        // a saved pairing is used only as a whole and in the expected shape
        const cfg = (this.ai && this.ai.config) || {};
        const savedOk = link.validChannel(cfg.channel, CHANNEL_PREFIX) && /^[0-9a-f]{64}$/.test(cfg.secretKey || '');
        this.channel = savedOk ? cfg.channel : (CHANNEL_PREFIX + generateEntropyHex(12));
        this.secretKey = savedOk ? cfg.secretKey : generateEntropyHex(32);
        this.fresh = new link.Freshness();

        if (this.ai && this.ai.config && !savedOk) {
            this.ai.config.channel = this.channel;
            this.ai.config.secretKey = this.secretKey;
            this.ai.saveConfig();
        }

        this.shortCode = formatShortCode(this.channel);
        this.stream = new RelayStream({ get: tlsDates.get, log: this.log });
        this.lastMsgId = null;
        this.openServerTime = null;
        const isCfg = (this.ai && typeof this.ai.isConfigured === 'function') ? this.ai.isConfigured() : false;
        this.lastSince = Math.floor(Date.now() / 1000) - (isCfg ? 2 : 7200);

        this.onPaired = null;
        this.onUnpaired = null;
        // phone notifications (phone_push.js): the phone's requests, and the relay's clock
        this.onPush = null;          // (message) for push_subscribe / push_unsubscribe / hello_request
        this.onServerTime = null;    // (ms) from each poll's Date header
    }

    getPairingUrl() {
        return `https://hexlay.github.io/idrive7-custom-apps/copilot.html?channel=${this.channel}#k=${this.secretKey}`;
    }

    getShortCode() {
        return this.shortCode;
    }

    /** Tell the phone something, encrypted for it (car -> phone key); fire and forget. */
    tellPhone(obj, title) {
        if (!this.channel) return;
        const wire = link.sealForPhone(this.secretKey, 'copilot_car', obj);
        if (!wire) return;
        try {
            const req = tlsDates.request({
                hostname: 'ntfy.sh',
                port: 443,
                path: '/' + this.channel,
                method: 'POST',
                headers: { 'Title': title || 'BMW M-Copilot', 'Content-Type': 'application/json' },
                timeout: 5000
            }, (res) => res.resume());
            req.on('error', () => {});
            req.on('timeout', () => req.destroy());
            req.write(JSON.stringify(wire));
            req.end();
        } catch (e) {
            this.log.warn('CloudPair: could not reach the relay: ' + e.message);
        }
    }

    /** Before the pairing is dropped (still with the old key, which the phone has). */
    notifyUnpair() {
        this.tellPhone({ type: 'unpaired' }, 'BMW M-Copilot Unpaired');
        this.log.info('CloudPair: told the phone about the unpair');
    }

    notifyAck() {
        this.tellPhone({ type: 'pair_ack' }, 'BMW M-Copilot Paired');
    }

    reset() {
        this.channel = CHANNEL_PREFIX + generateEntropyHex(12);
        this.secretKey = generateEntropyHex(32);
        this.shortCode = formatShortCode(this.channel);
        this.lastMsgId = null;
        this.fresh.reset();
        this.stream.stop();            // the next startPolling() subscribes to the new channel
        this.lastSince = Math.floor(Date.now() / 1000) - 2;
        if (this.ai && this.ai.config) {
            this.ai.config.channel = this.channel;
            this.ai.config.secretKey = this.secretKey;
            this.ai.saveConfig();
        }
        this.log.info('CloudPair: Reset session to fresh channel ' + this.shortCode);
    }

    /** Subscribe to the channel (one long-lived request; reconnects by itself). */
    startPolling() {
        if (this.stream.running) return;
        this.openServerTime = null;
        // from the last message seen; else, paired: the relay's whole cache (12 h) for what the
        // phone sent meanwhile; not paired: the recent part of it (lastSince)
        const since = this.lastMsgId || (this.isPaired() ? 'all' : this.lastSince);
        this.stream.start(this.channel, since, (item) => {
            if (item.id) this.lastMsgId = item.id;
            // cached messages from before this subscription opened, on a car that is already
            // paired: the original pairing among them is not acted on again (the relay's clock
            // decides, not the head unit's)
            const replay = this.isPaired() && this.openServerTime !== null && typeof item.time === 'number' && item.time * 1000 < this.openServerTime - 5000;
            this.handleIncomingMessage(item.message, replay, item.time);
        }, (ms) => {
            if (this.openServerTime === null) this.openServerTime = ms;
            if (this.onServerTime) this.onServerTime(ms);
        });
    }

    isPaired() {
        return !!(this.ai && this.ai.isConfigured());
    }

    decryptMessage(parsed) {
        if (!parsed || parsed.type !== 'copilot_encrypted') return null;
        const inner = link.openFromPhone(this.secretKey, parsed);
        if (!inner) this.log.warn('CloudPair: a message did not authenticate (wrong key or tampering): ignored');
        return inner;
    }

    handleIncomingMessage(rawMsg, replay, ntfyTime) {
        if (!rawMsg || typeof rawMsg !== 'string' || rawMsg.length > 8192) return;
        const trimmed = rawMsg.trim();
        if (trimmed.length < 3) return;

        let parsed = null;
        try {
            parsed = JSON.parse(trimmed);
        } catch (e) {}

        // The ntfy channel is public: only messages that decrypt and authenticate with this
        // car's pairing key (AES-256-GCM) are acted upon; plaintext pair/unpair is dropped.
        if (!parsed || parsed.type !== 'copilot_encrypted') {
            const own = parsed && (parsed.type === 'copilot_car' || parsed.type === 'copilot_pair_ack' || parsed.type === 'copilot_unpaired');
            if (!own) this.log.warn('CloudPair: Ignoring unauthenticated plaintext message on pairing channel');
            return;
        }
        const wire = parsed;
        parsed = this.decryptMessage(wire);
        if (!parsed) return;
        // sent long before it reached the relay (a re-post), or seen already: not acted on
        if (!this.fresh.accept(parsed, wire, ntfyTime)) {
            this.log.warn('CloudPair: an old or repeated message on the channel: ignored');
            return;
        }

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

        // Phone notifications: subscribe / unsubscribe this phone, or ask for the car's push key.
        // Subscribing is idempotent (newest per phone wins), so a replayed one changes nothing.
        if (parsed.type === 'push_subscribe' || parsed.type === 'push_unsubscribe' || parsed.type === 'hello_request') {
            if (!this.isPaired()) return;
            if (parsed.type === 'hello_request' && replay) return;
            if (this.onPush) this.onPush(parsed);
            return;
        }

        // Credentials Pairing Event
        if (parsed.geminiApiKey || parsed.apiKey || parsed.sessionToken) {
            if (replay) return;
            this.log.info('CloudPair: Received verified AI credentials via secure uplink!');
            this.ai.saveCredentials(parsed);
            this.notifyAck();
            if (this.onPaired) this.onPaired();
        }
    }

    stopPolling() {
        this.stream.stop();
    }
}

module.exports = { CloudPairManager };
