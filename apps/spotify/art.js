'use strict';
/**
 * art.js - Asynchronous album artwork loader and cache for Spotify iDrive 7.
 *
 * Downloads cover art JPEGs from Spotify CDN (i.scdn.co), decodes them into
 * RGBA byte arrays using pure JS, applies rounded corners, and registers them
 * via setImage() for GPU or software rendering.
 */
const http = require('http');
const tlsDates = require('./kit/tls_dates');
const urlMod = require('url');
const decodeJpeg = require('./jpeg');
const { setImage } = require('./kit/record');

const ART_IMG_ID = 101;
// load() runs every frame: a failed URL waits this long before it is asked for again
const FAIL_BACKOFF_MS = 60000;
// the whole download, however slowly the bytes trickle in
const TOTAL_TIMEOUT_MS = 15000;

class AlbumArtManager {
    constructor(log, onLoaded) {
        this.log = log || console;
        this.onLoaded = onLoaded || null;
        this.cache = new Map(); // url -> { width, height, data }
        this.currentUrl = null;
        this.loadingUrl = null;
        this.hasArt = false;
        this.failed = new Map(); // url -> time it may be tried again
    }

    _fail(url, why) {
        if (this.loadingUrl === url) this.loadingUrl = null;
        if (this.failed.has(url)) this.failed.delete(url);
        if (this.failed.size >= 50) this.failed.delete(this.failed.keys().next().value);
        this.failed.set(url, Date.now() + FAIL_BACKOFF_MS);
        if (why && this.log && this.log.warn) {
            this.log.warn('Fetch album art error: ' + why);
        }
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
        const retryAt = this.failed.get(url);
        if (retryAt && Date.now() < retryAt) return;
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

        let finished = false;
        const deadline = setTimeout(() => {
            if (finished) return;
            finished = true;
            try { req.destroy(); } catch (e) {}
            this._fail(url, 'timed out');
        }, TOTAL_TIMEOUT_MS);
        const fail = (why) => {
            if (finished) return;
            finished = true;
            clearTimeout(deadline);
            this._fail(url, why);
        };

        const get = parsed.protocol === 'http:' ? http.get : tlsDates.get;
        const req = get(opt, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                fail('HTTP ' + res.statusCode);
                return;
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('aborted', () => fail('connection closed mid-download'));
            res.on('end', () => {
                if (finished) return;
                finished = true;
                clearTimeout(deadline);
                this.loadingUrl = null;
                try {
                    const buf = Buffer.concat(chunks);
                    const decoded = decodeJpeg(buf, { formatAsRGBA: true });
                    if (decoded && decoded.width > 0 && decoded.height > 0) {
                        // Apply rounded corner mask to blend into #0c1015
                        this._applyRoundedCorners(decoded, Math.round(decoded.width * 0.07));

                        // Keep up to 25 recent album covers in cache
                        if (this.cache.size >= 25) {
                            const oldestKey = this.cache.keys().next().value;
                            this.cache.delete(oldestKey);
                        }
                        this.cache.set(url, decoded);

                        this.failed.delete(url);
                        if (this.currentUrl === url) {
                            this._applyImage(decoded);
                        }
                    } else {
                        this._fail(url, 'empty image');
                    }
                } catch (e) {
                    this._fail(url, 'decode: ' + e.message);
                }
            });
        });

        req.on('error', (err) => fail(err.message));

        req.on('timeout', () => {
            try { req.destroy(); } catch (e) {}
            fail('timed out');
        });
    }

    /** Corners outside radius r made see-through (premultiplied 0, 0, 0, 0): whatever the theme draws under them shows. */
    _applyRoundedCorners(img, r) {
        const w = img.width, h = img.height, d = img.data;
        const rSq = r * r;
        for (let y = 0; y < r; y++) {
            const dy = r - y;
            for (let x = 0; x < r; x++) {
                const dx = r - x;
                const distSq = dx * dx + dy * dy;
                if (distSq > rSq) {
                    // Top-Left
                    this._blendPixel(d, (y * w + x) * 4);
                    // Top-Right
                    this._blendPixel(d, (y * w + (w - 1 - x)) * 4);
                    // Bottom-Left
                    this._blendPixel(d, ((h - 1 - y) * w + x) * 4);
                    // Bottom-Right
                    this._blendPixel(d, ((h - 1 - y) * w + (w - 1 - x)) * 4);
                }
            }
        }
    }

    _blendPixel(d, i) {
        d[i] = 0;
        d[i + 1] = 0;
        d[i + 2] = 0;
        d[i + 3] = 0;
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
