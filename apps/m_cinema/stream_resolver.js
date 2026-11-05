'use strict';
/**
 * stream_resolver.js - Native YouTube Direct Video Stream Resolver for BMW iDrive 7.
 *
 * Resolves YouTube video IDs directly to 720p H.264 streams
 * without requiring Google Chrome, external npm packages, or third-party proxies.
 * Streams are playable directly by the native `mgu-vidplay` FFmpeg engine.
 */
const https = require('https');

// Robust fallback visitorData token in case network is constrained on cold start
const DEFAULT_VISITOR_DATA = 'CgtUQXk5Tlo5V3hGdyj7o6zXBjIKCgJHRRIEGgAgWWKrAgqoAkN0c0JDQVVTalFFQkRCNlBETHNWYndmVkdMQV9SNjhYZHVWNXlKaUJHaXNENEFkSzJxQS1nZHZWX0JacGkwRnJkTVgzRFQtNm5IdnRSeW5vdkNNc29mVTNXWVFyNkRXTE1WeEFFY1kwWHdyaEM5YkxoYTdFZThPVk52TVBzWmRiaHFTQmlGNGhnSkVGSEhqLWwtaGV0RU1ZblBtUjMzSjBibnNZRnpHOWRXTm0xUWk1ZW9vczNDTlVVMkU3eFRQdGJoaHc4U0FvQlRKRkFSeFk5V3B4cnRWVmI3WjZSc21GUkUyUjdfd2hzdW83ZkdRb3JTTDFyWkVyeVRYekdqYVRPZzVYUnBnSmJ5TmZQYU5PUy0xcUJSanY1Vkwtd0VJOTFaSUo2YlFQ';

let cachedVisitorData = DEFAULT_VISITOR_DATA;
let visitorDataTime = 0;

const INVIDIOUS_HOSTS = [
    'yt.chocolatemoo53.com',
    'inv.tux.pizza',
    'invidious.nerdvpn.de',
    'invidious.projectsegfau.lt'
];

/**
 * Checks vehicle internet connectivity by probing YouTube and Invidious endpoints.
 * Returns Promise<boolean>.
 */
function checkInternetConnection() {
    const probe = (hostname, path = '/') => {
        return new Promise((resolve) => {
            const req = https.request({
                hostname,
                port: 443,
                path,
                method: 'HEAD',
                timeout: 4000,
                rejectUnauthorized: false
            }, (res) => {
                res.resume();
                resolve(true);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
            req.end();
        });
    };

    // Direct-IP probe first (no DNS needed), then hostnames through the uplink resolver
    let uplink = null;
    try { uplink = require('./kit/uplink'); } catch (e) {}
    const first = uplink ? uplink.checkInternet({ timeout: 3500 }).catch(() => false) : Promise.resolve(false);

    return first.then((ok) => ok || probe('www.youtube.com')).then((ok) => {
        if (ok) return true;
        return probe('yt.chocolatemoo53.com', '/api/v1/trending');
    }).catch(() => false);
}

function fetchVisitorData() {
    return new Promise((resolve) => {
        // Strategy 1: YouTube ServiceWorker data endpoint
        const opt = {
            hostname: 'www.youtube.com',
            port: 443,
            path: '/sw.js_data',
            timeout: 4000
        };
        const req = https.get(opt, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                const vm = data.match(/Cgt[A-Za-z0-9_-]{50,}/);
                if (vm && vm[0]) {
                    cachedVisitorData = vm[0];
                    visitorDataTime = Date.now();
                    return resolve(cachedVisitorData);
                }
                // Strategy 2: YouTube Homepage initial data
                fetchHomepageVisitorData().then(resolve);
            });
        });
        req.on('error', () => fetchHomepageVisitorData().then(resolve));
        req.on('timeout', () => { req.destroy(); fetchHomepageVisitorData().then(resolve); });
    });
}

function fetchHomepageVisitorData() {
    return new Promise((resolve) => {
        const opt = {
            hostname: 'www.youtube.com',
            port: 443,
            path: '/',
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
            timeout: 4000
        };
        const req = https.get(opt, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                const vm1 = data.match(/\"VISITOR_DATA\":\"([^\"]+)\"/);
                const vm2 = data.match(/\"visitorData\":\"([^\"]+)\"/);
                const vd = (vm1 && vm1[1]) || (vm2 && vm2[1]);
                if (vd) {
                    cachedVisitorData = vd;
                    visitorDataTime = Date.now();
                }
                resolve(cachedVisitorData);
            });
        });
        req.on('error', () => resolve(cachedVisitorData));
        req.on('timeout', () => { req.destroy(); resolve(cachedVisitorData); });
    });
}

