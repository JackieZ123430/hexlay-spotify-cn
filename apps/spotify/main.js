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
const qrcodegen = require('./qrcodegen');

const W = 1600, H = 520;
const PAGES = ['Playlists', 'Library', 'Queue', 'Connect'];

// Format milliseconds as MM:SS
function fmtTime(ms) {
    if (!ms || ms < 0) return '0:00';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return m + ':' + (rem < 10 ? '0' : '') + rem;
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

mgu.run({
    async start(ctx) {
        const { ui, settings, log, dataDir } = ctx;
        const spotify = new SpotifyClient(ctx);
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
            cv.text('>', 180, 255, 42, '#1ed760', { align: 'center', font: 'bold' });

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

        /* ---------- Page 0: Playlists & Tracks ---------- */
        function drawPlaylists(cv, t) {
            const playlists = spotify.getPlaylists();

            if (!playlists || playlists.length === 0) {
                drawRequireConnect(cv, t);
                return;
            }

            // Keep selected index valid
            if (selectedPlaylistIdx >= playlists.length) selectedPlaylistIdx = 0;

            // Visible window for playlists (max 5)
            const VISIBLE_PL = 5;
            if (selectedPlaylistIdx < playlistScroll) playlistScroll = selectedPlaylistIdx;
            if (selectedPlaylistIdx >= playlistScroll + VISIBLE_PL) playlistScroll = selectedPlaylistIdx - VISIBLE_PL + 1;
            playlistScroll = Math.max(0, Math.min(playlistScroll, Math.max(0, playlists.length - VISIBLE_PL)));

            // Left Pane: Playlists (w: 500)
            const plTitle = 'Your Playlists (' + (selectedPlaylistIdx + 1) + '/' + playlists.length + ')';
            G.panel(cv, t, 40, 52, 500, 410, plTitle);

            // Up / Down scroll buttons in header if more than 5 playlists
            if (playlists.length > VISIBLE_PL) {
                if (playlistScroll > 0) {
                    cv.roundRect(438, 64, 30, 26, 6, withAlpha(t.accent, 0.25));
                    cv.text('^', 453, 83, 18, t.accent, { align: 'center', font: 'bold' });
                    cv.target(438, 64, 30, 26, () => {
                        playlistScroll = Math.max(0, playlistScroll - 1);
                        selectedPlaylistIdx = Math.max(0, selectedPlaylistIdx - 1);
                        spotify.selectPlaylist(playlists[selectedPlaylistIdx]);
                    }, 'pl_scroll_up', 10);
                }
                if (playlistScroll + VISIBLE_PL < playlists.length) {
                    cv.roundRect(476, 64, 30, 26, 6, withAlpha(t.accent, 0.25));
                    cv.text('v', 491, 83, 16, t.accent, { align: 'center', font: 'bold' });
                    cv.target(476, 64, 30, 26, () => {
                        playlistScroll = Math.min(playlists.length - VISIBLE_PL, playlistScroll + 1);
                        selectedPlaylistIdx = Math.min(playlists.length - 1, selectedPlaylistIdx + 1);
                        spotify.selectPlaylist(playlists[selectedPlaylistIdx]);
                    }, 'pl_scroll_down', 10);
                }
            }

            const visiblePlaylists = playlists.slice(playlistScroll, playlistScroll + VISIBLE_PL);
            visiblePlaylists.forEach((pl, vIdx) => {
                const realIdx = playlistScroll + vIdx;
                const py = 110 + vIdx * 67;
                const isSel = realIdx === selectedPlaylistIdx;
                const isPlPlaying = spotify.isPlaying && spotify.currentPlaylist && spotify.currentPlaylist.id === pl.id;

                cv.roundRect(56, py, 468, 59, 10, isSel ? withAlpha(t.accent, 0.22) : t.track);
                if (isSel) cv.strokeRoundRect(56, py, 468, 59, 10, 2, t.accent);

                // Accent tag
                cv.roundRect(62, py + 8, 5, 43, 2.5, isPlPlaying ? t.accent : (pl.accent || t.accent));
                cv.text(pl.name.slice(0, 24), 82, py + 29, 22, isSel ? t.text : '#e0e0e0', { font: 'bold' });
                cv.text((pl.trackCount || 0) + ' songs  -  ' + (pl.description ? pl.description.slice(0, 30) : 'Playlist'), 82, py + 48, 16, t.dim);

                if (isPlPlaying) {
                    drawMiniEqualizer(cv, 485, py + 29, t.accent, true, spectrumSeed);
                }

                cv.target(56, py, 468, 59, () => {
                    selectedPlaylistIdx = realIdx;
                    trackScroll = 0;
                    spotify.selectPlaylist(pl);
                }, 'pl_' + realIdx, 10);
            });

            // Right Pane: Tracks of selected playlist (w: 1000)
            const curPl = playlists[selectedPlaylistIdx] || playlists[0];
            const isThisPlPlaying = spotify.currentPlaylist && spotify.currentPlaylist.id === curPl.id;
            const trackTotal = curPl.trackCount || (curPl.tracks ? curPl.tracks.length : 0);

            G.panel(cv, t, 560, 52, 1000, 410, curPl.name + ' (' + trackTotal + ' tracks)');

            if (!curPl.tracks || curPl.tracks.length === 0) {
                cv.roundRect(576, 160, 968, 140, 12, t.track);
                cv.text('LOADING SONGS...', 1060, 225, 22, t.dim, { align: 'center', font: 'bold', spacing: 1 });
                cv.text('Fetching track list from Spotify cloud...', 1060, 260, 16, t.dim, { align: 'center' });
            } else {
                const VISIBLE_TRK = 7;
                const visibleTracks = curPl.tracks.slice(trackScroll, trackScroll + VISIBLE_TRK);

                visibleTracks.forEach((trk, vIdx) => {
                    const realIdx = trackScroll + vIdx;
                    const ty = 110 + vIdx * 49;
                    const isPlayingThis = isThisPlPlaying && spotify.currentTrack && spotify.currentTrack.id === trk.id;

                    if (isPlayingThis) {
                        cv.roundRect(576, ty, 968, 44, 8, withAlpha(t.accent, 0.22));
                        cv.strokeRoundRect(576, ty, 968, 44, 8, 1.5, t.accent);
                        drawMiniEqualizer(cv, 598, ty + 22, t.accent, spotify.isPlaying, spectrumSeed);
                    } else {
                        cv.roundRect(576, ty, 968, 44, 8, t.track);
                        cv.text(String(realIdx + 1), 598, ty + 27, 16, t.dim, { align: 'center', font: 'num' });
                    }

                    cv.text(trk.title.slice(0, 36), 626, ty + 28, 20, isPlayingThis ? t.accent : t.text, { font: 'bold' });
                    cv.text(trk.artist + (trk.album ? '  -  ' + trk.album : ''), 920, ty + 28, 17, t.dim);
                    cv.text(fmtTime(trk.durationMs), 1470, ty + 28, 16, t.dim, { align: 'right', font: 'num' });

                    if (isPlayingThis) {
                        cv.roundRect(1485, ty + 8, 50, 28, 6, t.accent);
                        cv.text('PLAYING', 1510, ty + 25, 11, '#000000', { align: 'center', font: 'bold' });
                    }

                    cv.target(576, ty, 968, 44, () => {
                        spotify.playTrack(curPl, realIdx);
                    }, 'trk_' + realIdx, 8);
                });
            }
        }

        /* ---------- Page 1: Library ---------- */
        function drawLibrary(cv, t) {
            const playlists = spotify.getPlaylists();
            if (!playlists || playlists.length === 0) {
                drawRequireConnect(cv, t);
                return;
            }

            G.panel(cv, t, 40, 52, 1520, 410, 'Your Library & Saved Music');

            const sections = [
                { title: 'Liked Songs', count: '142 songs', icon: '+', col: '#1db954' },
                { title: 'Heavy Rotation', count: 'Recent daily drivers', icon: 'R', col: '#e1001a' },
                { title: 'Saved Albums', count: '28 albums', icon: 'O', col: '#81c4ff' },
                { title: 'Followed Artists', count: '45 artists', icon: '*', col: '#ff9d00' },
            ];

            sections.forEach((sec, idx) => {
                const sx = 64 + idx * 370;
                cv.roundRect(sx, 120, 350, 220, 14, t.track);
                cv.strokeRoundRect(sx, 120, 350, 220, 14, 1, t.panelEdge);

                cv.circle(sx + 50, 170, 26, withAlpha(sec.col, 0.22));
                cv.text(sec.icon, sx + 50, 179, 24, sec.col, { align: 'center', font: 'bold' });

                cv.text(sec.title, sx + 90, 168, 24, t.text, { font: 'bold' });
                cv.text(sec.count, sx + 90, 192, 17, t.dim);

                cv.roundRect(sx + 30, 270, 290, 48, 8, withAlpha(sec.col, 0.18));
                cv.strokeRoundRect(sx + 30, 270, 290, 48, 8, 1, sec.col);
                cv.text('PLAY COLLECTION', sx + 175, 300, 17, sec.col, { align: 'center', font: 'bold', spacing: 1 });

                cv.target(sx, 120, 350, 220, () => {
                    if (playlists[idx % playlists.length]) {
                        spotify.selectPlaylist(playlists[idx % playlists.length]);
                        page = 0;
                    }
                }, 'lib_' + idx, 10);
            });
        }

        /* ---------- Page 2: Queue ---------- */
        function drawQueue(cv, t) {
            const pl = spotify.currentPlaylist;
            if (!pl || !pl.tracks || pl.tracks.length === 0) {
                drawRequireConnect(cv, t);
                return;
            }

            G.panel(cv, t, 40, 52, 1520, 410, 'Playback Queue (Up Next)');

            const curTrk = spotify.currentTrack;
            if (curTrk) {
                cv.roundRect(64, 114, 1472, 60, 10, withAlpha(t.accent, 0.18));
                cv.strokeRoundRect(64, 114, 1472, 60, 10, 1.5, t.accent);
                cv.text('NOW PLAYING', 84, 149, 16, t.accent, { font: 'bold', spacing: 1 });
                cv.text(curTrk.title, 220, 149, 22, t.text, { font: 'bold' });
                cv.text(curTrk.artist, 540, 149, 18, t.dim);
                drawMiniEqualizer(cv, 1490, 144, t.accent, spotify.isPlaying, spectrumSeed);
            }

            pl.tracks.slice(spotify.trackIndex + 1, spotify.trackIndex + 6).forEach((trk, idx) => {
                const qy = 186 + idx * 52;
                cv.roundRect(64, qy, 1472, 46, 8, t.track);
                cv.text(String(idx + 1), 84, qy + 28, 17, t.dim, { align: 'center', font: 'num' });
                cv.text(trk.title, 120, qy + 29, 22, t.text, { font: 'bold' });
                cv.text(trk.artist, 440, qy + 29, 18, t.dim);
                cv.text(fmtTime(trk.durationMs), 1490, qy + 29, 17, t.dim, { align: 'right', font: 'num' });

                cv.target(64, qy, 1472, 46, () => {
                    spotify.playTrack(pl, (spotify.trackIndex + 1 + idx) % pl.tracks.length);
                }, 'q_trk_' + idx, 8);
            });
        }

        /* ---------- Page 3: Connect & Real Cloud Pairing ---------- */
        function drawConnect(cv, t) {
            // Left: Real Cloud Pairing QR Code or Connected Status
            G.panel(cv, t, 40, 52, 580, 410, spotify.isOnline ? 'Spotify Account Status' : 'Scan to Connect Phone');

            if (spotify.isOnline && spotify.token) {
                // Connected Card
                cv.roundRect(70, 114, 520, 320, 14, '#0a1612');
                cv.strokeRoundRect(70, 114, 520, 320, 14, 1.5, '#1ed760');

                cv.circle(330, 175, 32, '#1ed760');
                cv.text('[OK]', 330, 184, 18, '#000000', { align: 'center', font: 'bold' });

                cv.text('SPOTIFY CONNECTED', 330, 235, 22, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });
                cv.text('Active Target: ' + spotify.activeDevice, 330, 265, 15, '#cbd5e1', { align: 'center' });
                cv.text('Personal library & playlists active', 330, 290, 14, '#64748b', { align: 'center' });

                // Disconnect Button
                const dcX = 160, dcY = 340, dcW = 340, dcH = 48;
                cv.roundRect(dcX, dcY, dcW, dcH, 10, '#1f1418');
                cv.strokeRoundRect(dcX, dcY, dcW, dcH, 10, 1.5, '#e1001a');
                cv.text('DISCONNECT / SWITCH ACCOUNT', dcX + dcW / 2, dcY + 30, 15, '#e1001a', { align: 'center', font: 'bold', spacing: 1 });

                cv.target(dcX, dcY, dcW, dcH, () => {
                    spotify.logout();
                    cachedQr = null;
                    cloudPair.startPolling();
                }, 'btn_logout', 15);
            } else {
                // Real Cloud Pairing QR Code
                const qrx = 160, qry = 114, qrsz = 195;
                const qr = getQrMatrix();
                if (qr) {
                    const modCount = qr.size;
                    const modPx = Math.floor(qrsz / modCount);
                    const actualSz = modPx * modCount;
                    const ox = qrx + Math.floor((qrsz - actualSz) / 2);
                    const oy = qry + Math.floor((qrsz - actualSz) / 2);

                    // White backdrop for clean camera scanning
                    cv.roundRect(ox - 14, oy - 14, actualSz + 28, actualSz + 28, 12, '#ffffff');
                    for (let r = 0; r < modCount; r++) {
                        for (let c = 0; c < modCount; c++) {
                            if (qr.getModule(c, r)) {
                                cv.fillRect(ox + c * modPx, oy + r * modPx, modPx, modPx, '#000000');
                            }
                        }
                    }
                }

                cv.text('Scan with phone to connect Spotify', 330, 355, 19, t.text, { align: 'center', font: 'bold' });
                cv.text('Open camera on any smartphone (4G/5G/Wi-Fi)', 330, 380, 14, t.dim, { align: 'center' });
                cv.text('PAIRING CODE: ' + cloudPair.getShortCode(), 330, 404, 15, '#00f0ff', { align: 'center', font: 'bold', spacing: 1 });
                cv.text('https://hexlay.github.io/idrive7-custom-apps/pair.html', 330, 426, 12, '#64748b', { align: 'center' });
            }

            // Right: Spotify Connect Target Devices
            G.panel(cv, t, 640, 52, 920, 410, 'Spotify Connect Devices');
            const devices = spotify.getDevices();

            devices.forEach((dev, idx) => {
                const dy = 124 + idx * 84;
                const isCur = dev.name === spotify.activeDevice;
                cv.roundRect(664, dy, 872, 70, 12, isCur ? withAlpha(t.accent, 0.22) : t.track);
                if (isCur) cv.strokeRoundRect(664, dy, 872, 70, 12, 2, t.accent);

                cv.circle(694, dy + 35, 10, isCur ? '#1db954' : t.tick);
                cv.text(dev.name, 724, dy + 33, 24, isCur ? t.text : '#dddddd', { font: 'bold' });
                cv.text(dev.type + (isCur ? '  -  CURRENT ACTIVE TARGET' : '  -  Available'), 724, dy + 55, 18, isCur ? t.accent : t.dim);

                cv.roundRect(1410, dy + 16, 106, 38, 8, isCur ? t.accent : withAlpha(t.tick, 0.5));
                cv.text(isCur ? 'CONNECTED' : 'TRANSFER', 1463, dy + 40, 16, '#ffffff', { align: 'center', font: 'bold' });

                cv.target(664, dy, 872, 70, () => {
                    spotify.transferToDevice(dev.id);
                }, 'dev_' + idx, 12);
            });

            // Status indicator
            cv.roundRect(664, 380, 280, 42, 8, withAlpha(t.panelEdge, 0.8));
            cv.text(spotify.isOnline ? 'ONLINE: CONNECTED' : 'AWAITING PHONE PAIRING', 804, 406, 16, spotify.isOnline ? '#1ed760' : '#ffb703', { align: 'center', font: 'bold' });
        }

        /* ---------- Master Render Loop ---------- */
        async function render() {
            spotify.tick();
            spectrumSeed += 0.08;

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
            else if (page === 2) drawQueue(cv, t);
            else if (page === 3) drawConnect(cv, t);

            // G20 Live Cockpit frame tabs along the top
            G.frame(cv, t, PAGES, page, [
                { text: 'SPOTIFY' },
                { text: spotify.activeDevice },
                { text: (spotify.isPlaying ? 'PLAYING: ' : 'PAUSED: ') + (spotify.currentTrack ? spotify.currentTrack.title.toUpperCase() : 'IDLE') }
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
