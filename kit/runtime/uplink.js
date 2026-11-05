'use strict';
/**
 * uplink.js - Uplink Network & DNS Resolution Layer for BMW iDrive 7 (MGU).
 *
 * MGU Architecture Note:
 * On BMW MGU, network traffic for internet-enabled apps is routed via routing
 * table 110 through an isolated veth / cellular / Wi-Fi uplink interface.
 * The vehicle's main /etc/resolv.conf is intentionally untouched and does NOT
 * resolve public internet domain names (queries fail with ENOTFOUND).
 *
 * The uplink service writes the current DHCP lease and valid DNS servers to:
 * - /var/opt/public/oap/oap_<uid>/data/uplink.json (the app's dataDir)
 * - /run/mgu-uplink/lease.json (system-wide 0644)
 *
 * This module:
 * 1. Process-wide intercepts Node's `dns.lookup` so all standard Node http/https
 *    requests, libraries, and child calls seamlessly resolve domain names via
 *    the active uplink DNS servers + resilient public fallbacks (1.1.1.1, 8.8.8.8).
 * 2. Caches resolved DNS records in memory with a 5-minute TTL.
 * 3. Provides direct-IP and uplink lease verification for fast, reliable offline/online detection.
 */
const dns = require('dns');
const fs = require('fs');
const https = require('https');
const net = require('net');
const path = require('path');

let initialized = false;
let appDataDir = null;
let origLookup = dns.lookup;
let customResolver = null;
let activeDnsServersKey = '';

// In-memory DNS cache: hostname -> { addresses: string[], expires: number }
const dnsCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const PUBLIC_FALLBACK_DNS = ['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4'];

/**
 * Reads DNS servers from uplink lease files or defaults to public DNS.
 */
function getActiveDnsServers() {
    const candidates = [
        appDataDir ? path.join(appDataDir, 'uplink.json') : null,
        '/run/mgu-uplink/lease.json'
    ].filter(Boolean);

    for (let i = 0; i < candidates.length; i++) {
        const file = candidates[i];
        try {
            if (fs.existsSync(file)) {
                const raw = fs.readFileSync(file, 'utf8');
                const lease = JSON.parse(raw);
                if (lease && Array.isArray(lease.dns) && lease.dns.length > 0) {
                    const valid = lease.dns.filter(ip => net.isIP(ip) === 4);
                    if (valid.length > 0) {
                        // Append public fallbacks after the carrier / mobile hotspot DNS
                        const combined = valid.slice();
                        for (let j = 0; j < PUBLIC_FALLBACK_DNS.length; j++) {
                            if (combined.indexOf(PUBLIC_FALLBACK_DNS[j]) === -1) {
                                combined.push(PUBLIC_FALLBACK_DNS[j]);
                            }
                        }
                        return combined;
                    }
                }
            }
        } catch (e) {}
    }

    return PUBLIC_FALLBACK_DNS;
}

/**
 * Returns an active dns.Resolver instance configured with the latest uplink DNS.
 */
function getResolver() {
    if (typeof dns.Resolver !== 'function') {
        return null;
    }

    const servers = getActiveDnsServers();
    const key = servers.join(',');

    if (!customResolver || key !== activeDnsServersKey) {
        try {
            const res = new dns.Resolver();
            res.setServers(servers);
            customResolver = res;
            activeDnsServersKey = key;
        } catch (err) {
            // If setting custom servers fails, keep existing
        }
    }
    return customResolver;
}

/**
 * Process-wide patched dns.lookup implementation.
 */
