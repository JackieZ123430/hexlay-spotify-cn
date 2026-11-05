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
 *      clean multi-colored audio spectrum visualizer.
 *   5. Intel Atom A3960 Hardware Thermal Safe Cap:
 *      Clamps streams strictly to 720p 60 HD to protect head unit CPU/GPU.
 *   6. Offline Safeguard:
 *      Verifies active internet connectivity to YouTube; if offline, notifies the user
 *      with high-contrast BMW-styled alert and disables streaming.
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
const { checkInternetConnection } = require('./stream_resolver');
const qrcodegen = require('./qrcodegen');

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
        let hasInternet = true;

        function updateVideoBounds() {
            if (!process.send) return;
            const payload = {
                t: 'video',
                fullscreen: isFullscreen,
                x: isFullscreen ? 0 : 52,
                y: isFullscreen ? 0 : 100,
                w: isFullscreen ? 1600 : 1008,
                h: isFullscreen ? 520 : 340,
                r: isFullscreen ? 0 : 8
            };
            process.send(Object.assign({ action: 'fullscreen' }, payload));
            process.send(Object.assign({ action: 'place' }, payload));
        }

        function toggleFullscreen() {
            isFullscreen = !isFullscreen;
            if (ctx.controller && ctx.controller.grab) {
                ctx.controller.grab(isFullscreen);
            }
            notify(isFullscreen ? 'Cinema Fullscreen' : 'Standard View');
            updateVideoBounds();
            render().catch(() => {});
        }

        // Listen for exit/fullscreen command from emulator exit button or HMI
        process.on('message', (m) => {
            if (!m || typeof m !== 'object') return;
            if (m.t === 'action') {
                if (m.action === 'fullscreen') {
                    isFullscreen = true;
                    if (ctx.controller && ctx.controller.grab) ctx.controller.grab(true);
                    updateVideoBounds();
                    render().catch(() => {});
                } else if (m.action === 'exit-fullscreen') {
                    isFullscreen = false;
                    if (ctx.controller && ctx.controller.grab) ctx.controller.grab(false);
                    updateVideoBounds();
                    render().catch(() => {});
                }
            } else if (m.t === 'video-state') {
                if (typeof m.playing === 'boolean') {
                    isPlaying = m.playing;
                    player.isPlaying = m.playing;
                    render().catch(() => {});
                }
            } else if (m.t === 'video-progress') {
                if (typeof m.time === 'number') {
                    currentTimeSec = Math.floor(m.time);
                }
                if (typeof m.duration === 'number' && m.duration > 0) {
                    totalDurationSec = Math.floor(m.duration);
                }
                if (typeof m.playing === 'boolean') {
                    isPlaying = m.playing;
                    player.isPlaying = m.playing;
                }
                if (totalDurationSec > 0) {
                    playProgress = Math.min(1, Math.max(0, currentTimeSec / totalDurationSec));
                }
                render().catch(() => {});
            }
        });

        // Internet connectivity checking
        checkInternetConnection().then((ok) => {
            hasInternet = ok;
            render().catch(() => {});
        });

        setInterval(() => {
            checkInternetConnection().then((ok) => {
                if (hasInternet !== ok) {
                    hasInternet = ok;
                    if (!hasInternet && isPlaying) {
                        player.pause();
                        isPlaying = false;
                        notify('Internet disconnected');
                    }
                    render().catch(() => {});
                }
            });
        }, 12000);

        // Foreground-Only Lifecycle: Video must NEVER play in background.
        if (ui.onVisible) {
            ui.onVisible((stateName, isVisible) => {
                log.info(`[M-Cinema] Screen '${stateName}' visible: ${isVisible}`);
                if (stateName === 'MAIN' && !isVisible) {
                    log.info('[M-Cinema] App left foreground -> stopping video immediately');
                    isPlaying = false;
                    isFullscreen = false;
                    player.stop();
                    if (process.send) {
                        try { process.send({ t: 'video', action: 'stop' }); } catch (e) {}
                    }
                    render().catch(() => {});
                }
            });
        }

        if (ui.onFocus) {
            ui.onFocus((stateName, hasFocus) => {
                log.info(`[M-Cinema] Screen '${stateName}' focus: ${hasFocus}`);
                if (stateName === 'MAIN' && !hasFocus) {
                    if (isPlaying) {
                        log.info('[M-Cinema] App lost focus -> pausing video');
                        isPlaying = false;
                        player.pause();
                        render().catch(() => {});
                    }
                }
            });
        }

        let cleanedUp = false;
        const appCleanup = () => {
            if (cleanedUp) return;
            cleanedUp = true;
            log.info('[M-Cinema] App terminating -> killing video engine');
            isPlaying = false;
            isFullscreen = false;
            player.stop();
            if (process.send) {
                try { process.send({ t: 'video', action: 'stop' }); } catch (e) {}
            }
        };
        // a SIGTERM/SIGINT listener replaces Node's default exit, so exit after the cleanup
        let exiting = false;
        const exitOnSignal = () => {
            if (exiting) return;
            exiting = true;
            try { appCleanup(); } catch (e) {}
            process.exit(0);
        };
        process.on('exit', appCleanup);
        process.on('SIGTERM', exitOnSignal);
        process.on('SIGINT', exitOnSignal);

        function setPage(idx) {
            page = idx;
            if (page !== 0 && isFullscreen) {
                isFullscreen = false;
            }
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

        player.onEnded = (code) => {
            isPlaying = false;
            notify(code ? 'Playback error' : 'Playback finished');
            render().catch(() => {});
        };

        player.onError = (msg) => {
            isPlaying = false;
            notify(msg);
            render().catch(() => {});
        };

        // In-Car Search State
        let searchQuery = '';
        let searchScroll = 0;
        const searchEngine = new YouTubeSearchEngine(log);
        let searchResults = searchEngine.getFeatured();
        const thumbManager = new ThumbnailManager(log, () => render().catch(() => {}));

        // Active YouTube video (preload featured BMW M3 video)
        const initialFeatured = (searchResults && searchResults[0]) || {};
        let activeCastVideo = {
            title: initialFeatured.title || 'New BMW M3 CS Manual! The Perfect M3? | 4K',
            channel: initialFeatured.channel || 'Top Gear',
            duration: initialFeatured.duration || '14:29',
            durationSec: initialFeatured.durationSec || parseDurationSec(initialFeatured.duration || '14:29'),
            quality: '720p HD',
            glow: '#0066b1',
            views: initialFeatured.views || '699K views',
            desc: initialFeatured.channel ? `${initialFeatured.channel}  |  ${initialFeatured.duration}  |  ${initialFeatured.views}` : (initialFeatured.url || ''),
            ytId: initialFeatured.id || 'AvCt8Ggtupc',
            url: initialFeatured.url || 'https://www.youtube.com/watch?v=AvCt8Ggtupc'
        };
        totalDurationSec = activeCastVideo.durationSec;

        // Monitor vehicle speed for safety (Vehicle2.statusCarSpeed2, re-read every 2 s)
        let parked = null;
        try {
            parked = require('./kit/parked').watch(ctx, log);
        } catch (e) {
            log.warn('[M-Cinema] speed watch unavailable: ' + e.message);
        }

        /**
         * Motion interlock (setting "interlock"):
         *   bypass - never locked
         *   auto   - locked while the car moves (> 3 km/h); VIM can't be detected, so moving = locked
         *   strict - also locked while the speed is unknown on a real car (no valid reading yet)
         */
        function computeMotionLocked() {
            const mode = settings.get('interlock') || 'auto';
            if (mode === 'bypass') return false;
            const kmh = parked ? parked.speed() : null;
            vehicleSpeed = kmh === null ? 0 : Math.round(kmh);
            if (parked && parked.moving()) return true;
            if (mode === 'strict' && kmh === null) {
                const onCar = !parked || !signals.hasNative || signals.hasNative();
                return onCar;
            }
            return false;
        }

        function checkInterlock() {
            const motionLocked = computeMotionLocked();
            if (motionLocked === lastMotionLocked) return motionLocked;
            lastMotionLocked = motionLocked;
            log.info('[M-Cinema] Motion interlock ' + (motionLocked ? 'engaged (' + vehicleSpeed + ' km/h)' : 'released'));
            // actually stop the picture: the native engine is held paused while locked
            player.setLocked(motionLocked);
            isPlaying = player.isPlaying;
            if (process.send) {
                process.send({ t: 'video', action: motionLocked ? 'pause' : (isPlaying ? 'resume' : 'pause') });
                process.send({ t: 'video', action: motionLocked ? 'hide' : (isPlaying && page === 0 ? 'show' : 'hide') });
            }
            render().catch(() => {});
            return motionLocked;
        }
        setInterval(checkInterlock, 500);

        // play/pause from a button, the knob or the touch surface (resume is refused while motion-locked)
        function togglePlayback() {
            if (isPlaying) player.pause();
            else if (!player.resume()) notify('Video locked while in motion');
            isPlaying = player.isPlaying;
        }

        function notify(msg) {
            statusMsg = msg;
            statusTime = Date.now();
        }

        function playVideo(video) {
            if (!hasInternet) {
                notify('No internet connection');
                render().catch(() => {});
                return;
            }

            video.quality = '720p HD';
            video.ytId = video.ytId || video.id || extractYouTubeId(video.url) || null;
            activeCastVideo = video;
            isPlaying = true;
            currentTimeSec = 0;
            totalDurationSec = video.durationSec || parseDurationSec(video.duration);
            playProgress = 0;
            setPage(0);

            if (video.ytId && loungeReceiver && loungeReceiver.isConnected) {
                loungeReceiver.sendPlayVideo(video.ytId);
            }

            const streamUrl = video.streamUrl || video.url || ('https://youtube.com/watch?v=' + (video.ytId || ''));
            const b = isFullscreen ?
                { x: 0, y: 0, w: 1600, h: 520, r: 0, fullscreen: true } :
                { x: 52, y: 100, w: 1008, h: 340, r: 8, fullscreen: false };
            player.play(streamUrl, totalDurationSec, Object.assign({}, video, b));
            isPlaying = player.isPlaying;

            notify('Playing: ' + video.title);
            render().catch(() => {});
        }

        // Initialize Official YouTube on TV Lounge Receiver
        const loungeReceiver = new YouTubeLoungeReceiver({
            onCast(video) {
                playVideo(video);
            },
            onControl(cmd) {
                if (cmd === 'pause') {
                    player.pause();
                } else if (cmd === 'play') {
                    player.resume();
                }
                isPlaying = player.isPlaying;
                render().catch(() => {});
            },
            onVolume(vol) {
                notify(`Cast Volume: ${vol}%`);
                render().catch(() => {});
            },
            log: log
        });

        loungeReceiver.start();

        // In-Car YouTube Search Executor
        async function runInCarSearch(q) {
            notify('Searching YouTube...');
            render().catch(() => {});
            try {
                const results = await searchEngine.search(q);
                if (results && results.length > 0) {
                    searchResults = results;
                    searchScroll = 0;
                    notify(`Found ${results.length} videos`);
                } else {
                    notify('No videos found');
                }
            } catch (err) {
                notify('Search failed');
            }
            render().catch(() => {});
        }

        /* ---------- Helper: Play Glyph ---------- */
        function drawPlayGlyph(cv, cx, cy, sz, col) {
            const hw = Math.floor(sz * 0.7);
            const hh = Math.floor(sz * 0.9);
            const x0 = cx - Math.floor(hw * 0.4);
            const y0 = cy - Math.floor(hh * 0.5);
            for (let i = 0; i <= hw; i++) {
                const frac = i / hw;
                const hLine = Math.floor((1 - frac) * hh);
                if (hLine > 0) {
                    cv.fillRect(x0 + i, cy - Math.floor(hLine / 2), 1, hLine, col);
                }
            }
        }

        /* ---------- Offline Safeguard: No Internet Connection ---------- */
        function drawNoInternet(cv, t) {
            G.panel(cv, t, 32, 44, 1536, 466, 'Network Status: Offline');

            cv.roundRect(48, 100, 1504, 388, 16, '#0f141f');
            cv.strokeRoundRect(48, 100, 1504, 388, 16, 2, '#e1001a');

            cv.circle(148, 250, 48, withAlpha('#e1001a', 0.2));
            cv.text('!', 148, 266, 50, '#e1001a', { align: 'center', font: 'bold' });

            cv.text('NO INTERNET CONNECTION', 228, 195, 28, '#e1001a', { font: 'bold', spacing: 1 });
            cv.text('M-Cinema requires an active internet connection to stream YouTube videos.', 228, 240, 19, '#ffffff');
            cv.text('Please verify that your BMW has cellular data or is connected to a mobile Wi-Fi hotspot.', 228, 276, 17, '#94a3b8');

            const btnW = 280, btnH = 52, btnY = 345, b1X = 228;
            cv.roundRect(b1X, btnY, btnW, btnH, 10, '#004e8c');
            cv.strokeRoundRect(b1X, btnY, btnW, btnH, 10, 1.5, '#00a3e0');
            cv.text('RETRY CONNECTION', b1X + btnW / 2, btnY + 32, 16, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });
            cv.target(b1X, btnY, btnW, btnH, () => {
                notify('Checking connection...');
                checkInternetConnection().then((ok) => {
                    hasInternet = ok;
                    notify(ok ? 'Connected' : 'Still Offline');
                    render().catch(() => {});
                });
            }, 'btn_retry_net', 15);
        }

        /* ---------- Page 0: Now Playing (Full Height Edge-to-Edge) ---------- */
        function drawPlayer(cv, t, now) {
            const video = activeCastVideo || {};
            const motionLocked = lastMotionLocked;

            if (isFullscreen) {
                drawFullscreenPlayer(cv, t, now, video, motionLocked);
                return;
            }

            // Left / Main Media Viewport (spanning y = 44 to 510, eliminates black bars)
            const panelY = 44;
            const panelH = 466;
            G.panel(cv, t, 32, panelY, 1048, panelH);

            const vx = 52, vy = 56, vw = 1008, vh = 384;

            if (settings.get('ambilight') !== 'off' && !motionLocked) {
                const pulse = (Math.sin(now / 400) + 1) * 0.5;
                const glowAlpha = isPlaying ? (0.22 + pulse * 0.14) : 0.06;
                cv.roundRect(vx - 2, vy - 2, vw + 4, vh + 4, 10, withAlpha('#0066b1', glowAlpha));
            }

            drawVideoScreen(cv, vx, vy, vw, vh, video, now, motionLocked, false);

            // Scrubber Bar
            const sy = 452, sw = 1008;
            cv.roundRect(vx, sy, sw, 6, 3, t.track);
            const thumbX = vx + Math.floor(sw * playProgress);
            cv.roundRect(vx, sy, Math.max(6, thumbX - vx), 6, 3, '#0066b1');
            cv.circle(thumbX, sy + 3, 7, '#ffffff');
            cv.arc(thumbX, sy + 3, 7, 9, 0, 360, '#00a3e0');

            // High-precision touch scrubber target across the 1008px scrubber bar
            cv.target(vx, sy - 16, sw, 38, (touchX) => {
                let rel = 0.5;
                if (typeof touchX === 'number' && !isNaN(touchX) && touchX >= vx && touchX <= vx + sw) {
                    rel = Math.max(0, Math.min(1, (touchX - vx) / sw));
                }
                playProgress = rel;
                if (totalDurationSec > 0) {
                    currentTimeSec = Math.floor(rel * totalDurationSec);
                    player.seek(currentTimeSec);
                }
                notify(`Seek: ${formatTime(currentTimeSec)}`);
                render().catch(() => {});
            }, 'seekbar_std', 8);

            const durDisplay = totalDurationSec > 0 ? formatTime(totalDurationSec) : (video.duration || '0:00');
            const timeStr = `${formatTime(currentTimeSec)} / ${durDisplay}`;
            cv.text(timeStr, vx, 486, 16, t.dim, { font: 'num' });
            cv.text('720p HD', vx + 160, 486, 13, '#00a3e0', { font: 'bold' });

            // Fullscreen Button below video
            const btnFsW = 148, btnFsH = 34;
            const btnFsX = vx + sw - btnFsW, btnFsY = 468;
            cv.roundRect(btnFsX, btnFsY, btnFsW, btnFsH, 6, '#0f1724');
            cv.strokeRoundRect(btnFsX, btnFsY, btnFsW, btnFsH, 6, 1, '#1e324c');
            cv.text('FULLSCREEN', btnFsX + btnFsW / 2, btnFsY + 22, 13, '#00f0ff', { align: 'center', font: 'bold', spacing: 1 });
            cv.target(btnFsX, btnFsY, btnFsW, btnFsH, () => {
                toggleFullscreen();
            }, 'btn_fullscreen_std', 10);

            // Right Panel (468px): Track Info & Controls
            G.panel(cv, t, 1100, panelY, 468, panelH, 'Track Info');

            const rx = 1124;
            cv.roundRect(rx, 100, 96, 24, 4, '#131e2d');
            cv.strokeRoundRect(rx, 100, 96, 24, 4, 1, '#1e324c');
            cv.text('YOUTUBE', rx + 48, 117, 11, '#00a3e0', { align: 'center', font: 'bold', spacing: 1 });

            const titleText = trunc(video.title || 'Ready to Play', 30);
            cv.text(titleText, rx, 154, 21, '#ffffff', { font: 'bold' });
            cv.text(video.channel || 'YouTube on TV', rx, 186, 16, '#00a3e0', { font: 'bold' });
            cv.text(video.views || 'Ready to Play', rx, 212, 14, t.dim);

            // Clean Play / Pause Button
            const btnW = 420, btnH = 52;
            const btnPlayY = 248;
            cv.roundRect(rx, btnPlayY, btnW, btnH, 8, isPlaying ? '#162233' : '#0066b1');
            cv.strokeRoundRect(rx, btnPlayY, btnW, btnH, 8, 1, isPlaying ? '#23364f' : '#00a3e0');
            cv.text(isPlaying ? 'PAUSE' : 'PLAY', rx + btnW / 2, btnPlayY + 32, 16, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });
            cv.target(rx, btnPlayY, btnW, btnH, () => {
                if (!isPlaying && !player.isPlaying && activeCastVideo) {
                    playVideo(activeCastVideo);
                } else {
                    togglePlayback();
                    render().catch(() => {});
                }
            }, 'btn_play_toggle', 10);

            // In-Car Search Tab Shortcut Button
            const btnSearchY = 314;
            cv.roundRect(rx, btnSearchY, btnW, 50, 8, '#0f1724');
            cv.strokeRoundRect(rx, btnSearchY, btnW, 50, 8, 1, '#1e324c');
            cv.text('SEARCH VIDEOS IN IDRIVE  >', rx + btnW / 2, btnSearchY + 31, 14, '#00f0ff', { align: 'center', font: 'bold', spacing: 1 });
            cv.target(rx, btnSearchY, btnW, 50, () => {
                setPage(1);
                render().catch(() => {});
            }, 'btn_go_search', 10);

            // Live Spectrum Visualizer (animated in right panel)
            if (isPlaying) {
                const eqX = rx + 16, eqY = 434;
                for (let bi = 0; bi < 24; bi++) {
                    const wave = Math.abs(Math.sin((now / 150) + bi * 0.45));
                    const barH = 4 + Math.floor(wave * 28);
                    const col = bi < 8 ? '#0066b1' : (bi < 16 ? '#00a3e0' : '#e1001a');
                    cv.roundRect(eqX + bi * 16, eqY - barH, 10, barH, 2, col);
                }
            }

            // Vehicle Stereo Audio Notice
            cv.text('Audio output: Vehicle stereo via Bluetooth / CarPlay', rx + btnW / 2, 482, 12, '#64748b', { align: 'center' });
        }

        /* ---------- Fullscreen Cinema Theater (Real Ultrawide Edge-to-Edge) ---------- */
        function drawFullscreenPlayer(cv, t, now, video, motionLocked) {
            cv.clear('#000000');

            if (motionLocked) {
                cv.roundRect(W / 2 - 400, H / 2 - 80, 800, 160, 14, '#0c121c');
                cv.strokeRoundRect(W / 2 - 400, H / 2 - 80, 800, 160, 14, 2, '#e1001a');
                cv.text('[!] VIDEO LOCKED WHILE IN MOTION', W / 2, H / 2 - 20, 24, '#e1001a', { align: 'center', font: 'bold' });
                cv.text('Audio continues through car speakers. Park vehicle to resume (' + vehicleSpeed + ' km/h).', W / 2, H / 2 + 22, 16, '#cbd5e1', { align: 'center' });
                return;
            }

            // Hardware live video surface edge-to-edge (Protocol 4 OP_VIDEO 19)
            if (video && video.ytId && cv.video) {
                cv.video(1, 0, 0, W, H, 0);
            }
            drawBuffering(cv, W / 2, H / 2);

            // Floating Normal View Exit Button in top-right corner
            const btnExitW = 160, btnExitH = 42;
            const btnExitX = W - btnExitW - 28, btnExitY = 24;
            cv.roundRect(btnExitX, btnExitY, btnExitW, btnExitH, 8, withAlpha('#0c1420', 0.9));
            cv.strokeRoundRect(btnExitX, btnExitY, btnExitW, btnExitH, 8, 1.5, '#00a3e0');
            cv.text('NORMAL VIEW', btnExitX + btnExitW / 2, btnExitY + 27, 15, '#00f0ff', { align: 'center', font: 'bold', spacing: 1 });
            cv.target(btnExitX, btnExitY, btnExitW, btnExitH, () => {
                toggleFullscreen();
            }, 'btn_exit_fs_bot', 15);

            // Floating Play/Pause Button in top-right HUD
            const btnPlayW = 130, btnPlayH = 42;
            const btnPlayX = btnExitX - btnPlayW - 14, btnPlayY = 24;
            cv.roundRect(btnPlayX, btnPlayY, btnPlayW, btnPlayH, 8, withAlpha('#0c1420', 0.9));
            cv.strokeRoundRect(btnPlayX, btnPlayY, btnPlayW, btnPlayH, 8, 1.5, isPlaying ? '#00a3e0' : '#2af575');
            cv.text(isPlaying ? 'PAUSE' : 'PLAY', btnPlayX + btnPlayW / 2, btnPlayY + 27, 15, isPlaying ? '#00f0ff' : '#2af575', { align: 'center', font: 'bold', spacing: 1 });
            cv.target(btnPlayX, btnPlayY, btnPlayW, btnPlayH, () => {
                togglePlayback();
                render().catch(() => {});
            }, 'btn_play_toggle_fs', 15);

            // Fullscreen Cinema Bottom Scrubber Bar & Time HUD
            const fsX = 48, fsW = W - 96;
            const fsY = H - 54;
            const durDisplay = totalDurationSec > 0 ? formatTime(totalDurationSec) : (video.duration || '0:00');
            const timeStr = `${formatTime(currentTimeSec)} / ${durDisplay}`;

            cv.roundRect(fsX - 12, fsY - 14, fsW + 24, 48, 10, withAlpha('#04070d', 0.82));
            cv.strokeRoundRect(fsX - 12, fsY - 14, fsW + 24, 48, 10, 1, '#1b2a3f');

            cv.text(timeStr, fsX, fsY + 12, 14, '#ffffff', { font: 'num' });
            cv.text('720p HD', fsX + 170, fsY + 12, 11, '#00a3e0', { font: 'bold' });

            // Spectrum Visualizer inside the HUD pill
            if (isPlaying) {
                const eqX = fsX + fsW - 152, eqY = fsY + 14;
                for (let bi = 0; bi < 16; bi++) {
                    const wave = Math.abs(Math.sin((now / 160) + bi * 0.6));
                    const barH = 3 + Math.floor(wave * 14);
                    const col = bi < 5 ? '#0066b1' : (bi < 11 ? '#00a3e0' : '#e1001a');
                    cv.roundRect(eqX + bi * 9, eqY - barH, 6, barH, 2, col);
                }
            }

            // Scrubber Track
            const fsSy = fsY + 24;
            cv.roundRect(fsX, fsSy, fsW, 6, 3, '#1e293b');
            const fsThumbX = fsX + Math.floor(fsW * playProgress);
            cv.roundRect(fsX, fsSy, Math.max(6, fsThumbX - fsX), 6, 3, '#0066b1');
            cv.circle(fsThumbX, fsSy + 3, 7, '#ffffff');
            cv.arc(fsThumbX, fsSy + 3, 7, 9, 0, 360, '#00a3e0');

            cv.target(fsX, fsSy - 20, fsW, 40, (touchX) => {
                let rel = 0.5;
                if (typeof touchX === 'number' && !isNaN(touchX) && touchX >= fsX && touchX <= fsX + fsW) {
                    rel = Math.max(0, Math.min(1, (touchX - fsX) / fsW));
                }
                playProgress = rel;
                if (totalDurationSec > 0) {
                    currentTimeSec = Math.floor(rel * totalDurationSec);
                    player.seek(currentTimeSec);
                }
                notify(`Seek: ${formatTime(currentTimeSec)}`);
                render().catch(() => {});
            }, 'seekbar_fs', 16);
        }

        /* ---------- Buffering progress (the stream downloads fully before playback) ---------- */
        function drawBuffering(cv, cx, cy) {
            const b = player.buffering;
            if (!b) return;
            const bw = 420, bh = 70;
            cv.roundRect(cx - bw / 2, cy - bh / 2, bw, bh, 10, withAlpha('#05080e', 0.9));
            cv.strokeRoundRect(cx - bw / 2, cy - bh / 2, bw, bh, 10, 1, '#1e324c');
            const frac = b.total > 0 ? Math.min(1, b.bytes / b.total) : 0;
            const label = b.total > 0 ?
                `Buffering ${Math.floor(frac * 100)}%  (${(b.bytes / 1048576).toFixed(1)} / ${(b.total / 1048576).toFixed(1)} MB)` :
                (b.bytes > 0 ? `Buffering ${(b.bytes / 1048576).toFixed(1)} MB` : 'Preparing stream...');
            cv.text(label, cx, cy - 6, 15, '#ffffff', { align: 'center', font: 'bold' });
            cv.roundRect(cx - bw / 2 + 24, cy + 14, bw - 48, 6, 3, '#1e293b');
            cv.roundRect(cx - bw / 2 + 24, cy + 14, Math.max(6, Math.floor((bw - 48) * frac)), 6, 3, '#00a3e0');
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
                const btnX = x + w - 124, btnY = y + 8, btnW = 112, btnH = 28;
                cv.roundRect(btnX, btnY, btnW, btnH, 4, withAlpha('#0c1420', 0.9));
                cv.strokeRoundRect(btnX, btnY, btnW, btnH, 4, 1, '#0066b1');
                cv.text('NORMAL', btnX + btnW / 2, btnY + 19, 12, '#00f0ff', { align: 'center', font: 'bold', spacing: 1 });
                cv.target(btnX, btnY, btnW, btnH, () => {
                    toggleFullscreen();
                }, 'btn_exit_fs_top', 12);
            }

            // Hardware live video surface (Protocol 4 OP_VIDEO 19)
            if (video.ytId) {
                if (cv.video) {
                    cv.video(1, x, y + 44, w, h - 44, 8);
                }
                drawBuffering(cv, cx, cy + 22);

                if (isPlaying) {
                    const eqX = x + w - 160, eqY = y + h - 14;
                    for (let bi = 0; bi < 16; bi++) {
                        const wave = Math.abs(Math.sin((now / 160) + bi * 0.6));
                        const barH = 4 + Math.floor(wave * 20);
                        const col = bi < 5 ? '#0066b1' : (bi < 11 ? '#00a3e0' : '#e1001a');
                        cv.roundRect(eqX + bi * 9, eqY - barH, 6, barH, 2, col);
                    }
                }
            } else {
                cv.circle(cx, cy - 14, 40, '#0c1420');
                cv.arc(cx, cy - 14, 38, 40, 0, 360, '#1e2d42');
                drawPlayGlyph(cv, cx + 4, cy - 14, 22, '#00a3e0');

                cv.text('Waiting for YouTube Stream', cx, cy + 46, 17, '#ffffff', { align: 'center', font: 'bold' });
                cv.text('Select a video in Search tab or cast from YouTube mobile app', cx, cy + 70, 13, '#94a3b8', { align: 'center' });
            }

            cv.target(x, y, w, h, () => {
                if (!isPlaying && !player.isPlaying && activeCastVideo) {
                    playVideo(activeCastVideo);
                } else {
                    togglePlayback();
                    render().catch(() => {});
                }
            }, 'vid_screen', 10);
        }

        /* ---------- Page 1: In-Car YouTube Search & Speller ---------- */
        function drawSearch(cv, t) {
            // Left Panel (1048px): Search Query & Speller Keyboard
            G.panel(cv, t, 32, 44, 1048, 466, 'Search YouTube in iDrive');

            const sx = 56, sy = 98, sw = 1000;

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
            const kbY = chipY + 50;
            const keyRows = [
                ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', '1', '2', '3'],
                ['K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', '4', '5', '6'],
                ['U', 'V', 'W', 'X', 'Y', 'Z', '-', '.', ' ', 'DEL', 'CLR', 'GO']
            ];

            const keyH = 46;
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
                    cv.text(k === ' ' ? 'SPACE' : k, x + keyW / 2, y + 28, 14, textCol, { align: 'center', font: 'bold' });

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

            // Right Panel (468px): Search Results List
            G.panel(cv, t, 1100, 44, 468, 466, 'Video Results');

            const listX = 1124;
            const itemW = 420;
            const itemH = 72;
            const visibleCount = 4;

            const visibleResults = searchResults.slice(searchScroll, searchScroll + visibleCount);

            if (visibleResults.length === 0) {
                cv.text('No results to display.', listX + itemW / 2, 240, 15, '#64748b', { align: 'center' });
                cv.text('Use keyboard or category chips to search.', listX + itemW / 2, 268, 13, '#475569', { align: 'center' });
            }

            const thumbW = 84;
            const thumbH = 54;
            const textStartX = listX + thumbW + 16;

            visibleResults.forEach((item, idx) => {
                const itemY = 104 + idx * 82;
                cv.roundRect(listX, itemY, itemW, itemH, 8, '#0b111a');
                cv.strokeRoundRect(listX, itemY, itemW, itemH, 8, 1, '#1b2a3f');

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

                cv.text(trunc(item.title, 24), textStartX, itemY + 28, 14, '#ffffff', { font: 'bold' });
                cv.text(trunc(item.channel, 20), textStartX, itemY + 52, 12, '#94a3b8');
                cv.text(item.duration, listX + itemW - 14, itemY + 52, 12, '#00a3e0', { align: 'right', font: 'num' });

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
            });

            // Pagination Controls at bottom of Results Panel
            if (searchResults.length > visibleCount) {
                const btnNavW = 196, btnNavH = 38, navY = 444;
                if (searchScroll > 0) {
                    cv.roundRect(listX, navY, btnNavW, btnNavH, 6, '#0f1724');
                    cv.strokeRoundRect(listX, navY, btnNavW, btnNavH, 6, 1, '#1e324c');
                    cv.text('< PREV', listX + btnNavW / 2, navY + 24, 13, '#00f0ff', { align: 'center', font: 'bold' });
                    cv.target(listX, navY, btnNavW, btnNavH, () => {
                        searchScroll = Math.max(0, searchScroll - visibleCount);
                        render().catch(() => {});
                    }, 'btn_res_prev', 10);
                }

                if (searchScroll + visibleCount < searchResults.length) {
                    const nextX = listX + itemW - btnNavW;
                    cv.roundRect(nextX, navY, btnNavW, btnNavH, 6, '#0f1724');
                    cv.strokeRoundRect(nextX, navY, btnNavW, btnNavH, 6, 1, '#1e324c');
                    cv.text('NEXT >', nextX + btnNavW / 2, navY + 24, 13, '#00f0ff', { align: 'center', font: 'bold' });
                    cv.target(nextX, navY, btnNavW, btnNavH, () => {
                        searchScroll = Math.min(searchResults.length - visibleCount, searchScroll + visibleCount);
                        render().catch(() => {});
                    }, 'btn_res_next', 10);
                }
            }
        }

        /* ---------- Page 2: Connect (Official YouTube TV Link Code) ---------- */
        function drawConnect(cv, t) {
            // Left Panel: Official YouTube on TV "Link with TV Code"
            G.panel(cv, t, 32, 44, 988, 466, 'Link Official YouTube Mobile App (TV Code)');

            const lx = 56, ly = 104;

            // 12-Digit TV Code Card
            cv.roundRect(lx, ly, 940, 96, 10, '#090e15');
            cv.strokeRoundRect(lx, ly, 940, 96, 10, 1.5, '#0066b1');

            cv.text('OFFICIAL YOUTUBE TV PAIRING CODE', lx + 24, ly + 32, 13, '#00a3e0', { font: 'bold', spacing: 1 });
            cv.text(loungeReceiver.getPairingCode(), lx + 24, ly + 72, 32, '#00f0ff', { font: 'num' });

            // Instructions to pair official YouTube mobile app
            cv.roundRect(lx, ly + 112, 940, 268, 10, '#070c14');
            cv.strokeRoundRect(lx, ly + 112, 940, 268, 10, 1, '#1e2d42');

            cv.text('HOW TO CAST FROM OFFICIAL YOUTUBE APP (IPHONE / ANDROID):', lx + 24, ly + 148, 16, '#ffffff', { font: 'bold' });
            cv.text('1. Open official YouTube app on your smartphone (or scan QR)', lx + 24, ly + 180, 15, '#cbd5e1');
            cv.text('2. Tap Settings (gear icon) > Watch on TV', lx + 24, ly + 210, 15, '#cbd5e1');
            cv.text('3. Tap "Link with TV code" and type the 12-digit code above', lx + 24, ly + 240, 15, '#00a3e0', { font: 'bold' });
            cv.text('4. Tap Cast icon in YouTube app — vehicle appears as "BMW iDrive 7"!', lx + 24, ly + 270, 15, '#cbd5e1');
            cv.text('5. Connect smartphone to car Bluetooth / CarPlay for stereo audio.', lx + 24, ly + 300, 15, '#2af575', { font: 'bold' });
            cv.text('6. Any video you tap on phone streams directly to your cockpit screen.', lx + 24, ly + 330, 14, '#94a3b8');

            // Official YouTube Link QR Code (youtube.com/pair)
            try {
                const qr = qrcodegen.QrCode.encodeText('https://www.youtube.com/pair', qrcodegen.QrCode.Ecc.MEDIUM);
                const qrx = lx + 740, qry = ly + 130, qrsz = 160;
                const modCount = qr.size;
                const modPx = Math.floor(qrsz / modCount);
                const actualSz = modPx * modCount;
                const ox = qrx + Math.floor((qrsz - actualSz) / 2);
                const oy = qry + Math.floor((qrsz - actualSz) / 2);

                cv.roundRect(ox - 8, oy - 8, actualSz + 16, actualSz + 16, 8, '#ffffff');
                for (let r = 0; r < modCount; r++) {
                    for (let c = 0; c < modCount; c++) {
                        if (qr.getModule(c, r)) {
                            cv.fillRect(ox + c * modPx, oy + r * modPx, modPx, modPx, '#000000');
                        }
                    }
                }
                cv.text('SCAN TO LINK APP', qrx + qrsz / 2, qry + qrsz + 20, 11, '#00f0ff', { align: 'center', font: 'bold' });
            } catch (e) {}

            // Right Panel (528px): System Status & Audio Routing
            G.panel(cv, t, 1040, 44, 528, 466, 'Status & Audio');

            const rx = 1064;

            // Receiver Active Status
            cv.roundRect(rx, 104, 480, 110, 8, '#090e15');
            cv.strokeRoundRect(rx, 104, 480, 110, 8, 1, '#0066b1');
            cv.text('RECEIVER: ACTIVE (YOUTUBE ON TV)', rx + 20, 136, 15, '#00a3e0', { font: 'bold' });
            cv.text('Direct Google Lounge Stream Protocol', rx + 20, 164, 13, '#94a3b8');
            cv.text('Cast target: BMW iDrive 7', rx + 20, 188, 13, '#cbd5e1');

            // Stereo Audio Routing Notice
            cv.roundRect(rx, 230, 480, 110, 8, '#090e15');
            cv.strokeRoundRect(rx, 230, 480, 110, 8, 1, '#1e2d42');
            cv.text('STEREO AUDIO: BLUETOOTH / CARPLAY', rx + 20, 262, 15, '#2af575', { font: 'bold' });
            cv.text('Phone streams audio via BMW RAM stereo DSP.', rx + 20, 290, 13, '#94a3b8');
            cv.text('Select Bluetooth or CarPlay source in iDrive Media.', rx + 20, 314, 13, '#cbd5e1');
        }

        /* ---------- Main Application Render Pipeline ---------- */
        async function render() {
            const t = ctx.theme();
            const cv = (ctx.canvas ? ctx.canvas(W, H) : ui.canvas()).clear(t.bg);
            const now = Date.now();

            if (!hasInternet) {
                drawNoInternet(cv, t);
                G.frame(cv, t, PAGES, page, []);
                await ui.image('MAIN_GFX', cv);
                return;
            }

            if (page === 0) {
                if (isFullscreen) {
                    drawFullscreenPlayer(cv, t, now, activeCastVideo, lastMotionLocked);
                    await ui.image('MAIN_GFX', cv);
                    return;
                }
                drawPlayer(cv, t, now);
            }
            else if (page === 1) drawSearch(cv, t);
            else if (page === 2) drawConnect(cv, t);

            // G-Series Live Cockpit frame tabs along the top
            G.frame(cv, t, PAGES, page, []);

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

        // Controller rotary knob & tilt (exclusive grab only in Fullscreen Cinema Mode)
        ctx.controller.grab(false);
        ctx.controller.onInput((ev) => {
            if (!ev) return false;
            if (isFullscreen) {
                if (ev.tilt === 'W' || ev.tilt === 'S') {
                    toggleFullscreen();
                    return true;
                }
                if (ev.knobTicks) {
                    if (totalDurationSec > 0) {
                        currentTimeSec = Math.max(0, Math.min(totalDurationSec, currentTimeSec + ev.knobTicks * 5));
                        playProgress = currentTimeSec / totalDurationSec;
                        player.seek(currentTimeSec);
                        notify(`Seek: ${formatTime(currentTimeSec)}`);
                    }
                    render().catch(() => {});
                    return true;
                }
                if (ev.press) {
                    togglePlayback();
                    render().catch(() => {});
                    return true;
                }
                return true;
            }
            if (page === 1) {
                if (ev.knobTicks) {
                    if (ev.knobTicks > 0) {
                        searchScroll = Math.min(Math.max(0, searchResults.length - 4), searchScroll + 1);
                    } else {
                        searchScroll = Math.max(0, searchScroll - 1);
                    }
                    render().catch(() => {});
                    return true;
                }
                if (ev.press && searchResults.length > 0) {
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
                    render().catch(() => {});
                    return true;
                }
            }
            return false;
        });

        // Start 15 fps / tick-driven render loop (same as Spotify, QuickCode, Copilot)
        ctx.loop('MAIN', 15, render);
        await render();
        log.info('M-Cinema ready');
    }
});
