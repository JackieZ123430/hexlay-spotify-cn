'use strict';
/**
 * test_sys_monitor.js - System Monitor (apps/sys_monitor), no head unit needed; in CI on Node 8 too.
 *
 *  - It is a viewer: its code has no way to end, signal or start a process, write a file or open a
 *    connection, and its manifest asks for no car signals and no internet (the build fails if that changes).
 *  - Its /proc reading against a made-up /proc and app folder: memory (each process's own, the kernel's
 *    counts), kernel threads, names with spaces and parentheses or cut to 15 characters, processes that ended
 *    or can't be read, processor use between samples, grouping and sorting, hidepid, the fallbacks.
 *  - Which app a process is: this app, MainApp, the MGU Store's apps and tools (its records, read again when
 *    they change), app folders where readable, and the rest by uid.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const APP = path.join(__dirname, '..', '..', 'apps', 'sys_monitor');
const P = require(path.join(APP, 'procs'));
const { SampleSampler } = require(path.join(APP, 'sample'));

const KB = 1024, MB = 1024 * KB;

/* ---------------- a viewer, and nothing else ---------------- */
{
    // the app's own code (the kit it runs on is every app's: it keeps the app's settings and log)
    const FORBIDDEN = [
        [/\bchild_process\b/, 'starts programs'],
        [/\bprocess\s*\.\s*kill\b/, 'signals processes'],
        [/\.\s*kill\s*\(/, 'signals processes'],
        // (a RegExp's .exec(text) is reading, not a program: method calls other than that, and bare calls)
        [/(^|[^.\w$])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/, 'starts programs'],
        [/\.\s*(spawn|spawnSync|execSync|execFile|execFileSync|fork)\s*\(/, 'starts programs'],
        [/\bprocess\s*\.\s*(exit|abort|setuid|setgid|seteuid|setegid|setgroups|chdir|umask)\s*\(/, 'changes the process'],
        [/\bfs\s*\.\s*(write|append|unlink|rename|rm|mkdir|mkdtemp|chmod|lchmod|fchmod|chown|lchown|fchown|truncate|ftruncate|copyFile|symlink|link|utimes|futimes|open|createWriteStream)\w*\s*\(/, 'writes files'],
        [/require\(\s*['"](net|http|https|http2|dgram|tls|dns|cluster|worker_threads|vm|inspector)['"]\s*\)/, 'opens connections or runs other code'],
        [/\beval\s*\(|\bnew\s+Function\s*\(/, 'runs other code'],
    ];
    const code = (f) => fs.readFileSync(path.join(APP, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')          // comments may say what it doesn't do
        .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
    // the guard itself: each of these must be caught (by a pattern, or by the allowed modules below)
    const allowedRequire = /require\(\s*['"](fs|os|path|\.\/kit\/(mgu|canvas|gauges)|\.\/(procs|sample))['"]\s*\)/;
    const caught = (src) => FORBIDDEN.some((x) => x[0].test(src)) || (src.match(/require\(\s*['"][^'"]+['"]\s*\)/g) || []).some((r) => !allowedRequire.test(r));
    ["process.kill(pid, 'SIGKILL')", 'process .kill(1)', 'p.kill()', "require('child_process')", "const { exec } = cp; exec('reboot')",
        "cp.execFileSync('kill', ['-9', '1'])", "fs.writeFileSync('/etc/x', 'y')", "fs.unlinkSync('/var/opt/x')", "fs.openSync(f, 'w')",
        "require('https').get(u)", "require('net')", "require('./kit/diag')", "process.setuid(0)", "eval('x')"]
        .forEach((bad) => assert(caught(bad), 'the guard misses: ' + bad));
    ['/^cpu\\s/.exec(line)', "fs.readFileSync(f, 'utf8')", "fs.readdirSync('/proc')", "require('fs')", "require('./procs')"]
        .forEach((ok) => assert(!caught(ok), 'the guard refuses reading: ' + ok));
    const files = fs.readdirSync(APP).filter((f) => /\.js$/.test(f));
    assert.deepStrictEqual(files.sort(), ['main.js', 'procs.js', 'sample.js'], 'a new file: add it here, and check it');
    files.forEach((f) => FORBIDDEN.forEach((x) => assert(!x[0].test(code(f)), f + ' ' + x[1] + ': ' + x[0])));
    // the only modules it loads: the kit, its own, and fs / os / path to read with
    files.forEach((f) => (code(f).match(/require\(\s*['"][^'"]+['"]\s*\)/g) || []).forEach((r) => {
        assert(allowedRequire.test(r), f + ' loads ' + r);
    }));
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    assert(!spec.signals, 'no car signals (SOME/IP)');
    assert(!spec.mguInternet, 'no internet');
    assert(!spec.autostart && !spec.startWidget, 'runs only while opened');
    assert(!spec.config, 'no diagnostic or other config');
}

/* ---------------- a made-up /proc ---------------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmon-'));
const created = [];
function mkdirs(dir) {
    if (fs.existsSync(dir)) return;
    mkdirs(path.dirname(dir));
    fs.mkdirSync(dir);
    created.push(dir);
}
function write(file, text) { mkdirs(path.dirname(file)); fs.writeFileSync(file, text); if (created.indexOf(file) < 0) created.push(file); }
function cleanup() {
    created.slice().reverse().forEach((f) => { try { fs.statSync(f).isDirectory() ? fs.rmdirSync(f) : fs.unlinkSync(f); } catch (e) { /* gone */ } });
    try { fs.rmdirSync(tmp); } catch (e) { /* not empty */ }
}

const proc = path.join(tmp, 'proc'), oap = path.join(tmp, 'oap');
const storeState = path.join(tmp, 'mgu-deploy', 'state.json'), uidsD = path.join(tmp, 'mgu-uplink', 'uids.d');

function status(name, uid, rssKb, extra) {
    extra = extra || {};
    const anon = extra.noAnon ? [] : ['RssAnon:\t' + Math.round(rssKb * 0.75) + ' kB', 'RssFile:\t' + Math.round(rssKb * 0.25) + ' kB', 'RssShmem:\t0 kB'];
    return ['Name:\t' + name, 'State:\tS (sleeping)', 'PPid:\t1', 'Uid:\t' + uid + '\t' + uid + '\t' + uid + '\t' + uid]
        .concat(rssKb == null ? [] : ['VmRSS:\t' + rssKb + ' kB'].concat(anon, ['VmSwap:\t' + (extra.swap || 0) + ' kB']))
        .concat(['Threads:\t' + (extra.threads || 1)]).join('\n') + '\n';
}
function stat(pid, name, ticks, start) {
    // fields: pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime ... starttime(22)
    const f = ['S', '1', pid, pid, '0', '-1', '4194560', '100', '0', '0', '0', String(ticks), '0', '0', '0', '20', '0', '1', '0', String(start)];
    return pid + ' (' + name + ') ' + f.join(' ') + ' 1000 200\n';
}
function proc1(pid, name, uid, rssKb, ticks, extra) {
    extra = extra || {};
    write(path.join(proc, String(pid), 'status'), status(name, uid, rssKb, extra));
    write(path.join(proc, String(pid), 'stat'), stat(pid, name, ticks, 1000));
    write(path.join(proc, String(pid), 'cmdline'), (extra.cmd || name).split(' ').join('\0') + '\0');
    if (extra.statm) write(path.join(proc, String(pid), 'statm'), extra.statm);
}
// the whole processor, and two cores: core 1 does all the work, core 2 idles
function cpuLine(total, idle) {
    return 'cpu  ' + (total - idle) + ' 0 0 ' + idle + ' 0 0 0 0 0 0\ncpu0 ' + (total - idle) + ' 0 0 0 0 0 0 0 0 0\ncpu1 0 0 0 ' + idle + ' 0 0 0 0 0 0\nintr 0\n';
}
function future(file, s) { const t = new Date(Date.now() + s * 1000); fs.utimesSync(file, t, t); }

try {
    write(path.join(proc, 'meminfo'), [
        'MemTotal:        4000000 kB', 'MemFree:          500000 kB', 'MemAvailable:    1500000 kB',
        'Buffers:          100000 kB', 'Cached:           900000 kB', 'Shmem:             50000 kB', 'AnonPages:       1300000 kB',
        'SReclaimable:      50000 kB', 'Slab:              80000 kB', 'KernelStack:        8000 kB',
        'PageTables:        12000 kB', 'SwapTotal:        1000000 kB', 'SwapFree:          900000 kB', 'HugePages_Total:       0',
    ].join('\n') + '\n');
    write(path.join(proc, 'stat'), cpuLine(10000, 8000));
    write(path.join(proc, 'uptime'), '5000.00 18000.00\n');
    write(path.join(proc, 'loadavg'), '1.42 1.31 1.24 2/612 4567\n');
    // the processor's sensors (sysfs): a board zone and the package one; two cores' clocks
    const sys = path.join(tmp, 'sys');
    write(path.join(sys, 'class', 'thermal', 'thermal_zone0', 'type'), 'acpitz\n');
    write(path.join(sys, 'class', 'thermal', 'thermal_zone0', 'temp'), '45000\n');
    write(path.join(sys, 'class', 'thermal', 'thermal_zone1', 'type'), 'x86_pkg_temp\n');
    write(path.join(sys, 'class', 'thermal', 'thermal_zone1', 'temp'), '61000\n');
    ['1800000', '2000000'].forEach((f, i) => {
        write(path.join(sys, 'devices', 'system', 'cpu', 'cpu' + i, 'cpufreq', 'scaling_cur_freq'), f + '\n');
        write(path.join(sys, 'devices', 'system', 'cpu', 'cpu' + i, 'cpufreq', 'cpuinfo_max_freq'), '2400000\n');
    });
    proc1(411, 'node', 0, 20000, 1, { cmd: 'node --max-old-space-size=64 /var/opt/idrive7-renderd/js/foreground_gate.js' });   // a script: by its name
    proc1(412, 'node', 0, 20000, 1, { cmd: 'node /var/opt/mgu-updater/current/js/updater.js' });                              // a Store tool's: its title
    proc1(413, 'node', 0, 20000, 1, { cmd: 'node -e setInterval(()=>0,1000)' });                                                  // nothing to tell: node
    proc1(1, 'systemd', 0, 12000, 50);
    proc1(2, 'kthreadd', 0, null, 0);                                      // kernel thread: no VmRSS
    proc1(300, 'HmiMain3D', 1001, 900000, 4000, { threads: 60, swap: 2048 });
    proc1(301, 'HmiMain3D', 1001, 100000, 100, { threads: 4 });
    proc1(400, 'node', 12230, 150000, 300, { cmd: 'node /var/opt/public/oap/oap_12230/source/javascript/app.js' });
    proc1(401, 'node', 12231, 120000, 200);
    proc1(402, 'node', 12201, 200000, 100);
    proc1(403, 'node', 12298, 60000, 10);                                  // an app whose folder can't be read
    proc1(404, 'node', 1000, 30000, 10);                                   // a node that is no iDrive app
    proc1(405, 'node', 12240, 70000, 10);                                  // this app (its folder can't be read either)
    proc1(406, 'HmiHelper', 12230, 9000, 1);                               // an app's process that isn't node: the app's still
    proc1(407, 'node', 12450, 80000, 10);                                  // the MGU Store, from its records
    proc1(408, 'node', 12299, 40000, 10);                                  // another Store app, from its records
    proc1(409, 'node', 12460, 30000, 10);                                  // the Store's updater (its uplink drop-in)
    proc1(410, 'oldkernel', 0, 8000, 1, { noAnon: true, statm: '9000 2000 500 10 0 1500 0\n' });   // no RssAnon: statm
    proc1(500, 'odd) name (x', 0, 5000, 5);                                // spaces and parentheses in the name
    proc1(501, 'unattended-upgr', 0, 3000, 1, { cmd: '/usr/bin/python3 /usr/bin/unattended-upgrade-shutdown' });   // cut to 15
    mkdirs(path.join(proc, '600'));                                        // ended between the listing and the read (no status)
    // a process this user may not read (Linux, not root: chmod is real there)
    const canDeny = typeof process.getuid === 'function' && process.getuid() !== 0;
    if (canDeny) { proc1(700, 'secret', 0, 1000, 1); fs.chmodSync(path.join(proc, '700', 'status'), 0); }
    write(path.join(oap, 'oap_12230', 'source', 'javascript', 'kit', 'app-spec.json'), JSON.stringify({ id: 'spotify', title: 'Spotify' }));
    write(path.join(oap, 'oap_12231', 'rhmiData', 'application.json'), JSON.stringify({ application: { name: 'Navigation' } }));
    ['oap_12298', 'oap_12240', 'oap_12450', 'oap_12299'].forEach((d) => mkdirs(path.join(oap, d)));
    write(storeState, JSON.stringify({ apps: { robertn_store: { uid: 12450, version: '0.9.1' }, car_vitals: { uid: 12299, version: '1.2.0' }, broken: { uid: 'x' } }, pending_reboot: [] }));
    write(path.join(uidsD, 'mgu-updater'), '12460\n');
    write(path.join(uidsD, 'other'), '# a comment\n12461, 12462\n');

    /* parsers on their own */
    const mi = P.parseMeminfo(fs.readFileSync(path.join(proc, 'meminfo'), 'utf8'));
    assert.strictEqual(mi.total, 4000000 * KB);
    assert.strictEqual(mi.available, 1500000 * KB);
    assert.strictEqual(mi.used, 2500000 * KB);
    assert.strictEqual(mi.cache, (900000 + 100000 + 50000 - 50000) * KB);
    assert.strictEqual(mi.anon, 1300000 * KB);
    assert.strictEqual(mi.swapUsed, 100000 * KB);
    assert.strictEqual(mi.kernel, (80000 + 8000 + 12000) * KB);
    assert.strictEqual(P.parseMeminfo('nothing here'), null);
    // an old kernel without MemAvailable: free + cache
    assert.strictEqual(P.parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nCached: 300 kB\n').available, 400 * KB);
    assert.deepStrictEqual(P.parseStat(stat(500, 'odd) name (x', 77, 1234)), { ticks: 77, start: 1234 });
    assert.strictEqual(P.parseStat('garbage'), null);
    assert.deepStrictEqual(P.parseStatm('9000 2000 500 10 0 1500 0'), { resident: 2000 * 4096, shared: 500 * 4096 });
    assert.strictEqual(P.parseStatm(''), null);
    const pc = P.parseCpu(cpuLine(10000, 8000));
    assert.deepStrictEqual([pc.total, pc.idle, pc.user, pc.ncpu, pc.cores.length, pc.cores[0].total, pc.cores[1].idle], [10000, 8000, 2000, 2, 2, 2000, 8000]);
    const sh = P.cpuShare(P.parseCpu('cpu  100 0 50 800 50 0 0 0'), P.parseCpu('cpu  200 0 100 1600 100 0 0 0'));
    assert.deepStrictEqual([sh.busy, sh.user, sh.system, sh.iowait].map(Math.round), [15, 10, 5, 5], 'iowait is waiting, not busy');
    assert.strictEqual(P.cpuShare(pc, pc), null, 'no time passed');
    assert.deepStrictEqual(P.parseLoadavg('1.42 1.31 1.24 2/612 4567'), { one: 1.42, five: 1.31, fifteen: 1.24, running: 2, threads: 612 });
    assert.strictEqual(P.parseLoadavg(''), null);
    assert.deepStrictEqual(P.pickTemp([{ type: 'acpitz', c: 45 }, { type: 'x86_pkg_temp', c: 61 }]), { c: 61, zone: 'x86_pkg_temp' });
    assert.deepStrictEqual(P.pickTemp([{ type: 'cpu-thermal', c: 55 }, { type: 'soc', c: 58 }, { type: 'battery', c: 70 }]), { c: 58, zone: 'soc' });
    assert.strictEqual(P.pickTemp([{ type: 'acpitz', c: 45 }]), null, 'a board sensor is not the processor\'s');
    assert.strictEqual(P.pickTemp([{ type: 'x86_pkg_temp', c: NaN }]), null, 'unreadable');
    assert.strictEqual(P.scriptName(['node', '/var/opt/idrive7-renderd/js/foreground_gate.js']), 'foreground_gate');
    assert.strictEqual(P.scriptName(['node', '--expose-gc', '/var/opt/mgu-updater/current/js/updater.js']), 'MGU Store updater');
    assert.strictEqual(P.scriptName(['node', '/opt/x/server/index.js']), 'server', 'index.js: its folder');
    assert.strictEqual(P.scriptName(['node', '/var/opt/public/oap/oap_12230/source/javascript/app.js']), 'iDrive app 12230');
    assert.strictEqual(P.scriptName(['python3', '/usr/bin/networkd-dispatcher', '--run-startup-triggers']), 'networkd-dispatcher');
    assert.strictEqual(P.scriptName(['node', '-e', 'setInterval(() => 0, 1000)']), null, 'inline code: nothing to name it by');
    assert.strictEqual(P.scriptName(['node']), null);
    assert.strictEqual(P.cmdline('node\0/a b/app.js\0\0'), 'node /a b/app.js');
    // names the kernel cut to 15 characters: the full one from the command line, only when it starts the same
    assert.strictEqual(P.fullName('unattended-upgr', ['/usr/bin/python3', '/usr/bin/unattended-upgrade-shutdown']), 'unattended-upgrade-shutdown');
    assert.strictEqual(P.fullName('networkd-dispat', ['/usr/bin/networkd-dispatcher']), 'networkd-dispatcher');
    assert.strictEqual(P.fullName('abcdefghijklmno', ['/bin/other']), 'abcdefghijklmno', 'no match: the cut name');
    assert.strictEqual(P.fullName('abcdefghijklmno', []), 'abcdefghijklmno', 'no command line (not readable)');
    assert.strictEqual(P.fullName('HmiMain3D', ['/usr/bin/HmiMain3D-other']), 'HmiMain3D', 'a name under 15 is whole');
    // /proc mounted so that an app sees only its own processes
    assert.strictEqual(P.hidepid('proc /proc proc rw,nosuid,nodev,noexec,relatime,hidepid=2 0 0\n', '/proc'), true);
    assert.strictEqual(P.hidepid('proc /proc proc rw,relatime,hidepid=invisible 0 0\n', '/proc'), true);
    assert.strictEqual(P.hidepid('proc /proc proc rw,relatime,hidepid=0 0 0\n', '/proc'), false);
    assert.strictEqual(P.hidepid('proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n', '/proc'), false);
    assert.strictEqual(P.hidepid('proc /other proc rw,hidepid=2 0 0\n', '/proc'), false);
    const om = P.osMem();
    assert(om.total > 0 && om.used >= 0 && om.used <= om.total && om.approx === true);
    assert.strictEqual(P.title('robertn_store'), 'MGU Store');
    assert.strictEqual(P.title('car_vitals'), 'Car Vitals');
    assert.strictEqual(P.title('mgu-updater'), 'MGU Store updater');
    assert.strictEqual(P.title('x'), 'X');

    /* first sample: memory, processes, no processor use yet */
    const s = new P.Sampler({ root: proc, oapDir: oap, self: { pid: 405, uid: 12240, title: 'System Monitor' }, storeState, uplinkUids: uidsD, sys });
    assert(s.available());
    const a = s.sample();
    assert.strictEqual(a.mem.total, 4000000 * KB);
    assert.strictEqual(a.cpu, null, 'processor use needs two samples');
    assert.strictEqual(a.ncpu, 2);
    assert.strictEqual(a.restricted, false);
    assert.strictEqual(a.hidden, canDeny ? 1 : 0, 'a process that ended is not "not readable"; one we may not read is');
    const pids = a.procs.map((p) => p.pid).sort((x, y) => x - y);
    assert.deepStrictEqual(pids, [1, 300, 301, 400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 500, 501], 'kernel threads are left out');
    const by = (pid) => a.procs.find((p) => p.pid === pid);
    // what a bare node runs
    assert.strictEqual(by(411).name, 'foreground_gate (node)');
    assert.strictEqual(by(412).name, 'MGU Store updater');
    assert.strictEqual(by(413).name, 'node');
    assert.strictEqual(by(400).app, 'Spotify', 'an app keeps its app name (no script naming)');
    // load, temperature (the package sensor), clock (the cores' average)
    assert.deepStrictEqual(a.load, { one: 1.42, five: 1.31, fifteen: 1.24, running: 2, threads: 612 });
    assert.deepStrictEqual(a.temp, { c: 61, zone: 'x86_pkg_temp' });
    assert.deepStrictEqual(a.freq, { hz: 1.9e9, max: 2.4e9 });
    // memory: each process's own (RssAnon); the resident size with its shared files beside it
    assert.strictEqual(by(300).mem, Math.round(900000 * 0.75) * KB);
    assert.strictEqual(by(300).rss, 900000 * KB);
    assert.strictEqual(by(410).mem, (2000 - 500) * 4096, 'a kernel without RssAnon: resident minus shared (statm)');
    assert.strictEqual(by(300).swap, 2048 * KB);
    assert.strictEqual(by(300).threads, 60);
    assert.strictEqual(by(300).cpu, null);
    assert.strictEqual(by(500).name, 'odd) name (x');
    assert.strictEqual(by(501).name, 'unattended-upgrade-shutdown');
    // which app: this app, MainApp, the Store's apps and tools, folders where readable, else the uid
    const who = (pid) => [by(pid).app, by(pid).kind, by(pid).store, by(pid).named];
    assert.deepStrictEqual(who(405), ['System Monitor', 'app', false, true], 'this app names itself');
    assert.deepStrictEqual(who(402), ['MainApp', 'app', false, true]);
    assert.deepStrictEqual(who(407), ['MGU Store', 'app', true, true], 'Store app: from its deploy records');
    assert.deepStrictEqual(who(408), ['Car Vitals', 'app', true, true], 'Store app with no known title: its id tidied');
    assert.deepStrictEqual(who(409), ['MGU Store updater', 'tool', true, true], 'the Store\'s tool: its uplink drop-in');
    assert.deepStrictEqual(who(400), ['Spotify', 'app', false, true], 'readable folder: the kit title');
    assert.deepStrictEqual(who(401), ['Navigation', 'app', false, true], 'readable folder: the RHMI name');
    assert.deepStrictEqual(who(403), ['iDrive app 12298', 'app', false, false], 'unreadable folder, not the Store\'s: its uid');
    assert.deepStrictEqual(who(404), [null, null, false, null], 'not an iDrive app');
    assert.strictEqual(by(406).app, 'Spotify', 'an app is told by its uid, whatever its process is called');
    assert.strictEqual(by(405).self, true);
    assert.strictEqual(Math.round(by(1).age), 5000 - 10, 'started 1000 ticks (10 s) after boot');
    assert.strictEqual(s.command(400), 'node /var/opt/public/oap/oap_12230/source/javascript/app.js');

    /* second sample: processor use since the first (share of all cores); the Store installed an app meanwhile */
    write(path.join(proc, 'stat'), cpuLine(12000, 9000));                 // 2000 ticks, 1000 idle: 50 % busy
    write(path.join(proc, '300', 'stat'), stat(300, 'HmiMain3D', 4500, 1000));   // +500 of 2000: 25 %
    write(storeState, JSON.stringify({ apps: { robertn_store: { uid: 12450 }, car_vitals: { uid: 12299 }, m_copilot: { uid: 12298 } } }));
    future(storeState, 5);
    const b = s.sample();
    assert.strictEqual(Math.round(b.cpu.busy), 50);
    assert.deepStrictEqual(b.cpu.cores.map(Math.round), [100, 0], 'core 1 did all of it');
    assert.deepStrictEqual([b.cpu.user, b.cpu.system, b.cpu.iowait].map(Math.round), [50, 0, 0]);
    assert.strictEqual(Math.round(b.procs.find((p) => p.pid === 300).cpu), 25);
    assert.strictEqual(b.procs.find((p) => p.pid === 1).cpu, 0);
    assert.strictEqual(b.procs.find((p) => p.pid === 403).app, 'M-Copilot', 'the Store\'s records are read again when they change');

    /* grouping: an app's processes (or a program's) added up */
    const g = P.group(b.procs, true);
    const hmi = g.find((r) => r.label === 'HmiMain3D');
    assert.strictEqual(hmi.count, 2);
    assert.strictEqual(hmi.mem, (Math.round(900000 * 0.75) + Math.round(100000 * 0.75)) * KB);
    assert.strictEqual(hmi.rss, 1000000 * KB);
    assert.strictEqual(Math.round(hmi.cpu), 25);
    assert.deepStrictEqual(hmi.pids.sort(), [300, 301]);
    assert.strictEqual(g.find((r) => r.label === 'System Monitor').self, true);
    assert.strictEqual(g.find((r) => r.label === 'Spotify').count, 2, 'node and its helper: one app');
    assert.strictEqual(g.find((r) => r.label === 'MGU Store').store, true);
    assert.strictEqual(g.find((r) => r.key === 'name:node').count, 2, 'the nodes that are no app and run nothing nameable: one row');
    assert(g.find((r) => r.key === 'name:foreground_gate (node)'), 'a named script: its own row');
    assert.strictEqual(P.group(b.procs, false).length, b.procs.length);
    assert.deepStrictEqual(P.sortRows(g, 'mem').slice(0, 3).map((r) => r.label), ['HmiMain3D', 'MainApp', 'Spotify']);
    assert.strictEqual(P.sortRows(g, 'cpu')[0].label, 'HmiMain3D');
    assert.strictEqual(P.sortRows(g, 'name')[0].label, 'Car Vitals');
    g.forEach((r) => { r.grow = r.label === 'MGU Store' ? 30 * MB : r.label === 'Spotify' ? -2 * MB : null; });
    assert.deepStrictEqual(P.sortRows(g, 'grow').slice(0, 2).map((r) => r.label), ['MGU Store', 'Spotify'], 'growth: most first, unknown last');
    // where the memory in use goes: apps (the Store's tools are programs), other programs, the rest
    const parts = P.breakdown(b);
    const own = (f) => b.procs.filter(f).reduce((x, p) => x + p.mem, 0);
    assert.strictEqual(parts.apps, own((p) => p.kind === 'app'));
    assert.strictEqual(parts.programs, own((p) => p.kind !== 'app'));
    assert.strictEqual(parts.apps + parts.programs + parts.system, b.mem.used);

    /* the head unit shows an app only its own processes: said, not shown as a near-empty head unit */
    const lonely = path.join(tmp, 'own');
    write(path.join(lonely, 'meminfo'), 'MemTotal: 4000000 kB\nMemAvailable: 1000000 kB\n');
    write(path.join(lonely, '42', 'status'), status('node', 12240, 50000));
    write(path.join(lonely, '42', 'stat'), stat(42, 'node', 1, 1));
    const lone = new P.Sampler({ root: lonely, oapDir: null, storeState: null, uplinkUids: null, self: { pid: 42, uid: 12240, title: 'System Monitor' } }).sample();
    assert.strictEqual(lone.restricted, true);
    assert.strictEqual(lone.procs.length, 1);
    // ...but not when this runs as root (a PC, a test): everything there may be root's
    assert.strictEqual(new P.Sampler({ root: lonely, oapDir: null, storeState: null, uplinkUids: null, self: { pid: 42, uid: 0 } }).sample().restricted, false);
    // no /proc/meminfo to read: Node's totals, marked approximate
    const nomem = path.join(tmp, 'nomem');
    write(path.join(nomem, '42', 'status'), status('node', 12240, 50000));
    const approx = new P.Sampler({ root: nomem, oapDir: null, storeState: null, uplinkUids: null, self: { pid: 42, uid: 0 } }).sample();
    assert.strictEqual(approx.mem.approx, true);
    assert.strictEqual(approx.procs.length, 1);
    // the Store not installed (no records): nothing breaks, apps by uid
    const noStore = new P.Sampler({ root: proc, oapDir: oap, storeState: path.join(tmp, 'none.json'), uplinkUids: path.join(tmp, 'none.d'), self: { pid: 405, uid: 12240, title: 'System Monitor' } }).sample();
    assert.strictEqual(noStore.procs.find((p) => p.pid === 407).app, 'iDrive app 12450');

    /* formatting */
    assert.strictEqual(P.fmtBytes(3.8 * 1024 * MB), '3.80 GB');
    assert.strictEqual(P.fmtBytes(612 * MB), '612 MB');
    assert.strictEqual(P.fmtBytes(12.3 * MB), '12.3 MB');
    assert.strictEqual(P.fmtBytes(-12.3 * MB), '-12.3 MB');
    assert.strictEqual(P.fmtBytes(880 * KB), '880 KB');
    assert.strictEqual(P.fmtBytes(null), '--');
    assert.strictEqual(P.fmtAge(3 * 86400 + 4 * 3600), '3 d 4 h');
    assert.strictEqual(P.fmtAge(2 * 3600 + 13 * 60), '2 h 13 min');
    assert.strictEqual(P.fmtAge(40), '40 s');

    /* no /proc at all (a Windows PC): the app falls back to sample data */
    const none = new P.Sampler({ root: path.join(tmp, 'missing'), oapDir: null, storeState: null, uplinkUids: null });
    assert.strictEqual(none.available(), false);
    const empty = none.sample();
    assert.deepStrictEqual(empty.procs, []);
    assert.strictEqual(empty.restricted, false);
    const demo = new SampleSampler().sample();
    assert.strictEqual(demo.sample, true);
    assert(demo.mem.used < demo.mem.total && demo.procs.length > 10);
    assert(demo.procs.some((p) => p.self), 'the sample marks this app');
    assert(demo.procs.every((p) => p.mem > 0 && p.mem <= p.rss), 'own memory within the resident size');
    console.log('test_sys_monitor: ok');
} finally {
    cleanup();
}
