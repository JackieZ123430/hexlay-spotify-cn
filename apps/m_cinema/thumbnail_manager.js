'use strict';
/**
 * thumbnail_manager.js - Video Thumbnail Loader and Cache for M-Cinema (BMW iDrive 7).
 *
 * Downloads video thumbnail JPEGs, decodes them to RGBA byte arrays using pure JS,
 * applies rounded corners matching BMW Live Cockpit design, and registers them
 * via setImage() for GPU WebGL / canvas rendering.
 */
const https = require('https');
const http = require('http');
const url = require('url');
const decodeJpeg = require('./jpeg');

let setImage = null;
try {
    setImage = require('./kit/record').setImage;
} catch (e) {
    try {
        setImage = require('../../kit/runtime/record').setImage;
    } catch (e2) {
        try {
            setImage = require('../../kit/record').setImage;
        } catch (e3) {}
    }
}

const THUMB_BASE_ID = 300;

class ThumbnailManager {
    constructor(log, onLoaded) {
        this.log = log || console;
        this.onLoaded = onLoaded || null;
        this.cache = new Map(); // ytId -> { width, height, data }
        this.loading = new Set(); // ytIds currently in flight
        this.slotMapping = new Map(); // slotIndex -> ytId
    }

    has(ytId) {
        return !!(ytId && this.cache.has(ytId));
    }

    load(ytId, url, slotIndex) {
        if (!ytId) return false;
        const imgId = THUMB_BASE_ID + slotIndex;

        // If this slot already displays this video's thumbnail
        if (this.slotMapping.get(slotIndex) === ytId && this.cache.has(ytId)) {
            return true;
        }

        // Check if we have this thumbnail in memory
        if (this.cache.has(ytId)) {
            const cached = this.cache.get(ytId);
            if (setImage) {
                setImage(imgId, cached.width, cached.height, cached.data);
            }
            this.slotMapping.set(slotIndex, ytId);
            return true;
        }

        if (this.loading.has(ytId)) return false;
        this.loading.add(ytId);

        const thumbUrl = url || `https://img.youtube.com/vi/${ytId}/mqdefault.jpg`;
        this._fetchUrl(thumbUrl, (buf) => {
            if (!buf) {
                this.loading.delete(ytId);
                // Fallback to hqdefault if mqdefault fails
                if (thumbUrl.includes('mqdefault.jpg')) {
                    this._fetchFallback(ytId, imgId, slotIndex);
                }
                return;
            }

            try {
                const decoded = decodeJpeg(buf, { formatAsRGBA: true });
                if (decoded && decoded.width > 0 && decoded.height > 0) {
                    this._applyRoundedCorners(decoded, Math.round(decoded.width * 0.06), [11, 17, 26]);

                    // Limit memory cache to 30 items
                    if (this.cache.size >= 30) {
                        const oldestKey = this.cache.keys().next().value;
                        this.cache.delete(oldestKey);
                    }
                    this.cache.set(ytId, decoded);
                    this.slotMapping.set(slotIndex, ytId);
                    if (setImage) {
                        setImage(imgId, decoded.width, decoded.height, decoded.data);
                    }

                    this.loading.delete(ytId);
                    if (this.onLoaded) {
                        this.onLoaded();
                    }
                } else {
                    this.loading.delete(ytId);
                }
            } catch (e) {
                this.loading.delete(ytId);
                if (this.log && this.log.warn) {
                    this.log.warn('Decode thumbnail error: ' + e.message);
                }
            }
        });

        return false;
    }

    _fetchUrl(targetUrl, cb, redirectCount = 0) {
        if (redirectCount > 4) return cb(null);
        try {
            const isHttps = targetUrl.startsWith('https://');
            const client = isHttps ? https : http;
            const u = url.parse(targetUrl);
            const options = {
                hostname: u.hostname,
                port: u.port || (isHttps ? 443 : 80),
                path: u.path,
                headers: { 'User-Agent': 'Mozilla/5.0 (BMW iDrive 7)' },
                timeout: 5000
            };
            const req = client.get(options, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const nextUrl = res.headers.location.startsWith('http') ?
                        res.headers.location :
                        url.resolve(targetUrl, res.headers.location);
                    return this._fetchUrl(nextUrl, cb, redirectCount + 1);
                }

                if (res.statusCode !== 200) {
                    return cb(null);
                }

                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    cb(Buffer.concat(chunks));
                });
            });

            req.on('error', () => cb(null));
            req.on('timeout', () => {
                req.destroy();
                cb(null);
            });
        } catch (e) {
            cb(null);
        }
    }

    _fetchFallback(ytId, imgId, slotIndex) {
        const fallbackUrl = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
        this._fetchUrl(fallbackUrl, (buf) => {
            if (!buf) return;
            try {
                const decoded = decodeJpeg(buf, { formatAsRGBA: true });
                if (decoded && decoded.width > 0 && decoded.height > 0) {
                    this._applyRoundedCorners(decoded, Math.round(decoded.width * 0.06), [11, 17, 26]);
                    this.cache.set(ytId, decoded);
                    this.slotMapping.set(slotIndex, ytId);
                    if (setImage) {
                        setImage(imgId, decoded.width, decoded.height, decoded.data);
                    }
                    if (this.onLoaded) this.onLoaded();
                }
            } catch (e) {}
        });
    }

    _applyRoundedCorners(img, r, bg) {
        const w = img.width, h = img.height, d = img.data;
        const rSq = r * r;
        for (let y = 0; y < r; y++) {
            const dy = r - y;
            for (let x = 0; x < r; x++) {
                const dx = r - x;
                const distSq = dx * dx + dy * dy;
                if (distSq > rSq) {
                    // Top-Left
                    this._blendPixel(d, (y * w + x) * 4, bg);
                    // Top-Right
                    this._blendPixel(d, (y * w + (w - 1 - x)) * 4, bg);
                    // Bottom-Left
                    this._blendPixel(d, ((h - 1 - y) * w + x) * 4, bg);
                    // Bottom-Right
                    this._blendPixel(d, ((h - 1 - y) * w + (w - 1 - x)) * 4, bg);
                }
            }
        }
    }

    _blendPixel(d, i, bg) {
        d[i] = bg[0];
        d[i + 1] = bg[1];
        d[i + 2] = bg[2];
        d[i + 3] = 255;
    }
}

module.exports = { ThumbnailManager, THUMB_BASE_ID };
