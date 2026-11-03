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
const { SpotifyAuthServer } = require('./auth_server');
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
        const authServer = new SpotifyAuthServer(ctx, spotify);
        authServer.start();

        const cloudPair = new CloudPairManager(ctx, spotify);
        cloudPair.startPolling();

        // Default to Online mode (demo !== 'on')
        // If not authenticated, open directly on the Connect tab!
        const isOnlineMode = settings.get('demo') !== 'on';
        let page = (isOnlineMode && !spotify.token) ? 3 : 0;
        let selectedPlaylistIdx = 0;
        let playlistScroll = 0;
        let trackScroll = 0;
        let likedScroll = 0;
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
            G.panel(cv, t, 40, 52, 1520, 410, 'Network Status: Offline');

            cv.roundRect(80, 110, 1440, 310, 16, '#0f141f');
            cv.strokeRoundRect(80, 110, 1440, 310, 16, 2, '#e1001a');

            cv.circle(180, 240, 44, withAlpha('#e1001a', 0.2));
            cv.text('!', 180, 255, 46, '#e1001a', { align: 'center', font: 'bold' });

            cv.text('NO INTERNET CONNECTION', 260, 180, 26, '#e1001a', { font: 'bold', spacing: 1 });
            cv.text('Spotify Online requires an active internet connection on your vehicle.', 260, 218, 18, '#ffffff');
            cv.text('Please verify that your BMW has cellular data or is connected to a mobile Wi-Fi hotspot.', 260, 248, 16, '#94a3b8');

            // Action Buttons: [RETRY CONNECTION] and [SWITCH TO DEMO MODE]
            const btnW = 280, btnH = 48, btnY = 320;
            const b1X = 260;
            cv.roundRect(b1X, btnY, btnW, btnH, 10, '#004e8c');
            cv.strokeRoundRect(b1X, btnY, btnW, btnH, 10, 1.5, '#00a3e0');
            cv.text('RETRY CONNECTION', b1X + btnW / 2, btnY + 30, 16, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });
            cv.target(b1X, btnY, btnW, btnH, () => {
                spotify.checkInternetConnection().then(() => render());
            }, 'btn_retry_net', 15);

            const b2X = b1X + btnW + 20;
            cv.roundRect(b2X, btnY, btnW, btnH, 10, '#1a2332');
            cv.strokeRoundRect(b2X, btnY, btnW, btnH, 10, 1, '#334155');
            cv.text('SWITCH TO DEMO MODE', b2X + btnW / 2, btnY + 30, 15, '#cbd5e1', { align: 'center', font: 'bold' });
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
            G.panel(cv, t, 40, 52, 1520, 410, 'Spotify Login Required');

            cv.roundRect(80, 110, 1440, 310, 16, '#0c1522');
            cv.strokeRoundRect(80, 110, 1440, 310, 16, 2, '#1ed760');

            cv.circle(180, 240, 44, withAlpha('#1ed760', 0.2));
            drawPlayIcon(cv, 183, 240, 32, '#1ed760');

            cv.text('SPOTIFY LOGIN REQUIRED', 260, 180, 26, '#ffffff', { font: 'bold', spacing: 1 });
            cv.text('Online Mode is active. Please pair your personal Spotify account to browse your library and control playback.', 260, 218, 17, '#cbd5e1');
            cv.text('Scan the QR code with your phone to sync your playlists and Spotify Connect target devices.', 260, 248, 15, '#94a3b8');

            const btnW = 340, btnH = 50, btnY = 320, bX = 260;
            cv.roundRect(bX, btnY, btnW, btnH, 10, '#1ed760');
            cv.text('PAIR PHONE (SCAN QR CODE)', bX + btnW / 2, btnY + 31, 16, '#000000', { align: 'center', font: 'bold', spacing: 1 });
            cv.target(bX, btnY, btnW, btnH, () => {
                page = 3; // Switch to Connect tab
            }, 'btn_goto_connect', 15);
        }

        /* ---------- Bottom Now Playing Player Dock ---------- */
        function drawBottomPlayerDock(cv, t) {
            const curTrk = spotify.currentTrack;
            const isPlaying = spotify.isPlaying;
            const dockX = 40, dockY = 448, dockW = 1520, dockH = 64;

            // Dock backdrop & border
            cv.roundRect(dockX, dockY, dockW, dockH, 12, withAlpha(t.panelEdge, 0.9));
            cv.strokeRoundRect(dockX, dockY, dockW, dockH, 12, 1, isPlaying ? withAlpha(t.accent, 0.4) : withAlpha(t.panelEdge, 0.8));

            // Mini artwork / Equalizer box
            const miniX = dockX + 10, miniY = dockY + 8, miniSz = 48;
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
                cv.text(trunc(curTrk.title, 32), dockX + 70, dockY + 28, 18, isPlaying ? t.accent : t.text, { font: 'bold' });
                const metaStr = curTrk.artist + (curTrk.album ? '  -  ' + curTrk.album : '');
                cv.text(trunc(metaStr, 42), dockX + 70, dockY + 48, 14, t.dim);
            } else {
                cv.text('No Track Playing', dockX + 70, dockY + 28, 18, t.dim, { font: 'bold' });
                cv.text('Select any song from Playlists or Liked Songs to begin', dockX + 70, dockY + 48, 14, t.dim);
            }

            // Tapping left half opens full Now Playing screen
            cv.target(dockX, dockY, 680, dockH, () => {
                page = 2; // Switch to Now Playing screen
                render();
            }, 'dock_open_np', 10);

            // Center: Elapsed / Duration timestamp
            if (curTrk) {
                cv.text(fmtTime(spotify.progressMs) + ' / ' + fmtTime(curTrk.durationMs), 860, dockY + 37, 15, t.dim, { align: 'center', font: 'num' });
            }

            // Controls on Right: Prev, Play/Pause, Next, Now Playing button
            // 1. Prev
            const prevX = 1140, prevY = dockY + 11, prevW = 54, prevH = 42;
            cv.roundRect(prevX, prevY, prevW, prevH, 8, withAlpha(t.panelEdge, 0.7));
            drawPrevIcon(cv, prevX + prevW / 2, prevY + prevH / 2, 16, t.text);
            cv.target(prevX, prevY, prevW, prevH, () => {
                spotify.prevTrack();
                render();
            }, 'dock_prev', 12);

            // 2. Play / Pause
            const playX = 1206, playY = dockY + 8, playW = 72, playH = 48;
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
            const nextX = 1290, nextY = dockY + 11, nextW = 54, nextH = 42;
            cv.roundRect(nextX, nextY, nextW, nextH, 8, withAlpha(t.panelEdge, 0.7));
            drawNextIcon(cv, nextX + nextW / 2, nextY + nextH / 2, 16, t.text);
            cv.target(nextX, nextY, nextW, nextH, () => {
                spotify.nextTrack();
                render();
            }, 'dock_next', 12);

            // 4. "NOW PLAYING >" button
            const npX = 1360, npY = dockY + 11, npW = 146, npH = 42;
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

            if (!playlists || playlists.length === 0) {
                if (!spotify.token || !spotify.paired) {
                    drawRequireConnect(cv, t);
                } else {
                    G.panel(cv, t, 40, 52, 1520, 388, 'Your Playlists (0)');

                    cv.roundRect(70, 140, 1460, 160, 12, t.track);
                    cv.strokeRoundRect(70, 140, 1460, 160, 12, 1, t.panelEdge);

                    const isBusy = spotify.isLoadingPlaylists || spotify.syncing;
                    cv.text(isBusy ? 'LOADING PLAYLISTS...' : 'NO PLAYLISTS FOUND', 800, 205, 22, t.dim, { align: 'center', font: 'bold', spacing: 1 });
                    cv.text(isBusy ? 'Fetching your playlists from Spotify cloud...' : 'Create or follow playlists on Spotify, or browse Liked Songs.', 800, 240, 16, t.dim, { align: 'center' });

                    const rfW = 240, rfH = 42, rfX = 680, rfY = 265;
                    cv.roundRect(rfX, rfY, rfW, rfH, 8, withAlpha(t.accent, 0.22));
                    cv.strokeRoundRect(rfX, rfY, rfW, rfH, 8, 1.5, t.accent);
                    cv.text('REFRESH PLAYLISTS', rfX + rfW / 2, rfY + 26, 14, t.accent, { align: 'center', font: 'bold', spacing: 1 });
                    cv.target(rfX, rfY, rfW, rfH, () => {
                        spotify.fetchPlaylists().then(() => render());
                    }, 'btn_refresh_pls', 12);

                    drawBottomPlayerDock(cv, t);
                }
                return;
            }

            // Keep selected index valid
            if (selectedPlaylistIdx >= playlists.length) selectedPlaylistIdx = 0;

            // Visible window for playlists (max 5)
            const VISIBLE_PL = 5;
            if (selectedPlaylistIdx < playlistScroll) playlistScroll = selectedPlaylistIdx;
            if (selectedPlaylistIdx >= playlistScroll + VISIBLE_PL) playlistScroll = selectedPlaylistIdx - VISIBLE_PL + 1;
            playlistScroll = Math.max(0, Math.min(playlistScroll, Math.max(0, playlists.length - VISIBLE_PL)));

            // Left Pane: Playlists (w: 500, h: 388)
            const plTitle = 'Your Playlists (' + (selectedPlaylistIdx + 1) + '/' + playlists.length + ')';
            G.panel(cv, t, 40, 52, 500, 388, plTitle);

            // Left Pane Scrollbar (replaces old ^/v buttons)
            drawScrollbar(cv, t, 524, 104, 324, playlists.length, VISIBLE_PL, playlistScroll, () => {
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
                const py = 104 + vIdx * 64;
                const isSel = realIdx === selectedPlaylistIdx;
                const isPlPlaying = spotify.isPlaying && spotify.currentPlaylist && spotify.currentPlaylist.id === pl.id;

                cv.roundRect(56, py, 458, 56, 10, isSel ? withAlpha(t.accent, 0.22) : t.track);
                if (isSel) cv.strokeRoundRect(56, py, 458, 56, 10, 2, t.accent);

                // Accent tag
                cv.roundRect(62, py + 7, 5, 42, 2.5, isPlPlaying ? t.accent : (pl.accent || t.accent));
                cv.text(trunc(pl.name, 22), 82, py + 27, 21, isSel ? t.text : '#e0e0e0', { font: 'bold' });
                cv.text((pl.trackCount || 0) + ' songs  -  ' + trunc(pl.description || 'Playlist', 26), 82, py + 46, 15, t.dim);

                if (isPlPlaying) {
                    drawMiniEqualizer(cv, 480, py + 28, t.accent, true, spectrumSeed);
                }

                cv.target(56, py, 458, 56, () => {
                    selectedPlaylistIdx = realIdx;
                    trackScroll = 0;
                    spotify.selectPlaylist(pl);
                }, 'pl_' + realIdx, 10);
            });

            // Right Pane: Tracks of selected playlist (w: 1000, h: 388)
            const curPl = playlists[selectedPlaylistIdx] || playlists[0];
            const isThisPlPlaying = spotify.currentPlaylist && spotify.currentPlaylist.id === curPl.id;
            const trackTotal = curPl.trackCount || (curPl.tracks ? curPl.tracks.length : 0);

            G.panel(cv, t, 560, 52, 1000, 388, trunc(curPl.name, 36) + ' (' + trackTotal + ' tracks)');

            if (!curPl.tracks || curPl.tracks.length === 0) {
                cv.roundRect(576, 150, 968, 140, 12, t.track);
                cv.text('LOADING SONGS...', 1060, 215, 22, t.dim, { align: 'center', font: 'bold', spacing: 1 });
                cv.text('Fetching track list from Spotify cloud...', 1060, 250, 16, t.dim, { align: 'center' });
            } else {
                const VISIBLE_TRK = 7;

                // Right Pane Tracks Scrollbar
                drawScrollbar(cv, t, 1538, 104, 324, curPl.tracks.length, VISIBLE_TRK, trackScroll, () => {
                    trackScroll = Math.max(0, trackScroll - VISIBLE_TRK);
                }, () => {
                    trackScroll = Math.min(Math.max(0, curPl.tracks.length - VISIBLE_TRK), trackScroll + VISIBLE_TRK);
                });

                const visibleTracks = curPl.tracks.slice(trackScroll, trackScroll + VISIBLE_TRK);

                visibleTracks.forEach((trk, vIdx) => {
                    const realIdx = trackScroll + vIdx;
                    const ty = 104 + vIdx * 46;
                    const isPlayingThis = isThisPlPlaying && spotify.currentTrack && spotify.currentTrack.id === trk.id;

                    if (isPlayingThis) {
                        cv.roundRect(576, ty, 946, 42, 8, withAlpha(t.accent, 0.22));
                        cv.strokeRoundRect(576, ty, 946, 42, 8, 1.5, t.accent);
                        drawMiniEqualizer(cv, 598, ty + 21, t.accent, spotify.isPlaying, spectrumSeed);
                    } else {
                        cv.roundRect(576, ty, 946, 42, 8, t.track);
                        cv.text(String(realIdx + 1), 598, ty + 26, 15, t.dim, { align: 'center', font: 'num' });
                    }

                    // Strict column bounds prevent overlap:
                    cv.text(trunc(trk.title, 24), 626, ty + 27, 19, isPlayingThis ? t.accent : t.text, { font: 'bold' });
                    const metaText = trk.artist + (trk.album ? '  -  ' + trk.album : '');
                    cv.text(trunc(metaText, 38), 920, ty + 27, 16, t.dim);
                    cv.text(fmtTime(trk.durationMs), isPlayingThis ? 1440 : 1490, ty + 27, 15, t.dim, { align: 'right', font: 'num' });

                    if (isPlayingThis) {
                        cv.roundRect(1450, ty + 7, 54, 28, 6, t.accent);
                        cv.text('PLAYING', 1477, ty + 24, 11, '#000000', { align: 'center', font: 'bold' });
                    }

                    cv.target(576, ty, 946, 42, () => {
                        spotify.playTrack(curPl, realIdx);
                    }, 'trk_' + realIdx, 8);
                });
            }

            // Bottom Player Dock
            drawBottomPlayerDock(cv, t);
        }

        /* ---------- Page 1: Liked Songs ---------- */
        function drawLibrary(cv, t) {
            const isOnline = settings.get('demo') !== 'on';
            if (isOnline && (!spotify.token || !spotify.paired)) {
                drawRequireConnect(cv, t);
                return;
            }

            const liked = (spotify.likedSongs && spotify.likedSongs.length)
                ? spotify.likedSongs
                : (spotify.isDemoMode ? require('./api').DEMO_PLAYLISTS[3].tracks : []);

            const total = spotify.likedTotal || liked.length;
            const VISIBLE_LIKED = 7;
            const startIdx = total > 0 ? likedScroll + 1 : 0;
            const endIdx = Math.min(likedScroll + VISIBLE_LIKED, total);
            const title = 'Liked Songs (' + (total > 0 ? (startIdx + '-' + endIdx + ' of ' + total) : '0') + ' tracks)';

            G.panel(cv, t, 40, 52, 1520, 388, title);

            // Liked Songs Scrollbar
            drawScrollbar(cv, t, 1538, 104, 324, liked.length, VISIBLE_LIKED, likedScroll, () => {
                likedScroll = Math.max(0, likedScroll - VISIBLE_LIKED);
            }, () => {
                likedScroll = Math.min(Math.max(0, liked.length - VISIBLE_LIKED), likedScroll + VISIBLE_LIKED);
            });

            if (!liked || liked.length === 0) {
                cv.roundRect(70, 140, 1460, 160, 12, t.track);
                cv.strokeRoundRect(70, 140, 1460, 160, 12, 1, t.panelEdge);
                const isBusy = spotify.isLoadingLiked || spotify.syncing;
                cv.text(isBusy ? 'LOADING LIKED SONGS...' : 'NO LIKED SONGS FOUND', 800, 205, 22, t.dim, { align: 'center', font: 'bold', spacing: 1 });
                cv.text(isBusy ? 'Fetching your saved songs from Spotify cloud...' : 'Like songs on Spotify to access them directly here.', 800, 240, 16, t.dim, { align: 'center' });
                drawBottomPlayerDock(cv, t);
                return;
            }

            const visible = liked.slice(likedScroll, likedScroll + VISIBLE_LIKED);
            visible.forEach((trk, vIdx) => {
                const realIdx = likedScroll + vIdx;
                const ty = 104 + vIdx * 46;
                const isPlayingThis = spotify.isPlaying && spotify.currentTrack && spotify.currentTrack.id === trk.id;

                if (isPlayingThis) {
                    cv.roundRect(56, ty, 1466, 42, 8, withAlpha(t.accent, 0.22));
                    cv.strokeRoundRect(56, ty, 1466, 42, 1.5, t.accent);
                    drawMiniEqualizer(cv, 80, ty + 21, t.accent, spotify.isPlaying, spectrumSeed);
                } else {
                    cv.roundRect(56, ty, 1466, 42, 8, t.track);
                    cv.text(String(realIdx + 1), 80, ty + 26, 15, t.dim, { align: 'center', font: 'num' });
                }

                // Heart tag
                cv.text('*', 115, ty + 28, 20, '#1ed760', { align: 'center', font: 'bold' });

                cv.text(trunc(trk.title, 34), 145, ty + 27, 19, isPlayingThis ? t.accent : t.text, { font: 'bold' });
                const metaText = trk.artist + (trk.album ? '  -  ' + trk.album : '');
                cv.text(trunc(metaText, 46), 680, ty + 27, 16, t.dim);
                cv.text(fmtTime(trk.durationMs), isPlayingThis ? 1410 : 1450, ty + 27, 15, t.dim, { align: 'right', font: 'num' });

                if (isPlayingThis) {
                    cv.roundRect(1420, ty + 7, 54, 28, 6, t.accent);
                    cv.text('PLAYING', 1447, ty + 24, 11, '#000000', { align: 'center', font: 'bold' });
                }

                cv.target(56, ty, 1466, 42, () => {
                    spotify.playLikedSong(realIdx);
                }, 'liked_' + realIdx, 8);
            });

            // Bottom Player Dock
            drawBottomPlayerDock(cv, t);
        }

        /* ---------- Page 2: Now Playing & Queue ---------- */
        function drawNowPlaying(cv, t) {
            const isOnline = settings.get('demo') !== 'on';
            if (isOnline && (!spotify.token || !spotify.paired)) {
                drawRequireConnect(cv, t);
                return;
            }

            const curTrk = spotify.currentTrack;
            const isPlaying = spotify.isPlaying;

            // Left Pane: Now Playing Cockpit (w: 840, h: 456)
            G.panel(cv, t, 40, 52, 840, 456, 'Now Playing');

            if (!curTrk) {
                cv.roundRect(70, 150, 780, 180, 12, t.track);
                cv.text('NO TRACK PLAYING', 460, 225, 22, t.dim, { align: 'center', font: 'bold', spacing: 1 });
                cv.text('Select any song from Playlists or Liked Songs to begin playback.', 460, 265, 16, t.dim, { align: 'center' });
            } else {
                // Vinyl / Album Art Box
                const artX = 70, artY = 112, artSz = 220;
                cv.roundRect(artX, artY, artSz, artSz, 14, '#0c1015');

                if (artManager.hasArt) {
                    cv.image(ART_IMG_ID, artX, artY, artSz, artSz);
                    cv.strokeRoundRect(artX, artY, artSz, artSz, 14, 1.5, isPlaying ? withAlpha(t.accent, 0.4) : withAlpha(t.panelEdge, 0.8));
                } else {
                    cv.strokeRoundRect(artX, artY, artSz, artSz, 14, 1.5, isPlaying ? withAlpha(t.accent, 0.4) : withAlpha(t.panelEdge, 0.8));

                    // Vinyl disc representation
                    const cx = artX + artSz / 2, cy = artY + artSz / 2;
                    cv.circle(cx, cy, 96, '#07090c');
                    cv.circle(cx, cy, 78, '#12161c');
                    cv.circle(cx, cy, 58, '#0a0d12');
                    cv.circle(cx, cy, 38, isPlaying ? withAlpha(t.accent, 0.3) : withAlpha(t.panelEdge, 0.5));
                    cv.circle(cx, cy, 14, isPlaying ? t.accent : t.dim);

                    // Multi-bar animated visualizer in center
                    drawMiniEqualizer(cv, cx, cy, '#ffffff', isPlaying, spectrumSeed);
                }

                // Right of Album Art: Track Info
                const metaX = 315;
                // Target Device badge
                const devText = 'DEVICE: ' + (spotify.activeDevice || 'SPOTIFY').toUpperCase();
                cv.roundRect(metaX, 115, 220, 24, 6, withAlpha(t.accent, 0.18));
                cv.text(trunc(devText, 24), metaX + 12, 132, 11, t.accent, { font: 'bold', spacing: 0.5 });

                // Big Song Title
                cv.text(trunc(curTrk.title, 26), metaX, 175, 26, isPlaying ? t.accent : t.text, { font: 'bold' });

                // Artist
                cv.text(trunc(curTrk.artist, 32), metaX, 210, 20, t.text);

                // Album
                if (curTrk.album) {
                    cv.text(trunc(curTrk.album, 36), metaX, 240, 16, t.dim);
                }

                // Audio Format Tag
                cv.text('LOSSLESS STREAM  -  SPOTIFY CONNECT', metaX, 305, 12, t.dim, { font: 'bold', spacing: 0.5 });

                // Progress Bar
                const progX = 70, progY = 358, progW = 780, progH = 6;
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
                const cy = 439;

                // 1. Shuffle
                const isShuf = !!spotify.shuffle;
                const bShufX = 140, bShufY = 416, bShufW = 60, bShufH = 46;
                cv.roundRect(bShufX, bShufY, bShufW, bShufH, 10, isShuf ? withAlpha(t.accent, 0.25) : withAlpha(t.panelEdge, 0.7));
                if (isShuf) cv.strokeRoundRect(bShufX, bShufY, bShufW, bShufH, 10, 1.5, t.accent);
                drawShuffleIcon(cv, bShufX + bShufW / 2, cy, 20, isShuf ? t.accent : t.dim);
                cv.target(bShufX, bShufY, bShufW, bShufH, () => {
                    spotify.toggleShuffle();
                    render();
                }, 'np_shuffle', 10);

                // 2. Prev
                const bPrevX = 216, bPrevY = 416, bPrevW = 76, bPrevH = 46;
                cv.roundRect(bPrevX, bPrevY, bPrevW, bPrevH, 10, withAlpha(t.panelEdge, 0.7));
                drawPrevIcon(cv, bPrevX + bPrevW / 2, cy, 22, t.text);
                cv.target(bPrevX, bPrevY, bPrevW, bPrevH, () => {
                    spotify.prevTrack();
                    render();
                }, 'np_prev', 12);

                // 3. Play / Pause (Big Accent Button)
                const bPlayX = 308, bPlayY = 410, bPlayW = 120, bPlayH = 58;
                cv.roundRect(bPlayX, bPlayY, bPlayW, bPlayH, 29, t.accent);
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
                const bNextX = 444, bNextY = 416, bNextW = 76, bNextH = 46;
                cv.roundRect(bNextX, bNextY, bNextW, bNextH, 10, withAlpha(t.panelEdge, 0.7));
                drawNextIcon(cv, bNextX + bNextW / 2, cy, 22, t.text);
                cv.target(bNextX, bNextY, bNextW, bNextH, () => {
                    spotify.nextTrack();
                    render();
                }, 'np_next', 12);

                // 5. Repeat
                const repMode = spotify.repeat;
                const isRep = repMode && repMode !== 'off';
                const bRepX = 536, bRepY = 416, bRepW = 60, bRepH = 46;
                cv.roundRect(bRepX, bRepY, bRepW, bRepH, 10, isRep ? withAlpha(t.accent, 0.25) : withAlpha(t.panelEdge, 0.7));
                if (isRep) cv.strokeRoundRect(bRepX, bRepY, bRepW, bRepH, 10, 1.5, t.accent);
                drawRepeatIcon(cv, bRepX + bRepW / 2, cy, 20, isRep ? t.accent : t.dim, repMode);
                cv.target(bRepX, bRepY, bRepW, bRepH, () => {
                    spotify.toggleRepeat();
                    render();
                }, 'np_repeat', 10);

                // 6. Like (Heart)
                const isLiked = !!spotify.isCurrentLiked;
                const bLikeX = 612, bLikeY = 416, bLikeW = 60, bLikeH = 46;
                cv.roundRect(bLikeX, bLikeY, bLikeW, bLikeH, 10, isLiked ? withAlpha(t.accent, 0.25) : withAlpha(t.panelEdge, 0.7));
                if (isLiked) cv.strokeRoundRect(bLikeX, bLikeY, bLikeW, bLikeH, 10, 1.5, t.accent);
                drawHeartIcon(cv, bLikeX + bLikeW / 2, cy - 2, 16, isLiked ? t.accent : t.dim, isLiked);
                cv.target(bLikeX, bLikeY, bLikeW, bLikeH, () => {
                    spotify.toggleLikeCurrent();
                    render();
                }, 'np_like', 10);
            }

            // Right Pane: Up Next in Queue (w: 660, h: 456)
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

            G.panel(cv, t, 900, 52, 660, 456, 'Up Next (' + upcoming.length + ')');

            if (!upcoming || upcoming.length === 0) {
                cv.roundRect(920, 150, 620, 160, 10, t.track);
                cv.text('Queue is currently empty.', 1230, 220, 19, t.dim, { align: 'center', font: 'bold' });
                cv.text('Play any track from Playlists or Liked Songs to queue up songs.', 1230, 255, 14, t.dim, { align: 'center' });
                return;
            }

            const VISIBLE_Q = 7;
            const visibleQ = upcoming.slice(0, VISIBLE_Q);
            visibleQ.forEach((trk, idx) => {
                const qy = 104 + idx * 48;
                cv.roundRect(916, qy, 628, 42, 8, t.track);
                cv.text(String(idx + 1), 936, qy + 26, 15, t.dim, { align: 'center', font: 'num' });
                cv.text(trunc(trk.title, 24), 960, qy + 26, 17, t.text, { font: 'bold' });
                cv.text(trunc(trk.artist, 20), 1260, qy + 26, 15, t.dim);
                cv.text(fmtTime(trk.durationMs), 1524, qy + 26, 14, t.dim, { align: 'right', font: 'num' });

                cv.target(916, qy, 628, 42, () => {
                    if (spotify.currentPlaylist) {
                        const pIdx = spotify.currentPlaylist.tracks.findIndex((x) => x.id === trk.id);
                        if (pIdx >= 0) spotify.playTrack(spotify.currentPlaylist, pIdx);
                    }
                }, 'q_trk_' + idx, 8);
            });
        }

        /* ---------- Page 3: Connect & Real Cloud Pairing ---------- */
        function drawConnect(cv, t) {
            // Left: Real Cloud Pairing QR Code or Connected Status
            G.panel(cv, t, 40, 52, 580, 388, spotify.isOnline ? 'Spotify Account Status' : 'Scan to Connect Phone');

            if (spotify.isOnline && spotify.token) {
                // Connected Card
                cv.roundRect(70, 108, 520, 260, 14, '#0a1612');
                cv.strokeRoundRect(70, 108, 520, 260, 14, 1.5, '#1ed760');

                cv.circle(330, 160, 28, '#1ed760');
                cv.text('[OK]', 330, 168, 16, '#000000', { align: 'center', font: 'bold' });

                cv.text('SPOTIFY CONNECTED', 330, 215, 20, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });
                cv.text('Active Target: ' + spotify.activeDevice, 330, 242, 15, '#cbd5e1', { align: 'center' });
                cv.text('Personal library & playlists active', 330, 265, 13, '#64748b', { align: 'center' });

                // Disconnect Button
                const dcX = 160, dcY = 300, dcW = 340, dcH = 44;
                cv.roundRect(dcX, dcY, dcW, dcH, 10, '#1f1418');
                cv.strokeRoundRect(dcX, dcY, dcW, dcH, 10, 1.5, '#e1001a');
                cv.text('DISCONNECT / SWITCH ACCOUNT', dcX + dcW / 2, dcY + 28, 14, '#e1001a', { align: 'center', font: 'bold', spacing: 1 });

                cv.target(dcX, dcY, dcW, dcH, () => {
                    spotify.logout();
                    cachedQr = null;
                    cloudPair.reset();
                    cloudPair.startPolling();
                }, 'btn_logout', 15);
            } else {
                // Real Cloud Pairing QR Code
                const qrx = 160, qry = 104, qrsz = 180;
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

                cv.text('Scan with phone to connect Spotify', 330, 325, 17, t.text, { align: 'center', font: 'bold' });
                cv.text('PAIRING CODE: ' + cloudPair.getShortCode(), 330, 350, 14, '#00f0ff', { align: 'center', font: 'bold', spacing: 1 });
                cv.text('https://hexlay.github.io/idrive7-custom-apps/pair.html', 330, 370, 11, '#64748b', { align: 'center' });
            }

            // Right: Spotify Connect Target Devices
            G.panel(cv, t, 640, 52, 920, 388, 'Spotify Connect Devices');
            const devices = spotify.getDevices();

            if (!devices || devices.length === 0) {
                cv.roundRect(664, 114, 872, 210, 14, t.track);
                cv.strokeRoundRect(664, 114, 872, 210, 14, 1, t.panelEdge);

                cv.circle(734, 180, 30, withAlpha(t.accent, 0.22));
                cv.text('!', 734, 190, 26, t.accent, { align: 'center', font: 'bold' });

                cv.text('NO ACTIVE SPOTIFY DEVICES FOUND', 790, 168, 20, t.text, { font: 'bold' });
                cv.text('Open Spotify on your iPhone, Mac, or car to connect playback.', 790, 196, 15, '#cbd5e1');
                cv.text('Spotify Connect routes audio to an active device running Spotify.', 790, 220, 13, t.dim);

                // Refresh Button
                const rfW = 220, rfH = 42, rfX = 790, rfY = 250;
                cv.roundRect(rfX, rfY, rfW, rfH, 8, withAlpha(t.accent, 0.22));
                cv.strokeRoundRect(rfX, rfY, rfW, rfH, 8, 1.5, t.accent);
                cv.text('REFRESH DEVICES', rfX + rfW / 2, rfY + 26, 14, t.accent, { align: 'center', font: 'bold', spacing: 1 });
                cv.target(rfX, rfY, rfW, rfH, () => {
                    spotify.fetchDevices().then(() => render());
                }, 'btn_refresh_devs', 12);
            } else {
                devices.slice(0, 3).forEach((dev, idx) => {
                    const dy = 110 + idx * 76;
                    const isCur = dev.isActive || dev.name === spotify.activeDevice;
                    cv.roundRect(664, dy, 872, 66, 12, isCur ? withAlpha(t.accent, 0.22) : t.track);
                    if (isCur) cv.strokeRoundRect(664, dy, 872, 66, 12, 2, t.accent);

                    cv.circle(694, dy + 33, 10, isCur ? '#1db954' : t.tick);
                    cv.text(dev.name, 724, dy + 31, 22, isCur ? t.text : '#dddddd', { font: 'bold' });
                    cv.text(dev.type + (isCur ? '  -  CURRENT ACTIVE TARGET' : '  -  Available'), 724, dy + 51, 16, isCur ? t.accent : t.dim);

                    cv.roundRect(1410, dy + 14, 106, 36, 8, isCur ? t.accent : withAlpha(t.tick, 0.5));
                    cv.text(isCur ? 'ACTIVE' : 'TRANSFER', 1463, dy + 37, 15, '#ffffff', { align: 'center', font: 'bold' });

                    cv.target(664, dy, 872, 66, () => {
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
            if (isOnline && (!spotify.token || !spotify.paired)) {
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
        ui.onClick('BTN_PLAY', () => {
            if (settings.get('demo') !== 'on' && (!spotify.hasInternet || !spotify.token)) return render();
            spotify.togglePlay();
            return render();
        });
        ui.onClick('BTN_NEXT', () => {
            if (settings.get('demo') !== 'on' && (!spotify.hasInternet || !spotify.token)) return render();
            spotify.nextTrack();
            return render();
        });
        ui.onClick('BTN_PREV', () => {
            if (settings.get('demo') !== 'on' && (!spotify.hasInternet || !spotify.token)) return render();
            spotify.prevTrack();
            return render();
        });
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; return render(); });
        ctx.onTab((idx) => { page = idx; return render(); });

        // Start 60 fps render loop
        ctx.loop('MAIN', 15, render);
        render().then(() => log.info('Spotify app ready')).catch((e) => log.warn('Spotify render error: ' + e));
    }
});
