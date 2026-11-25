'use strict';
/**
 * Spotify - native BMW iDrive 7 (MGU) Spotify Connect library & playlist browser.
 *
 * Operational Rules:
 *   1. Default Mode: Starts in Online Mode by default.
 *   2. Network Safeguard: In Online Mode, verifies active internet connectivity to Spotify.
 *      If offline, app is disabled with a high-contrast "No Internet Connection" lock screen.
 *   3. Connection Requirement: In Online Mode, requires authenticated personal account.
 *      Gates the player until paired; defaults to Connect tab on first launch.
 *   4. Real Cloud Pairing (No 127.0.0.1): Uses a real cloud pairing relay so any phone on
 *      4G, 5G, or Wi-Fi can scan the QR code and pair directly with Spotify OAuth.
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { SpotifyClient, DEMO_PLAYLISTS } = require('./api');
const { CloudPairManager } = require('./cloud_pair');
const { AlbumArtManager, ART_IMG_ID, ART_GROUND_ID, ART_QUEUE_ID } = require('./art');
const S = require('./kit/scene');
const qrcodegen = require('./kit/qrcodegen');

const W = 1600, H = 520;
const PAGES = ['Playlists', 'Liked Songs', 'Now Playing', 'Connect'];

/*
 * Sizes on this display (kit/runtime/panel.js): k = 1.2 on a 12.3" display, 1.44 on a 10.25" one, so rows,
 * buttons and text come out the same size in millimetres on both (as CarPlay sizes its own). sz(cv, n): n at
 * the reference size (k = 1), rounded.
 */
const kOf = (cv) => (cv.ui && cv.ui.k) || 1.44;
const sz = (cv, n) => Math.round(n * kOf(cv));
/** List & dock vertical metrics (adapts to panel scale k and full-screen extra height). */
function metrics(cv) {
    const ex = cv.extra || 0, dockH = sz(cv, 56);
    const dockY = 512 + ex - dockH;
    return {
        dockH, dockY,
        panelH: dockY - 6 - 44,                 // the panels over the dock
        listTop: 98, listBottom: dockY - 14,     // where rows go inside a panel over the dock
    };
}

// Format milliseconds as MM:SS
function fmtTime(ms) {
    if (!ms || ms < 0) return '0:00';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return m + ':' + (rem < 10 ? '0' : '') + rem;
}

// Format total playlist runtime (e.g. "27 min" or "1 hr 14 min")
function fmtTotalRuntime(tracks) {
    if (!Array.isArray(tracks) || !tracks.length) return '';
    let totalMs = 0;
    for (let i = 0; i < tracks.length; i++) totalMs += (tracks[i] && tracks[i].durationMs) || 0;
    if (totalMs <= 0) return '';
    const mins = Math.max(1, Math.round(totalMs / 60000));
    if (mins < 60) return mins + ' min';
    const hrs = Math.floor(mins / 60), rem = mins % 60;
    return rem ? hrs + ' hr ' + rem + ' min' : hrs + ' hr';
}

/** A thin scrollbar (kit scene.js): a tap on its upper or lower half scrolls up or down. */
function drawScrollbar(cv, t, x, y, h, total, visibleCount, scrollOffset, onScrollUp, onScrollDown) {
    if (total <= visibleCount) return;
    S.scrollbar(cv, t, x, y, h, total, visibleCount, scrollOffset);
    if (onScrollUp) cv.target(x - 14, y, 30, Math.floor(h / 2), onScrollUp, 'sb_up_' + x, 3);
    if (onScrollDown) cv.target(x - 14, y + Math.floor(h / 2), 30, Math.ceil(h / 2), onScrollDown, 'sb_down_' + x, 3);
}

// Mini animated equalizer icon for list rows (4 bars)
function drawMiniEqualizer(cv, cx, cy, col, isPlaying, seed) {
    const bars = 4;
    const barW = 3.5;
    const gap = 2.5;
    const totalW = bars * barW + (bars - 1) * gap;
    const startX = cx - totalW / 2;
    for (let i = 0; i < bars; i++) {
        let h;
        if (isPlaying) {
            const phase = seed * 3.2 + i * 1.8;
            h = Math.round(Math.abs(Math.sin(phase)) * 14 + 6);
        } else {
            h = [8, 14, 18, 10][i];
        }
        const bx = startX + i * (barW + gap);
        cv.roundRect(bx, cy - h / 2, barW, h, 1.5, col);
    }
}

// Helper to draw anti-aliased triangles across Recorder and Canvas
function drawTriangle(cv, p0, p1, p2, col) {
    if (cv.triangle) {
        cv.triangle([p0, p1, p2], col);
    } else {
        cv.quad([p0, p1, p2, p2], col);
    }
}

// Vector transport icon drawing helpers
function drawPlayIcon(cv, cx, cy, sz, col) {
    const hw = sz * 0.46, hh = sz * 0.52;
    drawTriangle(cv,
        [cx - hw * 0.7, cy - hh],
        [cx + hw * 1.15, cy],
        [cx - hw * 0.7, cy + hh],
        col
    );
}

function drawPauseIcon(cv, cx, cy, sz, col) {
    const barW = Math.max(3, Math.round(sz * 0.26));
    const barH = Math.round(sz * 0.95);
    const gap = Math.max(3, Math.round(sz * 0.28));
    cv.roundRect(cx - gap / 2 - barW, cy - barH / 2, barW, barH, Math.min(barW / 2, 2), col);
    cv.roundRect(cx + gap / 2, cy - barH / 2, barW, barH, Math.min(barW / 2, 2), col);
}

function drawNextIcon(cv, cx, cy, sz, col) {
    const tw = sz * 0.52, th = sz * 0.46;
    const barW = Math.max(3, Math.round(sz * 0.18));
    const gap = Math.max(3, Math.round(sz * 0.14));
    const totalW = tw + gap + barW;
    const left = cx - totalW / 2;
    drawTriangle(cv,
        [left, cy - th],
        [left + tw, cy],
        [left, cy + th],
        col
    );
    cv.roundRect(left + tw + gap, cy - th, barW, th * 2, Math.min(barW / 2, 2), col);
}

function drawPrevIcon(cv, cx, cy, sz, col) {
    const tw = sz * 0.52, th = sz * 0.46;
    const barW = Math.max(3, Math.round(sz * 0.18));
    const gap = Math.max(3, Math.round(sz * 0.14));
    const totalW = tw + gap + barW;
    const left = cx - totalW / 2;
    cv.roundRect(left, cy - th, barW, th * 2, Math.min(barW / 2, 2), col);
    drawTriangle(cv,
        [left + barW + gap + tw, cy - th],
        [left + barW + gap, cy],
        [left + barW + gap + tw, cy + th],
        col
    );
}

/** A smooth S from (x0,y0) to (x1,y1): flat at both ends (a cubic ease), as points for a polyline. */
function sCurve(x0, y0, x1, y1, n) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const u = i / n, e = u * u * (3 - 2 * u);
        pts.push([x0 + (x1 - x0) * u, y0 + (y1 - y0) * e]);
    }
    return pts;
}

/** An arrowhead (open chevron) at (x,y) pointing along angle dir (radians, 0 = right). */
function drawArrowHead(cv, x, y, dir, len, width, col) {
    [2.45, -2.45].forEach((a) => {
        cv.line(x, y, x + Math.cos(dir + a) * len, y + Math.sin(dir + a) * len, width, col);
    });
    cv.circle(x, y, width / 2, col);
}

function drawShuffleIcon(cv, cx, cy, sz, col) {
    const w = sz, h = sz * 0.56, lw = Math.max(2, sz * 0.1);
    const x0 = cx - w / 2, x1 = cx + w / 2 - lw;
    const y0 = cy - h / 2, y1 = cy + h / 2;
    const run = w * 0.18;                       // flat lead-in and lead-out
    // top-left to bottom-right, and bottom-left to top-right, crossing in the middle
    cv.polyline([[x0, y0]].concat(sCurve(x0 + run, y0, x1 - run, y1, 14), [[x1, y1]]), lw, col);
    cv.polyline([[x0, y1]].concat(sCurve(x0 + run, y1, x1 - run, y0, 14), [[x1, y0]]), lw, col);
    const ah = sz * 0.26;
    drawArrowHead(cv, x1 + lw * 0.4, y0, 0, ah, lw, col);
    drawArrowHead(cv, x1 + lw * 0.4, y1, 0, ah, lw, col);
}

function drawRepeatIcon(cv, cx, cy, sz, col, mode) {
    const w = sz, h = sz * 0.62, lw = Math.max(2, sz * 0.1);
    const r = h * 0.42, hl = lw / 2;
    const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
    // a rounded loop, open at the top right where the arrow points into it
    cv.line(x0 + r, y0, x1 - r - sz * 0.22, y0, lw, col);                  // top (stops at the gap)
    cv.arc(x1 - r, y0 + r, r - hl, r + hl, 0, 90, col);                    // top-right corner
    cv.line(x1, y0 + r, x1, y1 - r, lw, col);
    cv.arc(x1 - r, y1 - r, r - hl, r + hl, 90, 180, col);
    cv.line(x1 - r, y1, x0 + r + sz * 0.22, y1, lw, col);                  // bottom (gap at the left)
    cv.arc(x0 + r, y1 - r, r - hl, r + hl, 180, 270, col);
    cv.line(x0, y1 - r, x0, y0 + r, lw, col);
    cv.arc(x0 + r, y0 + r, r - hl, r + hl, 270, 360, col);
    const ah = sz * 0.24;
    drawArrowHead(cv, x1 - r - sz * 0.22 + ah * 0.5, y0, 0, ah, lw, col);
    drawArrowHead(cv, x0 + r + sz * 0.22 - ah * 0.5, y1, Math.PI, ah, lw, col);
    if (mode === 'track') {
        // repeat one: a small "1" badge on the loop
        cv.circle(x1, y0, sz * 0.3, col);
        cv.text('1', x1, y0 + sz * 0.13, Math.round(sz * 0.38), '#000000', { align: 'center', font: 'bold' });
    }
}

/** A heart: two lobes and a point, filled, or as an outline. */
function drawHeartIcon(cv, cx, cy, sz, col, filled) {
    const r = sz * 0.27, d = r * 0.9;
    const ly = cy - sz * 0.5 + r + sz * 0.06;          // the lobes' centres
    const tipY = ly + d + 1.414 * r;
    const dip = ly - Math.sqrt(r * r - d * d);
    const lT = [cx - d - 0.707 * r, ly + 0.707 * r], rT = [cx + d + 0.707 * r, ly + 0.707 * r];
    if (filled) {
        cv.circle(cx - d, ly, r, col);
        cv.circle(cx + d, ly, r, col);
        cv.quad([lT, [cx, dip], rT, [cx, tipY]], col);
        return;
    }
    const lw = Math.max(2, sz * 0.1), hl = lw / 2;
    const tA = Math.atan2(d, ly - dip) * 180 / Math.PI;       // where the lobes meet, from each centre
    cv.arc(cx - d, ly, r - hl, r + hl, 225, 360, col);
    cv.arc(cx - d, ly, r - hl, r + hl, 0, tA, col);
    cv.arc(cx + d, ly, r - hl, r + hl, 360 - tA, 360, col);
    cv.arc(cx + d, ly, r - hl, r + hl, 0, 135, col);
    cv.line(lT[0], lT[1], cx, tipY, lw, col);
    cv.line(rT[0], rT[1], cx, tipY, lw, col);
    cv.circle(cx, tipY, hl, col);
}

