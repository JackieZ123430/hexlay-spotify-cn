'use strict';
/**
 * art.js - Asynchronous album artwork loader and cache for Spotify iDrive 7.
 *
 * Downloads cover art JPEGs from Spotify CDN (i.scdn.co), decodes them into
 * RGBA byte arrays using pure JS, and registers them via setImage() for GPU
 * or software rendering. Rounded corners are applied analytically by the GPU
 * shader (OP_IMAGE radius), so decoded images stay full-bleed with crisp edges
 * and clean borders.
 *
 * Besides the cover itself (ART_IMG_ID) it makes, for Now Playing:
 *   ART_GROUND_ID      the cover shrunk to 32 px, blurred, calmed and darkened: drawn stretched over the
 *                      page it is a soft wash of the cover's colours
 *   ART_QUEUE_ID + k   the covers of the next songs (k = 0..3): the next one sharp, the later ones
 *                      small, blurred and darker, softer the further back they stand
 */
const http = require('http');
const tlsDates = require('./kit/tls_dates');
const urlMod = require('url');
const decodeJpeg = require('./jpeg');
const { setImage } = require('./kit/record');

const ART_IMG_ID = 101;
const ART_GROUND_ID = 110;
const ART_QUEUE_ID = 111;
const ART_THUMB_ID = 120;
const THUMB_SLOTS = 24;
const THUMB_SIZE = 64;
// the queue's covers, nearest first: side in px (0: the decoded cover as it is), blur radius in those px, brightness
const QUEUE_LOOK = [[0, 0, 1], [64, 1.5, 0.62], [48, 2.5, 0.44], [32, 2.5, 0.3]];
// load() runs every frame: a failed URL waits this long before it is asked for again
const FAIL_BACKOFF_MS = 60000;
// the whole download, however slowly the bytes trickle in
const TOTAL_TIMEOUT_MS = 15000;

/** Distinct offline procedural cover palettes for Demo Mode (no network needed). */
const DEMO_PALETTES = {
    t1: [[42, 28, 69], [162, 64, 90], [243, 228, 212], 0],     // Midnight City - violet to rose
    t2: [[20, 20, 22], [62, 16, 20], [227, 36, 43], 1],        // Turbo Killer - obsidian to crimson
    t3: [[21, 28, 63], [68, 42, 114], [240, 113, 143], 2],     // Nightcall - midnight blue to neon rose
    t4: [[32, 14, 18], [136, 36, 24], [255, 176, 0], 3],       // Blinding Lights - amber crimson
    t5: [[13, 47, 59], [29, 98, 108], [159, 227, 210], 0],     // Resonance - deep teal to mint
    t6: [[25, 24, 29], [74, 24, 38], [236, 60, 79], 1],        // Starboy - charcoal ruby
    t7: [[24, 22, 54], [116, 46, 86], [255, 166, 92], 2],      // Days of Thunder - twilight sunset
    t8: [[36, 20, 58], [148, 68, 82], [255, 198, 130], 3],     // Sunset
    t9: [[16, 24, 40], [34, 68, 118], [10, 156, 219], 0],      // Tech Noir
    t10: [[34, 18, 18], [110, 32, 26], [255, 206, 84], 1],     // Running in the 90s
    t11: [[14, 38, 56], [30, 92, 112], [116, 220, 244], 2],    // Crockett's Theme
    t12: [[20, 18, 36], [56, 36, 84], [168, 132, 240], 3],     // Far Away
    t13: [[14, 24, 34], [26, 72, 104], [124, 200, 240], 0],    // Strobe
    t14: [[22, 22, 26], [54, 58, 68], [220, 224, 232], 1],     // Teardrop
    t15: [[16, 32, 58], [43, 86, 148], [160, 212, 255], 2],    // Fast Car
    t16: [[38, 18, 14], [118, 44, 22], [255, 152, 64], 3],     // Speed King
};

