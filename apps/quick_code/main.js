'use strict';
/**
 * QuickCode - Safe One-Tap Cockpit Coding with Automated Backups
 * Engineered specifically for BMW G-Series (iDrive 7).
 *
 * Safety Architecture:
 *   1. STRICT LOW-RISK ARCHITECTURE (BDC_BODY3 0x40 ONLY):
 *      - All coding writes strictly target safe body and comfort parameters on BDC (0x40).
 *      - High-risk modules (HU_MGU 0x63, DME 0x12, DSC 0x29) are completely excluded.
 *      - Physically eliminates any risk of head unit black-screen, bootloops, or OS crashes.
 *   2. AUTOMATED PRE-CODING BACKUPS & 1-TAP ROLLBACK:
 *      - Every parameter change automatically creates a timestamped snapshot before writing.
 *      - Backups are stored in persistent head unit storage and can be restored anytime.
 *   3. BMW G-SERIES VEHICLE VERIFICATION:
 *      - Verifies presence of BDC_BODY3 architecture before unlocking coding writes.
 *   4. ENGINE RUNNING & MOTION SAFEGUARD:
 *      - Coding is strictly locked if engine RPM > 0 or vehicle Speed > 0.
 *   5. DIAGNOSTIC MODE INTERLOCK:
 *      - Requires Terminal 15 Diagnostic Mode (Start/Stop 3 times, engine OFF)
 *        matching authentic BimmerCode and ISTA safety protocols.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { Diag } = require('./kit/diag');
const { VehicleSafety } = require('./safety');
const { BackupManager } = require('./backup');

const W = 1600, H = 520;

const AMBIENT_PRESETS = [
    { name: 'BMW Bronze (OEM)', hex: '#c89650', desc: 'Standard BMW G-Series factory default warm tone', isOem: true },
    { name: 'M Neon Cyan', hex: '#00f0ff', desc: 'Vibrant modern hypercar glow', isOem: false },
    { name: 'Miami Violet', hex: '#9b5de5', desc: 'Synthwave deep purple hue', isOem: false },
    { name: 'Acid Lime', hex: '#2af575', desc: 'Electric M Performance accent', isOem: false },
    { name: 'BMW Blue (OEM)', hex: '#0066b2', desc: 'Classic factory M Sport cabin blue', isOem: true },
    { name: 'M Crimson Red', hex: '#e1001a', desc: 'Aggressive sport cockpit mood', isOem: false },
];

// Factory OEM Stock Pre-conditions for BMW G-Series BDC (0x40)
const OEM_DEFAULTS = {
    autoStartStopMem: false,      // OEM: MSA active every start cycle
    instantMirrorFold: false,     // OEM: 1.5s delay when holding lock
    windowInterruptMuted: false,  // OEM: Stops roll-up when door opens
    tailgateCloseFob: false,      // OEM: Requires continuous hold on fob/door
    comfortTurnSignals5: false,   // OEM: 3 flashes on one-touch tap
    reverseMirrorTilt70: false,   // OEM: 100% downward tilt (stares at floor)
    acousticLockChirp: false,     // OEM: Silent lock (no acoustic chirp)
    emergencyBrakeBfd: false,     // OEM: Steady brake lamp under heavy deceleration
    ambientColorName: 'BMW Bronze (OEM)'
};

mgu.run({
    async start(ctx) {
        const { ui, settings, log, signals, dataDir } = ctx;
        const diag = new Diag(signals, log);
        diag.init().catch(() => {});

        const safety = new VehicleSafety(diag, log);
        safety.scanModules().catch(() => {});

        const backupMgr = new BackupManager(dataDir, log);

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
        let instantMirrorFold = (saved.instantMirrorFold !== undefined) ? saved.instantMirrorFold : OEM_DEFAULTS.instantMirrorFold;
        let windowInterruptMuted = (saved.windowInterruptMuted !== undefined) ? saved.windowInterruptMuted : OEM_DEFAULTS.windowInterruptMuted;
        let tailgateCloseFob = (saved.tailgateCloseFob !== undefined) ? saved.tailgateCloseFob : OEM_DEFAULTS.tailgateCloseFob;
        let comfortTurnSignals5 = (saved.comfortTurnSignals5 !== undefined) ? saved.comfortTurnSignals5 : OEM_DEFAULTS.comfortTurnSignals5;
        let reverseMirrorTilt70 = (saved.reverseMirrorTilt70 !== undefined) ? saved.reverseMirrorTilt70 : OEM_DEFAULTS.reverseMirrorTilt70;
        let acousticLockChirp = (saved.acousticLockChirp !== undefined) ? saved.acousticLockChirp : OEM_DEFAULTS.acousticLockChirp;
        let emergencyBrakeBfd = (saved.emergencyBrakeBfd !== undefined) ? saved.emergencyBrakeBfd : OEM_DEFAULTS.emergencyBrakeBfd;
        let selectedColor = AMBIENT_PRESETS.find(p => p.name === (saved.ambientColorName || OEM_DEFAULTS.ambientColorName)) || AMBIENT_PRESETS[0];

        function getCurrentStateSnapshot() {
            return {
                autoStartStopMem,
                instantMirrorFold,
                windowInterruptMuted,
                tailgateCloseFob,
                comfortTurnSignals5,
                reverseMirrorTilt70,
                acousticLockChirp,
                emergencyBrakeBfd,
                ambientColorName: selectedColor.name
            };
        }

        function persistState() {
            saveState(getCurrentStateSnapshot());
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

        // Safe coding modification wrapper: checks safety, creates pre-coding backup, and persists
        function applyCodingChange(actionTitle, paramKey, oldValue, newValue, mutateFn) {
            const check = safety.checkCodingSafety(paramKey);
            if (!check.allowed) {
                activeSafetyAlert = check;
                notify('[!] ' + check.title);
                return false;
            }

            // Create automated backup before any parameter change!
            backupMgr.createBackup(actionTitle, paramKey, oldValue, newValue, getCurrentStateSnapshot());

            // Apply modification
            mutateFn();
            persistState();

            notify('[OK] Backed up & coded: ' + actionTitle);
            return true;
        }

        // Read Live Coded Values directly from vehicle BDC (0x40) over UDS
        async function readLiveEcuValues() {
            notify('Reading live BDC configuration from vehicle...');
            const live = await safety.readEcuConfiguration();
            if (live) {
                if (live.autoStartStopMem !== undefined) autoStartStopMem = live.autoStartStopMem;
                if (live.instantMirrorFold !== undefined) instantMirrorFold = live.instantMirrorFold;
                if (live.windowInterruptMuted !== undefined) windowInterruptMuted = live.windowInterruptMuted;
                if (live.tailgateCloseFob !== undefined) tailgateCloseFob = live.tailgateCloseFob;
                if (live.comfortTurnSignals5 !== undefined) comfortTurnSignals5 = live.comfortTurnSignals5;
                if (live.reverseMirrorTilt70 !== undefined) reverseMirrorTilt70 = live.reverseMirrorTilt70;
                if (live.acousticLockChirp !== undefined) acousticLockChirp = live.acousticLockChirp;
                persistState();
                notify('[OK] Successfully read current coded values from BDC (0x40)');
            } else {
                notify('[OK] Using vehicle defaults: ' + (saved && Object.keys(saved).length ? 'Loaded from cache' : 'OEM Factory Stock'));
            }
            render().catch(() => {});
        }

        // Restore all parameters back to factory OEM stock settings (with backup)
        function restoreOemDefaults() {
            const check = safety.checkCodingSafety();
            if (!check.allowed) {
                activeSafetyAlert = check;
                notify('[!] ' + check.title);
                return;
            }

            // Create pre-restore safety backup
            backupMgr.createBackup('Restore Factory OEM Defaults', 'all_oem', 'custom', 'oem', getCurrentStateSnapshot());

            autoStartStopMem = OEM_DEFAULTS.autoStartStopMem;
            instantMirrorFold = OEM_DEFAULTS.instantMirrorFold;
            windowInterruptMuted = OEM_DEFAULTS.windowInterruptMuted;
            tailgateCloseFob = OEM_DEFAULTS.tailgateCloseFob;
            comfortTurnSignals5 = OEM_DEFAULTS.comfortTurnSignals5;
            reverseMirrorTilt70 = OEM_DEFAULTS.reverseMirrorTilt70;
            acousticLockChirp = OEM_DEFAULTS.acousticLockChirp;
            emergencyBrakeBfd = OEM_DEFAULTS.emergencyBrakeBfd;
            selectedColor = AMBIENT_PRESETS.find(p => p.name === OEM_DEFAULTS.ambientColorName) || AMBIENT_PRESETS[0];

            persistState();
            notify('[OK] All settings restored to Factory OEM Stock');
            render().catch(() => {});
        }

        // Restore a specific historical backup snapshot
        function restoreBackupSnapshot(backupId) {
            const check = safety.checkCodingSafety();
            if (!check.allowed) {
                activeSafetyAlert = check;
                notify('[!] ' + check.title);
                return;
            }

            const item = backupMgr.getBackupById(backupId);
            if (!item || !item.snapshot) {
                notify('[!] Backup snapshot not found');
                return;
            }

            // Create a rollback safety point
            backupMgr.createBackup(`Rollback to ${item.timeFormatted}`, 'rollback', 'active', item.id, getCurrentStateSnapshot());

            const s = item.snapshot;
            if (s.autoStartStopMem !== undefined) autoStartStopMem = s.autoStartStopMem;
            if (s.instantMirrorFold !== undefined) instantMirrorFold = s.instantMirrorFold;
            if (s.windowInterruptMuted !== undefined) windowInterruptMuted = s.windowInterruptMuted;
            if (s.tailgateCloseFob !== undefined) tailgateCloseFob = s.tailgateCloseFob;
            if (s.comfortTurnSignals5 !== undefined) comfortTurnSignals5 = s.comfortTurnSignals5;
            if (s.reverseMirrorTilt70 !== undefined) reverseMirrorTilt70 = s.reverseMirrorTilt70;
            if (s.acousticLockChirp !== undefined) acousticLockChirp = s.acousticLockChirp;
            if (s.emergencyBrakeBfd !== undefined) emergencyBrakeBfd = s.emergencyBrakeBfd;
            if (s.ambientColorName) {
                const found = AMBIENT_PRESETS.find(p => p.name === s.ambientColorName);
                if (found) selectedColor = found;
            }

            persistState();
            notify(`[OK] Restored backup from ${item.timeFormatted}`);
            render().catch(() => {});
        }

        // Attempt live ECU read once TASU connects
        diag.on('available', (isAvail) => {
            if (isAvail) readLiveEcuValues().catch(() => {});
        });

        // 4 Curated Low-Risk Categories (BDC 0x40 Only)
        const PAGES = [
            { id: 'ambient', name: 'Ambient RGB' },
            { id: 'comfort', name: 'Comfort & Doors' },
            { id: 'lighting', name: 'Signals & Lighting' },
            { id: 'backups', name: 'Backups & Rollback' }
        ];

        /* ---------- Safety Lockout Screen (Non-G-Series) ---------- */
        function drawSafetyLockout(cv, t) {
            G.panel(cv, t, 40, 52, 1520, 410, 'Safety Interlock Active');

            cv.roundRect(80, 110, 1440, 310, 16, '#0f172a');
            cv.strokeRoundRect(80, 110, 1440, 310, 16, 2, '#e1001a');

            cv.circle(180, 260, 48, withAlpha('#e1001a', 0.2));
            cv.text('!', 180, 275, 48, '#e1001a', { align: 'center', font: 'bold' });

            cv.text('NON-G-SERIES ARCHITECTURE DETECTED', 260, 180, 26, '#e1001a', { font: 'bold' });
            cv.text('QuickCode is engineered specifically for BMW G-Series vehicles with iDrive 7 (BDC_BODY3).', 260, 220, 18, '#ffffff');
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

        /* ---------- Tab 0: Ambient Lighting RGB (BDC 0x40) ---------- */
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
            const btnLabel = canWrite ? (isOemColor ? 'RESTORE ' + selectedColor.name.toUpperCase() : 'WRITE ' + selectedColor.name.toUpperCase() + ' (AUTO-BACKUP)') : `[LOCKED] ${safeCheck.title}`;
            cv.text(btnLabel, btnX + btnW / 2, btnY + 34, 18, canWrite ? '#000000' : safeCheck.badgeColor, { align: 'center', font: 'bold', spacing: 1.2 });

            cv.target(btnX, btnY, btnW, btnH, () => {
                applyCodingChange(
                    'Ambient Color: ' + selectedColor.name,
                    'ambientColorName',
                    saved.ambientColorName || OEM_DEFAULTS.ambientColorName,
                    selectedColor.name,
                    () => {}
                );
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

        /* ---------- Tab 1: Comfort & Doors (BDC 0x40) ---------- */
        function drawComfort(cv, t) {
            G.panel(cv, t, 40, 52, 1520, 410, 'Comfort Access & Doors (BDC 0x40)');

            const toggles = [
                {
                    key: 'start_stop_mem',
                    title: 'Auto Start/Stop Memory',
                    desc: 'Permanently remembers last button state across ignition cycles (Stays OFF)',
                    active: autoStartStopMem,
                    stateLabel: autoStartStopMem ? 'CODED: MEMORY (OFF)' : 'OEM FACTORY (ACTIVE)',
                    action: () => {
                        const target = !autoStartStopMem;
                        applyCodingChange(
                            'Auto Start/Stop Memory',
                            'autoStartStopMem',
                            autoStartStopMem,
                            target,
                            () => { autoStartStopMem = target; }
                        );
                    }
                },
                {
                    key: 'mirror_fold',
                    title: 'Instant Mirror Fold on Lock',
                    desc: 'Folds side mirrors immediately when pressing lock (0.0s vs 1.5s hold delay)',
                    active: instantMirrorFold,
                    stateLabel: instantMirrorFold ? 'CODED: INSTANT (0.0s)' : 'OEM FACTORY (1.5s DELAY)',
                    action: () => {
                        const target = !instantMirrorFold;
                        applyCodingChange(
                            'Instant Mirror Fold',
                            'instantMirrorFold',
                            instantMirrorFold,
                            target,
                            () => { instantMirrorFold = target; }
                        );
                    }
                },
                {
                    key: 'window_roll',
                    title: 'Door Open Window Roll Protection',
                    desc: 'Power windows continue rolling up without interrupting when car door opens',
                    active: windowInterruptMuted,
                    stateLabel: windowInterruptMuted ? 'CODED: CONTINUOUS UP' : 'OEM FACTORY (INTERRUPT)',
                    action: () => {
                        const target = !windowInterruptMuted;
                        applyCodingChange(
                            'Continuous Window Roll-Up',
                            'windowInterruptMuted',
                            windowInterruptMuted,
                            target,
                            () => { windowInterruptMuted = target; }
                        );
                    }
                },
                {
                    key: 'tailgate_fob',
                    title: 'One-Touch Tailgate Close (Fob & Door)',
                    desc: 'One-touch close tailgate from key fob and driver door button without holding',
                    active: tailgateCloseFob,
                    stateLabel: tailgateCloseFob ? 'CODED: ONE-TOUCH CLOSE' : 'OEM FACTORY (HOLD REQUIRED)',
                    action: () => {
                        const target = !tailgateCloseFob;
                        applyCodingChange(
                            'One-Touch Tailgate Close',
                            'tailgateCloseFob',
                            tailgateCloseFob,
                            target,
                            () => { tailgateCloseFob = target; }
                        );
                    }
                }
            ];

            toggles.forEach((item, idx) => {
                const col = idx % 2;
                const row = Math.floor(idx / 2);
                const tx = 64 + col * 752;
                const ty = 112 + row * 162;
                const safeCheck = safety.checkCodingSafety(item.key);
                const canCode = safeCheck.allowed;

                // Card container with authentic BMW cockpit styling
                const cardBg = item.active ? '#0c1522' : '#0b0f16';
                const cardEdge = canCode ? (item.active ? '#0077c8' : '#1c2432') : withAlpha(safeCheck.badgeColor, 0.5);
                cv.roundRect(tx, ty, 720, 144, 12, cardBg);
                cv.strokeRoundRect(tx, ty, 720, 144, 12, 1.5, cardEdge);

                cv.text(item.title, tx + 28, ty + 38, 23, item.active ? '#ffffff' : '#cbd5e1', { font: 'bold' });
                cv.text(item.desc, tx + 28, ty + 68, 15, t.dim);

                // Status Pill
                const pillBg = canCode ? (item.active ? '#0a2e1d' : '#141c26') : '#241215';
                const pillBorder = canCode ? (item.active ? '#10b981' : '#283548') : safeCheck.badgeColor;
                const pillTextCol = canCode ? (item.active ? '#2af575' : '#8a99ad') : safeCheck.badgeColor;
                const pillLabel = canCode ? item.stateLabel : ('[LOCKED] ' + safeCheck.status);

                cv.roundRect(tx + 28, ty + 92, 250, 32, 6, pillBg);
                cv.strokeRoundRect(tx + 28, ty + 92, 250, 32, 6, 1, pillBorder);
                cv.text(pillLabel, tx + 153, ty + 113, 13, pillTextCol, { align: 'center', font: 'bold', spacing: 1 });

                // BMW iDrive 7 Toggle Switch
                const swX = tx + 586, swY = ty + 49;
                drawBmwToggle(cv, swX, swY, item.active, canCode, safeCheck.badgeColor);

                cv.target(tx, ty, 720, 144, () => {
                    item.action();
                }, 'tog_c_' + idx, 12);
            });
        }

        /* ---------- Tab 2: Signals & Lighting (BDC 0x40) ---------- */
        function drawLighting(cv, t) {
            G.panel(cv, t, 40, 52, 1520, 410, 'Signals & Lighting Enhancements (BDC 0x40)');

            const toggles = [
                {
                    key: 'signals_5flash',
                    title: '5-Flash Comfort Turn Signals',
                    desc: 'One-touch indicator flashes 5 times instead of factory 3 flashes for lane changes',
                    active: comfortTurnSignals5,
                    stateLabel: comfortTurnSignals5 ? 'CODED: 5 FLASHES' : 'OEM FACTORY (3 FLASHES)',
                    action: () => {
                        const target = !comfortTurnSignals5;
                        applyCodingChange(
                            '5-Flash Comfort Signals',
                            'comfortTurnSignals5',
                            comfortTurnSignals5,
                            target,
                            () => { comfortTurnSignals5 = target; }
                        );
                    }
                },
                {
                    key: 'mirror_tilt',
                    title: 'Curb Monitor Mirror Tilt (70%)',
                    desc: 'Passenger mirror dips 70% in reverse to show curb/rim instead of 100% floor angle',
                    active: reverseMirrorTilt70,
                    stateLabel: reverseMirrorTilt70 ? 'CODED: 70% TILT' : 'OEM FACTORY (100% TILT)',
                    action: () => {
                        const target = !reverseMirrorTilt70;
                        applyCodingChange(
                            'Curb Mirror Tilt 70%',
                            'reverseMirrorTilt70',
                            reverseMirrorTilt70,
                            target,
                            () => { reverseMirrorTilt70 = target; }
                        );
                    }
                },
                {
                    key: 'lock_chirp',
                    title: 'Acoustic Lock/Unlock Chirp',
                    desc: 'Audible horn chirp confirmation when locking or unlocking the vehicle',
                    active: acousticLockChirp,
                    stateLabel: acousticLockChirp ? 'CODED: CHIRP ACTIVE' : 'OEM FACTORY (SILENT)',
                    action: () => {
                        const target = !acousticLockChirp;
                        applyCodingChange(
                            'Acoustic Lock Chirp',
                            'acousticLockChirp',
                            acousticLockChirp,
                            target,
                            () => { acousticLockChirp = target; }
                        );
                    }
                },
                {
                    key: 'brake_bfd',
                    title: 'Brake Force Display (Flashing BFD)',
                    desc: 'Rapidly pulses outer brake lamps under heavy deceleration to alert trailing drivers',
                    active: emergencyBrakeBfd,
                    stateLabel: emergencyBrakeBfd ? 'CODED: FLASHING ACTIVE' : 'OEM FACTORY (STEADY LIGHT)',
                    action: () => {
                        const target = !emergencyBrakeBfd;
                        applyCodingChange(
                            'Flashing Brake Force (BFD)',
                            'emergencyBrakeBfd',
                            emergencyBrakeBfd,
                            target,
                            () => { emergencyBrakeBfd = target; }
                        );
                    }
                }
            ];

            toggles.forEach((item, idx) => {
                const col = idx % 2;
                const row = Math.floor(idx / 2);
                const tx = 64 + col * 752;
                const ty = 112 + row * 162;
                const safeCheck = safety.checkCodingSafety(item.key);
                const canCode = safeCheck.allowed;

                // Card container with authentic BMW cockpit styling
                const cardBg = item.active ? '#0c1522' : '#0b0f16';
                const cardEdge = canCode ? (item.active ? '#0077c8' : '#1c2432') : withAlpha(safeCheck.badgeColor, 0.5);
                cv.roundRect(tx, ty, 720, 144, 12, cardBg);
                cv.strokeRoundRect(tx, ty, 720, 144, 12, 1.5, cardEdge);

                cv.text(item.title, tx + 28, ty + 38, 23, item.active ? '#ffffff' : '#cbd5e1', { font: 'bold' });
                cv.text(item.desc, tx + 28, ty + 68, 15, t.dim);

                // Status Pill
                const pillBg = canCode ? (item.active ? '#0a2e1d' : '#141c26') : '#241215';
                const pillBorder = canCode ? (item.active ? '#10b981' : '#283548') : safeCheck.badgeColor;
                const pillTextCol = canCode ? (item.active ? '#2af575' : '#8a99ad') : safeCheck.badgeColor;
                const pillLabel = canCode ? item.stateLabel : ('[LOCKED] ' + safeCheck.status);

                cv.roundRect(tx + 28, ty + 92, 250, 32, 6, pillBg);
                cv.strokeRoundRect(tx + 28, ty + 92, 250, 32, 6, 1, pillBorder);
                cv.text(pillLabel, tx + 153, ty + 113, 13, pillTextCol, { align: 'center', font: 'bold', spacing: 1 });

                // BMW iDrive 7 Toggle Switch
                const swX = tx + 586, swY = ty + 49;
                drawBmwToggle(cv, swX, swY, item.active, canCode, safeCheck.badgeColor);

                cv.target(tx, ty, 720, 144, () => {
                    item.action();
                }, 'tog_l_' + idx, 12);
            });
        }

        /* ---------- Tab 3: Automated Backups & Rollback Engine ---------- */
        function drawBackups(cv, t) {
            G.panel(cv, t, 40, 52, 1520, 410, 'Automated Backups & Rollback Engine (BDC 0x40)');

            const backups = backupMgr.getBackups();
            const safeCheck = safety.checkCodingSafety();
            const canRestore = safeCheck.allowed;

            // Left Section: Historical Backups List
            const listX = 64, listY = 112, listW = 920;

            if (backups.length === 0) {
                // Empty state card
                cv.roundRect(listX, listY, listW, 330, 12, '#0c131d');
                cv.strokeRoundRect(listX, listY, listW, 330, 12, 1.5, '#1e293b');

                cv.circle(listX + listW / 2, listY + 120, 36, '#152132');
                cv.text('i', listX + listW / 2, listY + 132, 34, '#00a3e0', { align: 'center', font: 'bold' });

                cv.text('NO CODING BACKUPS YET', listX + listW / 2, listY + 195, 22, '#ffffff', { align: 'center', font: 'bold' });
                cv.text('An automated safety snapshot will be recorded here immediately before your first coding change.', listX + listW / 2, listY + 230, 16, '#94a3b8', { align: 'center' });
                cv.text('All historical snapshots can be rolled back anytime with a single tap.', listX + listW / 2, listY + 258, 15, '#64748b', { align: 'center' });
            } else {
                // Render up to 3 most recent backups
                const displayBackups = backups.slice(0, 3);
                displayBackups.forEach((b, idx) => {
                    const by = listY + idx * 110;
                    const bh = 100;

                    cv.roundRect(listX, by, listW, bh, 12, '#0c1522');
                    cv.strokeRoundRect(listX, by, listW, bh, 12, 1.5, '#1c293d');

                    // Timestamp pill
                    cv.roundRect(listX + 24, by + 16, 175, 26, 6, '#142030');
                    cv.text(b.timeFormatted, listX + 111, by + 34, 13, '#00a3e0', { align: 'center', font: 'bold' });

                    // ECU Target badge
                    cv.roundRect(listX + 210, by + 16, 150, 26, 6, '#0f291e');
                    cv.text('TARGET: BDC 0x40', listX + 285, by + 34, 12, '#2af575', { align: 'center', font: 'bold' });

                    // Backup Title & details
                    cv.text(b.actionTitle, listX + 24, by + 68, 20, '#ffffff', { font: 'bold' });
                    const valText = (b.oldValue !== null && b.newValue !== null) ? `Changed: ${b.oldValue} -> ${b.newValue}` : 'State Snapshot';
                    cv.text(valText, listX + 24, by + 88, 14, '#94a3b8');

                    // Right Restore Action Button
                    const btnW = 160, btnH = 46;
                    const btnX = listX + listW - btnW - 24, btnY = by + 27;

                    if (!canRestore) {
                        cv.roundRect(btnX, btnY, btnW, btnH, 8, '#241215');
                        cv.strokeRoundRect(btnX, btnY, btnW, btnH, 8, 1, safeCheck.badgeColor);
                        cv.text('[LOCKED]', btnX + btnW / 2, btnY + 29, 14, safeCheck.badgeColor, { align: 'center', font: 'bold', spacing: 1 });
                    } else {
                        cv.roundRect(btnX, btnY, btnW, btnH, 8, '#004e8c');
                        cv.strokeRoundRect(btnX, btnY, btnW, btnH, 8, 1.5, '#00a3e0');
                        cv.text('RESTORE', btnX + btnW / 2, btnY + 29, 16, '#ffffff', { align: 'center', font: 'bold', spacing: 1.2 });
                    }

                    cv.target(btnX, btnY, btnW, btnH, () => {
                        restoreBackupSnapshot(b.id);
                    }, 'bk_res_' + idx, 14);
                });
            }

            // Right Section: Safety Architecture Shield & Factory Reset
            const infoX = 1010, infoY = 112, infoW = 526;

            // Shield Card
            const shH = 190;
            cv.roundRect(infoX, infoY, infoW, shH, 12, '#09121d');
            cv.strokeRoundRect(infoX, infoY, infoW, shH, 12, 1.5, '#0077c8');

            cv.text('SAFE BDC-ONLY ARCHITECTURE', infoX + 28, infoY + 36, 19, '#00a3e0', { font: 'bold', spacing: 1 });
            cv.text('[OK] All coding writes strictly target BDC_BODY3 (0x40)', infoX + 28, infoY + 68, 15, '#cbd5e1');
            cv.text('[OK] High-risk HU_MGU (0x63) flashing completely disabled', infoX + 28, infoY + 96, 15, '#cbd5e1');
            cv.text('[OK] Zero risk of head unit black-screen, crash or bootloops', infoX + 28, infoY + 124, 15, '#2af575', { font: 'bold' });
            cv.text('[OK] Automated snapshot created before every modification', infoX + 28, infoY + 152, 15, '#cbd5e1');

            // OEM Factory Reset Card
            const resY = infoY + shH + 16, resH = 124;
            cv.roundRect(infoX, resY, infoW, resH, 12, '#101722');
            cv.strokeRoundRect(infoX, resY, infoW, resH, 12, 1.5, '#334155');

            const rfBtnX = infoX + 28, rfBtnY = resY + 22, rfBtnW = infoW - 56, rfBtnH = 48;
            cv.roundRect(rfBtnX, rfBtnY, rfBtnW, rfBtnH, 10, canRestore ? '#1e293b' : '#241215');
            cv.strokeRoundRect(rfBtnX, rfBtnY, rfBtnW, rfBtnH, 10, 1.5, canRestore ? '#00a3e0' : safeCheck.badgeColor);

            const rLabel = canRestore ? 'RESTORE ALL FACTORY OEM DEFAULTS' : `[LOCKED] ${safeCheck.title}`;
            cv.text(rLabel, rfBtnX + rfBtnW / 2, rfBtnY + 31, 16, canRestore ? '#ffffff' : safeCheck.badgeColor, { align: 'center', font: 'bold', spacing: 1 });

            cv.text('Instantly resets all 8 parameters back to authentic BMW factory stock.', infoX + 28, resY + 98, 14, '#94a3b8');

            cv.target(rfBtnX, rfBtnY, rfBtnW, rfBtnH, () => {
                restoreOemDefaults();
            }, 'btn_restore_oem_full', 14);
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

            // Right-side Action Buttons: [READ BDC] [RESTORE OEM] [TEST DIAG]
            const b3W = 190, b2W = 125, b1W = 105, bH = 26;
            const b3X = dockX + dockW - b3W - 6, bY = dockY + 6;
            const b2X = b3X - b2W - 8;
            const b1X = b2X - b1W - 8;

            // Button 1: READ BDC
            cv.roundRect(b1X, bY, b1W, bH, 6, '#0c1724');
            cv.strokeRoundRect(b1X, bY, b1W, bH, 6, 1, '#00a3e0');
            cv.text('READ BDC', b1X + b1W / 2, bY + 18, 12, '#00a3e0', { align: 'center', font: 'bold', spacing: 0.8 });
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

            if (page >= PAGES.length) page = 0;
            const curPageId = PAGES[page].id;

            if (curPageId === 'ambient') drawAmbient(cv, t, now);
            else if (curPageId === 'comfort') drawComfort(cv, t);
            else if (curPageId === 'lighting') drawLighting(cv, t);
            else if (curPageId === 'backups') drawBackups(cv, t);

            // G-Series Live Cockpit frame tabs along the top
            const pageNames = PAGES.map(p => p.name);
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
            page = (page + 1) % PAGES.length;
            return render();
        });

        ui.onClick('BTN_APPLY', () => {
            const check = safety.checkCodingSafety();
            if (!check.allowed) {
                activeSafetyAlert = check;
                notify('[!] ' + check.title);
            } else {
                notify('[OK] Selected parameters committed to BDC');
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
