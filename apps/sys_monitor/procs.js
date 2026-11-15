'use strict';
/**
 * procs.js - what uses the head unit's memory and processor, read from Linux /proc. Read only: nothing is
 * written, signalled or changed.
 *
 *   const s = new Sampler({ root: '/proc', oapDir: '/var/opt/public/oap', self: { uid, title } });
 *   const snap = s.sample();   // { at, mem, cpu, ncpu, procs, hidden, restricted, uptime }
 *   group(snap.procs, true)    // what each app (or program) uses, its processes added up
 *
 * Every iDrive app (OAP app: BMW's and these) runs as its own user id, installed in <oapDir>/oap_<uid>; its
 * processes are told by that uid. Naming one takes reading its folder, which the installer makes readable to
 * that app and MainApp only (mode 750): from another app that fails, and the app is "iDrive app <uid>". What
 * names it where its folder can be read: the kit's title (source/javascript/kit/app-spec.json, this
 * repository's apps), else its RHMI name (rhmiData/application.json). This app names itself (self.title);
 * oap_12201 is MainApp, the app manager.
 *
 * What the head unit may not let an app see is handled, never guessed: a process whose files can't be read is
 * counted (hidden); /proc mounted with hidepid shows an app only its own processes (restricted); an unreadable
 * /proc/meminfo falls back to Node's totals (mem.approx).
 *
 * Runs on the head unit's Node 8 (8.9.4 on 2019 units): nothing newer than that is used.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const KB = 1024;
// clock ticks a second in /proc/<pid>/stat (USER_HZ: 100 on x86 Linux)
const HZ = 100;
const MAINAPP_UID = 12201;
// the first uid of an app (the installer hands them out downwards from 12299; BMW's own apps are 12201 and up)
const FIRST_APP_UID = 10000;

/** A file's text, or null; err (when given) gets the error's code. */
function readText(file, err) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (err) err.code = e.code; return null; }
}
function readJson(file) {
    const s = readText(file);
    if (s == null || s.length > 256 * KB) return null;
    try { return JSON.parse(s); } catch (e) { return null; }
}

/** /proc/meminfo -> sizes in bytes, or null when it has no MemTotal. */
function parseMeminfo(text) {
    const m = {};
    String(text || '').split('\n').forEach((line) => {
        const r = /^([\w()]+):\s+(\d+)(\s+kB)?/.exec(line);
        if (r) m[r[1]] = Number(r[2]) * (r[3] ? KB : 1);
    });
    if (!m.MemTotal) return null;
    const n = (k) => m[k] || 0;
    const cache = Math.max(0, n('Cached') + n('Buffers') + n('SReclaimable') - n('Shmem'));
    // MemAvailable (kernel 3.14 and later): what can be given to programs without swapping
    const available = Math.min(m.MemTotal, m.MemAvailable != null ? m.MemAvailable : n('MemFree') + cache);
    return {
        total: m.MemTotal,
        available,
        used: Math.max(0, m.MemTotal - available),
        free: n('MemFree'),
        cache,
        shmem: n('Shmem'),
        kernel: n('Slab') + n('KernelStack') + n('PageTables'),
        swapTotal: n('SwapTotal'),
        swapUsed: Math.max(0, n('SwapTotal') - n('SwapFree')),
    };
}

/** Node's totals, when /proc/meminfo can't be read: free memory without the cache, so "used" comes out high. */
function osMem() {
    const total = os.totalmem(), available = Math.min(total, os.freemem());
    if (!(total > 0)) return null;
    return { total, available, used: total - available, free: available, cache: null, shmem: null, kernel: null, swapTotal: 0, swapUsed: 0, approx: true };
}