/** A loading spinner: a faint ring and a turning arc (moves with each frame drawn). */
function drawSpinner(cv, cx, cy, r, col, lw) {
    lw = lw || Math.max(2, r * 0.3);
    const r0 = r - lw / 2, r1 = r + lw / 2;
    cv.arc(cx, cy, r0, r1, 0, 360, withAlpha(col, 0.2));
    const a0 = (Date.now() / 2.4) % 360, a1 = a0 + 110;
    if (a1 <= 360) cv.arc(cx, cy, r0, r1, a0, a1, col, { round: true });
    else {
        cv.arc(cx, cy, r0, r1, a0, 360, col, { round: true });
        cv.arc(cx, cy, r0, r1, 0, a1 - 360, col, { round: true });
    }
}

/** The row that closes a list while its next page loads: a spinner and what loads. */
function drawLoadingRow(cv, t, x, y, w, label, h) {
    h = h || 42;
    const size = sz(cv, 12.5);
    S.hairline(cv, x, y - 3, w);
    drawSpinner(cv, x + sz(cv, 22), y + h / 2, sz(cv, 7), S.sel(t));
    cv.text(label, x + sz(cv, 46), y + h / 2 + size * 0.36, size, t.dim);
}

/** A device's kind as a small line glyph (phone, computer, speaker, TV, car; others a speaker). */
function drawDeviceIcon(cv, cx, cy, type, col) {
    const k = String(type || '').toLowerCase();
    const lw = 2;
    if (k === 'smartphone' || k === 'tablet') {
        const w = k === 'tablet' ? 20 : 14, h = 24;
        cv.strokeRoundRect(cx - w / 2, cy - h / 2, w, h, 3, lw, col);
        cv.line(cx - 2.5, cy + h / 2 - 4, cx + 2.5, cy + h / 2 - 4, lw, col);
    } else if (k === 'computer') {
        cv.strokeRoundRect(cx - 13, cy - 11, 26, 17, 2, lw, col);
        cv.line(cx - 16, cy + 10, cx + 16, cy + 10, lw, col);
    } else if (k === 'tv') {
        cv.strokeRoundRect(cx - 14, cy - 10, 28, 18, 2, lw, col);
        cv.line(cx - 6, cy + 12, cx + 6, cy + 12, lw, col);
    } else if (k === 'automobile') {
        cv.strokeRoundRect(cx - 15, cy - 3, 30, 11, 4, lw, col);
        cv.line(cx - 9, cy - 3, cx - 5, cy - 10, lw, col);
        cv.line(cx - 5, cy - 10, cx + 6, cy - 10, lw, col);
        cv.line(cx + 6, cy - 10, cx + 10, cy - 3, lw, col);
        cv.circle(cx - 8, cy + 9, 3, col);
        cv.circle(cx + 8, cy + 9, 3, col);
    } else {
        cv.strokeRoundRect(cx - 10, cy - 13, 20, 26, 4, lw, col);
        cv.arc(cx, cy + 3, 4, 6, 0, 360, col);
        cv.circle(cx, cy - 7, 2, col);
    }
}

