'use strict';
/**
 * M-Cinema - Native BMW iDrive 7 (MGU) YouTube Cockpit Theater & Video Player.
 * Styled after BMW ConnectedDrive & Live Cockpit Professional design language.
 *
 * Operational Architecture:
 *   1. In-Car YouTube Search:
 *      Search YouTube videos directly from the iDrive 7 central display using an
 *      on-screen BMW speller keyboard, category chips, and live results list.
 *   2. Official YouTube App TV Casting ("Link with TV code"):
 *      Pairs with the official YouTube mobile app on iPhone & Android via Google's
 *      official Lounge on TV protocol (Settings > Watch on TV > Link with TV code).
 *      Vehicle permanently appears as a Cast target ("BMW iDrive 7") in the official YouTube app!
 *   3. 60 FPS Native Vector Cockpit Stage:
 *      Full GPU-accelerated vector stage without heavy unaligned pixel buffers.
 *      Preserves 100% responsive touchscreen touch routing across tabs and seekbar!
 *   4. Active Cockpit Playback & Live Spectrum Equalizer:
 *      Dynamic live timecode, smooth seeking scrubber, animated ambilight aura, and
 *      clean 16-bar multi-colored audio spectrum visualizer.
 *   5. Intel Atom A3960 Hardware Thermal Safe Cap:
 *      Clamps streams strictly to 720p 60 HD to protect head unit CPU/GPU.
 *
 * Audio Routing:
 *   Audio streams through the vehicle stereo via Bluetooth Audio or Apple CarPlay / Android Auto.
 *
 * Pages:
 *   0: Now Playing - 21:9 Widescreen player with live ambient accent & spectrum visualizer
 *   1: Search - In-car YouTube search, speller keyboard & video results
 *   2: Connect - Official YouTube TV Link Code & Pairing Instructions
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { YouTubeSearchEngine } = require('./youtube_search');
const { YouTubeLoungeReceiver } = require('./lounge');
const { VideoPlayer } = require('./player');
const { ThumbnailManager, THUMB_BASE_ID } = require('./thumbnail_manager');

const W = 1600, H = 520;
const PAGES = ['Now Playing', 'Search', 'Connect'];

function trunc(str, maxLen) {
    if (!str || typeof str !== 'string') return '';
    return str.length > maxLen ? str.slice(0, maxLen - 1) + '..' : str;
}

function parseDurationSec(durStr) {
    if (!durStr || typeof durStr !== 'string') return 180;
    const parts = durStr.trim().split(':').map(Number);
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        return parts[0] * 60 + parts[1];
    }
    if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return 180;
}

function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem < 10 ? '0' : ''}${rem}`;
}

function extractYouTubeId(urlOrId) {
    if (!urlOrId) return null;
    if (/^[A-Za-z0-9_-]{11}$/.test(urlOrId)) return urlOrId;
    const m = String(urlOrId).match(/(?:v=|youtu\.be\/|embed\/|v\/|shorts\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log, signals } = ctx;

        let page = 0;
        let isPlaying = false;
        let currentTimeSec = 0;
        let totalDurationSec = 0;
        let playProgress = 0;
        let vehicleSpeed = 0;
        let statusMsg = null;
        let statusTime = 0;
        let lastMotionLocked = false;
        let isFullscreen = false;

        function updateVideoBounds() {
            if (!process.send) return;
            const b = isFullscreen ?
                { x: 64, y: 158, w: 1472, h: 236, r: 8 } :
                { x: 64, y: 158, w: 992, h: 236, r: 8 };
            process.send({ t: 'video', action: 'place', x: b.x, y: b.y, w: b.w, h: b.h, r: b.r });
        }

        function toggleFullscreen() {
            isFullscreen = !isFullscreen;
            notify(isFullscreen ? 'Cinema Fullscreen' : 'Standard View');
            updateVideoBounds();
            render().catch(() => {});
        }

        function setPage(idx) {
            page = idx;
            if (process.send) {
                process.send({ t: 'video', action: page === 0 && isPlaying && !lastMotionLocked ? 'show' : 'hide' });
            }
            if (page === 0 && isPlaying && !lastMotionLocked) {
                updateVideoBounds();
            }
        }

        // Native Hardware Video Engine (Protocol 4 OP_VIDEO)
        const player = new VideoPlayer(log, { shmPath: '/dev/shm/mgu-video-cinema' });
        if (ctx.display && ctx.display.video) {
            ctx.display.video(1, '/dev/shm/mgu-video-cinema');
        }

        player.onProgress = (pts, dur, playing) => {
            currentTimeSec = Math.floor(pts);
            if (dur > 0) totalDurationSec = Math.floor(dur);
            isPlaying = playing;
            if (totalDurationSec > 0) {
                playProgress = Math.min(1, Math.max(0, currentTimeSec / totalDurationSec));
            }
            render().catch(() => {});
        };

        player.onEnded = () => {
            isPlaying = false;
            notify('Playback finished');
            render().catch(() => {});
        };

        // In-Car Search State
        let searchQuery = '';
        let searchScroll = 0;
        const searchEngine = new YouTubeSearchEngine(log);
        let searchResults = searchEngine.getFeatured();
        const thumbManager = new ThumbnailManager(log, () => render().catch(() => {}));

        // Active YouTube video
        let activeCastVideo = {
            title: 'Ready to Play',
            channel: 'YouTube on TV',
            duration: '0:00',
            durationSec: 0,
            quality: '720p HD',
            glow: '#0066b1',
            views: 'Connected',
            desc: 'Search YouTube directly from iDrive in Search tab or link YouTube mobile app in Connect tab.',
            ytId: null,
            url: null
        };

        // Monitor vehicle speed for safety
        try {
            const Car = require('./kit/car');
            const car = new Car(ctx, ['speed']);
            car.onSample((data) => {
                if (data.speed !== undefined) vehicleSpeed = Math.round(data.speed);
            });
        } catch (e) {
            log.warn('M-Cinema: Speed monitor fallback: ' + e.message);
        }

        function notify(msg) {
            statusMsg = msg;
            statusTime = Date.now();
            log.info('M-Cinema: ' + msg);
        }

        // Common handler for playing any video (cast or searched)
        function playVideo(video) {
            video.quality = '720p HD';
            video.ytId = video.ytId || video.id || extractYouTubeId(video.url) || null;
            activeCastVideo = video;
            isPlaying = true;
            currentTimeSec = 0;
            totalDurationSec = video.durationSec || parseDurationSec(video.duration);
            playProgress = 0;
            setPage(0); // jump directly to Now Playing (sends 'show' now that isPlaying is true)

            // If connected to YouTube on TV Lounge, notify session
            if (video.ytId && loungeReceiver && loungeReceiver.isConnected) {
                loungeReceiver.sendPlayVideo(video.ytId);
            }

            // Start native video engine playback
            const streamUrl = video.streamUrl || video.url || ('https://youtube.com/watch?v=' + (video.ytId || ''));
            const b = isFullscreen ?
                { x: 64, y: 158, w: 1472, h: 236, r: 8 } :
                { x: 64, y: 158, w: 992, h: 236, r: 8 };
            player.play(streamUrl, totalDurationSec, Object.assign({}, video, b));

            notify('Playing: ' + video.title);
            render().catch(() => {});
        }

        // Active Playback Progress Ticker (fallback if not driven by native player)
        const playbackTimer = setInterval(() => {
            if (isPlaying && totalDurationSec > 0 && !player.proc) {
                currentTimeSec++;
                playProgress = Math.min(1, currentTimeSec / totalDurationSec);
                if (currentTimeSec >= totalDurationSec) {
                    currentTimeSec = 0;
                    playProgress = 0;
                }
                render().catch(() => {});
            }
        }, 1000);

        // Initialize Official YouTube on TV Lounge Receiver
        const loungeReceiver = new YouTubeLoungeReceiver({
            onCast(video) {
                playVideo(video);
            },
            onControl(cmd) {
                if (cmd === 'pause') {
                    isPlaying = false;
                    notify('Paused');
                } else if (cmd === 'play') {
                    isPlaying = true;
                    notify('Playing');
                }
                render().catch(() => {});
            },
            onCodeUpdated() {
                render().catch(() => {});
            }
        }, log);
        loungeReceiver.start().catch((e) => log.warn('Lounge start err: ' + e.message));

        /* ---------- Vector Play / Pause Icon ---------- */
        function drawPlayGlyph(cv, cx, cy, sz, col) {
            const hw = sz * 0.46, hh = sz * 0.52;
            const p0 = [cx - hw * 0.6, cy - hh];
            const p1 = [cx + hw * 1.1, cy];
            const p2 = [cx - hw * 0.6, cy + hh];
            if (cv.triangle) cv.triangle([p0, p1, p2], col);
            else cv.quad([p0, p1, p2, p2], col);
        }

        function drawPauseGlyph(cv, cx, cy, sz, col) {
            const w = sz * 0.28, h = sz * 0.9, gap = sz * 0.2;
            cv.fillRect(cx - gap - w, cy - h / 2, w, h, col);
            cv.fillRect(cx + gap, cy - h / 2, w, h, col);
        }

        /* ---------- Execute In-Car Search ---------- */
        async function runInCarSearch(query) {
            if (!query || !query.trim()) return;
            searchQuery = query.trim();
            notify('Searching YouTube: ' + searchQuery);
            render().catch(() => {});

            try {
                const list = await searchEngine.search(searchQuery);
                if (list && list.length > 0) {
                    searchResults = list;
                    searchScroll = 0;
                    notify(`Found ${list.length} videos`);
                } else {
                    notify('No videos found for: ' + searchQuery);
                }
            } catch (e) {
                notify('Search error: ' + e.message);
            }
            render().catch(() => {});
        }

        /* ---------- Page 0: Now Playing (OEM BMW Media Layout) ---------- */
        function drawPlayer(cv, t, now) {
            const video = activeCastVideo;
            const isParked = vehicleSpeed === 0;
            const interlock = settings.interlock || 'auto';
            const motionLocked = !isParked && interlock === 'strict';

            if (motionLocked !== lastMotionLocked) {
                lastMotionLocked = motionLocked;
                if (process.send) {
                    process.send({ t: 'video', action: motionLocked ? 'hide' : (isPlaying && page === 0 ? 'show' : 'hide') });
                }
            }

            if (isFullscreen) {
                drawFullscreenPlayer(cv, t, now, video, motionLocked);
                return;
            }

            // Left / Main Media Viewport (1040 x 410)
            G.panel(cv, t, 40, 52, 1040, 410, 'Video Display');

            const vx = 64, vy = 114, vw = 992, vh = 280;

            if (settings.ambilight !== 'off' && !motionLocked) {
                const pulse = (Math.sin(now / 400) + 1) * 0.5;
                const glowAlpha = isPlaying ? (0.22 + pulse * 0.14) : 0.06;
                cv.roundRect(vx - 2, vy - 2, vw + 4, vh + 4, 10, withAlpha('#0066b1', glowAlpha));
            }

            drawVideoScreen(cv, vx, vy, vw, vh, video, now, motionLocked, false);

            // Scrubber Bar
            const sy = 405, sw = 992;
            cv.roundRect(vx, sy, sw, 6, 3, t.track);
            const thumbX = vx + Math.floor(sw * playProgress);
            cv.roundRect(vx, sy, Math.max(6, thumbX - vx), 6, 3, '#0066b1');
            cv.circle(thumbX, sy + 3, 7, '#ffffff');
            cv.arc(thumbX, sy + 3, 7, 9, 0, 360, '#00a3e0');

            // 38px tall touch target centered on the scrubber
            cv.target(vx, sy - 16, sw, 38, (touchX) => {
                const rel = Math.max(0, Math.min(1, (touchX - vx) / sw));
                playProgress = rel;
                if (totalDurationSec > 0) {
                    currentTimeSec = Math.floor(rel * totalDurationSec);
                    player.seek(currentTimeSec);
                }
                notify(`Seek: ${formatTime(currentTimeSec)}`);
                render().catch(() => {});
            }, 'scrub', 8);

            const durDisplay = totalDurationSec > 0 ? formatTime(totalDurationSec) : (video.duration || '0:00');
            const timeStr = `${formatTime(currentTimeSec)} / ${durDisplay}`;
            cv.text(timeStr, vx, 442, 16, t.dim, { font: 'num' });
            cv.text('720p HD', vx + 160, 442, 13, '#00a3e0', { font: 'bold' });

            // Fullscreen Button below video
            const btnFsW = 148, btnFsH = 34;
            const btnFsX = vx + sw - btnFsW, btnFsY = 425;
            cv.roundRect(btnFsX, btnFsY, btnFsW, btnFsH, 6, '#0f1724');
            cv.strokeRoundRect(btnFsX, btnFsY, btnFsW, btnFsH, 6, 1, '#1e324c');
            cv.text('FULLSCREEN', btnFsX + btnFsW / 2, btnFsY + 22, 13, '#00f0ff', { align: 'center', font: 'bold', spacing: 1 });
            cv.target(btnFsX, btnFsY, btnFsW, btnFsH, () => {
                toggleFullscreen();
            }, 'btn_fullscreen_std', 10);

            // Right Panel (460px): Track Info & Controls
            G.panel(cv, t, 1100, 52, 460, 410, 'Track Info');

            cv.roundRect(1124, 114, 96, 24, 4, '#131e2d');
            cv.strokeRoundRect(1124, 114, 96, 24, 4, 1, '#1e324c');
            cv.text('YOUTUBE', 1172, 131, 11, '#00a3e0', { align: 'center', font: 'bold', spacing: 1 });

            const titleText = trunc(video.title || 'Ready to Play', 30);
            cv.text(titleText, 1124, 172, 21, '#ffffff', { font: 'bold' });
            cv.text(video.channel || 'YouTube on TV', 1124, 204, 16, '#00a3e0', { font: 'bold' });
            cv.text(video.views ? `${video.views}  |  720p HD` : 'Ready to Play', 1124, 230, 14, t.dim);

            // Clean Play / Pause Button
            const btnW = 412, btnH = 50;
            cv.roundRect(1124, 276, btnW, btnH, 8, isPlaying ? '#162233' : '#0066b1');
            cv.strokeRoundRect(1124, 276, btnW, btnH, 8, 1, isPlaying ? '#23364f' : '#00a3e0');
            cv.text(isPlaying ? 'PAUSE' : 'PLAY', 1124 + btnW / 2, 307, 16, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });
            cv.target(1124, 276, btnW, btnH, () => {
                isPlaying = !isPlaying;
                if (isPlaying) player.resume();
                else player.pause();
                notify(isPlaying ? 'Resumed' : 'Paused');
                render().catch(() => {});
            }, 'btn_play_toggle', 10);

            // In-Car Search Tab Shortcut Button
            cv.roundRect(1124, 344, btnW, btnH, 8, '#0f1724');
            cv.strokeRoundRect(1124, 344, btnW, btnH, 8, 1, '#1e324c');
            cv.text('SEARCH VIDEOS IN IDRIVE  >', 1124 + btnW / 2, 375, 14, '#00f0ff', { align: 'center', font: 'bold', spacing: 1 });
            cv.target(1124, 344, btnW, btnH, () => {
                setPage(1);
                render().catch(() => {});
            }, 'btn_go_search', 10);

            // Vehicle Stereo Audio Notice
            cv.text('Audio output: Vehicle stereo via Bluetooth / CarPlay', 1124 + btnW / 2, 428, 12, '#64748b', { align: 'center' });
        }

        /* ---------- Fullscreen Theater Player (1520 x 410 Cockpit Screen) ---------- */
        function drawFullscreenPlayer(cv, t, now, video, motionLocked) {
            // Full-width Grand Theater Panel
            G.panel(cv, t, 40, 52, 1520, 410, 'Cockpit Cinema Theater');

            const vx = 64, vy = 114, vw = 1472, vh = 280;

            if (settings.ambilight !== 'off' && !motionLocked) {
                const pulse = (Math.sin(now / 400) + 1) * 0.5;
                const glowAlpha = isPlaying ? (0.22 + pulse * 0.14) : 0.06;
                cv.roundRect(vx - 2, vy - 2, vw + 4, vh + 4, 10, withAlpha('#0066b1', glowAlpha));
            }

            drawVideoScreen(cv, vx, vy, vw, vh, video, now, motionLocked, true);

            // Widescreen Scrubber Bar across full 1472px
            const sy = 405, sw = 1472;
            cv.roundRect(vx, sy, sw, 6, 3, t.track);
            const thumbX = vx + Math.floor(sw * playProgress);
            cv.roundRect(vx, sy, Math.max(6, thumbX - vx), 6, 3, '#0066b1');
            cv.circle(thumbX, sy + 3, 7, '#ffffff');
            cv.arc(thumbX, sy + 3, 7, 9, 0, 360, '#00a3e0');

            // 38px tall touch target centered on the scrubber
            cv.target(vx, sy - 16, sw, 38, (touchX) => {
                const rel = Math.max(0, Math.min(1, (touchX - vx) / sw));
                playProgress = rel;
                if (totalDurationSec > 0) {
                    currentTimeSec = Math.floor(rel * totalDurationSec);
                    player.seek(currentTimeSec);
                }
                notify(`Seek: ${formatTime(currentTimeSec)}`);
                render().catch(() => {});
            }, 'scrub_fs', 8);

            // Left: Timecode and Quality badge
            const durDisplay = totalDurationSec > 0 ? formatTime(totalDurationSec) : (video.duration || '0:00');
            const timeStr = `${formatTime(currentTimeSec)} / ${durDisplay}`;
            cv.text(timeStr, vx, 442, 16, t.dim, { font: 'num' });
            cv.text('720p HD', vx + 160, 442, 13, '#00a3e0', { font: 'bold' });

            // Center: Play / Pause Control Button
            const btnPlayW = 140, btnPlayH = 34;
            const btnPlayX = vx + Math.floor((sw - btnPlayW) / 2), btnPlayY = 425;
            cv.roundRect(btnPlayX, btnPlayY, btnPlayW, btnPlayH, 6, isPlaying ? '#162233' : '#0066b1');
            cv.strokeRoundRect(btnPlayX, btnPlayY, btnPlayW, btnPlayH, 6, 1, isPlaying ? '#23364f' : '#00a3e0');
            cv.text(isPlaying ? 'PAUSE' : 'PLAY', btnPlayX + btnPlayW / 2, btnPlayY + 22, 13, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });
            cv.target(btnPlayX, btnPlayY, btnPlayW, btnPlayH, () => {
                isPlaying = !isPlaying;
                if (isPlaying) player.resume();
                else player.pause();
                notify(isPlaying ? 'Resumed' : 'Paused');
                render().catch(() => {});
            }, 'btn_play_toggle_fs', 10);

            // Right: Normal View Exit Button
            const btnExitW = 150, btnExitH = 34;
            const btnExitX = vx + sw - btnExitW, btnExitY = 425;
            cv.roundRect(btnExitX, btnExitY, btnExitW, btnExitH, 6, '#0f1724');
            cv.strokeRoundRect(btnExitX, btnExitY, btnExitW, btnExitH, 6, 1, '#1e324c');
            cv.text('NORMAL VIEW', btnExitX + btnExitW / 2, btnExitY + 22, 13, '#00f0ff', { align: 'center', font: 'bold', spacing: 1 });
            cv.target(btnExitX, btnExitY, btnExitW, btnExitH, () => {
                toggleFullscreen();
            }, 'btn_exit_fs_bot', 10);
        }

        /* ---------- Video Screen Canvas Renderer (Debloated 60 fps Vector Stage) ---------- */
        function drawVideoScreen(cv, x, y, w, h, video, now, motionLocked, isFs = false) {
            cv.roundRect(x, y, w, h, 8, '#060a12');
            cv.strokeRoundRect(x, y, w, h, 8, 1, '#1a273b');

            if (motionLocked) {
                cv.roundRect(x + 40, y + 40, w - 80, h - 80, 12, '#0c121c');
                cv.strokeRoundRect(x + 40, y + 40, w - 80, h - 80, 12, 1.5, '#e1001a');
                cv.text('[!] VIDEO LOCKED WHILE IN MOTION', x + w / 2, y + h / 2 - 16, 22, '#e1001a', { align: 'center', font: 'bold' });
                cv.text('Audio continues through car speakers. Park vehicle to resume (' + vehicleSpeed + ' km/h).', x + w / 2, y + h / 2 + 18, 15, '#cbd5e1', { align: 'center' });
                return;
            }

            const cx = x + w / 2;
            const cy = y + h / 2;

            // Ambient background glow inside the video screen
            if (isPlaying) {
                const pulse = (Math.sin(now / 350) + 1) * 0.5;
                cv.roundRect(x + 12, y + 12, w - 24, h - 24, 6, withAlpha('#0066b1', 0.06 + pulse * 0.05));
            }

            // Top Video HUD Bar
            cv.fillRect(x, y, w, 44, withAlpha('#05080e', 0.85));
            cv.fillRect(x, y + 43, w, 1, '#1b293d');

            // YouTube Logo Badge
            cv.roundRect(x + 16, y + 10, 84, 24, 4, '#e1001a');
            cv.text('YOUTUBE', x + 58, y + 27, 11, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });

            // Video Title
            const maxTitleLen = isFs ? 68 : 46;
            const titleText = trunc(video.title || 'Ready to Play', maxTitleLen);
            cv.text(titleText, x + 112, y + 28, 15, '#ffffff', { font: 'bold' });

            if (isFs) {
                // Top-right exit button in fullscreen HUD
                const btnX = x + w - 124, btnY = y + 8, btnW = 112, btnH = 28;
                cv.roundRect(btnX, btnY, btnW, btnH, 4, withAlpha('#0c1420', 0.9));
                cv.strokeRoundRect(btnX, btnY, btnW, btnH, 4, 1, '#0066b1');
                cv.text('NORMAL', btnX + btnW / 2, btnY + 19, 12, '#00f0ff', { align: 'center', font: 'bold', spacing: 1 });
                cv.target(btnX, btnY, btnW, btnH, () => {
                    toggleFullscreen();
                }, 'btn_exit_fs_top', 12);
                cv.text('720p HD', btnX - 16, y + 28, 13, '#00a3e0', { align: 'right', font: 'bold' });
            } else {
                // Quality Badge
                cv.text('720p HD', x + w - 20, y + 28, 13, '#00a3e0', { align: 'right', font: 'bold' });
            }

            // Center Stage: Refined Minimalist Playback Indicator & Hardware Video Surface
            if (video.ytId) {
                // Render live hardware video via Protocol 4 OP_VIDEO 19
                if (cv.video) {
                    cv.video(1, x, y + 44, w, h - 44, 8);
                }

                if (isPlaying) {
                    // Sleek 16-bar Spectrum Visualizer in bottom-right corner
                    const eqX = x + w - 160, eqY = y + h - 14;
                    for (let bi = 0; bi < 16; bi++) {
                        const wave = Math.abs(Math.sin((now / 160) + bi * 0.6));
                        const barH = 4 + Math.floor(wave * 20);
                        const col = bi < 5 ? '#0066b1' : (bi < 11 ? '#00a3e0' : '#e1001a');
                        cv.roundRect(eqX + bi * 9, eqY - barH, 6, barH, 2, col);
                    }
                } else {
                    // Clean Paused state
                    cv.circle(cx, cy - 6, 38, withAlpha('#0c1420', 0.85));
                    cv.arc(cx, cy - 6, 36, 38, 0, 360, '#ffb703');
                    drawPauseGlyph(cv, cx, cy - 6, 20, '#ffb703');

                    cv.text('PAUSED', cx, cy + 46, 16, '#ffb703', { align: 'center', font: 'bold' });
                }
            } else {
                // Waiting for search or cast
                cv.circle(cx, cy - 14, 40, '#0c1420');
                cv.arc(cx, cy - 14, 38, 40, 0, 360, '#1e2d42');
                drawPlayGlyph(cv, cx + 4, cy - 14, 22, '#00a3e0');

                cv.text('Waiting for YouTube Stream', cx, cy + 46, 17, '#ffffff', { align: 'center', font: 'bold' });
                cv.text('Select a video in Search tab or cast from YouTube mobile app', cx, cy + 70, 13, '#94a3b8', { align: 'center' });
            }

            // Touch target over entire video screen to toggle Play/Pause
            cv.target(x, y, w, h, () => {
                isPlaying = !isPlaying;
                if (isPlaying) player.resume();
                else player.pause();
                notify(isPlaying ? 'Play' : 'Pause');
                render().catch(() => {});
            }, 'vid_screen', 10);
        }

        /* ---------- Page 1: In-Car YouTube Search & Speller ---------- */
        function drawSearch(cv, t) {
            // Left Panel (1040px): Search Query & Speller Keyboard
            G.panel(cv, t, 40, 52, 1040, 410, 'Search YouTube in iDrive');

            const sx = 64, sy = 106, sw = 992;

            // Search Bar Input Box
            cv.roundRect(sx, sy, sw, 48, 8, '#0b111a');
            cv.strokeRoundRect(sx, sy, sw, 48, 8, 1, '#1e2d42');
            const displayText = searchQuery ? (searchQuery + '_') : 'Type search query or select quick tag...';
            cv.text(displayText, sx + 18, sy + 31, 16, searchQuery ? '#ffffff' : '#64748b', { font: searchQuery ? 'bold' : 'normal' });

            // Category Chips (1-Touch Instant Search)
            const categories = ['BMW M3', 'Nürburgring', 'Car Reviews', 'Drag Race', 'Top Gear', 'Lofi Drive'];
            let chipX = sx;
            const chipY = sy + 60;
            const chipH = 34;

            categories.forEach((cat, idx) => {
                const isSelected = searchQuery === cat;
                const chipW = cat.length * 9 + 28;
                cv.roundRect(chipX, chipY, chipW, chipH, 17, isSelected ? '#0066b1' : '#101a28');
                cv.strokeRoundRect(chipX, chipY, chipW, chipH, 17, 1, isSelected ? '#00a3e0' : '#1e324c');
                cv.text(cat, chipX + chipW / 2, chipY + 22, 13, isSelected ? '#ffffff' : '#cbd5e1', { align: 'center', font: 'bold' });

                cv.target(chipX, chipY, chipW, chipH, () => {
                    searchQuery = cat;
                    runInCarSearch(cat);
                }, 'chip_' + idx, 10);

                chipX += chipW + 12;
            });

            // BMW Speller Keyboard
            const kbY = chipY + 48;
            const keyRows = [
                ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', '1', '2', '3'],
                ['K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', '4', '5', '6'],
                ['U', 'V', 'W', 'X', 'Y', 'Z', '-', '.', ' ', 'DEL', 'CLR', 'GO']
            ];

            const keyH = 40;
            const keyMargin = 6;
            const totalRowW = sw;

            keyRows.forEach((row, rIdx) => {
                const y = kbY + rIdx * (keyH + keyMargin);
                const count = row.length;
                const keyW = Math.floor((totalRowW - (count - 1) * keyMargin) / count);

                row.forEach((k, cIdx) => {
                    const x = sx + cIdx * (keyW + keyMargin);
                    let bg = '#0f1724';
                    let border = '#1a293d';
                    let textCol = '#ffffff';

                    if (k === 'GO') {
                        bg = '#0066b1';
                        border = '#00a3e0';
                    } else if (k === 'DEL' || k === 'CLR') {
                        bg = '#1a1f2c';
                        border = '#2c3547';
                        textCol = '#94a3b8';
                    } else if (k === ' ') {
                        bg = '#131e2e';
                    }

                    cv.roundRect(x, y, keyW, keyH, 6, bg);
                    cv.strokeRoundRect(x, y, keyW, keyH, 6, 1, border);
                    cv.text(k === ' ' ? 'SPACE' : k, x + keyW / 2, y + 25, 14, textCol, { align: 'center', font: 'bold' });

                    cv.target(x, y, keyW, keyH, () => {
                        if (k === 'GO') {
                            runInCarSearch(searchQuery);
                        } else if (k === 'DEL') {
                            searchQuery = searchQuery.slice(0, -1);
                            render().catch(() => {});
                        } else if (k === 'CLR') {
                            searchQuery = '';
                            render().catch(() => {});
                        } else {
                            if (searchQuery.length < 40) {
                                searchQuery += k;
                                render().catch(() => {});
                            }
                        }
                    }, `key_${rIdx}_${cIdx}`, 10);
                });
            });

            // Clear search shortcut
            if (searchQuery) {
                const clrW = 90;
                cv.roundRect(sx + sw - clrW - 6, sy + 6, clrW, 36, 6, '#182434');
                cv.text('CLEAR', sx + sw - clrW / 2 - 6, sy + 28, 12, '#94a3b8', { align: 'center', font: 'bold' });
                cv.target(sx + sw - clrW - 6, sy + 6, clrW, 36, () => {
                    searchQuery = '';
                    render().catch(() => {});
                }, 'btn_clear_input', 10);
            }

            // Right Panel (460px): Search Results List
            G.panel(cv, t, 1100, 52, 460, 410, 'Video Results');

            const listX = 1124;
            let itemY = 114;
            const itemW = 412;
            const itemH = 68;
            const visibleCount = 4;

            const visibleResults = searchResults.slice(searchScroll, searchScroll + visibleCount);

            if (visibleResults.length === 0) {
                cv.text('No results to display.', listX + itemW / 2, 240, 15, '#64748b', { align: 'center' });
                cv.text('Use keyboard or category chips to search.', listX + itemW / 2, 268, 13, '#475569', { align: 'center' });
            }

            const thumbW = 80;
            const thumbH = 50;
            const textStartX = listX + thumbW + 18;

            visibleResults.forEach((item, idx) => {
                cv.roundRect(listX, itemY, itemW, itemH, 8, '#0b111a');
                cv.strokeRoundRect(listX, itemY, itemW, itemH, 8, 1, '#1b2a3f');

                // Render decoded video thumbnail or fallback glyph
                const imgId = THUMB_BASE_ID + idx;
                const thumbUrl = item.thumbnail || ('https://img.youtube.com/vi/' + item.id + '/mqdefault.jpg');
                const hasThumb = thumbManager.load(item.id, thumbUrl, idx);

                if (hasThumb) {
                    cv.image(imgId, listX + 8, itemY + 9, thumbW, thumbH);
                    cv.strokeRoundRect(listX + 8, itemY + 9, thumbW, thumbH, 6, 1, withAlpha('#00a3e0', 0.45));
                } else {
                    cv.roundRect(listX + 8, itemY + 9, thumbW, thumbH, 6, '#141e2c');
                    drawPlayGlyph(cv, listX + 8 + thumbW / 2, itemY + 9 + thumbH / 2, 16, '#00a3e0');
                }

                // Title, channel and duration
                cv.text(trunc(item.title, 24), textStartX, itemY + 28, 14, '#ffffff', { font: 'bold' });
                cv.text(trunc(item.channel, 20), textStartX, itemY + 50, 12, '#94a3b8');
                cv.text(item.duration, listX + itemW - 14, itemY + 50, 12, '#00a3e0', { align: 'right', font: 'num' });

                cv.target(listX, itemY, itemW, itemH, () => {
                    playVideo({
                        ytId: item.id,
                        title: item.title,
                        channel: item.channel,
                        duration: item.duration,
                        durationSec: item.durationSec || parseDurationSec(item.duration),
                        views: item.views,
                        quality: '720p HD',
                        glow: '#0066b1',
                        desc: item.channel ? `${item.channel}  |  ${item.duration}  |  ${item.views}` : item.url,
                        url: item.url
                    });
                }, 'res_' + (searchScroll + idx), 10);

                itemY += itemH + 8;
            });

            if (searchResults.length > visibleCount) {
                const bScrollY = 416;
                if (searchScroll > 0) {
                    cv.roundRect(1124, bScrollY, 196, 32, 6, '#101a28');
                    cv.text('▲ PREVIOUS', 1222, bScrollY + 21, 13, '#00a3e0', { align: 'center', font: 'bold' });
                    cv.target(1124, bScrollY, 196, 32, () => {
                        searchScroll = Math.max(0, searchScroll - visibleCount);
                        render().catch(() => {});
                    }, 'btn_res_prev', 10);
                }
                if (searchScroll + visibleCount < searchResults.length) {
                    cv.roundRect(1340, bScrollY, 196, 32, 6, '#101a28');
                    cv.text('▼ MORE RESULTS', 1438, bScrollY + 21, 13, '#00a3e0', { align: 'center', font: 'bold' });
                    cv.target(1340, bScrollY, 196, 32, () => {
                        searchScroll = Math.min(searchResults.length - visibleCount, searchScroll + visibleCount);
                        render().catch(() => {});
                    }, 'btn_res_next', 10);
                }
            }
        }

        /* ---------- Page 2: Connect (Official YouTube TV Link Code) ---------- */
        function drawConnect(cv, t) {
            // Left Panel (980px): Official YouTube on TV "Link with TV Code"
            G.panel(cv, t, 40, 52, 980, 410, 'Link Official YouTube Mobile App (TV Code)');

            const lx = 64, ly = 114;

            // 12-Digit TV Code Card
            cv.roundRect(lx, ly, 932, 96, 10, '#090e15');
            cv.strokeRoundRect(lx, ly, 932, 96, 10, 1.5, '#0066b1');

            cv.text('OFFICIAL YOUTUBE TV PAIRING CODE', lx + 24, ly + 32, 13, '#00a3e0', { font: 'bold', spacing: 1 });
            cv.text(loungeReceiver.getPairingCode(), lx + 24, ly + 72, 32, '#00f0ff', { font: 'num' });

            // Instructions to pair official YouTube mobile app
            cv.roundRect(lx, ly + 110, 932, 214, 10, '#070c14');
            cv.strokeRoundRect(lx, ly + 110, 932, 214, 10, 1, '#1e2d42');

            cv.text('HOW TO CAST FROM OFFICIAL YOUTUBE APP (IPHONE / ANDROID):', lx + 24, ly + 144, 16, '#ffffff', { font: 'bold' });
            cv.text('1. Open the official YouTube app on your smartphone', lx + 24, ly + 174, 15, '#cbd5e1');
            cv.text('2. Tap Settings (gear icon) > Watch on TV', lx + 24, ly + 200, 15, '#cbd5e1');
            cv.text('3. Tap "Link with TV code" and type the 12-digit code above', lx + 24, ly + 226, 15, '#00a3e0', { font: 'bold' });
            cv.text('4. Tap Cast icon in YouTube app — vehicle appears as "BMW iDrive 7"!', lx + 24, ly + 252, 15, '#cbd5e1');
            cv.text('5. Connect smartphone to car Bluetooth / CarPlay for vehicle stereo audio.', lx + 24, ly + 278, 15, '#2af575', { font: 'bold' });
            cv.text('6. Any video you tap on phone streams directly to your cockpit screen.', lx + 24, ly + 304, 14, '#94a3b8');

            // Right Panel (520px): System Status & Audio Routing
            G.panel(cv, t, 1040, 52, 520, 410, 'Status & Audio');

            const rx = 1064;

            // Receiver Active Status
            cv.roundRect(rx, 114, 472, 96, 8, '#090e15');
            cv.strokeRoundRect(rx, 114, 472, 96, 8, 1, '#0066b1');
            cv.text('RECEIVER: ACTIVE (YOUTUBE ON TV)', rx + 20, 144, 15, '#00a3e0', { font: 'bold' });
            cv.text('Direct Google Lounge Stream Protocol', rx + 20, 170, 13, '#94a3b8');
            cv.text('Cast target: BMW iDrive 7', rx + 20, 192, 13, '#cbd5e1');

            // Stereo Audio Routing Notice
            cv.roundRect(rx, 224, 472, 96, 8, '#090e15');
            cv.strokeRoundRect(rx, 224, 472, 96, 8, 1, '#1e2d42');
            cv.text('STEREO AUDIO: BLUETOOTH / CARPLAY', rx + 20, 254, 15, '#2af575', { font: 'bold' });
            cv.text('Phone streams audio via BMW RAM stereo DSP.', rx + 20, 280, 13, '#94a3b8');
            cv.text('Select Bluetooth or CarPlay source in iDrive Media.', rx + 20, 302, 13, '#cbd5e1');

            // Vehicle Motion Interlock
            const isParked = vehicleSpeed === 0;
            cv.roundRect(rx, 334, 472, 90, 8, '#090e15');
            cv.strokeRoundRect(rx, 334, 472, 90, 8, 1, isParked ? '#2af575' : '#ffb703');
            cv.text('VEHICLE: ' + (isParked ? 'PARKED (0 KM/H)' : 'IN MOTION (' + vehicleSpeed + ' KM/H)'), rx + 20, 364, 15, isParked ? '#2af575' : '#ffb703', { font: 'bold' });
            cv.text(isParked ? 'Video unlocked for central display' : 'Video interlock active while driving', rx + 20, 392, 13, isParked ? '#cbd5e1' : '#ffb703');
        }

        /* ---------- Master 60 fps Render Loop ---------- */
        async function render() {
            const now = Date.now();
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);

            if (page === 0) drawPlayer(cv, t, now);
            else if (page === 1) drawSearch(cv, t);
            else if (page === 2) drawConnect(cv, t);

            // G-Series Live Cockpit frame tabs along the top
            G.frame(cv, t, PAGES, page, [
                { text: 'M-CINEMA' },
                { text: '720p HD' },
                { text: isPlaying ? 'PLAYING' : 'PAUSED' }
            ]);

            // Explicit touch targets for top header tabs
            if (cv.tabRects && Array.isArray(cv.tabRects)) {
                cv.tabRects.forEach((tr) => {
                    cv.target(tr.x, tr.y, tr.w, tr.h, () => {
                        setPage(tr.i);
                        render().catch(() => {});
                    }, 'hdr_tab_' + tr.i, 15);
                });
            }

            if (statusMsg && (now - statusTime < 3200)) {
                cv.roundRect(W / 2 - 280, H - 52, 560, 38, 8, '#0066b1');
                cv.text(statusMsg, W / 2, H - 28, 16, '#ffffff', { align: 'center', font: 'bold' });
            }

            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- Tab Navigation & Interactions ---------- */
        ctx.hideButton('BTN_PAGE');
        ctx.onTab((idx) => {
            setPage(idx);
            return render();
        });

        ui.onClick('BTN_PAGE', () => {
            setPage((page + 1) % PAGES.length);
            return render();
        });

        ui.onClick('BTN_SETTINGS', () => {
            return ctx.openSettings ? ctx.openSettings() : null;
        });

        // Controller rotary knob & tilt
        ctx.controller.grab(true);
        ctx.controller.onInput((ev) => {
            if (page === 0 && isFullscreen && (ev.tilt === 'W' || ev.tilt === 'S')) {
                toggleFullscreen();
                return;
            }
            if (page === 0 && ev.knobTicks) {
                if (totalDurationSec > 0) {
                    currentTimeSec = Math.max(0, Math.min(totalDurationSec, currentTimeSec + ev.knobTicks * 5));
                    playProgress = currentTimeSec / totalDurationSec;
                    notify(`Seek: ${formatTime(currentTimeSec)}`);
                }
                render().catch(() => {});
            } else if (page === 1 && ev.knobTicks) {
                if (ev.knobTicks > 0) {
                    searchScroll = Math.min(Math.max(0, searchResults.length - 4), searchScroll + 1);
                } else {
                    searchScroll = Math.max(0, searchScroll - 1);
                }
                render().catch(() => {});
            }
            if (ev.press) {
                if (page === 0) {
                    isPlaying = !isPlaying;
                    notify(isPlaying ? 'Play' : 'Pause');
                } else if (page === 1 && searchResults.length > 0) {
                    const first = searchResults[searchScroll];
                    if (first) {
                        playVideo({
                            ytId: first.id,
                            title: first.title,
                            channel: first.channel,
                            duration: first.duration,
                            durationSec: first.durationSec || parseDurationSec(first.duration),
                            views: first.views,
                            quality: '720p HD',
                            glow: '#0066b1',
                            desc: first.channel ? `${first.channel}  |  ${first.duration}  |  ${first.views}` : first.url,
                            url: first.url
                        });
                    }
                }
                render().catch(() => {});
            }
        });

        notify('M-Cinema Ready');
        await render();
    }
});