/** /proc/<pid>/status -> { name, state, ppid, uid, rss, anon, file, shm, swap, threads } (sizes in bytes; rss null for kernel threads). */
function parseStatus(text) {
    const o = { name: '', state: '', ppid: 0, uid: -1, rss: null, anon: null, file: null, shm: null, swap: 0, threads: 0 };
    String(text || '').split('\n').forEach((line) => {
        const i = line.indexOf(':');
        if (i < 0) return;
        const k = line.slice(0, i), v = line.slice(i + 1).trim();
        const kb = () => Number(v.split(/\s+/)[0]) * KB;
        if (k === 'Name') o.name = v;
        else if (k === 'State') o.state = v.charAt(0);
        else if (k === 'PPid') o.ppid = Number(v);
        else if (k === 'Uid') o.uid = Number(v.split(/\s+/)[0]);
        else if (k === 'VmRSS') o.rss = kb();
        else if (k === 'RssAnon') o.anon = kb();
        else if (k === 'RssFile') o.file = kb();
        else if (k === 'RssShmem') o.shm = kb();
        else if (k === 'VmSwap') o.swap = kb();
        else if (k === 'Threads') o.threads = Number(v);
    });
    return o;
}

/** /proc/<pid>/stat -> { ticks (user + system), start (ticks after boot) }, or null. The name may hold spaces and ')'. */
function parseStat(text) {
    const s = String(text || ''), end = s.lastIndexOf(')');
    if (end < 0) return null;
    const f = s.slice(end + 2).split(' ');          // f[0] = field 3 (state)
    const utime = Number(f[11]), stime = Number(f[12]), start = Number(f[19]);
    if (!isFinite(utime) || !isFinite(stime)) return null;
    return { ticks: utime + stime, start: isFinite(start) ? start : null };
}

/** /proc/stat -> { total, idle, ncpu } (ticks since boot, all processors). */
function parseCpu(text) {
    const lines = String(text || '').split('\n');
    const first = lines[0] || '';
    if (!/^cpu\s/.test(first)) return null;
    const v = first.trim().split(/\s+/).slice(1).map(Number);
    // user nice system idle iowait irq softirq steal (guest time is already in user)
    const total = v.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
    const idle = (v[3] || 0) + (v[4] || 0);
    const ncpu = lines.filter((l) => /^cpu\d+\s/.test(l)).length || 1;
    return { total, idle, ncpu };
}

/** The command line's arguments (NUL-separated in /proc/<pid>/cmdline). */
function args(text) {
    const s = String(text || '').replace(/\0+$/, '');
    return s ? s.split('\0') : [];
}
/** The command line as one line. */
function cmdline(text) { return args(text).join(' ').trim(); }

// the kernel keeps a process's name to 15 characters (TASK_COMM_LEN): "unattended-upgr"
const COMM_MAX = 15;
/**
 * The full name of a process whose name the kernel cut: the program (or the script an interpreter runs, its
 * first argument) whose file name starts with the cut name. Else the cut name.
 */
function fullName(comm, argv) {
    if (comm.length !== COMM_MAX) return comm;
    const base = (a) => String(a || '').split('/').pop();
    const hit = [base(argv[0]), base(argv[1])].find((b) => b.length > COMM_MAX && b.indexOf(comm) === 0);
    return hit || comm;
}

/** /proc mounted with hidepid (an app sees only its own processes): from the mount table, for the mount at root. */
function hidepid(mounts, root) {
    return String(mounts || '').split('\n').some((l) => {
        const f = l.split(' ');
        return f[2] === 'proc' && f[1] === root && /(^|,)hidepid=(1|2|invisible|noaccess)(,|$)/.test(f[3] || '');
    });
}

/**
 * uid -> the iDrive app installed as oap_<uid>: { name, named } (named false: the app's folder can't be read, and
 * it is "iDrive app <uid>"), or null for a uid that is no app. Cached: an app keeps its uid while installed.
 */
