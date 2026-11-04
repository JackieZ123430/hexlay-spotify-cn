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

function fetchVisitorData() {
    return new Promise((resolve) => {
        // Strategy 1: YouTube ServiceWorker data endpoint
        const req = https.get('https://www.youtube.com/sw.js_data', { timeout: 4000 }, (res) => {
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
        const req = https.get('https://www.youtube.com', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
            timeout: 4000
        }, (res) => {
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

async function resolveYouTubeStream(videoId, log, retryCount = 0) {
    if (!videoId) return null;
    const logger = log || console;

    // Refresh visitor data every 2 hours if missing or stale
    if (!cachedVisitorData || (Date.now() - visitorDataTime > 7200000)) {
        await fetchVisitorData();
    }

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
        const req = https.request('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 6000
        }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', async () => {
                try {
                    const json = JSON.parse(data);
                    const status = json.playabilityStatus ? json.playabilityStatus.status : 'UNKNOWN';

                    if ((status === 'LOGIN_REQUIRED' || !json.streamingData) && retryCount < 1) {
                        logger.info(`[stream_resolver] Status ${status}, refreshing visitorData and retrying...`);
                        await fetchVisitorData();
                        try {
                            const retried = await resolveYouTubeStream(videoId, log, retryCount + 1);
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
                        reject(new Error('No stream URL in YouTube response: ' + status));
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

module.exports = {
    resolveYouTubeStream
};