/** Generate a crisp 128x128 procedural album cover (premultiplied RGBA) for demo tracks. */
function makeDemoCover(key) {
    const pal = DEMO_PALETTES[key] || DEMO_PALETTES.t1;
    const [c0, c1, ac, motif] = pal;
    const s = 128, out = new Uint8Array(s * s * 4);
    let seed = 17 + (key.charCodeAt(key.length - 1) || 0) * 131;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let y = 0; y < s; y++) {
        const ty = y / (s - 1);
        for (let x = 0; x < s; x++) {
            const tx = x / (s - 1);
            const g = Math.max(0, Math.min(1, tx * 0.55 + ty * 0.65 - 0.1));
            const grain = (rnd() - 0.5) * 12;
            let r = c0[0] + (c1[0] - c0[0]) * g + grain;
            let gr = c0[1] + (c1[1] - c0[1]) * g + grain;
            let b = c0[2] + (c1[2] - c0[2]) * g + grain;
            // subtle radial light spot in the lower right
            const dx = tx - 0.72, dy = ty - 0.68, d2 = dx * dx + dy * dy;
            if (d2 < 0.36) {
                const k = (1 - d2 / 0.36) * 0.24;
                r += (ac[0] - r) * k; gr += (ac[1] - gr) * k; b += (ac[2] - b) * k;
            }
            // minimal architectural motif per album (clean, graphic, zero clutter)
            let mark = 0;
            if (motif === 0) {
                // horizon disc + fine accent rule
                const cd = Math.hypot(tx - 0.5, ty - 0.54);
                if (cd < 0.24 && (ty < 0.58 || ((y >> 2) & 1) === 0)) mark = 0.72 * (1 - cd * 1.2);
                if (y >= 16 && y <= 18 && x >= 14 && x <= 44) mark = Math.max(mark, 0.9);
            } else if (motif === 1) {
                // slanted twin slashes
                const u = tx + ty * 0.35;
                if ((u > 0.52 && u < 0.61) || (u > 0.66 && u < 0.71)) mark = ty > 0.16 && ty < 0.84 ? 0.75 : 0;
                if (y >= 16 && y <= 18 && x >= 14 && x <= 38) mark = Math.max(mark, 0.85);
            } else if (motif === 2) {
                // concentric arcs
                const cd = Math.hypot(tx - 0.62, ty - 0.62);
                if (Math.abs(cd - 0.22) < 0.018 || Math.abs(cd - 0.34) < 0.012 || Math.abs(cd - 0.46) < 0.01) mark = 0.72;
                if (y >= 16 && y <= 18 && x >= 14 && x <= 42) mark = Math.max(mark, 0.85);
            } else {
                // stepped light bars
                if (x >= 16 && x <= 112 && ((y >= 88 && y <= 91) || (y >= 97 && y <= 99) || (y >= 104 && y <= 105))) mark = 0.78;
                if (y >= 16 && y <= 18 && x >= 16 && x <= 46) mark = Math.max(mark, 0.9);
            }
            if (mark > 0) {
                r += (ac[0] - r) * mark; gr += (ac[1] - gr) * mark; b += (ac[2] - b) * mark;
            }
            const o = (y * s + x) * 4;
            out[o] = Math.max(0, Math.min(255, Math.round(r)));
            out[o + 1] = Math.max(0, Math.min(255, Math.round(gr)));
            out[o + 2] = Math.max(0, Math.min(255, Math.round(b)));
            out[o + 3] = 255;
        }
    }
    return { width: s, height: s, data: out };
}

/**
 * A blur on s x s RGBA pixels, in place: three box passes of radius r each way (close to a Gaussian),
 * edges held. Small pictures blurred like this stay smooth when the GPU scales them up.
 */
