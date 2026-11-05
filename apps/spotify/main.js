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
const { SpotifyClient } = require('./api');
const { CloudPairManager } = require('./cloud_pair');
const { AlbumArtManager, ART_IMG_ID } = require('./art');
const qrcodegen = require('./qrcodegen');

const W = 1600, H = 520;
const PAGES = ['Playlists', 'Liked Songs', 'Now Playing', 'Connect'];

// Format milliseconds as MM:SS
function fmtTime(ms) {
    if (!ms || ms < 0) return '0:00';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return m + ':' + (rem < 10 ? '0' : '') + rem;
}

// String truncation with clean ellipsis
function trunc(str, maxLen) {
    if (!str || typeof str !== 'string') return '';
    return str.length > maxLen ? str.slice(0, maxLen - 1) + '..' : str;
}

// Sleek iDrive vertical scrollbar
function drawScrollbar(cv, t, x, y, h, total, visibleCount, scrollOffset, onScrollUp, onScrollDown) {
    if (total <= visibleCount) return;
    const barW = 5;
    // Track background
    cv.roundRect(x, y, barW, h, 2.5, withAlpha(t.panelEdge, 0.4));
    // Thumb calculation
    const maxScroll = Math.max(1, total - visibleCount);
    const thumbH = Math.max(30, Math.round((visibleCount / total) * h));
    const travel = h - thumbH;
    const thumbY = y + Math.round((Math.min(scrollOffset, maxScroll) / maxScroll) * travel);
    // Thumb fill
    cv.roundRect(x, thumbY, barW, thumbH, 2.5, withAlpha(t.accent, 0.7));

    // Touch targets: tapping upper half scrolls up, lower half scrolls down
    if (onScrollUp) {
        cv.target(x - 12, y, 30, Math.floor(h / 2), onScrollUp, 'sb_up_' + x, 8);
    }
    if (onScrollDown) {
        cv.target(x - 12, y + Math.floor(h / 2), 30, Math.ceil(h / 2), onScrollDown, 'sb_down_' + x, 8);
    }
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
function drawLoadingRow(cv, t, x, y, w, label) {
    cv.roundRect(x, y, w, 42, 8, withAlpha(t.track, 0.6));
    drawSpinner(cv, x + 22, y + 21, 8, t.accent);
    cv.text(label, x + 44, y + 27, 15, t.dim);
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

/** A spinner just left of a centred loading title (str drawn at cx, baseline y, this size). */
function drawSpinnerBefore(cv, str, cx, y, size, col) {
    const w = cv.textWidth ? cv.textWidth(str, size, { font: 'bold', spacing: 1 }) : str.length * size * 0.6;
    drawSpinner(cv, cx - w / 2 - size, y - size * 0.36, size * 0.42, col);
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
        cloudPair.startPolling();
        // background: no internet checks, slow pairing polls
        const onScreen = () => !ui.isVisible || ui.isVisible('MAIN');
        spotify.isOnScreen = onScreen;
        cloudPair.isOnScreen = onScreen;

        // Default to Online mode (demo !== 'on')
        // If not authenticated, open directly on the Connect tab!
        const isOnlineMode = settings.get('demo') !== 'on';
        let page = (isOnlineMode && !spotify.isAuthenticated()) ? 3 : 0;
        let selectedPlaylistIdx = 0;
        let playlistScroll = 0;
        let trackScroll = 0;
        let likedScroll = 0;
        let queueScroll = 0;

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
        const scrollGet = { pl: () => playlistScroll, trk: () => trackScroll, liked: () => likedScroll, q: () => queueScroll };
        const scrollSet = { pl: (v) => { playlistScroll = v; }, trk: (v) => { trackScroll = v; }, liked: (v) => { likedScroll = v; }, q: (v) => { queueScroll = v; } };
        let scrollAcc = 0, scrollList = null;
        ctx.onScroll((dy, at) => {
            const names = page === 0 ? ['pl', 'trk'] : page === 1 ? ['liked'] : page === 2 ? ['q'] : [];
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

        /* ---------- Offline Safeguard Screen: No Internet Connection ---------- */
        function drawNoInternet(cv, t) {
            G.panel(cv, t, 24, 44, 1552, 468, 'Network Status: Offline');

            cv.roundRect(48, 100, 1504, 388, 16, '#0f141f');
            cv.strokeRoundRect(48, 100, 1504, 388, 16, 2, '#e1001a');

            cv.circle(148, 250, 48, withAlpha('#e1001a', 0.2));
            cv.text('!', 148, 266, 50, '#e1001a', { align: 'center', font: 'bold' });

            cv.text('NO INTERNET CONNECTION', 228, 195, 28, '#e1001a', { font: 'bold', spacing: 1 });
            cv.text('Spotify Online requires an active internet connection on your vehicle.', 228, 240, 19, '#ffffff');
            cv.text('Please verify that your BMW has cellular data or is connected to a mobile Wi-Fi hotspot.', 228, 276, 17, '#94a3b8');

            // Action Buttons: [RETRY CONNECTION] and [SWITCH TO DEMO MODE]
            const btnW = 280, btnH = 52, btnY = 345;
            const b1X = 228;
            const netBusy = isBusy('net');
            cv.roundRect(b1X, btnY, btnW, btnH, 10, netBusy ? '#00365f' : '#004e8c');
            cv.strokeRoundRect(b1X, btnY, btnW, btnH, 10, 1.5, '#00a3e0');
            if (netBusy) {
                drawSpinner(cv, b1X + 62, btnY + btnH / 2, 10, '#ffffff');
                cv.text('CHECKING...', b1X + btnW / 2 + 14, btnY + 32, 16, '#cbd5e1', { align: 'center', font: 'bold', spacing: 1 });
            } else {
                cv.text('RETRY CONNECTION', b1X + btnW / 2, btnY + 32, 16, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });
            }
            cv.target(b1X, btnY, btnW, btnH, () => {
                runBusy('net', () => spotify.checkInternetConnection());
            }, 'btn_retry_net', 15);

            const b2X = b1X + btnW + 24;
            cv.roundRect(b2X, btnY, btnW, btnH, 10, '#1a2332');
            cv.strokeRoundRect(b2X, btnY, btnW, btnH, 10, 1, '#334155');
            cv.text('SWITCH TO DEMO MODE', b2X + btnW / 2, btnY + 32, 15, '#cbd5e1', { align: 'center', font: 'bold' });
            cv.target(b2X, btnY, btnW, btnH, () => {
                settings.set('demo', 'on');
                spotify.isDemoMode = true;
                spotify.playlists = require('./api').DEMO_PLAYLISTS;
                spotify.devices = require('./api').DEMO_DEVICES;
                render();
            }, 'btn_switch_demo', 15);
        }

        /* ---------- Gating Screen: Authentication Required in Online Mode ---------- */
        function drawRequireConnect(cv, t) {
            G.panel(cv, t, 24, 44, 1552, 468, 'Spotify Login Required');

            cv.roundRect(48, 100, 1504, 388, 16, '#0c1522');
            cv.strokeRoundRect(48, 100, 1504, 388, 16, 2, '#1ed760');

            cv.circle(148, 250, 48, withAlpha('#1ed760', 0.2));
            drawPlayIcon(cv, 151, 250, 36, '#1ed760');

            cv.text('SPOTIFY LOGIN REQUIRED', 228, 195, 28, '#ffffff', { font: 'bold', spacing: 1 });
            cv.text('Online Mode is active. Please pair your personal Spotify account to browse your library and control playback.', 228, 240, 18, '#cbd5e1');
            cv.text('Scan the QR code with your phone to sync your playlists and Spotify Connect target devices.', 228, 276, 16, '#94a3b8');

            const btnW = 340, btnH = 52, btnY = 345, bX = 228;
            cv.roundRect(bX, btnY, btnW, btnH, 10, '#1ed760');
            cv.text('PAIR PHONE (SCAN QR CODE)', bX + btnW / 2, btnY + 32, 16, '#000000', { align: 'center', font: 'bold', spacing: 1 });
            cv.target(bX, btnY, btnW, btnH, () => {
                page = 3; // Switch to Connect tab
            }, 'btn_goto_connect', 15);
        }

        /* ---------- Bottom Now Playing Player Dock ---------- */
        function drawBottomPlayerDock(cv, t) {
            const curTrk = spotify.currentTrack;
            const isPlaying = spotify.isPlaying;
            const dockX = 24, dockY = 446 + (cv.extra || 0), dockW = 1552, dockH = 66;

            // Dock backdrop & border
            cv.roundRect(dockX, dockY, dockW, dockH, 12, withAlpha(t.panelEdge, 0.9));
            cv.strokeRoundRect(dockX, dockY, dockW, dockH, 12, 1, isPlaying ? withAlpha(t.accent, 0.4) : withAlpha(t.panelEdge, 0.8));

            // Mini artwork / Equalizer box
            const miniX = dockX + 10, miniY = dockY + 9, miniSz = 48;
            cv.roundRect(miniX, miniY, miniSz, miniSz, 8, withAlpha(t.panelEdge, 0.9));
            if (artManager.hasArt) {
                cv.image(ART_IMG_ID, miniX, miniY, miniSz, miniSz);
                cv.strokeRoundRect(miniX, miniY, miniSz, miniSz, 8, 1, withAlpha(t.accent, 0.35));
            } else {
                cv.strokeRoundRect(miniX, miniY, miniSz, miniSz, 8, 1, withAlpha(t.accent, 0.3));
                drawMiniEqualizer(cv, miniX + 24, miniY + 24, isPlaying ? t.accent : t.dim, isPlaying, spectrumSeed);
            }

            // Track metadata
            if (curTrk) {
                // up to the time in the middle of the dock
                const dockTextW = 820 - (dockX + 70);
                cv.text(fitText(cv, curTrk.title, dockTextW, 18, { font: 'bold' }), dockX + 70, dockY + 28, 18, isPlaying ? t.accent : t.text, { font: 'bold' });
                const metaStr = curTrk.artist + (curTrk.album ? '  -  ' + curTrk.album : '');
                cv.text(fitText(cv, metaStr, dockTextW, 14), dockX + 70, dockY + 49, 14, t.dim);
            } else {
                cv.text('No Track Playing', dockX + 70, dockY + 28, 18, t.dim, { font: 'bold' });
                cv.text('Select any song from Playlists or Liked Songs to begin', dockX + 70, dockY + 49, 14, t.dim);
            }

            // Tapping left half opens full Now Playing screen
            cv.target(dockX, dockY, 700, dockH, () => {
                page = 2; // Switch to Now Playing screen
                render();
            }, 'dock_open_np', 10);

            // Center: Elapsed / Duration timestamp
            if (curTrk) {
                cv.text(fmtTime(spotify.progressMs) + ' / ' + fmtTime(curTrk.durationMs), 880, dockY + 38, 15, t.dim, { align: 'center', font: 'num' });
            }

            // Controls on Right: Prev, Play/Pause, Next, Now Playing button
            // 1. Prev
            const prevX = 1160, prevY = dockY + 12, prevW = 54, prevH = 42;
            cv.roundRect(prevX, prevY, prevW, prevH, 8, withAlpha(t.panelEdge, 0.7));
            if (busyOn('transport', 'prev')) drawSpinner(cv, prevX + prevW / 2, prevY + prevH / 2, 9, t.text);
            else drawPrevIcon(cv, prevX + prevW / 2, prevY + prevH / 2, 16, isBusy('transport') ? t.dim : t.text);
            cv.target(prevX, prevY, prevW, prevH, () => {
                runBusy('transport', () => spotify.prevTrack(), 'prev');
            }, 'dock_prev', 12);

            // 2. Play / Pause
            const playX = 1228, playY = dockY + 9, playW = 72, playH = 48;
            cv.roundRect(playX, playY, playW, playH, 24, isBusy('transport') ? withAlpha(t.accent, 0.6) : t.accent);
            if (busyOn('transport', 'play')) {
                drawSpinner(cv, playX + playW / 2, playY + playH / 2, 10, '#000000');
            } else if (isPlaying) {
                drawPauseIcon(cv, playX + playW / 2, playY + playH / 2, 18, '#000000');
            } else {
                drawPlayIcon(cv, playX + playW / 2, playY + playH / 2, 18, '#000000');
            }
            cv.target(playX, playY, playW, playH, () => {
                runBusy('transport', () => spotify.togglePlay(), 'play');
            }, 'dock_play', 15);

            // 3. Next
            const nextX = 1314, nextY = dockY + 12, nextW = 54, nextH = 42;
            cv.roundRect(nextX, nextY, nextW, nextH, 8, withAlpha(t.panelEdge, 0.7));
            if (busyOn('transport', 'next')) drawSpinner(cv, nextX + nextW / 2, nextY + nextH / 2, 9, t.text);
            else drawNextIcon(cv, nextX + nextW / 2, nextY + nextH / 2, 16, isBusy('transport') ? t.dim : t.text);
            cv.target(nextX, nextY, nextW, nextH, () => {
                runBusy('transport', () => spotify.nextTrack(), 'next');
            }, 'dock_next', 12);

            // 4. "NOW PLAYING >" button
            const npX = 1382, npY = dockY + 12, npW = 154, npH = 42;
            cv.roundRect(npX, npY, npW, npH, 8, withAlpha(t.accent, 0.2));
            cv.strokeRoundRect(npX, npY, npW, npH, 8, 1, withAlpha(t.accent, 0.4));
            cv.text('NOW PLAYING >', npX + npW / 2, npY + 26, 13, t.accent, { align: 'center', font: 'bold', spacing: 0.5 });
            cv.target(npX, npY, npW, npH, () => {
                page = 2; // Switch to Now Playing screen
                render();
            }, 'dock_btn_np', 12);

            // Thin progress line along the bottom edge of dock
            const dur = (curTrk && curTrk.durationMs) ? curTrk.durationMs : 1;
            const pFrac = Math.min(1, Math.max(0, spotify.progressMs / dur));
            cv.roundRect(dockX + 4, dockY + dockH - 4, dockW - 8, 3, 1.5, t.tick);
            if (pFrac > 0) {
                cv.roundRect(dockX + 4, dockY + dockH - 4, Math.round((dockW - 8) * pFrac), 3, 1.5, t.accent);
            }
        }

        /* ---------- Page 0: Playlists & Tracks ---------- */
        function drawPlaylists(cv, t) {
            const playlists = spotify.getPlaylists();
            const ex = cv.extra || 0;          // room below the page: panels and lists go down to the dock

            if (!playlists || playlists.length === 0) {
                if (isOnlineMode && !spotify.isAuthenticated()) {
                    drawRequireConnect(cv, t);
                } else {
                    G.panelExact(cv, t, 24, 44, 1552, 396 + ex, 'Your Playlists (0)');

                    cv.roundRect(48, 100, 1504, 200, 12, t.track);
                    cv.strokeRoundRect(48, 100, 1504, 200, 12, 1, t.panelEdge);

                    const loading = spotify.isLoadingPlaylists || spotify.syncing;
                    cv.text(loading ? 'LOADING PLAYLISTS...' : 'NO PLAYLISTS FOUND', 800, 175, 22, t.dim, { align: 'center', font: 'bold', spacing: 1 });
                    if (loading) drawSpinnerBefore(cv, 'LOADING PLAYLISTS...', 800, 175, 22, t.accent);
                    cv.text(loading ? 'Fetching your playlists from Spotify cloud...' : 'Create or follow playlists on Spotify, or browse Liked Songs.', 800, 210, 16, t.dim, { align: 'center' });

                    const rfW = 240, rfH = 44, rfX = 680, rfY = 236;
                    const plBusy = isBusy('playlists') || spotify.isLoadingPlaylists;
                    cv.roundRect(rfX, rfY, rfW, rfH, 8, withAlpha(t.accent, plBusy ? 0.1 : 0.22));
                    cv.strokeRoundRect(rfX, rfY, rfW, rfH, 8, 1.5, withAlpha(t.accent, plBusy ? 0.5 : 1));
                    if (plBusy) {
                        drawSpinner(cv, rfX + 40, rfY + rfH / 2, 9, t.accent);
                        cv.text('LOADING...', rfX + rfW / 2 + 12, rfY + 27, 14, withAlpha(t.accent, 0.8), { align: 'center', font: 'bold', spacing: 1 });
                    } else {
                        cv.text('REFRESH PLAYLISTS', rfX + rfW / 2, rfY + 27, 14, t.accent, { align: 'center', font: 'bold', spacing: 1 });
                    }
                    cv.target(rfX, rfY, rfW, rfH, () => {
                        if (!spotify.isLoadingPlaylists) runBusy('playlists', () => spotify.fetchPlaylists());
                    }, 'btn_refresh_pls', 12);

                    drawBottomPlayerDock(cv, t);
                }
                return;
            }

            // Keep selected index valid
            if (selectedPlaylistIdx >= playlists.length) selectedPlaylistIdx = 0;

            // Visible window for playlists (scrolled freely: not pulled back to the selection)
            const VISIBLE_PL = 5 + Math.floor(ex / 66);
            playlistScroll = Math.max(0, Math.min(playlistScroll, Math.max(0, playlists.length - VISIBLE_PL)));
            listGeo.pl = { x0: 24, x1: 532, rowH: 66, count: playlists.length, visible: VISIBLE_PL };
            cv.scroll = true;

            // Left Pane: Playlists (w: 500, h: 396)
            const plTitle = 'Your Playlists (' + (selectedPlaylistIdx + 1) + '/' + playlists.length + ')';
            G.panelExact(cv, t, 24, 44, 500, 396 + ex, plTitle);

            // Left Pane Scrollbar
            drawScrollbar(cv, t, 508, 98, 330 + ex, playlists.length, VISIBLE_PL, playlistScroll, () => {
                playlistScroll = Math.max(0, playlistScroll - 1);
                selectedPlaylistIdx = Math.max(0, selectedPlaylistIdx - 1);
                spotify.selectPlaylist(playlists[selectedPlaylistIdx]);
            }, () => {
                playlistScroll = Math.min(Math.max(0, playlists.length - VISIBLE_PL), playlistScroll + 1);
                selectedPlaylistIdx = Math.min(playlists.length - 1, selectedPlaylistIdx + 1);
                spotify.selectPlaylist(playlists[selectedPlaylistIdx]);
            });

            const visiblePlaylists = playlists.slice(playlistScroll, playlistScroll + VISIBLE_PL);
            visiblePlaylists.forEach((pl, vIdx) => {
                const realIdx = playlistScroll + vIdx;
                const py = 98 + vIdx * 66;
                const isSel = realIdx === selectedPlaylistIdx;
                const isPlPlaying = playingFrom(pl);       // the playlist Spotify plays from, selected or not

                cv.roundRect(38, py, 460, 58, 10, isSel ? withAlpha(t.accent, 0.22) : t.track);
                if (isSel) cv.strokeRoundRect(38, py, 460, 58, 10, 2, t.accent);

                // Accent tag
                cv.roundRect(44, py + 8, 5, 42, 2.5, isPlPlaying ? t.accent : (pl.accent || t.accent));
                const plTextW = (isPlPlaying ? 452 : 486) - 62;     // up to the equalizer, or the row's end
                cv.text(fitText(cv, pl.name, plTextW, 21, { font: 'bold' }), 62, py + 26, 21, isSel ? t.text : '#e0e0e0', { font: 'bold' });
                cv.text(fitText(cv, (pl.trackCount || 0) + ' songs  -  ' + (pl.description || 'Playlist'), plTextW, 15), 62, py + 48, 15, t.dim);

                if (isPlPlaying) {
                    drawMiniEqualizer(cv, 470, py + 29, t.accent, spotify.isPlaying, spectrumSeed);
                }

                cv.target(38, py, 460, 58, () => {
                    selectedPlaylistIdx = realIdx;
                    trackScroll = 0;
                    spotify.selectPlaylist(pl);
                }, 'pl_' + realIdx, 10);
            });

            // Right Pane: Tracks of selected playlist (x: 540, w: 1036, h: 396)
            const curPl = playlists[selectedPlaylistIdx] || playlists[0];
            // the track that plays, in this playlist (another playlist's context marks nothing here)
            const ctxHere = !spotify.contextUri || !/:playlist:/.test(spotify.contextUri) || playingFrom(curPl);
            const trackTotal = curPl.trackCount || (curPl.tracks ? curPl.tracks.length : 0);

            G.panelExact(cv, t, 540, 44, 1036, 396 + ex, fitText(cv, curPl.name, 760, 26, { font: 'bold' }) + ' (' + trackTotal + ' tracks)');

            // the songs of the playlist shown: fetched (and retried) from here, whatever selected it
            spotify.ensureTracks(curPl);

            if (!curPl.tracks || curPl.tracks.length === 0) {
                const none = !!curPl.tracksLoaded;
                cv.roundRect(556, 120, 1004, 180, 12, t.track);
                cv.text(none ? 'NO SONGS' : 'LOADING SONGS...', 1058, 195, 22, t.dim, { align: 'center', font: 'bold', spacing: 1 });
                if (!none) drawSpinnerBefore(cv, 'LOADING SONGS...', 1058, 195, 22, t.accent);
                cv.text(none ? 'This playlist has no songs that can be played here.' : 'Fetching track list from Spotify cloud...', 1058, 230, 16, t.dim, { align: 'center' });
            } else {
                const VISIBLE_TRK = 7 + Math.floor(ex / 47);
                // more songs than loaded: a "loading" row closes the list, and the next page comes
                // as the list nears its end
                const moreTrk = spotify.hasMoreTracks(curPl);
                const trkRows = curPl.tracks.length + (moreTrk ? 1 : 0);
                trackScroll = Math.max(0, Math.min(trackScroll, Math.max(0, trkRows - VISIBLE_TRK)));
                listGeo.trk = { x0: 540, x1: 1576, rowH: 47, count: trkRows, visible: VISIBLE_TRK };
                if (moreTrk && trackScroll + VISIBLE_TRK >= curPl.tracks.length - 5) spotify.loadMoreTracks(curPl);

                // Right Pane Tracks Scrollbar
                drawScrollbar(cv, t, 1554, 98, 330 + ex, trkRows, VISIBLE_TRK, trackScroll, () => {
                    trackScroll = Math.max(0, trackScroll - VISIBLE_TRK);
                }, () => {
                    trackScroll = Math.min(Math.max(0, trkRows - VISIBLE_TRK), trackScroll + VISIBLE_TRK);
                });

                const visibleTracks = curPl.tracks.slice(trackScroll, trackScroll + VISIBLE_TRK);
                if (moreTrk && trackScroll + VISIBLE_TRK > curPl.tracks.length) {
                    drawLoadingRow(cv, t, 556, 98 + (curPl.tracks.length - trackScroll) * 47, 980,
                        'Loading more songs (' + curPl.tracks.length + ' of ' + (curPl._total || trackTotal) + ')...');
                }

                visibleTracks.forEach((trk, vIdx) => {
                    const realIdx = trackScroll + vIdx;
                    const ty = 98 + vIdx * 47;
                    const startKey = 'pl:' + curPl.id + ':' + realIdx;
                    const starting = busyOn('start', startKey);
                    const isPlayingThis = starting || (ctxHere && isPlayingTrack(trk));

                    if (isPlayingThis) {
                        cv.roundRect(556, ty, 980, 42, 8, withAlpha(t.accent, 0.22));
                        cv.strokeRoundRect(556, ty, 980, 42, 8, 1.5, t.accent);
                        if (starting) drawSpinner(cv, 578, ty + 21, 8, t.accent);
                        else drawMiniEqualizer(cv, 578, ty + 21, t.accent, spotify.isPlaying, spectrumSeed);
                    } else {
                        cv.roundRect(556, ty, 980, 42, 8, t.track);
                        cv.text(String(realIdx + 1), 578, ty + 26, 15, t.dim, { align: 'center', font: 'num' });
                    }

                    // Strict column bounds prevent overlap:
                    cv.text(fitText(cv, trk.title, 290, 19, { font: 'bold' }), 606, ty + 27, 19, isPlayingThis ? t.accent : t.text, { font: 'bold' });
                    const metaText = trk.artist + (trk.album ? '  -  ' + trk.album : '');
                    cv.text(fitText(cv, metaText, (isPlayingThis ? 1384 : 1460) - 910, 16), 910, ty + 27, 16, t.dim);
                    cv.text(fmtTime(trk.durationMs), isPlayingThis ? 1430 : 1510, ty + 27, 15, t.dim, { align: 'right', font: 'num' });

                    if (isPlayingThis) {
                        cv.roundRect(1444, ty + 7, 54, 28, 6, starting ? withAlpha(t.accent, 0.35) : t.accent);
                        cv.text(starting ? 'WAIT' : 'PLAYING', 1471, ty + 24, 11, starting ? t.accent : '#000000', { align: 'center', font: 'bold' });
                    }

                    cv.target(556, ty, 980, 42, () => {
                        runBusy('start', () => spotify.playTrack(curPl, realIdx), startKey);
                    }, 'trk_' + realIdx, 8);
                });
            }

            // Bottom Player Dock
            drawBottomPlayerDock(cv, t);
        }

        /* ---------- Page 1: Liked Songs ---------- */
        function drawLibrary(cv, t) {
            if (isOnlineMode && !spotify.isAuthenticated()) {
                drawRequireConnect(cv, t);
                return;
            }

            const liked = (spotify.likedSongs && spotify.likedSongs.length)
                ? spotify.likedSongs
                : (spotify.isDemoMode ? require('./api').DEMO_PLAYLISTS[3].tracks : []);

            const total = spotify.likedTotal || liked.length;
            const ex = cv.extra || 0;
            const VISIBLE_LIKED = 7 + Math.floor(ex / 47);
            // more liked songs than loaded: a "loading" row closes the list, the next page comes near its end
            const moreLiked = liked === spotify.likedSongs && spotify.hasMoreLiked();
            const likedRows = liked.length + (moreLiked ? 1 : 0);
            likedScroll = Math.max(0, Math.min(likedScroll, Math.max(0, likedRows - VISIBLE_LIKED)));
            listGeo.liked = { x0: 24, x1: 1576, rowH: 47, count: likedRows, visible: VISIBLE_LIKED };
            if (moreLiked && likedScroll + VISIBLE_LIKED >= liked.length - 5) spotify.loadMoreLiked();
            cv.scroll = true;
            const startIdx = total > 0 ? likedScroll + 1 : 0;
            const endIdx = Math.min(likedScroll + VISIBLE_LIKED, liked.length, total);
            const title = 'Liked Songs (' + (total > 0 ? (startIdx + '-' + endIdx + ' of ' + total) : '0') + ' tracks)';

            G.panelExact(cv, t, 24, 44, 1552, 396 + ex, title);

            // Liked Songs Scrollbar
            drawScrollbar(cv, t, 1554, 98, 330 + ex, likedRows, VISIBLE_LIKED, likedScroll, () => {
                likedScroll = Math.max(0, likedScroll - VISIBLE_LIKED);
            }, () => {
                likedScroll = Math.min(Math.max(0, likedRows - VISIBLE_LIKED), likedScroll + VISIBLE_LIKED);
            });

            if (!liked || liked.length === 0) {
                cv.roundRect(48, 100, 1504, 200, 12, t.track);
                cv.strokeRoundRect(48, 100, 1504, 200, 12, 1, t.panelEdge);
                const loading = spotify.isLoadingLiked || spotify.syncing;
                cv.text(loading ? 'LOADING LIKED SONGS...' : 'NO LIKED SONGS FOUND', 800, 180, 22, t.dim, { align: 'center', font: 'bold', spacing: 1 });
                if (loading) drawSpinnerBefore(cv, 'LOADING LIKED SONGS...', 800, 180, 22, t.accent);
                cv.text(loading ? 'Fetching your saved songs from Spotify cloud...' : 'Like songs on Spotify to access them directly here.', 800, 215, 16, t.dim, { align: 'center' });
                drawBottomPlayerDock(cv, t);
                return;
            }

            const visible = liked.slice(likedScroll, likedScroll + VISIBLE_LIKED);
            if (moreLiked && likedScroll + VISIBLE_LIKED > liked.length) {
                drawLoadingRow(cv, t, 40, 98 + (liked.length - likedScroll) * 47, 1500,
                    'Loading more liked songs (' + liked.length + ' of ' + total + ')...');
            }
            visible.forEach((trk, vIdx) => {
                const realIdx = likedScroll + vIdx;
                const ty = 98 + vIdx * 47;
                const startKey = 'liked:' + realIdx;
                const starting = busyOn('start', startKey);
                const isPlayingThis = starting || isPlayingTrack(trk);

                if (isPlayingThis) {
                    cv.roundRect(40, ty, 1500, 42, 8, withAlpha(t.accent, 0.22));
                    cv.strokeRoundRect(40, ty, 1500, 42, 8, 1.5, t.accent);
                    if (starting) drawSpinner(cv, 64, ty + 21, 8, t.accent);
                    else drawMiniEqualizer(cv, 64, ty + 21, t.accent, spotify.isPlaying, spectrumSeed);
                } else {
                    cv.roundRect(40, ty, 1500, 42, 8, t.track);
                    cv.text(String(realIdx + 1), 64, ty + 26, 15, t.dim, { align: 'center', font: 'num' });
                }

                // Heart tag
                drawHeartIcon(cv, 98, ty + 21, 15, '#1ed760', true);

                cv.text(fitText(cv, trk.title, 540, 19, { font: 'bold' }), 126, ty + 27, 19, isPlayingThis ? t.accent : t.text, { font: 'bold' });
                const metaText = trk.artist + (trk.album ? '  -  ' + trk.album : '');
                cv.text(fitText(cv, metaText, (isPlayingThis ? 1394 : 1466) - 680, 16), 680, ty + 27, 16, t.dim);
                cv.text(fmtTime(trk.durationMs), isPlayingThis ? 1440 : 1510, ty + 27, 15, t.dim, { align: 'right', font: 'num' });

                if (isPlayingThis) {
                    cv.roundRect(1450, ty + 7, 54, 28, 6, starting ? withAlpha(t.accent, 0.35) : t.accent);
                    cv.text(starting ? 'WAIT' : 'PLAYING', 1477, ty + 24, 11, starting ? t.accent : '#000000', { align: 'center', font: 'bold' });
                }

                cv.target(40, ty, 1500, 42, () => {
                    runBusy('start', () => spotify.playLikedSong(realIdx), startKey);
                }, 'liked_' + realIdx, 8);
            });

            // Bottom Player Dock
            drawBottomPlayerDock(cv, t);
        }

        /* ---------- Page 2: Now Playing & Queue ---------- */
        function drawNowPlaying(cv, t) {
            if (isOnlineMode && !spotify.isAuthenticated()) {
                drawRequireConnect(cv, t);
                return;
            }

            const curTrk = spotify.currentTrack;
            const isPlaying = spotify.isPlaying;
            const npEx = cv.extra || 0;        // the panels reach the screen's bottom: controls move with it

            // Left Pane: Now Playing Cockpit (w: 880, h: 468)
            G.panel(cv, t, 24, 44, 880, 468, 'Now Playing');

            if (!curTrk) {
                cv.roundRect(48, 120, 832, 220, 12, t.track);
                cv.text('NO TRACK PLAYING', 464, 215, 22, t.dim, { align: 'center', font: 'bold', spacing: 1 });
                cv.text('Select any song from Playlists or Liked Songs to begin playback.', 464, 255, 16, t.dim, { align: 'center' });
            } else {
                // Vinyl / Album Art Box
                const artX = 54, artY = 104, artSz = 230;
                cv.roundRect(artX, artY, artSz, artSz, 14, '#0c1015');

                if (artManager.hasArt) {
                    cv.image(ART_IMG_ID, artX, artY, artSz, artSz);
                    cv.strokeRoundRect(artX, artY, artSz, artSz, 14, 1.5, isPlaying ? withAlpha(t.accent, 0.4) : withAlpha(t.panelEdge, 0.8));
                } else {
                    cv.strokeRoundRect(artX, artY, artSz, artSz, 14, 1.5, isPlaying ? withAlpha(t.accent, 0.4) : withAlpha(t.panelEdge, 0.8));

                    // Vinyl disc representation
                    const cx = artX + artSz / 2, cy = artY + artSz / 2;
                    cv.circle(cx, cy, 98, '#07090c');
                    cv.circle(cx, cy, 80, '#12161c');
                    cv.circle(cx, cy, 60, '#0a0d12');
                    cv.circle(cx, cy, 40, isPlaying ? withAlpha(t.accent, 0.3) : withAlpha(t.panelEdge, 0.5));
                    cv.circle(cx, cy, 14, isPlaying ? t.accent : t.dim);

                    // Multi-bar animated visualizer in center
                    drawMiniEqualizer(cv, cx, cy, '#ffffff', isPlaying, spectrumSeed);
                }

                // Right of Album Art: Track Info, as wide as the panel lets it be
                const metaX = 310, metaW = 880 - metaX;

                // where it plays: a pill as wide as its text, a live dot when music plays
                const devOpts = { font: 'bold', spacing: 1 };
                const devText = fitText(cv, spotify.activeDevice ? 'PLAYING ON  ' + spotify.activeDevice.toUpperCase() : 'SPOTIFY CONNECT', metaW - 44, 12, devOpts);
                const devW = cv.textWidth(devText, 12, devOpts) + 42;
                cv.roundRect(metaX, 106, devW, 28, 14, withAlpha(t.accent, 0.16));
                cv.circle(metaX + 16, 120, 4.5, isPlaying ? t.accent : withAlpha(t.accent, 0.45));
                cv.text(devText, metaX + 30, 125, 12, t.accent, devOpts);

                // Title, artist, album: cut only where the panel ends
                cv.text(fitText(cv, curTrk.title, metaW, 32, { font: 'bold' }), metaX, 182, 32, t.text, { font: 'bold' });
                cv.text(fitText(cv, curTrk.artist, metaW, 22), metaX, 218, 22, '#d4d8de');
                if (curTrk.album) {
                    cv.text(fitText(cv, curTrk.album, metaW, 17), metaX, 248, 17, t.dim);
                }

                // what it plays from: the playlist, Liked Songs or the album
                const ctxUri = spotify.contextUri || '';
                let fromKind = '', fromName = '';
                if (/:collection$/.test(ctxUri)) { fromKind = 'LIKED SONGS'; }
                else if (/:playlist:/.test(ctxUri)) {
                    const pl = (spotify.playlists || []).find((p) => p.uri === ctxUri);
                    fromKind = 'PLAYLIST'; fromName = pl ? pl.name : '';
                } else if (/:album:/.test(ctxUri)) { fromKind = 'ALBUM'; fromName = curTrk.album || ''; }
                else if (/:artist:/.test(ctxUri)) { fromKind = 'ARTIST'; }
                if (fromKind) {
                    cv.text('PLAYING FROM ' + fromKind, metaX, 304, 11, t.dim, { font: 'bold', spacing: 1.5 });
                    if (fromName) cv.text(fitText(cv, fromName, metaW, 17, { font: 'bold' }), metaX, 326, 17, t.text, { font: 'bold' });
                }

                // Progress Bar
                const progX = 54, progY = 360 + npEx, progW = 820, progH = 6;
                const dur = (curTrk && curTrk.durationMs) ? curTrk.durationMs : 1;
                const pFrac = Math.min(1, Math.max(0, spotify.progressMs / dur));
                cv.roundRect(progX, progY, progW, progH, 3, t.tick);
                if (pFrac > 0) {
                    cv.roundRect(progX, progY, Math.round(progW * pFrac), progH, 3, t.accent);
                    cv.circle(progX + Math.round(progW * pFrac), progY + 3, 6, '#ffffff');
                }
                cv.text(fmtTime(spotify.progressMs), progX, progY + 24, 15, t.accent, { font: 'num' });
                cv.text(fmtTime(curTrk.durationMs), progX + progW, progY + 24, 15, t.dim, { align: 'right', font: 'num' });
                // a tap on the bar jumps there; the controller pressed on it jumps 15 s on
                const seekPad = 10;
                cv.target(progX - seekPad, progY - 16, progW + seekPad * 2, 34, (at) => {
                    const to = at && at.w
                        ? (Math.max(0, Math.min(progW, at.x - seekPad)) / progW) * dur
                        : spotify.progressMs + 15000;
                    runBusy('seek', () => spotify.seek(to));
                }, 'np_seek', 6);

                // Transport Controls: shuffle, previous, play, next, repeat centred under the panel,
                // the heart at the right end. Secondary buttons are quiet until they are on.
                const cy = 444 + npEx;
                const midX = 464;
                const btnBg = withAlpha(t.panelEdge, 0.55);
                const toggle = (x, w, on, key, icon, run) => {
                    const y = cy - 26, h = 52;
                    cv.roundRect(x, y, w, h, 26, on ? withAlpha(t.accent, 0.18) : btnBg);
                    if (on) cv.strokeRoundRect(x, y, w, h, 26, 1.5, withAlpha(t.accent, 0.8));
                    if (isBusy(key)) {
                        drawSpinner(cv, x + w / 2, cy, 10, on ? t.accent : '#aeb4bd');
                    } else {
                        if (on) cv.circle(x + w / 2, y + h - 7, 2.5, t.accent);      // "on" dot, as Spotify marks it
                        icon(x + w / 2, on ? cy - 2 : cy, on ? t.accent : '#aeb4bd');
                    }
                    cv.target(x, y, w, h, () => runBusy(key, run), key, 10);
                };

                // 3. Play / Pause: the big round one
                const playR = 36;
                cv.circle(midX, cy, playR, isBusy('transport') ? withAlpha(t.accent, 0.6) : t.accent);
                if (busyOn('transport', 'play')) drawSpinner(cv, midX, cy, 13, '#000000', 4);
                else if (isPlaying) drawPauseIcon(cv, midX, cy, 28, '#000000');
                else drawPlayIcon(cv, midX + 2, cy, 28, '#000000');
                cv.target(midX - playR, cy - playR, playR * 2, playR * 2, () => {
                    runBusy('transport', () => spotify.togglePlay(), 'play');
                }, 'np_play', 15);

                // 2. / 4. Previous, Next: plain white glyphs on a soft round button
                const skipW = 64, skipGap = 22;
                const prevX = midX - playR - skipGap - skipW, nextX = midX + playR + skipGap;
                [[prevX, 'np_prev', 'prev', drawPrevIcon, () => spotify.prevTrack()],
                 [nextX, 'np_next', 'next', drawNextIcon, () => spotify.nextTrack()]].forEach(([x, key, id, icon, run]) => {
                    cv.roundRect(x, cy - 26, skipW, 52, 26, btnBg);
                    if (busyOn('transport', id)) drawSpinner(cv, x + skipW / 2, cy, 10, '#ffffff');
                    else icon(cv, x + skipW / 2, cy, 24, isBusy('transport') ? '#6b7280' : '#ffffff');
                    cv.target(x, cy - 26, skipW, 52, () => runBusy('transport', run, id), key, 12);
                });

                // 1. / 5. Shuffle, Repeat
                const togW = 60, togGap = 18;
                toggle(prevX - togGap - togW, togW, !!spotify.shuffle, 'np_shuffle',
                    (x, y, c) => drawShuffleIcon(cv, x, y, 24, c), () => spotify.toggleShuffle());
                const repMode = spotify.repeat;
                toggle(nextX + skipW + togGap, togW, !!(repMode && repMode !== 'off'), 'np_repeat',
                    (x, y, c) => drawRepeatIcon(cv, x, y, 24, c, repMode), () => spotify.toggleRepeat());

                // 6. Like: at the end of the progress bar's line
                const isLiked = !!spotify.isCurrentLiked;
                const likeW = 60, likeX = 874 - likeW;
                cv.roundRect(likeX, cy - 26, likeW, 52, 26, isLiked ? withAlpha(t.accent, 0.18) : btnBg);
                if (isLiked) cv.strokeRoundRect(likeX, cy - 26, likeW, 52, 26, 1.5, withAlpha(t.accent, 0.8));
                if (isBusy('like')) drawSpinner(cv, likeX + likeW / 2, cy, 10, isLiked ? t.accent : '#aeb4bd');
                else drawHeartIcon(cv, likeX + likeW / 2, cy + 1, 24, isLiked ? t.accent : '#aeb4bd', isLiked);
                cv.target(likeX, cy - 26, likeW, 52, () => runBusy('like', () => spotify.toggleLikeCurrent()), 'np_like', 10);
            }

            // Right Pane: Up Next in Queue (w: 656, h: 468)
            let upcoming = (spotify.remoteQueue && spotify.remoteQueue.length) ? spotify.remoteQueue : [];
            if (!upcoming.length && spotify.currentPlaylist && spotify.currentPlaylist.tracks) {
                const trks = spotify.currentPlaylist.tracks;
                const curIdx = trks.findIndex((x) => curTrk && x.id === curTrk.id);
                if (curIdx >= 0 && curIdx < trks.length - 1) {
                    upcoming = trks.slice(curIdx + 1);
                }
            } else if (!upcoming.length && spotify.likedSongs && spotify.likedSongs.length) {
                const curIdx = spotify.likedSongs.findIndex((x) => curTrk && x.id === curTrk.id);
                if (curIdx >= 0 && curIdx < spotify.likedSongs.length - 1) {
                    upcoming = spotify.likedSongs.slice(curIdx + 1);
                }
            }

            G.panel(cv, t, 920, 44, 656, 468, 'Up Next (' + upcoming.length + ')');

            if (!upcoming || upcoming.length === 0) {
                cv.roundRect(938, 120, 620, 180, 10, t.track);
                cv.text('Queue is currently empty.', 1248, 195, 19, t.dim, { align: 'center', font: 'bold' });
                cv.text('Play any track from Playlists or Liked Songs to queue up songs.', 1248, 230, 14, t.dim, { align: 'center' });
                return;
            }

            const VISIBLE_Q = 7 + Math.floor(npEx / 51);
            queueScroll = Math.max(0, Math.min(queueScroll, Math.max(0, upcoming.length - VISIBLE_Q)));
            listGeo.q = { x0: 920, x1: 1576, rowH: 51, count: upcoming.length, visible: VISIBLE_Q };
            cv.scroll = true;
            const visibleQ = upcoming.slice(queueScroll, queueScroll + VISIBLE_Q);
            visibleQ.forEach((trk, idx) => {
                const qy = 100 + idx * 51;
                cv.roundRect(938, qy, 620, 44, 8, t.track);
                cv.text(String(queueScroll + idx + 1), 958, qy + 27, 15, t.dim, { align: 'center', font: 'num' });
                cv.text(fitText(cv, trk.title, 1250 - 982, 17, { font: 'bold' }), 982, qy + 27, 17, t.text, { font: 'bold' });
                cv.text(fitText(cv, trk.artist, 1478 - 1260, 15), 1260, qy + 27, 15, t.dim);
                const startKey = 'q:' + trk.id;
                if (busyOn('start', startKey)) drawSpinner(cv, 1520, qy + 22, 8, t.accent);
                else cv.text(fmtTime(trk.durationMs), 1530, qy + 27, 14, t.dim, { align: 'right', font: 'num' });

                cv.target(938, qy, 620, 44, () => {
                    // what plays now, from this song on (a song queued by hand: that song alone)
                    const pl = spotify.currentPlaylist;
                    const pIdx = !spotify.contextUri && pl && pl.tracks ? pl.tracks.findIndex((x) => x.id === trk.id) : -1;
                    if (pIdx >= 0) runBusy('start', () => spotify.playTrack(pl, pIdx), startKey);
                    else runBusy('start', () => spotify.playQueued(trk), startKey);
                }, 'q_trk_' + (queueScroll + idx), 8);
            });
        }

        /* ---------- Page 3: Connect & Real Cloud Pairing ---------- */
        function drawConnect(cv, t) {
            // Left: Real Cloud Pairing QR Code or Connected Status
            const cEx = cv.extra || 0;
            G.panelExact(cv, t, 24, 44, 580, 396 + cEx, spotify.isAuthenticated() ? 'Spotify Account Status' : 'Scan to Connect Phone');

            if (spotify.isAuthenticated()) {
                // Connected Card
                const GREEN = '#1ed760';
                cv.roundRect(48, 98, 532, 284, 14, '#0a1612');
                cv.strokeRoundRect(48, 98, 532, 284, 14, 1.5, withAlpha(GREEN, 0.55));

                // badge: a check in a green disc, a soft ring around it
                const cx = 314, by = 140;
                cv.circle(cx, by, 36, withAlpha(GREEN, 0.12));
                cv.arc(cx, by, 30, 32, 0, 360, withAlpha(GREEN, 0.45));
                cv.circle(cx, by, 25, GREEN);
                cv.polyline([[cx - 11, by + 1], [cx - 4, by + 8], [cx + 11, by - 8]], 4.5, '#04140b');
                cv.circle(cx - 4, by + 8, 2.2, '#04140b');       // round the check's corner

                cv.text('CONNECTED TO SPOTIFY', cx, 202, 20, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });
                const prof = spotify.profile;
                const plan = prof && prof.product ? prof.product.charAt(0).toUpperCase() + prof.product.slice(1) : '';
                cv.text(prof ? fitText(cv, prof.name + (plan ? '  -  ' + plan : ''), 480, 16) : 'Signed in', cx, 226, 16, '#cbd5e1', { align: 'center' });

                // where the music plays: a pill with a live dot, or how to start
                const pillW = 380, pillX = cx - pillW / 2, pillY = 240, pillH = 32;
                if (spotify.activeDevice) {
                    cv.roundRect(pillX, pillY, pillW, pillH, 16, withAlpha(GREEN, 0.14));
                    const label = fitText(cv, 'Playing on ' + spotify.activeDevice, pillW - 50, 15, { font: 'bold' });
                    const lw = cv.textWidth(label, 15, { font: 'bold' });
                    const lx = cx - (lw + 18) / 2;
                    cv.circle(lx + 5, pillY + pillH / 2, 5, spotify.isPlaying ? GREEN : withAlpha(GREEN, 0.5));
                    cv.text(label, lx + 18, pillY + 21, 15, GREEN, { font: 'bold' });
                } else {
                    cv.roundRect(pillX, pillY, pillW, pillH, 16, withAlpha('#ffffff', 0.06));
                    cv.text('No device playing - open Spotify on your phone', cx, pillY + 21, 14, '#94a3b8', { align: 'center' });
                }

                // the library at a glance
                const nPl = (spotify.playlists || []).length;
                const nLiked = spotify.likedTotal || (spotify.likedSongs || []).length;
                cv.text(nPl + ' playlist' + (nPl === 1 ? '' : 's') + '   |   ' + nLiked + ' liked song' + (nLiked === 1 ? '' : 's'), cx, 294, 14, '#64748b', { align: 'center' });

                // Disconnect Button: quiet until needed
                const dcX = 164, dcY = 316, dcW = 300, dcH = 42;
                cv.roundRect(dcX, dcY, dcW, dcH, 10, '#1a1215');
                cv.strokeRoundRect(dcX, dcY, dcW, dcH, 10, 1, withAlpha('#e1001a', 0.7));
                cv.text('DISCONNECT / SWITCH ACCOUNT', dcX + dcW / 2, dcY + 26, 13, '#ff5c6c', { align: 'center', font: 'bold', spacing: 1 });

                cv.target(dcX, dcY, dcW, dcH, () => {
                    cloudPair.notifyUnpair();
                    spotify.logout();
                    cachedQr = null;
                    cloudPair.reset();
                    cloudPair.startPolling();
                }, 'btn_logout', 15);
            } else {
                // Real Cloud Pairing QR Code
                const qrx = 224, qry = 100, qrsz = 180;
                const qr = getQrMatrix();
                if (qr) {
                    const modCount = qr.size;
                    const modPx = Math.floor(qrsz / modCount);
                    const actualSz = modPx * modCount;
                    const ox = qrx + Math.floor((qrsz - actualSz) / 2);
                    const oy = qry + Math.floor((qrsz - actualSz) / 2);

                    // White backdrop for clean camera scanning
                    cv.roundRect(ox - 10, oy - 10, actualSz + 20, actualSz + 20, 10, '#ffffff');
                    for (let r = 0; r < modCount; r++) {
                        for (let c = 0; c < modCount; c++) {
                            if (qr.getModule(c, r)) {
                                cv.fillRect(ox + c * modPx, oy + r * modPx, modPx, modPx, '#000000');
                            }
                        }
                    }
                }

                const cx = 314;
                cv.text('Scan with phone to connect Spotify', cx, 320, 17, t.text, { align: 'center', font: 'bold' });
                cv.text('PAIRING CODE: ' + cloudPair.getShortCode(), cx, 344, 14, '#00f0ff', { align: 'center', font: 'bold', spacing: 1 });
                cv.text('https://hexlay.github.io/idrive7-custom-apps/pair.html', cx, 364, 11, '#64748b', { align: 'center' });
            }

            // Right: Spotify Connect Target Devices
            G.panelExact(cv, t, 620, 44, 956, 396 + cEx, 'Spotify Connect Devices');
            const devices = spotify.getDevices();

            if (!devices || devices.length === 0) {
                cv.roundRect(644, 100, 908, 230, 14, t.track);
                cv.strokeRoundRect(644, 100, 908, 230, 14, 1, t.panelEdge);

                cv.circle(714, 170, 30, withAlpha(t.accent, 0.22));
                cv.text('!', 714, 180, 26, t.accent, { align: 'center', font: 'bold' });

                cv.text('NO ACTIVE SPOTIFY DEVICES FOUND', 770, 158, 20, t.text, { font: 'bold' });
                cv.text('Open Spotify on your iPhone, Mac, or car to connect playback.', 770, 186, 15, '#cbd5e1');
                cv.text('Spotify Connect routes audio to an active device running Spotify.', 770, 210, 13, t.dim);

                // Refresh Button
                const rfW = 220, rfH = 42, rfX = 770, rfY = 240;
                const devBusy = isBusy('devices');
                cv.roundRect(rfX, rfY, rfW, rfH, 8, withAlpha(t.accent, devBusy ? 0.1 : 0.22));
                cv.strokeRoundRect(rfX, rfY, rfW, rfH, 8, 1.5, withAlpha(t.accent, devBusy ? 0.5 : 1));
                if (devBusy) {
                    drawSpinner(cv, rfX + 44, rfY + rfH / 2, 9, t.accent);
                    cv.text('SEARCHING...', rfX + rfW / 2 + 12, rfY + 26, 14, withAlpha(t.accent, 0.8), { align: 'center', font: 'bold', spacing: 1 });
                } else {
                    cv.text('REFRESH DEVICES', rfX + rfW / 2, rfY + 26, 14, t.accent, { align: 'center', font: 'bold', spacing: 1 });
                }
                cv.target(rfX, rfY, rfW, rfH, () => {
                    runBusy('devices', () => spotify.fetchDevices());
                }, 'btn_refresh_devs', 12);
            } else {
                // as many as the panel holds; the one that plays first
                const DEV_ROWS = Math.max(3, Math.floor((330 + cEx) / 78));
                const shown = devices.slice().sort((x, y) => (y.isActive ? 1 : 0) - (x.isActive ? 1 : 0)).slice(0, DEV_ROWS);
                shown.forEach((dev, idx) => {
                    const dy = 102 + idx * 78;
                    const isCur = !!dev.isActive;
                    const moving = busyOn('transfer', dev.id);
                    cv.roundRect(644, dy, 908, 68, 12, isCur ? withAlpha(t.accent, 0.16) : t.track);
                    if (isCur || moving) cv.strokeRoundRect(644, dy, 908, 68, 12, 1.5, withAlpha(t.accent, isCur ? 0.8 : 0.4));

                    // the device's kind, in a round tile
                    cv.circle(686, dy + 34, 22, isCur ? withAlpha(t.accent, 0.2) : withAlpha('#ffffff', 0.06));
                    drawDeviceIcon(cv, 686, dy + 34, dev.type, isCur ? t.accent : '#aeb4bd');

                    cv.text(fitText(cv, dev.name, 1390 - 724, 21, { font: 'bold' }), 724, dy + 31, 21, isCur ? t.text : '#dddddd', { font: 'bold' });
                    const vol = typeof dev.volume === 'number' ? '  |  Volume ' + dev.volume + '%' : '';
                    cv.text((isCur ? (spotify.isPlaying ? 'Playing now' : 'Paused here') : dev.type) + vol, 724, dy + 53, 15, isCur ? t.accent : t.dim);

                    // the action: where it plays, or "play here"
                    const bx = 1400, bw = 128, by = dy + 16, bh = 36;
                    if (isCur) {
                        cv.roundRect(bx, by, bw, bh, 18, withAlpha(t.accent, 0.22));
                        cv.circle(bx + 22, by + bh / 2, 4, t.accent);
                        cv.text('ACTIVE', bx + bw / 2 + 8, by + 23, 13, t.accent, { align: 'center', font: 'bold', spacing: 1 });
                    } else if (moving) {
                        cv.roundRect(bx, by, bw, bh, 18, withAlpha('#ffffff', 0.06));
                        drawSpinner(cv, bx + bw / 2, by + bh / 2, 9, t.accent);
                    } else {
                        const dim = isBusy('transfer');
                        cv.strokeRoundRect(bx, by, bw, bh, 18, 1.5, withAlpha('#ffffff', dim ? 0.15 : 0.45));
                        cv.text('PLAY HERE', bx + bw / 2, by + 23, 13, dim ? '#64748b' : '#ffffff', { align: 'center', font: 'bold', spacing: 1 });
                    }

                    cv.target(644, dy, 908, 68, () => {
                        if (!isCur) runBusy('transfer', () => spotify.transferToDevice(dev.id), dev.id);
                    }, 'dev_' + idx, 12);
                });
            }

            // Bottom Player Dock
            drawBottomPlayerDock(cv, t);
        }

        /* ---------- Master Render Loop ---------- */
        async function render() {
            spotify.tick();
            spectrumSeed += 0.08;

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
                G.frame(cv, t, PAGES, page, [
                    { text: 'SPOTIFY' },
                    { text: 'NO INTERNET (LOCKED)', color: '#e1001a' }
                ]);
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
                G.frame(cv, t, PAGES, page, [
                    { text: 'SPOTIFY' },
                    { text: 'LOGIN REQUIRED', color: '#ffb703' }
                ]);
                await ui.image('MAIN_GFX', cv);
                return;
            }

            // Normal Playback / Browsing screens
            if (page === 0) drawPlaylists(cv, t);
            else if (page === 1) drawLibrary(cv, t);
            else if (page === 2) drawNowPlaying(cv, t);
            else if (page === 3) drawConnect(cv, t);

            // G20 Live Cockpit frame tabs along the top: keep badges compact so tabs & Settings are never crowded out
            G.frame(cv, t, PAGES, page, [
                { text: spotify.activeDevice ? trunc(spotify.activeDevice, 28) : 'SPOTIFY' },
                { text: spotify.isPlaying ? 'PLAYING' : 'PAUSED', color: spotify.isPlaying ? '#1ed760' : t.dim }
            ]);

            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- HMI Button & Touch Interactions ---------- */
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; return render(); });
        ctx.onTab((idx) => { page = idx; return render(); });

        // Start 60 fps render loop and render initial frame
        // 30 fps while music plays (spectrum, progress), 10 fps otherwise; taps redraw at once
        ctx.loop('MAIN', 15, render, { maxFps: () => (spotify.isPlaying ? 30 : 10) });
        await render();
        log.info('Spotify app ready');
    }
});
