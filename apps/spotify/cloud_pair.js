'use strict';
/**
 * Cloud Pairing Manager for BMW iDrive 7 Spotify.
 *
 * Provides smartphone-to-car cloud pairing with zero-knowledge End-to-End Encryption (E2EE):
 *   1. Displays QR code on iDrive screen pointing to:
 *      https://hexlay.github.io/idrive7-custom-apps/pair.html?channel=<CHANNEL>&client_id=<CLIENT_ID>#k=<SECRET_KEY>
 *   2. Cryptographically isolated per vehicle (128-bit unique channel + 256-bit AES-GCM key).
 *   3. Secret key 'k' lives only in the car and in the phone's browser hash fragment (#k=...),
 *      NEVER sent across HTTP headers to GitHub or ntfy.sh servers.
 *   4. Mobile browser encrypts Spotify access/refresh tokens with AES-GCM before relaying.
 *   5. Only this specific car can decrypt and store the driver's Spotify tokens.
 *   6. Multi-car safe: each vehicle has an independent channel, encryption key, and storage.
 *   7. What the car tells the phone (paired, unpaired) is encrypted too, with its own key, and
 *      re-posted old messages are dropped (kit/link_crypto.js).
 */
const fs = require('fs');
const path = require('path');
const tlsDates = require('./tls_dates');
const link = require('./kit/link_crypto');

// polling the channel: quickly while waiting to be paired, slowly once paired (for the phone's unpair)
const PAIRING_POLL_MS = 2500;
const PAIRED_POLL_MS = 60000;
const BACKGROUND_POLL_MS = 30000;   // not paired, app not on screen

const crypto = require('crypto');

// pairing keys and channels come only from the system's CSPRNG
function generateEntropyHex(bytes) {
    return crypto.randomBytes(bytes).toString('hex');
}
const CHANNEL_PREFIX = 'bmw_spot_';

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
        this.log = (ctx && ctx.log) || console;
        this.spotify = spotifyClient;

        // Persist channel and secret key per car
        let savedChannel = null;
        let savedSecret = null;
        this.authFilePath = (this.ctx && this.ctx.dataDir) ?
            path.join(this.ctx.dataDir, 'spotify_auth.json') :
            path.join(__dirname, 'spotify_auth.json');

        try {
            if (fs.existsSync(this.authFilePath)) {
                const data = JSON.parse(fs.readFileSync(this.authFilePath, 'utf8'));
                if (data && data.channel) savedChannel = data.channel;
                if (data && data.secretKey) savedSecret = data.secretKey;
            }
        } catch (e) {}

        // a saved pairing is used only as a whole and in the expected shape
        const savedOk = link.validChannel(savedChannel, CHANNEL_PREFIX) && /^[0-9a-f]{64}$/.test(savedSecret || '');
        this.channel = savedOk ? savedChannel : (CHANNEL_PREFIX + generateEntropyHex(12));
        this.secretKey = savedOk ? savedSecret : generateEntropyHex(32);
        this.shortCode = formatShortCode(this.channel);
        this.fresh = new link.Freshness();

        // Persist if generated freshly
        if (!savedOk) {
            this.savePairingState();
        }

        this.pollInterval = null;
        this.isPolling = false;
        this.pollInFlight = false;
        this.lastPollAt = 0;
        this.lastMsgId = null;
        this.primed = false;
        this.onPaired = null;
        this.onUnpaired = null;
    }

    savePairingState() {
        try {
            let data = {};
            if (fs.existsSync(this.authFilePath)) {
                data = JSON.parse(fs.readFileSync(this.authFilePath, 'utf8')) || {};
            }
            data.channel = this.channel;
            data.secretKey = this.secretKey;
            // the same file holds the Spotify tokens: merged, and replaced atomically
            const tmp = this.authFilePath + '.tmp-' + process.pid;
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(tmp, this.authFilePath);
        } catch (e) {
            this.log.warn('CloudPair: Could not persist channel config: ' + e.message);
        }
    }

    getPairingUrl() {
        const clientId = (this.spotify && this.spotify.clientId) || '';
        const clientParam = clientId ? `&client_id=${clientId}` : '';
        return `https://hexlay.github.io/idrive7-custom-apps/pair.html?channel=${this.channel}${clientParam}#k=${this.secretKey}`;
    }

    getShortCode() {
        return this.shortCode;
    }

    /** Tell the phone something, encrypted for it (car -> phone key); fire and forget. */
    tellPhone(obj, title) {
        if (!this.channel) return;
        const wire = link.sealForPhone(this.secretKey, 'spotify_car', obj);
        if (!wire) return;
        try {
            const req = tlsDates.request({
                hostname: 'ntfy.sh',
                port: 443,
                path: '/' + this.channel,
                method: 'POST',
                headers: { 'Title': title, 'Content-Type': 'application/json' },
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
        this.tellPhone({ type: 'unpaired' }, 'BMW Spotify Unpaired');
        this.log.info('CloudPair: told the phone about the unpair');
    }

    notifyAck() {
        this.tellPhone({ type: 'pair_ack' }, 'BMW Spotify Paired');
    }

    reset() {
        this.channel = CHANNEL_PREFIX + generateEntropyHex(12);
        this.secretKey = generateEntropyHex(32);
        this.shortCode = formatShortCode(this.channel);
        this.lastMsgId = null;
        this.primed = false;
        this.fresh.reset();
        this.savePairingState();
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
            }

            try {
                this.pollInFlight = true;
                const req = tlsDates.get({
                    hostname: 'ntfy.sh',
                    port: 443,
                    path: pathStr,
                    timeout: 5000
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
                                    this.handleIncomingMessage(item.message, replay, item.time);
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
        return !!(this.spotify && (this.spotify.isAuthenticated ? this.spotify.isAuthenticated() : (this.spotify.isOnline && this.spotify.token)));
    }

    decryptMessage(parsed) {
        if (!parsed || parsed.type !== 'spotify_encrypted') return null;
        const inner = link.openFromPhone(this.secretKey, parsed);
        if (!inner) this.log.warn('Spotify CloudPair: a message did not authenticate (wrong key or tampering): ignored');
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
        if (!parsed || parsed.type !== 'spotify_encrypted') {
            const own = parsed && (parsed.type === 'spotify_car' || parsed.type === 'spotify_pair_ack' || parsed.type === 'spotify_unpaired');
            if (!own) this.log.warn('Spotify CloudPair: Ignoring unauthenticated plaintext message on pairing channel');
            return;
        }
        const wire = parsed;
        parsed = this.decryptMessage(wire);
        if (!parsed) return;
        // sent long before it reached the relay (a re-post), or seen already: not acted on
        if (!this.fresh.accept(parsed, wire, ntfyTime)) {
            this.log.warn('Spotify CloudPair: an old or repeated message on the channel: ignored');
            return;
        }

        // Phone unpair request
        if (parsed.type === 'phone_unpair') {
            if (!this.isPaired()) return;
            this.log.info('Spotify CloudPair: Received phone unpair request');
            if (this.onUnpaired) this.onUnpaired();
            return;
        }

        // Credentials Pairing Event
        if (typeof parsed.token === 'string' && parsed.token) {
            if (replay) return;
            this.log.info('Spotify CloudPair: Received verified Spotify token via secure uplink!');
            this.spotify.saveAuthTokens({
                token: parsed.token,
                refreshToken: parsed.refreshToken,
                expiresAt: parsed.expiresAt || (Date.now() + 3600000),
                clientId: parsed.clientId
            });
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