/** str cut (with "..") to fit maxW pixels at this size: room decides, not a character count. */
function fitText(cv, str, maxW, size, opts) {
    str = String(str || '');
    if (!cv.textWidth || cv.textWidth(str, size, opts) <= maxW) return str;
    let lo = 0, hi = str.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cv.textWidth(str.slice(0, mid).replace(/\s+$/, '') + '..', size, opts) <= maxW) lo = mid; else hi = mid - 1;
    }
    return str.slice(0, lo).replace(/\s+$/, '') + '..';
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log, dataDir } = ctx;
        const spotify = new SpotifyClient(ctx);
        const artManager = new AlbumArtManager(log, () => render());

        function notify(msg) {
            log.info('Spotify: ' + msg);
        }

        const cloudPair = new CloudPairManager(ctx, spotify);
        cloudPair.onPaired = () => {
            notify('Spotify Paired via Secure Cloud!');
            page = 0; // Automatically switch to Playlists upon pairing!
            spotify.initialFetch();
            render().catch(() => {});
        };
        cloudPair.onUnpaired = () => {
            spotify.logout();
            cachedQr = null;
            cachedQrUrl = null;
            cloudPair.reset();
            cloudPair.startPolling();
            artManager.load(null);
            page = 3;
            notify('Spotify Disconnected.');
            render().catch(() => {});
        };
        // background: no internet checks, no player polls and no relay stream (its keepalives would
        // wake the app all drive); what the phone sent meanwhile is read when the screen is back
        // (the relay keeps 12 h), as M-Copilot does
        const onScreen = () => !ui.isVisible || ui.isVisible('MAIN');
        spotify.isOnScreen = onScreen;
        if (ui.onVisible) ui.onVisible((name, visible) => {
            if (name !== 'MAIN') return;
            if (visible) cloudPair.startPolling(); else cloudPair.stopPolling();
        });
        if (onScreen()) cloudPair.startPolling();

        // Default to Online mode (demo !== 'on')
        // If not authenticated, open directly on the Connect tab!
        // read each time: the demo setting can change while the app runs
        const isOnlineMode = () => settings.get('demo') !== 'on';
        let page = (isOnlineMode() && !spotify.isAuthenticated()) ? 3 : 0;
        let showPhoneQr = false;        // Connect, paired: the phone page's QR code in place of the account card
        // the demo switched on or off (Settings, or the offline screen's button): its data in or out
        settings.onChange((k, v) => {
            if (k !== 'demo') return;
            spotify.setDemoMode(v === 'on');
            if (v !== 'on' && !spotify.isAuthenticated()) page = 3;      // to the pairing QR
            render();
        });
        let selectedPlaylistIdx = 0;
        let playlistScroll = 0;
        let trackScroll = 0;
        let likedScroll = 0;

        /*
         * Busy buttons. A tap that has to wait for Spotify (or the network) marks its button busy:
         * it shows a spinner and takes no other tap until the answer is in, so a slow phone is not
         * sent the same command twice. One key per group of buttons that must not overlap:
         *   start     a song started from a list (id: the row)    transport  play/pause, next, previous
         *   shuffle, repeat, like      devices  refresh            transfer   moving playback (id: device)
         *   playlists refresh          net      the internet check
         * A request that never answers frees its button after BUSY_MAX_MS.
         */
        const BUSY_MAX_MS = 12000;
        const busy = {};
        const isBusy = (key) => !!busy[key] && Date.now() - busy[key].at < BUSY_MAX_MS;
        const busyOn = (key, id) => isBusy(key) && busy[key].id === id;
        function runBusy(key, fn, id) {
            if (isBusy(key)) return;
            const mark = { at: Date.now(), id };
            busy[key] = mark;
            let p;
            try { p = Promise.resolve(fn()); } catch (e) { p = Promise.resolve(); log.warn(key + ': ' + e.message); }
            const done = () => { if (busy[key] === mark) delete busy[key]; render(); };
            p.then(done, done);
            render();
        }

        // "Playing" marks follow what Spotify plays (its context and track), not what is selected here
        const playingFrom = (pl) => !!(pl && pl.uri && spotify.contextUri && spotify.contextUri === pl.uri);
        const isPlayingTrack = (trk) => !!(trk && spotify.currentTrack && spotify.currentTrack.id === trk.id);

        // Lists scroll with a finger (the list under it) or the controller (the page's main list).
        // listGeo is filled while a page draws: rows per list, how many show, the list's x range.
        const listGeo = {};
        const scrollGet = { pl: () => playlistScroll, trk: () => trackScroll, liked: () => likedScroll };
        const scrollSet = { pl: (v) => { playlistScroll = v; }, trk: (v) => { trackScroll = v; }, liked: (v) => { likedScroll = v; } };
        let scrollAcc = 0, scrollList = null;
        ctx.onScroll((dy, at) => {
            const names = page === 0 ? ['pl', 'trk'] : page === 1 ? ['liked'] : [];
            const name = names.find((n) => at && listGeo[n] && at.x >= listGeo[n].x0 && at.x < listGeo[n].x1) || names[names.length - 1];
            const g = name && listGeo[name];
            if (!g) return false;
            if (name !== scrollList) { scrollList = name; scrollAcc = 0; }
            const max = Math.max(0, g.count - g.visible), cur = scrollGet[name]();
            scrollAcc += dy;
            const rows = scrollAcc > 0 ? Math.floor(scrollAcc / g.rowH) : Math.ceil(scrollAcc / g.rowH);
            if (!rows) return (dy > 0 && cur < max) || (dy < 0 && cur > 0);
            scrollAcc -= rows * g.rowH;
            const next = Math.max(0, Math.min(max, cur + rows));
            scrollSet[name](next);
            render().catch(() => {});
            return next !== cur;
        });
        let spectrumSeed = 0;

        /* ---------- Real Cloud Pairing QR Code Generation ---------- */
        let cachedQr = null;
        let cachedQrUrl = null;
        function getQrMatrix() {
            // Use real public pairing URL (works anywhere over 4G/5G/Wi-Fi, zero 127.0.0.1)
            const url = cloudPair.getPairingUrl();
            if (cachedQr && cachedQrUrl === url) return cachedQr;
            try {
                const qr = qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.MEDIUM);
                cachedQr = qr;
                cachedQrUrl = url;
                return qr;
            } catch (e) {
                return null;
            }
        }

        /* ---------- Offline: no internet ---------- */
        function drawNoInternet(cv, t) {
            const y = S.state(cv, t, 64, 110, 1000, {
                tone: 'error', glow: !!cv.place, title: 'No internet connection', size: sz(cv, 26),
                lines: ['Spotify needs the car to be online.', 'Check the phone hotspot, the USB-tethered phone or the LTE stick.'],
            });
            const bh = sz(cv, 32), netBusy = isBusy('net');
            let bx = 64;
            bx += S.button(cv, t, bx, y + 20, netBusy ? 'Checking...' : 'Try again', () => runBusy('net', () => spotify.checkInternetConnection()),
                { h: bh, primary: true, busy: netBusy, key: 'btn_retry_net', size: sz(cv, 13) }) + 16;
            S.button(cv, t, bx, y + 20, 'Use demo mode', () => settings.set('demo', 'on'), { h: bh, key: 'btn_switch_demo', size: sz(cv, 13) });
        }

        /* ---------- Not paired: connect the account first ---------- */
        function drawRequireConnect(cv, t) {
            const y = S.state(cv, t, 64, 110, 1000, {
                tone: 'info', glow: !!cv.place, title: 'Connect your Spotify account', size: sz(cv, 26),
                lines: ['Scan the code on the Connect tab with your phone and sign in to Spotify there.', 'Your playlists, liked songs and devices then show here.'],
            });
            S.button(cv, t, 64, y + 20, 'Pair your phone', () => { page = 3; }, { h: sz(cv, 32), primary: true, key: 'btn_goto_connect', size: sz(cv, 13) });
        }

        /* ---------- The mini player along the bottom (Playlists, Liked Songs, Connect) ---------- */
        function drawBottomPlayerDock(cv, t, m) {
            const curTrk = spotify.currentTrack;
            const isPlaying = spotify.isPlaying;
            m = m || metrics(cv);
            const acc = S.acc(t);
            const dockX = 24, dockY = m.dockY, dockW = 1552, dockH = m.dockH;

            // subtle elevated dock surface + ambient cover tint (GPU only)
            cv.fillRect(dockX, dockY, dockW, dockH, '#101218');
            if (cv.place && curTrk && artManager.hasArt) {
                cv.clip(dockX, dockY, dockW, dockH);
                cv.alpha(0.18);
                cv.image(ART_GROUND_ID, dockX, dockY - 360, dockW, dockW * 0.6, 0);
                cv.alpha(1);
                cv.noclip();
            }

            // a hairline over it, the progress along it in the theme's ramp (M blues in Afterglow)
            S.hairline(cv, dockX, dockY, dockW, 0.12);
            const dur = (curTrk && curTrk.durationMs) ? curTrk.durationMs : 1;
            const pFrac = curTrk ? Math.min(1, Math.max(0, spotify.progressMs / dur)) : 0;
            const pStops = (t.style !== 'afterglow' && t.ramp && t.ramp.length >= 2) ? [t.ramp[0], t.ramp[1]] : [S.M2, S.M1];
            if (pFrac > 0) cv.rampRect(dockX, dockY - 1, Math.round(dockW * pFrac), 3, 0, pStops, dockX, Math.max(1, Math.round(dockW * pFrac)));

            // the cover, small
            const miniSz = dockH - 22, miniX = dockX + 16, miniY = dockY + 12;
            if (artManager.hasArt && curTrk) {
                cv.image(ART_IMG_ID, miniX, miniY, miniSz, miniSz, 4);
                cv.strokeRoundRect(miniX + 0.5, miniY + 0.5, miniSz - 1, miniSz - 1, 4, 1, withAlpha('#ffffff', 0.14));
            } else {
                cv.roundRect(miniX, miniY, miniSz, miniSz, 4, withAlpha('#ffffff', 0.05));
                drawMiniEqualizer(cv, miniX + miniSz / 2, miniY + miniSz / 2, isPlaying ? acc : t.dim, isPlaying, spectrumSeed);
            }

            // the controls from the right: Now Playing, next, play, previous, heart
            const hit = Math.min(sz(cv, 38), dockH - 12), cy = dockY + dockH / 2 + 3, iconSz = Math.min(sz(cv, 15), 22);
            const playR = Math.min(sz(cv, 19), Math.floor(dockH * 0.34)), gap = Math.min(sz(cv, 10), 14);
            const npSize = Math.min(sz(cv, 12.5), 19), npH = Math.min(sz(cv, 30), dockH - 16);
            const npW = Math.round(cv.textWidth('Now playing', npSize) + sz(cv, 32)), npX = dockX + dockW - 12 - npW;
            const nextX = npX - sz(cv, 22) - hit, playX = nextX - gap - playR * 2, prevX = playX - gap - hit;
            const heartX = prevX - gap - hit;
            S.button(cv, t, npX, cy - Math.round(npH / 2), 'Now playing', () => { page = 2; render(); }, { h: npH, size: npSize, key: 'dock_btn_np', w: npW });
            const tb = isBusy('transport');
            if (curTrk) {
                const liked = !!spotify.isCurrentLiked;
                if (isBusy('like')) drawSpinner(cv, heartX + hit / 2, cy, sz(cv, 7), S.critC(t));
                else drawHeartIcon(cv, heartX + hit / 2, cy + 1, iconSz, liked ? S.critC(t) : '#aeb4bd', liked);
                cv.target(heartX, cy - hit / 2, hit, hit, () => runBusy('like', () => spotify.toggleLikeCurrent()), 'dock_like', hit / 2);
            }
            if (busyOn('transport', 'prev')) drawSpinner(cv, prevX + hit / 2, cy, sz(cv, 7), '#ffffff');
            else drawPrevIcon(cv, prevX + hit / 2, cy, iconSz, tb ? '#6b7280' : '#ffffff');
            cv.target(prevX, cy - hit / 2, hit, hit, () => runBusy('transport', () => spotify.prevTrack(), 'prev'), 'dock_prev', hit / 2);
            cv.circle(playX + playR, cy, playR, tb ? withAlpha('#ffffff', 0.6) : '#ffffff');
            if (busyOn('transport', 'play')) drawSpinner(cv, playX + playR, cy, sz(cv, 8), '#0b0c0f');
            else if (isPlaying) drawPauseIcon(cv, playX + playR, cy, Math.round(playR * 0.72), '#0b0c0f');
            else drawPlayIcon(cv, playX + playR + 1, cy, Math.round(playR * 0.72), '#0b0c0f');
            cv.target(playX, cy - playR, playR * 2, playR * 2, () => runBusy('transport', () => spotify.togglePlay(), 'play'), 'dock_play', playR);
            if (busyOn('transport', 'next')) drawSpinner(cv, nextX + hit / 2, cy, sz(cv, 7), '#ffffff');
            else drawNextIcon(cv, nextX + hit / 2, cy, iconSz, tb ? '#6b7280' : '#ffffff');
            cv.target(nextX, cy - hit / 2, hit, hit, () => runBusy('transport', () => spotify.nextTrack(), 'next'), 'dock_next', hit / 2);

            // the song: title and artist, the time right of them
            const timeSize = Math.min(sz(cv, 12), 18), timeText = curTrk ? fmtTime(spotify.progressMs) + ' / ' + fmtTime(curTrk.durationMs) : '';
            const timeW = timeText ? cv.textWidth(timeText, timeSize, { font: 'num' }) : 0, timeR = (curTrk ? heartX : prevX) - sz(cv, 20);
            const textX = miniX + miniSz + 18, textW = Math.max(120, timeR - timeW - 22 - textX);
            const tSize = Math.min(sz(cv, 15), 22), mSize = Math.min(sz(cv, 12), 18);
            if (curTrk) {
                cv.text(fitText(cv, curTrk.title, textW, tSize, { font: 'bold' }), textX, cy - 4, tSize, t.text, { font: 'bold' });
                cv.text(fitText(cv, curTrk.artist + (curTrk.album ? '  ·  ' + curTrk.album : ''), textW, mSize), textX, cy + mSize + 4, mSize, t.dim);
                cv.text(timeText, timeR, cy + timeSize * 0.36, timeSize, t.dim, { align: 'right', font: 'num' });
            } else {
                cv.text('Nothing playing', textX, cy - 4, tSize, t.dim, { font: 'bold' });
                cv.text(fitText(cv, 'Start a song from Playlists or Liked Songs', textW, mSize), textX, cy + mSize + 4, mSize, t.dim);
            }
            cv.target(dockX, dockY, (curTrk ? heartX : prevX) - 12 - dockX, dockH, () => { page = 2; render(); }, 'dock_open_np', 3);
        }

        /** Rounded cover thumbnail (real album/playlist art when loaded, glowing heart or monogram fallback). */
        function drawCoverThumb(cv, t, url, x, y, size, r, o) {
            const opt = o || {};
            if (opt.heart) {
                cv.roundRect(x, y, size, size, r, withAlpha(S.M3, opt.lit ? 0.30 : 0.20));
                cv.strokeRoundRect(x + 0.5, y + 0.5, size - 1, size - 1, r, 1, withAlpha(S.M3, opt.lit ? 0.65 : 0.42));
                drawHeartIcon(cv, x + size / 2, y + size / 2 + 1, Math.round(size * 0.42), S.M3, true);
                return;
            }
            const tid = url ? artManager.thumbId(url) : 0;
            if (tid) {
                cv.image(tid, x, y, size, size, r);
                cv.strokeRoundRect(x + 0.5, y + 0.5, size - 1, size - 1, r, 1, withAlpha('#ffffff', opt.lit ? 0.22 : 0.12));
                return;
            }
            const col = opt.accent || S.M1;
            cv.roundRect(x, y, size, size, r, withAlpha(col, opt.lit ? 0.26 : 0.14));
            cv.strokeRoundRect(x + 0.5, y + 0.5, size - 1, size - 1, r, 1, withAlpha(col, opt.lit ? 0.55 : 0.28));
            const ch = String(opt.letter || '♪').charAt(0).toUpperCase();
            cv.text(ch, x + size / 2, y + size / 2 + Math.round(size * 0.16), Math.max(14, Math.round(size * 0.42)), '#ffffff', { align: 'center', font: 'bold', literal: true });
        }

        /** Compact icon+label pill button for editorial headers (Play / Shuffle). */
        function drawHeroAction(cv, t, x, y, w, h, label, iconFn, run, o) {
            const opt = o || {};
            const selC = S.sel(t), szT = opt.size || 16;
            const r = Math.min(6, Math.round(h / 2));
            if (opt.primary) {
                cv.roundRect(x, y, w, h, r, selC);
                cv.strokeRoundRect(x + 0.5, y + 0.5, w - 1, h - 1, r, 1, withAlpha('#ffffff', 0.22));
            } else if (opt.active) {
                cv.roundRect(x, y, w, h, r, withAlpha(selC, 0.20));
                cv.strokeRoundRect(x + 0.5, y + 0.5, w - 1, h - 1, r, 1, withAlpha(selC, 0.72));
            } else {
                cv.roundRect(x, y, w, h, r, '#161922');
                cv.strokeRoundRect(x + 0.5, y + 0.5, w - 1, h - 1, r, 1, withAlpha('#ffffff', 0.18));
            }
            const cy = y + h / 2;
            const col = opt.primary ? '#ffffff' : opt.active ? '#ffffff' : t.text;
            const tw = cv.textWidth(label, szT, { font: opt.primary ? 'bold' : 'normal' });
            const icoGap = 10, icoW = 14;
            const startX = x + Math.round((w - (icoW + icoGap + tw)) / 2);
            if (opt.busy) drawSpinner(cv, startX + icoW / 2, cy, 7, col);
            else if (iconFn) iconFn(startX + icoW / 2, cy, col);
            cv.text(label, startX + icoW + icoGap, cy + szT * 0.35, szT, col, { font: opt.primary ? 'bold' : 'normal' });
            if (run) cv.target(x, y, w, h, run, opt.key || label, r);
        }

        /**
         * Modern 2-line track row with rounded album cover thumbnail, bold title over muted artist·album,
         * and crisp tabular duration. Active track renders as a softly lit elevated card with animated EQ.
         * o = { x, w, y, h, idx, trk, playing, starting, heart, card, showIndex }
         */
        function drawSongRow(cv, t, m, o) {
            const { x, w, y, trk } = o, h = o.h || 58, cy = y + h / 2;
            const acc = S.acc(t), selC = S.sel(t);
            const isCard = !!o.card;

            if (o.playing) {
                cv.roundRect(x, y, w, h, 6, '#131a26');
                S.shadeX(cv, x + 1, y + 1, Math.round(w * 0.62), h - 2, acc, 0.16, 0);
                cv.strokeRoundRect(x + 0.5, y + 0.5, w - 1, h - 1, 6, 1, withAlpha(selC, 0.42));
                S.mark(cv, x + 7, y + Math.round(h * 0.24), Math.round(h * 0.52), acc);
            } else if (isCard) {
                cv.roundRect(x, y, w, h, 6, '#101218');
                cv.strokeRoundRect(x + 0.5, y + 0.5, w - 1, h - 1, 6, 1, withAlpha('#ffffff', 0.07));
            } else {
                if (o.idx % 2 === 1) cv.roundRect(x, y, w, h, 4, withAlpha('#ffffff', 0.022));
                if (o.idx > 0) S.hairline(cv, x + 46, y - 3, w - 46, 0.07);
            }

            // Optional track index or playing EQ on the left
            let curX = x + (o.playing ? 26 : 12);
            if (o.showIndex) {
                const idxCx = x + (o.playing ? 32 : 24);
                if (o.playing) {
                    if (o.starting) drawSpinner(cv, idxCx, cy, 7, acc);
                    else drawMiniEqualizer(cv, idxCx, cy, acc, spotify.isPlaying, spectrumSeed);
                } else {
                    const nSz = Math.min(sz(cv, 11.5), 16);
                    cv.text(String(o.idx + 1), idxCx, cy + nSz * 0.35, nSz, t.dim, { align: 'center', font: 'num' });
                }
                curX = x + 52;
            }

            // Rounded album cover thumbnail
            const thumbSz = Math.max(34, Math.min(46, h - 14));
            const thumbY = y + Math.round((h - thumbSz) / 2);
            drawCoverThumb(cv, t, trk.albumArt, curX, thumbY, thumbSz, 4, {
                lit: o.playing, accent: o.playing ? selC : S.M2, letter: trk.title || '♪',
            });

            // Right side: tabular duration + optional heart / EQ badge (for card mode without left index)
            const timeSz = Math.min(sz(cv, 11.5), 16);
            const timeR = x + w - 16;
            const timeStr = fmtTime(trk.durationMs);
            const timeW = cv.textWidth(timeStr, timeSz, { font: 'num' });
            cv.text(timeStr, timeR, cy + timeSz * 0.35, timeSz, o.playing ? '#d6dde8' : t.dim, { align: 'right', font: 'num' });

            let rightLimit = timeR - timeW - 14;
            if (!o.showIndex && o.playing) {
                if (o.starting) drawSpinner(cv, rightLimit - 10, cy, 7, acc);
                else drawMiniEqualizer(cv, rightLimit - 12, cy, acc, spotify.isPlaying, spectrumSeed);
                rightLimit -= 30;
            } else if (o.heart) {
                drawHeartIcon(cv, rightLimit - 8, cy + 1, Math.min(13, Math.round(h * 0.24)), S.critC(t), true);
                rightLimit -= 24;
            }

            // Two-line editorial stack: Bold title over muted artist · album
            const tx = curX + thumbSz + 14;
            const textW = Math.max(80, rightLimit - tx);
            const tSz = Math.min(sz(cv, 13.5), 19);
            const aSz = Math.min(sz(cv, 11), 15.5);
            const lineGap = Math.max(4, Math.round((h - tSz - aSz) * 0.18));
            const titleY = cy - Math.round(lineGap * 0.5) - 1;
            const metaY = cy + aSz + Math.round(lineGap * 0.5);
            cv.text(fitText(cv, trk.title, textW, tSz, { font: 'bold' }), tx, titleY, tSz, o.playing ? '#ffffff' : t.text, { font: 'bold' });
            const metaText = trk.artist + (trk.album ? '  ·  ' + trk.album : '');
            cv.text(fitText(cv, metaText, textW, aSz), tx, metaY, aSz, o.playing ? '#aeb8c8' : t.dim);
        }

        /** A list that is empty, or still loading: a headline (a spinner before it while loading), a line, a button. */
        function drawEmptyList(cv, t, x, y, w, o) {
            const s = sz(cv, 20);
            if (o.loading) drawSpinner(cv, x + s * 0.45, y + s * 0.62, s * 0.38, S.sel(t));
            const end = S.state(cv, t, x + (o.loading ? s * 1.2 : 0), y, w, { tone: 'none', title: o.title, size: s, lines: [o.line] });
            if (o.button) S.button(cv, t, x, end + 14, o.button.label, o.button.run, { h: sz(cv, 30), size: sz(cv, 12.5), key: o.button.key, busy: o.button.busy });
        }

        /* ---------- Page 0: Playlists & Tracks ---------- */
        function drawPlaylists(cv, t) {
            const playlists = spotify.getPlaylists();
            const m = metrics(cv), gpu = !!cv.place;

            if (!playlists || playlists.length === 0) {
                if (isOnlineMode() && !spotify.isAuthenticated()) {
                    drawRequireConnect(cv, t);
                    return;
                }
                G.panelExact(cv, t, 24, 44, 1552, m.panelH, 'Your playlists');
                const loading = spotify.isLoadingPlaylists || spotify.syncing;
                const plBusy = isBusy('playlists') || spotify.isLoadingPlaylists;
                drawEmptyList(cv, t, 48, 120, 1000, {
                    loading, title: loading ? 'Loading your playlists' : 'No playlists yet',
                    line: loading ? 'Fetching them from Spotify.' : 'Create or follow playlists in Spotify, or open Liked Songs.',
                    button: loading ? null : { label: 'Refresh', key: 'btn_refresh_pls', busy: plBusy, run: () => { if (!spotify.isLoadingPlaylists) runBusy('playlists', () => spotify.fetchPlaylists()); } },
                });
                drawBottomPlayerDock(cv, t);
                return;
            }

            if (selectedPlaylistIdx >= playlists.length) selectedPlaylistIdx = 0;
            const curPl = playlists[selectedPlaylistIdx] || playlists[0];
            spotify.ensureTracks(curPl);

            const plCoverOf = (pl) => (pl && pl.image) || (pl && pl.tracks && pl.tracks[0] && pl.tracks[0].albumArt) || '';

            // Left sidebar geometry: sleek cover-art playlist cards
            const leftX = 24, leftW = 460, listH = m.listBottom - m.listTop;
            const plH = Math.min(72, Math.max(56, Math.round(sz(cv, 46))));
            const plStep = plH + 8;
            const VISIBLE_PL = Math.max(1, Math.floor((listH + 8) / plStep));
            playlistScroll = Math.max(0, Math.min(playlistScroll, Math.max(0, playlists.length - VISIBLE_PL)));
            listGeo.pl = { x0: leftX, x1: leftX + leftW + 18, rowH: plStep, count: playlists.length, visible: VISIBLE_PL };
            cv.scroll = true;

            // Right pane geometry: compact editorial hero banner + modern 2-line track list
            const rx = 516, rw = 1060;
            const heroH = Math.min(100, Math.max(82, Math.round(sz(cv, 64))));
            const heroY = 48;
            const trkTop = heroY + heroH + 12;
            const trkListH = Math.max(60, m.listBottom - trkTop);
            const songH = Math.min(60, Math.max(50, Math.round(sz(cv, 39))));
            const songStep = songH + 6;
            const VISIBLE_TRK = Math.max(1, Math.floor((trkListH + 6) / songStep));

            // Request thumbnails for all visible playlists + selected hero + visible tracks
            const thumbUrls = [];
            const visPls = playlists.slice(playlistScroll, playlistScroll + VISIBLE_PL);
            visPls.forEach((pl) => { const u = plCoverOf(pl); if (u) thumbUrls.push(u); });
            const heroUrl = plCoverOf(curPl);
            if (heroUrl) thumbUrls.push(heroUrl);
            const curTracks = (curPl && curPl.tracks) || [];
            const moreTrk = spotify.hasMoreTracks(curPl);
            const trkRows = curTracks.length + (moreTrk ? 1 : 0);
            trackScroll = Math.max(0, Math.min(trackScroll, Math.max(0, trkRows - VISIBLE_TRK)));
            curTracks.slice(trackScroll, trackScroll + VISIBLE_TRK).forEach((trk) => {
                if (trk && trk.albumArt) thumbUrls.push(trk.albumArt);
            });
            artManager.loadThumbs(thumbUrls);

            // ----- Left Sidebar: Your playlists -----
            G.panelExact(cv, t, leftX, 44, leftW + 8, m.panelH, 'Your playlists');
            cv.text((selectedPlaylistIdx + 1) + ' of ' + playlists.length, leftX + leftW, 44 + 32, Math.min(sz(cv, 11.5), 16), t.dim, { align: 'right' });
            drawScrollbar(cv, t, leftX + leftW + 10, m.listTop, listH, playlists.length, VISIBLE_PL, playlistScroll, () => {
                playlistScroll = Math.max(0, playlistScroll - 1);
                selectedPlaylistIdx = Math.max(0, selectedPlaylistIdx - 1);
                spotify.selectPlaylist(playlists[selectedPlaylistIdx]);
            }, () => {
                playlistScroll = Math.min(Math.max(0, playlists.length - VISIBLE_PL), playlistScroll + 1);
                selectedPlaylistIdx = Math.min(playlists.length - 1, selectedPlaylistIdx + 1);
                spotify.selectPlaylist(playlists[selectedPlaylistIdx]);
            });

            const PL_ACCENTS = [S.M1, S.M2, S.M3, S.BLUE, '#7cc8f0'];
            visPls.forEach((pl, vIdx) => {
                const realIdx = playlistScroll + vIdx;
                const py = m.listTop + vIdx * plStep;
                const isSel = realIdx === selectedPlaylistIdx, isPlPlaying = playingFrom(pl);
                const isLikedPl = /liked/i.test(pl.name || '');

                cv.roundRect(leftX, py, leftW, plH, 6, '#101218');
                cv.strokeRoundRect(leftX + 0.5, py + 0.5, leftW - 1, plH - 1, 6, 1, withAlpha('#ffffff', isSel ? 0.18 : 0.07));
                if (isSel) S.lit(cv, t, leftX + 1, py + 1, leftW - 2, plH - 2, 0.92);
                if (isPlPlaying) S.mark(cv, leftX + 7, py + Math.round(plH * 0.24), Math.round(plH * 0.52), S.acc(t));

                const tileSz = Math.max(38, plH - 16);
                const tileX = leftX + (isPlPlaying ? 26 : 10), tileY = py + Math.round((plH - tileSz) / 2);
                const pCol = pl.accent || PL_ACCENTS[realIdx % PL_ACCENTS.length];
                drawCoverThumb(cv, t, isLikedPl ? '' : plCoverOf(pl), tileX, tileY, tileSz, 4, {
                    heart: isLikedPl, lit: isSel, accent: pCol, letter: pl.name || 'P',
                });

                const textX = tileX + tileSz + 13;
                const textW = leftX + leftW - textX - (isPlPlaying ? 44 : 14);
                const nSize = Math.min(sz(cv, 13.5), 19), dSize = Math.min(sz(cv, 11), 15.5);
                const nY = py + Math.round(plH * 0.44), dY = nY + dSize + 7;
                cv.text(fitText(cv, pl.name, textW, nSize, { font: 'bold' }), textX, nY, nSize, isSel ? '#ffffff' : t.text, { font: 'bold' });
                const sub = (pl.trackCount || 0) + ' songs' + (isPlPlaying ? (spotify.isPlaying ? '  ·  Playing' : '  ·  Paused') : '');
                cv.text(fitText(cv, sub, textW, dSize), textX, dY, dSize, isPlPlaying ? S.acc(t) : t.dim);
                if (isPlPlaying) drawMiniEqualizer(cv, leftX + leftW - 22, py + plH / 2, S.acc(t), spotify.isPlaying, spectrumSeed);

                cv.target(leftX, py, leftW, plH, () => {
                    selectedPlaylistIdx = realIdx;
                    trackScroll = 0;
                    spotify.selectPlaylist(pl);
                }, 'pl_' + realIdx, 6);
            });

            // ----- Right Pane: Editorial Playlist Hero Header -----
            const ctxHere = !spotify.contextUri || !/:playlist:/.test(spotify.contextUri) || playingFrom(curPl);
            const isHeroLiked = /liked/i.test(curPl.name || '');
            const heroAccent = isHeroLiked ? S.M3 : (curPl.accent || S.M1);
            const trackTotal = curPl.trackCount || curTracks.length;

            cv.roundRect(rx, heroY, rw, heroH, 6, '#101218');
            if (gpu) {
                cv.clip(rx, heroY, rw, heroH);
                S.softEllipse(cv, rx + 110, heroY + heroH * 0.5, 320, 120, heroAccent, 0.22);
                cv.noclip();
            }
            cv.strokeRoundRect(rx + 0.5, heroY + 0.5, rw - 1, heroH - 1, 6, 1, withAlpha('#ffffff', 0.10));

            const covSz = heroH - 20, covX = rx + 12, covY = heroY + 10;
            if (gpu) S.softEllipse(cv, covX + covSz / 2, covY + covSz + 2, covSz * 0.52, 8, '#000000', 0.65);
            drawCoverThumb(cv, t, isHeroLiked ? '' : heroUrl, covX, covY, covSz, 5, {
                heart: isHeroLiked, lit: true, accent: heroAccent, letter: curPl.name || 'P',
            });

            // Hero action buttons: Play/Pause + Shuffle (right-aligned inside hero card)
            const actH = Math.min(40, Math.max(34, Math.round(heroH * 0.44)));
            const actSz = Math.min(sz(cv, 11.5), 16);
            const actY = heroY + Math.round((heroH - actH) / 2);
            const shufW = Math.round(cv.textWidth('Shuffle', actSz) + 48);
            const playPlayingHere = playingFrom(curPl) && spotify.isPlaying;
            const playLabel = playPlayingHere ? 'Pause' : 'Play';
            const playW = Math.round(cv.textWidth('Pause', actSz, { font: 'bold' }) + 50);
            const shufX = rx + rw - 14 - shufW;
            const playX = shufX - 10 - playW;
            const canPlayPl = curTracks.length > 0;

            drawHeroAction(cv, t, playX, actY, playW, actH, playLabel,
                (ix, iy, c) => (playPlayingHere ? drawPauseIcon(cv, ix, iy, 12, c) : drawPlayIcon(cv, ix + 1, iy, 12, c)),
                canPlayPl ? () => {
                    if (playingFrom(curPl)) runBusy('transport', () => spotify.togglePlay(), 'play');
                    else runBusy('start', () => spotify.playPlaylist(curPl, false), 'pl_play:' + curPl.id);
                } : null,
                { primary: true, size: actSz, key: 'pl_hero_play', busy: busyOn('start', 'pl_play:' + curPl.id) || busyOn('transport', 'play') });

            drawHeroAction(cv, t, shufX, actY, shufW, actH, 'Shuffle',
                (ix, iy, c) => drawShuffleIcon(cv, ix, iy, 13, c),
                canPlayPl ? () => runBusy('start', () => spotify.playPlaylist(curPl, true), 'pl_shuf:' + curPl.id) : null,
                { active: !!spotify.shuffle && playingFrom(curPl), size: actSz, key: 'pl_hero_shuffle', busy: busyOn('start', 'pl_shuf:' + curPl.id) });

            // Hero title, description & runtime summary
            const hTx = covX + covSz + 18, hTw = Math.max(140, playX - 16 - hTx);
            const hTitleSz = Math.min(sz(cv, 18.5), 26);
            const hDescSz = Math.min(sz(cv, 11), 15.5);
            const runtime = fmtTotalRuntime(curTracks);
            const metaLine = trackTotal + ' songs' + (runtime ? '  ·  ' + runtime : '') + (curPl.description ? '  ·  ' + curPl.description : '');
            cv.text(fitText(cv, curPl.name, hTw, hTitleSz, { font: 'bold' }), hTx, heroY + Math.round(heroH * 0.44), hTitleSz, t.text, { font: 'bold' });
            cv.text(fitText(cv, metaLine, hTw, hDescSz), hTx, heroY + Math.round(heroH * 0.74), hDescSz, t.dim);

            // ----- Right Pane: Modern 2-Line Track List -----
            if (!curTracks.length) {
                const none = !!curPl.tracksLoaded;
                drawEmptyList(cv, t, rx + 16, trkTop + 20, 880, { loading: !none, title: none ? 'No songs' : 'Loading songs', line: none ? 'This playlist has no songs that can be played here.' : 'Fetching them from Spotify.' });
            } else {
                listGeo.trk = { x0: rx - 10, x1: 1576, rowH: songStep, count: trkRows, visible: VISIBLE_TRK };
                if (moreTrk && trackScroll + VISIBLE_TRK >= curTracks.length - 5) spotify.loadMoreTracks(curPl);
                drawScrollbar(cv, t, 1574, trkTop, trkListH, trkRows, VISIBLE_TRK, trackScroll, () => {
                    trackScroll = Math.max(0, trackScroll - VISIBLE_TRK);
                }, () => {
                    trackScroll = Math.min(Math.max(0, trkRows - VISIBLE_TRK), trackScroll + VISIBLE_TRK);
                });
                const rowW = trkRows > VISIBLE_TRK ? rw - 16 : rw;
                if (moreTrk && trackScroll + VISIBLE_TRK > curTracks.length) {
                    drawLoadingRow(cv, t, rx, trkTop + (curTracks.length - trackScroll) * songStep, rowW,
                        'Loading more songs (' + curTracks.length + ' of ' + (curPl._total || trackTotal) + ')...', songH);
                }
                curTracks.slice(trackScroll, trackScroll + VISIBLE_TRK).forEach((trk, vIdx) => {
                    const realIdx = trackScroll + vIdx;
                    const ty = trkTop + vIdx * songStep;
                    const startKey = 'pl:' + curPl.id + ':' + realIdx;
                    const starting = busyOn('start', startKey);
                    const isPlayingThis = starting || (ctxHere && isPlayingTrack(trk));
                    drawSongRow(cv, t, m, { x: rx, w: rowW, y: ty, h: songH, idx: realIdx, trk, playing: isPlayingThis, starting, showIndex: true });
                    cv.target(rx, ty, rowW, songH, () => {
                        runBusy('start', () => spotify.playTrack(curPl, realIdx), startKey);
                    }, 'trk_' + realIdx, 6);
                });
            }

            drawBottomPlayerDock(cv, t);
        }

        /* ---------- Page 1: Liked Songs (Hero Header + Modern 2-Column Track Card Grid) ---------- */
        function drawLibrary(cv, t) {
            if (isOnlineMode() && !spotify.isAuthenticated()) {
                drawRequireConnect(cv, t);
                return;
            }

            const liked = (spotify.likedSongs && spotify.likedSongs.length)
                ? spotify.likedSongs
                : (spotify.isDemoMode ? DEMO_PLAYLISTS[3].tracks : []);

            const total = spotify.likedTotal || liked.length;
            const m = metrics(cv), gpu = !!cv.place;
            const gx = 24, gw = 1552;

            // Hero Header with M-crimson glow + Play / Shuffle pills
            const heroY = 48, heroH = Math.min(92, Math.max(76, Math.round(sz(cv, 58))));
            cv.roundRect(gx, heroY, gw, heroH, 6, '#101218');
            if (gpu) {
                cv.clip(gx, heroY, gw, heroH);
                S.softEllipse(cv, gx + 120, heroY + heroH * 0.5, 360, 120, S.M3, 0.24);
                cv.noclip();
            }
            cv.strokeRoundRect(gx + 0.5, heroY + 0.5, gw - 1, heroH - 1, 6, 1, withAlpha('#ffffff', 0.10));

            const badgeSz = heroH - 20;
            drawCoverThumb(cv, t, '', gx + 12, heroY + 10, badgeSz, 5, { heart: true, lit: true });

            const actH = Math.min(40, Math.max(34, Math.round(heroH * 0.46)));
            const actSz = Math.min(sz(cv, 11.5), 16);
            const actY = heroY + Math.round((heroH - actH) / 2);
            const shufW = Math.round(cv.textWidth('Shuffle', actSz) + 48);
            const playW = Math.round(cv.textWidth('Pause', actSz, { font: 'bold' }) + 50);
            const shufX = gx + gw - 14 - shufW;
            const playX = shufX - 10 - playW;
            const playingLikedCtx = !!(/:collection$/.test(spotify.contextUri || '') || (!spotify.isOnline && spotify.currentPlaylist && spotify.currentPlaylist.id === 'pl_liked'));
            const likedPlayingNow = playingLikedCtx && spotify.isPlaying;

            drawHeroAction(cv, t, playX, actY, playW, actH, likedPlayingNow ? 'Pause' : 'Play',
                (ix, iy, c) => (likedPlayingNow ? drawPauseIcon(cv, ix, iy, 12, c) : drawPlayIcon(cv, ix + 1, iy, 12, c)),
                liked.length ? () => {
                    if (playingLikedCtx) runBusy('transport', () => spotify.togglePlay(), 'play');
                    else runBusy('start', () => spotify.playLiked(false), 'liked_play');
                } : null,
                { primary: true, size: actSz, key: 'liked_hero_play', busy: busyOn('start', 'liked_play') || busyOn('transport', 'play') });

            drawHeroAction(cv, t, shufX, actY, shufW, actH, 'Shuffle',
                (ix, iy, c) => drawShuffleIcon(cv, ix, iy, 13, c),
                liked.length ? () => runBusy('start', () => spotify.playLiked(true), 'liked_shuf') : null,
                { active: !!spotify.shuffle && playingLikedCtx, size: actSz, key: 'liked_hero_shuffle', busy: busyOn('start', 'liked_shuf') });

            // 2-Column Track Card Grid geometry
            const gridTop = heroY + heroH + 12;
            const gridH = Math.max(60, m.listBottom - gridTop);
            const cardH = Math.min(64, Math.max(52, Math.round(sz(cv, 42))));
            const rowStep = cardH + 8;
            const VISIBLE_ROWS = Math.max(1, Math.floor((gridH + 8) / rowStep));
            const moreLiked = liked === spotify.likedSongs && spotify.hasMoreLiked();
            const totalGridRows = Math.ceil((liked.length + (moreLiked ? 1 : 0)) / 2);
            likedScroll = Math.max(0, Math.min(likedScroll, Math.max(0, totalGridRows - VISIBLE_ROWS)));
            listGeo.liked = { x0: gx, x1: gx + gw, rowH: rowStep, count: totalGridRows, visible: VISIBLE_ROWS };
            if (moreLiked && (likedScroll + VISIBLE_ROWS) * 2 >= liked.length - 6) spotify.loadMoreLiked();
            cv.scroll = true;

            // Hero text (title + range/runtime subtitle)
            const hTx = gx + 12 + badgeSz + 18, hTw = Math.max(160, playX - 18 - hTx);
            const hTitleSz = Math.min(sz(cv, 18.5), 26), hSubSz = Math.min(sz(cv, 11), 15.5);
            const startIdx = liked.length ? likedScroll * 2 + 1 : 0;
            const endIdx = Math.min((likedScroll + VISIBLE_ROWS) * 2, liked.length, total);
            const runtime = fmtTotalRuntime(liked);
            const subLine = total > 0
                ? total + ' saved songs' + (endIdx < total ? '  ·  showing ' + startIdx + '–' + endIdx : '') + (runtime && liked.length === total ? '  ·  ' + runtime : '')
                : 'Your saved tracks from Spotify';
            cv.text('Liked Songs', hTx, heroY + Math.round(heroH * 0.45), hTitleSz, t.text, { font: 'bold' });
            cv.text(fitText(cv, subLine, hTw, hSubSz), hTx, heroY + Math.round(heroH * 0.75), hSubSz, t.dim);

            if (!liked || liked.length === 0) {
                const loading = spotify.isLoadingLiked || spotify.syncing;
                drawEmptyList(cv, t, gx + 16, gridTop + 20, 1000, { loading, title: loading ? 'Loading your liked songs' : 'No liked songs yet', line: loading ? 'Fetching them from Spotify.' : 'Like songs in Spotify and they show here.' });
                drawBottomPlayerDock(cv, t);
                return;
            }

            const hasScroll = totalGridRows > VISIBLE_ROWS;
            if (hasScroll) {
                drawScrollbar(cv, t, 1574, gridTop, gridH, totalGridRows, VISIBLE_ROWS, likedScroll, () => {
                    likedScroll = Math.max(0, likedScroll - VISIBLE_ROWS);
                }, () => {
                    likedScroll = Math.min(Math.max(0, totalGridRows - VISIBLE_ROWS), likedScroll + VISIBLE_ROWS);
                });
            }

            const usableW = hasScroll ? gw - 16 : gw;
            const colGap = 16, colW = Math.floor((usableW - colGap) / 2);
            const firstItem = likedScroll * 2;
            const visItems = liked.slice(firstItem, firstItem + VISIBLE_ROWS * 2);
            artManager.loadThumbs(visItems.map((trk) => trk && trk.albumArt).filter(Boolean));

            visItems.forEach((trk, k) => {
                const realIdx = firstItem + k;
                const col = k % 2, row = Math.floor(k / 2);
                const cx = gx + col * (colW + colGap);
                const cy = gridTop + row * rowStep;
                const startKey = 'liked:' + realIdx;
                const starting = busyOn('start', startKey);
                const isPlayingThis = starting || isPlayingTrack(trk);
                drawSongRow(cv, t, m, { x: cx, w: colW, y: cy, h: cardH, idx: realIdx, trk, playing: isPlayingThis, starting, heart: true, card: true, showIndex: false });
                cv.target(cx, cy, colW, cardH, () => {
                    runBusy('start', () => spotify.playLikedSong(realIdx), startKey);
                }, 'liked_' + realIdx, 6);
            });

            if (moreLiked && firstItem + VISIBLE_ROWS * 2 > liked.length) {
                const k = liked.length - firstItem;
                if (k >= 0 && k < VISIBLE_ROWS * 2) {
                    const col = k % 2, row = Math.floor(k / 2);
                    drawLoadingRow(cv, t, gx + col * (colW + colGap), gridTop + row * rowStep, colW,
                        'Loading more (' + liked.length + ' of ' + total + ')...', cardH);
                }
            }

            drawBottomPlayerDock(cv, t);
        }

        /* ---------- Page 2: Now Playing ---------- */
        /**
         * The song that plays, on a ground made of its own cover (blurred and dark), with the next songs
         * standing behind it to the right: smaller, darker and softer the later they come. Text and controls
         * on the left stay plain: title, a progress line in the M blues, five controls and the heart.
         */
        function upNext(curTrk) {
            if (spotify.remoteQueue && spotify.remoteQueue.length) return spotify.remoteQueue;
            const from = spotify.currentPlaylist && spotify.currentPlaylist.tracks ? spotify.currentPlaylist.tracks
                : spotify.likedSongs && spotify.likedSongs.length ? spotify.likedSongs : [];
            const i = from.findIndex((x) => curTrk && x.id === curTrk.id);
            return i >= 0 ? from.slice(i + 1) : [];
        }
        function playUpcoming(trk, key) {
            // what plays now, from this song on (a song queued by hand: that song alone)
            const pl = spotify.currentPlaylist;
            const pIdx = !spotify.contextUri && pl && pl.tracks ? pl.tracks.findIndex((x) => x.id === trk.id) : -1;
            if (pIdx >= 0) runBusy('start', () => spotify.playTrack(pl, pIdx), key);
            else runBusy('start', () => spotify.playQueued(trk), key);
        }

        let lastTrackId = null;
        let trackSlideAt = 0;
        const TRACK_SLIDE_MS = 340;

        function drawNowPlaying(cv, t) {
            if (isOnlineMode() && !spotify.isAuthenticated()) {
                drawRequireConnect(cv, t);
                return;
            }

            const curTrk = spotify.currentTrack;
            const isPlaying = spotify.isPlaying;
            const ex = cv.extra || 0;
            const gpu = !!cv.place;                 // the GPU draws: soft shapes and smooth scaling
            const bottom = 512 + ex;
            const selC = S.sel(t), acc = S.acc(t), crit = S.critC(t), warn = S.warnC(t);

            // detect track switch for a smooth depth-queue glide-in (340 ms ease-out)
            const tid = curTrk ? curTrk.id : null;
            if (tid && lastTrackId && tid !== lastTrackId) trackSlideAt = Date.now();
            lastTrackId = tid;
            const slideRaw = trackSlideAt ? Math.max(0, 1 - (Date.now() - trackSlideAt) / TRACK_SLIDE_MS) : 0;
            const slide = slideRaw * slideRaw * (3 - 2 * slideRaw);   // smoothstep 1 -> 0

            // the ground: the cover, very blurred and dark, then darker towards the text and the bottom
            if (gpu && curTrk && artManager.hasArt) {
                cv.clip(0, 0, W, bottom);
                cv.image(ART_GROUND_ID, -160, -620, 1920, 1920, 0);
                cv.noclip();
                S.shadeX(cv, 0, 0, 1000, bottom, t.bg, 0.72, 0.34);
                S.shadeX(cv, 1000, 0, W - 1000, bottom, t.bg, 0.34, 0.56);
                S.shadeY(cv, 0, bottom - 220, W, 220, t.bg, 0, 0.9);
            }

            if (!curTrk) {
                cv.text('Nothing playing', 56, 160, sz(cv, 30), t.text, { font: 'bold' });
                cv.text('Start a song from Playlists or Liked Songs.', 56, 160 + sz(cv, 24), sz(cv, 14), t.dim);
                return;
            }

            // the cover, with a soft shadow + subtle floor glow under it and a razor-sharp GPU SDF rounded edge matching the border
            const artX = 56, artY = 72;
            const artSz = Math.max(216, Math.min(340, bottom - artY - 54));
            const artR = 6;
            const coverOff = Math.round(slide * 18);
            if (gpu) {
                S.softEllipse(cv, artX + coverOff + artSz / 2, artY + artSz + 10, artSz * 0.52, 22, '#000000', 0.78);
                S.softRect(cv, artX + coverOff + 16, artY + 32, artSz - 32, artSz - 24, 34, '#000000', 0.65);
            }
            if (artManager.hasArt) {
                cv.image(ART_IMG_ID, artX + coverOff, artY, artSz, artSz, artR);
            } else {
                cv.roundRect(artX + coverOff, artY, artSz, artSz, artR, t.track);
                drawMiniEqualizer(cv, artX + coverOff + artSz / 2, artY + artSz / 2, isPlaying ? acc : t.dim, isPlaying, spectrumSeed);
            }
            cv.strokeRoundRect(artX + coverOff + 0.5, artY + 0.5, artSz - 1, artSz - 1, artR, 1, withAlpha('#ffffff', 0.14));

            // where it plays (animated mini equalizer while playing, calm LED when paused), title, artist, album
            const mx = artX + artSz + 38, mw = 994 - mx;
            const lab = Math.min(sz(cv, 12), 18), tSize = Math.min(sz(cv, 38), 54), aSize = Math.min(sz(cv, 18), 26), alSize = Math.min(sz(cv, 13), 19);
            const devName = spotify.activeDevice || '';
            const devLabel = !devName ? 'Spotify Connect' : spotify.stalled ? devName + ' is not responding'
                : (isPlaying ? 'Playing on ' : 'Paused on ') + devName;
            const ledC = spotify.stalled ? warn : isPlaying ? acc : t.dim;
            if (isPlaying && !spotify.stalled) {
                drawMiniEqualizer(cv, mx + 10, 90 - lab * 0.36, acc, true, spectrumSeed);
                cv.text(fitText(cv, devLabel, mw - 28, lab), mx + 28, 90, lab, t.dim);
            } else {
                if (gpu) S.softEllipse(cv, mx + 4, 90 - lab * 0.36, 9, 9, ledC, 0.7);
                cv.circle(mx + 4, 90 - lab * 0.36, 4, ledC);
                cv.text(fitText(cv, devLabel, mw - 20, lab), mx + 18, 90, lab, t.dim);
            }
            const titleY = 90 + 12 + tSize * 0.94, artistY = titleY + aSize + 12, albumY = artistY + alSize + 10;
            cv.text(fitText(cv, curTrk.title, mw, tSize, { font: 'bold' }), mx, titleY, tSize, t.text, { font: 'bold' });
            cv.text(fitText(cv, curTrk.artist, mw, aSize), mx, artistY, aSize, t.text);
            const ctxUri = spotify.contextUri || '';
            let from = '';
            if (/:collection$/.test(ctxUri)) from = 'Liked Songs';
            else if (/:playlist:/.test(ctxUri)) { const pl = (spotify.playlists || []).find((p) => p.uri === ctxUri); from = pl ? pl.name : 'a playlist'; }
            else if (/:artist:/.test(ctxUri)) from = curTrk.artist;
            const albumLine = [curTrk.album, from && from !== curTrk.album ? 'from ' + from : ''].filter(Boolean).join('  ·  ');
            if (albumLine) cv.text(fitText(cv, albumLine, mw, alSize), mx, albumY, alSize, t.dim);

            // controls sizing first (adaptive to mw so Repeat and Heart never overlap even on 8.8" panels)
            const playR = Math.min(sz(cv, 26), Math.floor(mw * 0.082));
            const hit = Math.min(sz(cv, 44), Math.floor(mw * 0.12));
            const iconSz = Math.min(sz(cv, 18), Math.round(hit * 0.44));
            const maxGap = Math.floor((mw - (hit * 5 + playR * 2) - 18) / 5);
            const gap = Math.max(8, Math.min(sz(cv, 20), maxGap));

            // progress: the line, the times under it; a tap on it jumps there, the controller pressed on it 15 s on
            const tm = Math.min(sz(cv, 12), 18);
            const cy = Math.round(Math.min(bottom - playR - 14, Math.max(albumY + 96 + playR, artY + artSz - playR - 2)));
            const progY = Math.round(Math.min(cy - playR - tm - 30, Math.max(albumY + 34, artY + artSz * 0.68)));
            const progW = mw;
            const dur = curTrk.durationMs || 1, pFrac = Math.min(1, Math.max(0, spotify.progressMs / dur));
            S.progress(cv, mx, progY, progW, pFrac, t);
            cv.text(fmtTime(spotify.progressMs), mx, progY + 14 + tm, tm, t.dim, { font: 'num' });
            cv.text('-' + fmtTime(Math.max(0, dur - spotify.progressMs)), mx + progW, progY + 14 + tm, tm, t.dim, { align: 'right', font: 'num' });
            const seekPad = 10;
            cv.target(mx - seekPad, progY - 16, progW + seekPad * 2, 34, (at) => {
                const to = at && at.w ? (Math.max(0, Math.min(progW, at.x - seekPad)) / progW) * dur : spotify.progressMs + 15000;
                runBusy('seek', () => spotify.seek(to));
            }, 'np_seek', 6);

            // controls: shuffle, previous, play (with BMW-blue focus halo), next, repeat from the left; heart at the end
            let x = mx - 4;
            const plain = (key, id, icon, run, on, busyKey) => {
                const bx = x;
                const busyHere = busyKey ? busyOn(busyKey, id) : isBusy(key);
                if (busyHere) drawSpinner(cv, bx + hit / 2, cy, sz(cv, 8), on ? selC : '#ffffff');
                else icon(bx + hit / 2, cy, on === undefined ? (isBusy('transport') ? '#6b7280' : '#ffffff') : on ? selC : '#aeb4bd');
                if (on) cv.circle(bx + hit / 2, cy + iconSz * 0.85, 2.5, selC);
                cv.target(bx, cy - hit / 2, hit, hit, run, key, hit / 2);
                x += hit + gap;
            };
            plain('np_shuffle', null, (px, py, c) => drawShuffleIcon(cv, px, py, iconSz, c), () => runBusy('np_shuffle', () => spotify.toggleShuffle()), !!spotify.shuffle);
            plain('np_prev', 'prev', (px, py, c) => drawPrevIcon(cv, px, py, iconSz, c), () => runBusy('transport', () => spotify.prevTrack(), 'prev'), undefined, 'transport');
            // play / pause: white disc inside the Afterglow BMW-blue ring + soft halo
            const px = x + playR;
            if (gpu) S.softEllipse(cv, px, cy, playR + 20, playR + 20, selC, 0.36);
            cv.arc(px, cy, playR + 3, playR + 5.2, 0, 360, selC);
            cv.circle(px, cy, playR, isBusy('transport') ? withAlpha('#ffffff', 0.6) : '#ffffff');
            if (busyOn('transport', 'play')) drawSpinner(cv, px, cy, sz(cv, 9), '#0b0c0f', 4);
            else if (isPlaying) drawPauseIcon(cv, px, cy, Math.round(playR * 0.72), '#0b0c0f');
            else drawPlayIcon(cv, px + 2, cy, Math.round(playR * 0.72), '#0b0c0f');
            cv.target(px - playR - 4, cy - playR - 4, (playR + 4) * 2, (playR + 4) * 2, () => runBusy('transport', () => spotify.togglePlay(), 'play'), 'np_play', playR + 4);
            x = px + playR + gap;
            plain('np_next', 'next', (qx, qy, c) => drawNextIcon(cv, qx, qy, iconSz, c), () => runBusy('transport', () => spotify.nextTrack(), 'next'), undefined, 'transport');
            const repMode = spotify.repeat;
            plain('np_repeat', null, (qx, qy, c) => drawRepeatIcon(cv, qx, qy, iconSz, c, repMode), () => runBusy('np_repeat', () => spotify.toggleRepeat()), !!(repMode && repMode !== 'off'));
            // the heart: theme crit/M red when liked
            const isLiked = !!spotify.isCurrentLiked, lx = mx + progW - hit + 4;
            if (isBusy('like')) drawSpinner(cv, lx + hit / 2, cy, sz(cv, 8), crit);
            else drawHeartIcon(cv, lx + hit / 2, cy + 1, iconSz, isLiked ? crit : '#aeb4bd', isLiked);
            cv.target(lx, cy - hit / 2, hit, hit, () => runBusy('like', () => spotify.toggleLikeCurrent()), 'np_like', hit / 2);

            // up next: the next songs' covers standing back in depth (the GPU only: in software, the next one)
            const upcoming = upNext(curTrk);
            artManager.loadQueue(upcoming.slice(0, 4).map((x2) => x2.albumArt));
            const qx = 1036;
            const qMax = Math.floor((1564 - qx) / 2.26);      // guarantees slot 3 ends <= 1564 on every screen
            const q = Math.min(qMax, Math.round(artSz * 0.64));
            cv.text(upcoming.length ? 'Up next' : 'Nothing queued', qx, 90, lab, t.dim);
            const SLOTS = [
                [qx, 112, q],
                [qx + Math.round(q * 0.87), 112 + Math.round(q * 0.055), Math.round(q * 0.71)],
                [qx + Math.round(q * 1.48), 112 + Math.round(q * 0.1), Math.round(q * 0.5)],
                [qx + Math.round(q * 1.9), 112 + Math.round(q * 0.136), Math.round(q * 0.355)],
            ];
            // faint horizon / floor line the depth queue stands on
            if (upcoming.length) {
                const floorY = SLOTS[0][1] + SLOTS[0][2] + 6;
                S.shadeX(cv, qx - 16, floorY, 1564 - (qx - 16), 1, '#ffffff', 0.12, 0.02);
            }
            const n = Math.min(upcoming.length, gpu ? 4 : 1);
            for (let k = n - 1; k >= 0; k--) {
                const dst = SLOTS[k], src = SLOTS[Math.min(SLOTS.length - 1, k + 1)];
                const sx = Math.round(dst[0] + (src[0] - dst[0]) * slide);
                const sy = Math.round(dst[1] + (src[1] - dst[1]) * slide);
                const s = Math.round(dst[2] + (src[2] - dst[2]) * slide);
                const trk = upcoming[k], cr = Math.max(3, Math.round(s * 0.024));
                if (gpu) S.softEllipse(cv, sx + s / 2, sy + s + 4, s * 0.56, Math.max(8, s * 0.075), '#000000', 0.8);
                if (artManager.hasQueueArt(k)) cv.image(ART_QUEUE_ID + k, sx, sy, s, s, cr);
                else cv.roundRect(sx, sy, s, s, cr, withAlpha('#ffffff', 0.05 - k * 0.01));
                if (k === 0) cv.strokeRoundRect(sx + 0.5, sy + 0.5, s - 1, s - 1, cr, 1, withAlpha('#ffffff', 0.14));
                const key = 'q:' + trk.id;
                const x0 = k ? Math.max(dst[0], SLOTS[k - 1][0] + SLOTS[k - 1][2]) : dst[0];      // the part not behind the one in front
                cv.target(x0, dst[1], dst[0] + dst[2] - x0, dst[2], () => playUpcoming(trk, key), 'q_trk_' + k, 4);
            }
            if (upcoming.length) {
                const nx = upcoming[0], [sx, sy, s] = SLOTS[0], nt = Math.min(sz(cv, 15), 22), na = Math.min(sz(cv, 12), 18);
                const inMs = Math.max(0, dur - spotify.progressMs);
                const infoMaxW = 1564 - sx;
                if (busyOn('start', 'q:' + nx.id)) drawSpinner(cv, sx + s - 14, sy + s + 20 + nt * 0.6, sz(cv, 7), selC);
                cv.text(fitText(cv, nx.title, infoMaxW - 24, nt, { font: 'bold' }), sx, sy + s + 22 + nt, nt, t.text, { font: 'bold' });
                const moreTxt = upcoming.length > 4 ? '+' + (upcoming.length - 4) + ' more' : '';
                const moreW = moreTxt ? cv.textWidth(moreTxt, na) + 16 : 0;
                cv.text(fitText(cv, nx.artist + '  ·  in ' + fmtTime(inMs), Math.max(120, infoMaxW - moreW), na), sx, sy + s + 30 + nt + na, na, t.dim);
                if (moreTxt) cv.text(moreTxt, 1564, sy + s + 30 + nt + na, na, t.dim, { align: 'right' });
            }
        }

        /* ---------- Page 3: Connect & Real Cloud Pairing ---------- */
        /** A QR code on a white square with a soft shadow under it, size px, top left x, y. */
        function drawQrBlock(cv, qr, url, x, y, size) {
            const modCount = qr.size, modPx = Math.floor(size / modCount), actualSz = modPx * modCount;
            const ox = x + Math.floor((size - actualSz) / 2), oy = y + Math.floor((size - actualSz) / 2);
            if (cv.place) S.softRect(cv, ox, oy + 14, actualSz, actualSz, 26, '#000000', 0.7);
            cv.roundRect(ox - 12, oy - 12, actualSz + 24, actualSz + 24, 4, '#ffffff');
            // drawn once as a layer (kit gauges.qrCode), not a rectangle per module every frame
            G.qrCode(cv, qr, url, ox, oy, modPx);
        }

        function drawConnect(cv, t) {
            const m = metrics(cv), authed = spotify.isAuthenticated(), acc = S.acc(t);
            if (!authed) showPhoneQr = false;

            // left: the account, or the code to pair with
            G.panelExact(cv, t, 24, 44, 560, m.panelH, authed && !showPhoneQr ? 'Your account' : authed ? 'Phone page' : 'Connect your phone');
            const lx = 24, lw = 540, panelBottom = m.listBottom;
            if (authed && !showPhoneQr) {
                const headSize = Math.min(sz(cv, 19), 28);
                const y = S.state(cv, t, lx, 104, lw, { tone: 'info', glow: !!cv.place, title: 'Connected to Spotify', size: headSize, lines: [] });
                const prof = spotify.profile;
                const plan = prof && prof.product ? prof.product.charAt(0).toUpperCase() + prof.product.slice(1) : '';
                const nPl = (spotify.playlists || []).length, nLiked = spotify.likedTotal || (spotify.likedSongs || []).length;
                const rows = [
                    ['Account', prof ? prof.name : 'Signed in'],
                    ['Plan', plan || '--'],
                    ['Playing on', spotify.activeDevice || 'No device: open Spotify on your phone'],
                    ['Library', nPl + ' playlist' + (nPl === 1 ? '' : 's') + ' · ' + nLiked + ' liked song' + (nLiked === 1 ? '' : 's')],
                ];
                // size rows + button to stay strictly above the bottom dock even on 8.8" standard layout
                const bh = Math.min(sz(cv, 28), 42), hintSz = Math.min(sz(cv, 11), 16);
                const availRows = Math.max(96, panelBottom - (y + 4) - bh - hintSz - 36);
                const rh = Math.min(sz(cv, 26), Math.floor(availRows / rows.length));
                const rs = Math.min(sz(cv, 12.5), Math.round(rh * 0.48));
                rows.forEach((r, i) => S.pair(cv, t, lx, y + 4 + i * rh, lw, rh, r[0], fitText(cv, r[1], lw - 160, rs), { size: rs, dot: i === 2 && spotify.activeDevice ? (spotify.isPlaying ? acc : t.dim) : null }));
                const by = Math.min(panelBottom - bh - hintSz - 16, y + 4 + rows.length * rh + 16);
                S.button(cv, t, lx, by, 'Show phone QR', () => { showPhoneQr = true; render().catch(() => {}); }, { h: bh, size: Math.min(sz(cv, 12), 18), key: 'btn_phone_qr' });
                cv.text(fitText(cv, 'Disconnect or switch account on your phone.', lw, hintSz), lx, by + bh + hintSz + 10, hintSz, t.dim);
            } else {
                // Clean elevated dark QR card (generous centered QR, crisp pairing code, zero wall of tiny text)
                const cardY = 104, cardH = Math.max(200, panelBottom - cardY);
                cv.roundRect(lx, cardY, lw, cardH, 6, '#101218');
                cv.strokeRoundRect(lx + 0.5, cardY + 0.5, lw - 1, cardH - 1, 6, 1, withAlpha('#ffffff', 0.09));
                const qr = getQrMatrix();
                const qrsz = Math.max(128, Math.min(200, cardH - 52));
                const qx = lx + 28, qy = cardY + Math.round((cardH - qrsz) / 2);
                if (qr) drawQrBlock(cv, qr, cachedQrUrl, qx, qy, qrsz);
                const tx = qx + qrsz + 34, tw = lx + lw - tx - 20;
                const ts = Math.min(sz(cv, 15.5), 22), ds = Math.min(sz(cv, 11.5), 16), codeSz = Math.min(sz(cv, 21), 28);
                const title = authed ? 'Phone page' : 'Scan with your phone';
                cv.text(fitText(cv, title, tw, ts, { font: 'bold' }), tx, qy + ts, ts, t.text, { font: 'bold' });
                const sub = authed ? 'Manage account & car settings.' : 'Sign in to Spotify on your phone.';
                cv.text(fitText(cv, sub, tw, ds), tx, qy + ts + ds + 10, ds, t.dim);
                const codeY = qy + ts + ds + 44;
                cv.text('Pairing code', tx, codeY, ds, t.dim);
                cv.text(cloudPair.getShortCode(), tx, codeY + codeSz + 4, codeSz, acc, { font: 'bold', literal: true });
                cv.text(fitText(cv, 'hexlay.github.io/.../pair.html', tw, Math.max(13, ds - 1), { literal: true }), tx, codeY + codeSz + 26, Math.max(13, ds - 1), t.dim, { literal: true });
                if (authed) {
                    const bbh = Math.min(sz(cv, 28), 38);
                    S.button(cv, t, tx, qy + qrsz - bbh + 6, 'Back to account', () => { showPhoneQr = false; render().catch(() => {}); },
                        { h: bbh, size: Math.min(sz(cv, 11.5), 16), key: 'btn_phone_qr_back', w: Math.min(tw, 190) });
                }
            }

            // right: the Spotify Connect devices
            G.panelExact(cv, t, 620, 44, 956, m.panelH, 'Spotify Connect devices');
            const devices = spotify.getDevices();
            const devBusy = isBusy('devices');
            if (!devices || devices.length === 0) {
                drawEmptyList(cv, t, 644, 120, 880, {
                    loading: devBusy, title: devBusy ? 'Looking for devices' : 'No Spotify devices found',
                    line: 'Open Spotify on your phone, computer or speaker and it shows here.',
                    button: devBusy ? null : { label: 'Refresh', key: 'btn_refresh_devs', run: () => runBusy('devices', () => spotify.fetchDevices()) },
                });
            } else {
                // as many as the panel holds; the one that plays first
                const rowH = sz(cv, 52), step = rowH + 6, devTop = m.listTop;
                const DEV_ROWS = Math.max(1, Math.floor((m.listBottom - devTop + 6) / step));
                const nSize = sz(cv, 16), sSize = sz(cv, 12);
                const shown = devices.slice().sort((x, y) => (y.isActive ? 1 : 0) - (x.isActive ? 1 : 0)).slice(0, DEV_ROWS);
                const rx = 620, rw = 956;
                shown.forEach((dev, idx) => {
                    const dy = devTop + idx * step, mid = dy + rowH / 2;
                    const isCur = !!dev.isActive, moving = busyOn('transfer', dev.id);
                    S.hairline(cv, rx, dy - 3, rw);
                    if (isCur) { S.shadeX(cv, rx, dy, rw * 0.55, rowH, acc, 0.14, 0); S.mark(cv, rx + 2, dy + rowH * 0.22, rowH * 0.56, acc); }
                    drawDeviceIcon(cv, rx + 40, mid, dev.type, isCur ? acc : '#aeb4bd');
                    const textX = rx + 82, bw = sz(cv, 104), bx = rx + rw - 12 - bw;
                    const vol = typeof dev.volume === 'number' ? '  ·  volume ' + dev.volume + ' %' : '';
                    cv.text(fitText(cv, dev.name, bx - 20 - textX, nSize, { font: 'bold' }), textX, mid - 3, nSize, t.text, { font: 'bold' });
                    cv.text(fitText(cv, (isCur ? (spotify.isPlaying ? 'Playing here' : 'Paused here') : dev.type) + vol, bx - 20 - textX, sSize), textX, mid + sSize + 5, sSize, isCur ? acc : t.dim);
                    if (isCur) {
                        S.led(cv, bx + bw - cv.textWidth('Active', sSize) - 16, mid, acc, !!cv.place);
                        cv.text('Active', bx + bw, mid + sSize * 0.36, sSize, t.text, { align: 'right' });
                    } else if (moving) drawSpinner(cv, bx + bw / 2, mid, sz(cv, 8), acc);
                    else S.button(cv, t, bx, mid - sz(cv, 15), 'Play here', null, { h: sz(cv, 30), size: sz(cv, 12), w: bw, busy: isBusy('transfer') });
                    cv.target(rx, dy, rw, rowH, () => {
                        if (!isCur) runBusy('transfer', () => spotify.transferToDevice(dev.id), dev.id);
                    }, 'dev_' + idx, 3);
                });
            }

            drawBottomPlayerDock(cv, t);
        }

        /* ---------- Master Render Loop ---------- */
        // What a frame shows, roughly: the loop draws again when it changes, or at least once a second
        // (data that isn't listed here then shows within a second). Taps, scrolling, the album art and
        // the pairing call render() themselves and always draw.
        function frameSig() {
            const trk = spotify.currentTrack, pl = spotify.currentPlaylist, n = spotify.notice;
            return [page, showPhoneQr, selectedPlaylistIdx, playlistScroll, trackScroll, likedScroll,
                settings.get('demo'), spotify.hasInternet, spotify.isAuthenticated(),
                trk ? trk.id : '', spotify.isPlaying, spotify.stalled, spotify.shuffle, spotify.repeat, spotify.isCurrentLiked,
                Math.floor((spotify.progressMs || 0) / 1000), spotify.contextUri, spotify.activeDevice,
                (spotify.playlists || []).length, pl ? pl.id + ':' + ((pl.tracks && pl.tracks.length) || 0) : '',
                (spotify.likedSongs || []).length, spotify.likedTotal, (spotify.remoteQueue || []).length,
                (spotify.devices || []).map((d) => d.id + (d.isActive ? '*' : '')).join(','),
                artManager.hasArt, artManager.currentUrl, artManager.queueSig(), artManager.thumbSig(), n && Date.now() - n.at <= NOTICE_MS ? n.text : ''].join('|');
        }
        let lastSig = '', lastDrawAt = 0;
        /** The loop's frame: drawn while something moves (music, a spinner, cover transition), on a change, or once a second. */
        function loopFrame() {
            const sliding = trackSlideAt && Date.now() - trackSlideAt < TRACK_SLIDE_MS + 50;
            const moving = spotify.isPlaying || sliding || Object.keys(busy).some(isBusy) || spotify.isLoadingPlaylists || spotify.isLoadingLiked;
            if (!moving && Date.now() - lastDrawAt < 1000) {
                spotify.tick();                 // the polls go on
                if (frameSig() === lastSig) return Promise.resolve();
            }
            return render();
        }

        async function render() {
            spotify.tick();
            spectrumSeed += 0.08;
            lastSig = frameSig();
            lastDrawAt = Date.now();

            if (spotify.currentTrack && spotify.currentTrack.albumArt) {
                artManager.load(spotify.currentTrack.albumArt);
            } else if (artManager.hasArt) {
                artManager.load(null);           // nothing playing: no leftover album art
            }

            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);

            const isOnline = settings.get('demo') !== 'on';

            // 1. Connection check: In Online mode, if there is no internet, disable app
            if (isOnline && !spotify.hasInternet) {
                drawNoInternet(cv, t);
                G.frame(cv, t, PAGES, page);
                await ui.image('MAIN_GFX', cv);
                return;
            }

            // 2. Authentication check: In Online mode, if unauthenticated, force Connect or Gating
            if (isOnline && !spotify.isAuthenticated()) {
                if (page === 3) {
                    drawConnect(cv, t);
                } else {
                    drawRequireConnect(cv, t);
                }
                G.frame(cv, t, PAGES, page);
                await ui.image('MAIN_GFX', cv);
                return;
            }

            // Normal Playback / Browsing screens
            if (page === 0) drawPlaylists(cv, t);
            else if (page === 1) drawLibrary(cv, t);
            else if (page === 2) drawNowPlaying(cv, t);
            else if (page === 3) drawConnect(cv, t);

            // the page tabs along the top, no status chips: the pages show their own state
            G.frame(cv, t, PAGES, page);

            drawNotice(cv, t);
            await ui.image('MAIN_GFX', cv);
        }

        /* What went wrong, for NOTICE_MS over the dock: a tap closes it sooner. */
        const NOTICE_MS = 5000;
        function drawNotice(cv, t) {
            const n = spotify.notice;
            if (!n || Date.now() - n.at > NOTICE_MS) return;
            const size = 16, opts = { font: 'bold' };
            // over the dock's top edge; on Now Playing (no dock, the controls at the bottom) over Up Next
            const onNp = page === 2;
            const cx = onNp ? 1248 : 800, maxW = onNp ? 540 : 1100;
            const text = fitText(cv, n.text, maxW, size, opts);
            const w = cv.textWidth(text, size, opts) + 76, h = 46;
            const x = Math.round(cx - w / 2), y = 446 + (cv.extra || 0) - h - (onNp ? -40 : 12);
            cv.roundRect(x, y, w, h, 3, '#17181d');
            cv.strokeRoundRect(x + 0.5, y + 0.5, w - 1, h - 1, 3, 1, withAlpha('#ffffff', 0.16));
            S.mark(cv, x + 18, y + 12, h - 24, S.warnC(t));
            cv.text(text, x + 46, y + h / 2 + 6, size, '#ffffff', opts);
            cv.target(x, y, w, h, () => { spotify.notice = null; render(); }, 'notice', 3);
            // over the list rows: a tap on it is its own (the first target under a finger wins)
            if (Array.isArray(cv.targets)) cv.targets.unshift(cv.targets.pop());
        }

        /* ---------- HMI Button & Touch Interactions ---------- */
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; return render(); });
        ctx.onTab((idx) => { page = idx; showPhoneQr = false; return render(); });

        // 30 fps while music plays (spectrum, progress), 10 fps otherwise - and an unchanged frame
        // isn't drawn again (loopFrame); taps redraw at once
        ctx.loop('MAIN', 15, loopFrame, { maxFps: () => (spotify.isPlaying ? 30 : 10) });
        // where the frame goes changed (renderer, layout): draw it again there
        if (ctx.onLayout) ctx.onLayout(() => { render().catch(() => {}); });
        await render();
        log.info('Spotify app ready');
    }
});
