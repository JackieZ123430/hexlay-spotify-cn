'use strict';
/**
 * sample.js - made-up head unit processes for a computer without Linux /proc (the browser emulator and preview
 * on Windows). The app says it shows sample data whenever it does. Same snapshot shape as procs.js Sampler, and
 * named as on a car with the MGU Store: MainApp, this app and the Store's apps by name, BMW's own apps by uid
 * (their names can't be read there). One app grows steadily, to show what a memory leak looks like.
 */
const MB = 1024 * 1024;
const OAP = '/var/opt/public/oap/';
const app = (uid) => 'node --expose-gc ' + OAP + 'oap_' + uid + '/source/javascript/app.js';

// [name, uid, own MB, resident MB, cpu %, threads, app name, kind, by the MGU Store, command line, MB it grows a minute]
const LIST = [
    ['HmiMain3D', 1001, 820, 1180, 9, 64, null, null, false, '/usr/bin/HmiMain3D', 0],
    ['HmiMain3D', 1001, 150, 210, 1.1, 12, null, null, false, '/usr/bin/HmiMain3D --worker', 0],
    ['node', 12201, 120, 236, 1.5, 11, 'MainApp', 'app', false, 'node ' + OAP + 'oap_12201/source/javascript/app.js', 0],
    ['node', 12204, 46, 98, 0.4, 11, 'iDrive app 12204', 'app', false, app(12204), 0],
    ['node', 12450, 72, 128, 0.9, 11, 'MGU Store', 'app', true, app(12450), 0],
    ['node', 12449, 88, 148, 2.2, 11, 'Spotify', 'app', true, app(12449), 12],
    ['node', 12448, 69, 131, 0.6, 11, 'M-Copilot', 'app', true, app(12448), 0],
    ['node', 12447, 22, 64, 0.8, 10, 'System Monitor', 'app', true, app(12447), 0],
    ['node', 12460, 31, 78, 0.2, 9, 'MGU Store updater', 'tool', true, 'node /var/opt/mgu-updater/current/js/updater.js', 0],
    ['mgu-render', 0, 61, 92, 3.1, 6, null, null, false, '/var/opt/mgu-render/current/mgu-render', 0],
    ['mgu-uplink', 0, 14, 21, 0.3, 8, null, null, false, '/var/opt/mgu-uplink/current/mgu-uplink', 0],
    ['oapcontroller', 0, 41, 58, 0.3, 14, null, null, false, '/usr/bin/oapcontroller', 0],
    ['pulseaudio', 1002, 30, 44, 1.2, 5, null, null, false, '/usr/bin/pulseaudio --system', 0],
    ['systemd-journald', 0, 24, 38, 0.2, 1, null, null, false, '/lib/systemd/systemd-journald', 0],
    ['bluetoothd', 0, 9, 22, 0.1, 2, null, null, false, '/usr/libexec/bluetooth/bluetoothd', 0],
    ['connmand', 0, 6, 14, 0.1, 1, null, null, false, '/usr/sbin/connmand -n', 0],
    ['wpa_supplicant', 0, 4, 11, 0, 1, null, null, false, '/usr/sbin/wpa_supplicant -u', 0],
    ['dbus-daemon', 1003, 3, 9, 0.2, 1, null, null, false, '/usr/bin/dbus-daemon --system', 0],
    ['systemd', 0, 5, 12, 0.1, 1, null, null, false, '/sbin/init', 0],
    ['sshd', 0, 2, 6, 0, 1, null, null, false, '/usr/sbin/sshd -D', 0],
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
        const procs = LIST.map((p, i) => {
            const grow = p[10] * t / 60 * MB;
            const own = Math.round((p[2] + wob(i, p[2] * 0.01)) * MB + grow);
            const rss = Math.round(p[3] * MB + (own - p[2] * MB));
            return {
                pid: 300 + i * 37, name: p[0], state: i === 0 ? 'R' : 'S', ppid: 1, uid: p[1],
                mem: own, rss, anon: own, file: Math.max(0, rss - own), shm: Math.round(rss * 0.03),
                swap: i === 0 ? 24 * MB : 0, threads: p[5],
                cpu: t < 1 ? null : Math.max(0, p[4] + wob(i + 3, p[4] * 0.5)),
                app: p[6], named: p[6] ? !/^iDrive app /.test(p[6]) : null, kind: p[7], store: p[8],
                self: p[6] === 'System Monitor', age: this.boot + t - (p[6] && p[6] !== 'MainApp' ? 900 + i * 60 : 20),
            };
        });
        const total = 6 * 1024 * MB;
        const used = procs.reduce((a, p) => a + p.mem, 0) + 1180 * MB + Math.round(wob(9, 30) * MB);
        const available = total - used;
        return {
            at: Date.now(),
            sample: true,
            mem: { total, available, used, free: Math.round(available * 0.35), cache: Math.round(available * 0.6), shmem: 96 * MB, anon: null, kernel: 180 * MB, swapTotal: 1024 * MB, swapUsed: 24 * MB },
            cpu: t < 1 ? null : { busy: Math.max(0, 24 + wob(20, 8)), ncpu: 4 },
            ncpu: 4,
            procs,
            hidden: 0,
            restricted: false,
            uptime: this.boot + t,
        };
    }
    command(pid) {
        const p = LIST[(pid - 300) / 37];
        return p ? p[9] : '';
    }
}

module.exports = { SampleSampler };
