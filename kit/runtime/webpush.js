'use strict';
/**
 * webpush.js - send a Web Push notification from the head unit (Node 8, no npm packages).
 *
 * The phone's browser makes a push subscription { endpoint, keys: { p256dh, auth } } and the
 * car keeps it. To notify, the car:
 *   1. encrypts the payload for that browser only (RFC 8291, "aes128gcm" content coding,
 *      RFC 8188): the push service (Apple, Google, Mozilla, Microsoft) sees ciphertext;
 *   2. signs a VAPID token with the car's own P-256 key (RFC 8292, ES256 JWT), so the
 *      subscription only accepts pushes from this car;
 *   3. POSTs it to the endpoint, which must be one of the known push services.
 *
 * No server of ours is involved. The car must be awake and online to send.
 */
const url = require('url');

let crypto;
try { crypto = require('crypto'); } catch (e) { crypto = null; }

// endpoints the car may POST to: the browsers' push services, nothing else
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'web.push.apple.com', 'push.services.mozilla.com', 'notify.windows.com'];
const RECORD_SIZE = 4096;
const MAX_PAYLOAD = 3000;
// "sub" in the VAPID token: who sends, as the push services ask; the project, no person
const VAPID_SUBJECT = 'https://github.com/hexlay/idrive7-custom-apps';

const b64u = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) return null;
    const t = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(t + '==='.slice((t.length + 3) % 4), 'base64');
};
const pad32 = (b) => (b.length >= 32 ? b.slice(b.length - 32) : Buffer.concat([Buffer.alloc(32 - b.length), b]));
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** A new VAPID key pair: { publicKey, privateKey } as base64url (65-byte point, 32-byte scalar). */
function generateVapidKeys() {
    const e = crypto.createECDH('prime256v1');
    e.generateKeys();
    return { publicKey: b64u(e.getPublicKey()), privateKey: b64u(pad32(e.getPrivateKey())) };
}

/** Is k a usable VAPID key pair (the public key belongs to the private one)? */
function validVapidKeys(k) {
    try {
        const priv = fromB64u(k && k.privateKey), pub = fromB64u(k && k.publicKey);
        if (!priv || priv.length !== 32 || !pub || pub.length !== 65 || pub[0] !== 4) return false;
        const e = crypto.createECDH('prime256v1');
        e.setPrivateKey(priv);
        return e.getPublicKey().equals(pub);
    } catch (e) {
        return false;
    }
}

/** SEC1 "EC PRIVATE KEY" PEM for a raw P-256 key (Node 8's createSign wants a PEM). */
function privatePem(priv, pub) {
    const der = Buffer.concat([
        Buffer.from('30770201010420', 'hex'), priv,
        Buffer.from('a00a06082a8648ce3d030107a144034200', 'hex'), pub,
    ]);
    return '-----BEGIN EC PRIVATE KEY-----\n' + der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '') + '\n-----END EC PRIVATE KEY-----\n';
}

/** DER ECDSA signature -> the JWS form (r || s, 32 bytes each). */
function derToJose(der) {
    let i = 2;
    if (der[1] & 0x80) i += der[1] & 0x7f;
    const rLen = der[i + 1], r = der.slice(i + 2, i + 2 + rLen);
    i = i + 2 + rLen;
    const sLen = der[i + 1], s = der.slice(i + 2, i + 2 + sLen);
    return Buffer.concat([pad32(r), pad32(s)]);
}

/** The VAPID Authorization header value for an endpoint origin, valid until expSec. */
function vapidAuth(vapid, audience, expSec) {
    const priv = fromB64u(vapid.privateKey), pub = fromB64u(vapid.publicKey);
    const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const claims = b64u(Buffer.from(JSON.stringify({ aud: audience, exp: expSec, sub: VAPID_SUBJECT })));
    const input = header + '.' + claims;
    const sig = crypto.createSign('SHA256').update(input).sign(privatePem(priv, pub));
    return 'vapid t=' + input + '.' + b64u(derToJose(sig)) + ', k=' + vapid.publicKey;
}

/**
 * Encrypt a payload for one subscription (RFC 8291 / RFC 8188, one record).
 * salt and asKeys are for tests only; normally random.
 */
