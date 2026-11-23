'use strict';
/**
 * test_speed_limit.js - the Speed Limit app's road matching, replayed on the PC (no car, no SDK).
 *
 *   node kit/tools/test_speed_limit.js [pack] [--drives N] [--seed S] [--area tbilisi|georgia] [--verbose]
 *
 * Drives made from the pack itself: a chain of ways joined end to end (a turn at each junction), driven at a
 * speed for the road with GPS noise (4 m), heading noise (5 degrees), 1 Hz fixes and now and then a fix lost. Each
 * fix goes through matcher.js and is checked against the way and limit really driven. Then a few fixed places in
 * Tbilisi are printed, and the time an update takes (the car's Atom is slower than a PC: the budget is 5 ms there).
 * Exit code 1 when the matching falls under the thresholds below.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { LimitPack, F, merc, unmerc, groundScale } = require(path.join(ROOT, 'apps', 'speed_limit', 'limitpack'));
const { Matcher, limitOf, bearing, angDiff } = require(path.join(ROOT, 'apps', 'speed_limit', 'matcher'));
const { Cameras, camText } = require(path.join(ROOT, 'apps', 'speed_limit', 'cameras'));
const { Fixes } = require(path.join(ROOT, 'apps', 'speed_limit', 'fixes'));
const QL = require(path.join(ROOT, 'apps', 'speed_limit', 'qrlog'));
const QR = require(path.join(ROOT, 'apps', 'speed_limit', 'qr'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const file = args[0] && !args[0].startsWith('--') ? args[0] : path.join(ROOT, 'apps', 'speed_limit', 'georgia.pack');
const DRIVES = Number(opt('--drives', 60));
let seed = Number(opt('--seed', 7));
const AREA = opt('--area', 'tbilisi');
const VERBOSE = args.indexOf('--verbose') >= 0;
const JTRACE = args.indexOf('--junctions') >= 0;     // print the matches around the first junctions

function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function gauss() { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const t0 = Date.now();
const pack = LimitPack.open(file);
console.log('pack: ' + pack.describe() + ', ' + (pack.size / 1e6).toFixed(1) + ' MB, opened in ' + (Date.now() - t0) + ' ms');

/* ---------- ways: their pieces in order, and where they end ---------- */
const ways = new Map();     // way -> [piece ids] (put in driving order by geom(): the pack keeps them by place)
for (let i = 0; i < pack.count; i++) {
    const w = pack.piece(i).way;
    let a = ways.get(w);
    if (!a) { a = []; ways.set(w, a); }
    a.push(i);
}
const key = (x, y) => Math.round(x) + ',' + Math.round(y);
const ends = new Map();     // rounded end point -> [{ way, atStart }]
const chained = new Set();
function geom(way) {
    if (!chained.has(way)) { ways.set(way, pack.chain(ways.get(way))); chained.add(way); }
    const pts = [];
    for (const id of ways.get(way)) {
        const p = pack.points(id);
        for (let k = pts.length ? 2 : 0; k < p.length; k += 2) pts.push([p[k], p[k + 1], id]);
    }
    return pts;
}
const AREAS = { tbilisi: [41.64, 44.70, 41.82, 44.98], georgia: [41.0, 40.0, 43.6, 46.8] };
const box = AREAS[AREA] || AREAS.tbilisi;
const [bx0, by0] = merc(box[0], box[1]), [bx1, by1] = merc(box[2], box[3]);
const inBox = (x, y) => x >= bx0 && x <= bx1 && y >= by0 && y <= by1;
const pool = [];
ways.forEach((ids, w) => {
    const P = pack.piece(ids[0]);
    if (P.cls > 7) return;
    const g = geom(w), a = g[0], b = g[g.length - 1];
    if (!inBox(a[0], a[1])) return;
    pool.push(w);
    [[a, true], [b, false]].forEach(([p, atStart]) => {
        const k = key(p[0], p[1]);
        if (!ends.has(k)) ends.set(k, []);
        ends.get(k).push({ way: w, atStart });
    });
});
console.log('ways in ' + AREA + ': ' + pool.length);

