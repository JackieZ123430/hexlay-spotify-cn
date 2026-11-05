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

function drawShuffleIcon(cv, cx, cy, sz, col) {
    const w = sz * 0.8, h = sz * 0.5;
    const x0 = cx - w / 2, x1 = cx + w / 2;
    const y0 = cy - h / 2, y1 = cy + h / 2;
    cv.line(x0, y0, cx - w * 0.1, y0, 2, col);
    cv.line(cx - w * 0.1, y0, cx + w * 0.1, y1, 2, col);
    cv.line(cx + w * 0.1, y1, x1, y1, 2, col);

    cv.line(x0, y1, cx - w * 0.1, y1, 2, col);
    cv.line(cx - w * 0.1, y1, cx + w * 0.1, y0, 2, col);
    cv.line(cx + w * 0.1, y0, x1, y0, 2, col);

    drawTriangle(cv, [x1 - 4, y0 - 4], [x1 + 4, y0], [x1 - 4, y0 + 4], col);
    drawTriangle(cv, [x1 - 4, y1 - 4], [x1 + 4, y1], [x1 - 4, y1 + 4], col);
}

function drawRepeatIcon(cv, cx, cy, sz, col, mode) {
    const w = sz * 0.8, h = sz * 0.55;
    const x0 = cx - w / 2, x1 = cx + w / 2;
    const y0 = cy - h / 2, y1 = cy + h / 2;
    cv.line(x0 + 4, y0, x1 - 2, y0, 2, col);
    cv.line(x1, y0 + 3, x1, y1 - 3, 2, col);
    cv.line(x1 - 4, y1, x0 + 2, y1, 2, col);
    cv.line(x0, y1 - 3, x0, y0 + 3, 2, col);
    drawTriangle(cv, [x1 - 3, y0 - 4], [x1 + 4, y0], [x1 - 3, y0 + 4], col);
    if (mode === 'track') {
        cv.text('1', cx, cy + 5, 11, col, { align: 'center', font: 'bold' });
    }
}

