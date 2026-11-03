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
const PAGES = ['Playlists', 'Liked Songs', 'Queue', 'Connect'];

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

        /* ---------- Now Playing Sub-Header Pill ---------- */
        function drawNowPlayingPill(cv, t, x, y, w, h) {
            const curTrk = spotify.currentTrack;
            if (!curTrk) return;

            const isPlaying = spotify.isPlaying;
            cv.roundRect(x, y, w, h, 8, withAlpha(t.panelEdge, 0.7));
            cv.strokeRoundRect(x, y, w, h, 8, 1, isPlaying ? withAlpha(t.accent, 0.45) : withAlpha(t.panelEdge, 0.9));

            // Animated Equalizer icon
            drawMiniEqualizer(cv, x + 18, y + Math.floor(h / 2), isPlaying ? t.accent : t.dim, isPlaying, spectrumSeed);

            // "PLAYING:" or "PAUSED:" tag
            const stateStr = isPlaying ? 'PLAYING:' : 'PAUSED:';
            cv.text(stateStr, x + 34, y + Math.floor(h / 2) + 5, 13, isPlaying ? t.accent : t.dim, { font: 'bold', spacing: 0.5 });

            // Track title & artist
            const trackStr = curTrk.title + (curTrk.artist ? '  -  ' + curTrk.artist : '');
            cv.text(trunc(trackStr, 34), x + 104, y + Math.floor(h / 2) + 5, 15, isPlaying ? t.text : t.dim);

            // Tap cue to switch to Queue
            cv.text('QUEUE >', x + w - 12, y + Math.floor(h / 2) + 5, 12, isPlaying ? t.accent : t.dim, { align: 'right', font: 'bold' });

            cv.target(x, y, w, h, () => {
                page = 2; // Jump to Queue / Now Playing tab
            }, 'np_pill', 10);
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

            // Left Pane Scrollbar (replaces old ^/v buttons)
            drawScrollbar(cv, t, 524, 110, 330, playlists.length, VISIBLE_PL, playlistScroll, () => {
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
                const py = 110 + vIdx * 67;
                const isSel = realIdx === selectedPlaylistIdx;
                const isPlPlaying = spotify.isPlaying && spotify.currentPlaylist && spotify.currentPlaylist.id === pl.id;

                cv.roundRect(56, py, 458, 59, 10, isSel ? withAlpha(t.accent, 0.22) : t.track);
                if (isSel) cv.strokeRoundRect(56, py, 458, 59, 10, 2, t.accent);

                // Accent tag
                cv.roundRect(62, py + 8, 5, 43, 2.5, isPlPlaying ? t.accent : (pl.accent || t.accent));
                cv.text(trunc(pl.name, 22), 82, py + 29, 22, isSel ? t.text : '#e0e0e0', { font: 'bold' });
                cv.text((pl.trackCount || 0) + ' songs  -  ' + trunc(pl.description || 'Playlist', 26), 82, py + 48, 16, t.dim);

                if (isPlPlaying) {
                    drawMiniEqualizer(cv, 480, py + 29, t.accent, true, spectrumSeed);
                }

                cv.target(56, py, 458, 59, () => {
                    selectedPlaylistIdx = realIdx;
                    trackScroll = 0;
                    spotify.selectPlaylist(pl);
                }, 'pl_' + realIdx, 10);
            });

            // Right Pane: Tracks of selected playlist (w: 1000)
            const curPl = playlists[selectedPlaylistIdx] || playlists[0];
            const isThisPlPlaying = spotify.currentPlaylist && spotify.currentPlaylist.id === curPl.id;
            const trackTotal = curPl.trackCount || (curPl.tracks ? curPl.tracks.length : 0);

            G.panel(cv, t, 560, 52, 1000, 410, trunc(curPl.name, 22) + ' (' + trackTotal + ' tracks)');
            drawNowPlayingPill(cv, t, 960, 62, 570, 34);

            if (!curPl.tracks || curPl.tracks.length === 0) {
                cv.roundRect(576, 160, 968, 140, 12, t.track);
                cv.text('LOADING SONGS...', 1060, 225, 22, t.dim, { align: 'center', font: 'bold', spacing: 1 });
                cv.text('Fetching track list from Spotify cloud...', 1060, 260, 16, t.dim, { align: 'center' });
            } else {
                const VISIBLE_TRK = 7;

                // Right Pane Tracks Scrollbar
                drawScrollbar(cv, t, 1538, 110, 338, curPl.tracks.length, VISIBLE_TRK, trackScroll, () => {
                    trackScroll = Math.max(0, trackScroll - VISIBLE_TRK);
                }, () => {
                    trackScroll = Math.min(Math.max(0, curPl.tracks.length - VISIBLE_TRK), trackScroll + VISIBLE_TRK);
                });

                const visibleTracks = curPl.tracks.slice(trackScroll, trackScroll + VISIBLE_TRK);

                visibleTracks.forEach((trk, vIdx) => {
                    const realIdx = trackScroll + vIdx;
                    const ty = 110 + vIdx * 49;
                    const isPlayingThis = isThisPlPlaying && spotify.currentTrack && spotify.currentTrack.id === trk.id;

                    if (isPlayingThis) {
                        cv.roundRect(576, ty, 946, 44, 8, withAlpha(t.accent, 0.22));
                        cv.strokeRoundRect(576, ty, 946, 44, 8, 1.5, t.accent);
                        drawMiniEqualizer(cv, 598, ty + 22, t.accent, spotify.isPlaying, spectrumSeed);
                    } else {
                        cv.roundRect(576, ty, 946, 44, 8, t.track);
                        cv.text(String(realIdx + 1), 598, ty + 27, 16, t.dim, { align: 'center', font: 'num' });
                    }

                    // Strict column bounds prevent overlap:
                    // Title ends before 910; Artist starts at 920 and ends before 1420; Duration right-aligned
                    cv.text(trunc(trk.title, 24), 626, ty + 28, 20, isPlayingThis ? t.accent : t.text, { font: 'bold' });
                    const metaText = trk.artist + (trk.album ? '  -  ' + trk.album : '');
                    cv.text(trunc(metaText, 38), 920, ty + 28, 17, t.dim);
                    cv.text(fmtTime(trk.durationMs), isPlayingThis ? 1440 : 1490, ty + 28, 16, t.dim, { align: 'right', font: 'num' });

                    if (isPlayingThis) {
                        cv.roundRect(1450, ty + 8, 54, 28, 6, t.accent);
                        cv.text('PLAYING', 1477, ty + 25, 11, '#000000', { align: 'center', font: 'bold' });
                    }

                    cv.target(576, ty, 946, 44, () => {
                        spotify.playTrack(curPl, realIdx);
                    }, 'trk_' + realIdx, 8);
                });
            }
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

            G.panel(cv, t, 40, 52, 1520, 410, title);
            drawNowPlayingPill(cv, t, 960, 62, 570, 34);

            // Liked Songs Scrollbar (replaces old ^/v buttons)
            drawScrollbar(cv, t, 1538, 110, 338, liked.length, VISIBLE_LIKED, likedScroll, () => {
                likedScroll = Math.max(0, likedScroll - VISIBLE_LIKED);
            }, () => {
                likedScroll = Math.min(Math.max(0, liked.length - VISIBLE_LIKED), likedScroll + VISIBLE_LIKED);
            });

            if (!liked || liked.length === 0) {
                cv.roundRect(70, 150, 1460, 160, 12, t.track);
                cv.text('LOADING LIKED SONGS...', 800, 215, 22, t.dim, { align: 'center', font: 'bold', spacing: 1 });
                cv.text('Fetching your saved songs from Spotify cloud...', 800, 250, 16, t.dim, { align: 'center' });
                return;
            }

            const visible = liked.slice(likedScroll, likedScroll + VISIBLE_LIKED);
            visible.forEach((trk, vIdx) => {
                const realIdx = likedScroll + vIdx;
                const ty = 110 + vIdx * 49;
                const isPlayingThis = spotify.isPlaying && spotify.currentTrack && spotify.currentTrack.id === trk.id;

                if (isPlayingThis) {
                    cv.roundRect(56, ty, 1466, 44, 8, withAlpha(t.accent, 0.22));
                    cv.strokeRoundRect(56, ty, 1466, 44, 1.5, t.accent);
                    drawMiniEqualizer(cv, 80, ty + 22, t.accent, spotify.isPlaying, spectrumSeed);
                } else {
                    cv.roundRect(56, ty, 1466, 44, 8, t.track);
                    cv.text(String(realIdx + 1), 80, ty + 27, 16, t.dim, { align: 'center', font: 'num' });
                }

                // Heart tag
                cv.text('*', 115, ty + 29, 20, '#1ed760', { align: 'center', font: 'bold' });

                cv.text(trunc(trk.title, 34), 145, ty + 28, 20, isPlayingThis ? t.accent : t.text, { font: 'bold' });
                const metaText = trk.artist + (trk.album ? '  -  ' + trk.album : '');
                cv.text(trunc(metaText, 46), 680, ty + 28, 17, t.dim);
                cv.text(fmtTime(trk.durationMs), isPlayingThis ? 1410 : 1450, ty + 28, 16, t.dim, { align: 'right', font: 'num' });

                if (isPlayingThis) {
                    cv.roundRect(1420, ty + 8, 54, 28, 6, t.accent);
                    cv.text('PLAYING', 1447, ty + 25, 11, '#000000', { align: 'center', font: 'bold' });
                }

                cv.target(56, ty, 1466, 44, () => {
                    spotify.playLikedSong(realIdx);
                }, 'liked_' + realIdx, 8);
            });
        }

        /* ---------- Page 2: Queue ---------- */
        function drawQueue(cv, t) {
            const isOnline = settings.get('demo') !== 'on';
            if (isOnline && (!spotify.token || !spotify.paired)) {
                drawRequireConnect(cv, t);
                return;
            }

            G.panel(cv, t, 40, 52, 1520, 410, 'Playback Queue (Up Next)');

            const curTrk = spotify.currentTrack;

            // Card 1: Now Playing Card (h: 88)
            cv.roundRect(60, 108, 1480, 88, 12, curTrk ? withAlpha(t.accent, 0.16) : t.track);
            if (curTrk) cv.strokeRoundRect(60, 108, 1480, 88, 12, 1.5, t.accent);

            if (curTrk) {
                drawMiniEqualizer(cv, 95, 152, t.accent, spotify.isPlaying, spectrumSeed);
                cv.text('NOW PLAYING', 125, 136, 13, t.accent, { font: 'bold', spacing: 1 });
                cv.text(trunc(curTrk.title, 34), 125, 165, 23, t.text, { font: 'bold' });
                const curMeta = curTrk.artist + (curTrk.album ? '  -  ' + curTrk.album : '');
                cv.text(trunc(curMeta, 46), 680, 164, 18, t.dim);
                cv.text(fmtTime(spotify.progressMs) + ' / ' + fmtTime(curTrk.durationMs), 1500, 164, 16, t.accent, { align: 'right', font: 'num' });

                // Live progress bar along the bottom of card
                const pFrac = Math.min(1, Math.max(0, spotify.progressMs / (curTrk.durationMs || 1)));
                cv.roundRect(125, 180, 1380, 4, 2, t.tick);
                cv.roundRect(125, 180, 1380 * pFrac, 4, 2, t.accent);
            } else {
                cv.text('IDLE - NO TRACK PLAYING', 95, 152, 20, t.dim, { font: 'bold', spacing: 1 });
                cv.text('Select any song from Playlists or Liked Songs to begin playback.', 420, 152, 16, t.dim);
            }

            // Card 2: Up Next in Queue
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

            const qCount = upcoming.length;
            cv.text('UP NEXT IN QUEUE (' + qCount + ')', 62, 222, 14, t.dim, { font: 'bold', spacing: 1 });

            if (!upcoming || upcoming.length === 0) {
                cv.roundRect(60, 236, 1480, 120, 10, t.track);
                cv.text('Queue is currently empty.', 800, 285, 19, t.dim, { align: 'center', font: 'bold' });
                cv.text('Play any track from Playlists or Liked Songs to queue up songs.', 800, 315, 15, t.dim, { align: 'center' });
                return;
            }

            const VISIBLE_Q = 4;
            const visibleQ = upcoming.slice(0, VISIBLE_Q);
            visibleQ.forEach((trk, idx) => {
                const qy = 236 + idx * 52;
                cv.roundRect(60, qy, 1480, 46, 8, t.track);
                cv.text(String(idx + 1), 85, qy + 28, 16, t.dim, { align: 'center', font: 'num' });
                cv.text(trunc(trk.title, 34), 125, qy + 28, 20, t.text, { font: 'bold' });
                const metaText = trk.artist + (trk.album ? '  -  ' + trk.album : '');
                cv.text(trunc(metaText, 46), 680, qy + 28, 17, t.dim);
                cv.text(fmtTime(trk.durationMs), 1500, qy + 28, 16, t.dim, { align: 'right', font: 'num' });
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

            if (!devices || devices.length === 0) {
                cv.roundRect(664, 124, 872, 230, 14, t.track);
                cv.strokeRoundRect(664, 124, 872, 230, 14, 1, t.panelEdge);

                cv.circle(734, 195, 34, withAlpha(t.accent, 0.22));
                cv.text('!', 734, 206, 30, t.accent, { align: 'center', font: 'bold' });

                cv.text('NO ACTIVE SPOTIFY DEVICES FOUND', 790, 178, 22, t.text, { font: 'bold' });
                cv.text('Open Spotify on your iPhone, Mac, or car to connect playback.', 790, 208, 16, '#cbd5e1');
                cv.text('Spotify Connect routes audio to an active device running Spotify.', 790, 234, 14, t.dim);

                // Refresh Button
                const rfW = 240, rfH = 46, rfX = 790, rfY = 268;
                cv.roundRect(rfX, rfY, rfW, rfH, 8, withAlpha(t.accent, 0.22));
                cv.strokeRoundRect(rfX, rfY, rfW, rfH, 8, 1.5, t.accent);
                cv.text('REFRESH DEVICES', rfX + rfW / 2, rfY + 29, 15, t.accent, { align: 'center', font: 'bold', spacing: 1 });
                cv.target(rfX, rfY, rfW, rfH, () => {
                    spotify.fetchDevices().then(() => render());
                }, 'btn_refresh_devs', 12);
            } else {
                devices.forEach((dev, idx) => {
                    const dy = 124 + idx * 84;
                    const isCur = dev.isActive || dev.name === spotify.activeDevice;
                    cv.roundRect(664, dy, 872, 70, 12, isCur ? withAlpha(t.accent, 0.22) : t.track);
                    if (isCur) cv.strokeRoundRect(664, dy, 872, 70, 12, 2, t.accent);

                    cv.circle(694, dy + 35, 10, isCur ? '#1db954' : t.tick);
                    cv.text(dev.name, 724, dy + 33, 24, isCur ? t.text : '#dddddd', { font: 'bold' });
                    cv.text(dev.type + (isCur ? '  -  CURRENT ACTIVE TARGET' : '  -  Available'), 724, dy + 55, 18, isCur ? t.accent : t.dim);

                    cv.roundRect(1410, dy + 16, 106, 38, 8, isCur ? t.accent : withAlpha(t.tick, 0.5));
                    cv.text(isCur ? 'ACTIVE' : 'TRANSFER', 1463, dy + 40, 16, '#ffffff', { align: 'center', font: 'bold' });

                    cv.target(664, dy, 872, 70, () => {
                        spotify.transferToDevice(dev.id);
                    }, 'dev_' + idx, 12);
                });
            }

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
