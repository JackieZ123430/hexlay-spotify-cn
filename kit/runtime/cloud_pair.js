'use strict';
/**
 * cloud_pair.js - the phone <-> car pairing channel both apps share (Spotify, M-Copilot).
 *
 * End-to-end encrypted pairing over the public relay ntfy.sh:
 *   1. The car shows a QR code for a phone page with ?channel=<CHANNEL>#k=<SECRET_KEY>.
 *   2. Each car has its own channel (96 random bits) and AES-256-GCM key (256 bits).
 *   3. The key lives only in the car and in the link's #k= fragment, which browsers never send
 *      to a server (neither GitHub Pages nor ntfy.sh sees it).
 *   4. The phone encrypts what it sends (tokens, keys, settings) with it; the car acts only on
 *      messages that decrypt and authenticate, and drops re-posted or repeated ones.
 *   5. What the car tells the phone is encrypted too, with its own key (kit/link_crypto.js).
 *
 * The channel is read through one long-lived subscription (kit/relay_stream.js), not polled:
 * ntfy.sh limits requests per internet address, and polling used up the allowance the phone
 * shares with the car (its sends were then refused).
 *
 * An app subclasses CloudPair and gives:
 *   opts     { prefix: channel prefix, wire: 'spotify' | 'copilot' (message types), title, tag (log),
 *              load() -> { channel, secretKey } saved for this car or null, save(channel, secretKey) }
 *   isPaired()
 *   since()  where a new subscription starts (default: the last message seen, else the relay's 12 h)
 *   handle(msg, replay)   an authenticated, fresh message from the phone
 */
const crypto = require('crypto');
const tlsDates = require('./tls_dates');
const link = require('./link_crypto');
const { RelayStream } = require('./relay_stream');

// pairing keys and channels come only from the system's CSPRNG
const entropyHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

class CloudPair {
    constructor(ctx, opts) {
        this.ctx = ctx;
        this.log = (ctx && ctx.log) || console;
        this.opts = opts;
        this.tag = opts.tag || 'CloudPair';
        // a saved pairing is used only as a whole and in the expected shape
        const saved = (opts.load && opts.load()) || {};
        const savedOk = link.validChannel(saved.channel, opts.prefix) && /^[0-9a-f]{64}$/.test(saved.secretKey || '');
        this.channel = savedOk ? saved.channel : opts.prefix + entropyHex(12);
        this.secretKey = savedOk ? saved.secretKey : entropyHex(32);
        this.fresh = new link.Freshness();
        if (!savedOk) this.save();
        this.stream = new RelayStream({ get: tlsDates.get, log: this.log });
        this.lastMsgId = null;
        this.openServerTime = null;
        this.onPaired = null;
        this.onUnpaired = null;
    }

    /** Keep this car's channel and key (opts.save). */
    save() {
        try {
            if (this.opts.save) this.opts.save(this.channel, this.secretKey);
        } catch (e) {
            this.log.warn(this.tag + ': Could not persist channel config: ' + e.message);
        }
    }

    /** The pairing code under the QR code (the channel's first 8 hex digits). */
    getShortCode() {
        const raw = String(this.channel || '').slice(this.opts.prefix.length).toUpperCase();
        if (!raw) return '--------';
        return raw.length >= 8 ? raw.substring(0, 4) + '-' + raw.substring(4, 8) : raw;
    }

    /** Tell the phone something, encrypted for it (car -> phone key); fire and forget. */
    tellPhone(obj, title) {
        if (!this.channel) return;
        const wire = link.sealForPhone(this.secretKey, this.opts.wire + '_car', obj);
        if (!wire) return;
        try {
            const req = tlsDates.request({
                hostname: 'ntfy.sh',
                port: 443,
                path: '/' + this.channel,
                method: 'POST',
                headers: { 'Title': title || this.opts.title, 'Content-Type': 'application/json' },
                timeout: 5000,
            }, (res) => res.resume());
            req.on('error', () => {});
            req.on('timeout', () => req.destroy());
            req.write(JSON.stringify(wire));
            req.end();
        } catch (e) {
            this.log.warn(this.tag + ': could not reach the relay: ' + e.message);
        }
    }

    notifyAck() {
        this.tellPhone({ type: 'pair_ack' }, this.opts.title + ' Paired');
    }

    /** A new channel and key (after a disconnect): the old QR code and phone pages stop working. */
    reset() {
        this.channel = this.opts.prefix + entropyHex(12);
        this.secretKey = entropyHex(32);
        this.lastMsgId = null;
        this.fresh.reset();
        this.stream.stop();            // the next startPolling() subscribes to the new channel
        this.save();
        this.log.info(this.tag + ': Reset session to fresh channel ' + this.getShortCode());
    }

    since() {
        return this.lastMsgId || 'all';
    }

    /** Subscribe to the channel (one long-lived request; reconnects by itself). */
    startPolling() {
        if (this.stream.running) return;
        this.openServerTime = null;
        this.stream.start(this.channel, this.since(), (item) => {
            if (item.id) this.lastMsgId = item.id;
            // cached messages from before this subscription opened, on a car that is already
            // paired: the original pairing among them is not acted on again (the relay's clock
            // decides, not the head unit's)
            const replay = this.isPaired() && this.openServerTime !== null && typeof item.time === 'number' && item.time * 1000 < this.openServerTime - 5000;
            this.handleIncomingMessage(item.message, replay, item.time);
        }, (ms) => {
            if (this.openServerTime === null) this.openServerTime = ms;
        });
    }

    stopPolling() {
        this.stream.stop();
    }

    decryptMessage(parsed) {
        if (!parsed || parsed.type !== this.opts.wire + '_encrypted') return null;
        const inner = link.openFromPhone(this.secretKey, parsed);
        if (!inner) this.log.warn(this.tag + ': a message did not authenticate (wrong key or tampering): ignored');
        return inner;
    }

    handleIncomingMessage(rawMsg, replay, ntfyTime) {
        if (!rawMsg || typeof rawMsg !== 'string' || rawMsg.length > 8192) return;
        const trimmed = rawMsg.trim();
        if (trimmed.length < 3) return;
        let parsed = null;
        try { parsed = JSON.parse(trimmed); } catch (e) { /* not JSON: dropped below */ }
        const w = this.opts.wire;
        // The ntfy channel is public: only messages that decrypt and authenticate with this
        // car's pairing key (AES-256-GCM) are acted upon; plaintext pair/unpair is dropped.
        if (!parsed || parsed.type !== w + '_encrypted') {
            const own = parsed && (parsed.type === w + '_car' || parsed.type === w + '_pair_ack' || parsed.type === w + '_unpaired');
            if (!own) this.log.warn(this.tag + ': Ignoring unauthenticated plaintext message on pairing channel');
            return;
        }
        const msg = this.decryptMessage(parsed);
        if (!msg) return;
        // sent long before it reached the relay (a re-post), or seen already: not acted on
        if (!this.fresh.accept(msg, parsed, ntfyTime)) {
            this.log.warn(this.tag + ': an old or repeated message on the channel: ignored');
            return;
        }
        // the phone disconnects this car
        if (msg.type === 'phone_unpair') {
            if (!this.isPaired()) return;
            this.log.info(this.tag + ': Received phone unpair request');
            if (this.onUnpaired) this.onUnpaired();
            return;
        }
        this.handle(msg, replay);
    }
}

module.exports = { CloudPair };
