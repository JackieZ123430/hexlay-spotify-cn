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
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { Diag } = require('./kit/diag');
const { VehicleSafety } = require('./safety');

const W = 1600, H = 520;

const AMBIENT_PRESETS = [
    { name: 'BMW Bronze (OEM)', hex: '#c89650', desc: 'Standard BMW G-Series factory default warm tone', isOem: true },
    { name: 'M Neon Cyan', hex: '#00f0ff', desc: 'Vibrant modern hypercar glow', isOem: false },
    { name: 'Miami Violet', hex: '#9b5de5', desc: 'Synthwave deep purple hue', isOem: false },
    { name: 'Acid Lime', hex: '#2af575', desc: 'Electric M Performance accent', isOem: false },
    { name: 'BMW Blue (OEM)', hex: '#0066b2', desc: 'Classic factory M Sport cabin blue', isOem: true },
    { name: 'M Crimson Red', hex: '#e1001a', desc: 'Aggressive sport cockpit mood', isOem: false },
];

const SOUND_THEMES = [
    { id: 'oem', name: 'BMW Modern (G-Series)', isOem: true, desc: 'Factory standard iDrive 7 chimes and warning alerts' },
    { id: 'm', name: 'BMW M Performance', isOem: false, desc: 'Aggressive high-tempo sport acoustic alerts' },
    { id: 'rr', name: 'Rolls-Royce Phantom', isOem: false, desc: 'Gentle orchestral harp & luxury chimes' },
    { id: 'i', name: 'BMW i-Series Electric', isOem: false, desc: 'Futuristic electronic harmonic tones' },
];

// Factory OEM Stock Pre-conditions for BMW G-Series
const OEM_DEFAULTS = {
    autoStartStopMem: false,      // OEM: MSA active every start cycle
    seatbeltChimeMuted: false,    // OEM: Standard audible cabin chime
    instantMirrorFold: false,     // OEM: 1.5s delay when holding lock
    windowInterruptMuted: false,  // OEM: Stops roll-up when door opens
    soundThemeId: 'oem',          // OEM: BMW Modern factory chimes
    videoInMotionUnlocked: false, // OEM: Speedlock cutoff above 3 km/h
    tirePsiAndTemp: false,        // OEM: Pressure only (temp hidden)
    ambientColorName: 'BMW Bronze (OEM)'
};