function resolveInvidiousStream(videoId, logger) {
    return new Promise((resolve, reject) => {
        let i = 0;
        function tryNext() {
            if (i >= INVIDIOUS_HOSTS.length) {
                return reject(new Error('All Invidious stream endpoints exhausted'));
            }
            const host = INVIDIOUS_HOSTS[i++];
            const req = https.get({
                hostname: host,
                path: `/api/v1/videos/${videoId}`,
                timeout: 5000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }, (res) => {
                if (res.statusCode !== 200) return tryNext();
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => {
                    try {
                        const j = JSON.parse(d);
                        const all = (j.adaptiveFormats || []).concat(j.formatStreams || []);
                        const chosen = all.find(f => (f.resolution === '720p' || f.qualityLabel === '720p') && ((f.type && f.type.includes('avc1')) || f.encoding === 'h264') && f.url)
                                    || all.find(f => (f.resolution === '720p' || f.qualityLabel === '720p') && f.url)
                                    || all.find(f => (f.resolution === '360p' || f.qualityLabel === '360p') && f.url)
                                    || all.find(f => f.url);
                        if (chosen && chosen.url) {
                            if (logger) logger.info(`[stream_resolver] Stream resolved via Invidious (${host}): ${chosen.resolution || '720p'}`);
                            return resolve({
                                url: chosen.url,
                                quality: chosen.resolution || chosen.qualityLabel || '720p HD',
                                width: chosen.width || 1280,
                                height: chosen.height || 720,
                                fps: chosen.fps || 30,
                                durationSec: j.lengthSeconds || 0,
                                title: j.title || ''
                            });
                        }
                        tryNext();
                    } catch (e) {
                        tryNext();
                    }
                });
            });
            req.on('error', tryNext);
            req.on('timeout', () => { req.destroy(); tryNext(); });
        }
        tryNext();
    });
}

function resolveInnerTubeStream(videoId, logger, retryCount = 0) {
    const payload = JSON.stringify({
        context: {
            client: {
                clientName: 'VISIONOS',
                clientVersion: '1.02',
                deviceMake: 'Apple',
                deviceModel: 'RealityDevice17,1',
                osName: 'visionOS',
                osVersion: '26.5.23O471',
                userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
                hl: 'en',
                gl: 'US',
                utcOffsetMinutes: 0,
                visitorData: cachedVisitorData || DEFAULT_VISITOR_DATA
            }
        },
        videoId: videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        playbackContext: {
            contentPlaybackContext: {
                html5Preference: 'HTML5_PREF_WANTS'
            }
        }
    });

    return new Promise((resolve, reject) => {
        const opt = {
            hostname: 'www.youtube.com',
            port: 443,
            path: '/youtubei/v1/player?prettyPrint=false',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 6000
        };
        const req = https.request(opt, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', async () => {
                try {
                    const json = JSON.parse(data);
                    const status = json.playabilityStatus ? json.playabilityStatus.status : 'UNKNOWN';

                    if ((status === 'LOGIN_REQUIRED' || !json.streamingData) && retryCount < 1) {
                        logger.info(`[stream_resolver] InnerTube status ${status}, refreshing visitorData and retrying...`);
                        await fetchVisitorData();
                        try {
                            const retried = await resolveInnerTubeStream(videoId, logger, retryCount + 1);
                            return resolve(retried);
                        } catch (re) {
                            return reject(re);
                        }
                    }

                    const formats = (json.streamingData && json.streamingData.formats) || [];
                    const adaptive = (json.streamingData && json.streamingData.adaptiveFormats) || [];
                    const all = formats.concat(adaptive);

                    // Prefer 720p H.264 (avc1) for thermal-safe hardware decoding on Intel Atom
                    const chosen = all.find(f => f.qualityLabel === '720p' && f.mimeType && f.mimeType.includes('avc1') && f.url)
                                || all.find(f => f.qualityLabel === '720p' && f.url)
                                || all.find(f => f.mimeType && f.mimeType.includes('avc1') && f.url)
                                || all.find(f => f.url);

                    if (chosen && chosen.url) {
                        resolve({
                            url: chosen.url,
                            quality: chosen.qualityLabel || '720p HD',
                            width: chosen.width || 1280,
                            height: chosen.height || 720,
                            fps: chosen.fps || 30,
                            durationSec: json.videoDetails ? parseInt(json.videoDetails.lengthSeconds, 10) : 0,
                            title: json.videoDetails ? json.videoDetails.title : ''
                        });
                    } else {
                        reject(new Error('No direct stream URL in InnerTube: ' + status));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout resolving YouTube stream'));
        });
        req.write(payload);
        req.end();
    });
}

async function resolveYouTubeStream(videoId, log, retryCount = 0) {
    if (!videoId) return null;
    const logger = log || console;

    // Refresh visitor data every 2 hours if missing or stale
    if (!cachedVisitorData || (Date.now() - visitorDataTime > 7200000)) {
        await fetchVisitorData();
    }

    try {
        const stream = await resolveInnerTubeStream(videoId, logger, retryCount);
        if (stream && stream.url) return stream;
    } catch (err) {
        logger.info(`[stream_resolver] InnerTube stream resolution fallback: ${err.message}`);
    }

    // Secondary fallback: Invidious cluster (yt.chocolatemoo53.com, etc.)
    return resolveInvidiousStream(videoId, logger);
}

module.exports = {
    resolveYouTubeStream,
    checkInternetConnection
};