function patchedLookup(hostname, options, callback) {
    let cb = callback;
    let opts = options;

    if (typeof options === 'function') {
        cb = options;
        opts = {};
    } else if (typeof options === 'number') {
        opts = { family: options };
    } else if (!opts || typeof opts !== 'object') {
        opts = {};
    }

    if (!hostname || typeof hostname !== 'string') {
        return origLookup(hostname, opts, cb);
    }

    // Direct IP or local address: no DNS lookup needed
    if (net.isIP(hostname) || hostname === 'localhost') {
        return origLookup(hostname, opts, cb);
    }

    // Check memory cache
    const now = Date.now();
    const cached = dnsCache.get(hostname);
    if (cached && cached.expires > now && cached.addresses && cached.addresses.length > 0) {
        if (opts.all) {
            return process.nextTick(() => {
                cb(null, cached.addresses.map(a => ({ address: a, family: 4 })));
            });
        }
        return process.nextTick(() => {
            cb(null, cached.addresses[0], 4);
        });
    }

    const resolver = getResolver();
    if (!resolver) {
        return origLookup(hostname, opts, cb);
    }

    resolver.resolve4(hostname, (err, addrs) => {
        if (!err && addrs && addrs.length > 0) {
            dnsCache.set(hostname, {
                addresses: addrs,
                expires: now + CACHE_TTL_MS
            });

            if (opts.all) {
                return cb(null, addrs.map(a => ({ address: a, family: 4 })));
            }
            return cb(null, addrs[0], 4);
        }

        // If uplink resolver fails, fall back to system origLookup as last resort
        origLookup(hostname, opts, (sysErr, address, family) => {
            if (!sysErr && address) {
                const arr = Array.isArray(address) ? address.map(x => x.address || x) : [address];
                dnsCache.set(hostname, {
                    addresses: arr,
                    expires: now + CACHE_TTL_MS
                });
            }
            cb(sysErr, address, family);
        });
    });
}

/**
 * Initializes the uplink DNS hook and data directory binding.
 */
function init(dataDir) {
    if (dataDir) {
        appDataDir = dataDir;
    }
    if (initialized) {
        return;
    }
    initialized = true;

    // Monkey-patch dns.lookup
    dns.lookup = patchedLookup;
}

/**
 * Direct IP probe to test active internet routing without depending on DNS.
 * Tests Cloudflare 1.1.1.1 and Google 8.8.8.8 directly over HTTPS (port 443).
 */
function probeDirectIp(ip, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const req = https.request({
            hostname: ip,
            port: 443,
            path: '/',
            method: 'HEAD',
            timeout: timeoutMs || 3000,
            rejectUnauthorized: false
        }, (res) => {
            if (!settled) {
                settled = true;
                res.resume();
                resolve(true);
            }
        });

        req.on('error', () => {
            if (!settled) {
                settled = true;
                resolve(false);
            }
        });

        req.on('timeout', () => {
            if (!settled) {
                settled = true;
                req.destroy();
                resolve(false);
            }
        });

        req.end();
    });
}

/**
 * Checks vehicle internet connectivity.
 * Returns Promise<boolean>.
 */
async function checkInternet(opts) {
    const timeout = (opts && opts.timeout) || 3500;

    // 1. Direct IP probe (fastest and 100% immune to DNS issues)
    const ipOk = await probeDirectIp('1.1.1.1', timeout);
    if (ipOk) return true;

    const ipFallbackOk = await probeDirectIp('8.8.8.8', Math.round(timeout * 0.8));
    if (ipFallbackOk) return true;

    // 2. Lease presence check: if mgu-uplink has an active lease
    const lease = getLease();
    if (lease && lease.ip && lease.router) {
        // We have an active uplink lease; try resolving a domain
        const resolver = getResolver();
        if (resolver) {
            const dnsResolved = await new Promise((resolve) => {
                resolver.resolve4('www.google.com', (err, addrs) => {
                    resolve(!err && Array.isArray(addrs) && addrs.length > 0);
                });
            });
            if (dnsResolved) return true;
        }
    }

    return false;
}

/**
 * Reads lease metadata from disk if present.
 */
function getLease() {
    const candidates = [
        appDataDir ? path.join(appDataDir, 'uplink.json') : null,
        '/run/mgu-uplink/lease.json'
    ].filter(Boolean);

    for (let i = 0; i < candidates.length; i++) {
        try {
            if (fs.existsSync(candidates[i])) {
                return JSON.parse(fs.readFileSync(candidates[i], 'utf8'));
            }
        } catch (e) {}
    }
    return null;
}

/**
 * Quick synchronous online check based on active lease existence.
 */
function isOnlineSync() {
    const lease = getLease();
    return !!(lease && lease.ip);
}

/**
 * One-line description of the uplink state for the app log.
 */
function describe() {
    const lease = getLease();
    if (!lease || !lease.ip) {
        return 'no lease (data dir ' + appDataDir + '): uplink offline or app not in apps.d; dns ' + getActiveDnsServers().join(',');
    }
    return 'lease ' + lease.ip + ' via ' + (lease.interface || '?') + ' router ' + lease.router + '; dns ' + getActiveDnsServers().join(',');
}

module.exports = {
    init,
    describe,
    checkInternet,
    isOnlineSync,
    getLease,
    getActiveDnsServers,
    dnsCache
};