function drawHeartIcon(cv, cx, cy, sz, col, filled) {
    const r = sz * 0.3;
    cv.circle(cx - r, cy - r * 0.5, r, col);
    cv.circle(cx + r, cy - r * 0.5, r, col);
    drawTriangle(cv,
        [cx - r * 2, cy - r * 0.3],
        [cx + r * 2, cy - r * 0.3],
        [cx, cy + sz * 0.6],
        col
    );
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
            cv.roundRect(b1X, btnY, btnW, btnH, 10, '#004e8c');
            cv.strokeRoundRect(b1X, btnY, btnW, btnH, 10, 1.5, '#00a3e0');
            cv.text('RETRY CONNECTION', b1X + btnW / 2, btnY + 32, 16, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });
            cv.target(b1X, btnY, btnW, btnH, () => {
                spotify.checkInternetConnection().then(() => render());
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
                cv.text(trunc(curTrk.title, 34), dockX + 70, dockY + 28, 18, isPlaying ? t.accent : t.text, { font: 'bold' });
                const metaStr = curTrk.artist + (curTrk.album ? '  -  ' + curTrk.album : '');
                cv.text(trunc(metaStr, 44), dockX + 70, dockY + 49, 14, t.dim);
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
            drawPrevIcon(cv, prevX + prevW / 2, prevY + prevH / 2, 16, t.text);
            cv.target(prevX, prevY, prevW, prevH, () => {
                spotify.prevTrack();
                render();
            }, 'dock_prev', 12);

            // 2. Play / Pause
            const playX = 1228, playY = dockY + 9, playW = 72, playH = 48;
            cv.roundRect(playX, playY, playW, playH, 24, t.accent);
            if (isPlaying) {
                drawPauseIcon(cv, playX + playW / 2, playY + playH / 2, 18, '#000000');
            } else {
                drawPlayIcon(cv, playX + playW / 2, playY + playH / 2, 18, '#000000');
            }
            cv.target(playX, playY, playW, playH, () => {
                spotify.togglePlay();
                render();
            }, 'dock_play', 15);

            // 3. Next
            const nextX = 1314, nextY = dockY + 12, nextW = 54, nextH = 42;
            cv.roundRect(nextX, nextY, nextW, nextH, 8, withAlpha(t.panelEdge, 0.7));
            drawNextIcon(cv, nextX + nextW / 2, nextY + nextH / 2, 16, t.text);
            cv.target(nextX, nextY, nextW, nextH, () => {
                spotify.nextTrack();
                render();
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

                    const isBusy = spotify.isLoadingPlaylists || spotify.syncing;
                    cv.text(isBusy ? 'LOADING PLAYLISTS...' : 'NO PLAYLISTS FOUND', 800, 175, 22, t.dim, { align: 'center', font: 'bold', spacing: 1 });
                    cv.text(isBusy ? 'Fetching your playlists from Spotify cloud...' : 'Create or follow playlists on Spotify, or browse Liked Songs.', 800, 210, 16, t.dim, { align: 'center' });

                    const rfW = 240, rfH = 44, rfX = 680, rfY = 236;
                    cv.roundRect(rfX, rfY, rfW, rfH, 8, withAlpha(t.accent, 0.22));
                    cv.strokeRoundRect(rfX, rfY, rfW, rfH, 8, 1.5, t.accent);
                    cv.text('REFRESH PLAYLISTS', rfX + rfW / 2, rfY + 27, 14, t.accent, { align: 'center', font: 'bold', spacing: 1 });
                    cv.target(rfX, rfY, rfW, rfH, () => {
                        spotify.fetchPlaylists().then(() => render());
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
                cv.text(trunc(pl.name, 22), 62, py + 26, 21, isSel ? t.text : '#e0e0e0', { font: 'bold' });
                cv.text((pl.trackCount || 0) + ' songs  -  ' + trunc(pl.description || 'Playlist', 26), 62, py + 48, 15, t.dim);

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

            G.panelExact(cv, t, 540, 44, 1036, 396 + ex, trunc(curPl.name, 36) + ' (' + trackTotal + ' tracks)');

            if (!curPl.tracks || curPl.tracks.length === 0) {
                cv.roundRect(556, 120, 1004, 180, 12, t.track);
                cv.text('LOADING SONGS...', 1058, 195, 22, t.dim, { align: 'center', font: 'bold', spacing: 1 });
                cv.text('Fetching track list from Spotify cloud...', 1058, 230, 16, t.dim, { align: 'center' });
            } else {
                const VISIBLE_TRK = 7 + Math.floor(ex / 47);
                trackScroll = Math.max(0, Math.min(trackScroll, Math.max(0, curPl.tracks.length - VISIBLE_TRK)));
                listGeo.trk = { x0: 540, x1: 1576, rowH: 47, count: curPl.tracks.length, visible: VISIBLE_TRK };

                // Right Pane Tracks Scrollbar
                drawScrollbar(cv, t, 1554, 98, 330 + ex, curPl.tracks.length, VISIBLE_TRK, trackScroll, () => {
                    trackScroll = Math.max(0, trackScroll - VISIBLE_TRK);
                }, () => {
                    trackScroll = Math.min(Math.max(0, curPl.tracks.length - VISIBLE_TRK), trackScroll + VISIBLE_TRK);
                });

                const visibleTracks = curPl.tracks.slice(trackScroll, trackScroll + VISIBLE_TRK);

                visibleTracks.forEach((trk, vIdx) => {
                    const realIdx = trackScroll + vIdx;
                    const ty = 98 + vIdx * 47;
                    const isPlayingThis = ctxHere && isPlayingTrack(trk);

                    if (isPlayingThis) {
                        cv.roundRect(556, ty, 980, 42, 8, withAlpha(t.accent, 0.22));
                        cv.strokeRoundRect(556, ty, 980, 42, 8, 1.5, t.accent);
                        drawMiniEqualizer(cv, 578, ty + 21, t.accent, spotify.isPlaying, spectrumSeed);
                    } else {
                        cv.roundRect(556, ty, 980, 42, 8, t.track);
                        cv.text(String(realIdx + 1), 578, ty + 26, 15, t.dim, { align: 'center', font: 'num' });
                    }

                    // Strict column bounds prevent overlap:
                    cv.text(trunc(trk.title, 26), 606, ty + 27, 19, isPlayingThis ? t.accent : t.text, { font: 'bold' });
                    const metaText = trk.artist + (trk.album ? '  -  ' + trk.album : '');
                    cv.text(trunc(metaText, 40), 910, ty + 27, 16, t.dim);
                    cv.text(fmtTime(trk.durationMs), isPlayingThis ? 1430 : 1510, ty + 27, 15, t.dim, { align: 'right', font: 'num' });

                    if (isPlayingThis) {
                        cv.roundRect(1444, ty + 7, 54, 28, 6, t.accent);
                        cv.text('PLAYING', 1471, ty + 24, 11, '#000000', { align: 'center', font: 'bold' });
                    }

                    cv.target(556, ty, 980, 42, () => {
                        spotify.playTrack(curPl, realIdx);
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
            likedScroll = Math.max(0, Math.min(likedScroll, Math.max(0, liked.length - VISIBLE_LIKED)));
            listGeo.liked = { x0: 24, x1: 1576, rowH: 47, count: liked.length, visible: VISIBLE_LIKED };
            cv.scroll = true;
            const startIdx = total > 0 ? likedScroll + 1 : 0;
            const endIdx = Math.min(likedScroll + VISIBLE_LIKED, total);
            const title = 'Liked Songs (' + (total > 0 ? (startIdx + '-' + endIdx + ' of ' + total) : '0') + ' tracks)';

            G.panelExact(cv, t, 24, 44, 1552, 396 + ex, title);

            // Liked Songs Scrollbar
            drawScrollbar(cv, t, 1554, 98, 330 + ex, liked.length, VISIBLE_LIKED, likedScroll, () => {
                likedScroll = Math.max(0, likedScroll - VISIBLE_LIKED);
            }, () => {
                likedScroll = Math.min(Math.max(0, liked.length - VISIBLE_LIKED), likedScroll + VISIBLE_LIKED);
            });

            if (!liked || liked.length === 0) {
                cv.roundRect(48, 100, 1504, 200, 12, t.track);
                cv.strokeRoundRect(48, 100, 1504, 200, 12, 1, t.panelEdge);
                const isBusy = spotify.isLoadingLiked || spotify.syncing;
                cv.text(isBusy ? 'LOADING LIKED SONGS...' : 'NO LIKED SONGS FOUND', 800, 180, 22, t.dim, { align: 'center', font: 'bold', spacing: 1 });
                cv.text(isBusy ? 'Fetching your saved songs from Spotify cloud...' : 'Like songs on Spotify to access them directly here.', 800, 215, 16, t.dim, { align: 'center' });
                drawBottomPlayerDock(cv, t);
                return;
            }

            const visible = liked.slice(likedScroll, likedScroll + VISIBLE_LIKED);
            visible.forEach((trk, vIdx) => {
                const realIdx = likedScroll + vIdx;
                const ty = 98 + vIdx * 47;
                const isPlayingThis = isPlayingTrack(trk);

                if (isPlayingThis) {
                    cv.roundRect(40, ty, 1500, 42, 8, withAlpha(t.accent, 0.22));
                    cv.strokeRoundRect(40, ty, 1500, 42, 8, 1.5, t.accent);
                    drawMiniEqualizer(cv, 64, ty + 21, t.accent, spotify.isPlaying, spectrumSeed);
                } else {
                    cv.roundRect(40, ty, 1500, 42, 8, t.track);
                    cv.text(String(realIdx + 1), 64, ty + 26, 15, t.dim, { align: 'center', font: 'num' });
                }

                // Heart tag
                cv.text('*', 98, ty + 28, 20, '#1ed760', { align: 'center', font: 'bold' });

                cv.text(trunc(trk.title, 36), 126, ty + 27, 19, isPlayingThis ? t.accent : t.text, { font: 'bold' });
                const metaText = trk.artist + (trk.album ? '  -  ' + trk.album : '');
                cv.text(trunc(metaText, 48), 680, ty + 27, 16, t.dim);
                cv.text(fmtTime(trk.durationMs), isPlayingThis ? 1440 : 1510, ty + 27, 15, t.dim, { align: 'right', font: 'num' });

                if (isPlayingThis) {
                    cv.roundRect(1450, ty + 7, 54, 28, 6, t.accent);
                    cv.text('PLAYING', 1477, ty + 24, 11, '#000000', { align: 'center', font: 'bold' });
                }

                cv.target(40, ty, 1500, 42, () => {
                    spotify.playLikedSong(realIdx);
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

                // Right of Album Art: Track Info
                const metaX = 310;
                // Target Device badge
                const devText = 'DEVICE: ' + (spotify.activeDevice || 'SPOTIFY').toUpperCase();
                cv.roundRect(metaX, 108, 230, 26, 6, withAlpha(t.accent, 0.18));
                cv.text(trunc(devText, 24), metaX + 12, 126, 11, t.accent, { font: 'bold', spacing: 0.5 });

                // Big Song Title
                cv.text(trunc(curTrk.title, 26), metaX, 172, 28, isPlaying ? t.accent : t.text, { font: 'bold' });

                // Artist
                cv.text(trunc(curTrk.artist, 32), metaX, 208, 21, t.text);

                // Album
                if (curTrk.album) {
                    cv.text(trunc(curTrk.album, 36), metaX, 240, 17, t.dim);
                }

                // Audio Format Tag
                cv.text('LOSSLESS STREAM  -  SPOTIFY CONNECT', metaX, 305, 12, t.dim, { font: 'bold', spacing: 0.5 });

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

                // Transport Controls
                const cy = 444 + npEx;

                // 1. Shuffle
                const isShuf = !!spotify.shuffle;
                const bShufX = 140, bShufY = 416 + npEx, bShufW = 60, bShufH = 50;
                cv.roundRect(bShufX, bShufY, bShufW, bShufH, 10, isShuf ? withAlpha(t.accent, 0.25) : withAlpha(t.panelEdge, 0.7));
                if (isShuf) cv.strokeRoundRect(bShufX, bShufY, bShufW, bShufH, 10, 1.5, t.accent);
                drawShuffleIcon(cv, bShufX + bShufW / 2, cy, 20, isShuf ? t.accent : t.dim);
                cv.target(bShufX, bShufY, bShufW, bShufH, () => {
                    spotify.toggleShuffle();
                    render();
                }, 'np_shuffle', 10);

                // 2. Prev
                const bPrevX = 222, bPrevY = 416 + npEx, bPrevW = 76, bPrevH = 50;
                cv.roundRect(bPrevX, bPrevY, bPrevW, bPrevH, 10, withAlpha(t.panelEdge, 0.7));
                drawPrevIcon(cv, bPrevX + bPrevW / 2, cy, 22, t.text);
                cv.target(bPrevX, bPrevY, bPrevW, bPrevH, () => {
                    spotify.prevTrack();
                    render();
                }, 'np_prev', 12);

                // 3. Play / Pause (Big Accent Button)
                const bPlayX = 320, bPlayY = 410 + npEx, bPlayW = 120, bPlayH = 62;
                cv.roundRect(bPlayX, bPlayY, bPlayW, bPlayH, 31, t.accent);
                if (isPlaying) {
                    drawPauseIcon(cv, bPlayX + bPlayW / 2, cy, 26, '#000000');
                } else {
                    drawPlayIcon(cv, bPlayX + bPlayW / 2, cy, 26, '#000000');
                }
                cv.target(bPlayX, bPlayY, bPlayW, bPlayH, () => {
                    spotify.togglePlay();
                    render();
                }, 'np_play', 15);

                // 4. Next
                const bNextX = 462, bNextY = 416 + npEx, bNextW = 76, bNextH = 50;
                cv.roundRect(bNextX, bNextY, bNextW, bNextH, 10, withAlpha(t.panelEdge, 0.7));
                drawNextIcon(cv, bNextX + bNextW / 2, cy, 22, t.text);
                cv.target(bNextX, bNextY, bNextW, bNextH, () => {
                    spotify.nextTrack();
                    render();
                }, 'np_next', 12);

                // 5. Repeat
                const repMode = spotify.repeat;
                const isRep = repMode && repMode !== 'off';
                const bRepX = 560, bRepY = 416 + npEx, bRepW = 60, bRepH = 50;
                cv.roundRect(bRepX, bRepY, bRepW, bRepH, 10, isRep ? withAlpha(t.accent, 0.25) : withAlpha(t.panelEdge, 0.7));
                if (isRep) cv.strokeRoundRect(bRepX, bRepY, bRepW, bRepH, 10, 1.5, t.accent);
                drawRepeatIcon(cv, bRepX + bRepW / 2, cy, 20, isRep ? t.accent : t.dim, repMode);
                cv.target(bRepX, bRepY, bRepW, bRepH, () => {
                    spotify.toggleRepeat();
                    render();
                }, 'np_repeat', 10);

                // 6. Like (Heart)
                const isLiked = !!spotify.isCurrentLiked;
                const bLikeX = 642, bLikeY = 416 + npEx, bLikeW = 60, bLikeH = 50;
                cv.roundRect(bLikeX, bLikeY, bLikeW, bLikeH, 10, isLiked ? withAlpha(t.accent, 0.25) : withAlpha(t.panelEdge, 0.7));
                if (isLiked) cv.strokeRoundRect(bLikeX, bLikeY, bLikeW, bLikeH, 10, 1.5, t.accent);
                drawHeartIcon(cv, bLikeX + bLikeW / 2, cy - 2, 16, isLiked ? t.accent : t.dim, isLiked);
                cv.target(bLikeX, bLikeY, bLikeW, bLikeH, () => {
                    spotify.toggleLikeCurrent();
                    render();
                }, 'np_like', 10);
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
                cv.text(trunc(trk.title, 24), 982, qy + 27, 17, t.text, { font: 'bold' });
                cv.text(trunc(trk.artist, 20), 1260, qy + 27, 15, t.dim);
                cv.text(fmtTime(trk.durationMs), 1530, qy + 27, 14, t.dim, { align: 'right', font: 'num' });

                cv.target(938, qy, 620, 44, () => {
                    if (spotify.currentPlaylist) {
                        const pIdx = spotify.currentPlaylist.tracks.findIndex((x) => x.id === trk.id);
                        if (pIdx >= 0) spotify.playTrack(spotify.currentPlaylist, pIdx);
                    }
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
                cv.roundRect(48, 98, 532, 284, 14, '#0a1612');
                cv.strokeRoundRect(48, 98, 532, 284, 14, 1.5, '#1ed760');

                const cx = 314;
                cv.circle(cx, 154, 28, '#1ed760');
                cv.text('[OK]', cx, 162, 16, '#000000', { align: 'center', font: 'bold' });

                cv.text('SPOTIFY CONNECTED', cx, 212, 20, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });
                cv.text('Active Target: ' + spotify.activeDevice, cx, 238, 15, '#cbd5e1', { align: 'center' });
                cv.text('Personal library & playlists active', cx, 260, 13, '#64748b', { align: 'center' });

                // Disconnect Button
                const dcX = 134, dcY = 298, dcW = 360, dcH = 46;
                cv.roundRect(dcX, dcY, dcW, dcH, 10, '#1f1418');
                cv.strokeRoundRect(dcX, dcY, dcW, dcH, 10, 1.5, '#e1001a');
                cv.text('DISCONNECT / SWITCH ACCOUNT', dcX + dcW / 2, dcY + 29, 14, '#e1001a', { align: 'center', font: 'bold', spacing: 1 });

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
                cv.roundRect(rfX, rfY, rfW, rfH, 8, withAlpha(t.accent, 0.22));
                cv.strokeRoundRect(rfX, rfY, rfW, rfH, 8, 1.5, t.accent);
                cv.text('REFRESH DEVICES', rfX + rfW / 2, rfY + 26, 14, t.accent, { align: 'center', font: 'bold', spacing: 1 });
                cv.target(rfX, rfY, rfW, rfH, () => {
                    spotify.fetchDevices().then(() => render());
                }, 'btn_refresh_devs', 12);
            } else {
                devices.slice(0, 3).forEach((dev, idx) => {
                    const dy = 102 + idx * 78;
                    const isCur = dev.isActive || dev.name === spotify.activeDevice;
                    cv.roundRect(644, dy, 908, 68, 12, isCur ? withAlpha(t.accent, 0.22) : t.track);
                    if (isCur) cv.strokeRoundRect(644, dy, 908, 68, 12, 2, t.accent);

                    cv.circle(674, dy + 34, 10, isCur ? '#1db954' : t.tick);
                    cv.text(dev.name, 704, dy + 32, 22, isCur ? t.text : '#dddddd', { font: 'bold' });
                    cv.text(dev.type + (isCur ? '  -  CURRENT ACTIVE TARGET' : '  -  Available'), 704, dy + 52, 16, isCur ? t.accent : t.dim);

                    cv.roundRect(1420, dy + 16, 106, 36, 8, isCur ? t.accent : withAlpha(t.tick, 0.5));
                    cv.text(isCur ? 'ACTIVE' : 'TRANSFER', 1473, dy + 39, 15, '#ffffff', { align: 'center', font: 'bold' });

                    cv.target(644, dy, 908, 68, () => {
                        spotify.transferToDevice(dev.id);
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
                { text: spotify.activeDevice ? trunc(spotify.activeDevice, 16) : 'SPOTIFY' },
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
