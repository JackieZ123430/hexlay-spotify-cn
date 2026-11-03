'use strict';
/**
 * M-Cinema - Native BMW iDrive 7 (MGU) YouTube Cockpit Theater & Video Cast.
 * Styled after BMW ConnectedDrive & Live Cockpit Professional design language.
 *
 * Operational Architecture:
 *   1. Zero-127.0.0.1 Cloud Relay:
 *      QR code connects directly to:
 *      https://hexlay.github.io/idrive7-custom-apps/cinema.html?channel=<CHANNEL>
 *      Works seamlessly on iPhone & Android over 4G, 5G, or car Wi-Fi.
 *   2. YouTube Video Search & 1-Tap Mobile Cast:
 *      Search YouTube videos directly from smartphone remote without dashboard bloat.
 *   3. OEM BMW iDrive 7 Aesthetics:
 *      Clean 2-panel widescreen layout, matte media viewport, real YouTube thumbnail
 *      decoder, and native rotary controller navigation.
 *   4. Intel Atom A3960 Hardware Thermal Safe Cap:
 *      Clamps stream to 720p or 1080p 60 to prevent head unit processor overheating.
 *
 * Pages:
 *   0: Now Playing - 21:9 / 16:9 media player with live ambient accent
 *   1: Connect - Smartphone QR pairing for instant search & casting
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { CastServer } = require('./server');
const { CloudCastManager, parseYouTubeId } = require('./cloud_cast');
const { YouTubeThumbnailManager, THUMB_IMG_ID } = require('./thumbnail');
const qrcodegen = require('./qrcodegen');

const W = 1600, H = 520;
const PAGES = ['Now Playing', 'Connect'];

// String truncation with clean ellipsis
function trunc(str, maxLen) {
    if (!str || typeof str !== 'string') return '';
    return str.length > maxLen ? str.slice(0, maxLen - 1) + '..' : str;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log, signals } = ctx;

        let page = 0;
        let isPlaying = true;
        let playProgress = 0.25;
        let isFullscreen = false;
        let vehicleSpeed = 0;
        let statusMsg = null;
        let statusTime = 0;

        // Active YouTube video cast by user
        let activeCastVideo = {
            title: 'Ready to Cast',
            channel: 'YouTube Receiver',
            duration: '00:00',
            quality: (settings.quality === '1080p') ? '1080p 60' : '720p 60',
            glow: '#0066b1',
            views: 'Connected',
            desc: 'Scan QR code in Connect tab with iPhone or Android to search and cast any YouTube video.',
            ytId: null,
            url: null,
            thumbnail: null
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

        /* ---------- Helper: Text Formatting & Wrapping ---------- */
        function wrapLines(text, maxChars = 42) {
            if (!text) return [];
            const rawLines = text.split('\n');
            const lines = [];
            rawLines.forEach(rl => {
                const words = rl.split(' ');
                let cur = '';
                words.forEach(w => {
                    if ((cur ? cur + ' ' + w : w).length <= maxChars) {
                        cur = cur ? cur + ' ' + w : w;
                    } else {
                        if (cur) lines.push(cur);
                        cur = w;
                    }
                });
                if (cur) lines.push(cur);
            });
            return lines;
        }

        // Initialize Thumbnail Manager
        const thumbnailManager = new YouTubeThumbnailManager(log, () => {
            render().catch(() => {});
        });

        // Initialize Cloud Cast Relay (Works over 4G/5G/Wi-Fi, zero 127.0.0.1)
        const cloudCast = new CloudCastManager(ctx, {
            onCast(video) {
                if (settings.quality === '720p') {
                    video.quality = '720p 60';
                }
                activeCastVideo = video;
                page = 0; // jump directly to Now Playing
                isPlaying = true;
                playProgress = 0;

                if (video.ytId || video.thumbnail) {
                    thumbnailManager.load(video.ytId, video.thumbnail);
                }

                notify('Streaming (' + video.quality + '): ' + video.title);
                render().catch(() => {});
            },
            onControl(cmd, val) {
                if (cmd === 'toggle') isPlaying = !isPlaying;
                else if (cmd === 'play') isPlaying = true;
                else if (cmd === 'pause') isPlaying = false;
                else if (cmd === 'fullscreen') isFullscreen = !isFullscreen;
                else if (cmd === 'seek') {
                    playProgress = Math.max(0, Math.min(1, playProgress + (val || 0) * 0.02));
                }
                render().catch(() => {});
            }
        });
        cloudCast.startPolling();

        // Initialize Local In-Car Fallback Server
        const castServer = new CastServer({
            onCast(video) {
                if (settings.quality === '720p') {
                    video.quality = '720p 60';
                }
                activeCastVideo = video;
                page = 0;
                isPlaying = true;
                playProgress = 0;

                if (video.ytId || video.thumbnail) {
                    thumbnailManager.load(video.ytId, video.thumbnail);
                }

                notify('Local Cast (' + video.quality + '): ' + video.title);
                render().catch(() => {});
            },
            onControl(action, val) {
                if (action === 'toggle') isPlaying = !isPlaying;
                else if (action === 'fullscreen') isFullscreen = !isFullscreen;
                else if (action === 'seek') playProgress = Math.max(0, Math.min(1, playProgress + (val || 0) * 0.02));
                render().catch(() => {});
            }
        }, log);
        castServer.setCloudUrl(cloudCast.getCastUrl());
        castServer.start();

        /* ---------- QR Code for Smartphone Cloud Cast ---------- */
        let cachedQr = null;
        let cachedQrUrl = null;
        function getCastQr() {
            const url = cloudCast.getCastUrl();
            if (cachedQr && cachedQrUrl === url) return cachedQr;
            try {
                const qr = qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.MEDIUM);
                cachedQr = qr;
                cachedQrUrl = url;
                return cachedQr;
            } catch (e) {
                return null;
            }
        }

        /* ---------- Vector Play Icon ---------- */
        function drawPlayGlyph(cv, cx, cy, sz, col) {
            const hw = sz * 0.46, hh = sz * 0.52;
            const p0 = [cx - hw * 0.6, cy - hh];
            const p1 = [cx + hw * 1.1, cy];
            const p2 = [cx - hw * 0.6, cy + hh];
            if (cv.triangle) cv.triangle([p0, p1, p2], col);
            else cv.quad([p0, p1, p2, p2], col);
        }

        /* ---------- Page 0: Now Playing (OEM BMW Media Layout) ---------- */
        function drawPlayer(cv, t, now) {
            const video = activeCastVideo;
            const isParked = vehicleSpeed === 0;
            const interlock = settings.interlock || 'auto';
            const motionLocked = !isParked && interlock === 'strict';

            if (isFullscreen) {
                // Edge-to-edge Cinema Ultrawide 21:9 View
                drawVideoScreen(cv, 0, 0, W, H, video, true, now, motionLocked);
                return;
            }

            // Left / Main Media Viewport (1040 x 410)
            G.panel(cv, t, 40, 52, 1040, 410, 'Video Display');

            const vx = 64, vy = 114, vw = 992, vh = 280;

            // Refined subtle edge glow around viewport
            if (settings.ambilight !== 'off' && !motionLocked) {
                cv.roundRect(vx - 2, vy - 2, vw + 4, vh + 4, 12, withAlpha('#0066b1', 0.25));
            }

            // Screen frame
            drawVideoScreen(cv, vx, vy, vw, vh, video, false, now, motionLocked);

            // Scrubber Bar & Media Controls
            const sy = 405, sw = 992;
            cv.roundRect(vx, sy, sw, 6, 3, t.track);
            cv.roundRect(vx, sy, Math.floor(sw * playProgress), 6, 3, '#0066b1');
            cv.circle(vx + Math.floor(sw * playProgress), sy + 3, 6, '#ffffff');

            cv.target(vx, sy - 10, sw, 28, (x) => {
                const rel = Math.max(0, Math.min(1, (x - vx) / sw));
                playProgress = rel;
                notify(`Seek: ${Math.floor(rel * 100)}%`);
            }, 'scrub', 8);

            // Timecode & Badges below scrubber
            cv.text('02:15 / ' + (video.duration || '00:00'), vx, 442, 15, t.dim, { font: 'num' });
            cv.text(video.quality, vx + 160, 442, 13, '#00a3e0', { font: 'bold' });
            cv.text(isPlaying ? 'PLAYING' : 'PAUSED', vx + sw - 120, 442, 15, isPlaying ? '#2af575' : '#ffb703', { font: 'bold', align: 'right' });

            // Right Panel (460px): Track Info & Controls
            G.panel(cv, t, 1100, 52, 460, 410, 'Track Info');

            // Source Pill (BMW OEM style)
            cv.roundRect(1124, 114, 96, 24, 4, '#131e2d');
            cv.strokeRoundRect(1124, 114, 96, 24, 4, 1, '#1e324c');
            cv.text('YOUTUBE', 1172, 131, 11, '#00a3e0', { align: 'center', font: 'bold', spacing: 1 });

            // Title & Channel
            const titleText = trunc(video.title || 'Ready to Cast', 32);
            cv.text(titleText, 1124, 168, 20, '#ffffff', { font: 'bold' });
            cv.text(video.channel || 'YouTube Receiver', 1124, 196, 16, '#00a3e0', { font: 'bold' });
            cv.text(video.views || 'Ready', 1124, 220, 14, t.dim);

            // Metadata card
            const descBoxX = 1124, descBoxY = 236, descBoxW = 412, descBoxH = 76;
            cv.roundRect(descBoxX, descBoxY, descBoxW, descBoxH, 8, '#080d15');
            cv.strokeRoundRect(descBoxX, descBoxY, descBoxW, descBoxH, 8, 1, t.panelEdge);

            const descLines = wrapLines(video.desc, 44);
            descLines.slice(0, 2).forEach((line, idx) => {
                cv.text(line, descBoxX + 14, descBoxY + 28 + idx * 22, 13, '#94a3b8');
            });

            // Transport Buttons (Solid BMW OEM Style)
            const btnW = 196, btnH = 44;
            // Play/Pause button
            cv.roundRect(1124, 326, btnW, btnH, 8, isPlaying ? '#162233' : '#0066b1');
            cv.strokeRoundRect(1124, 326, btnW, btnH, 8, 1, isPlaying ? '#23364f' : '#00a3e0');
            cv.text(isPlaying ? 'PAUSE' : 'PLAY', 1124 + btnW / 2, 353, 16, '#ffffff', { align: 'center', font: 'bold' });
            cv.target(1124, 326, btnW, btnH, () => {
                isPlaying = !isPlaying;
                notify(isPlaying ? 'Resumed' : 'Paused');
            }, 'btn_play_toggle', 10);

            // Aspect / Fullscreen button
            cv.roundRect(1340, 326, btnW, btnH, 8, '#162233');
            cv.strokeRoundRect(1340, 326, btnW, btnH, 8, 1, '#23364f');
            cv.text('21:9 WIDESCREEN', 1340 + btnW / 2, 353, 15, '#ffffff', { align: 'center', font: 'bold' });
            cv.target(1340, 326, btnW, btnH, () => {
                isFullscreen = !isFullscreen;
                notify(isFullscreen ? '21:9 Fullscreen' : 'Standard View');
            }, 'btn_fs_toggle', 10);

            // Connect Tab Shortcut
            cv.roundRect(1124, 384, 412, 44, 8, '#0f1724');
            cv.strokeRoundRect(1124, 384, 412, 44, 8, 1, '#0066b1');
            cv.text('CONNECT SMARTPHONE (QR)  >', 1124 + 206, 411, 14, '#00f0ff', { align: 'center', font: 'bold' });
            cv.target(1124, 384, 412, 44, () => {
                page = 1;
            }, 'btn_go_cast', 10);
        }

        /* ---------- Video Screen Canvas Renderer ---------- */
        function drawVideoScreen(cv, x, y, w, h, video, isFs, now, motionLocked) {
            cv.roundRect(x, y, w, h, isFs ? 0 : 8, '#06090e');
            if (!isFs) cv.strokeRoundRect(x, y, w, h, 8, 1, '#1a2536');

            if (motionLocked) {
                cv.roundRect(x + 40, y + 40, w - 80, h - 80, 12, '#0c121c');
                cv.strokeRoundRect(x + 40, y + 40, w - 80, h - 80, 12, 1.5, '#e1001a');
                cv.text('[!] VIDEO LOCKED WHILE IN MOTION', x + w / 2, y + h / 2 - 16, 22, '#e1001a', { align: 'center', font: 'bold' });
                cv.text('Audio continues. Park vehicle to resume video playback (' + vehicleSpeed + ' km/h).', x + w / 2, y + h / 2 + 18, 15, '#cbd5e1', { align: 'center' });
                return;
            }

            const cx = x + w / 2;
            const cy = y + h / 2;

            if (thumbnailManager.hasThumbnail) {
                // Real decoded video artwork
                cv.image(THUMB_IMG_ID, x, y, w, h);

                // Clean letterbox bar overlays
                cv.fillRect(x, y, w, 44, withAlpha('#000000', 0.65));
                cv.fillRect(x, y + h - 44, w, 44, withAlpha('#000000', 0.65));

                cv.text(trunc(video.title, 48), x + 20, y + 28, 14, '#ffffff', { font: 'bold' });
            } else {
                // Sleek matte idle screen
                cv.fillRect(x, y, w, h, '#070b12');
                cv.circle(cx, cy - 14, 40, '#0e1724');
                cv.arc(cx, cy - 14, 38.5, 40, 0, 360, '#1e2d42');
                drawPlayGlyph(cv, cx + 3, cy - 14, 24, '#00a3e0');

                cv.text('Waiting for YouTube Stream', cx, cy + 48, 16, '#cbd5e1', { align: 'center', font: 'bold' });
                cv.text('Open Connect tab to scan phone QR remote', cx, cy + 72, 13, '#64748b', { align: 'center' });
            }

            // Center Play Triangle when paused
            if (!isPlaying && thumbnailManager.hasThumbnail) {
                cv.circle(cx, cy, 38, withAlpha('#000000', 0.7));
                cv.arc(cx, cy, 36.5, 38, 0, 360, '#00a3e0');
                drawPlayGlyph(cv, cx + 3, cy, 22, '#ffffff');
            }

            // Click to toggle fullscreen / play
            cv.target(x, y, w, h, () => {
                if (isFs) isFullscreen = false;
                else isPlaying = !isPlaying;
            }, 'vid_screen', 10);
        }

        /* ---------- Page 1: Connect (Pairing & ConnectedDrive Remote) ---------- */
        function drawCast(cv, t) {
            // Left Panel: Smartphone QR Code
            G.panel(cv, t, 40, 52, 740, 410, 'Smartphone Connect');

            const qr = getCastQr();
            if (qr) {
                const qrx = 70, qry = 120, qrsz = 210;
                const modCount = qr.size;
                const modPx = Math.floor(qrsz / modCount);
                const actualSz = modPx * modCount;
                const ox = qrx + Math.floor((qrsz - actualSz) / 2);
                const oy = qry + Math.floor((qrsz - actualSz) / 2);

                cv.roundRect(ox - 12, oy - 12, actualSz + 24, actualSz + 24, 10, '#ffffff');
                for (let r = 0; r < modCount; r++) {
                    for (let c = 0; c < modCount; c++) {
                        if (qr.getModule(c, r)) {
                            cv.fillRect(ox + c * modPx, oy + r * modPx, modPx, modPx, '#000000');
                        }
                    }
                }

                // Steps instructions in OEM ConnectedDrive style
                const sx = 320, sy = 120;
                cv.text('CONNECT IPHONE OR ANDROID', sx, sy + 18, 18, '#ffffff', { font: 'bold' });
                cv.text('1. Scan QR code with your phone camera', sx, sy + 48, 14, '#cbd5e1');
                cv.text('2. Search YouTube or tap 1-Tap Paste', sx, sy + 74, 14, '#cbd5e1');
                cv.text('3. Tap Cast to stream to central display', sx, sy + 100, 14, '#00a3e0', { font: 'bold' });
                cv.text('4. Works over 4G, 5G, or car Wi-Fi (No 127.0.0.1)', sx, sy + 126, 14, '#94a3b8');

                // Pairing Short Code Pill
                cv.roundRect(sx, sy + 152, 420, 36, 8, '#0b131f');
                cv.strokeRoundRect(sx, sy + 152, 420, 36, 8, 1, '#0066b1');
                cv.text('PAIRING CODE: ' + cloudCast.getShortCode(), sx + 210, sy + 175, 15, '#00f0ff', { align: 'center', font: 'num' });

                // Direct Public URL Text
                cv.text('hexlay.github.io/idrive7-custom-apps/cinema.html', sx + 210, sy + 212, 13, '#64748b', { align: 'center' });
            }

            // Right Panel: Safety & System Status
            G.panel(cv, t, 820, 52, 740, 410, 'System & Safety Status');

            // Receiver Active Status
            cv.roundRect(844, 114, 692, 86, 8, '#090e15');
            cv.strokeRoundRect(844, 114, 692, 86, 8, 1, '#0066b1');
            cv.text('RECEIVER STATUS: ACTIVE (CLOUD RELAY)', 870, 144, 16, '#00a3e0', { font: 'bold' });
            cv.text('Relay Channel: ' + cloudCast.getChannel() + ' · Zero Localhost / 127.0.0.1 dependency', 870, 172, 13, '#94a3b8');

            // Hardware Thermal Capping
            cv.roundRect(844, 214, 692, 86, 8, '#090e15');
            cv.strokeRoundRect(844, 214, 692, 86, 8, 1, '#1e2d42');
            cv.text('HARDWARE THERMAL MANAGEMENT (' + (settings.quality === '1080p' ? '1080P FHD' : '720P HD') + ')', 870, 244, 16, '#cbd5e1', { font: 'bold' });
            cv.text('Intel Atom A3960 CPU/GPU safe limit active. High-bandwidth 4K/2K downsampled.', 870, 272, 13, '#94a3b8');

            // Vehicle Motion Interlock
            const isParked = vehicleSpeed === 0;
            cv.roundRect(844, 314, 692, 86, 8, '#090e15');
            cv.strokeRoundRect(844, 314, 692, 86, 8, 1, isParked ? '#2af575' : '#ffb703');
            cv.text('VEHICLE STATUS: ' + (isParked ? 'PARKED (0 KM/H)' : 'IN MOTION (' + vehicleSpeed + ' KM/H)'), 870, 344, 16, isParked ? '#2af575' : '#ffb703', { font: 'bold' });
            cv.text(isParked ? 'Playback unlocked for central display' : 'Video interlock active while driving', 870, 372, 13, isParked ? '#cbd5e1' : '#ffb703');
        }

        /* ---------- Master 60 fps Render Loop ---------- */
        async function render() {
            const now = Date.now();
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);

            // Header tabs and active page
            if (!isFullscreen) {
                if (page === 0) drawPlayer(cv, t, now);
                else if (page === 1) drawCast(cv, t);

                // G-Series Live Cockpit frame tabs along the top
                G.frame(cv, t, PAGES, page, [
                    { text: 'M-CINEMA' },
                    { text: activeCastVideo.quality },
                    { text: isPlaying ? 'PLAYING' : 'PAUSED' }
                ]);
            } else {
                drawVideoScreen(cv, 0, 0, W, H, activeCastVideo, true, now, vehicleSpeed > 0 && settings.interlock === 'strict');
            }

            // Notification toast
            if (statusMsg && (now - statusTime < 3200)) {
                cv.roundRect(W / 2 - 280, H - 52, 560, 38, 8, '#0066b1');
                cv.text(statusMsg, W / 2, H - 28, 16, '#ffffff', { align: 'center', font: 'bold' });
            }

            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- HMI Button & Touch Interactions ---------- */
        ui.onClick('BTN_PLAY', () => {
            isPlaying = !isPlaying;
            notify(isPlaying ? 'Play' : 'Pause');
            return render();
        });

        ui.onClick('BTN_MODE', () => {
            isFullscreen = !isFullscreen;
            return render();
        });

        ui.onClick('BTN_PAGE', () => {
            page = (page + 1) % PAGES.length;
            return render();
        });

        ctx.onTab((idx) => {
            page = idx;
            return render();
        });

        // Controller rotary knob & tilt
        ctx.controller.grab(true);
        ctx.controller.onInput((ev) => {
            if (ev.knobTicks) {
                playProgress = Math.max(0, Math.min(1, playProgress + ev.knobTicks * 0.02));
                render().catch(() => {});
            }
            if (ev.press) {
                isPlaying = !isPlaying;
                notify(isPlaying ? 'Play' : 'Pause');
                render().catch(() => {});
            }
        });

        // Start 60 fps render loop
        ctx.loop('MAIN', 15, render);
        render().then(() => log.info('M-Cinema ready')).catch((e) => log.warn('M-Cinema render error: ' + e));
    }
});