/* ---------- a drive: ways chained at their ends ---------- */
function route() {
    for (let tries = 0; tries < 50; tries++) {
        const w0 = pool[Math.floor(rnd() * pool.length)];
        const P0 = pack.piece(ways.get(w0)[0]);
        let fwd = (P0.flags & F.ONEWAY) ? true : rnd() < 0.5;
        const legs = [];
        let way = w0, total = 0;
        for (let n = 0; n < 8 && total < 6000; n++) {
            let g = geom(way);
            if (!fwd) g = g.slice().reverse();
            legs.push({ way, fwd, g });
            for (let i = 1; i < g.length; i++) total += Math.hypot(g[i][0] - g[i - 1][0], g[i][1] - g[i - 1][1]);
            const end = g[g.length - 1], prev = g[g.length - 2];
            const hIn = bearing(end[0] - prev[0], end[1] - prev[1]);
            const next = (ends.get(key(end[0], end[1])) || []).filter((e) => e.way !== way).map((e) => {
                const P = pack.piece(ways.get(e.way)[0]);
                if ((P.flags & F.ONEWAY) && !e.atStart) return null;           // can't drive a one-way against it
                const gg = geom(e.way), s = e.atStart ? gg : gg.slice().reverse();
                const hOut = bearing(s[1][0] - s[0][0], s[1][1] - s[0][1]);
                return angDiff(hIn, hOut) < 100 ? { way: e.way, fwd: e.atStart } : null;
            }).filter(Boolean);
            if (!next.length) break;
            const pick = next[Math.floor(rnd() * next.length)];
            way = pick.way; fwd = pick.fwd;
        }
        if (total > 800) return legs;
    }
    return null;
}

const SPEED = [100, 85, 70, 60, 50, 40, 35, 20];       // km/h by class, a little under the usual limits
function drive(legs) {
    // sample one fix a second along the legs; truth = the leg's way, the piece and its limit that way
    const fixes = [];
    legs.forEach((leg, li) => {
        const g = leg.g, P = pack.piece(g[0][2]);
        const v = SPEED[P.cls] / 3.6 * (0.85 + rnd() * 0.3);
        let carry = fixes.carry || 0;
        for (let i = 1; i < g.length; i++) {
            const ax = g[i - 1][0], ay = g[i - 1][1], dx = g[i][0] - ax, dy = g[i][1] - ay;
            const segM = Math.hypot(dx, dy) * groundScale(ay);
            const pid = leg.fwd ? g[i][2] : g[i - 1][2];
            let s = carry;
            while (s < segM) {
                const f = s / segM;
                fixes.push({ x: ax + dx * f, y: ay + dy * f, h: bearing(dx, dy), v: v * 3.6, way: leg.way, piece: pid, dir: leg.fwd ? 1 : -1, leg: li });
                s += v;
            }
            carry = s - segM;
        }
        fixes.carry = carry;
    });
    return fixes;
}

