'use strict';
/**
 * fixes.js - the driver's own corrections of the map's limits, made in the car on the app's page. Node 8.
 *
 *   const fixes = new Fixes(file, log);      file: data/corrections.json (kept by app updates and new maps)
 *   fixes.get(way)                           { f, b } km/h along / against the way's pieces (0: not corrected), or undefined
 *   fixes.set(way, f, b, where)              where: { lat, lon } (for the log and the file: a person can find the road)
 *   fixes.remove(way)  fixes.undo()  fixes.clear()  fixes.count
 *
 * A correction belongs to an OpenStreetMap road (its way id) and a direction, not to a place in the map file: a new
 * map (a new georgia.pack) keeps them. The file is read once when the app starts and written only when a correction
 * changes (whole or not at all: the head unit loses power at every switch-off). Lookups are a Map: nothing per tick.
 */
const fs = require('fs');

/** The file whole or not at all: a temp file beside it, renamed over it (as the kit's write_whole.js). */
function writeWhole(file, text) {
    const tmp = file + '.' + process.pid + '.tmp';
    try { fs.writeFileSync(tmp, text, 'utf8'); fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { /* not there */ } throw e; }
}

class Fixes {
    constructor(file, log) {
        this.file = file;
        this.log = log;
        this.list = [];             // in the order they were made: { way, f, b, lat, lon, at } (undo takes the last)
        this.map = new Map();
        try {
            const j = JSON.parse(fs.readFileSync(file, 'utf8'));
            (j && Array.isArray(j.roads) ? j.roads : []).forEach((r) => {
                if (r && r.way > 0 && (r.f >= 0 && r.f <= 250) && (r.b >= 0 && r.b <= 250)) this._put(r);
            });
        } catch (e) { if (e.code !== 'ENOENT' && log) log.warn('corrections: ' + e.message + ' (starting without them)'); }
    }

    get count() { return this.list.length; }
    get(way) { return this.map.get(way); }

    _put(r) {
        const o = { way: r.way, f: r.f | 0, b: r.b | 0, lat: r.lat, lon: r.lon, at: r.at };
        this.list = this.list.filter((x) => x.way !== o.way);
        this.list.push(o);
        this.map.set(o.way, o);
    }

    set(way, f, b, where) {
        const w = where || {};
        this._put({ way, f, b, lat: w.lat != null ? +w.lat.toFixed(5) : null, lon: w.lon != null ? +w.lon.toFixed(5) : null, at: new Date().toISOString().slice(0, 16) });
        this._save('set way ' + way + ' ' + f + '/' + b + (w.lat != null ? ' at ' + w.lat.toFixed(5) + ',' + w.lon.toFixed(5) : ''));
    }

    remove(way, why) {
        if (!this.map.has(way)) return false;
        this.map.delete(way);
        this.list = this.list.filter((x) => x.way !== way);
        this._save('removed way ' + way + (why ? ' (' + why + ')' : ''));
        return true;
    }

    undo() {
        const last = this.list[this.list.length - 1];
        return last ? this.remove(last.way, 'undo') : false;
    }

    clear() {
        if (!this.list.length) return false;
        const n = this.list.length;
        this.list = []; this.map.clear();
        this._save('cleared ' + n);
        return true;
    }

    _save(what) {
        if (this.log) this.log.info('correction: ' + what);
        try { writeWhole(this.file, JSON.stringify({ version: 1, roads: this.list }, null, 1)); } catch (e) { if (this.log) this.log.warn('corrections: not saved: ' + e.message); }
    }
}

module.exports = { Fixes };
