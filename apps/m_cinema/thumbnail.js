'use strict';
/**
 * thumbnail.js - Asynchronous YouTube Thumbnail loader and cache for M-Cinema.
 *
 * Fetches video thumbnail JPEGs directly from YouTube CDN (img.youtube.com),
 * decodes them into RGBA byte arrays using pure JS, and registers them
 * via setImage() for 60 fps GPU / software rendering on the iDrive 7 ultrawide display.
 */
const https = require('https');
const decodeJpeg = require('./jpeg');
const { setImage } = require('./kit/record');

const THUMB_IMG_ID = 102;

class YouTubeThumbnailManager {
    constructor(log, onLoaded) {
        this.log = log || console;
        this.onLoaded = onLoaded || null;
        this.cache = new Map(); // ytId -> { width, height, data }
        this.currentId = null;
        this.loadingId = null;
        this.hasThumbnail = false;
    }

    load(ytId, customUrl) {
        if (!ytId && !customUrl) {
            this.currentId = null;
            this.hasThumbnail = false;
            return;
        }

        const id = ytId || customUrl;
        if (id === this.currentId && this.hasThumbnail) {
            return;
        }

        this.currentId = id;

        // Check memory cache
        if (this.cache.has(id)) {
            const cached = this.cache.get(id);
            this._applyImage(cached);
            return;
        }

        if (this.loadingId === id) return;
        this.loadingId = id;

        const thumbUrl = customUrl || `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;

        const fetchUrl = (targetUrl, hops = 0) => {
            if (hops > 3) {
                this.loadingId = null;
                return;
            }

            const req = https.get(targetUrl, { timeout: 6000 }, (res) => {
                // Follow 301/302 redirects if needed
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    fetchUrl(res.headers.location, hops + 1);
                    return;
                }

                if (res.statusCode !== 200) {
                    this.loadingId = null;
                    return;
                }

                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    this.loadingId = null;
                    try {
                        const buf = Buffer.concat(chunks);
                        const decoded = decodeJpeg(buf, { formatAsRGBA: true });
                        if (decoded && decoded.width > 0 && decoded.height > 0) {
                            // Apply subtle rounded corner mask
                            this._applyRoundedCorners(decoded, Math.round(decoded.width * 0.04), [6, 9, 14]);

                            if (this.cache.size >= 20) {
                                const oldest = this.cache.keys().next().value;
                                this.cache.delete(oldest);
                            }
                            this.cache.set(id, decoded);

                            if (this.currentId === id) {
                                this._applyImage(decoded);
                            }
                        }
                    } catch (e) {
                        if (this.log && this.log.warn) {
                            this.log.warn('YouTube thumbnail decode error: ' + e.message);
                        }
                    }
                });
            });

            req.on('error', (err) => {
                this.loadingId = null;
                if (this.log && this.log.warn) {
                    this.log.warn('YouTube thumbnail fetch error: ' + err.message);
                }
            });

            req.on('timeout', () => {
                req.destroy();
                this.loadingId = null;
            });
        };

        fetchUrl(thumbUrl);
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
                    this._blendPixel(d, (y * w + x) * 4, bg);
                    this._blendPixel(d, (y * w + (w - 1 - x)) * 4, bg);
                    this._blendPixel(d, ((h - 1 - y) * w + x) * 4, bg);
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
        setImage(THUMB_IMG_ID, img.width, img.height, img.data);
        this.hasThumbnail = true;
        if (this.onLoaded) {
            this.onLoaded();
        }
    }
}

module.exports = {
    YouTubeThumbnailManager,
    THUMB_IMG_ID
};
