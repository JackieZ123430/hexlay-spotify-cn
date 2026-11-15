'use strict';
/**
 * sample.js - made-up head unit processes for a computer without Linux /proc (the browser emulator and preview
 * on Windows). The app says it shows sample data whenever it does. Same snapshot shape as procs.js Sampler, and
 * named as on the car: MainApp and this app by name, the other apps by uid (their folders can't be read there).
 */
const MB = 1024 * 1024;
const OAP = '/var/opt/public/oap/';

// [name, uid, MB, cpu % (a little wobble is added), threads, app, command line]
const LIST = [
    ['HmiMain3D', 1001, 1180, 9, 64, null, '/usr/bin/HmiMain3D'],
    ['node', 12201, 236, 1.5, 11, 'MainApp', 'node ' + OAP + 'oap_12201/source/javascript/app.js'],
    ['node', 12230, 148, 2.2, 11, 'iDrive app 12230', 'node --expose-gc ' + OAP + 'oap_12230/source/javascript/app.js'],
    ['node', 12231, 131, 0.6, 11, 'iDrive app 12231', 'node --expose-gc ' + OAP + 'oap_12231/source/javascript/app.js'],
    ['node', 12232, 64, 0.8, 10, 'System Monitor', 'node --expose-gc ' + OAP + 'oap_12232/source/javascript/app.js'],
    ['mgu-render', 0, 92, 3.1, 6, null, '/usr/bin/mgu-render'],
    ['oapcontroller', 0, 58, 0.3, 14, null, '/usr/bin/oapcontroller'],
    ['pulseaudio', 1002, 44, 1.2, 5, null, '/usr/bin/pulseaudio --system'],
    ['systemd-journald', 0, 38, 0.2, 1, null, '/lib/systemd/systemd-journald'],
    ['bluetoothd', 0, 22, 0.1, 2, null, '/usr/libexec/bluetooth/bluetoothd'],
    ['connmand', 0, 14, 0.1, 1, null, '/usr/sbin/connmand -n'],
    ['wpa_supplicant', 0, 11, 0, 1, null, '/usr/sbin/wpa_supplicant -u'],
    ['dbus-daemon', 1003, 9, 0.2, 1, null, '/usr/bin/dbus-daemon --system'],
    ['systemd', 0, 12, 0.1, 1, null, '/sbin/init'],
    ['systemd-udevd', 0, 7, 0, 1, null, '/lib/systemd/systemd-udevd'],
    ['sshd', 0, 6, 0, 1, null, '/usr/sbin/sshd -D'],
];
// HmiMain3D's helpers, and several node workers of one app (grouping adds them up)
const EXTRA = [
    ['HmiMain3D', 1001, 210, 1.1, 12, null, '/usr/bin/HmiMain3D --worker'],
    ['pulseaudio', 1002, 8, 0, 2, null, '/usr/bin/pulseaudio --system --helper'],
];

class SampleSampler {
    constructor() {
        this.t0 = Date.now();
        this.boot = 3 * 3600 + 17 * 60;     // up for 3 h 17 min when the app opens
    }
    available() { return true; }
    sample() {
        const t = (Date.now() - this.t0) / 1000;
        const wob = (i, a) => Math.sin(t / 7 + i * 1.7) * a;
        const procs = LIST.concat(EXTRA).map((p, i) => {
            const rss = Math.round((p[2] + wob(i, p[2] * 0.02)) * MB);
            return {
                pid: 300 + i * 37, name: p[0], state: i === 0 ? 'R' : 'S', ppid: 1, uid: p[1],
                rss, anon: Math.round(rss * 0.7), file: Math.round(rss * 0.25), shm: Math.round(rss * 0.05),
                swap: i === 0 ? 24 * MB : 0, threads: p[4],
                cpu: t < 1 ? null : Math.max(0, p[3] + wob(i + 3, p[3] * 0.5)),
                app: p[5], named: p[5] ? !/^iDrive app /.test(p[5]) : null, self: p[5] === 'System Monitor', age: this.boot + t - (p[5] && p[5] !== 'MainApp' ? 900 + i * 60 : 20),
            };
        });
        const total = 6 * 1024 * MB;
        const used = procs.reduce((a, p) => a + p.rss, 0) + 610 * MB + Math.round(wob(9, 40) * MB);
        const available = total - used;
        return {
            at: Date.now(),
            sample: true,
            mem: { total, available, used, free: Math.round(available * 0.35), cache: Math.round(available * 0.6), shmem: 96 * MB, kernel: 180 * MB, swapTotal: 1024 * MB, swapUsed: 24 * MB },
            cpu: t < 1 ? null : { busy: Math.max(0, 24 + wob(20, 8)), ncpu: 4 },
            ncpu: 4,
            procs,
            hidden: 0,
            uptime: this.boot + t,
        };
    }
    command(pid) {
        const i = (pid - 300) / 37, p = LIST.concat(EXTRA)[i];
        return p ? p[6] : '';
    }
}

module.exports = { SampleSampler };
