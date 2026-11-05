'use strict';
/**
 * dtc_text.js - what a stored fault code means, for the AI (instead of a bare hex code).
 *
 * The fault text database (dtc_db.pack) and the lookup order are those of the Fault Scanner app in
 * cauliflowermossgrape/idrive7-apps (apps/dtc_scanner), MIT License:
 *   Copyright (c) 2026 cauliflowermossgrape
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 *   associated documentation files, to deal in the Software without restriction, subject to: the above
 *   copyright notice and this permission notice shall be included in all copies or substantial portions.
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 *
 * A lookup inflates only the few KB that hold its code (kit/runtime/pack.js); nothing is read before
 * a fault is described. The text for exactly the unit's type wins, so a unit with faults is asked
 * once for its type (UDS 22 F150, see unitTypes in main.js); without it the text every type at that
 * address agrees on is used, and a code with several possible texts says so instead of guessing.
 *
 *   const T = require('./dtc_text');
 *   T.describe(0x12, '2A82', ids)   // -> 'VANOS, intake: ...' or null     ids = { '12': '0F26E8' }
 *   T.unitName(0x12, ids)            // -> 'Engine electronics' (the database's name for that type)
 *   T.hasDb                          // false without dtc_db.pack (then codes stay codes)
 */
const path = require('path');

const hex = (n, w) => n.toString(16).toUpperCase().padStart(w || 2, '0');
let DB = null, SGBD = {}, UNIT_NAMES = {}, OWN = {};
try {
    DB = require('./kit/pack').open(path.join(__dirname, 'dtc_db'));
    SGBD = DB.json('sgbd_index.json');
    UNIT_NAMES = DB.json('unit_names.json');
} catch (e) { DB = null; }
try { OWN = require('./known_texts'); } catch (e) { OWN = {}; }
const get = (file, key) => { try { return DB ? DB.get(file, key) : null; } catch (e) { return null; } };
const text = (key) => OWN[key] || get('dtc_texts.json', key);
const ascii = (s) => String(s).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').replace(/[\x00-\x1f\x7f]/g, '').trim();
const FAMILY = {
    '23:D1C604': 'Assist sensors: Unexpected Ethernet communication/link',
    '61:03178A': 'Telematics: Mobile network connection limited',
};

/** the unit's type name (SGBD) from its F150 index, or null */
function variant(addr, ids) {
    const idx = ids && ids[hex(addr)];
    const v = idx ? SGBD[hex(addr) + ' ' + idx] : null;
    return v && /^[A-Za-z0-9_]+$/.test(v) ? v : null;
}

function describe(addr, rawCode, ids) {
    const code = String(rawCode).trim().toUpperCase().replace(/^0X/, '').padStart(6, '0');
    const key = hex(addr) + ':' + code;
    const own = text(key);
    if (own) return ascii(own);
    const v = variant(addr, ids);
    const iv = (v && get('tables/variant/' + v.toLowerCase() + '.json', code)) || get('tables/addr/' + hex(addr) + '.json', code);
    if (iv) return ascii(iv);
    const t = (v && get('texts/' + v + '.json', code)) || text('*:' + code);
    if (t) return ascii(t);
    const c = get('code_texts.json', code);
    const ct = (typeof c === 'string' ? c : c && c[hex(addr)]) || get('tables/codes.json', code) || FAMILY[key];
    if (ct) return ascii(ct);
    const n = get('tables/ambiguous.json', code);
    return n > 0 ? n + ' possible texts (depends on the unit type)' : null;
}

/** the database's name for the unit's type, or null */
function unitName(addr, ids) {
    const v = variant(addr, ids);
    return v && UNIT_NAMES[v] ? ascii(UNIT_NAMES[v]) : null;
}

module.exports = { describe, unitName, hasDb: !!DB && Object.keys(SGBD).length > 0 };