function encrypt(payload, keys, salt, asKeys) {
    const ua = fromB64u(keys && keys.p256dh), auth = fromB64u(keys && keys.auth);
    if (!ua || ua.length !== 65 || ua[0] !== 4 || !auth || auth.length !== 16) throw new Error('bad subscription keys');
    const as = crypto.createECDH('prime256v1');
    if (asKeys) as.setPrivateKey(asKeys); else as.generateKeys();
    const asPub = as.getPublicKey();
    const shared = as.computeSecret(ua);
    const prkKey = hmac(auth, shared);
    const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), ua, asPub, Buffer.from([1])]));
    salt = salt || crypto.randomBytes(16);
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).slice(0, 16);
    const iv = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).slice(0, 12);
    const c = crypto.createCipheriv('aes-128-gcm', cek, iv);
    const body = Buffer.concat([c.update(Buffer.concat([payload, Buffer.from([2])])), c.final(), c.getAuthTag()]);
    const rs = Buffer.alloc(4);
    rs.writeUInt32BE(RECORD_SIZE, 0);
    return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, body]);
}

/** The endpoint as { hostname, path, origin } when it is https on a known push service; else null. */
function checkEndpoint(endpoint) {
    if (typeof endpoint !== 'string' || endpoint.length > 1024) return null;
    let u;
    try { u = url.parse(endpoint); } catch (e) { return null; }
    if (u.protocol !== 'https:' || !u.hostname || (u.port && u.port !== '443') || u.auth) return null;
    const host = u.hostname.toLowerCase();
    if (!PUSH_HOSTS.some((h) => host === h || host.slice(-(h.length + 1)) === '.' + h)) return null;
    return { hostname: host, path: u.path || '/', origin: 'https://' + host };
}

/** A subscription object as the page sends it, checked; or null. */
function checkSubscription(sub) {
    if (!sub || typeof sub !== 'object' || !sub.keys) return null;
    const ep = checkEndpoint(sub.endpoint);
    const ua = fromB64u(sub.keys.p256dh), auth = fromB64u(sub.keys.auth);
    if (!ep || !ua || ua.length !== 65 || ua[0] !== 4 || !auth || auth.length !== 16) return null;
    return { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
}

/**
 * Send one notification.
 *   opts.request   https.request-like (tls_dates.request on the car)
 *   opts.now()     the best known real time in ms (the car's clock may be days off)
 *   opts.ttl       seconds the push service keeps it while the phone is offline (default 12 h)
 *   opts.topic     replaces an undelivered notification with the same topic (a-zA-Z0-9_-, <= 32)
 * Resolves { status, date } (date: the service's Date header in ms, for clock correction).
 * Status 404 / 410: the subscription is gone and should be forgotten.
 */
function send(sub, vapid, data, opts) {
    return new Promise((resolve, reject) => {
        if (!crypto) { reject(new Error('no crypto')); return; }
        const ep = checkEndpoint(sub && sub.endpoint);
        if (!ep) { reject(new Error('endpoint not allowed')); return; }
        const payload = Buffer.from(JSON.stringify(data), 'utf8');
        if (payload.length > MAX_PAYLOAD) { reject(new Error('payload too large')); return; }
        let body;
        try { body = encrypt(payload, sub.keys); } catch (e) { reject(e); return; }
        const now = (opts && opts.now) ? opts.now() : Date.now();
        const headers = {
            'Content-Type': 'application/octet-stream',
            'Content-Encoding': 'aes128gcm',
            'Content-Length': body.length,
            TTL: String((opts && opts.ttl) || 43200),
            Urgency: (opts && opts.urgency) || 'normal',
            Authorization: vapidAuth(vapid, ep.origin, Math.floor(now / 1000) + 12 * 3600),
        };
        if (opts && opts.topic && /^[A-Za-z0-9_-]{1,32}$/.test(opts.topic)) headers.Topic = opts.topic;
        const req = ((opts && opts.request) || require('https').request)({
            hostname: ep.hostname, port: 443, path: ep.path, method: 'POST', headers, timeout: 15000,
        }, (res) => {
            res.resume();
            const d = Date.parse(res.headers && res.headers.date);
            resolve({ status: res.statusCode, date: isFinite(d) ? d : null });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end(body);
    });
}

module.exports = { generateVapidKeys, validVapidKeys, vapidAuth, encrypt, send, checkEndpoint, checkSubscription, b64u, fromB64u, PUSH_HOSTS };
