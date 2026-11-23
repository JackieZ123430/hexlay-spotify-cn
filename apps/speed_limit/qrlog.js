'use strict';
/**
 * qrlog.js - the app's log as QR codes on its own screen, for a phone photo: someone without SSH sends the photos
 * with an issue, and kit/tools/qrlog_decode.py turns them back into the log. Node 8.
 *
 * The format is idrive7-apps' QR log (cauliflowermossgrape/idrive7-apps kit/runtime/qrlog.js, MIT), so either
 * decoder reads it. A code: a text line "MGULOG2 d1 <app> <version> <page>/<pages>" and a newline, then that page's
 * lines compressed (raw deflate with the preset dictionary qrdict.js). In a page a line's time is "+<seconds> " after
 * the line before (the first keeps hh:mm:ss). Each page is compressed on its own: any photo reads without the others.
 * Page 1 holds the newest lines.
 *
 *   logText(file)                 the log made short: times without the date, stack lines left out, a VIN masked
 *   pages(text, size, head)       the log cut into codes' worth of whole lines: [Buffer]
 *   drawCode(c, q, info)          one code and its help text on a canvas.js Canvas (the screen's picture)
 *
 * Nothing here runs unless the QR screen is open: the log is read and compressed when it opens (and on Size or
 * Refresh), a code is drawn when it is shown.
 */
const fs = require('fs');
const zlib = require('zlib');
const qr = require('./qr');

const SIZES = {
    // (77, 97 and 137 modules: on the 1600 x 520 picture about 5, 4 and 3 screen pixels a module)
    large: { version: 15, label: 'Large' },
    medium: { version: 20, label: 'Medium' },
    small: { version: 30, label: 'Small' },
};
const ORDER = ['medium', 'large', 'small'];
const DICT = 1;
let dict = null;
function dictionary() {
    if (dict === null) { try { dict = require('./qrdict'); } catch (e) { dict = false; } }
    return dict || null;
}
const MAX_PAGES = 8, LINE_MAX = 300, SDK_MAX = 160, TAIL_BYTES = 128 * 1024;

/** The log made short for the codes: the last TAIL_BYTES, times as hh:mm:ss, stack and noise lines left out. */
function logText(file) {
    let raw = '';
    try {
        const fd = fs.openSync(file, 'r'), st = fs.fstatSync(fd), n = Math.min(st.size, TAIL_BYTES), buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, st.size - n);
        fs.closeSync(fd);
        raw = buf.toString('utf8');
        if (n < st.size) raw = raw.slice(raw.indexOf('\n') + 1);          // a whole first line
    } catch (e) { return ''; }
    let day = '', last = null;
    const out = [];
    raw.split('\n').forEach((l) => {
        const m = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)\.\d+Z (\w+) (.*)$/.exec(l);
        if (!m) return;                                    // stack lines and wrapped SDK dumps
        if (/^SDK_/.test(m[3]) && m[3] !== 'SDK_ERROR') return;
        if (/^click /.test(m[4])) return;                  // the page's own clicks
        const msg = m[4].slice(0, m[3] === 'SDK_ERROR' ? SDK_MAX : LINE_MAX);
        if (msg === last) return;
        last = msg;
        if (m[1] !== day) { day = m[1]; out.push('-- ' + day + ' (UTC)'); }
        out.push(m[2] + ' ' + (m[3] === 'INFO' ? '' : m[3] + ' ') + msg);
    });
    return out.join('\n').replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, '<VIN>');
}

/** A page's lines with each time after the first as "+<seconds>" since the line before (a step back: the time again). */
function relTimes(lines) {
    let last = null;
    return lines.map((l) => {
        const m = /^(\d\d):(\d\d):(\d\d) (.*)$/.exec(l);
        if (!m) return l;
        const t = +m[1] * 3600 + +m[2] * 60 + +m[3], out = last === null || t < last ? l : '+' + (t - last) + ' ' + m[4];
        last = t;
        return out;
    });
}
function deflate(lines) {
    const d = dictionary(), o = d ? { level: 9, dictionary: d } : { level: 9 };
    return zlib.deflateRawSync(Buffer.from(relTimes(lines).join('\n'), 'utf8'), o);
}
const magic = () => 'MGULOG2 d' + (dictionary() ? DICT : 0);

/**
 * The log cut into pages, each the most whole lines whose compressed size fits the size's code, from the newest back:
 * page 1 has the newest lines (oldest first within a page); the oldest are left out when they don't fit in MAX_PAGES.
 */
function pages(text, size, head) {
    const cap = qr.capacity(SIZES[size].version, 'L');
    const top = (n, of) => magic() + ' ' + String(head || 'app').replace(/\s+/g, ' ').trim() + ' ' + n + '/' + of + '\n';
    const room = cap - Buffer.byteLength(top(MAX_PAGES, MAX_PAGES));
    const lines = String(text || '').split('\n').filter((l) => l.length);
    // each page starts with its day (the "-- date" line before its first line), so every page reads alone
    const days = [];
    lines.forEach((l, i) => { days[i] = /^-- /.test(l) ? null : (i && (/^-- /.test(lines[i - 1]) ? lines[i - 1] : days[i - 1])) || null; });
    const part = (a, b) => (days[a] ? [days[a]] : []).concat(lines.slice(a, b));
    const rev = [];
    let end = lines.length;
    while (end > 0 && rev.length < MAX_PAGES) {
        if (deflate(part(end - 1, end)).length > room) { end--; continue; }   // one line too long alone: left out
        let lo = 1, hi = end;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (deflate(part(end - mid, end)).length <= room) lo = mid; else hi = mid - 1;
        }
        rev.push(deflate(part(end - lo, end)));
        end -= lo;
    }
    if (!rev.length) rev.push(deflate(['(the log is empty)']));
    return rev.map((z, i) => Buffer.concat([Buffer.from(top(i + 1, rev.length), 'utf8'), z]));
}

/** The code q (qr.encode) as big as the picture allows, black on white with its quiet zone, and the help on the right.
 * info: { page, pages, size (label) } */
function drawCode(c, q, info) {
    const H = c.h;
    c.clear('#000000');
    const n = q.size + 8, dev = Math.max(1, Math.floor((H - 16) / n)), side = dev * n;
    const ox = 40, oy = Math.round((H - side) / 2);
    c.fillRect(ox, oy, side, side, '#ffffff');
    for (let y = 0; y < q.size; y++) {
        for (let x = 0; x < q.size;) {
            if (!q.get(x, y)) { x++; continue; }
            let e = x;
            while (e < q.size && q.get(e, y)) e++;
            c.fillRect(ox + (x + 4) * dev, oy + (y + 4) * dev, (e - x) * dev, dev, '#000000');
            x = e;
        }
    }
    const tx = ox + side + 60, o = { literal: true };
    c.text('Speed Limit log', tx, 90, 40, '#ffffff', Object.assign({ font: 'bold' }, o));
    c.text('Code ' + info.page + ' of ' + info.pages + '   (size: ' + info.size + ')', tx, 145, 30, '#ffffff', o);
    ['Take a photo of every code and send the', 'photos with your report (GitHub issue).', 'Code 1 has the newest lines.', '',
        'Hard to scan? Size: Large. More lines', 'in each code? Size: Small (hold steady).']
        .forEach((h, i) => c.text(h, tx, 215 + i * 38, 26, '#b4bcc8', o));
}

module.exports = { logText, pages, drawCode, SIZES, ORDER };
