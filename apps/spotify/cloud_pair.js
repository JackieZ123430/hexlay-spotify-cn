'use strict';
/**
 * Spotify's phone pairing (kit/cloud_pair.js): the QR code opens
 *   https://hexlay.github.io/idrive7-custom-apps/pair.html?channel=<CHANNEL>&client_id=<CLIENT_ID>#k=<SECRET_KEY>
 * where the phone signs in to Spotify and sends the tokens to this car, encrypted with the key.
 * The channel and key are kept in spotify_auth.json with the tokens.
 */
const fs = require('fs');
const path = require('path');
const { CloudPair } = require('./kit/cloud_pair');

class CloudPairManager extends CloudPair {
    constructor(ctx, spotifyClient) {
        const file = (ctx && ctx.dataDir) ? path.join(ctx.dataDir, 'spotify_auth.json') : path.join(__dirname, 'spotify_auth.json');
        const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) || {} : {});
        super(ctx, {
            prefix: 'bmw_spot_', wire: 'spotify', title: 'BMW Spotify', tag: 'Spotify CloudPair',
            load: () => { try { return read(); } catch (e) { return null; } },
            save: (channel, secretKey) => {
                // the same file holds the Spotify tokens: merged, and replaced atomically
                const data = Object.assign(read(), { channel, secretKey });
                const tmp = file + '.tmp-' + process.pid;
                fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
                fs.renameSync(tmp, file);
            },
        });
        this.spotify = spotifyClient;
        this.authFilePath = file;
    }

    getPairingUrl() {
        const clientId = (this.spotify && this.spotify.clientId) || '';
        const clientParam = clientId ? `&client_id=${clientId}` : '';
        return `https://hexlay.github.io/idrive7-custom-apps/pair.html?channel=${this.channel}${clientParam}#k=${this.secretKey}`;
    }

    isPaired() {
        return !!(this.spotify && (this.spotify.isAuthenticated ? this.spotify.isAuthenticated() : (this.spotify.isOnline && this.spotify.token)));
    }

    handle(msg, replay) {
        // The phone asks whether this car is paired (to show "Connected" only when it is)
        if (msg.type === 'hello_request') {
            if (!replay) this.tellPhone({ type: 'car_hello', app: 'spotify', paired: this.isPaired() });
            return;
        }
        // the Spotify login from the phone
        if (typeof msg.token === 'string' && msg.token) {
            if (replay) return;
            this.log.info(this.tag + ': Received verified Spotify token via secure uplink!');
            this.spotify.saveAuthTokens({
                token: msg.token,
                refreshToken: msg.refreshToken,
                expiresAt: msg.expiresAt || (Date.now() + 3600000),
                clientId: msg.clientId,
            });
            this.notifyAck();
            if (this.onPaired) this.onPaired();
        }
    }
}

module.exports = { CloudPairManager };
