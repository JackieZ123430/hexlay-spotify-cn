'use strict';
/**
 * M-Copilot's phone pairing (kit/cloud_pair.js): the QR code opens
 *   https://hexlay.github.io/idrive7-custom-apps/copilot.html?channel=<CHANNEL>#k=<SECRET_KEY>
 * where the phone sets the AI provider and key, the model and the car profile, sent to this car
 * encrypted with the key. The channel and key are kept in the AI config (copilot_auth.json).
 */
const { CloudPair } = require('./kit/cloud_pair');

class CloudPairManager extends CloudPair {
    constructor(ctx, aiBridge) {
        super(ctx, {
            prefix: 'bmw_copilot_', wire: 'copilot', title: 'BMW M-Copilot',
            load: () => (aiBridge && aiBridge.config) || null,
            save: (channel, secretKey) => {
                if (!(aiBridge && aiBridge.config)) return;
                aiBridge.config.channel = channel;
                aiBridge.config.secretKey = secretKey;
                aiBridge.saveConfig();
            },
        });
        this.ai = aiBridge;
        // not paired: only the recent part of the relay's cache (an old pairing for a reset channel is no use)
        this.lastSince = Math.floor(Date.now() / 1000) - (this.isPaired() ? 2 : 7200);
        this.onHelloRequest = null;  // a phone page asks for the car's hello (main.js: paired, settings)
        this.onModel = null;
        this.onProfile = null;
    }

    getPairingUrl() {
        return `https://hexlay.github.io/idrive7-custom-apps/copilot.html?channel=${this.channel}#k=${this.secretKey}`;
    }

    isPaired() {
        return !!(this.ai && typeof this.ai.isConfigured === 'function' && this.ai.isConfigured());
    }

    reset() {
        this.lastSince = Math.floor(Date.now() / 1000) - 2;
        super.reset();
    }

    // from the last message seen; else, paired: the relay's whole cache (12 h) for what the
    // phone sent meanwhile; not paired: the recent part of it (lastSince)
    since() {
        return this.lastMsgId || (this.isPaired() ? 'all' : this.lastSince);
    }

    handle(msg, replay) {
        // The AI model picked on the phone page (also on a replay: AiBridge.setModel keeps only the newest)
        if (msg.type === 'copilot_model') {
            if (this.onModel) this.onModel(msg.provider, msg.model, msg.time);
            return;
        }
        // The owner's car profile (also on a replay: Vehicle.setProfile keeps only the newest)
        if (msg.type === 'copilot_profile') {
            if (this.onProfile) this.onProfile(msg.profile, msg.time);
            return;
        }
        // A phone page asks for the car's hello (not an old request read again from the relay).
        // push_subscribe / push_unsubscribe from phone pages before 1.0.17 are ignored.
        if (msg.type === 'hello_request') {
            if (!this.isPaired() || replay) return;
            if (this.onHelloRequest) this.onHelloRequest();
            return;
        }
        if (msg.type === 'push_subscribe' || msg.type === 'push_unsubscribe') return;
        // the AI credentials from the phone. From the relay's backlog (sent while M-Copilot was closed or
        // the car asleep) only a key newer than the one the car has: a new key or provider sent meanwhile
        // is taken, the original pairing (also still in the backlog) is not applied again.
        if (msg.geminiApiKey || msg.apiKey || msg.sessionToken) {
            if (replay && !(typeof msg.time === 'number' && msg.time > this.ai.keyTime())) return;
            this.log.info(this.tag + ': Received verified AI credentials via secure uplink' + (replay ? ' (sent while M-Copilot was closed)' : '') + '!');
            this.ai.saveCredentials(msg, msg.time);
            this.notifyAck();
            if (this.onPaired) this.onPaired();
        }
    }
}

module.exports = { CloudPairManager };
