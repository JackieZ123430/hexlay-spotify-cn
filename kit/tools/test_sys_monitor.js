'use strict';
/**
 * test_sys_monitor.js - System Monitor's /proc reading (apps/sys_monitor/procs.js) against a made-up /proc
 * and app folder: memory, processes, kernel threads, names with spaces and parentheses, processes that can't
 * be read, iDrive apps named from their install folder, processor use between samples, grouping and sorting.
 * Runs on the head unit's Node 8 (CI), no head unit needed.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require(path.join(__dirname, '..', '..', 'apps', 'sys_monitor', 'procs'));
const { SampleSampler } = require(path.join(__dirname, '..', '..', 'apps', 'sys_monitor', 'sample'));

const KB = 1024, MB = 1024 * KB;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmon-'));
const created = [];
function mkdirs(dir) {
    if (fs.existsSync(dir)) return;
    mkdirs(path.dirname(dir));
    fs.mkdirSync(dir);
    created.push(dir);
}
function write(file, text) { mkdirs(path.dirname(file)); fs.writeFileSync(file, text); created.push(file); }
function cleanup() {
    created.slice().reverse().forEach((f) => { try { fs.statSync(f).isDirectory() ? fs.rmdirSync(f) : fs.unlinkSync(f); } catch (e) { /* gone */ } });
    try { fs.rmdirSync(tmp); } catch (e) { /* not empty */ }
}

const proc = path.join(tmp, 'proc'), oap = path.join(tmp, 'oap');

function status(name, uid, rssKb, extra) {
    return ['Name:\t' + name, 'State:\tS (sleeping)', 'PPid:\t1', 'Uid:\t' + uid + '\t' + uid + '\t' + uid + '\t' + uid]
        .concat(rssKb == null ? [] : ['VmRSS:\t' + rssKb + ' kB', 'RssAnon:\t' + Math.round(rssKb * 0.75) + ' kB', 'RssFile:\t' + Math.round(rssKb * 0.25) + ' kB', 'RssShmem:\t0 kB', 'VmSwap:\t' + ((extra && extra.swap) || 0) + ' kB'])
        .concat(['Threads:\t' + ((extra && extra.threads) || 1)]).join('\n') + '\n';
}
function stat(pid, name, ticks, start) {
    // fields: pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime ... starttime(22)
    const f = ['S', '1', pid, pid, '0', '-1', '4194560', '100', '0', '0', '0', String(ticks), '0', '0', '0', '20', '0', '1', '0', String(start)];
    return pid + ' (' + name + ') ' + f.join(' ') + ' 1000 200\n';
}
function proc1(pid, name, uid, rssKb, ticks, extra) {
    write(path.join(proc, String(pid), 'status'), status(name, uid, rssKb, extra));
    write(path.join(proc, String(pid), 'stat'), stat(pid, name, ticks, 1000));
    write(path.join(proc, String(pid), 'cmdline'), (extra && extra.cmd || name).split(' ').join('\0') + '\0');
}
function cpuLine(total, idle) { return 'cpu  ' + (total - idle) + ' 0 0 ' + idle + ' 0 0 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0 0 0\ncpu1 1 0 0 1 0 0 0 0 0 0\nintr 0\n'; }

