'use strict';
/**
 * HTTPS for a head unit whose clock may be days off (modelled on mgu-store's
 * mgu-updater fetch.js). Node 8.
 *
 * Each connection is checked as Node checks it. When the only complaint is a
 * certificate's dates (CERT_NOT_YET_VALID, CERT_HAS_EXPIRED), the presented
 * chain is checked again without them (certs.js: every signature up to a
 * trusted root, CA constraints, key usages) and the host name with
 * tls.checkServerIdentity. Any other complaint, or a chain that fails that
 * check, destroys the socket before a single byte of the request is sent.
 *
 *   request(options, onResponse) -> req   like https.request(options, cb):
 *       write(), end(), destroy(), abort(); 'error' and
 *       'timeout' events; options.timeout covers the handshake as well
 *   get(options, onResponse) -> req       like https.get
 *   connect(options, cb)                  cb(err, verifiedTlsSocket)
 *   agent(opts) -> https.Agent            keep-alive agent: each new connection goes through
 *       connect() (the same check, before the request is written); idle connections are reused,
 *       so a request skips the TCP + TLS handshake. request(Object.assign(o, { agent })) uses it.
 */
const EventEmitter = require('events');
const crypto = require('crypto');
const https = require('https');
const net = require('net');
const tls = require('tls');
const certs = require('./certs');

const DATE_ERRORS = ['CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED'];
// chains already re-verified (sha256 of host + chain), so a 2.5 s poll does not redo the signatures
const verified = [];
const VERIFIED_MAX = 16;

/* Why sock's certificate is refused once its dates are left out; null if it is not. */
function refusedButForDates(sock, host, ca) {
    const peer = sock.getPeerCertificate(true);
    const chain = [];
    for (let c = peer; c && c.raw && !chain.some((d) => d.equals(c.raw)); c = c.issuerCertificate) {
        chain.push(c.raw);
    }
    const name = tls.checkServerIdentity(host, peer);
    if (name) {
        return name.message;
    }
    const key = crypto.createHash('sha256').update(host + '\n').update(Buffer.concat(chain)).digest('hex');
    if (verified.indexOf(key) >= 0) {
        return null;
    }
    const why = certs.verifyChain(chain, ca ? certs.pemCerts(ca) : certs.nodeRoots());
    if (!why) {
        verified.push(key);
        if (verified.length > VERIFIED_MAX) verified.shift();
    }
    return why;
}

/* Why sock may not be used; null when its certificate checks out (dates aside). */
function refusal(sock, host, ca) {
    if (sock.authorized) {
        return null;
    }
    const code = sock.authorizationError;
    if (DATE_ERRORS.indexOf(code) < 0) {
        return String(code || 'unverified certificate');
    }
    let why;
    try {
        why = refusedButForDates(sock, host, ca);
    } catch (e) {
        why = e.message;
    }
    return why ? `${code}, and ${why}` : null;
}

function connect(options, cb) {
    const host = options.hostname || options.host;
    let done = false;
    const sock = tls.connect({
        host,
        port: Number(options.port) || 443,
        servername: options.servername || (net.isIP(host) ? undefined : host),
        ca: options.ca || undefined,
        // checked below, before anything is written
        rejectUnauthorized: false
    }, () => {
        if (done) return;
        const why = refusal(sock, host, options.ca);
        if (why) {
            done = true;
            sock.destroy();
            cb(Object.assign(new Error(`${host}: certificate refused (${why})`), { code: 'CERT_REFUSED', refused: true }));
            return;
        }
        done = true;
        sock.removeListener('error', onError);
        cb(null, sock);
    });
    const onError = (err) => {
        if (!done) {
            done = true;
            cb(err);
        }
    };
    sock.on('error', onError);
    return sock;
}

const IDLE_MS = 20000;   // an idle kept-alive connection is closed after this

class VerifiedAgent extends https.Agent {
    // async: the agent waits for cb, so nothing is written before the certificate is checked
    createConnection(options, cb) {
        connect(options, (err, sock) => {
            if (err) return cb(err);
            sock.setKeepAlive(true, 10000);
            cb(null, sock);
        });
    }
}

function agent(opts) {
    const a = new VerifiedAgent(Object.assign({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 4, maxFreeSockets: 2 }, opts));
    // close connections that stay idle, rather than finding them dead at the next request
    a.on('free', (sock) => {
        sock.setTimeout(IDLE_MS);
        if (!sock._idleWatch) {
            sock._idleWatch = true;
            sock.on('timeout', () => { if (!sock._httpMessage) sock.destroy(); });
        }
    });
    return a;
}

function request(options, onResponse) {
    if (options.agent instanceof VerifiedAgent) return https.request(options, onResponse);
    const req = new EventEmitter();
    const pending = [];
    let ended = false;
    let real = null;
    let sock = null;
    let dead = false;
    let timer = null;
    const timeout = options.timeout;

    const fail = (err) => {
        if (dead) return;
        dead = true;
        clearTimeout(timer);
        req.emit('error', err);
    };
    if (timeout) {
        // the handshake; the request's own socket timeout takes over after it
        timer = setTimeout(() => { if (!dead && !real) req.emit('timeout'); }, timeout);
    }

    sock = connect(options, (err, verifiedSock) => {
        if (dead) {
            if (verifiedSock) verifiedSock.destroy();
            return;
        }
        if (err) {
            fail(err);
            return;
        }
        clearTimeout(timer);
        const opts = Object.assign({}, options, {
            defaultPort: 443,
            agent: undefined,
            createConnection: () => verifiedSock
        });
        delete opts.timeout;
        real = https.request(opts, onResponse);
        real.on('error', (e) => { if (!dead) { dead = true; req.emit('error', e); } });
        if (timeout) {
            real.setTimeout(timeout, () => { if (!dead) req.emit('timeout'); });
        }
        pending.forEach((c) => real.write(c));
        pending.length = 0;
        if (ended) real.end();
    });

    req.write = (chunk) => {
        if (real) real.write(chunk);
        else pending.push(chunk);
        return true;
    };
    req.end = (chunk) => {
        if (chunk !== undefined && chunk !== null) req.write(chunk);
        ended = true;
        if (real) real.end();
        return req;
    };
    req.destroy = req.abort = () => {
        if (dead) return;
        dead = true;
        clearTimeout(timer);
        if (real) real.abort();
        else if (sock) sock.destroy();
    };
    return req;
}

function get(options, onResponse) {
    const req = request(Object.assign({}, options, { method: 'GET' }), onResponse);
    req.end();
    return req;
}

module.exports = { request, get, connect, agent, refusal, DATE_ERRORS };
