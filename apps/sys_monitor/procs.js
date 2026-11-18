'use strict';
/**
 * procs.js - what uses the head unit's memory and processor, read from Linux /proc. A viewer: it only reads
 * files; it never writes one, starts a program, signals or ends a process, or opens a connection
 * (kit/tools/test_sys_monitor.js fails the build if this file or main.js ever does).
 *
 *   const s = new Sampler({ root: '/proc', oapDir: '/var/opt/public/oap', self: { uid, title } });
 *   const snap = s.sample();   // { at, mem, cpu, ncpu, procs, hidden, restricted, uptime }
 *   group(snap.procs, true)    // what each app (or program) uses, its processes added up
 *
 * Memory: a process's own memory (mem) is its private resident memory (RssAnon: its heap, stacks, the
 * buffers it allocated), which is what it adds to the RAM in use. The resident size (rss) also counts the
 * program and library files it maps, shared with every other process that maps them (all the node apps map
 * the same node binary): added up over processes it comes out far above the RAM in use, so it is shown in a
 * row's details only. Kernels before 4.5 have no RssAnon: then resident minus shared (/proc/<pid>/statm).
 *
 * Which app a process is: every iDrive app (OAP app: BMW's, the MGU Store's, these) runs as its own uid,
 * installed in <oapDir>/oap_<uid>. Its name, from what an app may read on the car:
 *   1. this app (self.title); oap_12201 is MainApp, the app manager
 *   2. an app the MGU Store installed: its deploy tool's /var/opt/mgu-deploy/state.json (mode 0644), apps
 *      { <app id>: { uid, version } }, read again when it changes
 *   3. the Store's own tools' uids (the updater's downloads and builds): /var/opt/mgu-uplink/uids.d/<tool>
 *   4. the app's folder, where it can be read (MainApp's rights; not from another app: the installer makes it
 *      750, readable to that app and MainApp only): the kit's title, else the RHMI name
 *   5. else "iDrive app <uid>": BMW's own apps (MainApp keeps their uids in its own folder)
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
const PAGE = 4096;                  // x86 page size (/proc/<pid>/statm counts pages)
// clock ticks a second in /proc/<pid>/stat (USER_HZ: 100 on x86 Linux)
const HZ = 100;
const MAINAPP_UID = 12201;
// the first uid of an app (MainApp hands out 12203..12450; the Store's tools sit above)
const FIRST_APP_UID = 10000;
const STORE_STATE = '/var/opt/mgu-deploy/state.json';
const UPLINK_UIDS = '/var/opt/mgu-uplink/uids.d';
// app and tool ids whose title isn't their id tidied up
const TITLES = {
    robertn_store: 'MGU Store', spotify: 'Spotify', m_copilot: 'M-Copilot', sys_monitor: 'System Monitor',
    'mgu-updater': 'MGU Store updater', 'mgu-uplink': 'MGU Store uplink', 'mgu-render': 'MGU renderer', 'mgu-deploy': 'MGU Store installer',
};

/** A file's text, or null; err (when given) gets the error's code. */
function readText(file, err) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (err) err.code = e.code; return null; }
}
function readJson(file) {
    const s = readText(file);
    if (s == null || s.length > 1024 * KB) return null;
    try { return JSON.parse(s); } catch (e) { return null; }
}
function mtime(file) {
    try { return fs.statSync(file).mtime.getTime(); } catch (e) { return 0; }
}
function list(dir) {
    try { return fs.readdirSync(dir); } catch (e) { return []; }
}

/** An app's or tool's id as a title: the known ones by name, others tidied ("car_vitals" -> "Car Vitals"). */
function title(id) {
    if (Object.prototype.hasOwnProperty.call(TITLES, id)) return TITLES[id];
    return String(id).split(/[_-]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || String(id);
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
        anon: m.AnonPages != null ? m.AnonPages : null,    // all processes' private memory, as the kernel counts it
        kernel: n('Slab') + n('KernelStack') + n('PageTables'),
        swapTotal: n('SwapTotal'),
        swapUsed: Math.max(0, n('SwapTotal') - n('SwapFree')),
    };
}

