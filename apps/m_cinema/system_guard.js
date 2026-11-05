'use strict';
/**
 * system_guard.js - keeps video playback from overheating or starving the head unit.
 *
 * Every POLL_MS it reads the hottest CPU/SoC thermal zone (/sys/class/thermal) and the free RAM
 * (/proc/meminfo MemAvailable) and reports a level:
 *   ok        - play freely
 *   hot       - pause and refuse to start/resume, until it cools to RESUME_C
 *   critical  - stop the video engine and free its memory
 * Low memory works the same way: below LOW_MEM_MB = hot, below CRITICAL_MEM_MB = critical.
 * Without readable sensors (emulator, PC) the guard reports ok and says so in the log.
 */
const fs = require('fs');
const path = require('path');

const POLL_MS = 3000;
const HOT_C = 85;            // pause video, refuse to play
const RESUME_C = 78;         // hysteresis: play again below this
const CRITICAL_C = 92;       // stop the engine
const LOW_MEM_MB = 150;      // refuse to start / pause
const RESUME_MEM_MB = 200;
const CRITICAL_MEM_MB = 80;  // stop the engine
const LOG_EVERY_MS = 60000;
// zones that measure the CPU / SoC (others, like a battery or a modem, are ignored when present)
const CPU_ZONE = /x86_pkg|cpu|soc|core|pch|acpitz|tcpu|package/i;

class SystemGuard {
    constructor(log, opts) {
        this.log = log || console;
        this.opts = opts || {};
        this.thermalDir = this.opts.thermalDir || '/sys/class/thermal';
        this.meminfo = this.opts.meminfo || '/proc/meminfo';
        this.level = 'ok';
        this.reason = '';
        this.tempC = null;
        this.memMb = null;
        this.listeners = [];
        this.timer = null;
        this.lastLog = 0;
        this.zones = null;
    }

    _findZones() {
        const zones = [];
        try {
            for (const d of fs.readdirSync(this.thermalDir)) {
                if (!/^thermal_zone\d+$/.test(d)) continue;
                let type = '';
                try { type = fs.readFileSync(path.join(this.thermalDir, d, 'type'), 'utf8').trim(); } catch (e) {}
                zones.push({ file: path.join(this.thermalDir, d, 'temp'), type: type });
            }
        } catch (e) {}
        const cpu = zones.filter((z) => CPU_ZONE.test(z.type));
        return cpu.length ? cpu : zones;
    }

    readTempC() {
        if (!this.zones) {
            this.zones = this._findZones();
            this.log.info('[M-Cinema:Guard] Thermal zones: ' + (this.zones.length ? this.zones.map((z) => z.type || '?').join(', ') : 'none readable'));
        }
        let max = null;
        for (const z of this.zones) {
            try {
                const v = parseInt(fs.readFileSync(z.file, 'utf8'), 10);
                if (!isFinite(v)) continue;
                const c = v > 1000 ? v / 1000 : v;          // millidegrees on Linux
                if (c > -40 && c < 150 && (max === null || c > max)) max = c;
            } catch (e) {}
        }
        return max;
    }

    readMemMb() {
        try {
            const m = /MemAvailable:\s+(\d+)\s*kB/.exec(fs.readFileSync(this.meminfo, 'utf8'));
            return m ? Math.round(parseInt(m[1], 10) / 1024) : null;
        } catch (e) {
            return null;
        }
    }

    /** Recompute the level from fresh readings; returns { level, reason }. */
    check() {
        const t = this.readTempC();
        const m = this.readMemMb();
        this.tempC = t;
        this.memMb = m;
        const wasHot = this.level !== 'ok';
        let level = 'ok', reason = '';
        if (t !== null && t >= CRITICAL_C) { level = 'critical'; reason = `head unit at ${Math.round(t)}°C`; }
        else if (m !== null && m < CRITICAL_MEM_MB) { level = 'critical'; reason = `only ${m} MB memory free`; }
        else if (t !== null && (t >= HOT_C || (wasHot && t >= RESUME_C))) { level = 'hot'; reason = `head unit at ${Math.round(t)}°C`; }
        else if (m !== null && (m < LOW_MEM_MB || (wasHot && m < RESUME_MEM_MB))) { level = 'hot'; reason = `only ${m} MB memory free`; }
        const now = Date.now();
        if (now - this.lastLog > LOG_EVERY_MS) {
            this.lastLog = now;
            this.log.info(`[M-Cinema:Guard] ${t === null ? 'temp n/a' : Math.round(t) + '°C'}, ${m === null ? 'mem n/a' : m + ' MB free'} -> ${level}`);
        }
        if (level !== this.level) {
            this.log.warn(`[M-Cinema:Guard] ${this.level} -> ${level}${reason ? ' (' + reason + ')' : ''}`);
            this.level = level;
            this.reason = reason;
            this.listeners.forEach((fn) => { try { fn(level, reason); } catch (e) { this.log.warn('guard listener: ' + e); } });
        } else {
            this.reason = reason;
        }
        return { level: level, reason: reason };
    }

    /** May a video start (or resume) now? */
    canPlay() { return this.check().level === 'ok'; }

    onChange(fn) { this.listeners.push(fn); }

    start() {
        if (this.timer) return;
        this.check();
        this.timer = setInterval(() => this.check(), this.opts.pollMs || POLL_MS);
    }

    stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }
}

module.exports = { SystemGuard, HOT_C, RESUME_C, CRITICAL_C, LOW_MEM_MB, CRITICAL_MEM_MB };
