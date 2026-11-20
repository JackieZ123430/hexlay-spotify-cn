#!/bin/sh
# ============================================================================
# sli-recon.sh - read-only discovery for the Speed Limit Info app (phase 1).
#
# Changes nothing on the head unit. It reads files, lists folders, asks
# systemd and cluster-render for their status, and writes its report and
# extracts to $OUT (default /tmp/sli-recon, tmpfs: gone at the next start).
# It sends nothing on SOME/IP and nothing to any ECU.
#
#   scp deploy/car/sli-recon.sh root@<hu>:/tmp/
#   ssh root@<hu> sh /tmp/sli-recon.sh
#   scp 'root@<hu>:/tmp/sli-recon/*' reference/sli-recon/
#
# What comes back:
#   report.txt        everything printed below (paste it back)
#   candidates.json   the catalog's full definitions of every interface that
#                     may carry a position, heading, fix or yaw rate
# ============================================================================
set -u
CATALOG=${CATALOG:-/etc/oap/someip/someip-interfaces.json}
OUT=${OUT:-/tmp/sli-recon}
NODE=${NODE:-/usr/bin/node}
CR=/var/opt/cluster-render
CR_SOCK=/dev/shm/cluster-render/render.sock
VSEC=${VSEC:-/etc/vsomeip/vsomeip_security.json}

mkdir -p "$OUT" || { echo "cannot write $OUT"; exit 1; }

# ---------------------------------------------------------------------------
# The catalog walk: Node 8, no modern syntax. Written to $OUT and run there.
# ---------------------------------------------------------------------------
cat > "$OUT/catalog.js" <<'EOF'
'use strict';
var fs = require('fs');
var cat = process.argv[2], out = process.argv[3];
var clip = function (s, n) { s = String(s); return s.length > n ? s.slice(0, n) + ' ...(' + s.length + ' chars)' : s; };

var raw;
try { raw = fs.readFileSync(cat, 'utf8'); } catch (e) { console.log('cannot read ' + cat + ': ' + e.message); process.exit(0); }
var db = JSON.parse(raw);
var ifs = db.interfaces || {};
var names = Object.keys(ifs).sort();
console.log('catalog ' + cat + ': ' + (raw.length / 1048576).toFixed(2) + ' MB, ' + names.length + ' interfaces');
Object.keys(db).forEach(function (k) {
    var v = db[k];
    console.log('  top-level "' + k + '": ' + (v && typeof v === 'object' ? Object.keys(v).length + ' entries' : clip(JSON.stringify(v), 200)));
});

// How this firmware describes a field: one we already use, whole.
var SAMPLE = 'de.bmw.infotainment.vehicle.Vehicle2';
if (ifs[SAMPLE]) {
    console.log('\nschema sample: ' + SAMPLE + ' has keys: ' + Object.keys(ifs[SAMPLE]).join(', '));
    console.log('  fields.statusCarSpeed2 = ' + clip(JSON.stringify((ifs[SAMPLE].fields || {}).statusCarSpeed2), 1500));
}

function flags(fd) {
    if (!fd || typeof fd !== 'object') return '?';
    return ((fd.getter && fd.getter.id) ? 'r' : '-') + (fd.notifier ? 's' : '-') + (fd.setter ? 'w' : '-');
}

// Signals the app will use whatever the position source turns out to be.
console.log('\n== known signals (r = getter, s = notifier, w = setter; the app only reads)');
[
    ['de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2'],
    ['de.bmw.infrastructure.VehicleCondition', 'VehicleCondition'],
    ['de.bmw.infotainment.vehicle.CDS2', 'statusLateralAccelerationMassCenter'],
    ['de.bmw.infotainment.vehicle.CDS2', 'statusLongitudinalAccelerationMassCenter'],
    ['de.bmw.infrastructure.VehicleInformation', 'statusGearboxDrive'],
    ['de.bmw.infotainment.hmi.hmicontext.HMIContext', 'currentDisplayLanguage']
].forEach(function (p) {
    var i = ifs[p[0]];
    var fd = i && i.fields ? i.fields[p[1]] : undefined;
    console.log('  ' + (!i ? 'NO INTERFACE ' : !fd ? 'NO FIELD     ' : flags(fd) + '          ') + p[0] + '.' + p[1]);
});