class AppNames {
    constructor(oapDir, self) {
        this.dir = oapDir;
        this.self = self || {};
        this.cache = new Map();
    }
    get(uid) {
        if (!(uid >= FIRST_APP_UID)) return null;
        if (this.cache.has(uid)) return this.cache.get(uid);
        const v = this._look(uid);
        this.cache.set(uid, v);
        return v;
    }
    _look(uid) {
        if (uid === this.self.uid && this.self.title) return { name: this.self.title, named: true };
        if (uid === MAINAPP_UID) return { name: 'MainApp', named: true };
        if (!this.dir) return null;
        const base = path.join(this.dir, 'oap_' + uid);
        const spec = readJson(path.join(base, 'source', 'javascript', 'kit', 'app-spec.json'));
        if (spec && typeof spec.title === 'string' && spec.title) return { name: spec.title, named: true };
        const desc = readJson(path.join(base, 'rhmiData', 'application.json'));
        const a = desc && desc.application;
        if (a && typeof a.name === 'string' && a.name) return { name: a.name, named: true };
        // (the folder itself can be seen from another app: only what is inside it can't)
        let installed = false;
        try { installed = fs.statSync(base).isDirectory(); } catch (e) { /* no such app */ }
        return installed ? { name: 'iDrive app ' + uid, named: false } : null;
    }
}

/**
 * Samples /proc. CPU use is measured between two samples: the first sample has cpu null for every process.
 * opts: { root ('/proc'), oapDir (where the apps are installed), self: { pid, uid, title } (this app) }
 */
class Sampler {
    constructor(opts) {
        opts = opts || {};
        this.root = opts.root || '/proc';
        const self = opts.self || {};
        this.selfPid = self.pid || process.pid;
        this.selfUid = self.uid != null ? self.uid : (typeof process.getuid === 'function' ? process.getuid() : -1);
        this.names = new AppNames(opts.oapDir === undefined ? '/var/opt/public/oap' : opts.oapDir, { uid: this.selfUid, title: self.title });
        this.prev = null;           // { cpu, ticks: Map pid -> ticks }
        this.cmdCache = new Map();  // pid -> its arguments (they don't change)
        this.mounts = undefined;    // /proc/self/mounts, read once
    }
    /** Linux /proc is here (the head unit; not a Windows PC). */
    available() {
        return fs.existsSync(path.join(this.root, 'self', 'status')) || parseMeminfo(readText(path.join(this.root, 'meminfo'))) !== null;
    }

    sample() {
        const r = this.root;
        const mem = parseMeminfo(readText(path.join(r, 'meminfo'))) || osMem();
        const cpuNow = parseCpu(readText(path.join(r, 'stat')));
        const up = Number(String(readText(path.join(r, 'uptime')) || '').split(' ')[0]) || null;
        let pids = [];
        try { pids = fs.readdirSync(r).filter((n) => /^\d+$/.test(n)).map(Number); } catch (e) { /* no /proc */ }
        const prev = this.prev;
        const dTotal = prev && cpuNow ? cpuNow.total - prev.cpu.total : 0;
        const ticks = new Map();
        const procs = [];
        let hidden = 0;
        pids.forEach((pid) => {
            const err = {};
            const st = readText(path.join(r, String(pid), 'status'), err);
            if (st == null) {
                // ended since the folder was listed (ENOENT, ESRCH): not there. Anything else: not ours to read.
                if (err.code !== 'ENOENT' && err.code !== 'ESRCH') hidden++;
                return;
            }
            const s = parseStatus(st);
            if (s.rss == null) return;                       // a kernel thread (or ended meanwhile): no memory of its own
            const stat = parseStat(readText(path.join(r, String(pid), 'stat')));
            let cpu = null;
            if (stat) {
                ticks.set(pid, stat.ticks);
                const before = prev && prev.ticks.get(pid);
                // share of the whole processor (all cores) between the two samples
                if (before != null && dTotal > 0) cpu = Math.max(0, Math.min(100, (stat.ticks - before) / dTotal * 100));
            }
            const app = this.names.get(s.uid);
            procs.push({
                pid, name: s.name.length === COMM_MAX ? fullName(s.name, this.args(pid)) : s.name, state: s.state, ppid: s.ppid, uid: s.uid,
                rss: s.rss, anon: s.anon, file: s.file, shm: s.shm, swap: s.swap, threads: s.threads,
                cpu, app: app ? app.name : null, named: app ? app.named : null, self: pid === this.selfPid,
                age: stat && stat.start != null && up != null ? Math.max(0, up - stat.start / HZ) : null,
            });
        });
        let cpu = null;
        if (prev && cpuNow && dTotal > 0) cpu = { busy: Math.max(0, Math.min(100, 100 - (cpuNow.idle - prev.cpu.idle) / dTotal * 100)), ncpu: cpuNow.ncpu };
        if (cpuNow) this.prev = { cpu: cpuNow, ticks };
        // forget command lines of processes that ended
        this.cmdCache.forEach((v, pid) => { if (!ticks.has(pid)) this.cmdCache.delete(pid); });
        if (this.mounts === undefined) this.mounts = readText(path.join(r, 'self', 'mounts'));
        // only this app's own processes to be seen (it runs as an app's uid, as on the car): the others are hidden
        const restricted = hidepid(this.mounts, r) || (procs.length > 0 && this.selfUid >= FIRST_APP_UID && procs.every((p) => p.uid === this.selfUid));
        return {
            at: Date.now(), mem, cpu, ncpu: cpuNow ? cpuNow.ncpu : (os.cpus() || []).length || null,
            procs, hidden, restricted, uptime: up,
        };
    }
    /** The process's arguments (cached), [] when they can't be read. */
    args(pid) {
        if (this.cmdCache.has(pid)) return this.cmdCache.get(pid);
        const a = args(readText(path.join(this.root, String(pid), 'cmdline')));
        this.cmdCache.set(pid, a);
        return a;
    }
    /** The process's command line, or '' when it can't be read. */
    command(pid) { return this.args(pid).join(' ').trim(); }
}

