'use strict';
/**
 * Phone notifications for M-Copilot: the car tells the paired phones about a new warning
 * light (Check Control message) or a service item coming due, as Web Push notifications
 * (kit/webpush.js) sent by the car itself, end-to-end encrypted to each phone's browser.
 *
 *   - Phones subscribe through the encrypted pairing channel (cloud_pair.js): the page asks
 *     for the car's push key ("hello"), makes a browser push subscription for it and sends
 *     the subscription back. Only messages that authenticate with the pairing key count.
 *   - What is kept (data/copilot_push.json, mode 0600): the car's VAPID key pair, the phones'
 *     subscriptions (at most 5) and when each warning / service item was last told. No VIN,
 *     no position, nothing about the driver.
 *   - Unpairing forgets all of it and makes a new key, so an old phone can't be reached
 *     (or reach the car) again.
 *   - Sending needs the car awake and online; what can't go out yet is retried for 12 hours.
 *   - Logs show the push service's host, never a subscription's address (it is a secret).
 */
const fs = require('fs');
const path = require('path');
const wp = require('./kit/webpush');

const MAX_PHONES = 5;
const WARNING_AGAIN_MS = 24 * 3600 * 1000;        // the same warning again after a day at the soonest
const SERVICE_AGAIN_MS = 30 * 24 * 3600 * 1000;   // the same service state again after 30 days
const RATE_WINDOW_MS = 10 * 60 * 1000, RATE_MAX = 6;
const QUEUE_MAX = 20, QUEUE_TTL_MS = 12 * 3600 * 1000, RETRY_MS = 60 * 1000;
const SETTLE_MS = 4000;                           // warning texts arrive just after the warning itself

const clean = (x, n) => String(x === undefined || x === null ? '' : x).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, n || 80);

class PhoneNotifier {
    /**
     * opts: { dataDir, log, request (tls_dates.request), tellPhone(obj, title), version, settleMs (tests) }
     */
    constructor(opts) {
        this.log = opts.log || console;
        this.request = opts.request;
        this.tellPhone = opts.tellPhone;
        this.version = opts.version || '';
        this.settleMs = opts.settleMs !== undefined ? opts.settleMs : SETTLE_MS;
        this.file = path.join(opts.dataDir || __dirname, 'copilot_push.json');
        this.clockOffset = 0;               // real time - car clock, from the relay's / push service's Date
        this.queue = [];
        this.sent = [];                     // send times, for the rate limit
        this.ccPending = null;
        this.retryTimer = null;
        this.state = this._load();
    }

