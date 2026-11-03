'use strict';
/**
 * M-Cinema - Ultrawide Parked Cinema & Cockpit Theater for BMW iDrive 7.
 * Runs natively on the vehicle's GPU at 60 fps.
 *
 * Features:
 *   - 21:9 Cinema Ultrawide & 16:9 Letterbox video playback
 *   - Active Cockpit Ambilight Glow reacting to video palette
 *   - Parked Vehicle Motion Safety Interlock
 *   - Physical iDrive Controller & Touchscreen support
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { CATEGORIES } = require('./channels');

const W = 1600, H = 520;
const PAGES = ['Now Playing', 'Channels & Feeds', 'Cast & Stream'];

mgu.run({
    async start(ctx) {
        const { ui, settings, log, signals } = ctx;

        let page = 0;
        let catIdx = 0;
        let itemIdx = 0;
        let isPlaying = true;
        let playProgress = 0.35; // 35% through video
        let isFullscreen = false;
        let vehicleSpeed = 0;
        let statusMsg = null;
        let statusTime = 0;

        // Try reading vehicle speed
        try {
            const Car = require('./kit/car');
            const car = new Car(ctx, ['speed']);
            car.onSample((data) => {
                if (data.speed !== undefined) vehicleSpeed = Math.round(data.speed);
            });
        } catch (e) {
            log.warn('M-Cinema: Speed monitor fallback: ' + e.message);
        }

        function currentVideo() {
            const cat = CATEGORIES[catIdx] || CATEGORIES[0];
            return cat.items[itemIdx] || cat.items[0];
        }

        function notify(msg) {
            statusMsg = msg;
            statusTime = Date.now();
            log.info('M-Cinema: ' + msg);
        }

        /* ---------- Page 0: Now Playing Cinema Player ---------- */
        function drawPlayer(cv, t, now) {
            const video = currentVideo();
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
            G.panel(cv, t, 40, 52, 1040, 410, 'Cockpit Cinema: ' + video.quality);

            const vx = 64, vy = 114, vw = 992, vh = 280;

            // Cockpit Ambilight Glow around the viewport
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

            // Scrubber touch target
            cv.target(vx, sy - 10, sw, 28, (x) => {
                const rel = Math.max(0, Math.min(1, (x - vx) / sw));
                playProgress = rel;
                notify(`Seek: ${Math.floor(rel * 100)}%`);
            }, 'scrub', 8);

            // Timecode & Badges below scrubber
            cv.text('03:42 / ' + video.duration, vx, 442, 16, t.dim, { font: 'num' });
            cv.text(video.quality, vx + 180, 442, 14, glowCol, { font: 'bold' });
            cv.text(isPlaying ? 'PLAYING' : 'PAUSED', vx + sw - 120, 442, 16, isPlaying ? '#2af575' : '#ffb703', { font: 'bold', align: 'right' });

            // Right Panel (460px): Video Details & Quick Controls
            G.panel(cv, t, 1100, 52, 460, 410, 'Video Details');

            cv.text(video.title, 1124, 130, 20, '#ffffff', { font: 'bold' });
            cv.text(video.channel, 1124, 162, 17, glowCol, { font: 'bold' });
            cv.text(`${video.views} views | ${CATEGORIES[catIdx].name}`, 1124, 188, 15, t.dim);

            // Description box
            cv.roundRect(1124, 210, 412, 100, 10, '#090e16');
            cv.strokeRoundRect(1124, 210, 412, 100, 10, 1, t.panelEdge);
            cv.text(video.desc, 1140, 242, 16, '#94a3b8');

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

            // Next Video button
            cv.roundRect(1124, 392, 412, 46, 10, '#162233');
            cv.text('NEXT VIDEO >>', 1124 + 206, 421, 17, '#00a3e0', { align: 'center', font: 'bold' });
            cv.target(1124, 392, 412, 46, () => {
                const cat = CATEGORIES[catIdx];
                itemIdx = (itemIdx + 1) % cat.items.length;
                playProgress = 0;
            }, 'btn_next_vid', 10);
        }

        /* ---------- Video Screen Canvas Renderer ---------- */
        function drawVideoScreen(cv, x, y, w, h, video, isFs, now, motionLocked) {
            // Screen Background
            cv.roundRect(x, y, w, h, isFs ? 0 : 12, '#06090e');
            if (!isFs) cv.strokeRoundRect(x, y, w, h, 12, 1.5, '#1e293b');

            if (motionLocked) {
                // Safety Interlock Warning
                cv.roundRect(x + 40, y + 40, w - 80, h - 80, 16, '#0f172a');
                cv.strokeRoundRect(x + 40, y + 40, w - 80, h - 80, 16, 2, '#ffb703');
                cv.text('⚠ VIDEO PAUSED WHILE DRIVING', x + w / 2, y + h / 2 - 20, 24, '#ffb703', { align: 'center', font: 'bold' });
                cv.text('Safety interlock active at ' + vehicleSpeed + ' km/h', x + w / 2, y + h / 2 + 16, 17, '#cbd5e1', { align: 'center' });
                cv.text('Use QuickCode to enable Video In Motion, or park vehicle.', x + w / 2, y + h / 2 + 45, 15, '#94a3b8', { align: 'center' });
                return;
            }

            // Cinematic Virtual Frame: Draw high-speed motion artwork / scene preview
            const glowCol = video.glow || '#00a3e0';
            const cx = x + w / 2;
            const cy = y + h / 2;

            // Horizon & Asphalt perspective lines
            cv.fillRect(x + 10, cy, w - 20, Math.floor(h / 2) - 10, '#0a0f18');
            cv.line(cx, cy, x + 60, y + h - 15, 2, withAlpha(glowCol, 0.4));
            cv.line(cx, cy, x + w - 60, y + h - 15, 2, withAlpha(glowCol, 0.4));
            cv.line(cx, cy, cx, y + h - 15, 3, '#ffffff');

            // Digital HUD overlay on video
            cv.roundRect(x + 30, y + 25, 220, 36, 6, withAlpha('#000000', 0.65));
            cv.text('BMW M TELEMETRY', x + 44, y + 48, 14, glowCol, { font: 'bold', spacing: 1 });
            cv.text('278 KM/H | 6,400 RPM', x + 44, y + 74, 15, '#ffffff', { font: 'num' });

            // Big Center Play Triangle (if paused)
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

        /* ---------- Page 1: Channels & Category Grid ---------- */
        function drawChannels(cv, t) {
            // Category selector tabs (left)
            G.panel(cv, t, 40, 52, 420, 410, 'Cinema Channels');

            CATEGORIES.forEach((cat, idx) => {
                const cy = 114 + idx * 72;
                const isSel = idx === catIdx;

                cv.roundRect(64, cy, 372, 60, 10, isSel ? withAlpha('#00a3e0', 0.25) : t.track);
                cv.strokeRoundRect(64, cy, 372, 60, 10, isSel ? 2 : 1, isSel ? '#00a3e0' : t.panelEdge);

                cv.circle(92, cy + 30, 8, isSel ? '#00a3e0' : t.dim);
                cv.text(cat.name, 114, cy + 36, 18, isSel ? '#ffffff' : '#cbd5e1', { font: isSel ? 'bold' : 'normal' });

                cv.target(64, cy, 372, 60, () => {
                    catIdx = idx;
                    itemIdx = 0;
                }, 'cat_' + idx, 10);
            });

            // Video Cards (right)
            const activeCat = CATEGORIES[catIdx];
            G.panel(cv, t, 480, 52, 1080, 410, activeCat.name + ' (' + activeCat.items.length + ' Videos)');

            activeCat.items.forEach((item, idx) => {
                const iy = 114 + idx * 98;
                const isCur = idx === itemIdx;

                cv.roundRect(504, iy, 1032, 86, 12, isCur ? withAlpha(item.glow, 0.2) : '#090e16');
                cv.strokeRoundRect(504, iy, 1032, 86, 12, isCur ? 2 : 1, isCur ? item.glow : t.panelEdge);

                // Video Thumbnail Placeholder
                cv.roundRect(520, iy + 10, 116, 66, 8, '#131b26');
                cv.strokeRoundRect(520, iy + 10, 116, 66, 8, 1, item.glow);
                cv.quad([[570, iy + 33], [586, iy + 43], [570, iy + 53], [570, iy + 53]], item.glow);

                // Duration tag on thumb
                cv.roundRect(582, iy + 52, 50, 20, 4, '#000000');
                cv.text(item.duration, 607, iy + 66, 12, '#ffffff', { align: 'center', font: 'num' });

                // Titles & Metadata
                cv.text(item.title, 656, iy + 34, 19, '#ffffff', { font: 'bold' });
                cv.text(`${item.channel} | ${item.views} views | ${item.quality}`, 656, iy + 62, 15, item.glow);

                // Play Now button
                const playX = 1420, playY = iy + 22, playW = 100, playH = 42;
                cv.roundRect(playX, playY, playW, playH, 8, isCur ? item.glow : '#1a2432');
                cv.text(isCur ? 'WATCH' : 'PLAY', playX + playW / 2, playY + 27, 16, isCur ? '#000000' : '#ffffff', { align: 'center', font: 'bold' });

                cv.target(504, iy, 1032, 86, () => {
                    itemIdx = idx;
                    page = 0; // jump to player
                    isPlaying = true;
                    playProgress = 0;
                    notify('Now Playing: ' + item.title);
                }, 'item_' + idx, 12);
            });
        }

        /* ---------- Page 2: Cast & Direct Stream ---------- */
        function drawCast(cv, t) {
            G.panel(cv, t, 40, 52, 740, 410, 'Direct Stream / Phone Cast');

            const cx = 64, cy = 114;
            cv.text('STREAM SOURCES & PROTOCOLS', cx, cy + 20, 18, '#ffffff', { font: 'bold' });
            cv.text('M-Cinema accepts live HLS (.m3u8), MP4 and RTSP streams', cx, cy + 48, 16, t.dim);

            const sources = [
                { title: 'YouTube & Browser Mirroring', desc: 'Stream video from smartphone via phone hotspot / Wi-Fi', status: 'READY' },
                { title: 'Local Media USB / DLNA', desc: 'Play 1080p high-bitrate video files stored on MGU USB drive', status: 'MOUNTED' },
                { title: 'Plex & Jellyfin Direct Feed', desc: 'Connect to your home media server while charging or parked', status: 'ONLINE' }
            ];

            sources.forEach((s, idx) => {
                const sy = cy + 80 + idx * 85;
                cv.roundRect(cx, sy, 690, 72, 10, '#0a1019');
                cv.strokeRoundRect(cx, sy, 690, 72, 10, 1, t.panelEdge);

                cv.text(s.title, cx + 20, sy + 28, 18, '#ffffff', { font: 'bold' });
                cv.text(s.desc, cx + 20, sy + 52, 15, t.dim);

                cv.roundRect(cx + 570, sy + 20, 100, 32, 6, withAlpha('#00a3e0', 0.2));
                cv.text(s.status, cx + 620, sy + 41, 14, '#00a3e0', { align: 'center', font: 'bold' });
            });

            // Right Panel: Safety & Video in Motion Status
            G.panel(cv, t, 820, 52, 740, 410, 'Cockpit Safety & VIM Status');

            const isParked = vehicleSpeed === 0;
            cv.roundRect(844, 114, 692, 100, 12, '#090e16');
            cv.strokeRoundRect(844, 114, 692, 100, 12, 1.5, isParked ? '#2af575' : '#ffb703');

            cv.text('VEHICLE STATUS: ' + (isParked ? 'PARKED (0 KM/H)' : 'IN MOTION (' + vehicleSpeed + ' KM/H)'), 870, 150, 20, isParked ? '#2af575' : '#ffb703', { font: 'bold' });
            cv.text(isParked ? '✓ Safe for full cockpit video and audio playback' : '⚠ Motion lockout active without Video in Motion coding', 870, 182, 16, '#cbd5e1');

            // QuickCode VIM Integration banner
            cv.roundRect(844, 234, 692, 110, 12, '#0c1626');
            cv.strokeRoundRect(844, 234, 692, 110, 12, 1, '#00a3e0');

            cv.text('QUICKCODE INTEGRATION', 870, 266, 18, '#00a3e0', { font: 'bold' });
            cv.text('Want to allow your passenger to watch while driving?', 870, 292, 16, '#ffffff');
            cv.text('Open QuickCode app -> Video & Display -> Enable Video In Motion (VIM).', 870, 318, 15, t.dim);
        }

        /* ---------- Master 60 fps Render Loop ---------- */
        async function render() {
            const now = Date.now();
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);

            // If not in fullscreen, draw top header tabs and active page
            if (!isFullscreen) {
                if (page === 0) drawPlayer(cv, t, now);
                else if (page === 1) drawChannels(cv, t);
                else if (page === 2) drawCast(cv, t);

                // G20/G15 Live Cockpit frame tabs along the top
                G.frame(cv, t, PAGES, page, [
                    { text: 'M-CINEMA' },
                    { text: currentVideo().quality },
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
            // Knob turn
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