/* ---------- run: two noise profiles ---------- */
const failures = [];
function run(label, NOISE, HNOISE, DROP) {
    let ticks = 0, wayOk = 0, limOk = 0, scored = 0, junction = 0, none = 0, lost = 0, lagSum = 0, lagN = 0;
    const times = [];
    const s0 = seed;
    for (let d = 0; d < DRIVES; d++) {
        const legs = route();
        if (!legs) continue;
        const fixes = drive(legs);
        const m = new Matcher(pack);
        let lastLeg = -1, sinceLeg = 0, caught = false;
        const trace = [];
        for (let i = 0; i < fixes.length; i++) {
            const f = fixes[i];
            if (f.leg !== lastLeg) {
                if (lastLeg > 0 && !caught) { lagSum += sinceLeg + 1; lagN++; }      // never caught: the whole leg
                lastLeg = f.leg; sinceLeg = 0; caught = false;
            } else sinceLeg++;
            const gs = groundScale(f.y);
            const drop = rnd() < DROP;
            const fix = drop ? null : { x: f.x + gauss() * NOISE / gs, y: f.y + gauss() * NOISE / gs, heading: (f.h + gauss() * HNOISE + 360) % 360, speed: f.v };
            if (drop) lost++;
            const r = m.update(fix, i * 1000);
            times.push(r.ms);
            ticks++;
            if (JTRACE) trace.push(r);
            if (f.leg > 0 && !caught) { if (r.way === f.way) { caught = true; lagSum += sinceLeg; lagN++; } }
            if (sinceLeg < 4 && f.leg > 0) { junction++; continue; }      // the hysteresis' seconds after a junction
            if (i < 2) continue;
            scored++;
            if (r.state === 'none' || r.state === 'nofix') none++;
            if (r.way === f.way) wayOk++;
            const want = limitOf(pack.piece(f.piece), f.dir, m.defaults).limit;
            if (r.limit === want) limOk++;
            else if (VERBOSE && r.state === 'match') console.log('  drive ' + d + ' t' + i + ': way ' + r.way + ' (want ' + f.way + ') limit ' + r.limit + ' want ' + want + ' dist ' + (r.dist || 0).toFixed(1));
        }
        if (JTRACE && d < 4) {
            for (let i = 1; i < fixes.length; i++) {
                if (fixes[i].leg === fixes[i - 1].leg) continue;
                let s = '  drive ' + d + ' junction ' + fixes[i - 1].way + ' -> ' + fixes[i].way + ' at ' + fixes[i].v.toFixed(0) + ' km/h:';
                for (let k = -1; k < 6 && i + k < fixes.length; k++) {
                    const r = trace[i + k], w = fixes[i + k].way;
                    s += ' [' + k + ' ' + (r.way === w ? 'ok' : r.way === fixes[i - 1].way ? 'old' : r.way || '-') + ' c' + r.candidates + ']';
                }
                console.log(s);
            }
        }
    }
    seed = s0;                                  // the same drives for every profile
    if (JTRACE) console.log('(junction traces above: [fix after the junction: ok | old | other way, candidates])');
    times.sort((a, b) => a - b);
    const pc = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(3);
    const pct = (n) => (100 * n / Math.max(1, scored)).toFixed(1) + ' %';
    console.log('\n' + label + ': ' + DRIVES + ' drives, ' + ticks + ' fixes (' + lost + ' lost, ' + junction + ' just after a junction not scored)');
    console.log('  right road:  ' + pct(wayOk) + '   right limit: ' + pct(limOk) + '   no road: ' + pct(none));
    console.log('  after a junction the new road is taken in ' + (lagSum / Math.max(1, lagN)).toFixed(1) + ' fixes on average');
    console.log('  update time: median ' + pc(0.5) + ' ms, 99 % ' + pc(0.99) + ' ms, max ' + times[times.length - 1].toFixed(3) + ' ms (PC)');
    return { okWay: wayOk / Math.max(1, scored), okLim: limOk / Math.max(1, scored), p99: times[Math.floor(0.99 * times.length)] };
}
const a = run('GPS 4 m, heading 5 deg', 4, 5, 0.03);
if (a.okWay < 0.95 || a.okLim < 0.95) failures.push('4 m drives: right road ' + (a.okWay * 100).toFixed(1) + ' %, limit ' + (a.okLim * 100).toFixed(1) + ' % (want 95 %)');
const b = run('GPS 10 m, heading 15 deg', 10, 15, 0.08);
if (b.okWay < 0.85 || b.okLim < 0.85) failures.push('10 m drives: right road ' + (b.okWay * 100).toFixed(1) + ' %, limit ' + (b.okLim * 100).toFixed(1) + ' % (want 85 %)');
if (Math.max(a.p99, b.p99) > 5) failures.push('update 99 % ' + Math.max(a.p99, b.p99).toFixed(2) + ' ms (want under 5)');

