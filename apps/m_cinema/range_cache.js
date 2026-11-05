'use strict';
/**
 * range_cache.js - browser-style video buffering for M-Cinema.
 *
 * The stream is fetched in CHUNK-sized HTTP Range requests (the way a browser's player does) and
 * kept in a small RAM window around the playback position:
 *   - ahead:  up to `aheadBytes` past the position the engine reads (prefetch, at most 2 at a time)
 *   - behind: `behindBytes` before it (small backward seeks need no refetch)
 *   - never more than `maxBytes` in total; chunks outside the window are dropped
 * A seek simply reads somewhere else: that chunk is fetched first and prefetches that are no
 * longer needed are cancelled. Short range requests also avoid the slowdown YouTube applies to
 * one long download. An expired stream URL (HTTP 403 / 410) is replaced through `refreshUrl()`.
 *
 * serve(sockPath) answers the native engine (mgu-vidplay --sock): "R <offset> <len>\n" ->
 * 4-byte little-endian length + bytes (0 = end of file, 0xFFFFFFFF = error).
 */
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const urlMod = require('url');

const CHUNK = 1024 * 1024;
const MAX_FETCHES = 2;
const IDLE_TIMEOUT_MS = 15000;
const MAX_RETRIES = 5;
const ERR_LEN = 0xFFFFFFFF;

class RangeCache {
    /**
     * opts: { url, size, log, chunkSize, aheadBytes, behindBytes, maxBytes,
     *         refreshUrl: () => Promise<string|null>, headers }
     * Use RangeCache.open(url, opts) to learn the size from the first range.
     */
    constructor(opts) {
        this.url = opts.url;
        this.size = opts.size;
        this.log = opts.log || console;
        this.chunk = opts.chunkSize || CHUNK;
        this.ahead = Math.max(this.chunk * 2, opts.aheadBytes || 16 * this.chunk);
        this.behind = opts.behindBytes !== undefined ? opts.behindBytes : 2 * this.chunk;
        this.maxBytes = Math.max(this.ahead + this.behind + this.chunk, opts.maxBytes || 24 * this.chunk);
        this.refreshUrl = opts.refreshUrl || null;
        this.headers = opts.headers || {};
        this.ready = new Map();      // chunk index -> Buffer
        this.pending = new Map();    // chunk index -> { promise, abort, wanted }
        this.readPos = 0;
        this.destroyed = false;
        this.fetchedBytes = 0;
        this.refreshing = null;
        this.server = null;
        this.conn = null;
        this.onError = null;         // (err) when a range can't be fetched any more
    }

    /** Fetch the first chunk, learn the total size; resolves with a ready RangeCache. */
    static open(url, opts) {
        const o = Object.assign({}, opts, { url: url, size: 0 });
        const cache = new RangeCache(o);
        return cache._fetchRange(0, cache.chunk - 1, true).then((r) => {
            if (!r.total) throw Object.assign(new Error('Stream size unknown (no Content-Range)'), { code: 'NORANGE' });
            cache.size = r.total;
            cache.ready.set(0, r.buf);
            cache.fetchedBytes += r.buf.length;
            return cache;
        });
    }

    get chunkCount() { return Math.ceil(this.size / this.chunk); }

    /** RAM held by the cache (ready chunks). */
    heldBytes() {
        let n = 0;
        this.ready.forEach((b) => { n += b.length; });
        return n;
    }

    /** Contiguous bytes ready from the read position on (the "buffered ahead" of a browser). */
    bufferedAhead() {
        let idx = Math.floor(this.readPos / this.chunk);
        let n = 0;
        while (idx < this.chunkCount && this.ready.has(idx)) {
            const start = idx * this.chunk;
            n += Math.min(this.size, start + this.chunk) - Math.max(start, this.readPos);
            idx++;
        }
        return Math.max(0, n);
    }

    /** Bytes [off, off+len) - at most to the end of that chunk; empty Buffer at the end of file. */
    read(off, len) {
        if (this.destroyed) return Promise.reject(new Error('closed'));
        if (off >= this.size) return Promise.resolve(Buffer.alloc(0));
        const idx = Math.floor(off / this.chunk);
        this.readPos = off;
        const p = this._get(idx, true);
        this._schedule();
        return p.then((buf) => {
            const start = off - idx * this.chunk;
            return buf.slice(start, Math.min(buf.length, start + len));
        });
    }

    _get(idx, wanted) {
        const have = this.ready.get(idx);
        if (have) return Promise.resolve(have);
        let pend = this.pending.get(idx);
        if (!pend) pend = this._startFetch(idx);
        if (wanted) pend.wanted = true;
        return pend.promise;
    }