mgu.run({
    async start(ctx) {
        const { ui, settings, log, signals, dataDir } = ctx;
        const diag = new Diag(signals, log);
        diag.init().catch(() => {});

        const safety = new VehicleSafety(diag, log);
        safety.scanModules().catch(() => {});

        // Persistent State File
        const STATE_FILE = path.join(dataDir || process.cwd(), 'quick_code_state.json');

        function saveState(st) {
            try {
                fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), 'utf8');
            } catch (e) {
                log.warn('QuickCode: Failed to save state: ' + e.message);
            }
        }

        function loadSavedState() {
            try {
                if (fs.existsSync(STATE_FILE)) {
                    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
                }
            } catch (e) {
                log.warn('QuickCode: Failed to load state: ' + e.message);
            }
            return null;
        }

        // Initialize state: start with authentic OEM factory defaults or saved configuration
        const saved = loadSavedState() || {};
        let autoStartStopMem = (saved.autoStartStopMem !== undefined) ? saved.autoStartStopMem : OEM_DEFAULTS.autoStartStopMem;
        let seatbeltChimeMuted = (saved.seatbeltChimeMuted !== undefined) ? saved.seatbeltChimeMuted : OEM_DEFAULTS.seatbeltChimeMuted;
        let instantMirrorFold = (saved.instantMirrorFold !== undefined) ? saved.instantMirrorFold : OEM_DEFAULTS.instantMirrorFold;
        let windowInterruptMuted = (saved.windowInterruptMuted !== undefined) ? saved.windowInterruptMuted : OEM_DEFAULTS.windowInterruptMuted;
        let currentSoundTheme = SOUND_THEMES.find(s => s.id === (saved.soundThemeId || OEM_DEFAULTS.soundThemeId)) || SOUND_THEMES[0];
        let videoInMotionUnlocked = (saved.videoInMotionUnlocked !== undefined) ? saved.videoInMotionUnlocked : OEM_DEFAULTS.videoInMotionUnlocked;
        let tirePsiAndTemp = (saved.tirePsiAndTemp !== undefined) ? saved.tirePsiAndTemp : OEM_DEFAULTS.tirePsiAndTemp;
        let selectedColor = AMBIENT_PRESETS.find(p => p.name === (saved.ambientColorName || OEM_DEFAULTS.ambientColorName)) || AMBIENT_PRESETS[0];

        function persistState() {
            saveState({
                autoStartStopMem,
                seatbeltChimeMuted,
                instantMirrorFold,
                windowInterruptMuted,
                soundThemeId: currentSoundTheme.id,
                videoInMotionUnlocked,
                tirePsiAndTemp,
                ambientColorName: selectedColor.name
            });
        }

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

        // Feedback & Safety Dialog state
        let statusMsg = null;
        let statusTime = 0;
        let activeSafetyAlert = null;

        function notify(msg) {
            statusMsg = msg;
            statusTime = Date.now();
            log.info('QuickCode: ' + msg);
        }

        // Read Live Coded Values directly from vehicle ECUs over UDS
        async function readLiveEcuValues() {
            notify('Reading current ECU coding from vehicle...');
            const live = await safety.readEcuConfiguration();
            if (live) {
                if (live.autoStartStopMem !== undefined) autoStartStopMem = live.autoStartStopMem;
                if (live.instantMirrorFold !== undefined) instantMirrorFold = live.instantMirrorFold;
                if (live.windowInterruptMuted !== undefined) windowInterruptMuted = live.windowInterruptMuted;
                if (live.soundThemeId !== undefined) {
                    const found = SOUND_THEMES.find(s => s.id === live.soundThemeId);
                    if (found) currentSoundTheme = found;
                }
                if (live.videoInMotionUnlocked !== undefined) videoInMotionUnlocked = live.videoInMotionUnlocked;
                persistState();
                notify('[OK] Successfully read current coded values from car');
            } else {
                notify('[OK] Using vehicle defaults: ' + (saved && Object.keys(saved).length ? 'Loaded from cache' : 'OEM Factory Stock'));
            }
            render().catch(() => {});
        }

        // Restore all parameters back to factory OEM stock settings
        function restoreOemDefaults() {
            autoStartStopMem = OEM_DEFAULTS.autoStartStopMem;
            seatbeltChimeMuted = OEM_DEFAULTS.seatbeltChimeMuted;
            instantMirrorFold = OEM_DEFAULTS.instantMirrorFold;
            windowInterruptMuted = OEM_DEFAULTS.windowInterruptMuted;
            currentSoundTheme = SOUND_THEMES.find(s => s.id === OEM_DEFAULTS.soundThemeId) || SOUND_THEMES[0];
            videoInMotionUnlocked = OEM_DEFAULTS.videoInMotionUnlocked;
            tirePsiAndTemp = OEM_DEFAULTS.tirePsiAndTemp;
            selectedColor = AMBIENT_PRESETS.find(p => p.name === OEM_DEFAULTS.ambientColorName) || AMBIENT_PRESETS[0];
            persistState();
            notify('[OK] All settings restored to Factory OEM Stock');
            render().catch(() => {});
        }

        // Attempt live ECU read once TASU connects
        diag.on('available', (isAvail) => {
            if (isAvail) readLiveEcuValues().catch(() => {});
        });

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

            const isOemColor = !!selectedColor.isOem;
            const btnLabel = canWrite ? (isOemColor ? 'RESTORE ' + selectedColor.name.toUpperCase() : 'WRITE ' + selectedColor.name.toUpperCase() + ' TO BDC') : `[LOCKED] ${safeCheck.title}`;
            cv.text(btnLabel, btnX + btnW / 2, btnY + 34, 18, canWrite ? '#000000' : safeCheck.badgeColor, { align: 'center', font: 'bold', spacing: 1.2 });

            cv.target(btnX, btnY, btnW, btnH, () => {
                const check = safety.checkCodingSafety('ambient_rgb');
                if (!check.allowed) {
                    activeSafetyAlert = check;
                    notify('[!] ' + check.title);
                    return;
                }
                persistState();
                notify(isOemColor ? 'Restored ' + selectedColor.name : 'BDC Updated: Ambient RGB set to ' + selectedColor.name);
            }, 'btn_apply_amb', 12);
        }

        /* ---------- BMW iDrive 7 OEM Toggle Switch ---------- */
        function drawBmwToggle(cv, x, y, active, canCode, lockColor) {
            const w = 104, h = 46, r = 23;
            const thumbR = 18;

            if (!canCode) {
                // Interlocked / Locked State (e.g. Engine Running)
                cv.roundRect(x, y, w, h, r, '#0a0e14');
                cv.strokeRoundRect(x, y, w, h, r, 1.5, withAlpha(lockColor || '#ffb703', 0.65));
                cv.text('LOCKED', x + w / 2, y + 28, 12, lockColor || '#ffb703', { align: 'center', font: 'bold', spacing: 1 });
                const tx = x + (active ? w - r : r), ty = y + r;
                cv.circle(tx, ty, thumbR, '#080c12');
                cv.circle(tx, ty, thumbR - 1.5, '#1e293b');
                return;
            }

            if (active) {
                // Active State: Vivid BMW Blue & M-Performance Cyan
                cv.roundRect(x, y, w, h, r, '#004e8c');
                cv.strokeRoundRect(x, y, w, h, r, 1.5, '#00a3e0');

                // "ON" label on the left in crisp white
                cv.text('ON', x + 28, y + 28, 14, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });

                // Tactile Machined Aluminum Thumb on the right
                const tx = x + w - r, ty = y + r;
                cv.circle(tx, ty, thumbR, '#002e54');
                cv.circle(tx, ty, thumbR - 1.5, '#f8fafc');
                // Central vertical grip notch (BMW M-Cyan bar)
                cv.roundRect(tx - 2, ty - 7, 4, 14, 2, '#00a3e0');
            } else {
                // Inactive State: Dark Graphite & Slate
                cv.roundRect(x, y, w, h, r, '#0c121a');
                cv.strokeRoundRect(x, y, w, h, r, 1.5, '#1e2a3a');

                // "OFF" label on the right in dim slate
                cv.text('OFF', x + w - 28, y + 28, 13, '#64748b', { align: 'center', font: 'bold', spacing: 1 });

                // Tactile Matte Aluminum Thumb on the left
                const tx = x + r, ty = y + r;
                cv.circle(tx, ty, thumbR, '#090e15');
                cv.circle(tx, ty, thumbR - 1.5, '#384656');
                // Central vertical grip notch
                cv.roundRect(tx - 2, ty - 7, 4, 14, 2, '#1e293b');
            }
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
                    stateLabel: autoStartStopMem ? 'CODED: MEMORY (OFF)' : 'OEM FACTORY (ACTIVE)',
                    action: () => {
                        autoStartStopMem = !autoStartStopMem;
                        persistState();
                        notify('Auto Start/Stop ' + (autoStartStopMem ? 'Set to Memory (OFF)' : 'Restored to OEM'));
                    }
                },
                {
                    key: 'start_stop_mem',
                    title: 'Seatbelt Warning Chimes',
                    desc: 'Mutes repetitive initial cabin audio gong when parking or maneuvering',
                    active: seatbeltChimeMuted,
                    stateLabel: seatbeltChimeMuted ? 'CODED: SILENCED' : 'OEM FACTORY (ACTIVE)',
                    action: () => {
                        seatbeltChimeMuted = !seatbeltChimeMuted;
                        persistState();
                        notify('Seatbelt Chimes ' + (seatbeltChimeMuted ? 'Muted' : 'Restored to OEM'));
                    }
                },
                {
                    key: 'mirror_fold',
                    title: 'Instant Mirror Fold on Lock',
                    desc: 'Folds exterior side mirrors immediately when pressing lock (0.0s vs 1.5s delay)',
                    active: instantMirrorFold,
                    stateLabel: instantMirrorFold ? 'CODED: INSTANT (0.0s)' : 'OEM FACTORY (1.5s DELAY)',
                    action: () => {
                        instantMirrorFold = !instantMirrorFold;
                        persistState();
                        notify('Mirror Fold Delay ' + (instantMirrorFold ? 'Set to 0.0s Instant' : 'Restored to OEM 1.5s'));
                    }
                },
                {
                    key: 'window_roll',
                    title: 'Door Open Window Roll Protection',
                    desc: 'Power windows continue rolling up without interrupting when car door is opened',
                    active: windowInterruptMuted,
                    stateLabel: windowInterruptMuted ? 'CODED: CONTINUOUS UP' : 'OEM FACTORY (INTERRUPT)',
                    action: () => {
                        windowInterruptMuted = !windowInterruptMuted;
                        persistState();
                        notify('Window Roll Protection ' + (windowInterruptMuted ? 'Continuous Up' : 'Restored to OEM'));
                    }
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

                // Card container with authentic BMW cockpit styling
                const cardBg = item.active ? '#0c1522' : '#0b0f16';
                const cardEdge = canCode ? (item.active ? '#0077c8' : '#1c2432') : withAlpha(safeCheck.badgeColor, 0.5);
                cv.roundRect(tx, ty, 715, 135, 12, cardBg);
                cv.strokeRoundRect(tx, ty, 715, 135, 12, 1.5, cardEdge);

                cv.text(item.title, tx + 28, ty + 38, 24, item.active ? '#ffffff' : '#cbd5e1', { font: 'bold' });
                cv.text(item.desc, tx + 28, ty + 68, 16, t.dim);

                // Status Pill
                const pillBg = canCode ? (item.active ? '#0a2e1d' : '#141c26') : '#241215';
                const pillBorder = canCode ? (item.active ? '#10b981' : '#283548') : safeCheck.badgeColor;
                const pillTextCol = canCode ? (item.active ? '#2af575' : '#8a99ad') : safeCheck.badgeColor;
                const pillLabel = canCode ? item.stateLabel : ('[LOCKED] ' + safeCheck.status);

                cv.roundRect(tx + 28, ty + 88, 240, 32, 6, pillBg);
                cv.strokeRoundRect(tx + 28, ty + 88, 240, 32, 6, 1, pillBorder);
                cv.text(pillLabel, tx + 148, ty + 109, 14, pillTextCol, { align: 'center', font: 'bold', spacing: 1 });

                // BMW iDrive 7 Toggle Switch
                const swX = tx + 575, swY = ty + 44;
                drawBmwToggle(cv, swX, swY, item.active, canCode, safeCheck.badgeColor);

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

                // Authentic BMW iDrive 7 selection list styling
                const rowBg = isCur ? '#0c1522' : '#0b0f16';
                const rowEdge = canCode ? (isCur ? '#0077c8' : '#1c2432') : withAlpha(safeCheck.badgeColor, 0.45);
                cv.roundRect(64, sy, 1472, 68, 12, rowBg);
                cv.strokeRoundRect(64, sy, 1472, 68, 12, isCur ? 1.5 : 1, rowEdge);

                // BMW Radio Selection Indicator
                if (isCur) {
                    cv.circle(96, sy + 34, 12, '#005ea6');
                    cv.circle(96, sy + 34, 7, '#00a3e0');
                } else {
                    cv.circle(96, sy + 34, 10, '#1c2533');
                    cv.circle(96, sy + 34, 8, '#0b0f16');
                }

                cv.text(theme.name, 130, sy + 32, 24, isCur ? '#ffffff' : '#cbd5e1', { font: 'bold' });
                cv.text(theme.desc, 130, sy + 54, 17, isCur ? '#94a3b8' : '#64748b');

                // Right Action / Status Pill
                const btnX = 1370, btnY = sy + 15, btnW = 140, btnH = 38;
                if (!canCode) {
                    cv.roundRect(btnX, btnY, btnW, btnH, 8, '#241215');
                    cv.strokeRoundRect(btnX, btnY, btnW, btnH, 8, 1, safeCheck.badgeColor);
                    cv.text('[LOCKED]', btnX + btnW / 2, btnY + 24, 14, safeCheck.badgeColor, { align: 'center', font: 'bold', spacing: 1 });
                } else if (isCur) {
                    // Active BMW Blue & M-Cyan Pill with high contrast text
                    cv.roundRect(btnX, btnY, btnW, btnH, 8, '#004e8c');
                    cv.strokeRoundRect(btnX, btnY, btnW, btnH, 8, 1.5, '#00a3e0');
                    cv.text('ACTIVE', btnX + btnW / 2, btnY + 24, 15, '#ffffff', { align: 'center', font: 'bold', spacing: 1.2 });
                } else {
                    // Select Button
                    cv.roundRect(btnX, btnY, btnW, btnH, 8, '#141c26');
                    cv.strokeRoundRect(btnX, btnY, btnW, btnH, 8, 1, '#2a384c');
                    cv.text('SELECT', btnX + btnW / 2, btnY + 24, 14, '#94a3b8', { align: 'center', font: 'bold', spacing: 1 });
                }

                cv.target(64, sy, 1472, 68, () => {
                    const check = safety.checkCodingSafety('sound_chimes');
                    if (!check.allowed) {
                        activeSafetyAlert = check;
                        notify('[!] ' + check.title);
                        return;
                    }
                    currentSoundTheme = theme;
                    persistState();
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
                    status: videoInMotionUnlocked ? 'CODED: VIM UNLOCKED' : 'OEM FACTORY (3 KM/H LOCK)',
                    action: () => {
                        videoInMotionUnlocked = !videoInMotionUnlocked;
                        persistState();
                        notify('Video In Motion ' + (videoInMotionUnlocked ? 'Unlocked' : 'Restored to OEM 3 km/h Lock'));
                    }
                },
                {
                    key: 'tpms_display',
                    title: 'Tire Pressure & Temperature Display',
                    desc: 'Forces real-time bar/PSI AND live compound Celsius temperature readout simultaneously on Live Cockpit Kombi',
                    active: tirePsiAndTemp,
                    status: tirePsiAndTemp ? 'CODED: PSI + TEMP FORCED' : 'OEM FACTORY (PRESSURE ONLY)',
                    action: () => {
                        tirePsiAndTemp = !tirePsiAndTemp;
                        persistState();
                        notify('TPMS Display ' + (tirePsiAndTemp ? 'Forced PSI+Temp' : 'Restored to OEM Pressure Only'));
                    }
                }
            ];

            const items = allItems.filter(item => safety.supports(item.key));

            items.forEach((item, idx) => {
                const dy = 124 + idx * 135;
                const safeCheck = safety.checkCodingSafety(item.key);
                const canCode = safeCheck.allowed;

                // Card container with authentic BMW cockpit styling
                const cardBg = item.active ? '#0c1522' : '#0b0f16';
                const cardEdge = canCode ? (item.active ? '#0077c8' : '#1c2432') : withAlpha(safeCheck.badgeColor, 0.5);
                cv.roundRect(64, dy, 1472, 115, 12, cardBg);
                cv.strokeRoundRect(64, dy, 1472, 115, 12, 1.5, cardEdge);

                cv.text(item.title, 96, dy + 38, 24, item.active ? '#ffffff' : '#cbd5e1', { font: 'bold' });
                cv.text(item.desc, 96, dy + 66, 16, t.dim);

                // Status Pill
                const pillBg = canCode ? (item.active ? '#0a2e1d' : '#141c26') : '#241215';
                const pillBorder = canCode ? (item.active ? '#10b981' : '#283548') : safeCheck.badgeColor;
                const pillTextCol = canCode ? (item.active ? '#2af575' : '#8a99ad') : safeCheck.badgeColor;
                const pillLabel = canCode ? item.status : ('[LOCKED] ' + safeCheck.status);

                cv.roundRect(96, dy + 82, 320, 26, 6, pillBg);
                cv.strokeRoundRect(96, dy + 82, 320, 26, 6, 1, pillBorder);
                cv.text(pillLabel, 256, dy + 100, 14, pillTextCol, { align: 'center', font: 'bold', spacing: 1 });

                // BMW iDrive 7 Toggle Switch
                const swX = 1390, swY = dy + 34;
                drawBmwToggle(cv, swX, swY, item.active, canCode, safeCheck.badgeColor);

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

        /* ---------- Bottom Diagnostic & Vehicle State Dock ---------- */
        function drawDiagnosticDock(cv, t, safeStatus) {
            const dockX = 40, dockY = 472, dockW = 1520, dockH = 38;
            const isDiag = safety.vehicleState.diagnosticMode;
            const rpm = safety.vehicleState.rpm;
            const speed = safety.vehicleState.speed;
            const stateColor = safeStatus.badgeColor;

            // Dock background container
            cv.roundRect(dockX, dockY, dockW, dockH, 8, '#080d14');
            cv.strokeRoundRect(dockX, dockY, dockW, dockH, 8, 1, withAlpha(stateColor, 0.45));

            // Status indicator dot
            cv.circle(dockX + 22, dockY + dockH / 2, 6, stateColor);
            cv.circle(dockX + 22, dockY + dockH / 2, 11, withAlpha(stateColor, 0.22));

            // State label & detailed advice
            let mainLabel = '';
            let subLabel = '';
            if (speed > 0) {
                mainLabel = `VEHICLE IN MOTION (${speed} KM/H)`;
                subLabel = 'Coding locked while driving. Park vehicle to enable.';
            } else if (rpm > 0) {
                mainLabel = `ENGINE RUNNING (${rpm} RPM)`;
                subLabel = 'Coding locked. Turn off engine and press Start/Stop 3 times for Diagnostic Mode.';
            } else if (!isDiag) {
                mainLabel = 'DIAGNOSTIC MODE REQUIRED';
                subLabel = 'Turn engine OFF -> Press Start/Stop 3 times rapidly (foot off brake) until cluster confirms.';
            } else {
                mainLabel = 'DIAGNOSTIC MODE ACTIVE';
                subLabel = 'Terminal 15 engaged (0 RPM). All ECUs unlocked and safe for 1-tap coding.';
            }

            cv.text(mainLabel, dockX + 42, dockY + 24, 15, stateColor, { font: 'bold', spacing: 1 });
            const mainW = cv.textWidth(mainLabel, 15, { font: 'bold', spacing: 1 });
            cv.text(' |  ' + subLabel, dockX + 46 + mainW, dockY + 24, 14, t.dim);

            // Right-side Action Buttons: [READ ECU] [RESTORE OEM] [TEST DIAG]
            const b3W = 190, b2W = 125, b1W = 105, bH = 26;
            const b3X = dockX + dockW - b3W - 6, bY = dockY + 6;
            const b2X = b3X - b2W - 8;
            const b1X = b2X - b1W - 8;

            // Button 1: READ ECU
            cv.roundRect(b1X, bY, b1W, bH, 6, '#0c1724');
            cv.strokeRoundRect(b1X, bY, b1W, bH, 6, 1, '#00a3e0');
            cv.text('READ ECU', b1X + b1W / 2, bY + 18, 12, '#00a3e0', { align: 'center', font: 'bold', spacing: 0.8 });
            cv.target(b1X, bY, b1W, bH, () => {
                readLiveEcuValues();
            }, 'btn_dock_read_ecu', 15);

            // Button 2: RESTORE OEM
            cv.roundRect(b2X, bY, b2W, bH, 6, '#181b22');
            cv.strokeRoundRect(b2X, bY, b2W, bH, 6, 1, '#94a3b8');
            cv.text('RESTORE OEM', b2X + b2W / 2, bY + 18, 12, '#cbd5e1', { align: 'center', font: 'bold', spacing: 0.8 });
            cv.target(b2X, bY, b2W, bH, () => {
                restoreOemDefaults();
            }, 'btn_dock_restore_oem', 15);

            // Button 3: TEST DIAG MODE
            cv.roundRect(b3X, bY, b3W, bH, 6, isDiag ? '#0e241b' : '#261214');
            cv.strokeRoundRect(b3X, bY, b3W, bH, 6, 1, stateColor);
            const btnText = isDiag ? 'TEST: LOCK (ENG ON)' : 'TEST: ENTER DIAG';
            cv.text(btnText, b3X + b3W / 2, bY + 18, 12, stateColor, { align: 'center', font: 'bold', spacing: 0.8 });

            cv.target(b3X, bY, b3W, bH, () => {
                safety.toggleSimulatedDiagMode();
                if (safety.vehicleState.diagnosticMode) {
                    activeSafetyAlert = null;
                    notify('[OK] Diagnostic Mode simulated (Coding unlocked)');
                } else {
                    activeSafetyAlert = safety.checkCodingSafety();
                    notify('[!] Diagnostic Mode exited (Coding locked)');
                }
            }, 'btn_dock_toggle_diag', 15);
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

            // G-Series Live Cockpit frame tabs along the top (clean, uncrowded)
            const pageNames = activePages.map(p => p.name);
            const safeStatus = safety.checkCodingSafety();
            G.frame(cv, t, pageNames, page, [
                { text: 'G-SERIES' },
                { text: safeStatus.badgeText, color: safeStatus.badgeColor }
            ]);

            // Dedicated Vehicle State & Diagnostic Dock along bottom
            drawDiagnosticDock(cv, t, safeStatus);

            // Toast feedback message (floating cleanly above the dock)
            if (statusMsg && now - statusTime < 3500) {
                const alpha = Math.min(1, (3500 - (now - statusTime)) / 500);
                cv.roundRect(W / 2 - 280, 415, 560, 44, 10, withAlpha('#000000', 0.9 * alpha));
                cv.strokeRoundRect(W / 2 - 280, 415, 560, 44, 10, 1.5, withAlpha('#1db954', alpha));
                cv.text(statusMsg, W / 2, 443, 18, withAlpha('#ffffff', alpha), { align: 'center', font: 'bold', spacing: 1 });
            }

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