/* ---------- real places in Tbilisi (OSM 2026-11-19: a node pair's middle on each way, its heading) ---------- */
// [name, way, lat, lon, heading, maxspeed tag (null: untagged)]
const PLACES = [
    ['Akaki Tsereteli Ave (south-bound)', 75266716, 41.736162, 44.782364, 156, 40],
    ['Akaki Tsereteli Ave, north-bound carriageway', 125953058, 41.752369, 44.778427, 343, 30],
    ['Alexander Kazbegi Ave', 28400283, 41.726559, 44.768936, 51, 50],
    ['Ilia Chavchavadze Ave (two-way)', 28046188, 41.707745, 44.738088, 55, 50],
    ['Ilia Chavchavadze Ave (two-way), the other way', 28046188, 41.707745, 44.738088, 235, 50],
    ['Kakheti Highway, trunk east-bound', 20819000, 41.684264, 44.886358, 79, 80],
    ['Kakheti Highway, side road west-bound', 25624407, 41.684366, 44.884377, 267, 60],
    ['Kakheti Highway near Vaziani', 20822972, 41.692287, 44.977751, 94, 90],
    ['Pekini Ave, north-bound', 80633186, 41.727771, 44.768241, 352, 50],
    ['Pekini Ave, south-bound', 28345040, 41.730544, 44.767571, 173, 40],
    ['Rustavi Highway, north-west-bound', 172912875, 41.666549, 44.867079, 302, 80],
    ['Rustavi Highway, east-bound', 787369886, 41.661112, 44.883924, 109, 70],
    ['Tbilisi Bypass Road', 20647951, 41.782626, 44.961565, 308, 90],
    ['Tbilisi Bypass Road, the other way', 20647951, 41.782626, 44.961565, 128, 90],
    ['Vakhtang Gorgasali St', 25626175, 41.687581, 44.819719, 317, 70],
    ['Vazha-Pshavela Ave', 97543762, 41.725194, 44.742635, 262, 60],
    ['Ksani St (no limit tagged)', 74196390, 41.768256, 44.786754, 124, null],
    ['Rustavi Highway south (no limit tagged)', 754475328, 41.641505, 44.913747, 161, null],
];
console.log('\nplaces (driven up to them: fixes 30 and 15 m before and at the place, 5 m off the road):');
let placesOk = 0;
PLACES.forEach(([name, way, lat, lon, h, tag]) => {
    const m = new Matcher(pack);
    const [x, y] = merc(lat, lon);
    // 5 m to the right of the way it's driven (the usual GNSS error, and a lane over)
    const gs = groundScale(y), rad = (h + 90) * Math.PI / 180, ox = Math.sin(rad) * 5 / gs, oy = Math.cos(rad) * 5 / gs;
    const hx = Math.sin(h * Math.PI / 180) / gs, hy = Math.cos(h * Math.PI / 180) / gs;
    let r = null;
    [-30, -15, 0].forEach((s, i) => { r = m.update({ x: x + ox + hx * s, y: y + oy + hy * s, heading: h, speed: 45 }, i * 1000); });
    const ok = r.way === way && (tag == null ? r.inferred : r.limit === tag && !r.inferred);
    if (ok) placesOk++; else failures.push('place ' + name + ': way ' + r.way + ' limit ' + r.limit + ' (want way ' + way + ', ' + (tag || 'a default') + ')');
    const P = r.piece >= 0 ? pack.piece(r.piece) : null;
    console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + name + ': ' + r.state + (P ? ', way ' + r.way + ' (' + ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living', 'service'][r.cls] + (P.flags & F.URBAN ? ', urban' : '') + ') ' + r.dist.toFixed(1) + ' m: ' + r.limit + ' km/h' + (r.inferred ? ' (default)' : '') : ''));
});
console.log('  ' + placesOk + ' / ' + PLACES.length);

/* ---------- no position: a tunnel holds its limit, an open road for 15 s ---------- */
function holdCase(tunnel) {
    for (let i = 0; i < pack.count; i++) {
        const P = pack.piece(i);
        if (((P.flags & F.TUNNEL) !== 0) !== tunnel || P.cls > 4 || !(P.src & 3) || P.n < 2) continue;
        const pts = pack.points(i, P);
        const x = (pts[0] + pts[2]) / 2, y = (pts[1] + pts[3]) / 2, h = bearing(pts[2] - pts[0], pts[3] - pts[1]);
        const m = new Matcher(pack);
        const r0 = m.update({ x, y, heading: h, speed: 60 }, 0);
        if (r0.way !== P.way) continue;
        return { way: P.way, limit: r0.limit, at20: m.update(null, 20000), at120: m.update(null, 120000) };
    }
    return null;
}
const tun = holdCase(true), open = holdCase(false);
console.log('\nno position:');
if (!tun) failures.push('no tunnel with a limit in the pack to test');
else {
    const ok = tun.at120.state === 'hold' && tun.at120.limit === tun.limit;
    console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + 'tunnel (way ' + tun.way + ', ' + tun.limit + ' km/h): after 2 min without a position ' + tun.at120.state + ' ' + tun.at120.limit);
    if (!ok) failures.push('a tunnel does not hold its limit');
}
if (open) {
    const ok = open.at20.state === 'nofix' && open.at20.limit === null;
    console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + 'open road (way ' + open.way + '): after 20 s without a position ' + open.at20.state);
    if (!ok) failures.push('an open road keeps its limit without a position');
}