    _startFetch(idx) {
        const start = idx * this.chunk;
        const end = Math.min(this.size, start + this.chunk) - 1;
        let abortFn = () => {};
        const pend = { wanted: false, abort: () => abortFn() };
        pend.promise = this._fetchWithRetry(start, end, (a) => { abortFn = a; }).then((buf) => {
            if (this.pending.get(idx) === pend) this.pending.delete(idx);
            if (this.destroyed) return buf;
            this.ready.set(idx, buf);
            this.fetchedBytes += buf.length;
            this._evict();
            this._schedule();
            return buf;
        }, (err) => {
            if (this.pending.get(idx) === pend) this.pending.delete(idx);
            if (!this.destroyed && err.code !== 'ABORTED') this._schedule();
            throw err;
        });
        this.pending.set(idx, pend);
        return pend;
    }

    /** Window of chunk indexes to keep: [first, last]. */
    _window() {
        const cur = Math.floor(this.readPos / this.chunk);
        const first = Math.max(0, cur - Math.ceil(this.behind / this.chunk));
        const last = Math.min(this.chunkCount - 1, cur + Math.ceil(this.ahead / this.chunk));
        return { cur: cur, first: first, last: last };
    }

    _evict() {
        const w = this._window();
        this.ready.forEach((b, idx) => {
            if (idx < w.first || idx > w.last) this.ready.delete(idx);
        });
        // hard cap: drop the chunks farthest from the read position
        if (this.heldBytes() > this.maxBytes) {
            const order = Array.from(this.ready.keys()).sort((a, b) => Math.abs(b - w.cur) - Math.abs(a - w.cur));
            for (const idx of order) {
                if (this.heldBytes() <= this.maxBytes) break;
                if (idx !== w.cur) this.ready.delete(idx);
            }
        }
    }

    _schedule() {
        if (this.destroyed) return;
        const w = this._window();
        // cancel prefetches outside the window that nobody waits for (after a seek)
        this.pending.forEach((p, idx) => {
            if (!p.wanted && (idx < w.cur || idx > w.last)) {
                this.pending.delete(idx);
                p.abort();
            }
        });
        for (let idx = w.cur; idx <= w.last && this.pending.size < MAX_FETCHES; idx++) {
            if (this.ready.has(idx) || this.pending.has(idx)) continue;
            if (this.heldBytes() + this.chunk * (this.pending.size + 1) > this.maxBytes) break;
            this._startFetch(idx).promise.catch(() => {});
        }
    }

    _refresh() {
        if (!this.refreshUrl) return Promise.resolve(false);
        if (!this.refreshing) {
            this.log.info('[M-Cinema:Cache] Stream URL expired, resolving a fresh one');
            this.refreshing = Promise.resolve(this.refreshUrl()).then((u) => {
                if (u) this.url = u;
                return !!u;
            }, () => false);
            const done = () => { setTimeout(() => { this.refreshing = null; }, 10000); };
            this.refreshing.then(done, done);
        }
        return this.refreshing;
    }

    _fetchWithRetry(start, end, setAbort) {
        let attempt = 0;
        let refreshed = false;
        const run = () => {
            if (this.destroyed) return Promise.reject(Object.assign(new Error('closed'), { code: 'ABORTED' }));
            return this._fetchRange(start, end, false, setAbort).then((r) => r.buf, (err) => {
                if (err.code === 'ABORTED' || this.destroyed) throw err;
                if ((err.status === 403 || err.status === 410) && !refreshed) {
                    refreshed = true;
                    return this._refresh().then((ok) => {
                        if (!ok) throw err;
                        return run();
                    });
                }
                if (++attempt > MAX_RETRIES || (err.status >= 400 && err.status < 500 && err.status !== 429)) throw err;
                const delay = Math.min(8000, 500 * Math.pow(2, attempt - 1));
                this.log.warn(`[M-Cinema:Cache] Range ${start}-${end} failed (${err.message}), retry ${attempt}/${MAX_RETRIES} in ${delay} ms`);
                return new Promise((res) => setTimeout(res, delay)).then(run);
            });
        };
        return run();
    }