// Interface names that may be about position, and member names that are.
var NAME_RX = /posit|gnss|gps|geo(?!metr)|(?:^|[^l])locati|navig|odomet|deadreck|sensor|travel|compass/i;
var MEMBER_RX = /posit|gnss|gps|latitu|longitu|wgs|heading|altitu|deadreck|dead_reck|mapmatch|coordinat|geoco|yaw|gier|fixqual|fixtype|satell|hdop|pdop|compass/i;
var MEMBER_RX_G = new RegExp(MEMBER_RX.source, 'gi');

var found = [];
names.forEach(function (n) {
    var d = ifs[n], hits = [];
    ['fields', 'methods', 'events', 'broadcasts', 'attributes'].forEach(function (sec) {
        if (d && d[sec] && typeof d[sec] === 'object') {
            Object.keys(d[sec]).forEach(function (m) { if (MEMBER_RX.test(m)) hits.push(sec + '.' + m); });
        }
    });
    var deep = (JSON.stringify(d).match(MEMBER_RX_G) || []).length;
    if (NAME_RX.test(n) || hits.length || deep) found.push({ n: n, hits: hits, deep: deep, byName: NAME_RX.test(n) });
});

console.log('\n== interfaces that may carry position / heading / fix / yaw: ' + found.length);
found.forEach(function (f) {
    console.log('  ' + f.n + '  [name ' + (f.byName ? 'yes' : 'no') + ', member hits ' + f.hits.length + ', text hits ' + f.deep + ']');
});

// The strong candidates in full: a member name hit, or a matching name with text hits.
var strong = found.filter(function (f) { return f.hits.length || (f.byName && f.deep); });
console.log('\n== strong candidates in detail: ' + strong.length);
var keep = {};
strong.forEach(function (f) {
    var d = ifs[f.n];
    keep[f.n] = d;
    console.log('\n### ' + f.n);
    Object.keys(d).forEach(function (k) {
        if (['fields', 'methods', 'events', 'broadcasts'].indexOf(k) < 0) console.log('  ' + k + ' = ' + clip(JSON.stringify(d[k]), 240));
    });
    var fields = d.fields || {};
    var fk = Object.keys(fields);
    console.log('  fields (' + fk.length + '):');
    fk.slice(0, 80).forEach(function (k) {
        var hit = MEMBER_RX.test(k) || MEMBER_RX.test(JSON.stringify(fields[k]));
        console.log('    ' + flags(fields[k]) + ' ' + k + (hit ? '  = ' + clip(JSON.stringify(fields[k]), 700) : ''));
    });
    if (fk.length > 80) console.log('    ... ' + (fk.length - 80) + ' more in candidates.json');
    ['methods', 'events', 'broadcasts'].forEach(function (sec) {
        if (d[sec] && typeof d[sec] === 'object') {
            var ks = Object.keys(d[sec]);
            console.log('  ' + sec + ' (' + ks.length + '): ' + clip(ks.join(', '), 1200));
        }
    });
});
if (ifs[SAMPLE]) keep[SAMPLE] = ifs[SAMPLE];

// Other top-level sections (type tables, if this catalog keeps them apart): the entries that match.
Object.keys(db).forEach(function (k) {
    if (k === 'interfaces' || !db[k] || typeof db[k] !== 'object') return;
    var ks = Object.keys(db[k]).filter(function (e) { return MEMBER_RX.test(e) || MEMBER_RX.test(JSON.stringify(db[k][e])); });
    if (!ks.length) return;
    console.log('\n== top-level "' + k + '": ' + ks.length + ' matching entries');
    ks.slice(0, 40).forEach(function (e) { console.log('  ' + e + ' = ' + clip(JSON.stringify(db[k][e]), 500)); keep['@' + k + '/' + e] = db[k][e]; });
});

fs.writeFileSync(out + '/candidates.json', JSON.stringify(keep, null, 1));
console.log('\nwrote ' + out + '/candidates.json (' + Object.keys(keep).length + ' entries)');
EOF