/** Node's totals, when /proc/meminfo can't be read: free memory without the cache, so "used" comes out high. */
function osMem() {
    const total = os.totalmem(), available = Math.min(total, os.freemem());
    if (!(total > 0)) return null;
    return { total, available, used: total - available, free: available, cache: null, shmem: null, anon: null, kernel: null, swapTotal: 0, swapUsed: 0, approx: true };
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

/** /proc/<pid>/statm -> { resident, shared } in bytes, or null. */
function parseStatm(text) {
    const f = String(text || '').trim().split(/\s+/).map(Number);
    if (f.length < 3 || !isFinite(f[1]) || !isFinite(f[2])) return null;
    return { resident: f[1] * PAGE, shared: f[2] * PAGE };
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

/** One /proc/stat cpu line -> its ticks: { total, idle, user, system, iowait }. */
function cpuTicks(line) {
    const v = line.trim().split(/\s+/).slice(1).map((n) => Number(n) || 0);
    // user nice system idle iowait irq softirq steal (guest time is already in user)
    return {
        total: v.slice(0, 8).reduce((a, b) => a + b, 0),
        idle: (v[3] || 0) + (v[4] || 0),
        user: (v[0] || 0) + (v[1] || 0),
        system: (v[2] || 0) + (v[5] || 0) + (v[6] || 0) + (v[7] || 0),
        iowait: v[4] || 0,
    };
}
/** /proc/stat -> the whole processor's ticks since boot, ncpu, and each core's (cores). */
function parseCpu(text) {
    const lines = String(text || '').split('\n');
    const first = lines[0] || '';
    if (!/^cpu\s/.test(first)) return null;
    const cores = lines.filter((l) => /^cpu\d+\s/.test(l)).map(cpuTicks);
    return Object.assign(cpuTicks(first), { ncpu: cores.length || 1, cores });
}
/** What share of the time between two cpuTicks (a, b) went to each kind, in %: { busy, user, system, iowait }. */
function cpuShare(a, b) {
    const d = b.total - a.total;
    if (!(d > 0)) return null;
    const pc = (k) => Math.max(0, Math.min(100, (b[k] - a[k]) / d * 100));
    return { busy: Math.max(0, Math.min(100, 100 - pc('idle'))), user: pc('user'), system: pc('system'), iowait: pc('iowait') };
}

/** /proc/loadavg -> { one, five, fifteen, running, threads } (load: processes running or waiting to, averaged). */
function parseLoadavg(text) {
    const f = String(text || '').trim().split(/\s+/);
    const l = f.slice(0, 3).map(Number), rt = /^(\d+)\/(\d+)$/.exec(f[3] || '');
    if (l.length < 3 || l.some((n) => !isFinite(n))) return null;
    return { one: l[0], five: l[1], fifteen: l[2], running: rt ? Number(rt[1]) : null, threads: rt ? Number(rt[2]) : null };
}

// sensors that are the processor's (or its SoC's): thermal zone types, hwmon "name:label"
const CPU_SENSOR = /x86_pkg|coretemp|k10temp|package|tctl|tdie|cpu|core|soc|proc|b0d4|tsens/i;
// sensors that are something else (and the ACPI zone that only stands for the others)
const NOT_CPU = /bat|charger|wifi|wlan|iwl|ath\d|nvme|ssd|disk|drive|skin|ambient|int3400|gpu|nouveau|radeon/i;
/**
 * The processor's temperature from the kernel's sensors ([{ type, c }]: thermal zones by their type, hwmon ones as
 * "name:label") -> { c, zone, board }: the package sensor (x86_pkg_temp, coretemp's "Package id") where there is one,
 * else the hottest one named for the processor or its SoC, else the hottest board sensor (acpitz: board true);
 * null when none can be read.
 */
function pickTemp(zones) {
    const ok = zones.filter((z) => isFinite(z.c) && z.c > -40 && z.c < 150 && z.c !== 0 && !NOT_CPU.test(z.type));
    const hottest = (a) => a.sort((x, y) => y.c - x.c)[0];
    const pkg = hottest(ok.filter((z) => /x86_pkg_temp|package id|tctl|tdie/i.test(z.type)));
    if (pkg) return { c: pkg.c, zone: pkg.type, board: false };
    const cpu = hottest(ok.filter((z) => CPU_SENSOR.test(z.type)));
    if (cpu) return { c: cpu.c, zone: cpu.type, board: false };
    const board = hottest(ok);
    return board ? { c: board.c, zone: board.type, board: true } : null;
}
/** A sysfs temperature (millidegrees; a few drivers give degrees) -> °C, NaN when unreadable. */
function sysTemp(text) {
    const s = text == null ? '' : String(text).trim();
    const n = s ? Number(s) : NaN;
    return Math.abs(n) >= 1000 ? n / 1000 : n;
}

// interpreters whose processes are named after the script they run
const INTERP = /^(node|nodejs|python[\d.]*|perl|ruby|lua[\d.]*)$/;
/**
 * The program an interpreter (node, python) runs, from its arguments: a tool of /var/opt/<tool>/ by its title, else
 * the script's name (its folder's for index / app / main). null when none can be told.
 */
function scriptName(argv) {
    const s = argv.slice(1).find((a) => a && a.charAt(0) !== '-' && !/\s/.test(a) && (/\.(js|mjs|cjs|py|pl|rb|lua)$/.test(a) || a.indexOf('/') >= 0));
    if (!s) return null;
    const oap = /\/oap_(\d+)\//.exec(s);
    if (oap) return 'iDrive app ' + oap[1];
    const tool = /^\/var\/opt\/([^/]+)\//.exec(s);
    if (tool && Object.prototype.hasOwnProperty.call(TITLES, tool[1])) return TITLES[tool[1]];
    const parts = s.split('/').filter(Boolean), base = (parts.pop() || '').replace(/\.(js|mjs|cjs|py|pl|rb|lua)$/, '');
    return /^(index|app|main|server|start)$/.test(base) && parts.length ? parts.pop() : base || null;
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
 * uid -> what runs as it: { name, named, kind: 'app' | 'tool', store } (named false: an iDrive app whose name
 * can't be read, "iDrive app <uid>"; store: installed by the MGU Store), or null for a uid that is neither an
 * app nor a Store tool. The Store's records are read again when they change (refresh).
 */
class AppNames {
    constructor(opts) {
        opts = opts || {};
        this.dir = opts.oapDir;
        this.self = opts.self || {};
        this.storeFile = opts.storeState === undefined ? STORE_STATE : opts.storeState;
        this.uidsDir = opts.uplinkUids === undefined ? UPLINK_UIDS : opts.uplinkUids;
        this.cache = new Map();
        this.store = new Map();     // uid -> app id (the Store's deploy tool)
        this.tools = new Map();     // uid -> tool id (the uplink's drop-ins)
        this.sig = null;
    }
    /** Read the Store's records again if they changed since; true when they did. */
    refresh() {
        const files = this.uidsDir ? list(this.uidsDir).filter((n) => !/^\./.test(n)).sort() : [];
        const sig = [this.storeFile ? mtime(this.storeFile) : 0].concat(files.map((n) => n + ':' + mtime(path.join(this.uidsDir, n)))).join('|');
        if (sig === this.sig) return false;
        this.sig = sig;
        this.store = new Map(); this.tools = new Map();
        const st = this.storeFile ? readJson(this.storeFile) : null;
        const apps = st && st.apps && typeof st.apps === 'object' ? st.apps : {};
        Object.keys(apps).forEach((id) => {
            const uid = Number(apps[id] && apps[id].uid);
            if (uid >= FIRST_APP_UID && uid % 1 === 0) this.store.set(uid, id);
        });
        files.forEach((n) => {
            String(readText(path.join(this.uidsDir, n)) || '').split('\n').forEach((l) => {
                l.split('#')[0].split(/[\s,]+/).forEach((s) => {
                    const uid = Number(s);
                    if (s && uid >= FIRST_APP_UID && uid % 1 === 0 && !this.tools.has(uid)) this.tools.set(uid, n);
                });
            });
        });
        this.cache.clear();
        return true;
    }
    get(uid) {
        if (!(uid >= FIRST_APP_UID)) return null;
        if (this.cache.has(uid)) return this.cache.get(uid);
        const v = this._look(uid);
        this.cache.set(uid, v);
        return v;
    }
    _look(uid) {
        const app = (name, named, store) => ({ name, named, kind: 'app', store: !!store });
        if (uid === this.self.uid && this.self.title) return app(this.self.title, true, this.store.has(uid));
        if (uid === MAINAPP_UID) return app('MainApp', true, false);
        if (this.store.has(uid)) return app(title(this.store.get(uid)), true, true);
        if (this.tools.has(uid)) return { name: title(this.tools.get(uid)), named: true, kind: 'tool', store: true };
        if (!this.dir) return null;
        const base = path.join(this.dir, 'oap_' + uid);
        const spec = readJson(path.join(base, 'source', 'javascript', 'kit', 'app-spec.json'));
        if (spec && typeof spec.title === 'string' && spec.title) return app(spec.title, true, false);
        const desc = readJson(path.join(base, 'rhmiData', 'application.json'));
        const a = desc && desc.application;
        if (a && typeof a.name === 'string' && a.name) return app(a.name, true, false);
        // (the folder itself can be seen from another app: only what is inside it can't)
        let installed = false;
        try { installed = fs.statSync(base).isDirectory(); } catch (e) { /* no such app */ }
        return installed ? app('iDrive app ' + uid, false, false) : null;
    }
}

/**
 * Samples /proc. CPU use is measured between two samples: the first sample has cpu null for every process.
 * opts: { root ('/proc'), oapDir (where the apps are installed), self: { pid, uid, title } (this app),
 *         storeState, uplinkUids (the MGU Store's records; null: none) }
 */
class Sampler {
    constructor(opts) {
        opts = opts || {};
        this.root = opts.root || '/proc';
        const self = opts.self || {};
        this.selfPid = self.pid || process.pid;
        this.selfUid = self.uid != null ? self.uid : (typeof process.getuid === 'function' ? process.getuid() : -1);
        this.names = new AppNames({
            oapDir: opts.oapDir === undefined ? '/var/opt/public/oap' : opts.oapDir,
            self: { uid: this.selfUid, title: self.title },
            storeState: opts.storeState, uplinkUids: opts.uplinkUids,
        });
        this.sys = opts.sys === undefined ? '/sys' : opts.sys;
        this.prev = null;           // { cpu, ticks: Map pid -> ticks }
        this.cmdCache = new Map();  // pid -> its arguments (they don't change)
        this.mounts = undefined;    // /proc/self/mounts, read once
        this.sensors = null;        // the thermal zones' and cpufreq files, found once
    }
    /** The files the processor's temperature and clock are in (sysfs; any may be missing or unreadable). */
    _sensors() {
        // (looked for once; again each minute while no temperature sensor was found: a driver may load later)
        if (this.sensors && (this.sensors.zones.length || Date.now() - this.sensors.at < 60000)) return this.sensors;
        const s = { zones: [], freq: [], max: null, at: Date.now() };
        if (this.sys) {
            const tz = path.join(this.sys, 'class', 'thermal');
            list(tz).filter((n) => /^thermal_zone\d+$/.test(n)).forEach((n) => {
                const type = String(readText(path.join(tz, n, 'type')) || '').trim();
                if (type) s.zones.push({ type, file: path.join(tz, n, 'temp') });
            });
            // hwmon: Intel's coretemp (the processor's own sensors) is only here, not among the thermal zones
            const hw = path.join(this.sys, 'class', 'hwmon');
            list(hw).filter((n) => /^hwmon\d+$/.test(n)).forEach((n) => {
                // (older kernels keep a driver's files in its device folder)
                [path.join(hw, n), path.join(hw, n, 'device')].some((d) => {
                    const files = list(d).filter((f) => /^temp\d+_input$/.test(f)).sort();
                    if (!files.length) return false;
                    const name = String(readText(path.join(d, 'name')) || readText(path.join(hw, n, 'name')) || n).trim();
                    files.forEach((f) => {
                        const label = String(readText(path.join(d, f.replace('_input', '_label'))) || '').trim();
                        s.zones.push({ type: name + ':' + (label || f.replace('_input', '')), file: path.join(d, f) });
                    });
                    return true;
                });
            });
            const cpus = path.join(this.sys, 'devices', 'system', 'cpu');
            list(cpus).filter((n) => /^cpu\d+$/.test(n)).forEach((n) => {
                const f = path.join(cpus, n, 'cpufreq');
                if (readText(path.join(f, 'scaling_cur_freq')) != null) s.freq.push(path.join(f, 'scaling_cur_freq'));
                const mx = Number(readText(path.join(f, 'cpuinfo_max_freq')));
                if (mx > 0) s.max = Math.max(s.max || 0, mx * 1000);
            });
        }
        this.sensors = s;
        return s;
    }
    /** The temperature sensors found, each with what it reads now, for the log. */
    sensorList() {
        return this._sensors().zones.map((z) => {
            const c = sysTemp(readText(z.file));
            return z.type + ' ' + (isFinite(c) ? c + ' C' : 'unreadable');
        });
    }
    /** { temp: { c, zone, board } | null, freq: { hz, max } | null } now. */
    _processor() {
        const s = this._sensors();
        const temp = pickTemp(s.zones.map((z) => ({ type: z.type, c: sysTemp(readText(z.file)) })));
        const hz = s.freq.map((f) => Number(readText(f)) * 1000).filter((v) => v > 0);
        return { temp, freq: hz.length ? { hz: hz.reduce((a, b) => a + b, 0) / hz.length, max: s.max } : null };
    }
    /** Linux /proc is here (the head unit; not a Windows PC). */
    available() {
        return fs.existsSync(path.join(this.root, 'self', 'status')) || parseMeminfo(readText(path.join(this.root, 'meminfo'))) !== null;
    }

    sample() {
        const r = this.root;
        this.names.refresh();
        const mem = parseMeminfo(readText(path.join(r, 'meminfo'))) || osMem();
        const cpuNow = parseCpu(readText(path.join(r, 'stat')));
        const up = Number(String(readText(path.join(r, 'uptime')) || '').split(' ')[0]) || null;
        const pids = list(r).filter((n) => /^\d+$/.test(n)).map(Number);
        const prev = this.prev;
        const dTotal = prev && cpuNow ? cpuNow.total - prev.cpu.total : 0;
        const ticks = new Map();
        const procs = [];
        let hidden = 0;
        pids.forEach((pid) => {
            const dir = path.join(r, String(pid)), err = {};
            const st = readText(path.join(dir, 'status'), err);
            if (st == null) {
                // ended since the folder was listed (ENOENT, ESRCH): not there. Anything else: not ours to read.
                if (err.code !== 'ENOENT' && err.code !== 'ESRCH') hidden++;
                return;
            }
            const s = parseStatus(st);
            if (s.rss == null) return;                       // a kernel thread (or ended meanwhile): no memory of its own
            let own = s.anon;
            if (own == null) {                               // a kernel before 4.5: resident minus shared
                const sm = parseStatm(readText(path.join(dir, 'statm')));
                own = sm ? Math.max(0, sm.resident - sm.shared) : s.rss;
            }
            const stat = parseStat(readText(path.join(dir, 'stat')));
            let cpu = null;
            if (stat) {
                ticks.set(pid, stat.ticks);
                const before = prev && prev.ticks.get(pid);
                // share of the whole processor (all cores) between the two samples
                if (before != null && dTotal > 0) cpu = Math.max(0, Math.min(100, (stat.ticks - before) / dTotal * 100));
            }
            const app = this.names.get(s.uid);
            let name = s.name.length === COMM_MAX ? fullName(s.name, this.args(pid)) : s.name;
            // a bare "node" or "python" that is no app: what it runs ("foreground_gate (node)", "MGU Store updater")
            if (!app && INTERP.test(name)) {
                const script = scriptName(this.args(pid));
                // (a tool's or an app's title stands alone; a script's name says what runs it)
                if (script) name = / /.test(script) ? script : script + ' (' + name + ')';
            }
            procs.push({
                pid, name, state: s.state, ppid: s.ppid, uid: s.uid,
                mem: own, rss: s.rss, anon: s.anon, file: s.file, shm: s.shm, swap: s.swap, threads: s.threads, cpu,
                app: app ? app.name : null, named: app ? app.named : null, kind: app ? app.kind : null, store: app ? app.store : false,
                self: pid === this.selfPid,
                age: stat && stat.start != null && up != null ? Math.max(0, up - stat.start / HZ) : null,
            });
        });
        // the whole processor and each core since the last sample
        let cpu = null;
        const share = prev && cpuNow ? cpuShare(prev.cpu, cpuNow) : null;
        if (share) {
            cpu = Object.assign(share, {
                ncpu: cpuNow.ncpu,
                cores: cpuNow.cores.map((c, i) => { const s = prev.cpu.cores[i] && cpuShare(prev.cpu.cores[i], c); return s ? s.busy : null; }),
            });
        }
        if (cpuNow) this.prev = { cpu: cpuNow, ticks };
        // forget command lines of processes that ended
        this.cmdCache.forEach((v, pid) => { if (!ticks.has(pid)) this.cmdCache.delete(pid); });
        if (this.mounts === undefined) this.mounts = readText(path.join(r, 'self', 'mounts'));
        // only this app's own processes to be seen (it runs as an app's uid, as on the car): the others are hidden
        const restricted = hidepid(this.mounts, r) || (procs.length > 0 && this.selfUid >= FIRST_APP_UID && procs.every((p) => p.uid === this.selfUid));
        const pr = this._processor();
        return {
            at: Date.now(), mem, cpu, ncpu: cpuNow ? cpuNow.ncpu : (os.cpus() || []).length || null,
            load: parseLoadavg(readText(path.join(r, 'loadavg'))), temp: pr.temp, freq: pr.freq,
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

/** A row's label: the app's (or Store tool's) name, else the program's. */
function label(p) { return p.app || p.name || ('PID ' + p.pid); }

/**
 * Processes added up per app / program (byApp), or one row each. Rows:
 * { key, label, count, mem (own memory), rss, swap, cpu (null until measured), threads, pids, app, kind, store, self, procs }
 */
function group(procs, byApp) {
    const rows = new Map();
    procs.forEach((p) => {
        const key = byApp ? (p.app ? 'app:' + p.uid : 'name:' + p.name) : 'pid:' + p.pid;
        let g = rows.get(key);
        if (!g) {
            g = { key, label: label(p), count: 0, mem: 0, rss: 0, swap: 0, cpu: null, threads: 0, pids: [], app: !!p.app, kind: p.kind, store: !!p.store, self: false, procs: [] };
            rows.set(key, g);
        }
        g.count++;
        g.mem += p.mem || 0;
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

// what each column sorts by first: names A to Z, numbers the most first
const SORT_FIRST = { name: 'asc', count: 'desc', mem: 'desc', pct: 'desc', grow: 'desc', cpu: 'desc' };
/**
 * Sort rows by a column: 'name', 'count' (processes; a process row's PID), 'mem', 'pct', 'grow' (row.grow, set by
 * the caller) or 'cpu'; dir 'asc' / 'desc' (default: SORT_FIRST's).
 */
function sortRows(rows, by, dir) {
    const lower = (r) => r.label.toLowerCase();
    const name = (a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0);
    if (!SORT_FIRST[by]) by = 'mem';
    const s = (dir || SORT_FIRST[by]) === 'asc' ? 1 : -1;
    if (by === 'name') return rows.slice().sort((a, b) => s * name(a, b));
    // the number sorted by (% of RAM is the memory's share: the same order); a process row's count column is its PID
    const val = by === 'pct' ? (r) => r.mem
        : by === 'count' ? (r) => (r.key.indexOf('pid:') === 0 ? r.pids[0] : r.count)
            : (r) => r[by];
    // (unknown values last either way; then the most memory, then by name)
    return rows.slice().sort((a, b) => {
        const va = val(a), vb = val(b);
        if ((va == null) !== (vb == null)) return va == null ? 1 : -1;
        return (va == null ? 0 : s * (va - vb)) || (b.mem - a.mem) || name(a, b);
    });
}

/**
 * Where the memory in use goes: iDrive apps (their processes' own memory), other programs (theirs), and the
 * rest: the system and what is shared (the kernel, program and library files in memory, shared and graphics
 * buffers). { apps, programs, system }, bytes.
 */
function breakdown(snap) {
    let apps = 0, programs = 0;
    snap.procs.forEach((p) => { if (p.kind === 'app') apps += p.mem || 0; else programs += p.mem || 0; });
    const used = snap.mem ? snap.mem.used : apps + programs;
    return { apps, programs, system: Math.max(0, used - apps - programs) };
}

/** Bytes as the HMI would write them: 3.80 GB, 612 MB, 880 KB. */
function fmtBytes(n) {
    if (n == null || !isFinite(n)) return '--';
    const a = Math.abs(n), sign = n < 0 ? '-' : '';
    if (a >= 1024 * 1024 * 1024) return sign + (a / (1024 * 1024 * 1024)).toFixed(a >= 10 * 1024 * 1024 * 1024 ? 1 : 2) + ' GB';
    if (a >= 1024 * 1024) return sign + (a / (1024 * 1024)).toFixed(a >= 100 * 1024 * 1024 ? 0 : 1) + ' MB';
    if (a >= 1024) return sign + Math.round(a / 1024) + ' KB';
    return sign + Math.round(a) + ' B';
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

module.exports = {
    Sampler, AppNames, group, sortRows, SORT_FIRST, breakdown, label, title, parseMeminfo, parseStatus, parseStatm, parseStat, parseCpu,
    cpuShare, parseLoadavg, pickTemp, sysTemp, scriptName, cmdline, fullName, hidepid, osMem, fmtBytes, fmtAge, HZ, STORE_STATE, UPLINK_UIDS,
};