/* ---------- speed cameras: warned ahead in their direction, not the other way, not beside the road ---------- */
console.log('\nspeed cameras (' + pack.cameras.n + ' in the pack):');
const C = pack.cameras;
let ci = -1;
for (let i = 0; i < C.n; i++) if (C.dir[i] >= 0) { ci = i; break; }
function approach(dirDeg, offsetM) {
    // drive straight at 50 km/h (2 fixes a second) from 500 m before camera ci to 50 m past it, along dirDeg
    const cams = new Cameras(C), gs = groundScale(C.y[ci]), hr = dirDeg * Math.PI / 180;
    const sx = Math.sin(hr), sy = Math.cos(hr), ox = Math.cos(hr) * offsetM / gs, oy = -Math.sin(hr) * offsetM / gs;
    const seen = [];
    for (let s = -500; s <= 50; s += 7) {
        const x = C.x[ci] + sx * s / gs + ox, y = C.y[ci] + sy * s / gs + oy;
        const r = cams.update({ x, y }, dirDeg, 0);
        seen.push({ s, dist: r ? r.dist : null });
    }
    return seen;
}
if (ci < 0) failures.push('no camera with a direction in the pack');
else {
    const d = C.dir[ci];
    const a = approach(d, 0), first = a.find((p) => p.dist !== null);
    const warnAt = first ? -first.s : 0, after = a.filter((p) => p.s > 15 && p.dist !== null).length;
    const down = a.filter((p) => p.dist !== null).every((p, i, arr) => i === 0 || p.dist <= arr[i - 1].dist + 0.01);
    let ok = first && warnAt <= 400 && warnAt > 380 && after === 0 && down;
    console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + 'driving the way it checks (' + d + ' deg): warned from ' + warnAt + ' m, counting down, gone once passed');
    if (!ok) failures.push('camera: not warned as it should be ahead');
    const b = approach((d + 180) % 360, 0);
    ok = b.every((p) => p.dist === null);
    console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + 'driving the other way: no warning');
    if (!ok) failures.push('camera: warned for the other direction');
    const c = approach(d, 50);
    ok = c.every((p) => p.dist === null);
    console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + 'a road 50 m beside it: no warning');
    if (!ok) failures.push('camera: warned for a road beside it');
    const steps = ['430', '380', '120', '96', '4'].map((m) => camText(Number(m))).join(', ');
    ok = steps === '450 m, 400 m, 100 m, 100 m, 0 m';
    console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + 'distance steps: ' + steps);
    if (!ok) failures.push('camera: distance steps ' + steps);
}

/* ---------- the driver's corrections: the S4 -> Tbilisi Bypass loop near Rustavi (its own way, no limit tagged) ---------- */
console.log('\ncorrections (the S4 / Tbilisi Bypass loop near Rustavi):');
function okIf(ok, text) { console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + text); if (!ok) failures.push('corrections: ' + text); }
const LOOP = 59594305, S4N = 426110697, AFTER = 120781228;
if (!ways.has(LOOP) || !ways.has(S4N) || !ways.has(AFTER)) okIf(false, 'the loop and its roads are in the pack');
else {
    // S4 north-bound to the loop's start, the loop, the bypass after it: 2 fixes a second at 40 km/h
    function driveLoop(m) {
        const line = [];
        const s4 = geom(S4N), loop = geom(LOOP), after = geom(AFTER);
        const start = loop[0], gs = groundScale(start[1]);
        // the last 300 m of S4 before the loop leaves it (the S4 points nearest the loop's start, and before them)
        let k = 0;
        s4.forEach((p, i) => { if (Math.hypot(p[0] - start[0], p[1] - start[1]) < Math.hypot(s4[k][0] - start[0], s4[k][1] - start[1])) k = i; });
        let back = k, run = 0;
        while (back > 0 && run < 300) { run += Math.hypot(s4[back][0] - s4[back - 1][0], s4[back][1] - s4[back - 1][1]) * gs; back--; }
        s4.slice(back, k).concat(loop, after.slice(1)).forEach((p) => line.push(p));
        const out = [], step = 40 / 3.6 / 2;
        let acc = 0, t = 0;
        for (let i = 1; i < line.length; i++) {
            const a = line[i - 1], b = line[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]) * gs;
            while (acc <= L) {
                const f = L ? acc / L : 0, h = bearing(b[0] - a[0], b[1] - a[1]);
                const r = m.update({ x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, heading: h, speed: 40 }, t += 500);
                out.push(r);
                acc += step;
            }
            acc -= L;
        }
        return out;
    }
    const on = (rs, way) => rs.filter((r) => r.way === way);
    const plain = driveLoop(new Matcher(pack, {}));
    const loopPlain = on(plain, LOOP);
    okIf(loopPlain.length > 20 && loopPlain.every((r) => r.inferred && r.limit !== 110),
        'untagged ramp: the settlement / rural default, not the motorway\'s 110 (' + (loopPlain[0] || {}).limit + ')');
    const tmp = path.join(require('os').tmpdir(), 'sl_fixes_' + process.pid + '.json');
    try { require('fs').unlinkSync(tmp); } catch (e) { /* none */ }
    const fx = new Fixes(tmp, null);
    fx.set(LOOP, 50, 50, { lat: 41.58993, lon: 44.94827 });
    const fixed = driveLoop(new Matcher(pack, { fixes: fx }));
    const loopFixed = on(fixed, LOOP), s4f = on(fixed, S4N), afterF = on(fixed, AFTER);
    okIf(loopFixed.length > 20 && loopFixed.every((r) => r.limit === 50 && r.corrected && !r.inferred), 'corrected to 50: 50 all round the loop');
    okIf(s4f.length > 5 && s4f.every((r) => r.limit === on(plain, S4N)[0].limit && !r.corrected) && afterF.length && afterF.every((r) => r.limit === on(plain, AFTER)[0].limit && !r.corrected),
        'S4 before it and the bypass after it keep the map\'s ' + (s4f[0] || {}).limit + ' / ' + (afterF[0] || {}).limit);
    const again = new Fixes(tmp, null);
    okIf(again.count === 1 && again.get(LOOP).f === 50, 'kept in the file: read back after a restart');
    // a correction the map has caught up with goes by itself: S4 "corrected" to the limit it already has
    const s4lim = on(plain, S4N)[0].limit;
    again.set(S4N, s4lim, s4lim, null);
    driveLoop(new Matcher(pack, { fixes: again }));
    okIf(!again.get(S4N) && again.get(LOOP), 'one the map tags the same way removes itself (the loop\'s stays)');
    again.set(S4N, 70, 70, null);
    okIf(again.undo() && !again.get(S4N) && again.count === 1, 'undo: the last one goes');
    okIf(again.clear() && again.count === 0 && new Fixes(tmp, null).count === 0, 'clear all: none left, in the file too');
    try { require('fs').unlinkSync(tmp); } catch (e) { /* none */ }
}