# ---------------------------------------------------------------------------
# cluster-render's status over its socket: hello + status, print, close.
# No layer is made, so no target is asked for.
# ---------------------------------------------------------------------------
cat > "$OUT/cr_status.js" <<'EOF'
'use strict';
var net = require('net');
var s = net.connect(process.argv[2]);
function msg(o) {
    var b = Buffer.from(JSON.stringify(o), 'utf8'), m = Buffer.alloc(5 + b.length);
    m.writeUInt32LE(b.length + 1, 0); m[4] = 0x4a; b.copy(m, 5); return m;
}
var buf = Buffer.alloc(0);
s.on('connect', function () { s.write(msg({ op: 'hello', app: 'sli_recon', proto: 1 })); s.write(msg({ op: 'status' })); });
s.on('data', function (d) {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 5) {
        var n = buf.readUInt32LE(0);
        if (buf.length < 4 + n) break;
        var t = buf[4], body = buf.slice(5, 4 + n);
        buf = buf.slice(4 + n);
        if (t !== 0x4a) continue;
        var j; try { j = JSON.parse(body.toString('utf8')); } catch (e) { continue; }
        console.log(j.ev === 'status' ? j.text : JSON.stringify(j));
    }
});
s.on('error', function (e) { console.log('socket: ' + e.message); });
setTimeout(function () { s.destroy(); }, 2500);
EOF