/** A row's label: the app's name for an iDrive app's process, else the program's. */
function label(p) { return p.app || p.name || ('PID ' + p.pid); }

/**
 * Processes added up per app / program (byApp), or one row each. Rows:
 * { key, label, count, rss, swap, cpu (null until measured), threads, pids, app, self, procs }
 */
function group(procs, byApp) {
    const rows = new Map();
    procs.forEach((p) => {
        const key = byApp ? (p.app ? 'app:' + p.uid : 'name:' + p.name) : 'pid:' + p.pid;
        let g = rows.get(key);
        if (!g) {
            g = { key, label: label(p), count: 0, rss: 0, swap: 0, cpu: null, threads: 0, pids: [], app: !!p.app, self: false, procs: [] };
            rows.set(key, g);
        }
        g.count++;
        g.rss += p.rss || 0;
        g.swap += p.swap || 0;
        g.threads += p.threads || 0;
        if (p.cpu != null) g.cpu = (g.cpu || 0) + p.cpu;
        g.pids.push(p.pid);
        g.procs.push(p);
        if (p.self) g.self = true;
    });
    return Array.from(rows.values());
}

/** Sort rows: by 'mem' (most first), 'cpu' (most first) or 'name' (A to Z). */
function sortRows(rows, by) {
    const lower = (r) => r.label.toLowerCase();
    const name = (a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0);
    const cmp = by === 'name' ? name
        : by === 'cpu' ? (a, b) => ((b.cpu || 0) - (a.cpu || 0)) || (b.rss - a.rss) || name(a, b)
            : (a, b) => (b.rss - a.rss) || name(a, b);
    return rows.slice().sort(cmp);
}

/** Bytes as the HMI would write them: 3.80 GB, 612 MB, 880 KB. */
function fmtBytes(n) {
    if (n == null || !isFinite(n)) return '--';
    if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 * 1024 ? 1 : 2) + ' GB';
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(n >= 100 * 1024 * 1024 ? 0 : 1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return Math.round(n) + ' B';
}

/** A duration in seconds as "3 d 4 h", "2 h 13 min", "12 min", "40 s". */
function fmtAge(s) {
    if (s == null || !isFinite(s)) return '--';
    s = Math.floor(s);
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d) return d + ' d ' + h + ' h';
    if (h) return h + ' h ' + m + ' min';
    if (m) return m + ' min';
    return s + ' s';
}

module.exports = { Sampler, AppNames, group, sortRows, label, parseMeminfo, parseStatus, parseStat, parseCpu, cmdline, fullName, hidepid, osMem, fmtBytes, fmtAge, HZ };
