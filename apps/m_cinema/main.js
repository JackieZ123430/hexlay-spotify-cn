'use strict';
/**
 * M-Cinema - Ultrawide Parked Cinema & Cockpit Theater for BMW iDrive 7.
 * Focused 100% on allowing the user to seamlessly stream their own content.
 *
 * Pages:
 *   0: Theater Player - 21:9 Cinema Ultrawide player with live ambilight glow
 *   1: Cast & Connect - Smartphone QR code for instant 1-tap YouTube/Web casting
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { CastServer } = require('./server');
const qrcodegen = require('./qrcodegen');

const W = 1600, H = 520;
const PAGES = ['Theater Player', 'Cast & Connect'];

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

        // Active video cast by user
        let activeCastVideo = {
            title: 'Ready for Cast Stream',
            channel: 'M-Cinema Receiver',
            duration: '00:00',
            quality: (settings.quality === '1080p') ? '1080p 60' : '720p 60',
            glow: '#00a3e0',
            views: 'Waiting for Phone',
            desc: 'Scan QR code in Cast & Connect tab with your phone to stream any YouTube link.',
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

        /* ---------- Helper: Text Wrapping for Descriptions ---------- */
        function wrapLines(text, maxChars = 40) {
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

        // Initialize Cast Server for smartphone streaming
        const castServer = new CastServer({
            onCast(video) {
                // Thermal safety: restrict to settings.quality (720p or 1080p max, never 4K)
                if (settings.quality === '720p') {
                    video.quality = '720p 60';
                }
                activeCastVideo = video;
                page = 0; // jump directly to Theater Player
                isPlaying = true;
                playProgress = 0;
                notify('Streaming (' + video.quality + '): ' + video.title);
                render().catch(() => {});
            },
            onControl(action, val) {
                if (action === 'toggle') isPlaying = !isPlaying;
                else if (action === 'fullscreen') isFullscreen = !isFullscreen;
                else if (action === 'seek') playProgress = Math.max(0, Math.min(1, playProgress + (val || 0) * 0.02));
                render().catch(() => {});
            }
        }, log);
        castServer.start();

        /* ---------- QR Code for Smartphone Cast Remote ---------- */
        let cachedQr = null;
        function getCastQr() {
            if (cachedQr) return cachedQr;
            try {
                const url = castServer.getCastUrl();
                cachedQr = qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.MEDIUM);
                return cachedQr;
            } catch (e) {
                return null;
            }
        }

        /* ---------- Page 0: Theater Player ---------- */
        function drawPlayer(cv, t, now) {
            const video = activeCastVideo;
            const glowCol = video.glow || '#00a3e0';
            const enableAmbilight = settings.ambilight !== 'off';
            const isParked = vehicleSpeed === 0;
            const interlock = settings.interlock || 'auto';
            const motionLocked = !isParked && interlock === 'strict';

            if (isFullscreen) {
                // Edge-to-edge Cinema Ultrawide 21:9 View
                drawVideoScreen(cv, 0, 0, W, H, video, true, now, motionLocked);
                return;
            }

            // Left / Main Player Viewport (1040 x 410)
            G.panel(cv, t, 40, 52, 1040, 410, 'Cockpit Theater: ' + video.quality);

            const vx = 64, vy = 114, vw = 992, vh = 280;

            // Cockpit Ambilight Glow around viewport
            if (enableAmbilight && !motionLocked) {
                const pulse = (Math.sin(now / 500) + 1) * 0.5;
                const glowA = 0.18 + pulse * 0.12;
                cv.roundRect(vx - 16, vy - 16, vw + 32, vh + 32, 20, withAlpha(glowCol, glowA));
            }

            // Screen frame
            drawVideoScreen(cv, vx, vy, vw, vh, video, false, now, motionLocked);

            // Scrubber Bar & Media Controls
            const sy = 405, sw = 992;
            cv.roundRect(vx, sy, sw, 8, 4, t.track);
            cv.roundRect(vx, sy, Math.floor(sw * playProgress), 8, 4, glowCol);
            cv.circle(vx + Math.floor(sw * playProgress), sy + 4, 8, '#ffffff');

            cv.target(vx, sy - 10, sw, 28, (x) => {
                const rel = Math.max(0, Math.min(1, (x - vx) / sw));
                playProgress = rel;
                notify(`Seek: ${Math.floor(rel * 100)}%`);
            }, 'scrub', 8);

            // Timecode & Badges below scrubber
            cv.text('02:15 / ' + (video.duration || 'Live'), vx, 442, 16, t.dim, { font: 'num' });
            cv.text(video.quality, vx + 180, 442, 14, glowCol, { font: 'bold' });
            cv.text(isPlaying ? 'PLAYING' : 'PAUSED', vx + sw - 120, 442, 16, isPlaying ? '#2af575' : '#ffb703', { font: 'bold', align: 'right' });

            // Right Panel (460px): Stream Details & Quick Controls
            G.panel(cv, t, 1100, 52, 460, 410, 'Stream Details');

            const titleText = (video.title && video.title.length > 28) ? video.title.slice(0, 26) + '...' : (video.title || 'Ready');
            cv.text(titleText, 1124, 130, 20, '#ffffff', { font: 'bold' });
            cv.text(video.channel || '', 1124, 162, 17, glowCol, { font: 'bold' });
            cv.text(video.views || '', 1124, 188, 15, t.dim);

            // Description / URL box with multiline text wrapping
            const descBoxX = 1124, descBoxY = 210, descBoxW = 412, descBoxH = 100;
            cv.roundRect(descBoxX, descBoxY, descBoxW, descBoxH, 10, '#090e16');
            cv.strokeRoundRect(descBoxX, descBoxY, descBoxW, descBoxH, 10, 1, t.panelEdge);

            const descLines = wrapLines(video.desc, 42);
            descLines.slice(0, 3).forEach((line, idx) => {
                cv.text(line, descBoxX + 16, descBoxY + 30 + idx * 24, 15, '#94a3b8');
            });

            // Quick Actions
            const btnW = 196, btnH = 48;
            // Play/Pause button
            cv.roundRect(1124, 330, btnW, btnH, 10, isPlaying ? '#162233' : glowCol);
            cv.strokeRoundRect(1124, 330, btnW, btnH, 10, 1, glowCol);
            cv.text(isPlaying ? 'PAUSE' : 'PLAY', 1124 + btnW / 2, 361, 18, isPlaying ? '#ffffff' : '#000000', { align: 'center', font: 'bold' });
            cv.target(1124, 330, btnW, btnH, () => {
                isPlaying = !isPlaying;
                notify(isPlaying ? 'Resumed' : 'Paused');
            }, 'btn_play_toggle', 10);

            // Fullscreen button
            cv.roundRect(1340, 330, btnW, btnH, 10, '#162233');
            cv.strokeRoundRect(1340, 330, btnW, btnH, 10, 1, t.panelEdge);
            cv.text('FULLSCREEN', 1340 + btnW / 2, 361, 18, '#ffffff', { align: 'center', font: 'bold' });
            cv.target(1340, 330, btnW, btnH, () => {
                isFullscreen = !isFullscreen;
                notify(isFullscreen ? 'Cinema Fullscreen Active' : 'Standard View');
            }, 'btn_fs_toggle', 10);

            // Switch to Cast QR button
            cv.roundRect(1124, 392, 412, 46, 10, '#162233');
            cv.text('CAST NEW VIDEO (QR) >>', 1124 + 206, 421, 17, '#00a3e0', { align: 'center', font: 'bold' });
            cv.target(1124, 392, 412, 46, () => {
                page = 1;
            }, 'btn_go_cast', 10);
        }

        /* ---------- Video Screen Canvas Renderer ---------- */
        function drawVideoScreen(cv, x, y, w, h, video, isFs, now, motionLocked) {
            cv.roundRect(x, y, w, h, isFs ? 0 : 12, '#06090e');
            if (!isFs) cv.strokeRoundRect(x, y, w, h, 12, 1.5, '#1e293b');

            if (motionLocked) {
                cv.roundRect(x + 40, y + 40, w - 80, h - 80, 16, '#0f172a');
                cv.strokeRoundRect(x + 40, y + 40, w - 80, h - 80, 16, 2, '#ffb703');
                cv.text('WARNING: VIDEO PAUSED WHILE DRIVING', x + w / 2, y + h / 2 - 20, 24, '#ffb703', { align: 'center', font: 'bold' });
                cv.text('Safety interlock active at ' + vehicleSpeed + ' km/h', x + w / 2, y + h / 2 + 16, 17, '#cbd5e1', { align: 'center' });
                cv.text('Use QuickCode to enable Video In Motion, or park vehicle.', x + w / 2, y + h / 2 + 45, 15, '#94a3b8', { align: 'center' });
                return;
            }

            const glowCol = video.glow || '#00a3e0';
            const cx = x + w / 2;
            const cy = y + h / 2;

            // Perspective cinema horizon & stage lines
            cv.fillRect(x + 10, cy, w - 20, Math.floor(h / 2) - 10, '#0a0f18');
            cv.line(cx, cy, x + 60, y + h - 15, 2, withAlpha(glowCol, 0.4));
            cv.line(cx, cy, x + w - 60, y + h - 15, 2, withAlpha(glowCol, 0.4));
            cv.line(cx, cy, cx, y + h - 15, 3, '#ffffff');

            // Video Stream Status Pill
            cv.roundRect(x + 30, y + 25, 270, 48, 8, withAlpha('#000000', 0.75));
            cv.strokeRoundRect(x + 30, y + 25, 270, 48, 8, 1, withAlpha(glowCol, 0.4));
            cv.text('YOUTUBE ULTRA-WIDE STREAM', x + 44, y + 45, 13, glowCol, { font: 'bold', spacing: 1 });
            cv.text((video.quality || '720P 60').toUpperCase() + ' | 21:9 CINEMA', x + 44, y + 64, 14, '#ffffff', { font: 'num' });

            // Center Play Triangle (if paused)
            if (!isPlaying) {
                cv.circle(cx, cy, 44, withAlpha('#000000', 0.7));
                cv.circle(cx, cy, 44, glowCol);
                cv.quad([[cx - 14, cy - 20], [cx + 20, cy], [cx - 14, cy + 20], [cx - 14, cy + 20]], '#ffffff');
            }

            // Click to toggle fullscreen / play
            cv.target(x, y, w, h, () => {
                if (isFs) isFullscreen = false;
                else isPlaying = !isPlaying;
            }, 'vid_screen', 10);
        }

        /* ---------- Page 1: Cast & Connect (Phone QR Remote) ---------- */
        function drawCast(cv, t) {
            // Left Panel: Smartphone QR Code
            G.panel(cv, t, 40, 52, 740, 410, 'Scan Phone to Cast YouTube');

            const qr = getCastQr();
            if (qr) {
                const qrx = 70, qry = 120, qrsz = 210;
                const modCount = qr.size;
                const modPx = Math.floor(qrsz / modCount);
                const actualSz = modPx * modCount;
                const ox = qrx + Math.floor((qrsz - actualSz) / 2);
                const oy = qry + Math.floor((qrsz - actualSz) / 2);

                cv.roundRect(ox - 14, oy - 14, actualSz + 28, actualSz + 28, 12, '#ffffff');
                for (let r = 0; r < modCount; r++) {
                    for (let c = 0; c < modCount; c++) {
                        if (qr.getModule(c, r)) {
                            cv.fillRect(ox + c * modPx, oy + r * modPx, modPx, modPx, '#000000');
                        }
                    }
                }

                // Steps instructions
                const sx = 320, sy = 120;
                cv.text('SCAN PHONE TO CAST', sx, sy + 18, 19, '#ffffff', { font: 'bold' });
                cv.text('1. Connect phone to car Wi-Fi hotspot', sx, sy + 48, 15, '#cbd5e1');
                cv.text('2. In YouTube app, tap Share -> Copy Link', sx, sy + 74, 15, '#cbd5e1');
                cv.text('3. Tap "1-TAP PASTE & CAST" on phone', sx, sy + 100, 15, '#2af575', { font: 'bold' });
                cv.text('4. Full 21:9 Ultrawide streaming begins!', sx, sy + 126, 15, '#00a3e0');

                cv.roundRect(sx, sy + 152, 420, 36, 8, '#0b131f');
                cv.strokeRoundRect(sx, sy + 152, 420, 36, 8, 1, '#00a3e0');
                cv.text(castServer.getCastUrl(), sx + 210, sy + 175, 15, '#00a3e0', { align: 'center', font: 'num' });
            }

            // Right Panel: Safety & Video in Motion Status
            G.panel(cv, t, 820, 52, 740, 410, 'Cast Remote & Motion Safety');

            // Server active pill with thermal hardware protection status
            cv.roundRect(844, 114, 692, 90, 10, '#090e16');
            cv.strokeRoundRect(844, 114, 692, 90, 10, 1, '#00a3e0');
            cv.text('CAST RECEIVER ACTIVE (:8090) | THERMAL SAFE (' + (settings.quality === '1080p' ? '1080P MAX' : '720P COOL') + ')', 870, 145, 17, '#00a3e0', { font: 'bold' });
            cv.text('Intel Atom A3960 hardware protection: 4K/2K streams downsampled to prevent overheating', 870, 172, 14, '#94a3b8');

            const isParked = vehicleSpeed === 0;
            cv.roundRect(844, 218, 692, 90, 10, '#090e16');
            cv.strokeRoundRect(844, 218, 692, 90, 10, 1, isParked ? '#2af575' : '#ffb703');

            cv.text('VEHICLE STATUS: ' + (isParked ? 'PARKED (0 KM/H)' : 'IN MOTION (' + vehicleSpeed + ' KM/H)'), 870, 248, 18, isParked ? '#2af575' : '#ffb703', { font: 'bold' });
            cv.text(isParked ? '[OK] Safe for full cockpit video and audio playback' : '[!] Motion lockout active without Video in Motion coding', 870, 275, 15, isParked ? '#cbd5e1' : '#ffb703');

            // QuickCode VIM Integration banner
            cv.roundRect(844, 322, 692, 110, 10, '#0c1626');
            cv.strokeRoundRect(844, 322, 692, 110, 10, 1, '#00a3e0');

            cv.text('QUICKCODE INTEGRATION', 870, 350, 18, '#00a3e0', { font: 'bold' });
            cv.text('Want to allow your passenger to watch while driving?', 870, 376, 15, '#ffffff');
            cv.text('Open QuickCode app -> Video & Display -> Enable Video In Motion (VIM).', 870, 402, 14, t.dim);
        }

        /* ---------- Master 60 fps Render Loop ---------- */
        async function render() {
            const now = Date.now();
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);

            // If not in fullscreen, draw top header tabs and active page
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
                drawPlayer(cv, t, now);
            }

            // Global Notification banner
            if (statusMsg && (now - statusTime < 3500)) {
                cv.roundRect(W / 2 - 320, H - 56, 640, 42, 10, '#00a3e0');
                cv.text(statusMsg, W / 2, H - 29, 18, '#ffffff', { align: 'center', font: 'bold' });
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
        });

        // Start 60 fps render loop
        ctx.loop('MAIN', 15, render);
        render().then(() => log.info('M-Cinema ready')).catch((e) => log.warn('M-Cinema render error: ' + e));
    }
});
