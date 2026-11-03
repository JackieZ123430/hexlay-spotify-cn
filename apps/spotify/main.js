'use strict';
/**
 * Spotify - native BMW iDrive 7 (MGU) Spotify Connect library & playlist browser.
 * Focuses on browsing, selecting playlists, queuing music and fast switching.
 * "Now Playing" playback status is left to BMW's native media widget on the home/split screen.
 *
 * Pages:
 *   0: Playlists   - Split playlist & track selector with live playing indicators
 *   1: Library     - Liked songs, heavy rotation, saved albums & artists
 *   2: Queue       - Up next queue inspection
 *   3: Connect     - QR code phone authorization & Spotify Connect device switcher
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { SpotifyClient } = require('./api');
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
        const { ui, settings, log } = ctx;
        const spotify = new SpotifyClient(ctx);

        let page = 0;
        let selectedPlaylistIdx = 0;
        let spectrumSeed = 0;

        /* ---------- QR Code Generation ---------- */
        let cachedQr = null;
        function getQrMatrix() {
            if (cachedQr) return cachedQr;
            try {
                const url = 'https://accounts.spotify.com/authorize?client_id=' + spotify.clientId + '&response_type=code&scope=user-modify-playback-state+user-read-playback-state';
                const qr = qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.MEDIUM);
                cachedQr = qr;
                return qr;
            } catch (e) {
                return null;
            }
        }

        /* ---------- Page 0: Playlists & Tracks with Now Playing Indicator ---------- */
        function drawPlaylists(cv, t) {
            const playlists = spotify.getPlaylists();

            // Left Pane: Playlists (w: 520)
            G.panel(cv, t, 40, 52, 500, 410, 'Your Playlists');
            playlists.forEach((pl, idx) => {
                const py = 114 + idx * 74;
                const isSel = idx === selectedPlaylistIdx;
                const isPlPlaying = spotify.isPlaying && spotify.currentPlaylist && spotify.currentPlaylist.id === pl.id;

                cv.roundRect(56, py, 468, 62, 10, isSel ? withAlpha(t.accent, 0.22) : t.track);
                if (isSel) cv.strokeRoundRect(56, py, 468, 62, 10, 2, t.accent);

                // Accent tag
                cv.roundRect(62, py + 8, 6, 46, 3, isPlPlaying ? t.accent : (pl.accent || t.accent));
                cv.text(pl.name, 82, py + 32, 24, isSel ? t.text : '#e0e0e0', { font: 'bold' });
                cv.text(pl.trackCount + ' songs  ·  ' + (pl.description.slice(0, 32) + '...'), 82, py + 52, 18, t.dim);

                // If this playlist is currently active:
                if (isPlPlaying) {
                    drawMiniEqualizer(cv, 485, py + 31, t.accent, true, spectrumSeed);
                }

                cv.target(56, py, 468, 62, () => {
                    selectedPlaylistIdx = idx;
                    spotify.selectPlaylist(pl);
                }, 'pl_' + idx, 10);
            });

            // Right Pane: Tracks of selected playlist (w: 1000)
            const curPl = playlists[selectedPlaylistIdx] || playlists[0];
            const isThisPlPlaying = spotify.currentPlaylist && spotify.currentPlaylist.id === curPl.id;

            G.panel(cv, t, 560, 52, 1000, 410, curPl.name + ' (' + curPl.tracks.length + ' tracks)');

            curPl.tracks.slice(0, 7).forEach((trk, idx) => {
                const ty = 114 + idx * 52;
                const isPlayingThis = isThisPlPlaying && spotify.currentTrack && spotify.currentTrack.id === trk.id;

                if (isPlayingThis) {
                    // High-contrast glowing row for currently playing song
                    cv.roundRect(576, ty, 968, 46, 8, withAlpha(t.accent, 0.25));
                    cv.strokeRoundRect(576, ty, 968, 46, 8, 1.5, t.accent);

                    // Animated equalizer bars replacing track number
                    drawMiniEqualizer(cv, 602, ty + 23, t.accent, spotify.isPlaying, spectrumSeed);

                    // Track title highlighted in Spotify green
                    cv.text(trk.title, 630, ty + 30, 22, t.accent, { font: 'bold' });
                    cv.text(trk.artist + '  ·  ' + trk.album, 950, ty + 30, 20, t.text);

                    // Elapsed / Duration
                    const timeStr = fmtTime(spotify.progressMs) + ' / ' + fmtTime(trk.durationMs);
                    cv.text(timeStr, 1420, ty + 30, 20, t.accent, { align: 'right', font: 'num' });

                    // NOW PLAYING pill badge
                    cv.roundRect(1440, ty + 10, 92, 26, 6, t.accent);
                    cv.text('PLAYING', 1486, ty + 28, 14, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });
                } else {
                    cv.roundRect(576, ty, 968, 46, 8, idx % 2 === 0 ? withAlpha(t.track, 0.5) : 'transparent');
                    cv.text(String(idx + 1), 602, ty + 30, 20, t.dim, { align: 'center', font: 'num' });
                    cv.text(trk.title, 630, ty + 30, 22, '#ffffff', { font: 'bold' });
                    cv.text(trk.artist + '  ·  ' + trk.album, 950, ty + 30, 20, t.dim);
                    cv.text(fmtTime(trk.durationMs), 1510, ty + 30, 20, t.dim, { align: 'right', font: 'num' });
                }

                cv.target(576, ty, 968, 46, () => {
                    spotify.playTrack(curPl, idx);
                }, 'trk_' + idx, 8);
            });
        }

        /* ---------- Page 1: Library ---------- */
        function drawLibrary(cv, t) {
            G.panel(cv, t, 40, 52, 1520, 410, 'Your Spotify Library');

            const isLikedPlaying = spotify.isPlaying && spotify.currentPlaylist && spotify.currentPlaylist.id === 'pl_liked';
            const cards = [
                { title: 'Liked Songs', count: '142 Tracks', tag: 'FAV', color: '#1db954', desc: 'Auto-synced with phone', active: isLikedPlaying },
                { title: 'Heavy Rotation', count: '5 Playlists', tag: 'TOP', color: '#e1001a', desc: 'Your most played driving music', active: false },
                { title: 'Albums', count: '28 Saved', tag: 'ALB', color: '#81c4ff', desc: 'Saved albums library', active: false },
                { title: 'Artists', count: '45 Following', tag: 'ART', color: '#ff9d00', desc: 'Favorite music creators', active: false },
            ];

            cards.forEach((c, i) => {
                const cx = 70 + i * 365;
                const cy = 130;
                cv.roundRect(cx, cy, 335, 290, 14, t.track);
                cv.strokeRoundRect(cx, cy, 335, 290, 14, 1.5, c.active ? t.accent : t.panelEdge);

                cv.circle(cx + 60, cy + 60, 36, withAlpha(c.color, 0.25));
                cv.text(c.tag, cx + 60, cy + 68, 22, c.color, { align: 'center', font: 'bold', spacing: 1 });

                cv.text(c.title, cx + 24, cy + 145, 28, t.text, { font: 'bold' });
                cv.text(c.count, cx + 24, cy + 180, 22, c.color, { font: 'bold' });
                cv.text(c.desc, cx + 24, cy + 215, 18, t.dim);

                // Quick Play button or Active indicator
                if (c.active) {
                    cv.roundRect(cx + 24, cy + 235, 150, 38, 8, t.accent);
                    drawMiniEqualizer(cv, cx + 50, cy + 254, '#ffffff', true, spectrumSeed);
                    cv.text('PLAYING', cx + 105, cy + 260, 16, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });
                } else {
                    cv.roundRect(cx + 24, cy + 235, 140, 38, 8, withAlpha(c.color, 0.3));
                    cv.text('PLAY ALL', cx + 94, cy + 260, 18, t.text, { align: 'center', font: 'bold' });
                }

                cv.target(cx, cy, 335, 290, () => {
                    spotify.selectPlaylist(spotify.getPlaylists()[i % spotify.getPlaylists().length]);
                    page = 0;
                }, 'lib_card_' + i, 14);
            });
        }

        /* ---------- Page 2: Queue ---------- */
        function drawQueue(cv, t) {
            G.panel(cv, t, 40, 52, 1520, 410, 'Playback Queue');

            // Current playing banner
            cv.roundRect(64, 114, 1472, 64, 10, withAlpha(t.accent, 0.22));
            cv.strokeRoundRect(64, 114, 1472, 64, 10, 1.5, t.accent);

            drawMiniEqualizer(cv, 96, 146, t.accent, spotify.isPlaying, spectrumSeed);
            cv.text('NOW PLAYING', 126, 152, 18, t.accent, { font: 'bold', spacing: 1.5 });
            cv.text(spotify.currentTrack.title, 300, 152, 24, t.text, { font: 'bold' });
            cv.text(spotify.currentTrack.artist + '  ·  ' + spotify.currentTrack.album, 720, 152, 22, t.dim);
            cv.text(fmtTime(spotify.progressMs) + ' / ' + fmtTime(spotify.currentTrack.durationMs), 1500, 152, 22, t.accent, { align: 'right', font: 'num' });

            cv.text('NEXT IN QUEUE', 64, 215, 20, t.dim, { font: 'bold', spacing: 1.5 });

            // Next items
            const pl = spotify.currentPlaylist;
            const remaining = pl.tracks.slice(spotify.trackIndex + 1).concat(pl.tracks.slice(0, spotify.trackIndex));
            remaining.slice(0, 4).forEach((trk, idx) => {
                const qy = 236 + idx * 52;
                cv.roundRect(64, qy, 1472, 46, 8, withAlpha(t.track, 0.6));
                cv.text(String(idx + 1), 90, qy + 30, 20, t.dim, { align: 'center', font: 'num' });
                cv.text(trk.title, 130, qy + 30, 22, t.text, { font: 'bold' });
                cv.text(trk.artist + '  ·  ' + trk.album, 650, qy + 30, 20, t.dim);
                cv.text(fmtTime(trk.durationMs), 1500, qy + 30, 20, t.dim, { align: 'right', font: 'num' });

                cv.target(64, qy, 1472, 46, () => {
                    spotify.playTrack(pl, (spotify.trackIndex + 1 + idx) % pl.tracks.length);
                }, 'q_trk_' + idx, 8);
            });
        }

        /* ---------- Page 3: Connect & QR Setup ---------- */
        function drawConnect(cv, t) {
            // Left: QR Code Pairing
            G.panel(cv, t, 40, 52, 580, 410, 'Scan to Connect Phone');

            const qrx = 160, qry = 120, qrsz = 210;
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

            cv.text('Scan with your phone to authorize', 330, 385, 20, t.text, { align: 'center', font: 'bold' });
            cv.text('Tokens save automatically on this car', 330, 412, 17, t.dim, { align: 'center' });

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
                cv.text(dev.type + (isCur ? '  ·  CURRENT ACTIVE TARGET' : '  ·  Available'), 724, dy + 55, 18, isCur ? t.accent : t.dim);

                cv.roundRect(1410, dy + 16, 106, 38, 8, isCur ? t.accent : withAlpha(t.tick, 0.5));
                cv.text(isCur ? 'CONNECTED' : 'TRANSFER', 1463, dy + 40, 16, '#ffffff', { align: 'center', font: 'bold' });

                cv.target(664, dy, 872, 70, () => {
                    spotify.transferToDevice(dev.id);
                }, 'dev_' + idx, 12);
            });

            // Status indicator
            cv.roundRect(664, 380, 260, 42, 8, withAlpha(t.panelEdge, 0.8));
            cv.text(spotify.isOnline ? 'ONLINE: CONNECTED' : 'DEMO MODE: ACTIVE', 794, 406, 18, spotify.isOnline ? '#1ed760' : t.accent, { align: 'center', font: 'bold' });
        }

        /* ---------- Master Render Loop ---------- */
        async function render() {
            spotify.tick();
            spectrumSeed += 0.08;

            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);

            // Draw current active page
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
        ui.onClick('BTN_PLAY', () => { spotify.togglePlay(); return render(); });
        ui.onClick('BTN_NEXT', () => { spotify.nextTrack(); return render(); });
        ui.onClick('BTN_PREV', () => { spotify.prevTrack(); return render(); });
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; return render(); });
        ctx.onTab((idx) => { page = idx; return render(); });

        // Start 60 fps render loop
        ctx.loop('MAIN', 15, render);
        render().then(() => log.info('Spotify app ready')).catch((e) => log.warn('Spotify render error: ' + e));
    }
});