function blur(px, s, r) {
    const n = Math.max(1, Math.round(r)), tmp = new Float32Array(s * 4);
    for (let pass = 0; pass < 3; pass++) {
        for (let dir = 0; dir < 2; dir++) {
            for (let line = 0; line < s; line++) {
                const at = (i) => (dir ? (i * s + line) : (line * s + i)) * 4;
                for (let i = 0; i < s; i++) {
                    let r0 = 0, g0 = 0, b0 = 0, a0 = 0;
                    for (let k = -n; k <= n; k++) {
                        const j = at(Math.max(0, Math.min(s - 1, i + k)));
                        r0 += px[j]; g0 += px[j + 1]; b0 += px[j + 2]; a0 += px[j + 3];
                    }
                    const m = 2 * n + 1;
                    tmp[i * 4] = r0 / m; tmp[i * 4 + 1] = g0 / m; tmp[i * 4 + 2] = b0 / m; tmp[i * 4 + 3] = a0 / m;
                }
                for (let i = 0; i < s; i++) { const j = at(i); px[j] = tmp[i * 4]; px[j + 1] = tmp[i * 4 + 1]; px[j + 2] = tmp[i * 4 + 2]; px[j + 3] = tmp[i * 4 + 3]; }
            }
        }
    }
    return px;
}
/** Colours moved part of the way (0..1) to their grey: a calmer copy. */
function desaturate(px, amount) {
    for (let i = 0; i < px.length; i += 4) {
        const y = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        px[i] += (y - px[i]) * amount; px[i + 1] += (y - px[i + 1]) * amount; px[i + 2] += (y - px[i + 2]) * amount;
    }
    return px;
}

/** img (premultiplied RGBA, w x h) shrunk to s x s (box average), its colour times k. */
function shrink(img, s, k) {
    const w = img.width, h = img.height, d = img.data, out = new Uint8Array(s * s * 4);
    for (let oy = 0; oy < s; oy++) {
        const y0 = Math.floor(oy * h / s), y1 = Math.max(y0 + 1, Math.floor((oy + 1) * h / s));
        for (let ox = 0; ox < s; ox++) {
            const x0 = Math.floor(ox * w / s), x1 = Math.max(x0 + 1, Math.floor((ox + 1) * w / s));
            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    const i = (y * w + x) * 4;
                    r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; n++;
                }
            }
            const o = (oy * s + ox) * 4;
            out[o] = Math.round(r / n * k); out[o + 1] = Math.round(g / n * k); out[o + 2] = Math.round(b / n * k); out[o + 3] = Math.round(a / n);
        }
    }
    return out;
}