    /**
     * One HTTP Range request. Resolves { buf, total }. `first`: accept a 200 (whole body) only to
     * report NORANGE. Follows up to 5 redirects.
     */
    _fetchRange(start, end, first, setAbort, targetUrl, redirects) {
        return new Promise((resolve, reject) => {
            const u = urlMod.parse(targetUrl || this.url);
            const lib = u.protocol === 'http:' ? http : https;
            const want = end - start + 1;
            let done = false;
            let req = null;
            const fail = (err) => {
                if (done) return;
                done = true;
                if (req) { try { req.abort(); } catch (e) {} }
                reject(err);
            };
            if (setAbort) setAbort(() => fail(Object.assign(new Error('aborted'), { code: 'ABORTED' })));
            try {
                req = lib.get({
                    hostname: u.hostname,
                    port: u.port || (u.protocol === 'http:' ? 80 : 443),
                    path: u.path,
                    headers: Object.assign({
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
                        'Accept': '*/*',
                        'Range': `bytes=${start}-${end}`
                    }, this.headers),
                    timeout: IDLE_TIMEOUT_MS
                }, (res) => {
                    if (done) { res.resume(); return; }
                    const sc = res.statusCode;
                    if (sc >= 300 && sc < 400 && res.headers.location) {
                        res.resume();
                        if ((redirects || 0) >= 5) return fail(new Error('too many redirects'));
                        const next = urlMod.resolve(targetUrl || this.url, res.headers.location);
                        done = true;
                        return this._fetchRange(start, end, first, setAbort, next, (redirects || 0) + 1).then(resolve, reject);
                    }
                    if (sc === 200 && first) {
                        res.resume();
                        return fail(Object.assign(new Error('Server ignores Range requests'), { code: 'NORANGE' }));
                    }
                    if (sc !== 206) {
                        res.resume();
                        return fail(Object.assign(new Error(`HTTP ${sc}`), { status: sc }));
                    }
                    const ctype = String(res.headers['content-type'] || '');
                    if (/text\/html|application\/json/i.test(ctype)) {
                        res.resume();
                        return fail(new Error('Stream returned a web page, not video'));
                    }
                    const cr = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(String(res.headers['content-range'] || ''));
                    if (!cr || Number(cr[1]) !== start) {
                        res.resume();
                        return fail(new Error('Unexpected Content-Range ' + (res.headers['content-range'] || '(none)')));
                    }
                    const total = cr[3] === '*' ? 0 : Number(cr[3]);
                    const expect = Math.min(want, Number(cr[2]) - start + 1);
                    const buf = Buffer.alloc(expect);
                    let got = 0;
                    res.on('data', (c) => {
                        if (done) return;
                        if (got + c.length > expect) return fail(new Error('Range body longer than announced'));
                        c.copy(buf, got);
                        got += c.length;
                    });
                    res.on('aborted', () => fail(new Error('connection aborted')));
                    res.on('error', (e) => fail(e));
                    res.on('end', () => {
                        if (done) return;
                        if (got !== expect) return fail(new Error(`short range (${got}/${expect} bytes)`));
                        done = true;
                        resolve({ buf: buf, total: total });
                    });
                });
            } catch (e) {
                return fail(e);
            }
            req.on('error', (e) => fail(e));
            req.on('timeout', () => fail(new Error('idle timeout')));
        });
    }

    /** Serve the native engine on a Unix socket. Resolves once listening. */
    serve(sockPath) {
        try { fs.unlinkSync(sockPath); } catch (e) {}
        return new Promise((resolve, reject) => {
            const server = net.createServer((c) => {
                if (this.conn || this.destroyed) { c.destroy(); return; }   // one engine only
                this.conn = c;
                let lineBuf = '';
                let chain = Promise.resolve();
                const answer = (off, len) => this.read(off, len).then((data) => {
                    const hdr = Buffer.alloc(4);
                    hdr.writeUInt32LE(data.length, 0);
                    if (!c.destroyed) { c.write(hdr); if (data.length) c.write(data); }
                }, (err) => {
                    if (err.code !== 'ABORTED' && !this.destroyed) {
                        this.log.warn(`[M-Cinema:Cache] Range at ${off} failed: ${err.message}`);
                        if (this.onError) this.onError(err);
                    }
                    const hdr = Buffer.alloc(4);
                    hdr.writeUInt32LE(ERR_LEN, 0);
                    if (!c.destroyed) c.write(hdr);
                });
                c.on('data', (d) => {
                    lineBuf += d.toString('latin1');
                    let nl;
                    while ((nl = lineBuf.indexOf('\n')) >= 0) {
                        const line = lineBuf.slice(0, nl).trim();
                        lineBuf = lineBuf.slice(nl + 1);
                        const m = /^R (\d+) (\d+)$/.exec(line);
                        if (!m) continue;
                        const off = Number(m[1]), len = Math.min(Number(m[2]), 4 * 1024 * 1024);
                        chain = chain.then(() => answer(off, len));   // in order, one at a time
                    }
                    if (lineBuf.length > 256) lineBuf = '';
                });
                c.on('error', () => {});
                c.on('close', () => { if (this.conn === c) this.conn = null; });
            });
            server.on('error', reject);
            server.listen(sockPath, () => {
                try { fs.chmodSync(sockPath, 0o600); } catch (e) {}
                this.server = server;
                this.sockPath = sockPath;
                resolve();
            });
        });
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.pending.forEach((p) => p.abort());
        this.pending.clear();
        this.ready.clear();
        if (this.conn) { try { this.conn.destroy(); } catch (e) {} this.conn = null; }
        if (this.server) { try { this.server.close(); } catch (e) {} this.server = null; }
        if (this.sockPath) { try { fs.unlinkSync(this.sockPath); } catch (e) {} }
    }
}

module.exports = { RangeCache, CHUNK };