    _load() {
        let s = {};
        try { s = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch (e) { s = {}; }
        if (!wp.validVapidKeys(s.vapid)) s.vapid = null;
        s.phones = Array.isArray(s.phones) ? s.phones.filter((p) => p && wp.checkSubscription(p.sub)) : [];
        s.told = s.told && typeof s.told === 'object' ? s.told : {};
        return s;
    }

    _save() {
        const old = this.now() - 60 * 24 * 3600 * 1000;
        Object.keys(this.state.told).forEach((k) => { if (!(this.state.told[k] > old)) delete this.state.told[k]; });
        try {
            const tmp = this.file + '.tmp-' + process.pid;
            fs.writeFileSync(tmp, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(tmp, this.file);
        } catch (e) {
            this.log.warn('Phone push: could not save: ' + e.message);
        }
    }

    now() { return Date.now() + this.clockOffset; }

    /** A trusted time (ms) seen in an HTTPS Date header: corrects the car's clock for the VAPID token. */
    serverTime(ms) {
        if (typeof ms === 'number' && isFinite(ms)) this.clockOffset = ms - Date.now();
    }

    phoneCount() { return this.state.phones.length; }

    vapidPublicKey() {
        if (!this.state.vapid) {
            this.state.vapid = wp.generateVapidKeys();
            this._save();
        }
        return this.state.vapid.publicKey;
    }

    /** The car's hello to the phone: which app, and the key a push subscription needs. */
    hello() {
        this.tellPhone({ type: 'car_hello', app: 'm_copilot', version: this.version, push: true, vapid: this.vapidPublicKey(), phones: this.phoneCount() }, 'BMW M-Copilot');
    }

    /** A message from the paired phone (already decrypted, fresh and authenticated). */
    onPhoneMessage(m) {
        if (m.type === 'hello_request') { this.hello(); return; }
        if (m.type === 'push_unsubscribe') {
            const before = this.state.phones.length;
            this.state.phones = this.state.phones.filter((p) => p.sub.endpoint !== m.endpoint);
            if (this.state.phones.length !== before) {
                this._save();
                this.log.info('Phone push: a phone turned notifications off (' + this.state.phones.length + ' left)');
            }
            this.tellPhone({ type: 'push_off' }, 'BMW M-Copilot');
            return;
        }
        if (m.type !== 'push_subscribe') return;
        const sub = wp.checkSubscription(m.sub);
        if (!sub) {
            this.log.warn('Phone push: a subscription for an unknown push service was refused');
            this.tellPhone({ type: 'push_error', reason: 'unsupported' }, 'BMW M-Copilot');
            return;
        }
        // the subscription must be for this car's key (the page subscribed with the hello's key)
        if (m.vapid !== this.vapidPublicKey()) {
            this.tellPhone({ type: 'push_error', reason: 'stale_key' }, 'BMW M-Copilot');
            this.hello();
            return;
        }
        const label = clean(m.label, 40);
        const known = this.state.phones.find((p) => p.sub.endpoint === sub.endpoint);
        if (known) {
            if (typeof m.time === 'number' && known.at && m.time < known.at) return;   // an older request
            known.sub = sub; known.label = label; known.at = m.time;
        } else {
            this.state.phones.push({ sub, label, at: m.time });
            while (this.state.phones.length > MAX_PHONES) this.state.phones.shift();
        }
        this._save();
        this.log.info('Phone push: notifications on for a phone via ' + wp.checkEndpoint(sub.endpoint).hostname + ' (' + this.state.phones.length + ' phones)');
        this.tellPhone({ type: 'push_ok', phones: this.state.phones.length }, 'BMW M-Copilot');
        this._sendTo([this.state.phones.find((p) => p.sub.endpoint === sub.endpoint)],
            { title: 'Notifications are on', body: 'Your car will tell this phone about new warning lights and service due.', tag: 'hello' }, { topic: 'hello' });
    }

    /** Unpaired: forget every phone and the key (an old phone can't be reached again). */
    forgetAll() {
        this.state = { vapid: null, phones: [], told: {} };
        this.queue = [];
        this._save();
    }

    /**
     * The active Check Control messages: active (a Map whose keys are the active ids, read again
     * when the notification goes out) and their texts (Map id -> text). A warning is told once a
     * day at most, after a short wait for its text to arrive.
     */
    checkControl(active, names) {
        const idsOf = () => Array.from(active && active.keys ? active.keys() : []);
        const ids = idsOf();
        const fresh = ids.filter((id) => {
            const last = this.state.told['cc:' + id];
            return !last || this.now() - last > WARNING_AGAIN_MS;
        });
        if (!fresh.length || !this.state.phones.length) return;
        if (this.ccPending) return;
        this.ccPending = setTimeout(() => {
            this.ccPending = null;
            const now = idsOf();
            const still = fresh.filter((id) => now.indexOf(id) >= 0);
            if (!still.length) return;
            still.forEach((id) => { this.state.told['cc:' + id] = this.now(); });
            this._save();
            const texts = still.map((id) => clean((names && names.get && names.get(id)) || ('Warning ' + id), 60));
            const body = texts.length === 1 ? texts[0] : texts.slice(0, 4).join(', ') + (texts.length > 4 ? ' and ' + (texts.length - 4) + ' more' : '');
            this.enqueue({ title: texts.length === 1 ? 'Warning in your car' : texts.length + ' warnings in your car', body, tag: 'cc' }, { topic: 'cc', urgency: 'high' });
        }, this.settleMs);
    }

    /** The service list now: [{ name, state: 'OK' | 'due soon' | 'overdue', way, date }]. */
    service(items) {
        if (!Array.isArray(items) || !this.state.phones.length) return;
        const due = items.filter((i) => i && (i.state === 'overdue' || i.state === 'due soon')).filter((i) => {
            const last = this.state.told['svc:' + i.name + ':' + i.state];
            return !last || this.now() - last > SERVICE_AGAIN_MS;
        });
        if (!due.length) return;
        due.forEach((i) => { this.state.told['svc:' + i.name + ':' + i.state] = this.now(); });
        this._save();
        const overdue = due.some((i) => i.state === 'overdue');
        const body = due.slice(0, 4).map((i) => clean(i.name, 40) + ': ' + i.state + (i.way ? ' (' + clean(i.way, 20) + ')' : '')).join(', ');
        this.enqueue({ title: overdue ? 'Service overdue' : 'Service due soon', body, tag: 'svc' }, { topic: 'svc' });
    }

    /** Send to every phone now, or keep it until the car is online (12 h at most). */
    enqueue(note, opts) {
        if (!this.state.phones.length) return;
        this.queue.push({ note, opts: opts || {}, at: this.now() });
        while (this.queue.length > QUEUE_MAX) this.queue.shift();
        this.flush();
    }

    flush() {
        if (this.flushing) return;
        const t = this.now();
        this.queue = this.queue.filter((q) => t - q.at < QUEUE_TTL_MS);
        this.sent = this.sent.filter((s) => t - s < RATE_WINDOW_MS);
        if (!this.queue.length) return;
        if (this.sent.length >= RATE_MAX) { this._retryLater(); return; }
        const q = this.queue[0];
        this.flushing = true;
        this._sendTo(this.state.phones.slice(), q.note, q.opts).then((anyOk) => {
            this.flushing = false;
            if (anyOk || !this.state.phones.length) {
                this.queue.shift();
                this.sent.push(this.now());
                if (this.queue.length) setImmediate(() => this.flush());
            } else {
                this._retryLater();
            }
        });
    }

    _retryLater() {
        if (this.retryTimer) return;
        this.retryTimer = setTimeout(() => { this.retryTimer = null; this.flush(); }, RETRY_MS);
    }

    /** Push to these phones; resolves true when at least one took it. Gone subscriptions are dropped. */
    _sendTo(phones, note, opts) {
        const vapid = this.state.vapid;
        if (!vapid) return Promise.resolve(false);
        const data = { title: clean(note.title, 60), body: clean(note.body, 300), tag: note.tag || 'car', app: 'm_copilot', t: this.now() };
        return Promise.all(phones.filter(Boolean).map((p) => this._sendOne(p, vapid, data, opts, true))).then((r) => r.some(Boolean));
    }

    _sendOne(phone, vapid, data, opts, retry) {
        const host = (wp.checkEndpoint(phone.sub.endpoint) || {}).hostname;
        return wp.send(phone.sub, vapid, data, Object.assign({ request: this.request, now: () => this.now() }, opts)).then((r) => {
            if (r.status === 404 || r.status === 410) {
                this.state.phones = this.state.phones.filter((p) => p !== phone);
                this._save();
                this.log.info('Phone push: a phone\'s subscription has ended (' + host + '): forgotten');
                return false;
            }
            // 401 / 403: most likely the car's clock made the token look expired; the service's Date fixes it
            if ((r.status === 401 || r.status === 403) && retry && r.date) {
                this.serverTime(r.date);
                return this._sendOne(phone, vapid, data, opts, false);
            }
            if (r.status >= 200 && r.status < 300) return true;
            this.log.warn('Phone push: ' + host + ' answered ' + r.status);
            return false;
        }, (e) => {
            this.log.warn('Phone push: ' + (host || 'push service') + ': ' + e.message);
            return false;
        });
    }

    stop() {
        if (this.ccPending) { clearTimeout(this.ccPending); this.ccPending = null; }
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    }
}

module.exports = { PhoneNotifier };