class AlbumArtManager {
    constructor(log, onLoaded) {
        this.log = log || console;
        this.onLoaded = onLoaded || null;
        this.cache = new Map(); // url -> { width, height, data }
        this.currentUrl = null;
        this.loadingUrl = null;
        this.hasArt = false;
        this.failed = new Map(); // url -> time it may be tried again
        this.queueUrls = [];     // the next songs' covers, nearest first
        this.queueShown = [];    // url shown in each queue slot ('' none)
        this.queueLoading = null;
        this._lastQueueKey = '';
        this.thumbSlots = new Map();             // url -> slot (0..THUMB_SLOTS-1), LRU order
        this.thumbSlotUrl = new Array(THUMB_SLOTS).fill(null);
        this.thumbQueue = [];                    // pending remote thumbnail URLs
        this.thumbLoading = null;
        this._thumbRev = 0;
        this._lastThumbKey = '';
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

    static usable(url) {
        return !!url && typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://') || url.startsWith('demo:'));
    }

    _getOrMakeDemo(url) {
        if (!url.startsWith('demo:')) return null;
        if (this.cache.has(url)) return this.cache.get(url);
        const img = makeDemoCover(url.slice(5));
        if (this.cache.size >= 48) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(url, img);
        return img;
    }

    load(url) {
        if (!AlbumArtManager.usable(url)) {
            this.currentUrl = null;
            this.hasArt = false;
            return;
        }

        if (url === this.currentUrl && this.hasArt) {
            return;
        }

        this.currentUrl = url;

        if (url.startsWith('demo:')) {
            this._applyImage(this._getOrMakeDemo(url));
            return;
        }

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
        this._download(url, (decoded) => {
            if (this.loadingUrl === url) this.loadingUrl = null;
            if (decoded && this.currentUrl === url) this._applyImage(decoded);
            else this._queueStep();
        });
    }

    /**
     * The next songs' covers (urls, nearest first, up to 4). Loaded one at a time after the
     * current cover; each slot shows what it has until its new cover is in.
     */
    loadQueue(urls) {
        const list = (urls || []).slice(0, QUEUE_LOOK.length);
        const key = list.join('|');
        if (key === this._lastQueueKey && !this.queueLoading) {
            let ready = true;
            for (let k = 0; k < list.length; k++) {
                if (AlbumArtManager.usable(list[k]) && this.queueShown[k] !== list[k]) { ready = false; break; }
            }
            if (ready) return;
        }
        this._lastQueueKey = key;
        this.queueUrls = list;
        this._queueStep();
    }
    hasQueueArt(k) { return !!this.queueShown[k] && this.queueShown[k] === this.queueUrls[k]; }
    queueSig() { return this.queueShown.join(','); }

    _queueStep() {
        if (this.queueLoading || this.loadingUrl) return;
        for (let k = 0; k < this.queueUrls.length; k++) {
            const url = this.queueUrls[k];
            if (!AlbumArtManager.usable(url) || this.queueShown[k] === url) continue;
            if (url.startsWith('demo:')) { this._applyQueue(k, this._getOrMakeDemo(url)); continue; }
            if (this.cache.has(url)) { this._applyQueue(k, this.cache.get(url)); continue; }
            const retryAt = this.failed.get(url);
            if (retryAt && Date.now() < retryAt) continue;
            this.queueLoading = url;
            this._download(url, () => {
                this.queueLoading = null;
                this._queueStep();
            });
            return;
        }
        this._thumbStep();
    }

    /** Request 64x64 cover thumbnails for visible playlist/track rows (LRU pool, up to 24 slots). */
    loadThumbs(urls) {
        if (!Array.isArray(urls) || !urls.length) return;
        // O(1) fast-path at 30 fps when the same visible URLs are already registered
        let key = '';
        for (let i = 0; i < urls.length; i++) key += (i ? '|' : '') + (urls[i] || '');
        if (key === this._lastThumbKey && !this.thumbQueue.length && !this.thumbLoading) return;
        this._lastThumbKey = key;

        const pending = [];
        const seen = new Set();
        let addedSync = false;
        for (let i = 0; i < urls.length && seen.size < THUMB_SLOTS; i++) {
            const url = urls[i];
            if (!AlbumArtManager.usable(url) || seen.has(url)) continue;
            seen.add(url);
            if (this.thumbSlots.has(url)) {
                const slot = this.thumbSlots.get(url);
                this.thumbSlots.delete(url);
                this.thumbSlots.set(url, slot);
                continue;
            }
            if (url.startsWith('demo:')) {
                this._applyThumb(url, this._getOrMakeDemo(url), true);
                addedSync = true;
                continue;
            }
            if (this.cache.has(url)) {
                this._applyThumb(url, this.cache.get(url), true);
                addedSync = true;
                continue;
            }
            const retryAt = this.failed.get(url);
            if (retryAt && Date.now() < retryAt) continue;
            pending.push(url);
        }
        this.thumbQueue = pending;
        if (addedSync && this.onLoaded) this.onLoaded();
        if (pending.length) this._thumbStep();
    }

    thumbId(url) {
        if (!url || !this.thumbSlots.has(url)) return 0;
        return ART_THUMB_ID + this.thumbSlots.get(url);
    }

    thumbSig() { return this._thumbRev; }

    _allocThumbSlot(url) {
        if (this.thumbSlots.has(url)) return this.thumbSlots.get(url);
        let slot = -1;
        for (let i = 0; i < THUMB_SLOTS; i++) {
            if (!this.thumbSlotUrl[i]) { slot = i; break; }
        }
        if (slot < 0) {
            const oldest = this.thumbSlots.keys().next().value;
            slot = this.thumbSlots.get(oldest);
            this.thumbSlots.delete(oldest);
        }
        this.thumbSlots.set(url, slot);
        this.thumbSlotUrl[slot] = url;
        return slot;
    }

    _applyThumb(url, img, deferNotify) {
        const slot = this._allocThumbSlot(url);
        const px = shrink(img, THUMB_SIZE, 1);
        for (let i = 3; i < px.length; i += 4) px[i] = 255;
        setImage(ART_THUMB_ID + slot, THUMB_SIZE, THUMB_SIZE, px);
        this._thumbRev++;
        if (!deferNotify && this.onLoaded) this.onLoaded();
    }

    _thumbStep() {
        if (this.thumbLoading || this.queueLoading || this.loadingUrl) return;
        while (this.thumbQueue.length) {
            const url = this.thumbQueue.shift();
            if (!AlbumArtManager.usable(url) || this.thumbSlots.has(url)) continue;
            if (url.startsWith('demo:')) { this._applyThumb(url, this._getOrMakeDemo(url)); continue; }
            if (this.cache.has(url)) { this._applyThumb(url, this.cache.get(url)); continue; }
            const retryAt = this.failed.get(url);
            if (retryAt && Date.now() < retryAt) continue;
            this.thumbLoading = url;
            this._download(url, (decoded) => {
                this.thumbLoading = null;
                if (decoded) this._applyThumb(url, decoded);
                this._thumbStep();
            });
            return;
        }
    }

    _applyQueue(k, img) {
        const look = QUEUE_LOOK[k];
        if (!look[0]) setImage(ART_QUEUE_ID + k, img.width, img.height, img.data);
        else {
            const px = desaturate(blur(shrink(img, look[0], look[2]), look[0], look[1]), 0.25);
            for (let i = 3; i < px.length; i += 4) px[i] = 255;
            setImage(ART_QUEUE_ID + k, look[0], look[0], px);
        }
        this.queueShown[k] = this.queueUrls[k];
        if (this.onLoaded) this.onLoaded();
    }

    /** Fetch and decode url into the cache; done(decoded or null). */
    _download(url, done) {
        let parsed;
        try {
            parsed = urlMod.parse(url);
        } catch (e) {
            this._fail(url, 'bad url');
            done(null);
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
            done(null);
        }, TOTAL_TIMEOUT_MS);
        const fail = (why) => {
            if (finished) return;
            finished = true;
            clearTimeout(deadline);
            this._fail(url, why);
            done(null);
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
            // Node 8.9.4 (2019 head units) also says 'aborted' for a whole response that is still being read when
            // the server closes the connection, as it does here (no keep-alive): only a cut one fails
            res.on('aborted', () => { if (!res.complete) fail('connection closed mid-download'); });
            res.on('end', () => {
                if (finished) return;
                if (!res.complete) { fail('connection closed mid-download'); return; }
                finished = true;
                clearTimeout(deadline);
                let decoded = null;
                try {
                    const buf = Buffer.concat(chunks);
                    decoded = decodeJpeg(buf, { formatAsRGBA: true });
                } catch (e) {
                    this._fail(url, 'decode: ' + e.message);
                    done(null);
                    return;
                }
                if (!(decoded && decoded.width > 0 && decoded.height > 0)) {
                    this._fail(url, 'empty image');
                    done(null);
                    return;
                }

                // Keep up to 48 recent album covers in cache (full-bleed RGBA; GPU SDF rounds corners cleanly)
                if (this.cache.size >= 48) {
                    const oldestKey = this.cache.keys().next().value;
                    this.cache.delete(oldestKey);
                }
                this.cache.set(url, decoded);
                this.failed.delete(url);
                done(decoded);
            });
        });

        req.on('error', (err) => fail(err.message));

        req.on('timeout', () => {
            try { req.destroy(); } catch (e) {}
            fail('timed out');
        });
    }

    _applyImage(img) {
        setImage(ART_IMG_ID, img.width, img.height, img.data);
        // the ground: 32 px, blurred, calmer and dark, fully opaque
        const g = desaturate(blur(shrink(img, 32, 0.36), 32, 4), 0.35);
        for (let i = 3; i < g.length; i += 4) g[i] = 255;
        setImage(ART_GROUND_ID, 32, 32, g);
        this.hasArt = true;
        // the queue's covers wait while the current one loads: on now
        this._queueStep();
        if (this.onLoaded) {
            this.onLoaded();
        }
    }
}

module.exports = {
    AlbumArtManager,
    ART_IMG_ID,
    ART_GROUND_ID,
    ART_QUEUE_ID,
    ART_THUMB_ID,
    THUMB_SLOTS,
    QUEUE_LOOK,
    makeDemoCover,
    shrink,
    blur
};
