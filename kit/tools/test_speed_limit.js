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
console.log('pack: ' + pack.describe() + ', ' + (pack.buf.length / 1e6).toFixed(1) + ' MB, opened in ' + (Date.now() - t0) + ' ms');

/* ---------- ways: their pieces in order, and where they end ---------- */
const ways = new Map();     // way -> [piece ids] (consecutive in the pack, in the way's order)
for (let i = 0; i < pack.count; i++) {
    const w = pack.piece(i).way;
    let a = ways.get(w);
    if (!a) { a = []; ways.set(w, a); }
    a.push(i);
}
const key = (x, y) => Math.round(x) + ',' + Math.round(y);
const ends = new Map();     // rounded end point -> [{ way, atStart }]
function geom(way) {
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

if (failures.length) { console.log('\nFAIL:\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('\nok');
