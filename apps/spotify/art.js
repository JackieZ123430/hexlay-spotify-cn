'use strict';
/**
 * art.js - Asynchronous album artwork loader and cache for Spotify iDrive 7.
 *
 * Downloads cover art JPEGs from Spotify CDN (i.scdn.co), decodes them into
 * RGBA byte arrays using pure JS, applies rounded corners, and registers them
 * via setImage() for GPU or software rendering.
 */
const https = require('https');
const http = require('http');
const urlMod = require('url');
const decodeJpeg = require('./jpeg');
const { setImage } = require('./kit/record');

const ART_IMG_ID = 101;

class AlbumArtManager {
    constructor(log, onLoaded) {
        this.log = log || console;
        this.onLoaded = onLoaded || null;
        this.cache = new Map(); // url -> { width, height, data }
        this.currentUrl = null;
        this.loadingUrl = null;
        this.hasArt = false;
    }

    load(url) {
        if (!url || typeof url !== 'string' || (!url.startsWith('https://') && !url.startsWith('http://'))) {
            this.currentUrl = null;
            this.hasArt = false;
            return;
        }

        if (url === this.currentUrl && this.hasArt) {
            return;
        }

        this.currentUrl = url;

        // Check memory cache
        if (this.cache.has(url)) {
            const cached = this.cache.get(url);
            this._applyImage(cached);
            return;
        }

        if (this.loadingUrl === url) return;
        this.loadingUrl = url;

        let parsed;
        try {
            parsed = urlMod.parse(url);
        } catch (e) {
            this.loadingUrl = null;
            return;
        }

        const opt = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
            path: parsed.path,
            headers: { 'User-Agent': 'BMW-iDrive7' },
            timeout: 6000
        };

        const client = parsed.protocol === 'http:' ? http : https;
        const req = client.get(opt, (res) => {
            if (res.statusCode !== 200) {
                this.loadingUrl = null;
                return;
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                this.loadingUrl = null;
                try {
                    const buf = Buffer.concat(chunks);
                    const decoded = decodeJpeg(buf, { formatAsRGBA: true });
                    if (decoded && decoded.width > 0 && decoded.height > 0) {
                        // Apply rounded corner mask to blend into #0c1015
                        this._applyRoundedCorners(decoded, Math.round(decoded.width * 0.07), [12, 16, 21]);

                        // Keep up to 25 recent album covers in cache
                        if (this.cache.size >= 25) {
                            const oldestKey = this.cache.keys().next().value;
                            this.cache.delete(oldestKey);
                        }
                        this.cache.set(url, decoded);

                        if (this.currentUrl === url) {
                            this._applyImage(decoded);
                        }
                    }
                } catch (e) {
                    if (this.log && this.log.warn) {
                        this.log.warn('Decode album art error: ' + e.message);
                    }
                }
            });
        });

        req.on('error', (err) => {
            this.loadingUrl = null;
            if (this.log && this.log.warn) {
                this.log.warn('Fetch album art error: ' + err.message);
            }
        });

        req.on('timeout', () => {
            req.destroy();
            this.loadingUrl = null;
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

    _applyImage(img) {
        setImage(ART_IMG_ID, img.width, img.height, img.data);
        this.hasArt = true;
        if (this.onLoaded) {
            this.onLoaded();
        }
    }
}

module.exports = {
    AlbumArtManager,
    ART_IMG_ID
};
