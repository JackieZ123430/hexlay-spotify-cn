'use strict';
/**
 * player.js - Native Video Engine Controller for M-Cinema (BMW iDrive 7).
 *
 * Spawns and controls the native `mgu-vidplay` engine over IPC FIFOs:
 *   - Video frames decoded directly into /dev/shm/mgu-video-cinema (Protocol 4)
 *   - Control FIFO: sends pause, resume, seek, and stop commands
 *   - Status FIFO: receives live timecode and playback state JSON updates
 *   - Streaming, best first (by the engine's --caps):
 *       'sock': browser-style range buffering (range_cache.js): 1 MB HTTP ranges in a small RAM
 *               window around the playback position, instant seeks, no file in /tmp
 *       'grow': download to /tmp, play while the file grows (servers that ignore Range)
 *       older engine: download completely to /tmp, then play
 *   - Engine runs at a lower CPU priority (--nice); a watchdog stops an engine that hangs
 *   - Locks (motion, heat, ...): while any is set the picture is held paused
 *   - Simulator / PC fallback: simulates playback timing if native binary is unavailable
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const urlMod = require('url');
const { spawn, execFileSync } = require('child_process');
const { resolveYouTubeStream } = require('./stream_resolver.js');
const { RangeCache } = require('./range_cache.js');

function extractYouTubeId(urlOrId) {
    if (!urlOrId) return null;
    if (/^[A-Za-z0-9_-]{11}$/.test(urlOrId)) return urlOrId;
    const m = String(urlOrId).match(/(?:v=|youtu\.be\/|embed\/|v\/|shorts\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
}

const BIN_CANDIDATES = [
    '/var/opt/mgu-renderd/mgu-vidplay',
    path.join(__dirname, 'bin', 'mgu-vidplay'),
    path.join(process.cwd(), 'bin', 'mgu-vidplay'),
    path.join(process.cwd(), 'source', 'javascript', 'bin', 'mgu-vidplay'),
    path.join(process.cwd(), 'javascript', 'bin', 'mgu-vidplay'),
    path.resolve(__dirname, '..', 'bin', 'mgu-vidplay'),
    '/usr/local/bin/mgu-vidplay',
    '/tmp/mgu-vidplay'
];

// tmpfs cache, capped to keep /tmp (RAM) from filling up. The engine starts once START_BYTES
// are in (the MP4 header and the first seconds); the rest plays while it downloads.
const MAX_CACHE_BYTES = 300 * 1024 * 1024;
const START_BYTES = 1024 * 1024;
const ENGINE_NICE = 10;               // the HMI always gets the CPU first
const AHEAD_SECONDS = 90;             // range mode: prefetch this much video ahead ...
const AHEAD_MIN = 4 * 1024 * 1024;    // ... at least this much
const AHEAD_MAX = 16 * 1024 * 1024;   // ... at most this much (RAM)
const WATCHDOG_MS = 20000;            // a playing engine silent this long is stopped
const CACHE_HEADROOM = 16 * 1024 * 1024;
const MAX_RESUMES = 4;
const IDLE_TIMEOUT_MS = 15000;
const CTRL_RETRY_MS = 200;
const CTRL_RETRY_MAX = 50;

const mb = (n) => (n / 1048576).toFixed(1);

class VideoPlayer {
    constructor(log, opts) {
        this.log = log || console;
        this.opts = opts || {};
        this.shmPath = this.opts.shmPath || '/dev/shm/mgu-video-cinema';
        this.ctrlPath = this.opts.ctrlPath || '/tmp/mgu-cinema-ctrl.fifo';
        this.statusPath = this.opts.statusPath || '/tmp/mgu-cinema-status.fifo';
        this.streamLocalFile = this.opts.streamLocalFile || '/tmp/mgu-cinema-stream.mp4';
        this.sockPath = this.opts.sockPath || '/tmp/mgu-cinema-src.sock';
        this.maxCacheBytes = this.opts.maxCacheBytes || MAX_CACHE_BYTES;
        this.spawnImpl = this.opts.spawn || spawn;
        this.proc = null;
        this.gen = 0;                 // bumped on every play/stop; stale async callbacks compare it
        this.statusFd = -1;
        this.statusTimer = null;
        this.ctrlQueue = [];
        this.ctrlTimer = null;
        this.ctrlTries = 0;
        this.activeDownload = null;
        this.activeUrl = null;
        this.isPlaying = false;
        this.userPaused = false;
        this.locks = new Set();       // 'motion', 'heat', ...: picture held paused while any is set
        this.cache = null;            // RangeCache in range mode
        this.lastStatusAt = 0;
        this.watchdog = null;
        this.buffering = null;        // { bytes, total } while waiting for the stream (start or stall)
        this.stalled = false;         // engine is playing but waiting for more downloaded data
        this.dlBytes = 0;
        this.dlTotal = 0;
        this.engine = undefined;      // { bin, grow, sock, nice } once probed
        this.currentTimeSec = 0;
        this.totalDurationSec = 0;
        this.simTimer = null;
        this.onProgress = null;
        this.onEnded = null;
        this.onBuffering = null;      // (bytes, total)
        this.onError = null;          // (message)
        this.onVideoFile = null;      // (path | null): define / drop the frame file in the renderer
        this.videoAnnounced = false;

        // leftovers of an earlier run (killed app, older version): orphaned engine, cache, FIFOs
        if (!this.opts.noSweep) this._sweep();

        // 'exit' only: SIGTERM/SIGINT are handled (and exited) by main.js
        process.on('exit', () => this._resetInternal());
    }

    /** Files this player creates; all of them live in RAM (/tmp, /dev/shm). */
    _ownFiles() {
        return [this.streamLocalFile, this.streamLocalFile + '.done', this.sockPath, this.ctrlPath, this.statusPath, this.shmPath];
    }

    _removeFiles(files) {
        for (const f of files) {
            try { fs.unlinkSync(f); } catch (e) {}
        }
    }

    /**
     * Stop video engines left running by an earlier run of the app (an older engine does not
     * exit with its parent) and remove what they left in /tmp and /dev/shm.
     */
    _sweep() {
        let killed = 0;
        if (process.platform === 'linux') {
            let pids = [];
            try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d) && Number(d) !== process.pid); } catch (e) {}
            for (const pid of pids) {
                let cmd = '';
                try { cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8'); } catch (e) { continue; }
                const args = cmd.split('\0');
                // the engine binary is the first argument (or near it, behind a wrapper such as nice)
                if (!args.slice(0, 3).some((x) => /(^|\/)mgu-vidplay$/.test(x)) || args.indexOf(this.shmPath) < 0) continue;
                try { process.kill(Number(pid), 'SIGKILL'); killed++; } catch (e) {}
            }
        }
        const stale = this._ownFiles().filter((f) => { try { return fs.existsSync(f); } catch (e) { return false; } });
        this._removeFiles(stale);
        if (killed || stale.length) {
            this.log.info(`[M-Cinema:Player] Cleaned up an earlier run: ${killed} engine(s) stopped, ${stale.length} file(s) removed`);
        }
    }

    get locked() { return this.locks.size > 0; }

    /** Features of the engine at bin ('grow', 'sock', 'nice'); none for older engines. */
    _probeCaps(bin) {
        this.lastProbe = '';
        try {
            const out = execFileSync(bin, ['--caps'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
            const caps = out.split(/\s+/).filter(Boolean);
            this.lastProbe = caps.length ? caps.join(',') : 'no features listed';
            return caps;
        } catch (e) {
            // older engines don't know --caps (usage, exit 1); EACCES / ENOEXEC = can't run from there
            this.lastProbe = e.code ? 'cannot run (' + e.code + ')' : (e.status !== undefined ? 'older engine (no --caps)' : String(e.message || e));
            return [];
        }
    }

    _engineFor(bin, caps) {
        return { bin: bin, grow: caps.indexOf('grow') >= 0, sock: caps.indexOf('sock') >= 0, nice: caps.indexOf('nice') >= 0 };
    }

    /**
     * The engine to use: { bin, grow, sock, nice }, or null. Prefers the most capable candidate
     * (an older copy may sit in /var/opt/mgu-renderd from a manual install).
     */
    _findEngine() {
        if (this.engine !== undefined) return this.engine;
        if (this.opts.bin !== undefined) {
            const bin = this.opts.bin;
            this.engine = bin ? this._engineFor(bin, this.opts.caps || this._probeCaps(bin)) : null;
            return this.engine;
        }
        let best = null;
        const score = (e) => (e.sock ? 2 : 0) + (e.grow ? 1 : 0);
        for (const p of BIN_CANDIDATES) {
            try {
                if (!fs.existsSync(p)) continue;
                try { fs.chmodSync(p, 0o755); } catch (e) {}
                if (!fs.statSync(p).isFile()) continue;
                const e = this._engineFor(p, this._probeCaps(p));
                this.log.info(`[M-Cinema:Player] Engine candidate ${p}: ${this.lastProbe}`);
                if (/cannot run/.test(this.lastProbe)) continue;      // e.g. a noexec mount
                if (!best || score(e) > score(best)) best = e;
                if (e.sock) break;
            } catch (e) {}
        }
        this.engine = best;
        if (best) this.log.info(`[M-Cinema:Player] Video engine: ${best.bin} (${best.sock ? 'range buffering' : best.grow ? 'plays while downloading' : 'older engine: full download first'})`);
        return this.engine;
    }

    /** Stop the engine process now; its late 'close' is ignored. */
    /** Tell the renderer about the frame file (defined once the engine made it, dropped before removal). */
    _announceVideo(on) {
        if (on === this.videoAnnounced) return;
        this.videoAnnounced = on;
        if (this.onVideoFile) {
            try { this.onVideoFile(on ? this.shmPath : null); } catch (e) {}
        }
    }

    _killProc() {
        this._clearCtrlQueue();
        if (!this.proc) return;
        this._writeCtrl('quit');
        const p = this.proc;
        this.proc = null;
        try {
            if (p && !p.killed) p.kill('SIGKILL');
        } catch (e) {}
        this._closeStatus();
    }

    _abortDownload() {
        const dl = this.activeDownload;
        this.activeDownload = null;
        if (dl) dl.abort();
    }

    _resetInternal() {
        this.gen++;
        this._abortDownload();
        this._stopWatchdog();
        if (this.cache) { this.cache.destroy(); this.cache = null; }
        this.buffering = null;
        this.stalled = false;
        this.dlBytes = 0;
        this.dlTotal = 0;

        if (this.simTimer) {
            clearInterval(this.simTimer);
            this.simTimer = null;
        }
        this._killProc();
        this._closeStatus();

        // nothing stays behind in RAM: download cache, socket, FIFOs, the engine's frame file
        // (the renderer drops its handle first, or the removed file's memory stays in use)
        this._announceVideo(false);
        this._removeFiles(this._ownFiles());
    }

    _fail(msg) {
        this.log.warn(`[M-Cinema:Player] ${msg}`);
        this.isPlaying = false;
        this.buffering = null;
        if (this.onError) this.onError(msg);
    }

    play(streamUrl, durationSec, videoMeta) {
        this._resetInternal();
        const gen = this.gen;
        this.activeUrl = streamUrl;
        this.activeMeta = videoMeta || {};
        this.totalDurationSec = durationSec || 0;
        this.currentTimeSec = 0;
        this.isPlaying = !this.locked;
        this.userPaused = false;

        const ytId = (videoMeta && (videoMeta.ytId || videoMeta.id)) || extractYouTubeId(streamUrl) || null;
        this.activeYtId = ytId;
        const bX = (videoMeta && typeof videoMeta.x === 'number') ? videoMeta.x : 52;
        const bY = (videoMeta && typeof videoMeta.y === 'number') ? videoMeta.y : 102;
        const bW = (videoMeta && typeof videoMeta.w === 'number') ? videoMeta.w : 1008;
        const bH = (videoMeta && typeof videoMeta.h === 'number') ? videoMeta.h : 336;
        const bR = (videoMeta && typeof videoMeta.r === 'number') ? videoMeta.r : 8;

        if (process.send) {
            process.send({
                t: 'video',
                action: 'play',
                url: streamUrl,
                ytId: ytId,
                title: (videoMeta && videoMeta.title) || '',
                duration: this.totalDurationSec,
                time: this.currentTimeSec,
                fullscreen: !!(videoMeta && videoMeta.fullscreen),
                quality: 'hd720',
                captions: false,
                x: bX,
                y: bY,
                w: bW,
                h: bH,
                r: bR
            });
        }

        const engine = this._findEngine();
        if (!engine) {
            this.log.warn('[M-Cinema:Player] Native mgu-vidplay binary not found on host, using simulation clock');
            this._startSimulation();
            return false;
        }

        // If playing YouTube, resolve direct stream first
        if (ytId && (!streamUrl || !streamUrl.includes('googlevideo.com'))) {
            this.log.info(`[M-Cinema:Player] Resolving direct YouTube stream for: ${ytId}`);
            this.buffering = { bytes: 0, total: 0 };
            const resolve = this.opts.resolve || resolveYouTubeStream;
            resolve(ytId, this.log).then((resolved) => {
                if (gen !== this.gen) return;
                if (resolved && resolved.url) {
                    this.log.info(`[M-Cinema:Player] Direct stream resolved: ${resolved.quality} (${resolved.width}x${resolved.height})`);
                    if (resolved.durationSec > 0 && !this.totalDurationSec) {
                        this.totalDurationSec = resolved.durationSec;
                    }
                    this._streamAndSpawn(engine, resolved.url, gen);
                } else {
                    this._streamAndSpawn(engine, streamUrl, gen);
                }
            }).catch((err) => {
                if (gen !== this.gen) return;
                this.log.warn(`[M-Cinema:Player] Direct stream resolution fallback: ${err.message}`);
                this._streamAndSpawn(engine, streamUrl, gen);
            });
            return true;
        }

        return this._streamAndSpawn(engine, streamUrl, gen);
    }

    _streamAndSpawn(engine, mediaUrl, gen) {
        if (gen !== this.gen) return false;
        if (!mediaUrl) {
            this._fail('No playable stream');
            return false;
        }

        // If it's already a local file path, spawn directly
        if (!mediaUrl.startsWith('http://') && !mediaUrl.startsWith('https://')) {
            this.buffering = null;
            return this._spawnPlayer(engine.bin, mediaUrl, gen);
        }
        if (engine.sock) return this._playFromRanges(engine, mediaUrl, gen);
        return this._playFromFile(engine, mediaUrl, gen);
    }

    _playFromFile(engine, mediaUrl, gen) {
        return engine.grow ? this._playWhileDownloading(engine.bin, mediaUrl, gen)
                           : this._playAfterDownload(engine.bin, mediaUrl, gen);
    }

    /** A fresh stream URL for the current video (the old one expired), or null. */
    _refreshUrl(gen) {
        const ytId = this.activeYtId;
        if (!ytId) return Promise.resolve(null);
        const resolve = this.opts.resolve || resolveYouTubeStream;
        return resolve(ytId, this.log).then((r) => (gen === this.gen && r && r.url) ? r.url : null, () => null);
    }

    /** Browser-style: the engine reads byte ranges that range_cache.js fetches on demand. */
    _playFromRanges(engine, mediaUrl, gen) {
        this.log.info('[M-Cinema:Player] Range buffering: opening stream');
        this.buffering = { bytes: 0, total: START_BYTES };
        RangeCache.open(mediaUrl, { log: this.log, refreshUrl: () => this._refreshUrl(gen), chunkSize: this.opts.chunkSize })
            .then((cache) => {
                if (gen !== this.gen) { cache.destroy(); return; }
                this.cache = cache;
                const dur = this.totalDurationSec || 0;
                const ahead = dur > 0 ? cache.size / dur * AHEAD_SECONDS : AHEAD_MAX;
                cache.ahead = Math.max(AHEAD_MIN, Math.min(AHEAD_MAX, Math.round(ahead)));
                cache.maxBytes = cache.ahead + cache.behind + 4 * cache.chunk;
                cache.onError = (err) => {
                    if (gen !== this.gen || this.cache !== cache) return;
                    this._killProc();
                    this._fail('Video stream failed: ' + err.message);
                };
                this.log.info(`[M-Cinema:Player] Stream ${mb(cache.size)} MB, buffer window ${mb(cache.ahead)} MB ahead (max ${mb(cache.maxBytes)} MB RAM)`);
                return cache.serve(this.sockPath).then(() => {
                    if (gen !== this.gen) return;
                    this.stalled = true;               // until the first picture
                    this.buffering = { bytes: cache.bufferedAhead(), total: START_BYTES };
                    this._spawnPlayer(engine.bin, null, gen, ['--sock', this.sockPath, '--size', String(cache.size)], engine);
                });
            })
            .catch((err) => {
                if (gen !== this.gen) return;
                if (this.cache) { this.cache.destroy(); this.cache = null; }
                if (err.code === 'NORANGE') {
                    this.log.warn(`[M-Cinema:Player] ${err.message}: falling back to downloading the file`);
                    this._playFromFile(engine, mediaUrl, gen);
                    return;
                }
                this._fail('Video stream unavailable: ' + err.message);
            });
        return true;
    }

    /**
     * Download to tmpfs and start the engine after START_BYTES: it reads the file as it grows and
     * waits (reporting "buffering") when playback catches up with the download. The .done marker
     * tells it where the real end of the file is.
     */
    _playWhileDownloading(bin, mediaUrl, gen) {
        const localPath = this.streamLocalFile;
        const doneMarker = localPath + '.done';
        try { fs.unlinkSync(doneMarker); } catch (e) {}
        this.log.info(`[M-Cinema:Player] Streaming to ${localPath}, playback starts after ${mb(START_BYTES)} MB`);
        this.buffering = { bytes: 0, total: 0 };
        let started = false;
        const start = (total) => {
            if (started || gen !== this.gen) return;
            started = true;
            this.buffering = null;
            this.log.info(`[M-Cinema:Player] Starting playback at ${mb(this.dlBytes)} MB of ${total > 0 ? mb(total) + ' MB' : 'unknown size'}`);
            this._spawnPlayer(bin, localPath, gen, ['--grow', doneMarker].concat(total > 0 ? ['--size', String(total)] : []));
        };
        const dl = this._streamVideoToFile(mediaUrl, localPath, (err, p, bytes) => {
            if (this.activeDownload === dl) this.activeDownload = null;
            if (gen !== this.gen) return;
            if (err) {
                this._killProc();
                this._fail(err.message);
                return;
            }
            try {
                fs.writeFileSync(doneMarker, '');
            } catch (e) {
                this.log.warn(`[M-Cinema:Player] Could not write ${doneMarker}: ${e.message}`);
            }
            this.log.info(`[M-Cinema:Player] Video stream download completed (${bytes} bytes)`);
            if (this.stalled) { this.stalled = false; this.buffering = null; }
            start(bytes);                    // a video shorter than START_BYTES starts now
        }, (written, total) => {
            if (gen !== this.gen) return;
            this.dlBytes = written;
            this.dlTotal = total;
            if (!started) {
                this.buffering = { bytes: written, total: total };
                if (written >= START_BYTES) start(total);
            } else if (this.stalled) {
                this.buffering = { bytes: written, total: total };
            }
        });
        this.activeDownload = dl;
        return true;
    }

    /** Older engine (stops at the end of a growing file): download completely, then spawn. */
    _playAfterDownload(bin, mediaUrl, gen) {
        this.log.info(`[M-Cinema:Player] Buffering HTTPS stream to ${this.streamLocalFile}...`);
        this.buffering = { bytes: 0, total: 0 };
        const dl = this._streamVideoToFile(mediaUrl, this.streamLocalFile, (err, localPath, bytes) => {
            if (this.activeDownload === dl) this.activeDownload = null;
            if (gen !== this.gen) return;
            this.buffering = null;
            if (err) {
                this._fail(err.message);
                return;
            }
            this.log.info(`[M-Cinema:Player] Video stream download completed (${bytes} bytes), launching player`);
            this._spawnPlayer(bin, localPath, gen);
        }, (written, total) => {
            if (gen === this.gen) this.buffering = { bytes: written, total: total };
        });
        this.activeDownload = dl;
        return true;
    }

    /** Free bytes usable in the cache directory (df), capped at maxCacheBytes. */
    _cacheLimit(localPath) {
        let limit = this.maxCacheBytes;
        try {
            const out = execFileSync('df', ['-P', '-k', path.dirname(localPath)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
            const lines = out.trim().split('\n');
            const cols = lines[lines.length - 1].trim().split(/\s+/);
            const availKb = parseInt(cols[cols.length - 3], 10);
            if (availKb > 0) limit = Math.min(limit, availKb * 1024 - CACHE_HEADROOM);
        } catch (e) {}
        return Math.max(0, limit);
    }

    /**
     * Downloads remoteUrl to localPath. onDone(err, localPath, bytes) is called once (never after
     * abort()); onData(written, total) after each chunk. Follows redirects, needs a 2xx video body,
     * caps the size, resumes an idle or broken transfer with an HTTP Range request when the server
     * accepts ranges.
     */
    _streamVideoToFile(remoteUrl, localPath, onDone, onData) {
        try { if (fs.existsSync(localPath)) fs.unlinkSync(localPath); } catch (e) {}

        const limit = this._cacheLimit(localPath);
        const fileOut = fs.createWriteStream(localPath, { flags: 'w' });

        let written = 0;
        let total = 0;
        let resumes = 0;
        let acceptRanges = false;
        let finished = false;
        let req = null;
        let resumeUrl = remoteUrl;
        let lastReport = 0;

        const dropReq = () => {
            const r = req;
            req = null;
            if (r) { try { r.abort(); } catch (e) {} }
        };
        const finish = (err) => {
            if (finished) return;
            finished = true;
            dropReq();
            if (err) {
                try { fileOut.end(); } catch (e) {}
                try { fs.unlinkSync(localPath); } catch (e) {}
                onDone(err, localPath, written);
            } else {
                fileOut.end(() => onDone(null, localPath, written));
            }
        };
        fileOut.on('error', (e) => {
            finish(new Error(e.code === 'ENOSPC' ? 'Video cache full (not enough memory)' : `Video cache write failed: ${e.message}`));
        });

        const retry = (r0, reason) => {
            if (finished || r0 !== req) return;
            dropReq();
            if (resumes >= MAX_RESUMES || (written > 0 && !acceptRanges)) {
                return finish(new Error(`Video download failed: ${reason}`));
            }
            resumes++;
            this.log.warn(`[M-Cinema:Player] Stream ${reason} at ${written} bytes, ${written > 0 ? 'resuming with Range' : 'retrying'} (${resumes}/${MAX_RESUMES})`);
            setTimeout(() => makeReq(resumeUrl, 0), 1000);
        };

        const makeReq = (targetUrl, redirectCount) => {
            if (finished) return;
            if (redirectCount > 5) {
                return finish(new Error('Video download failed: too many redirects'));
            }
            const u = urlMod.parse(targetUrl);
            const lib = u.protocol === 'http:' ? http : https;
            const headers = {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
                'Accept': '*/*'
            };
            if (written > 0) headers.Range = `bytes=${written}-`;
            let r;
            try {
                r = lib.get({
                    hostname: u.hostname,
                    port: u.port || (u.protocol === 'http:' ? 80 : 443),
                    path: u.path,
                    headers: headers,
                    timeout: IDLE_TIMEOUT_MS
                }, (res) => {
                    if (finished || r !== req) { res.resume(); return; }
                    const sc = res.statusCode;
                    if (sc >= 300 && sc < 400 && res.headers.location) {
                        res.resume();
                        let nextUrl = res.headers.location;
                        if (!nextUrl.startsWith('http')) {
                            nextUrl = urlMod.resolve(targetUrl, nextUrl);
                        }
                        return makeReq(nextUrl, redirectCount + 1);
                    }
                    if (written > 0 ? sc !== 206 : (sc < 200 || sc > 299)) {
                        res.resume();
                        return finish(new Error(written > 0 ? `Video resume refused (HTTP ${sc})` : `Video stream unavailable (HTTP ${sc})`));
                    }
                    const ctype = String(res.headers['content-type'] || '');
                    if (/text\/html|text\/plain|application\/json|application\/xml/i.test(ctype)) {
                        res.resume();
                        return finish(new Error('Video stream returned a web page, not video'));
                    }
                    if (written === 0) {
                        total = parseInt(res.headers['content-length'], 10) || 0;
                        acceptRanges = /bytes/i.test(String(res.headers['accept-ranges'] || '')) || sc === 206;
                    } else {
                        acceptRanges = true;
                        const cr = /\/(\d+)\s*$/.exec(String(res.headers['content-range'] || ''));
                        if (cr && !total) total = parseInt(cr[1], 10) || 0;
                    }
                    if (total > limit) {
                        res.resume();
                        return finish(new Error(`Video too large for cache (${mb(total)} MB)`));
                    }
                    resumeUrl = targetUrl;
                    let resAborted = false;

                    res.on('data', (chunk) => {
                        if (finished || r !== req) return;
                        if (written + chunk.length > limit) {
                            return finish(new Error(`Video too large for cache (> ${mb(limit)} MB)`));
                        }
                        written += chunk.length;
                        if (!fileOut.write(chunk)) {
                            res.pause();
                            fileOut.once('drain', () => res.resume());
                        }
                        if (onData) onData(written, total);
                        const now = Date.now();
                        if (now - lastReport > 250) {
                            lastReport = now;
                            if (this.onBuffering) this.onBuffering(written, total);
                        }
                    });
                    res.on('aborted', () => { resAborted = true; retry(r, 'aborted'); });
                    res.on('error', (err) => retry(r, err.message));
                    res.on('end', () => {
                        if (finished || r !== req || resAborted) return;
                        if (total > 0 && written < total) return retry(r, 'ended early');
                        finish(null);
                    });
                });
            } catch (err) {
                return finish(new Error(`Video download failed: ${err.message}`));
            }
            req = r;
            r.on('error', (err) => retry(r, err.message));
            r.on('timeout', () => retry(r, 'idle timeout'));
        };

        makeReq(remoteUrl, 0);

        return {
            abort: () => {
                if (finished) return;
                finished = true;
                dropReq();
                try { fileOut.end(); } catch (e) {}
            }
        };
    }

    _mkfifo(p) {
        try { fs.unlinkSync(p); } catch (e) {}        // stale FIFO (a killed engine may still hold the old one)
        const tries = [['mkfifo', ['-m', '666', p]], ['mknod', [p, 'p']]];
        for (const t of tries) {
            try {
                execFileSync(t[0], t[1], { stdio: 'ignore', timeout: 2000 });
                return true;
            } catch (e) {}
        }
        this.log.warn(`[M-Cinema:Player] Could not create FIFO ${p}; vidplay will create it`);
        return false;
    }

    _spawnPlayer(bin, localFilePath, gen, extraArgs, engine) {
        if (gen !== undefined && gen !== this.gen) return false;
        try {
            // FIFOs exist and the status reader is open BEFORE spawn: vidplay opens the status
            // FIFO O_WRONLY|O_NONBLOCK once, which fails (ENXIO) unless a reader is there.
            this._closeStatus();
            this._clearCtrlQueue();
            this._mkfifo(this.ctrlPath);
            if (this._mkfifo(this.statusPath)) this._openStatusReader();

            const args = [
                '--shm', this.shmPath,
                '--width', '1280',
                '--height', '720',
                '--fps', '30',
                '--ctrl', this.ctrlPath,
                '--status', this.statusPath
            ].concat((engine || this.engine || {}).nice ? ['--nice', String(ENGINE_NICE)] : [],
                     extraArgs || [], localFilePath ? [localFilePath] : []);

            this.log.info(`[M-Cinema:Player] Spawning native player: ${bin} ${args.join(' ')}`);
            const proc = this.spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            this.proc = proc;

            if (proc.stdout) proc.stdout.on('data', (d) => {
                this.log.info(`[mgu-vidplay] ${d.toString().trim()}`);
            });
            if (proc.stderr) proc.stderr.on('data', (d) => {
                this.log.info(`[mgu-vidplay] ${d.toString().trim()}`);
            });

            proc.on('error', (err) => {
                if (this.proc !== proc) return;
                this.proc = null;
                this._closeStatus();
                this._clearCtrlQueue();
                this._fail(`Video engine failed: ${err.message}`);
            });

            proc.on('close', (code) => {
                // a killed previous engine closes late: it must not end the current video
                if (this.proc !== proc) {
                    this.log.info(`[M-Cinema:Player] Previous native player exited (${code}), ignored`);
                    return;
                }
                this.log.info(`[M-Cinema:Player] Native player process exited with code ${code}`);
                this.proc = null;
                this._stopWatchdog();
                this.buffering = null;
                this.stalled = false;
                this._closeStatus();
                this._clearCtrlQueue();
                this.isPlaying = false;
                if (this.onEnded) this.onEnded(code);
            });

            if (this.userPaused || this.locked) {
                this.isPlaying = false;
                this._sendCtrl('pause');
            } else {
                this.isPlaying = true;
            }
            this._startWatchdog(gen);
            return true;
        } catch (err) {
            this.log.error(`[M-Cinema:Player] Failed to start native player: ${err.message}`);
            this.proc = null;
            this._closeStatus();
            this._startSimulation();
            return false;
        }
    }

    _openStatusReader() {
        try {
            this.statusFd = fs.openSync(this.statusPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        } catch (e) {
            this.statusFd = -1;
            this.log.warn(`[M-Cinema:Player] Could not attach status FIFO: ${e.message}`);
            return;
        }
        const fd = this.statusFd;
        const buf = Buffer.alloc(4096);
        let leftover = '';
        this.statusTimer = setInterval(() => {
            if (this.statusFd !== fd) return;
            for (;;) {
                let n = 0;
                try {
                    n = fs.readSync(fd, buf, 0, buf.length, null);
                } catch (e) {
                    if (e.code !== 'EAGAIN' && e.code !== 'EWOULDBLOCK') this._closeStatus();
                    break;
                }
                if (n <= 0) break;       // no writer (yet / any more)
                const lines = (leftover + buf.toString('utf8', 0, n)).split('\n');
                leftover = lines.pop();
                for (const line of lines) this._onStatusLine(line);
            }
        }, 200);
    }

    /** Stop an engine that went silent while it should be playing (it sends status every 250-500 ms). */
    _startWatchdog(gen) {
        this._stopWatchdog();
        this.lastStatusAt = Date.now();
        this.watchdog = setInterval(() => {
            if (gen !== this.gen || !this.proc) return this._stopWatchdog();
            if (this.userPaused || this.locked) { this.lastStatusAt = Date.now(); return; }   // a paused engine is quiet
            if (Date.now() - this.lastStatusAt > WATCHDOG_MS) {
                this.log.warn(`[M-Cinema:Player] Engine silent for ${WATCHDOG_MS / 1000} s, stopping it`);
                this._killProc();
                this._stopWatchdog();
                this._fail('Video engine stopped responding');
            }
        }, 2000);
    }

    _stopWatchdog() {
        if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    }

    _onStatusLine(line) {
        if (!line.trim()) return;
        try {
            const data = JSON.parse(line.trim());
            if (typeof data.pts === 'number') {
                this.lastStatusAt = Date.now();
                // a normal status line comes after the first frame was written (buffering lines can
                // come earlier, while the stream opens): the renderer may open the frame file now
                if (!this.videoAnnounced && this.proc && !data.buffering) this._announceVideo(true);
                // the engine caught up with the download: show the buffering overlay until it resumes
                if (data.buffering) {
                    this.stalled = true;
                    this.buffering = this.cache ? { bytes: this.cache.bufferedAhead(), total: START_BYTES }
                                                : { bytes: this.dlBytes, total: this.dlTotal };
                } else if (this.stalled) {
                    this.stalled = false;
                    this.buffering = null;
                }
                this.currentTimeSec = data.pts;
                if (data.dur > 0) this.totalDurationSec = data.dur;
                this.isPlaying = !!data.playing && !this.userPaused && !this.locked;
                if (this.onProgress) {
                    this.onProgress(this.currentTimeSec, this.totalDurationSec, this.isPlaying);
                }
            }
        } catch (e) {}
    }

    _closeStatus() {
        if (this.statusTimer) {
            clearInterval(this.statusTimer);
            this.statusTimer = null;
        }
        if (this.statusFd >= 0) {
            try { fs.closeSync(this.statusFd); } catch (e) {}
            this.statusFd = -1;
        }
    }

    /** One non-blocking write to the control FIFO; false when vidplay isn't reading it (yet). */
    _writeCtrl(cmd) {
        let fd = -1;
        try {
            fd = fs.openSync(this.ctrlPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
            fs.writeSync(fd, cmd + '\n');
            return true;
        } catch (e) {
            if (e.code !== 'ENXIO' && e.code !== 'ENOENT' && e.code !== 'EAGAIN') {
                this.log.warn(`[M-Cinema:Player] Failed sending command '${cmd}': ${e.message}`);
            }
            return false;
        } finally {
            if (fd >= 0) { try { fs.closeSync(fd); } catch (e) {} }
        }
    }

    _sendCtrl(cmd) {
        if (!this.proc) return;
        // keep order: once something is queued, queue behind it
        if (!this.ctrlQueue.length && this._writeCtrl(cmd)) return;
        this.ctrlQueue.push(cmd);
        if (this.ctrlQueue.length > 16) this.ctrlQueue.shift();
        if (this.ctrlTimer) return;
        this.ctrlTries = 0;
        this.ctrlTimer = setInterval(() => {
            if (!this.proc || ++this.ctrlTries > CTRL_RETRY_MAX) {
                if (this.proc) this.log.warn(`[M-Cinema:Player] Control FIFO has no reader, dropped: ${this.ctrlQueue.join(', ')}`);
                this._clearCtrlQueue();
                return;
            }
            while (this.ctrlQueue.length && this._writeCtrl(this.ctrlQueue[0])) this.ctrlQueue.shift();
            if (!this.ctrlQueue.length) this._clearCtrlQueue();
        }, CTRL_RETRY_MS);
    }

    _clearCtrlQueue() {
        this.ctrlQueue = [];
        if (this.ctrlTimer) {
            clearInterval(this.ctrlTimer);
            this.ctrlTimer = null;
        }
    }

    /**
     * Hold the picture paused while lock `name` is set ('motion', 'heat', ...). When the last lock
     * clears, playback resumes unless the user paused.
     */
    setLock(name, on) {
        const was = this.locked;
        if (on) this.locks.add(name); else this.locks.delete(name);
        if (this.locked === was) return;
        if (this.locked) {
            this.isPlaying = false;
            if (this.proc) this._sendCtrl('pause');
        } else if (!this.userPaused && (this.proc || this.simTimer || this.activeDownload || this.buffering || this.cache)) {
            this.isPlaying = true;
            this.lastStatusAt = Date.now();
            if (this.proc) this._sendCtrl('resume');
        }
    }

    /** Motion interlock (kept for callers): the 'motion' lock. */
    setLocked(locked) { this.setLock('motion', !!locked); }

    /** True while there is a video loaded (playing, paused, or buffering). */
    hasMedia() { return !!(this.proc || this.cache || this.activeDownload || this.simTimer || this.buffering); }

    pause() {
        this.isPlaying = false;
        this.userPaused = true;
        if (this.proc) {
            this._sendCtrl('pause');
        }
        if (process.send) {
            process.send({ t: 'video', action: 'pause' });
        }
    }

    resume() {
        if (this.locked) return false;
        this.isPlaying = true;
        this.userPaused = false;
        this.lastStatusAt = Date.now();
        if (this.proc) {
            this._sendCtrl('resume');
        }
        if (process.send) {
            process.send({ t: 'video', action: 'resume' });
        }
        return true;
    }

    seek(sec) {
        this.currentTimeSec = Math.max(0, sec);
        if (this.proc) {
            this._sendCtrl(`seek ${this.currentTimeSec}`);
        }
        if (process.send) {
            process.send({ t: 'video', action: 'seek', time: this.currentTimeSec });
        }
        if (this.onProgress) {
            this.onProgress(this.currentTimeSec, this.totalDurationSec, this.isPlaying);
        }
    }

    stop() {
        this.isPlaying = false;
        this.userPaused = false;
        this.activeUrl = null;
        this.activeMeta = null;
        this.currentTimeSec = 0;
        this._resetInternal();
        if (process.send) {
            try {
                process.send({ t: 'video', action: 'stop' });
            } catch (e) {}
        }
    }

    _startSimulation() {
        if (this.simTimer) clearInterval(this.simTimer);
        this.simTimer = setInterval(() => {
            if (!this.isPlaying) return;
            this.currentTimeSec += 1;
            if (this.totalDurationSec > 0 && this.currentTimeSec >= this.totalDurationSec) {
                this.currentTimeSec = this.totalDurationSec;
                this.isPlaying = false;
                if (this.onEnded) this.onEnded();
            }
            if (this.onProgress) {
                this.onProgress(this.currentTimeSec, this.totalDurationSec, this.isPlaying);
            }
        }, 1000);
    }
}

module.exports = { VideoPlayer };