# ---------------------------------------------------------------------------
# vsomeip security: the global policy file (one policy per uid, with the services
# it may offer and request). Who offers each candidate (the position's source) and
# whether app uids (12201..12450) may request it.
# ---------------------------------------------------------------------------
cat > "$OUT/security.js" <<'EOF'
'use strict';
var fs = require('fs');
var g, cand = {};
try { g = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch (e) { console.log('cannot read ' + process.argv[2] + ': ' + e.message); process.exit(0); }
try { cand = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')); } catch (e) { /* no candidates */ }
var sec = g.security || {}, pols = sec.policies || [];
var clip = function (s, n) { s = String(s); return s.length > n ? s.slice(0, n) + ' ...' : s; };
console.log('policies: ' + pols.length + '; other security keys: ' + clip(JSON.stringify(Object.keys(sec).filter(function (k) { return k !== 'policies'; }).reduce(function (o, k) { o[k] = sec[k]; return o; }, {})), 300));
var uidOf = function (p) { var c = p.credentials || {}; return String(c.uid); };
var appPols = pols.filter(function (p) { var u = +uidOf(p); return u >= 12201 && u <= 12450; });
console.log('policies for OAP app uids (12201..12450): ' + appPols.length);
appPols.slice(0, 3).forEach(function (p) { console.log('  e.g. ' + clip(JSON.stringify(p), 400)); });
var anyUid = pols.filter(function (p) { var c = p.credentials || {}; return typeof c.uid !== 'number' && !/^\d+$/.test(String(c.uid)); });
anyUid.slice(0, 3).forEach(function (p) { console.log('  range / any-uid policy: ' + clip(JSON.stringify(p), 400)); });
var hex = function (v) { var n = typeof v === 'number' ? v : /^0x/i.test(String(v)) ? parseInt(v, 16) : parseInt(v, 10); return isFinite(n) ? '0x' + n.toString(16) : null; };
var has = function (list, sid) { return (list || []).some(function (e) { return hex(e.service) === sid || e.service === 'any' || e.service === '0xffff'; }); };
Object.keys(cand).forEach(function (name) {
    if (name[0] === '@') return;
    var d = cand[name], sid = null;
    Object.keys(d).forEach(function (k) { if (!sid && /service.?id|^serviceid$|^service$/i.test(k)) sid = hex(d[k]); });
    if (!sid) { console.log(name + ': no service id key found (keys: ' + Object.keys(d).join(', ') + ')'); return; }
    var offer = pols.filter(function (p) { return has((p.allow || {}).offers, sid); }).map(uidOf);
    var req = pols.filter(function (p) { return has((p.allow || {}).requests, sid); }).map(uidOf);
    var deny = pols.filter(function (p) { return has((p.deny || {}).requests, sid); }).map(uidOf);
    console.log(name + ' (' + sid + '): offered by uid ' + (offer.join(',') || '-') + '; requests allowed for ' + req.length + ' uids' +
        (req.filter(function (u) { return +u >= 12201 && +u <= 12450; }).length ? ' (incl. app uids)' : '') + (deny.length ? '; denied for ' + deny.join(',') : ''));
});
EOF

section() { echo; echo "======== $*"; }

main() {
    section "1. Head unit"
    date -u
    uname -a
    cat /etc/os-release 2>/dev/null
    for f in /etc/version /etc/sw_version /etc/swversion /etc/build /etc/issue; do
        [ -f "$f" ] && { echo "-- $f"; head -n 5 "$f"; }
    done
    echo "-- files in /etc naming the I-step (P18_...):"
    grep -rl 'P18_2' /etc 2>/dev/null | head -n 5
    echo "-- hwvariant: $(grep -o 'hwvariant=[^ ]*' /proc/cmdline 2>/dev/null)"
    echo "-- node $("$NODE" -v 2>&1)"
    "$NODE" -e "try{console.log('-- MainApp '+require('/usr/lib/oap-mainapp/package.json').version)}catch(e){console.log('-- MainApp version: '+e.message)}"
    echo "-- CPU: $(grep -c ^processor /proc/cpuinfo) x $(grep -m 1 'model name' /proc/cpuinfo | cut -d: -f2)"
    free 2>/dev/null | head -n 2
    df -h /var/opt /var/opt/public /tmp 2>/dev/null

    section "2. SOME/IP catalog ($CATALOG)"
    ls -la "$CATALOG"
    "$NODE" "$OUT/catalog.js" "$CATALOG" "$OUT"

    section "3. Tools installed by the MGU Store (/var/opt/*/current)"
    for d in /var/opt/*; do
        [ -e "$d/current" ] || continue
        v=$("$NODE" -e "try{var c=require('$d/current/component.json');process.stdout.write((c.id||'')+' '+(c.version||''))}catch(e){process.stdout.write('(no component.json)')}" 2>/dev/null)
        echo "  $(basename "$d"): $v -> $(readlink "$d/current")"
    done

    section "4. OAP apps registered (uids.txt)"
    cat /var/opt/public/oap/oap_12201/security/uids.txt 2>/dev/null

    section "5. cluster-render"
    ls -la /dev/shm/cluster-render 2>&1
    ls -la "$CR" "$CR/current" 2>&1 | head -n 40
    systemctl --no-pager status cluster-render.socket cluster-render.service 2>&1 | head -n 24
    echo "-- conf files:"
    find "$CR" -maxdepth 3 -name '*.conf' 2>/dev/null
    echo "-- local conf:"
    cat "$CR/cluster-render.local.conf" 2>/dev/null || echo "(none)"
    echo "-- target settings in the shipped conf:"
    for c in $(find "$CR/current" -maxdepth 2 -name 'cluster-render.conf' 2>/dev/null); do
        grep -E '^[[:space:]]*(map|panel|hud|guide|scene_ids|panel_fallback|hud_yield|guide_hold)' "$c"
    done
    echo "-- status over the socket:"
    [ -S "$CR_SOCK" ] && "$NODE" "$OUT/cr_status.js" "$CR_SOCK" || echo "(no socket at $CR_SOCK)"
    echo "-- last 60 log lines:"
    tail -n 60 "$CR/log/cluster-render.log" 2>/dev/null || echo "(no log)"

    section "6. Shared folders other cluster / HUD apps use"
    for d in /dev/shm/mgu-hud /dev/shm/cluster-info; do
        echo "-- $d"
        ls -la "$d" 2>/dev/null || echo "(none)"
        for f in "$d"/*; do [ -f "$f" ] && echo "   $(basename "$f"): $(head -c 300 "$f")"; done
    done

    section "7. Position hardware and processes (information only)"
    ls /dev 2>/dev/null | grep -i -E 'gnss|gps|nmea' || echo "(no gnss/gps device node)"
    (ps -eo pid,user,comm 2>/dev/null || ps) | grep -i -E 'gnss|gps|posi|navi|locat|dr_|sensor' | grep -v grep | head -n 25

    section "8. vsomeip configuration (security policies limit who may subscribe)"
    ls -d /etc/vsomeip* /etc/someip* /etc/oap/someip 2>/dev/null
    echo "-- per-uid policy folders: $(ls -d /etc/vsomeip/*_* 2>/dev/null | wc -l)"
    "$NODE" "$OUT/security.js" "$VSEC" "$OUT/candidates.json"

    section "9. SQLite on the unit"
    ls /usr/lib/libsqlite3* /lib/libsqlite3* 2>/dev/null
    command -v sqlite3 2>/dev/null || echo "(no sqlite3 command)"
    ls /var/opt/mgu-python/current/bin/python3 2>/dev/null && /var/opt/mgu-python/current/bin/python3 -c "import sqlite3;print('mgu-python sqlite', sqlite3.sqlite_version)"

    section "done"
    echo "report: $OUT/report.txt   extracts: $OUT/candidates.json"
}

main 2>&1 | tee "$OUT/report.txt"
