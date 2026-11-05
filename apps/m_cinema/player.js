'use strict';
/**
 * player.js - Native Video Engine Controller for M-Cinema (BMW iDrive 7).
 *
 * Spawns and controls the native `mgu-vidplay` engine over IPC FIFOs:
 *   - Video frames decoded directly into /dev/shm/mgu-video-cinema (Protocol 4)
 *   - Control FIFO: sends pause, resume, seek, and stop commands
 *   - Status FIFO: receives live timecode and playback state JSON updates
 *   - Local tmpfs streaming cache: buffers HTTPS video into /tmp/mgu-cinema-stream.mp4
 *   - Simulator / PC fallback: simulates playback timing if native binary is unavailable
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const urlMod = require('url');
const { spawn, execFileSync } = require('child_process');
const { resolveYouTubeStream } = require('./stream_resolver.js');

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

// tmpfs cache: the native engine stops at EOF of a growing file, so a stream is downloaded
// completely before vidplay starts. Capped to keep /tmp (RAM) from filling up.
const MAX_CACHE_BYTES = 300 * 1024 * 1024;
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
        this.locked = false;          // motion interlock: picture held paused
        this.buffering = null;        // { bytes, total } while the stream downloads
        this.currentTimeSec = 0;
        this.totalDurationSec = 0;
        this.simTimer = null;
        this.onProgress = null;
        this.onEnded = null;
        this.onBuffering = null;      // (bytes, total)
        this.onError = null;          // (message)

        // 'exit' only: SIGTERM/SIGINT are handled (and exited) by main.js
        process.on('exit', () => this._resetInternal());
    }

    _findBinary() {
        if (this.opts.bin !== undefined) return this.opts.bin;
        for (const p of BIN_CANDIDATES) {
            try {
                if (fs.existsSync(p)) {
                    try { fs.chmodSync(p, 0o755); } catch (e) {}
                    if (fs.statSync(p).isFile()) {
                        return p;
                    }
                }
            } catch (e) {}
        }
        return null;
    }

    _abortDownload() {
        const dl = this.activeDownload;
        this.activeDownload = null;
        if (dl) dl.abort();
    }

    _resetInternal() {
        this.gen++;
        this._abortDownload();
        this.buffering = null;

        if (this.simTimer) {
            clearInterval(this.simTimer);
            this.simTimer = null;
        }
        this._clearCtrlQueue();
        if (this.proc) {
            this._writeCtrl('quit');
            const p = this.proc;
            this.proc = null;    // its late 'close' is ignored (see _spawnPlayer)
            try {
                if (p && !p.killed) {
                    p.kill('SIGKILL');
                }
            } catch (e) {}
        }
        this._closeStatus();

        try {
            if (fs.existsSync(this.streamLocalFile)) {
                fs.unlinkSync(this.streamLocalFile);
            }
        } catch (e) {}
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

        const bin = this._findBinary();
        if (!bin) {
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
                    this._streamAndSpawn(bin, resolved.url, gen);
                } else {
                    this._streamAndSpawn(bin, streamUrl, gen);
                }
            }).catch((err) => {
                if (gen !== this.gen) return;
                this.log.warn(`[M-Cinema:Player] Direct stream resolution fallback: ${err.message}`);
                this._streamAndSpawn(bin, streamUrl, gen);
            });
            return true;
        }

        return this._streamAndSpawn(bin, streamUrl, gen);
    }

    _streamAndSpawn(bin, mediaUrl, gen) {
        if (gen !== this.gen) return false;
        if (!mediaUrl) {
            this._fail('No playable stream');
            return false;
        }

        // If it's already a local file path, spawn directly
        if (!mediaUrl.startsWith('http://') && !mediaUrl.startsWith('https://')) {
            this.buffering = null;
            return this._spawnPlayer(bin, mediaUrl, gen);
        }

        // vidplay stops at the EOF of a growing file: download completely, then spawn
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
     * abort()). Follows redirects, needs a 2xx video body, caps the size, resumes an idle or
     * broken transfer with an HTTP Range request when the server accepts ranges.
     */
    _streamVideoToFile(remoteUrl, localPath, onDone) {
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
                        const now = Date.now();
                        if (now - lastReport > 250) {
                            lastReport = now;
                            this.buffering = { bytes: written, total: total };
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

    _spawnPlayer(bin, localFilePath, gen) {
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
                '--status', this.statusPath,
                localFilePath
            ];

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

    _onStatusLine(line) {
        if (!line.trim()) return;
        try {
            const data = JSON.parse(line.trim());
            if (typeof data.pts === 'number') {
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

    /** Motion interlock: hold the picture paused while locked; resume on unlock unless the user paused. */
    setLocked(locked) {
        locked = !!locked;
        if (locked === this.locked) return;
        this.locked = locked;
        if (locked) {
            this.isPlaying = false;
            if (this.proc) this._sendCtrl('pause');
        } else if (!this.userPaused && (this.proc || this.simTimer || this.activeDownload || this.buffering)) {
            this.isPlaying = true;
            if (this.proc) this._sendCtrl('resume');
        }
    }

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