/* ---------- the QR log: codes that decode back into the log ---------- */
console.log('\nQR log:');
{
    const zlib = require('zlib'), dict = require(path.join(ROOT, 'apps', 'speed_limit', 'qrdict'));
    const lines = ['-- 2026-11-22 (UTC)'];
    for (let i = 0; i < 400; i++) lines.push('12:' + String(10 + (i >> 6)).padStart(2, '0') + ':' + String(i % 60).padStart(2, '0') + ' drive: match way ' + (59594305 + i) + ' ' + (50 + i % 5 * 10) + 'd shown 60 at 41.58993,44.94827 h' + (i % 360) + ' 42km/h nav 3m off');
    const text = lines.join('\n');
    let ok = true, got = [];
    ['large', 'medium', 'small'].forEach((size) => {
        const pg = QL.pages(text, size, 'speed_limit 1.0.8');
        pg.forEach((b, i) => {
            QR.encode(b, { version: QL.SIZES[size].version, ecl: 'L' });     // throws when it doesn't fit
            const nl = b.indexOf(10), head = b.slice(0, nl).toString();
            if (head !== 'MGULOG2 d1 speed_limit 1.0.8 ' + (i + 1) + '/' + pg.length) ok = false;
            const body = zlib.inflateRawSync(b.slice(nl + 1), { dictionary: dict }).toString();
            if (size === 'medium') got = body.split('\n').concat(got);
        });
    });
    // the newest lines are all there (relative times "+<s>" written back as they are: compare the messages)
    const msg = (l) => l.replace(/^(\d\d:\d\d:\d\d|\+\d+) /, '');
    const want = lines.slice(-60).map(msg), have = got.filter((l) => !/^-- /.test(l)).map(msg);
    ok = ok && want.every((w) => have.indexOf(w) >= 0);
    const { Canvas } = (() => { try { return require(path.join(ROOT, 'kit', 'runtime', 'canvas')); } catch (e) { return {}; } })();
    if (Canvas) { const cv = new Canvas(1600, 520); QL.drawCode(cv, QR.encode(QL.pages(text, 'medium', 'x')[0], { version: 20, ecl: 'L' }), { page: 1, pages: 3, size: 'Medium' }); ok = ok && cv.png().length > 1000; }
    console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + 'pages fit their codes, read back with the dictionary, newest lines on page 1, drawn');
    if (!ok) failures.push('QR log');
}

if (failures.length) { console.log('\nFAIL:\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('\nok');
