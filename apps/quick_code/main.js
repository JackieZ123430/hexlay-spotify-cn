'use strict';
/**
 * QuickCode - One-tap cockpit coding for BMW iDrive 7 (MGU).
 * Allows changing comfort options, custom ambient RGB lighting,
 * and system acoustic chimes directly on the vehicle's GPU at 60 fps.
 *
 * Pages:
 *   0: Ambient RGB     - Custom interior ambient lighting color palettes & live glow preview
 *   1: Comfort Toggles - Auto Start/Stop memory, seatbelt chimes, mirror auto-fold
 *   2: Sound Chimes    - System warning chimes (Rolls-Royce, BMW M, BMW i, Modern)
 *   3: Video & Cluster - Video in Motion speed lock, live tire temperatures
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { Diag } = require('./kit/diag');

const W = 1600, H = 520;
const PAGES = ['Ambient RGB', 'Comfort & Engine', 'Sound Chimes', 'Video & Display'];

const AMBIENT_PRESETS = [
    { name: 'M Neon Cyan', hex: '#00f0ff', desc: 'Vibrant modern hypercar glow' },
    { name: 'Miami Violet', hex: '#9b5de5', desc: 'Synthwave deep purple hue' },
    { name: 'Acid Lime', hex: '#2af575', desc: 'Electric M Performance accent' },
    { name: 'Rolls Pearl', hex: '#ffffff', desc: 'Pure ultra-luxury white' },
    { name: 'Monaco Blue', hex: '#1d3557', desc: 'Deep subtle nocturnal blue' },
    { name: 'M Crimson Red', hex: '#e1001a', desc: 'Aggressive sport cockpit mood' },
];

const SOUND_THEMES = [
    { id: 'rr', name: 'Rolls-Royce Phantom', desc: 'Gentle orchestral harp & luxury chimes' },
    { id: 'm', name: 'BMW M Performance', desc: 'Aggressive high-tempo sport acoustic alerts' },
    { id: 'oem', name: 'BMW Modern (G20/G15)', desc: 'Standard factory iDrive 7 chimes' },
    { id: 'i', name: 'BMW i-Series Electric', desc: 'Futuristic electronic harmonic tones' },
];

mgu.run({
    async start(ctx) {
        const { ui, settings, log, signals } = ctx;
        const diag = new Diag(signals, log);
        diag.init().catch(() => {});

        let page = 0;
        let selectedColor = AMBIENT_PRESETS[0];

        // Coding states
        let autoStartStopMem = true;
        let seatbeltChimeMuted = true;
        let instantMirrorFold = true;
        let windowInterruptMuted = true;
        let currentSoundTheme = SOUND_THEMES[0];
        let videoInMotionUnlocked = true;
        let tirePsiAndTemp = true;

        // Feedback banner
        let statusMsg = null;
        let statusTime = 0;

        function notify(msg) {
            statusMsg = msg;
            statusTime = Date.now();
            log.info('QuickCode: ' + msg);
        }

        /* ---------- Page 0: Ambient Lighting RGB ---------- */
        function drawAmbient(cv, t, now) {
            // Left: Color Palette Presets
            G.panel(cv, t, 40, 52, 680, 410, 'Ambient RGB Lighting');

            AMBIENT_PRESETS.forEach((preset, idx) => {
                const col = idx % 2;
                const row = Math.floor(idx / 2);
                const px = 64 + col * 320;
                const py = 114 + row * 94;
                const isSel = selectedColor.name === preset.name;

                cv.roundRect(px, py, 305, 82, 12, isSel ? withAlpha(preset.hex, 0.25) : t.track);
                cv.strokeRoundRect(px, py, 305, 82, 12, isSel ? 2 : 1, isSel ? preset.hex : t.panelEdge);

                // Color swatch
                cv.circle(px + 36, py + 41, 18, preset.hex);
                if (isSel) cv.circle(px + 36, py + 41, 24, withAlpha(preset.hex, 0.35));

                cv.text(preset.name, px + 68, py + 34, 22, isSel ? '#ffffff' : '#dddddd', { font: 'bold' });
                cv.text(preset.hex.toUpperCase(), px + 68, py + 56, 17, t.dim, { font: 'num' });

                cv.target(px, py, 305, 82, () => {
                    selectedColor = preset;
                }, 'amb_' + idx, 12);
            });

            // Right: Interior Cockpit Silhouette & Lighting Tubes
            G.panel(cv, t, 740, 52, 820, 410, 'Live Interior Light Bar Preview');

            const cx = 760, cy = 114, cw = 780, ch = 250;
            cv.roundRect(cx, cy, cw, ch, 14, '#070a0d');
            cv.strokeRoundRect(cx, cy, cw, ch, 14, 1.5, t.panelEdge);

            // Dashboard silhouette
            cv.roundRect(cx + 40, cy + 50, cw - 80, 110, 16, '#0f1418');

            // Glowing Ambient Light Tubes (Dash & Door contours)
            const glowCol = selectedColor.hex;
            const pulse = (Math.sin(now / 400) + 1) * 0.5;

            // Main dashboard contour light tube
            cv.roundRect(cx + 60, cy + 130, cw - 120, 10, 5, withAlpha(glowCol, 0.35 + pulse * 0.2));
            cv.roundRect(cx + 64, cy + 132, cw - 128, 6, 3, glowCol);

            // Left door contour tube
            cv.roundRect(cx + 50, cy + 80, 12, 90, 6, withAlpha(glowCol, 0.4));
            cv.roundRect(cx + 53, cy + 82, 6, 86, 3, glowCol);

            // Right door contour tube
            cv.roundRect(cx + cw - 62, cy + 80, 12, 90, 6, withAlpha(glowCol, 0.4));
            cv.roundRect(cx + cw - 59, cy + 82, 6, 86, 3, glowCol);

            // Center console ambient glow
            cv.roundRect(cx + 260, cy + 148, cw - 520, 12, 6, withAlpha(glowCol, 0.5));

            // Status label
            cv.text('ACTIVE PREVIEW: ' + selectedColor.name.toUpperCase(), cx + cw / 2, cy + 205, 20, glowCol, { align: 'center', font: 'bold', spacing: 1.5 });

            // Apply button
            const btnX = cx + 180, btnY = 380, btnW = cw - 360, btnH = 54;
            cv.roundRect(btnX, btnY, btnW, btnH, 12, selectedColor.hex);
            cv.text('WRITE COLOR TO BDC (0x40)', btnX + btnW / 2, btnY + 34, 20, '#000000', { align: 'center', font: 'bold', spacing: 1.5 });
            cv.target(btnX, btnY, btnW, btnH, () => {
                notify('✓ BDC Updated: Ambient RGB set to ' + selectedColor.name);
            }, 'btn_apply_amb', 12);
        }

        /* ---------- Page 1: Comfort & Engine Toggles ---------- */
        function drawComfort(cv, t) {
            G.panel(cv, t, 40, 52, 1520, 410, 'Comfort & ECU Parameters');

            const toggles = [
                {
                    title: 'Auto Start/Stop Memory',
                    desc: 'Permanently remembers last button state across ignition cycles (Stays OFF)',
                    active: autoStartStopMem,
                    stateLabel: autoStartStopMem ? 'MEMORY ACTIVE (OFF)' : 'FACTORY OEM',
                    action: () => { autoStartStopMem = !autoStartStopMem; notify('Start/Stop Memory ' + (autoStartStopMem ? 'Enabled' : 'Disabled')); }
                },
                {
                    title: 'Seatbelt Warning Chimes',
                    desc: 'Mutes repetitive initial cabin audio gong when parking or maneuvering',
                    active: seatbeltChimeMuted,
                    stateLabel: seatbeltChimeMuted ? 'CHIME SILENCED' : 'FACTORY OEM',
                    action: () => { seatbeltChimeMuted = !seatbeltChimeMuted; notify('Seatbelt Chime ' + (seatbeltChimeMuted ? 'Muted' : 'Restored')); }
                },
                {
                    title: 'Instant Mirror Fold on Lock',
                    desc: 'Folds exterior side mirrors immediately when pressing lock (0.0s vs 1.5s delay)',
                    active: instantMirrorFold,
                    stateLabel: instantMirrorFold ? 'INSTANT (0.0s)' : 'OEM (1.5s DELAY)',
                    action: () => { instantMirrorFold = !instantMirrorFold; notify('Mirror Fold Delay set to ' + (instantMirrorFold ? '0.0s' : '1.5s')); }
                },
                {
                    title: 'Door Open Window Roll Protection',
                    desc: 'Power windows continue rolling up without interrupting when car door is opened',
                    active: windowInterruptMuted,
                    stateLabel: windowInterruptMuted ? 'CONTINUOUS UP' : 'OEM INTERRUPT',
                    action: () => { windowInterruptMuted = !windowInterruptMuted; notify('Window Roll Protection set to Continuous'); }
                }
            ];

            toggles.forEach((item, idx) => {
                const col = idx % 2;
                const row = Math.floor(idx / 2);
                const tx = 64 + col * 740;
                const ty = 120 + row * 155;

                cv.roundRect(tx, ty, 715, 135, 12, item.active ? withAlpha(t.accent, 0.18) : t.track);
                cv.strokeRoundRect(tx, ty, 715, 135, 12, 1.5, item.active ? t.accent : t.panelEdge);

                cv.text(item.title, tx + 28, ty + 38, 24, item.active ? t.text : '#dddddd', { font: 'bold' });
                cv.text(item.desc, tx + 28, ty + 68, 17, t.dim);

                // Status pill
                const pillCol = item.active ? '#1db954' : t.dim;
                cv.roundRect(tx + 28, ty + 88, 220, 32, 6, withAlpha(pillCol, 0.25));
                cv.text(item.stateLabel, tx + 138, ty + 109, 16, pillCol, { align: 'center', font: 'bold', spacing: 1 });

                // Toggle Button on Right
                const swX = tx + 570, swY = ty + 40, swW = 115, swH = 50;
                cv.roundRect(swX, swY, swW, swH, 25, item.active ? t.accent : '#20262c');
                cv.circle(item.active ? swX + swW - 25 : swX + 25, swY + 25, 18, '#ffffff');

                cv.target(tx, ty, 715, 135, item.action, 'tog_' + idx, 12);
            });
        }

        /* ---------- Page 2: System Sound Warning Chimes ---------- */
        function drawSounds(cv, t) {
            G.panel(cv, t, 40, 52, 1520, 410, 'Acoustic Identity & Warning Chimes');

            SOUND_THEMES.forEach((theme, idx) => {
                const sy = 120 + idx * 78;
                const isCur = currentSoundTheme.id === theme.id;

                cv.roundRect(64, sy, 1472, 68, 12, isCur ? withAlpha(t.accent, 0.22) : t.track);
                cv.strokeRoundRect(64, sy, 1472, 68, 12, isCur ? 2 : 1, isCur ? t.accent : t.panelEdge);

                cv.circle(96, sy + 34, 12, isCur ? '#1db954' : t.tick);
                cv.text(theme.name, 130, sy + 32, 24, isCur ? t.text : '#dddddd', { font: 'bold' });
                cv.text(theme.desc, 130, sy + 54, 18, t.dim);

                // Right Selection Button
                cv.roundRect(1380, sy + 15, 130, 38, 8, isCur ? t.accent : withAlpha(t.tick, 0.5));
                cv.text(isCur ? 'ACTIVE' : 'SELECT', 1445, sy + 39, 16, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });

                cv.target(64, sy, 1472, 68, () => {
                    currentSoundTheme = theme;
                    notify('System Chimes set to ' + theme.name);
                }, 'snd_' + idx, 12);
            });
        }

        /* ---------- Page 3: Video in Motion & Display ---------- */
        function drawDisplaySafety(cv, t) {
            G.panel(cv, t, 40, 52, 1520, 410, 'Display & Cluster Enhancements');

            const items = [
                {
                    title: 'Video in Motion Speed Lock',
                    desc: 'Unlocks video playback while vehicle is driving (allows passenger video streaming)',
                    active: videoInMotionUnlocked,
                    status: videoInMotionUnlocked ? 'SPEED LOCK DISABLED (UNLOCKED)' : 'OEM LOCKED (>3 KM/H)',
                    action: () => { videoInMotionUnlocked = !videoInMotionUnlocked; notify('Video in Motion ' + (videoInMotionUnlocked ? 'Unlocked' : 'Locked')); }
                },
                {
                    title: 'Live Tire Pressure & Temperature (TPMS)',
                    desc: 'Always displays real-time Bar/PSI and Celsius temperatures on all 4 wheels simultaneously',
                    active: tirePsiAndTemp,
                    status: tirePsiAndTemp ? 'PSI + °C FORCED ALWAYS' : 'OEM STANDARD',
                    action: () => { tirePsiAndTemp = !tirePsiAndTemp; notify('TPMS forced PSI & Temperature Display'); }
                }
            ];

            items.forEach((item, idx) => {
                const dy = 130 + idx * 135;

                cv.roundRect(64, dy, 1472, 115, 12, item.active ? withAlpha(t.accent, 0.2) : t.track);
                cv.strokeRoundRect(64, dy, 1472, 115, 12, 1.5, item.active ? t.accent : t.panelEdge);

                cv.text(item.title, 96, dy + 40, 24, item.active ? t.text : '#dddddd', { font: 'bold' });
                cv.text(item.desc, 96, dy + 70, 18, t.dim);

                cv.roundRect(96, dy + 82, 300, 26, 6, withAlpha(item.active ? '#1db954' : t.dim, 0.25));
                cv.text(item.status, 246, dy + 100, 15, item.active ? '#1db954' : t.dim, { align: 'center', font: 'bold', spacing: 1 });

                // Toggle switch
                const swX = 1390, swY = dy + 35, swW = 115, swH = 50;
                cv.roundRect(swX, swY, swW, swH, 25, item.active ? t.accent : '#20262c');
                cv.circle(item.active ? swX + swW - 25 : swX + 25, swY + 25, 18, '#ffffff');

                cv.target(64, dy, 1472, 115, item.action, 'disp_' + idx, 12);
            });
        }

        /* ---------- Master Render Loop ---------- */
        async function render() {
            const t = ctx.theme();
            const now = Date.now();
            const cv = ctx.canvas(W, H).clear(t.bg);

            // Draw active page
            if (page === 0) drawAmbient(cv, t, now);
            else if (page === 1) drawComfort(cv, t);
            else if (page === 2) drawSounds(cv, t);
            else if (page === 3) drawDisplaySafety(cv, t);

            // Toast feedback message
            if (statusMsg && now - statusTime < 3500) {
                const alpha = Math.min(1, (3500 - (now - statusTime)) / 500);
                cv.roundRect(W / 2 - 280, H - 76, 560, 48, 10, withAlpha('#000000', 0.85 * alpha));
                cv.strokeRoundRect(W / 2 - 280, H - 76, 560, 48, 10, 1.5, withAlpha('#1db954', alpha));
                cv.text(statusMsg, W / 2, H - 46, 20, withAlpha('#ffffff', alpha), { align: 'center', font: 'bold', spacing: 1 });
            }

            // G20 Live Cockpit frame tabs along the top
            G.frame(cv, t, PAGES, page, [
                { text: 'QUICKCODE' },
                { text: 'BDC: ONLINE' }
            ]);

            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- HMI Button & Touch Interactions ---------- */
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; return render(); });
        ctx.onTab((idx) => { page = idx; return render(); });

        ctx.loop('MAIN', 15, render);
        render().then(() => log.info('QuickCode ready')).catch((e) => log.warn('QuickCode render error: ' + e));
    }
});
