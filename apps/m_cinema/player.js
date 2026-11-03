'use strict';
/**
 * player.js - Native Video Engine Controller for M-Cinema (BMW iDrive 7).
 *
 * Spawns and controls the native `mgu-vidplay` engine over IPC FIFOs:
 *   - Video frames decoded directly into /dev/shm/mgu-video-cinema (Protocol 4)
 *   - Control FIFO: sends pause, resume, seek, and stop commands
 *   - Status FIFO: receives live timecode and playback state JSON updates
 *   - Simulator / PC fallback: simulates playback timing if native binary is unavailable
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BIN_CANDIDATES = [
    '/var/opt/mgu-renderd/mgu-vidplay',
    path.join(__dirname, 'bin', 'mgu-vidplay'),
    '/usr/local/bin/mgu-vidplay',
    '/tmp/mgu-vidplay'
];

class VideoPlayer {
    constructor(log, opts) {
        this.log = log || console;
        this.opts = opts || {};
        this.shmPath = this.opts.shmPath || '/dev/shm/mgu-video-cinema';
        this.ctrlPath = '/tmp/mgu-cinema-ctrl.fifo';
        this.statusPath = '/tmp/mgu-cinema-status.fifo';
        this.proc = null;
        this.ctrlFd = -1;
        this.statusStream = null;
        this.activeUrl = null;
        this.isPlaying = false;
        this.currentTimeSec = 0;
        this.totalDurationSec = 0;
        this.simTimer = null;
        this.onProgress = null;
        this.onEnded = null;
    }

    _findBinary() {
        for (const p of BIN_CANDIDATES) {
            try {
                if (fs.existsSync(p) && fs.statSync(p).isFile()) {
                    return p;
                }
            } catch (e) {}
        }
        return null;
    }

    play(streamUrl, durationSec) {
        this.stop();
        this.activeUrl = streamUrl;
        this.totalDurationSec = durationSec || 0;
        this.currentTimeSec = 0;
        this.isPlaying = true;

        const bin = this._findBinary();
        if (!bin) {
            this.log.warn('[M-Cinema:Player] Native mgu-vidplay binary not found on host, using simulation clock');
            this._startSimulation();
            return false;
        }

        try {
            // Setup FIFOs
            try { if (!fs.existsSync(this.ctrlPath)) fs.unlinkSync(this.ctrlPath); } catch (e) {}
            try { if (!fs.existsSync(this.statusPath)) fs.unlinkSync(this.statusPath); } catch (e) {}

            const args = [
                '--shm', this.shmPath,
                '--width', '1280',
                '--height', '720',
                '--fps', '30',
                '--ctrl', this.ctrlPath,
                '--status', this.statusPath,
                streamUrl
            ];

            this.log.info(`[M-Cinema:Player] Spawning native player: ${bin} ${args.join(' ')}`);
            this.proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

            this.proc.stdout.on('data', (d) => {
                this.log.info(`[mgu-vidplay] ${d.toString().trim()}`);
            });
            this.proc.stderr.on('data', (d) => {
                this.log.info(`[mgu-vidplay] ${d.toString().trim()}`);
            });

            this.proc.on('close', (code) => {
                this.log.info(`[M-Cinema:Player] Native player process exited with code ${code}`);
                this.proc = null;
                this.isPlaying = false;
                if (this.onEnded) this.onEnded();
            });

            // Connect status reader after short delay
            setTimeout(() => {
                this._connectStatusFifo();
            }, 300);

            return true;
        } catch (err) {
            this.log.error(`[M-Cinema:Player] Failed to start native player: ${err.message}`);
            this._startSimulation();
            return false;
        }
    }

    _connectStatusFifo() {
        try {
            if (fs.existsSync(this.statusPath)) {
                this.statusStream = fs.createReadStream(this.statusPath, { encoding: 'utf8' });
                let leftover = '';
                this.statusStream.on('data', (chunk) => {
                    const lines = (leftover + chunk).split('\n');
                    leftover = lines.pop();
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const data = JSON.parse(line.trim());
                            if (typeof data.pts === 'number') {
                                this.currentTimeSec = data.pts;
                                if (data.dur > 0) this.totalDurationSec = data.dur;
                                this.isPlaying = !!data.playing;
                                if (this.onProgress) {
                                    this.onProgress(this.currentTimeSec, this.totalDurationSec, this.isPlaying);
                                }
                            }
                        } catch (e) {}
                    }
                });
            }
        } catch (e) {
            this.log.warn(`[M-Cinema:Player] Could not attach status FIFO: ${e.message}`);
        }
    }

    _sendCtrl(cmd) {
        if (!this.proc) return;
        try {
            if (fs.existsSync(this.ctrlPath)) {
                fs.appendFileSync(this.ctrlPath, cmd + '\n');
            }
        } catch (e) {
            this.log.warn(`[M-Cinema:Player] Failed sending command '${cmd}': ${e.message}`);
        }
    }

    pause() {
        this.isPlaying = false;
        if (this.proc) {
            this._sendCtrl('pause');
        }
    }

    resume() {
        this.isPlaying = true;
        if (this.proc) {
            this._sendCtrl('resume');
        }
    }

    seek(sec) {
        this.currentTimeSec = Math.max(0, sec);
        if (this.proc) {
            this._sendCtrl(`seek ${this.currentTimeSec}`);
        }
    }

    stop() {
        this.isPlaying = false;
        if (this.simTimer) {
            clearInterval(this.simTimer);
            this.simTimer = null;
        }
        if (this.statusStream) {
            try { this.statusStream.destroy(); } catch (e) {}
            this.statusStream = null;
        }
        if (this.proc) {
            this._sendCtrl('quit');
            const p = this.proc;
            setTimeout(() => {
                try { if (p && !p.killed) p.kill('SIGKILL'); } catch (e) {}
            }, 500);
            this.proc = null;
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
