/*
 * carlink.js - the phone side of the car link, shared by the pages (index, pair, copilot).
 *
 * Security model
 *   - Each car app pairing has a channel on ntfy.sh (a public relay) and a 256-bit key K that
 *     only the car and the QR code's #k= fragment carry. The fragment never leaves the phone
 *     (browsers don't send it), and it is removed from the address bar as soon as it is read.
 *   - K is imported into WebCrypto as NON-EXTRACTABLE keys and kept in IndexedDB: pages can
 *     use them to encrypt for / decrypt from the car, but no script can read the key bytes
 *     back out, not even one running on this origin.
 *   - phone -> car: AES-256-GCM with K. car -> phone: AES-256-GCM with HKDF-SHA256(K,
 *     "idrive7 car->phone v1"), so neither side can be fooled by its own messages.
 *   - Every message carries its send time and a random nonce inside the encryption; one whose
 *     send time is far from when the relay received it (a re-post) or seen before is dropped.
 *   - Nothing unauthenticated from the channel changes what the page shows or does.
 *   - Pairing links are accepted only for this site's own pages with a well-formed channel
 *     and key; a scanned QR code can't send the phone anywhere else.
 */
(function () {
    'use strict';

    // a page shown inside another site's frame could be clicked through without the user knowing
    if (window.top !== window.self) {
        document.documentElement.style.display = 'none';
        try { window.top.location = window.self.location.href; } catch (e) { /* a sandboxed frame stays blank */ }
    }

    const APPS = {
        spotify: { prefix: 'bmw_spot_', page: 'pair.html', name: 'Spotify', toCar: 'spotify_encrypted', fromCar: 'spotify_car' },
        copilot: { prefix: 'bmw_copilot_', page: 'copilot.html', name: 'M-Copilot', toCar: 'copilot_encrypted', fromCar: 'copilot_car' },
    };
    const RELAY = 'https://ntfy.sh/';
    const FRESH_MS = 15 * 60 * 1000;
    const C2P_INFO = 'idrive7 car->phone v1';
    const DB_NAME = 'idrive7-link', STORE = 'cars';

    const enc = new TextEncoder(), dec = new TextDecoder();
    const toHex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
    const fromHex = (h) => new Uint8Array(h.match(/.{2}/g).map((b) => parseInt(b, 16)));
    const randomHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));
    const b64u = (buf) => btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const fromB64u = (s) => {
        const t = s.replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(t + '==='.slice((t.length + 3) % 4));
        return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    };

    function appOf(channel) {
        if (typeof channel !== 'string') return null;
        for (const id of Object.keys(APPS)) {
            const p = APPS[id].prefix;
            if (channel.length === p.length + 24 && channel.indexOf(p) === 0 && /^[0-9a-f]{24}$/.test(channel.slice(p.length))) return id;
        }
        return null;
    }
    const validChannel = (channel, app) => appOf(channel) !== null && (!app || appOf(channel) === app);
    const validKeyHex = (k) => typeof k === 'string' && /^[0-9a-f]{64}$/i.test(k);
    function shortCode(channel) {
        const app = appOf(channel);
        if (!app) return '--------';
        const raw = channel.slice(APPS[app].prefix.length).toUpperCase();
        return raw.slice(0, 4) + '-' + raw.slice(4, 8);
    }

    // ---------- storage: IndexedDB with non-extractable CryptoKeys (memory only when it is missing) ----------
    const memory = new Map();
    let dbPromise = null;
    function db() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve) => {
            let req;
            try { req = indexedDB.open(DB_NAME, 1); } catch (e) { resolve(null); return; }
            req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'channel' }); };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        });
        return dbPromise;
    }
    function tx(mode, fn) {
        return db().then((d) => new Promise((resolve, reject) => {
            if (!d) { resolve(fn(null)); return; }
            const t = d.transaction(STORE, mode), s = t.objectStore(STORE);
            let out;
            Promise.resolve(fn(s)).then((r) => { out = r; });
            t.oncomplete = () => resolve(out);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error);
        }));
    }
    const reqP = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

    function getCar(channel) {
        if (!validChannel(channel)) return Promise.resolve(null);
        return tx('readonly', (s) => (s ? reqP(s.get(channel)) : memory.get(channel) || null)).then((c) => c || memory.get(channel) || null, () => memory.get(channel) || null);
    }
    function putCar(car) {
        memory.set(car.channel, car);
        return tx('readwrite', (s) => (s ? reqP(s.put(car)) : null)).then(() => car, () => car);
    }
    /**
     * The cars of My cars: only confirmed ones (a send went through, or the car answered that it
     * is paired). A pending car (QR scanned, not connected yet) older than PENDING_MS is dropped.
     */
    const PENDING_MS = 60 * 60 * 1000;
    function listCars(opts) {
        return tx('readonly', (s) => (s ? reqP(s.getAll()) : Array.from(memory.values())))
            .then((all) => (all || []).filter((c) => c && appOf(c.channel)), () => Array.from(memory.values()))
            .then((all) => {
                all.filter((c) => c.pending && Date.now() - (c.added || 0) > PENDING_MS).forEach((c) => forgetCar(c.channel));
                return all.filter((c) => (opts && opts.all) || !c.pending).sort((a, b) => (b.added || 0) - (a.added || 0));
            });
    }
    /** The car is connected for real: keep it in My cars. */
    function confirmCar(channel) {
        return getCar(channel).then((c) => {
            if (!c || !c.pending) return c;
            c.pending = false;
            return putCar(c);
        });
    }
    function forgetCar(channel) {
        memory.delete(channel);
        return tx('readwrite', (s) => (s ? reqP(s.delete(channel)) : null)).catch(() => {});
    }
    function updateInfo(channel, patch) {
        return getCar(channel).then((c) => {
            if (!c) return null;
            c.info = Object.assign({}, c.info || {}, patch);
            return putCar(c);
        });
    }

    /** Import a car's key (hex) as two non-extractable keys and keep the car. */
    async function saveCar(channel, keyHex) {
        const app = appOf(channel);
        if (!app || !validKeyHex(keyHex) || !(window.crypto && crypto.subtle)) return null;
        let raw = fromHex(keyHex.toLowerCase());
        const toCar = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
        const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
        const fromCar = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(C2P_INFO) },
            base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
        raw.fill(0);
        raw = null;
        const old = await getCar(channel);
        // new cars wait for proof of a connection (confirmCar) before they show in My cars
        const pending = old ? !!old.pending : true;
        return putCar({ channel, app, code: shortCode(channel), added: (old && old.added) || Date.now(), pending, toCar, fromCar, info: (old && old.info) || {} });
    }

    /** Keys the older pages left in local/session storage: moved into IndexedDB and wiped. */
    async function migrateLegacy() {
        const moves = [];
        [[window.localStorage, 'bmw_spot_k_'], [window.sessionStorage, 'bmw_spot_k_'], [window.sessionStorage, 'copilot_k_']].forEach(([st, pre]) => {
            try {
                for (let i = st.length - 1; i >= 0; i--) {
                    const name = st.key(i);
                    if (name && name.indexOf(pre) === 0) {
                        const ch = name.slice(pre.length), k = st.getItem(name);
                        st.removeItem(name);
                        if (validChannel(ch) && validKeyHex(k)) moves.push([ch, k]);
                    }
                }
            } catch (e) { /* storage blocked */ }
        });
        // these were real pairings of the older pages
        for (const [ch, k] of moves) { try { await saveCar(ch, k); await confirmCar(ch); } catch (e) { /* skip */ } }
    }

    /**
     * The page's car from its address: ?channel=... (or the OAuth state) and, from a QR code,
     * #k=<key>, which is stored and then removed from the address bar and history entry.
     */
    async function carFromAddress(app, channel) {
        await migrateLegacy();
        const hash = window.location.hash || '';
        if (hash.indexOf('#k=') === 0) {
            const k = hash.slice(3).trim();
            history.replaceState(history.state, document.title, window.location.pathname + window.location.search);
            if (validChannel(channel, app) && validKeyHex(k)) await saveCar(channel, k);
        }
        return validChannel(channel, app) ? getCar(channel) : null;
    }

    /** A scanned / pasted pairing link -> { app, channel, key, page } when it is one of ours, else null. */
    function parsePairingLink(text) {
        let u;
        try { u = new URL(String(text).trim()); } catch (e) { return null; }
        const here = new URL('.', window.location.href);
        const official = new URL('https://hexlay.github.io/idrive7-custom-apps/');
        const dirOk = (u.origin === here.origin && u.pathname.indexOf(here.pathname) === 0) || (u.origin === official.origin && u.pathname.indexOf(official.pathname) === 0);
        const secure = u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1';
        if (!dirOk || !secure) return null;
        const file = u.pathname.split('/').pop();
        const channel = u.searchParams.get('channel') || '';
        const app = appOf(channel);
        const k = u.hash.indexOf('#k=') === 0 ? u.hash.slice(3) : '';
        if (!app || APPS[app].page !== file || !validKeyHex(k)) return null;
        return { app, channel, key: k.toLowerCase(), page: APPS[app].page };
    }

    // ---------- messages ----------
    const seenIv = new Set();

    async function sealForCar(car, obj) {
        if (!car || !car.toCar) return null;
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const body = Object.assign({}, obj, { time: Date.now(), n: randomHex(8) });
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, car.toCar, enc.encode(JSON.stringify(body))));
        return { type: APPS[car.app].toCar, iv: toHex(iv), tag: toHex(ct.slice(-16)), data: toHex(ct.slice(0, -16)) };
    }

    /** A relay item ({ message, time }) from the car -> the decrypted object, or null (not for us / not authentic / stale). */
    async function openFromCar(car, item) {
        if (!car || !car.fromCar || !item || typeof item.message !== 'string' || item.message.length > 8192) return null;
        let w;
        try { w = JSON.parse(item.message); } catch (e) { return null; }
        if (!w || w.type !== APPS[car.app].fromCar || typeof w.iv !== 'string' || typeof w.tag !== 'string' || typeof w.data !== 'string') return null;
        if (!/^[0-9a-f]{24}$/i.test(w.iv) || !/^[0-9a-f]{32}$/i.test(w.tag) || !/^([0-9a-f]{2})*$/i.test(w.data)) return null;
        let obj;
        try {
            const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(w.iv), tagLength: 128 }, car.fromCar, fromHex(w.data + w.tag));
            obj = JSON.parse(dec.decode(pt));
        } catch (e) { return null; }
        if (!obj || typeof obj !== 'object' || typeof obj.time !== 'number' || typeof obj.type !== 'string') return null;
        if (typeof item.time !== 'number' || Math.abs(obj.time - item.time * 1000) > FRESH_MS) return null;
        const id = car.channel + ':' + w.iv.toLowerCase();
        if (seenIv.has(id)) return null;
        seenIv.add(id);
        return obj;
    }

    /** Encrypt obj for the car and post it; resolves true when the relay took it. */
    /**
     * Encrypt obj for the car and post it; resolves true when the relay took it. The relay can be
     * briefly unreachable (Safari: "Load failed"), so a network error, 429 or 5xx is tried again,
     * 3 attempts over about 6 s. A repeat that did arrive is harmless: the car keeps the newest.
     */
    async function sendToCar(car, obj, title) {
        const wire = await sealForCar(car, obj);
        if (!wire) return false;
        const body = JSON.stringify(wire);
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt) await new Promise((r) => setTimeout(r, attempt === 1 ? 1500 : 4000));
            try {
                // a plain POST with a text body and no custom headers: no CORS preflight, so one
                // request instead of two (a rate-limited preflight is what made Safari say "Load failed")
                const res = await fetch(RELAY + car.channel, { method: 'POST', body, referrerPolicy: 'no-referrer' });
                if (res.ok) return true;
                if (res.status !== 429 && res.status < 500) return false;
            } catch (e) { /* unreachable: try again */ }
        }
        return false;
    }
    const RELAY_DOWN = 'Couldn\'t reach the relay (ntfy.sh) after 3 tries, so nothing was sent. Check the phone\'s internet connection and tap again.';

    /** Live messages from the car: onMsg(obj) for each authentic one. Returns a stop function. */
    function listen(car, onMsg) {
        let es;
        try { es = new EventSource(RELAY + car.channel + '/sse'); } catch (e) { return () => {}; }
        es.onmessage = (e) => {
            let item;
            try { item = JSON.parse(e.data); } catch (x) { return; }
            if (!item || item.event !== 'message') return;
            openFromCar(car, item).then((o) => { if (o) onMsg(o); });
        };
        return () => { try { es.close(); } catch (e) { /* closed */ } };
    }

    /** The car's messages the relay still keeps (up to 12 hours), oldest first, decrypted. */
    async function recent(car) {
        const res = await fetch(RELAY + car.channel + '/json?poll=1&since=12h', { referrerPolicy: 'no-referrer' });
        if (!res.ok) return [];
        const out = [];
        for (const line of (await res.text()).split('\n')) {
            if (!line.trim()) continue;
            let item;
            try { item = JSON.parse(line); } catch (e) { continue; }
            if (item && item.event === 'message') {
                const o = await openFromCar(car, item);
                if (o) out.push(o);
            }
        }
        return out;
    }

    /**
     * The car's last word about the pairing among its recent messages: 'unpaired' (it disconnected:
     * this entry's channel and key are dead), 'paired' (an ack or hello since), or null (nothing kept).
     */
    function lastWord(msgs) {
        let w = null;
        (msgs || []).forEach((m) => {
            if (m && m.type === 'unpaired') w = 'unpaired';
            else if (m && (m.type === 'pair_ack' || (m.type === 'car_hello' && m.paired === true))) w = 'paired';
        });
        return w;
    }
    /** Drop a car that disconnected while this page was closed (the relay keeps 12 hours). True if dropped. */
    async function dropIfUnpaired(car) {
        const msgs = await recent(car).catch(() => []);
        if (lastWord(msgs) !== 'unpaired') return false;
        await forgetCar(car.channel);
        return true;
    }

    /** Wait (up to ms) for a message from the car of one of these types. */
    function waitFor(car, types, ms) {
        return new Promise((resolve) => {
            let stop = null;
            const timer = setTimeout(() => { if (stop) stop(); resolve(null); }, ms);
            stop = listen(car, (o) => {
                if (types.indexOf(o.type) < 0) return;
                clearTimeout(timer);
                stop();
                resolve(o);
            });
        });
    }

    // ---------- QR scanner ----------
    const carlinkSrc = document.currentScript ? document.currentScript.src : window.location.href;

    /**
     * Scan QR codes with the camera into <video> video; onText(text) for each code read (return
     * true to stop). Returns { stop }. Rejects when there is no camera / permission.
     */
    async function startScanner(video, onText) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser has no camera access.');
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        video.srcObject = stream;
        video.setAttribute('playsinline', '');
        video.muted = true;
        await video.play();
        let detector = null, decode = null, stopped = false;
        if ('BarcodeDetector' in window) {
            try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; }
        }
        if (!detector) {
            if (!window.jsQR) {
                await new Promise((resolve, reject) => {
                    const s = document.createElement('script');
                    s.src = new URL('vendor/jsQR-1.4.0.js', carlinkSrc).href;
                    s.onload = resolve;
                    s.onerror = () => reject(new Error('could not load the QR decoder'));
                    document.head.appendChild(s);
                });
            }
            const canvas = document.createElement('canvas'), g = canvas.getContext('2d', { willReadFrequently: true });
            decode = () => {
                const w = video.videoWidth, h = video.videoHeight;
                if (!w || !h) return null;
                const scale = Math.min(1, 720 / Math.max(w, h));
                canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
                g.drawImage(video, 0, 0, canvas.width, canvas.height);
                const img = g.getImageData(0, 0, canvas.width, canvas.height);
                const r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
                return r ? r.data : null;
            };
        }
        const stop = () => {
            stopped = true;
            stream.getTracks().forEach((t) => t.stop());
            video.srcObject = null;
        };
        const tick = async () => {
            if (stopped) return;
            let text = null;
            try {
                if (detector) { const codes = await detector.detect(video); text = codes && codes[0] ? codes[0].rawValue : null; } else text = decode();
            } catch (e) { text = null; }
            if (text && onText(text)) { stop(); return; }
            setTimeout(tick, 200);
        };
        tick();
        return { stop };
    }

    // ---------- notifications (Web Push) ----------
    const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
    const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
    const swUrl = () => new URL('sw.js', carlinkSrc).href;
    // one service worker registration per car (its own scope), so each car's push key has its own subscription
    const scopeFor = (car) => new URL('n/' + car.channel + '/', carlinkSrc).href;

    async function pushSubscription(car) {
        if (!pushSupported()) return null;
        const reg = await navigator.serviceWorker.getRegistration(scopeFor(car));
        return reg ? reg.pushManager.getSubscription() : null;
    }

    // the car's worker controls no page, so navigator.serviceWorker.ready never fires for it
    function activeWorker(reg) {
        if (reg.active) return Promise.resolve(reg.active);
        const w = reg.installing || reg.waiting;
        if (!w) return Promise.reject(new Error('The notification worker did not start.'));
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('The notification worker did not start.')), 15000);
            w.addEventListener('statechange', () => {
                if (w.state === 'activated') { clearTimeout(t); resolve(w); }
                if (w.state === 'redundant') { clearTimeout(t); reject(new Error('The notification worker did not start.')); }
            });
        });
    }

    async function subscribePush(car, vapidB64u) {
        const key = fromB64u(vapidB64u);
        if (key.length !== 65 || key[0] !== 4) throw new Error('The car sent an invalid notification key.');
        const reg = await navigator.serviceWorker.register(swUrl(), { scope: scopeFor(car) });
        await activeWorker(reg);
        let sub = await reg.pushManager.getSubscription();
        if (sub) {
            const cur = sub.options && sub.options.applicationServerKey ? b64u(sub.options.applicationServerKey) : null;
            if (cur && cur !== b64u(key)) { await sub.unsubscribe(); sub = null; }
        }
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        return sub.toJSON();
    }

    async function unsubscribePush(car) {
        const reg = pushSupported() ? await navigator.serviceWorker.getRegistration(scopeFor(car)) : null;
        if (!reg) return null;
        const sub = await reg.pushManager.getSubscription();
        const endpoint = sub ? sub.endpoint : null;
        if (sub) await sub.unsubscribe().catch(() => {});
        await reg.unregister().catch(() => {});
        return endpoint;
    }

    // ---------- forgetting a car ----------
    /** What the pages keep about a car besides its key: the paired flags, Copilot's profile, provider and models. */
    function clearPageState(channel) {
        try {
            ['bmw_spot_paired_', 'copilot_paired_', 'copilot_profile_', 'copilot_provider_'].forEach((p) => localStorage.removeItem(p + channel));
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const k = localStorage.key(i);
                if (k && k.indexOf('copilot_model_' + channel + '_') === 0) localStorage.removeItem(k);
            }
        } catch (e) { /* storage blocked */ }
    }

    /**
     * Forget a car on this phone: its notifications, what the pages kept and its key.
     * disconnect: first ask the car to unpair (Spotify logs out, M-Copilot drops its AI key; both
     * make a new QR code). The relay keeps the request 12 h, so a car that is off does it the
     * next time its app reads the channel. Resolves { told }: the relay took the request.
     */
    async function forget(car, disconnect) {
        let told = false;
        const endpoint = await unsubscribePush(car).catch(() => null);
        if (car && car.toCar) {
            try {
                if (disconnect) told = await sendToCar(car, { type: 'phone_unpair' }, 'BMW car link');
                else if (endpoint) await sendToCar(car, { type: 'push_unsubscribe', endpoint }, 'BMW car link');
            } catch (e) { told = false; }
        }
        clearPageState(car.channel);
        await forgetCar(car.channel);
        return { told };
    }

    /** A rough device name for the car's list of phones; nothing that identifies a person. */
    function deviceLabel() {
        const ua = navigator.userAgent;
        if (isIOS()) return /iPad/.test(ua) ? 'iPad' : 'iPhone';
        if (/Android/.test(ua)) return 'Android phone';
        return 'Browser';
    }

    window.CarLink = {
        APPS, appOf, validChannel, validKeyHex, shortCode, randomHex,
        getCar, listCars, confirmCar, forgetCar, forget, clearPageState, saveCar, updateInfo, carFromAddress, migrateLegacy, parsePairingLink, lastWord, dropIfUnpaired,
        sendToCar, RELAY_DOWN, openFromCar, listen, recent, waitFor,
        startScanner,
        isIOS, isStandalone, pushSupported, pushSubscription, subscribePush, unsubscribePush, deviceLabel,
    };
})();