try {
    write(path.join(proc, 'meminfo'), [
        'MemTotal:        4000000 kB', 'MemFree:          500000 kB', 'MemAvailable:    1500000 kB',
        'Buffers:          100000 kB', 'Cached:           900000 kB', 'Shmem:             50000 kB',
        'SReclaimable:      50000 kB', 'Slab:              80000 kB', 'KernelStack:        8000 kB',
        'PageTables:        12000 kB', 'SwapTotal:        1000000 kB', 'SwapFree:          900000 kB', 'HugePages_Total:       0',
    ].join('\n') + '\n');
    write(path.join(proc, 'stat'), cpuLine(10000, 8000));
    write(path.join(proc, 'uptime'), '5000.00 18000.00\n');
    proc1(1, 'systemd', 0, 12000, 50);
    proc1(2, 'kthreadd', 0, null, 0);                                      // kernel thread: no VmRSS
    proc1(300, 'HmiMain3D', 1001, 900000, 4000, { threads: 60, swap: 2048 });
    proc1(301, 'HmiMain3D', 1001, 100000, 100, { threads: 4 });
    proc1(400, 'node', 12230, 150000, 300, { cmd: 'node /var/opt/public/oap/oap_12230/source/javascript/app.js' });
    proc1(401, 'node', 12231, 120000, 200);
    proc1(402, 'node', 12201, 200000, 100);
    proc1(403, 'node', 12299, 60000, 10);                                  // installed, no names
    proc1(404, 'node', 1000, 30000, 10);                                   // a node that is no iDrive app
    proc1(405, 'node', 12240, 70000, 10);                                  // this app (its folder can't be read either)
    proc1(406, 'HmiHelper', 12230, 9000, 1);                               // an app's process that isn't node: the app's still
    proc1(500, 'odd) name (x', 0, 5000, 5);                                // spaces and parentheses in the name
    proc1(501, 'unattended-upgr', 0, 3000, 1, { cmd: '/usr/bin/python3 /usr/bin/unattended-upgrade-shutdown' });   // cut to 15
    mkdirs(path.join(proc, '600'));                                        // ended between the listing and the read (no status)
    // a process this user may not read (Linux, not root: chmod is real there)
    const canDeny = typeof process.getuid === 'function' && process.getuid() !== 0;
    if (canDeny) { proc1(700, 'secret', 0, 1000, 1); fs.chmodSync(path.join(proc, '700', 'status'), 0); }
    write(path.join(oap, 'oap_12230', 'source', 'javascript', 'kit', 'app-spec.json'), JSON.stringify({ id: 'spotify', title: 'Spotify' }));
    write(path.join(oap, 'oap_12231', 'rhmiData', 'application.json'), JSON.stringify({ application: { name: 'Navigation' } }));
    mkdirs(path.join(oap, 'oap_12299'));
    mkdirs(path.join(oap, 'oap_12240'));

    // parsers on their own
    const mi = P.parseMeminfo(fs.readFileSync(path.join(proc, 'meminfo'), 'utf8'));
    assert.strictEqual(mi.total, 4000000 * KB);
    assert.strictEqual(mi.available, 1500000 * KB);
    assert.strictEqual(mi.used, 2500000 * KB);
    assert.strictEqual(mi.cache, (900000 + 100000 + 50000 - 50000) * KB);
    assert.strictEqual(mi.swapUsed, 100000 * KB);
    assert.strictEqual(mi.kernel, (80000 + 8000 + 12000) * KB);
    assert.strictEqual(P.parseMeminfo('nothing here'), null);
    // an old kernel without MemAvailable: free + cache
    assert.strictEqual(P.parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nCached: 300 kB\n').available, 400 * KB);
    const odd = P.parseStat(stat(500, 'odd) name (x', 77, 1234));
    assert.deepStrictEqual(odd, { ticks: 77, start: 1234 });
    assert.strictEqual(P.parseStat('garbage'), null);
    assert.deepStrictEqual(P.parseCpu(cpuLine(10000, 8000)), { total: 10000, idle: 8000, ncpu: 2 });
    assert.strictEqual(P.cmdline('node\0/a b/app.js\0\0'), 'node /a b/app.js');
    // names the kernel cut to 15 characters: the full one from the command line, only when it starts the same
    assert.strictEqual(P.fullName('unattended-upgr', ['/usr/bin/python3', '/usr/bin/unattended-upgrade-shutdown']), 'unattended-upgrade-shutdown');
    assert.strictEqual(P.fullName('networkd-dispat', ['/usr/bin/networkd-dispatcher']), 'networkd-dispatcher');
    assert.strictEqual(P.fullName('abcdefghijklmno', ['/bin/other']), 'abcdefghijklmno', 'no match: the cut name');
    assert.strictEqual(P.fullName('abcdefghijklmno', []), 'abcdefghijklmno', 'no command line (a kernel thread, not readable)');
    assert.strictEqual(P.fullName('HmiMain3D', ['/usr/bin/HmiMain3D-other']), 'HmiMain3D', 'a name under 15 is whole');
    // /proc mounted so that an app sees only its own processes
    assert.strictEqual(P.hidepid('proc /proc proc rw,nosuid,nodev,noexec,relatime,hidepid=2 0 0\n', '/proc'), true);
    assert.strictEqual(P.hidepid('proc /proc proc rw,relatime,hidepid=invisible 0 0\n', '/proc'), true);
    assert.strictEqual(P.hidepid('proc /proc proc rw,relatime,hidepid=0 0 0\n', '/proc'), false);
    assert.strictEqual(P.hidepid('proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n', '/proc'), false);
    assert.strictEqual(P.hidepid('proc /other proc rw,hidepid=2 0 0\n', '/proc'), false);
    const om = P.osMem();
    assert(om.total > 0 && om.used >= 0 && om.used <= om.total && om.approx === true);

    // first sample: memory, processes, no processor use yet
    const s = new P.Sampler({ root: proc, oapDir: oap, self: { pid: 405, uid: 12240, title: 'System Monitor' } });
    assert(s.available());
    const a = s.sample();
    assert.strictEqual(a.mem.total, 4000000 * KB);
    assert.strictEqual(a.cpu, null, 'processor use needs two samples');
    assert.strictEqual(a.ncpu, 2);
    assert.strictEqual(a.restricted, false);
    assert.strictEqual(a.hidden, canDeny ? 1 : 0, 'a process that ended is not "not readable"; one we may not read is');
    const pids = a.procs.map((p) => p.pid).sort((x, y) => x - y);
    assert.deepStrictEqual(pids, [1, 300, 301, 400, 401, 402, 403, 404, 405, 406, 500, 501], 'kernel threads are left out');
    assert.strictEqual(a.procs.find((p) => p.pid === 501).name, 'unattended-upgrade-shutdown');
    const by = (pid) => a.procs.find((p) => p.pid === pid);
    assert.strictEqual(by(300).rss, 900000 * KB);
    assert.strictEqual(by(300).swap, 2048 * KB);
    assert.strictEqual(by(300).threads, 60);
    assert.strictEqual(by(300).cpu, null);
    assert.strictEqual(by(500).name, 'odd) name (x');
    assert.strictEqual(by(400).app, 'Spotify', 'kit app: its title');
    assert.strictEqual(by(401).app, 'Navigation', 'other app: its RHMI name');
    assert.strictEqual(by(402).app, 'MainApp');
    assert.strictEqual(by(403).app, 'iDrive app 12299', 'installed, its folder not readable: told by its uid');
    assert.strictEqual(by(403).named, false);
    assert.strictEqual(by(400).named, true);
    assert.strictEqual(by(404).app, null, 'not an iDrive app');
    assert.strictEqual(by(405).app, 'System Monitor', 'this app names itself');
    assert.strictEqual(by(405).self, true);
    assert.strictEqual(by(406).app, 'Spotify', 'an app is told by its uid, whatever its process is called');
    assert.strictEqual(Math.round(by(1).age), 5000 - 10, 'started 1000 ticks (10 s) after boot');
    assert.strictEqual(s.command(400), 'node /var/opt/public/oap/oap_12230/source/javascript/app.js');

    // second sample: processor use since the first (share of all cores)
    write(path.join(proc, 'stat'), cpuLine(12000, 9000));                 // 2000 ticks, 1000 idle: 50 % busy
    write(path.join(proc, '300', 'stat'), stat(300, 'HmiMain3D', 4500, 1000));   // +500 of 2000: 25 %
    const b = s.sample();
    assert.strictEqual(Math.round(b.cpu.busy), 50);
    assert.strictEqual(Math.round(b.procs.find((p) => p.pid === 300).cpu), 25);
    assert.strictEqual(b.procs.find((p) => p.pid === 1).cpu, 0);

    // grouping: an app's processes (or a program's) added up
    const g = P.group(b.procs, true);
    const hmi = g.find((r) => r.label === 'HmiMain3D');
    assert.strictEqual(hmi.count, 2);
    assert.strictEqual(hmi.rss, 1000000 * KB);
    assert.strictEqual(Math.round(hmi.cpu), 25);
    assert.deepStrictEqual(hmi.pids.sort(), [300, 301]);
    assert.strictEqual(g.find((r) => r.label === 'System Monitor').self, true);
    assert.strictEqual(g.find((r) => r.label === 'Spotify').count, 2, 'node and its helper: one app');
    assert.strictEqual(g.find((r) => r.key === 'name:node').count, 1, 'the non-app node stays its own row');
    assert.strictEqual(P.group(b.procs, false).length, b.procs.length);
    assert.deepStrictEqual(P.sortRows(g, 'mem').slice(0, 3).map((r) => r.label), ['HmiMain3D', 'MainApp', 'Spotify']);
    assert.strictEqual(P.sortRows(g, 'cpu')[0].label, 'HmiMain3D');
    assert.strictEqual(P.sortRows(g, 'name')[0].label, 'HmiMain3D');

    // the head unit shows an app only its own processes: said, not shown as a near-empty head unit
    const own = path.join(tmp, 'own');
    write(path.join(own, 'meminfo'), 'MemTotal: 4000000 kB\nMemAvailable: 1000000 kB\n');
    write(path.join(own, '42', 'status'), status('node', 12240, 50000));
    write(path.join(own, '42', 'stat'), stat(42, 'node', 1, 1));
    const lone = new P.Sampler({ root: own, oapDir: null, self: { pid: 42, uid: 12240, title: 'System Monitor' } }).sample();
    assert.strictEqual(lone.restricted, true);
    assert.strictEqual(lone.procs.length, 1);
    // ...but not when this runs as root (a PC, a test): everything there may be root's
    assert.strictEqual(new P.Sampler({ root: own, oapDir: null, self: { pid: 42, uid: 0 } }).sample().restricted, false);
    // no /proc/meminfo to read: Node's totals, marked approximate
    const nomem = path.join(tmp, 'nomem');
    write(path.join(nomem, '42', 'status'), status('node', 12240, 50000));
    const approx = new P.Sampler({ root: nomem, oapDir: null, self: { pid: 42, uid: 0 } }).sample();
    assert.strictEqual(approx.mem.approx, true);
    assert.strictEqual(approx.procs.length, 1);

    // formatting
    assert.strictEqual(P.fmtBytes(3.8 * 1024 * MB), '3.80 GB');
    assert.strictEqual(P.fmtBytes(612 * MB), '612 MB');
    assert.strictEqual(P.fmtBytes(12.3 * MB), '12.3 MB');
    assert.strictEqual(P.fmtBytes(880 * KB), '880 KB');
    assert.strictEqual(P.fmtBytes(null), '--');
    assert.strictEqual(P.fmtAge(3 * 86400 + 4 * 3600), '3 d 4 h');
    assert.strictEqual(P.fmtAge(2 * 3600 + 13 * 60), '2 h 13 min');
    assert.strictEqual(P.fmtAge(40), '40 s');

    // no /proc at all (a Windows PC): the app falls back to sample data
    const none = new P.Sampler({ root: path.join(tmp, 'missing'), oapDir: null });
    assert.strictEqual(none.available(), false);
    const empty = none.sample();
    assert.deepStrictEqual(empty.procs, []);
    assert.strictEqual(empty.restricted, false);
    const demo = new SampleSampler().sample();
    assert.strictEqual(demo.sample, true);
    assert(demo.mem.used < demo.mem.total && demo.procs.length > 10);
    assert(demo.procs.some((p) => p.self), 'the sample marks this app');
    console.log('test_sys_monitor: ok');
} finally {
    cleanup();
}
