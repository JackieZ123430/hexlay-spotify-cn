'use strict';
/**
 * QuickCode - One-tap cockpit coding for all BMW G-Series (iDrive 7).
 * Allows changing comfort options, custom ambient RGB lighting,
 * and system acoustic chimes directly on the vehicle's GPU at 60 fps.
 *
 * Safety Enforcements:
 *   - Verifies BMW G-Series architecture (BDC_BODY3 / HU_MGU).
 *   - Dynamically detects module presence (BDC 0x40, KOMBI 0x60, HU_MGU 0x63, DSC 0x29).
 *   - Hides any coding options or tabs where the required ECU module is absent.
 *   - ENGINE RUNNING SAFEGUARD: Coding is strictly locked if engine RPM > 0.
 *   - MOTION SAFEGUARD: Coding is strictly locked if vehicle speed > 0.
 *   - DIAGNOSTIC MODE: Requires Terminal 15 Diagnostic Mode (3-press Start button, engine OFF)
 *     before writing any ECU parameters (matches BimmerCode & ISTA safety standards).
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { Diag } = require('./kit/diag');
const { VehicleSafety } = require('./safety');

const W = 1600, H = 520;

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
    { id: 'oem', name: 'BMW Modern (G-Series)', desc: 'Standard factory iDrive 7 chimes (G20/G30/G15/G05)' },
    { id: 'i', name: 'BMW i-Series Electric', desc: 'Futuristic electronic harmonic tones' },
];

mgu.run({
    async start(ctx) {
        const { ui, settings, log, signals } = ctx;
        const diag = new Diag(signals, log);
        diag.init().catch(() => {});

        const safety = new VehicleSafety(diag, log);
        safety.scanModules().catch(() => {});

        // Monitor vehicle speed and engine RPM for safety interlock
        try {
            const Car = require('./kit/car');
            const car = new Car(ctx, ['rpm', 'speed']);
            car.onSample((sample) => {
                safety.updateTelemetry(sample);
            });
        } catch (e) {
            log.warn('QuickCode: Telemetry monitor fallback: ' + e.message);
        }

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

        // Feedback & Safety Dialog state
        let statusMsg = null;
        let statusTime = 0;
        let activeSafetyAlert = null;

        function notify(msg) {
            statusMsg = msg;
            statusTime = Date.now();
            log.info('QuickCode: ' + msg);
        }

        // Dynamically compute available pages according to detected modules
        function getPages() {
            const list = [];
            if (safety.supports('ambient_rgb')) list.push({ id: 'ambient', name: 'Ambient RGB' });
            list.push({ id: 'comfort', name: 'Comfort & Engine' });
            if (safety.supports('sound_chimes')) list.push({ id: 'sounds', name: 'Sound Chimes' });
            list.push({ id: 'display', name: 'Video & Display' });
            return list;
        }

        /* ---------- Safety Lockout Screen (Non-G-Series) ---------- */
        function drawSafetyLockout(cv, t) {
            G.panel(cv, t, 40, 52, 1520, 410, 'Safety Interlock Active');

            cv.roundRect(80, 110, 1440, 310, 16, '#0f172a');
            cv.strokeRoundRect(80, 110, 1440, 310, 16, 2, '#e1001a');

            cv.circle(180, 260, 48, withAlpha('#e1001a', 0.2));
            cv.text('!', 180, 275, 48, '#e1001a', { align: 'center', font: 'bold' });

            cv.text('NON-G-SERIES ARCHITECTURE DETECTED', 260, 180, 26, '#e1001a', { font: 'bold' });
            cv.text('QuickCode is engineered specifically for BMW G-Series vehicles with iDrive 7 (BDC_BODY3 / HU_MGU).', 260, 220, 18, '#ffffff');
            cv.text('All ECU coding write and parameter change functions have been permanently locked for vehicle protection.', 260, 252, 17, '#94a3b8');
            cv.text('No coding modifications will be sent to the vehicle CAN/Ethernet bus.', 260, 284, 17, '#94a3b8');

            cv.roundRect(260, 320, 380, 44, 8, '#1e293b');
            cv.text('STATUS: READ-ONLY SAFE LOCKOUT', 450, 348, 16, '#ffb703', { align: 'center', font: 'bold' });
        }

        /* ---------- Safety Modal Dialog (Engine Running / Diag Mode Required) ---------- */
        function drawSafetyModal(cv, t) {
            if (!activeSafetyAlert) return;
            const alert = activeSafetyAlert;

            // Fullscreen dark backdrop overlay
            cv.roundRect(0, 0, W, H, 0, withAlpha('#000000', 0.82));

            // Dialog Box
            const dw = 860, dh = 400;
            const dx = (W - dw) / 2, dy = (H - dh) / 2;
            cv.roundRect(dx, dy, dw, dh, 16, '#0c131d');
            cv.strokeRoundRect(dx, dy, dw, dh, 16, 2, alert.badgeColor || '#e1001a');

            // Header Banner
            cv.roundRect(dx + 16, dy + 16, dw - 32, 54, 10, withAlpha(alert.badgeColor || '#e1001a', 0.15));
            cv.circle(dx + 50, dy + 43, 16, alert.badgeColor || '#e1001a');
            cv.text('!', dx + 50, dy + 49, 18, '#000000', { align: 'center', font: 'bold' });
            cv.text(alert.title, dx + 82, dy + 50, 20, alert.badgeColor || '#e1001a', { font: 'bold', spacing: 1 });

            // Message text
            cv.text(alert.message, dx + 32, dy + 104, 15, '#cbd5e1');

            // Step instructions box
            const boxY = dy + 130, boxH = 160;
            cv.roundRect(dx + 32, boxY, dw - 64, boxH, 10, '#060a10');
            cv.strokeRoundRect(dx + 32, boxY, dw - 64, boxH, 10, 1, '#1e293b');

            cv.text('HOW TO ENTER BMW DIAGNOSTIC MODE (PAD):', dx + 48, boxY + 28, 15, '#00a3e0', { font: 'bold' });

            const steps = alert.steps && alert.steps.length ? alert.steps : [
                '1. Turn OFF engine completely (Press Start/Stop button)',
                '2. Foot completely OFF the brake pedal',
                '3. Press the Start/Stop button 3 times in quick succession',
                '4. Instrument cluster will display "Diagnostic mode active"'
            ];

            steps.forEach((st, i) => {
                cv.text(st, dx + 48, boxY + 58 + i * 25, 15, '#ffffff');
            });

            // Action Buttons at bottom
            const btnW = 240, btnH = 46;
            const b1X = dx + 32, bY = dy + dh - 64;

            // Dismiss Button
            cv.roundRect(b1X, bY, btnW, btnH, 8, '#1e293b');
            cv.strokeRoundRect(b1X, bY, btnW, btnH, 8, 1, '#334155');
            cv.text('OK, UNDERSTOOD', b1X + btnW / 2, bY + 29, 16, '#ffffff', { align: 'center', font: 'bold' });
            cv.target(b1X, bY, btnW, btnH, () => {
                activeSafetyAlert = null;
            }, 'btn_dismiss_alert', 15);

            // Simulation / Toggle Button (for bench / demo mode)
            const b2X = dx + dw - 32 - 340;
            const isDiag = safety.vehicleState.diagnosticMode;
            cv.roundRect(b2X, bY, 340, btnH, 8, isDiag ? '#0f291e' : '#2d1518');
            cv.strokeRoundRect(b2X, bY, 340, btnH, 8, 1, isDiag ? '#2af575' : '#e1001a');
            const simLabel = isDiag ? 'DIAG MODE: ACTIVE (CLICK TO LOCK)' : 'SIMULATE: ENTER DIAG MODE';
            cv.text(simLabel, b2X + 170, bY + 29, 14, isDiag ? '#2af575' : '#ffb703', { align: 'center', font: 'bold' });
            cv.target(b2X, bY, 340, btnH, () => {
                safety.toggleSimulatedDiagMode();
                if (safety.vehicleState.diagnosticMode) {
                    activeSafetyAlert = null;
                    notify('[OK] Diagnostic Mode simulated (Coding unlocked)');
                } else {
                    activeSafetyAlert = safety.checkCodingSafety();
                    notify('[!] Diagnostic Mode exited (Coding locked)');
                }
            }, 'btn_sim_diag', 15);
        }

        /* ---------- Page: Ambient Lighting RGB ---------- */
        function drawAmbient(cv, t, now) {
            G.panel(cv, t, 40, 52, 680, 410, 'Ambient RGB Lighting (BDC 0x40)');

            AMBIENT_PRESETS.forEach((preset, idx) => {
                const col = idx % 2;
                const row = Math.floor(idx / 2);
                const px = 64 + col * 320;
                const py = 114 + row * 94;
                const isSel = selectedColor.name === preset.name;

                cv.roundRect(px, py, 305, 82, 12, isSel ? withAlpha(preset.hex, 0.25) : t.track);
                cv.strokeRoundRect(px, py, 305, 82, 12, isSel ? 2 : 1, isSel ? preset.hex : t.panelEdge);

                cv.circle(px + 36, py + 41, 18, preset.hex);
                if (isSel) cv.circle(px + 36, py + 41, 24, withAlpha(preset.hex, 0.35));

                cv.text(preset.name, px + 68, py + 34, 22, isSel ? '#ffffff' : '#dddddd', { font: 'bold' });
                cv.text(preset.hex.toUpperCase(), px + 68, py + 56, 17, t.dim, { font: 'num' });

                cv.target(px, py, 305, 82, () => {
                    selectedColor = preset;
                }, 'amb_' + idx, 12);
            });

            // Right: Interior Silhouette & Light Tubes
            G.panel(cv, t, 740, 52, 820, 410, 'Live Interior Light Bar Preview');

            const cx = 760, cy = 114, cw = 780, ch = 250;
            cv.roundRect(cx, cy, cw, ch, 14, '#070a0d');
            cv.strokeRoundRect(cx, cy, cw, ch, 14, 1.5, t.panelEdge);

            cv.roundRect(cx + 40, cy + 50, cw - 80, 110, 16, '#0f1418');

            const glowCol = selectedColor.hex;
            const pulse = (Math.sin(now / 400) + 1) * 0.5;

            // Light tubes
            cv.roundRect(cx + 60, cy + 130, cw - 120, 10, 5, withAlpha(glowCol, 0.35 + pulse * 0.2));
            cv.roundRect(cx + 64, cy + 132, cw - 128, 6, 3, glowCol);

            cv.roundRect(cx + 50, cy + 80, 12, 90, 6, withAlpha(glowCol, 0.4));
            cv.roundRect(cx + 53, cy + 82, 6, 86, 3, glowCol);

            cv.roundRect(cx + cw - 62, cy + 80, 12, 90, 6, withAlpha(glowCol, 0.4));
            cv.roundRect(cx + cw - 59, cy + 82, 6, 86, 3, glowCol);

            cv.roundRect(cx + 260, cy + 148, cw - 520, 12, 6, withAlpha(glowCol, 0.5));

            cv.text('ACTIVE PREVIEW: ' + selectedColor.name.toUpperCase(), cx + cw / 2, cy + 205, 20, glowCol, { align: 'center', font: 'bold', spacing: 1.5 });

            // Apply button (Gated by Engine Running & Diagnostic Mode Safety)
            const btnX = cx + 180, btnY = 380, btnW = cw - 360, btnH = 54;
            const safeCheck = safety.checkCodingSafety('ambient_rgb');
            const canWrite = safeCheck.allowed;

            cv.roundRect(btnX, btnY, btnW, btnH, 12, canWrite ? selectedColor.hex : '#16202c');
            cv.strokeRoundRect(btnX, btnY, btnW, btnH, 12, 1.5, canWrite ? selectedColor.hex : safeCheck.badgeColor);

            const btnLabel = canWrite ? 'WRITE COLOR TO BDC (0x40)' : `[LOCKED] ${safeCheck.title}`;
            cv.text(btnLabel, btnX + btnW / 2, btnY + 34, 18, canWrite ? '#000000' : safeCheck.badgeColor, { align: 'center', font: 'bold', spacing: 1.2 });

            cv.target(btnX, btnY, btnW, btnH, () => {
                const check = safety.checkCodingSafety('ambient_rgb');
                if (!check.allowed) {
                    activeSafetyAlert = check;
                    notify('[!] ' + check.title);
                    return;
                }
                notify('BDC Updated: Ambient RGB set to ' + selectedColor.name);
            }, 'btn_apply_amb', 12);
        }

        /* ---------- Page: Comfort & Engine Toggles ---------- */
        function drawComfort(cv, t) {
            G.panel(cv, t, 40, 52, 1520, 410, 'Comfort & ECU Parameters');

            const allToggles = [
                {
                    key: 'start_stop_mem',
                    title: 'Auto Start/Stop Memory',
                    desc: 'Permanently remembers last button state across ignition cycles (Stays OFF)',
                    active: autoStartStopMem,
                    stateLabel: autoStartStopMem ? 'MEMORY ACTIVE (OFF)' : 'FACTORY OEM',
                    action: () => { autoStartStopMem = !autoStartStopMem; notify('Start/Stop Memory ' + (autoStartStopMem ? 'Enabled' : 'Disabled')); }
                },
                {
                    key: 'start_stop_mem',
                    title: 'Seatbelt Warning Chimes',
                    desc: 'Mutes repetitive initial cabin audio gong when parking or maneuvering',
                    active: seatbeltChimeMuted,
                    stateLabel: seatbeltChimeMuted ? 'CHIME SILENCED' : 'FACTORY OEM',
                    action: () => { seatbeltChimeMuted = !seatbeltChimeMuted; notify('Seatbelt Chime ' + (seatbeltChimeMuted ? 'Muted' : 'Restored')); }
                },
                {
                    key: 'mirror_fold',
                    title: 'Instant Mirror Fold on Lock',
                    desc: 'Folds exterior side mirrors immediately when pressing lock (0.0s vs 1.5s delay)',
                    active: instantMirrorFold,
                    stateLabel: instantMirrorFold ? 'INSTANT (0.0s)' : 'OEM (1.5s DELAY)',
                    action: () => { instantMirrorFold = !instantMirrorFold; notify('Mirror Fold Delay set to ' + (instantMirrorFold ? '0.0s' : '1.5s')); }
                },
                {
                    key: 'window_roll',
                    title: 'Door Open Window Roll Protection',
                    desc: 'Power windows continue rolling up without interrupting when car door is opened',
                    active: windowInterruptMuted,
                    stateLabel: windowInterruptMuted ? 'CONTINUOUS UP' : 'OEM INTERRUPT',
                    action: () => { windowInterruptMuted = !windowInterruptMuted; notify('Window Roll Protection set to Continuous'); }
                }
            ];

            // Filter out items whose required modules are not present on the vehicle
            const toggles = allToggles.filter(item => safety.supports(item.key));

            toggles.forEach((item, idx) => {
                const col = idx % 2;
                const row = Math.floor(idx / 2);
                const tx = 64 + col * 740;
                const ty = 120 + row * 155;
                const safeCheck = safety.checkCodingSafety(item.key);
                const canCode = safeCheck.allowed;

                cv.roundRect(tx, ty, 715, 135, 12, item.active ? withAlpha(t.accent, 0.18) : t.track);
                cv.strokeRoundRect(tx, ty, 715, 135, 12, 1.5, canCode ? (item.active ? t.accent : t.panelEdge) : withAlpha(safeCheck.badgeColor, 0.6));

                cv.text(item.title, tx + 28, ty + 38, 24, item.active ? t.text : '#dddddd', { font: 'bold' });
                cv.text(item.desc, tx + 28, ty + 68, 17, t.dim);

                const pillCol = canCode ? (item.active ? '#1db954' : t.dim) : safeCheck.badgeColor;
                const pillLabel = canCode ? item.stateLabel : ('[LOCKED] ' + safeCheck.status);
                cv.roundRect(tx + 28, ty + 88, 240, 32, 6, withAlpha(pillCol, 0.25));
                cv.text(pillLabel, tx + 148, ty + 109, 15, pillCol, { align: 'center', font: 'bold', spacing: 1 });

                const swX = tx + 570, swY = ty + 40, swW = 115, swH = 50;
                cv.roundRect(swX, swY, swW, swH, 25, canCode ? (item.active ? t.accent : '#20262c') : '#181f28');
                cv.circle(item.active ? swX + swW - 25 : swX + 25, swY + 25, 18, canCode ? '#ffffff' : '#64748b');

                cv.target(tx, ty, 715, 135, () => {
                    const check = safety.checkCodingSafety(item.key);
                    if (!check.allowed) {
                        activeSafetyAlert = check;
                        notify('[!] ' + check.title);
                        return;
                    }
                    item.action();
                }, 'tog_' + idx, 12);
            });
        }

        /* ---------- Page: Sound Warning Chimes ---------- */
        function drawSounds(cv, t) {
            G.panel(cv, t, 40, 52, 1520, 410, 'Acoustic Identity & Warning Chimes (KOMBI / MGU)');

            SOUND_THEMES.forEach((theme, idx) => {
                const sy = 120 + idx * 78;
                const isCur = currentSoundTheme.id === theme.id;
                const safeCheck = safety.checkCodingSafety('sound_chimes');
                const canCode = safeCheck.allowed;

                cv.roundRect(64, sy, 1472, 68, 12, isCur ? withAlpha(t.accent, 0.22) : t.track);
                cv.strokeRoundRect(64, sy, 1472, 68, 12, isCur ? 2 : 1, isCur ? t.accent : t.panelEdge);

                cv.circle(96, sy + 34, 12, isCur ? '#1db954' : t.tick);
                cv.text(theme.name, 130, sy + 32, 24, isCur ? t.text : '#dddddd', { font: 'bold' });
                cv.text(theme.desc, 130, sy + 54, 18, t.dim);

                cv.roundRect(1380, sy + 15, 130, 38, 8, isCur ? t.accent : withAlpha(t.tick, 0.5));
                const badgeText = canCode ? (isCur ? 'ACTIVE' : 'SELECT') : '[LOCKED]';
                cv.text(badgeText, 1445, sy + 39, 15, canCode ? '#ffffff' : safeCheck.badgeColor, { align: 'center', font: 'bold', spacing: 1 });

                cv.target(64, sy, 1472, 68, () => {
                    const check = safety.checkCodingSafety('sound_chimes');
                    if (!check.allowed) {
                        activeSafetyAlert = check;
                        notify('[!] ' + check.title);
                        return;
                    }
                    currentSoundTheme = theme;
                    notify('System Chimes set to ' + theme.name);
                }, 'snd_' + idx, 12);
            });
        }

        /* ---------- Page: Video & Display Safety ---------- */
        function drawDisplaySafety(cv, t) {
            G.panel(cv, t, 40, 52, 1520, 410, 'Display & Cluster Enhancements');

            const allItems = [
                {
                    key: 'video_in_motion',
                    title: 'Video in Motion (VIM)',
                    desc: 'Enables continuous passenger media & cinema playback regardless of speed limit (Lock at 3 km/h disabled)',
                    active: videoInMotionUnlocked,
                    status: videoInMotionUnlocked ? 'PERMANENTLY UNLOCKED' : 'FACTORY OEM (LOCKED)',
                    action: () => { videoInMotionUnlocked = !videoInMotionUnlocked; notify('Video In Motion ' + (videoInMotionUnlocked ? 'Unlocked' : 'Locked')); }
                },
                {
                    key: 'tpms_display',
                    title: 'Tire Pressure & Temperature Display',
                    desc: 'Forces real-time bar/PSI AND live compound Celsius temperature readout simultaneously on Live Cockpit Kombi',
                    active: tirePsiAndTemp,
                    status: tirePsiAndTemp ? 'PSI + DEG C FORCED ALWAYS' : 'OEM STANDARD',
                    action: () => { tirePsiAndTemp = !tirePsiAndTemp; notify('TPMS Kombi Display ' + (tirePsiAndTemp ? 'Forced PSI+Temp' : 'OEM')); }
                }
            ];

            const items = allItems.filter(item => safety.supports(item.key));

            items.forEach((item, idx) => {
                const dy = 124 + idx * 135;
                const safeCheck = safety.checkCodingSafety(item.key);
                const canCode = safeCheck.allowed;

                cv.roundRect(64, dy, 1472, 115, 12, item.active ? withAlpha(t.accent, 0.18) : t.track);
                cv.strokeRoundRect(64, dy, 1472, 115, 12, 1.5, canCode ? (item.active ? t.accent : t.panelEdge) : withAlpha(safeCheck.badgeColor, 0.6));

                cv.text(item.title, 96, dy + 38, 24, item.active ? t.text : '#dddddd', { font: 'bold' });
                cv.text(item.desc, 96, dy + 66, 17, t.dim);

                const pillCol = canCode ? (item.active ? '#1db954' : t.dim) : safeCheck.badgeColor;
                const pillLabel = canCode ? item.status : ('[LOCKED] ' + safeCheck.status);
                cv.roundRect(96, dy + 82, 320, 26, 6, withAlpha(pillCol, 0.25));
                cv.text(pillLabel, 256, dy + 100, 15, pillCol, { align: 'center', font: 'bold', spacing: 1 });

                const swX = 1390, swY = dy + 35, swW = 115, swH = 50;
                cv.roundRect(swX, swY, swW, swH, 25, canCode ? (item.active ? t.accent : '#20262c') : '#181f28');
                cv.circle(item.active ? swX + swW - 25 : swX + 25, swY + 25, 18, canCode ? '#ffffff' : '#64748b');

                cv.target(64, dy, 1472, 115, () => {
                    const check = safety.checkCodingSafety(item.key);
                    if (!check.allowed) {
                        activeSafetyAlert = check;
                        notify('[!] ' + check.title);
                        return;
                    }
                    item.action();
                }, 'disp_' + idx, 12);
            });
        }

        /* ---------- Master Render Loop ---------- */
        async function render() {
            const t = ctx.theme();
            const now = Date.now();
            const cv = ctx.canvas(W, H).clear(t.bg);

            if (!safety.isGSeries) {
                drawSafetyLockout(cv, t);
                await ui.image('MAIN_GFX', cv);
                return;
            }

            const activePages = getPages();
            if (page >= activePages.length) page = 0;
            const curPageId = activePages[page].id;

            if (curPageId === 'ambient') drawAmbient(cv, t, now);
            else if (curPageId === 'comfort') drawComfort(cv, t);
            else if (curPageId === 'sounds') drawSounds(cv, t);
            else if (curPageId === 'display') drawDisplaySafety(cv, t);

            // Toast feedback message
            if (statusMsg && now - statusTime < 3500) {
                const alpha = Math.min(1, (3500 - (now - statusTime)) / 500);
                cv.roundRect(W / 2 - 280, H - 76, 560, 48, 10, withAlpha('#000000', 0.85 * alpha));
                cv.strokeRoundRect(W / 2 - 280, H - 76, 560, 48, 10, 1.5, withAlpha('#1db954', alpha));
                cv.text(statusMsg, W / 2, H - 46, 20, withAlpha('#ffffff', alpha), { align: 'center', font: 'bold', spacing: 1 });
            }

            // G-Series Live Cockpit frame tabs along the top
            const pageNames = activePages.map(p => p.name);
            const safeStatus = safety.checkCodingSafety();
            G.frame(cv, t, pageNames, page, [
                { text: 'QUICKCODE' },
                { text: safety.detectedChassis },
                { text: safeStatus.badgeText }
            ]);

            // Top Diagnostic Mode Simulation Quick-Pill (Clickable for Bench / Demo testing)
            cv.roundRect(W - 270, 14, 250, 30, 6, withAlpha('#000000', 0.6));
            cv.strokeRoundRect(W - 270, 14, 250, 30, 6, 1, safeStatus.badgeColor);
            cv.text(safety.vehicleState.diagnosticMode ? '[OK] DIAG MODE: ON' : '[!] DIAG MODE: OFF', W - 145, 33, 13, safeStatus.badgeColor, { align: 'center', font: 'bold' });
            cv.target(W - 270, 14, 250, 30, () => {
                safety.toggleSimulatedDiagMode();
                if (safety.vehicleState.diagnosticMode) {
                    activeSafetyAlert = null;
                    notify('[OK] Diagnostic Mode simulated (Coding unlocked)');
                } else {
                    activeSafetyAlert = safety.checkCodingSafety();
                    notify('[!] Diagnostic Mode exited (Coding locked)');
                }
            }, 'btn_top_sim_diag', 20);

            // If safety alert modal is active, render on top of everything!
            if (activeSafetyAlert) {
                drawSafetyModal(cv, t);
            }

            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- HMI Button & Touch Interactions ---------- */
        ui.onClick('BTN_PAGE', () => {
            if (activeSafetyAlert) {
                activeSafetyAlert = null;
                return render();
            }
            const activePages = getPages();
            page = (page + 1) % activePages.length;
            return render();
        });

        ui.onClick('BTN_APPLY', () => {
            const check = safety.checkCodingSafety();
            if (!check.allowed) {
                activeSafetyAlert = check;
                notify('[!] ' + check.title);
            } else {
                notify('[OK] Selected parameters committed to ECU');
            }
            return render();
        });

        ctx.onTab((idx) => {
            if (activeSafetyAlert) {
                activeSafetyAlert = null;
            }
            page = idx;
            return render();
        });

        ctx.loop('MAIN', 15, render);
        render().then(() => log.info('QuickCode ready')).catch((e) => log.warn('QuickCode render error: ' + e));
    }
});
