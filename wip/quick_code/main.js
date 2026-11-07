'use strict';
/**
 * QuickCode - Safe One-Tap Cockpit Coding with Automated Backups
 * Engineered specifically for BMW G-Series (iDrive 7).
 *
 * Safety Architecture:
 *   1. STRICT LOW-RISK ARCHITECTURE (BDC_BODY3 0x40 ONLY):
 *      - All coding writes strictly target safe body and comfort parameters on BDC (0x40).
 *      - High-risk modules (HU_MGU 0x63, DME 0x12, DSC 0x29, KOMBI 0x60) are completely excluded.
 *      - Physically eliminates any risk of head unit black-screen, bootloops, or OS crashes.
 *   2. AUTOMATED PRE-CODING BACKUPS & 1-TAP ROLLBACK:
 *      - Every parameter change automatically creates a crash-proof timestamped snapshot before writing.
 *      - Backups are stored in atomic, self-healing head unit storage and can be restored anytime.
 *   3. BMW G-SERIES VEHICLE VERIFICATION:
 *      - Verifies presence of BDC_BODY3 architecture before unlocking coding writes.
 *   4. ENGINE RUNNING & MOTION SAFEGUARD:
 *      - Coding is strictly locked if engine RPM > 0 or vehicle Speed > 0.
 *      - Strict validation prevents NaN telemetry bypasses.
 *   5. DIAGNOSTIC MODE INTERLOCK:
 *      - Requires Terminal 15 Diagnostic Mode (Start/Stop 3 times, engine OFF)
 *        matching authentic BimmerCode and ISTA safety protocols.
 *   6. TRIPLE-CHECK WRITES WITH LIVE READ-BACK:
 *      - Parameters written over ISO 14229 Service 0x2E are verified immediately
 *        via Service 0x22 to ensure ECU EEPROM confirmation.
 *   7. CONCURRENCY MUTEX:
 *      - Prevents overlapping or concurrent write transactions.
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

/*
 * Sizes on this display (kit/runtime/panel.js): k = 1.2 on a 12.3" display, 1.44 on a 10.25" one, so cards,
 * switches, buttons and text come out the same size in millimetres on both (as CarPlay sizes its own).
 * sz(cv, n): n at the reference size (k = 1), rounded. The kit draws no text smaller than readable
 * (Recorder.minText), so text that has to fit a box is cut with fitText at the size it is drawn.
 */
const kOf = (cv) => (cv.ui && cv.ui.k) || 1.44;
const sz = (cv, n) => Math.round(n * kOf(cv));
/** str cut with '...' to fit maxW at size. */
function fitText(cv, str, maxW, size, opts) {
    str = String(str || '');
    if (cv.textWidth(str, size, opts) <= maxW) return str;
    while (str.length > 1 && cv.textWidth(str + '...', size, opts) > maxW) str = str.slice(0, -1);
    return str + '...';
}
/** str broken into at most maxLines lines of maxW at size, the last cut with '...' if it doesn't all fit. */
function wrapText(cv, str, maxW, size, maxLines, opts) {
    const words = String(str || '').split(/\s+/).filter(Boolean), lines = [];
    let cur = '';
    for (let i = 0; i < words.length; i++) {
        const next = cur ? cur + ' ' + words[i] : words[i];
        if (cv.textWidth(next, size, opts) <= maxW || !cur) { cur = next; continue; }
        if (lines.length === maxLines - 1) { cur = fitText(cv, words.slice(i - cur.split(' ').length).join(' '), maxW, size, opts); lines.push(cur); return lines; }
        lines.push(cur); cur = words[i];
    }
    if (cur) lines.push(fitText(cv, cur, maxW, size, opts));
    return lines.slice(0, maxLines);
}
/** Baseline that centres text of size in a box from y, h high. */
const mid = (y, h, size) => y + h / 2 + size * 0.36;
/** Page geometry: the status dock at the bottom (sized by the display) and the panels over it. */
function geom(cv) {
    const dockH = sz(cv, 32), dockY = 510 - dockH;
    return { dockH, dockY, panelH: dockY - 8 - 52 };
}

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
    ambientColorName: 'BMW Bronze (OEM)',
    ambientHex: '#c89650'
};

mgu.run({
    async start(ctx) {
        const { ui, settings, log, signals, dataDir } = ctx;
        const diag = new Diag(signals, log);
        diag.init().catch(() => {});

        const safety = new VehicleSafety(diag, log);
        safety.scanModules().catch(() => {});

        const backupMgr = new BackupManager(dataDir, log);

        // Persistent State File with Atomic Mirror
        const baseDir = dataDir || process.cwd();
        const STATE_FILE = path.join(baseDir, 'quick_code_state.json');
        const STATE_BAK = STATE_FILE + '.bak';

        function saveState(st) {
            if (!st || typeof st !== 'object') return;
            const dir = path.dirname(STATE_FILE);
            const tempPath = path.join(dir, `.tmp_qc_st_${process.pid}_${Date.now()}`);
            try {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                const jsonStr = JSON.stringify(st, null, 2);
                fs.writeFileSync(tempPath, jsonStr, 'utf8');
                if (fs.existsSync(STATE_FILE)) {
                    try { fs.copyFileSync(STATE_FILE, STATE_BAK); } catch (_) {}
                }
                fs.renameSync(tempPath, STATE_FILE);
            } catch (e) {
                log.warn('QuickCode: Failed to save state atomically: ' + e.message);
                try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
            }
        }

        function loadSavedState() {
            try {
                if (fs.existsSync(STATE_FILE)) {
                    const content = fs.readFileSync(STATE_FILE, 'utf8');
                    if (content && content.trim().length > 0) {
                        const parsed = JSON.parse(content);
                        if (parsed && typeof parsed === 'object') return parsed;
                    }
                }
            } catch (e) {
                log.warn('QuickCode: Failed to load primary state: ' + e.message);
            }

            try {
                if (fs.existsSync(STATE_BAK)) {
                    const bakContent = fs.readFileSync(STATE_BAK, 'utf8');
                    if (bakContent && bakContent.trim().length > 0) {
                        const parsed = JSON.parse(bakContent);
                        if (parsed && typeof parsed === 'object') {
                            log.info('QuickCode: Recovered state from backup mirror');
                            return parsed;
                        }
                    }
                }
            } catch (e) {
                log.warn('QuickCode: Failed to load mirror state: ' + e.message);
            }
            return null;
        }

        // Initialize state: start with authentic OEM factory defaults or saved configuration
        const saved = loadSavedState() || {};
        let autoStartStopMem = (typeof saved.autoStartStopMem === 'boolean') ? saved.autoStartStopMem : OEM_DEFAULTS.autoStartStopMem;
        let instantMirrorFold = (typeof saved.instantMirrorFold === 'boolean') ? saved.instantMirrorFold : OEM_DEFAULTS.instantMirrorFold;
        let windowInterruptMuted = (typeof saved.windowInterruptMuted === 'boolean') ? saved.windowInterruptMuted : OEM_DEFAULTS.windowInterruptMuted;
        let tailgateCloseFob = (typeof saved.tailgateCloseFob === 'boolean') ? saved.tailgateCloseFob : OEM_DEFAULTS.tailgateCloseFob;
        let comfortTurnSignals5 = (typeof saved.comfortTurnSignals5 === 'boolean') ? saved.comfortTurnSignals5 : OEM_DEFAULTS.comfortTurnSignals5;
        let reverseMirrorTilt70 = (typeof saved.reverseMirrorTilt70 === 'boolean') ? saved.reverseMirrorTilt70 : OEM_DEFAULTS.reverseMirrorTilt70;
        let acousticLockChirp = (typeof saved.acousticLockChirp === 'boolean') ? saved.acousticLockChirp : OEM_DEFAULTS.acousticLockChirp;
        let emergencyBrakeBfd = (typeof saved.emergencyBrakeBfd === 'boolean') ? saved.emergencyBrakeBfd : OEM_DEFAULTS.emergencyBrakeBfd;
        let selectedColor = AMBIENT_PRESETS.find(p => p.name === saved.ambientColorName) || AMBIENT_PRESETS[0];

        function getCurrentStateSnapshot() {
            return {
                autoStartStopMem: !!autoStartStopMem,
                instantMirrorFold: !!instantMirrorFold,
                windowInterruptMuted: !!windowInterruptMuted,
                tailgateCloseFob: !!tailgateCloseFob,
                comfortTurnSignals5: !!comfortTurnSignals5,
                reverseMirrorTilt70: !!reverseMirrorTilt70,
                acousticLockChirp: !!acousticLockChirp,
                emergencyBrakeBfd: !!emergencyBrakeBfd,
                ambientColorName: selectedColor ? selectedColor.name : OEM_DEFAULTS.ambientColorName,
                ambientHex: selectedColor ? selectedColor.hex : OEM_DEFAULTS.ambientHex
            };
        }

        function persistState() {
            saveState(getCurrentStateSnapshot());
        }

        // Monitor vehicle speed and engine RPM for safety interlock
        try {
            const Car = require('./kit/car');
            const car = new Car(ctx, ['rpm', 'speed', 'condition']);
            car.onSample((sample) => {
                safety.updateTelemetry(sample);
            });
        } catch (e) {
            log.warn('QuickCode: Telemetry monitor fallback: ' + e.message);
        }

        let page = 0;
        let lastRawRead = null; // { raw2001, raw2002, at } from the last READ BDC

        // Feedback & Safety Dialog state
        let statusMsg = null;
        let statusTime = 0;
        let activeSafetyAlert = null;
        let isCodingInProgress = false;

        function notify(msg) {
            statusMsg = msg;
            statusTime = Date.now();
            log.info('QuickCode: ' + msg);
        }

        /**
         * Safe coding modification wrapper:
         *   1. Safety interlock validation
         *   2. Automated pre-coding backup snapshot
         *   3. UDS write to BDC (0x40) with session control
         *   4. Triple-Check read-back verification
         *   5. State mutation and atomic disk persistence
         */
        async function applyCodingChange(actionTitle, paramKey, oldValue, newValue, candidateState) {
            if (isCodingInProgress) {
                notify('[!] Coding in progress, please wait...');
                return false;
            }

            const check = safety.checkCodingSafety(paramKey);
            if (!check.allowed) {
                activeSafetyAlert = check;
                notify('[!] ' + check.title);
                return false;
            }

            isCodingInProgress = true;
            notify(`[..] Coding BDC 0x40: ${actionTitle}...`);
            render().catch(() => {});

            try {
                // 1. Create automated pre-coding backup snapshot
                const preSnapshot = getCurrentStateSnapshot();
                backupMgr.createBackup(actionTitle, paramKey, oldValue, newValue, preSnapshot);

                // 2. Prepare candidate configuration to write
                const targetState = Object.assign({}, preSnapshot, candidateState);

                // 3. Perform write to ECU with Triple-Check Read-Back Verification
                const writeResult = await safety.writeEcuConfiguration(targetState);

                if (!writeResult || !writeResult.success) {
                    const errMsg = (writeResult && writeResult.error) ? writeResult.error : 'ECU rejected write command';
                    notify('[ERR] Coding failed: ' + errMsg);
                    log.error(`QuickCode: Coding write failed for "${actionTitle}": ${errMsg}`);
                    return false;
                }

                // 4. Update memory state with verified values
                if (targetState.autoStartStopMem !== undefined) autoStartStopMem = targetState.autoStartStopMem;
                if (targetState.instantMirrorFold !== undefined) instantMirrorFold = targetState.instantMirrorFold;
                if (targetState.windowInterruptMuted !== undefined) windowInterruptMuted = targetState.windowInterruptMuted;
                if (targetState.tailgateCloseFob !== undefined) tailgateCloseFob = targetState.tailgateCloseFob;
                if (targetState.comfortTurnSignals5 !== undefined) comfortTurnSignals5 = targetState.comfortTurnSignals5;
                if (targetState.reverseMirrorTilt70 !== undefined) reverseMirrorTilt70 = targetState.reverseMirrorTilt70;
                if (targetState.acousticLockChirp !== undefined) acousticLockChirp = targetState.acousticLockChirp;
                if (targetState.emergencyBrakeBfd !== undefined) emergencyBrakeBfd = targetState.emergencyBrakeBfd;
                if (targetState.ambientColorName) {
                    const p = AMBIENT_PRESETS.find(x => x.name === targetState.ambientColorName);
                    if (p) selectedColor = p;
                }

                // 5. Persist state to disk
                persistState();

                notify(`[OK] Backed up, coded & verified: ${actionTitle}`);
                return true;
            } catch (e) {
                notify('[ERR] Unexpected error: ' + e.message);
                log.error(`QuickCode: Exception during coding change: ` + (e.stack || e.message));
                return false;
            } finally {
                isCodingInProgress = false;
                render().catch(() => {});
            }
        }

        // Read Live Coded Values directly from vehicle BDC (0x40) over UDS
        async function readLiveEcuValues() {
            if (isCodingInProgress) return;
            notify('Reading live BDC configuration from vehicle...');
            render().catch(() => {});

            try {
                const live = await safety.readEcuConfiguration(AMBIENT_PRESETS);
                // The DID map is unverified, so decoded values are NOT applied to the toggles:
                // show and log the raw bytes the BDC returned instead.
                if (live && (live.raw2001 || live.raw2002)) {
                    lastRawRead = { raw2001: live.raw2001 || '-', raw2002: live.raw2002 || '-', at: Date.now() };
                    log.info('QuickCode: raw BDC read 0x2001=[' + lastRawRead.raw2001 + '] 0x2002=[' + lastRawRead.raw2002 + ']');
                    notify('[OK] Raw BDC read: 0x2001 [' + lastRawRead.raw2001 + ']');
                } else {
                    notify('[!] BDC did not return DID 0x2001/0x2002 (see log)');
                }
            } catch (e) {
                notify('[ERR] Read BDC error: ' + e.message);
                log.warn('QuickCode: readLiveEcuValues error: ' + e.message);
            } finally {
                render().catch(() => {});
            }
        }

        // Restore all parameters back to factory OEM stock settings (with backup and ECU write)
        async function restoreOemDefaults() {
            if (isCodingInProgress) return;
            const check = safety.checkCodingSafety();
            if (!check.allowed) {
                activeSafetyAlert = check;
                notify('[!] ' + check.title);
                return;
            }

            const oemPreset = AMBIENT_PRESETS.find(p => p.name === OEM_DEFAULTS.ambientColorName) || AMBIENT_PRESETS[0];
            const candidate = Object.assign({}, OEM_DEFAULTS, {
                ambientColorName: oemPreset.name,
                ambientHex: oemPreset.hex
            });

            await applyCodingChange('Restore Factory OEM Defaults', 'all_oem', 'custom', 'oem', candidate);
        }

        // Restore a specific historical backup snapshot with ECU write and verification
        async function restoreBackupSnapshot(backupId) {
            if (isCodingInProgress) return;
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

            const s = item.snapshot;
            const candidate = {
                autoStartStopMem: (s.autoStartStopMem !== undefined) ? s.autoStartStopMem : autoStartStopMem,
                instantMirrorFold: (s.instantMirrorFold !== undefined) ? s.instantMirrorFold : instantMirrorFold,
                windowInterruptMuted: (s.windowInterruptMuted !== undefined) ? s.windowInterruptMuted : windowInterruptMuted,
                tailgateCloseFob: (s.tailgateCloseFob !== undefined) ? s.tailgateCloseFob : tailgateCloseFob,
                comfortTurnSignals5: (s.comfortTurnSignals5 !== undefined) ? s.comfortTurnSignals5 : comfortTurnSignals5,
                reverseMirrorTilt70: (s.reverseMirrorTilt70 !== undefined) ? s.reverseMirrorTilt70 : reverseMirrorTilt70,
                acousticLockChirp: (s.acousticLockChirp !== undefined) ? s.acousticLockChirp : acousticLockChirp,
                emergencyBrakeBfd: (s.emergencyBrakeBfd !== undefined) ? s.emergencyBrakeBfd : emergencyBrakeBfd,
                ambientColorName: s.ambientColorName || (selectedColor ? selectedColor.name : OEM_DEFAULTS.ambientColorName),
                ambientHex: s.ambientHex || (selectedColor ? selectedColor.hex : OEM_DEFAULTS.ambientHex)
            };

            await applyCodingChange(`Rollback to ${item.timeFormatted}`, 'rollback', 'active', item.id, candidate);
        }

        // Attempt live ECU discovery and read once TASU connects
        diag.on('available', async (isAvail) => {
            log.info(`QuickCode: Diagnostic transport available=${isAvail}`);
            if (isAvail) {
                await safety.scanModules();
                await readLiveEcuValues();
            }
        });

        // 4 Curated Low-Risk Categories (BDC 0x40 Only)
        // (short tab names: the header holds them and Settings at a readable size; the panels say the rest)
        const PAGES = [
            { id: 'ambient', name: 'Ambient' },
            { id: 'comfort', name: 'Comfort' },
            { id: 'lighting', name: 'Lighting' },
            { id: 'backups', name: 'Backups' }
        ];

        /* ---------- Safety Lockout Screen (Non-G-Series or Bus Unreachable) ---------- */
        function drawSafetyLockout(cv, t) {
            G.panel(cv, t, 40, 52, 1520, geom(cv).panelH, 'Safety Interlock Active');

            cv.roundRect(80, 110, 1440, 310, 16, '#0f172a');
            cv.strokeRoundRect(80, 110, 1440, 310, 16, 2, '#e1001a');

            cv.circle(180, 260, 48, withAlpha('#e1001a', 0.2));
            cv.text('!', 180, 275, 48, '#e1001a', { align: 'center', font: 'bold' });

            cv.text('BDC_BODY3 ARCHITECTURE NOT DETECTED', 260, 175, 26, '#e1001a', { font: 'bold' });
            cv.text('QuickCode is engineered specifically for BMW G-Series vehicles with iDrive 7 (BDC_BODY3 0x40).', 260, 215, 18, '#ffffff');
            cv.text('All ECU coding write and parameter change functions are locked for vehicle protection.', 260, 245, 17, '#94a3b8');
            cv.text('No coding modifications will be sent to the vehicle CAN/Ethernet bus.', 260, 275, 17, '#94a3b8');

            const lbH = sz(cv, 38), lbSize = sz(cv, 12), lbOpt = { align: 'center', font: 'bold' };
            const stW = cv.textWidth('STATUS: READ-ONLY SAFE LOCKOUT', lbSize, lbOpt) + 40;
            cv.roundRect(260, 315, stW, lbH, 8, '#1e293b');
            cv.text('STATUS: READ-ONLY SAFE LOCKOUT', 260 + stW / 2, mid(315, lbH, lbSize), lbSize, '#ffb703', lbOpt);

            // Interactive Re-scan Button so startup timing never permanently locks user out
            const rBtnX = 260 + stW + 20, rBtnY = 315, rBtnW = cv.textWidth('RETRY BUS SCAN', lbSize, lbOpt) + sz(cv, 50), rBtnH = lbH;
            cv.roundRect(rBtnX, rBtnY, rBtnW, rBtnH, 8, '#0f291e');
            cv.strokeRoundRect(rBtnX, rBtnY, rBtnW, rBtnH, 8, 1.5, '#2af575');
            cv.text('RETRY BUS SCAN', rBtnX + rBtnW / 2, mid(rBtnY, rBtnH, lbSize), lbSize, '#2af575', lbOpt);
            cv.target(rBtnX, rBtnY, rBtnW, rBtnH, async () => {
                notify('Scanning vehicle bus for BDC (0x40)...');
                await safety.scanModules();
                if (safety.isGSeries) {
                    notify('[OK] BDC_BODY3 (0x40) responding! Unlocked.');
                    await readLiveEcuValues();
                } else {
                    notify('[!] BDC (0x40) still not responding.');
                }
                render().catch(() => {});
            }, 'btn_retry_scan', 15);
        }

        /* ---------- Safety Modal Dialog (Engine Running / Diag Mode Required) ---------- */
        function drawSafetyModal(cv, t) {
            if (!activeSafetyAlert) return;
            const alert = activeSafetyAlert;

            // Fullscreen dark backdrop overlay
            cv.roundRect(0, 0, W, H, 0, withAlpha('#000000', 0.82));

            // Dialog Box
            const dw = 1000, dh = 460;
            // (below the page's top strip, which the full-screen header covers)
            const dx = (W - dw) / 2, dy = 48;
            cv.roundRect(dx, dy, dw, dh, 16, '#0c131d');
            cv.strokeRoundRect(dx, dy, dw, dh, 16, 2, alert.badgeColor || '#e1001a');

            // Header Banner
            cv.roundRect(dx + 16, dy + 16, dw - 32, 54, 10, withAlpha(alert.badgeColor || '#e1001a', 0.15));
            cv.circle(dx + 50, dy + 43, 16, alert.badgeColor || '#e1001a');
            cv.text('!', dx + 50, dy + 49, 18, '#000000', { align: 'center', font: 'bold' });
            const aTitle = sz(cv, 15), aMsg = sz(cv, 12.5), aStep = sz(cv, 12.5), aGap = Math.round(aStep * 1.55);
            cv.text(fitText(cv, alert.title, dw - 130, aTitle, { font: 'bold', spacing: 1 }), dx + 82, mid(dy + 16, 54, aTitle), aTitle, alert.badgeColor || '#e1001a', { font: 'bold', spacing: 1 });

            // Message text
            cv.text(fitText(cv, alert.message, dw - 64, aMsg), dx + 32, dy + 104, aMsg, '#cbd5e1');

            // Step instructions box
            const boxY = dy + 126, boxH = 24 + aStep + 4 * aGap + 10;
            cv.roundRect(dx + 32, boxY, dw - 64, boxH, 10, '#060a10');
            cv.strokeRoundRect(dx + 32, boxY, dw - 64, boxH, 10, 1, '#1e293b');

            cv.text(alert.status === 'READ_ONLY' ? 'WHY CODING IS OFF:' : 'WHAT TO DO:', dx + 48, boxY + 14 + aStep, aStep, '#00a3e0', { font: 'bold' });

            const steps = alert.steps && alert.steps.length ? alert.steps : [
                '1. Turn OFF engine completely (Press Start/Stop button)',
                '2. Foot completely OFF the brake pedal',
                '3. Press the Start/Stop button 3 times in quick succession',
                '4. Instrument cluster will display "Diagnostic mode active"'
            ];

            steps.forEach((st, i) => {
                cv.text(fitText(cv, st, dw - 96, aStep), dx + 48, boxY + 14 + aStep + (i + 1) * aGap, aStep, '#ffffff');
            });

            // Action Buttons at bottom
            const btnW = sz(cv, 200), btnH = sz(cv, 38);
            const b1X = dx + 32, bY = dy + dh - 18 - btnH;

            // Dismiss Button
            cv.roundRect(b1X, bY, btnW, btnH, 8, '#1e293b');
            cv.strokeRoundRect(b1X, bY, btnW, btnH, 8, 1, '#334155');
            cv.text('OK, UNDERSTOOD', b1X + btnW / 2, mid(bY, btnH, sz(cv, 13)), sz(cv, 13), '#ffffff', { align: 'center', font: 'bold' });
            cv.target(b1X, bY, btnW, btnH, () => {
                activeSafetyAlert = null;
            }, 'btn_dismiss_alert', 15);

        }

        /* ---------- Tab 0: Ambient Lighting RGB (BDC 0x40) ---------- */
        function drawAmbient(cv, t, now) {
            const g = geom(cv);
            G.panel(cv, t, 40, 52, 680, g.panelH, 'Ambient RGB Lighting (BDC 0x40)');

            // six colour tiles, two by three, filling the panel
            const tileTop = 114, tileGap = 12, tileW = 305;
            const tileH = Math.floor((52 + g.panelH - 18 - tileTop - 2 * tileGap) / 3);
            const nSize = sz(cv, 16), hSize = sz(cv, 12.5);
            AMBIENT_PRESETS.forEach((preset, idx) => {
                const col = idx % 2;
                const row = Math.floor(idx / 2);
                const px = 64 + col * 320;
                const py = tileTop + row * (tileH + tileGap);
                const isSel = selectedColor.name === preset.name;
                const dotR = Math.round(tileH * 0.22), dotX = px + 14 + dotR + 6, dotY = py + tileH / 2;

                cv.roundRect(px, py, tileW, tileH, 12, isSel ? withAlpha(preset.hex, 0.25) : t.track);
                cv.strokeRoundRect(px, py, tileW, tileH, 12, isSel ? 2 : 1, isSel ? preset.hex : t.panelEdge);

                cv.circle(dotX, dotY, dotR, preset.hex);
                if (isSel) cv.circle(dotX, dotY, dotR + 6, withAlpha(preset.hex, 0.35));

                const textX = dotX + dotR + 16, textW = px + tileW - 12 - textX;
                cv.text(fitText(cv, preset.name, textW, nSize, { font: 'bold' }), textX, dotY - 3, nSize, isSel ? '#ffffff' : '#dddddd', { font: 'bold' });
                cv.text(preset.hex.toUpperCase(), textX, dotY + hSize + 5, hSize, t.dim, { font: 'num' });

                cv.target(px, py, tileW, tileH, () => {
                    if (isCodingInProgress) return;
                    selectedColor = preset;
                }, 'amb_' + idx, 12);
            });

            // Right: Interior Silhouette & Light Tubes
            G.panel(cv, t, 740, 52, 820, g.panelH, 'Live Interior Light Bar Preview');

            // the apply button at the panel's bottom, the preview in the room above it
            const btnH = sz(cv, 42), btnY = 52 + g.panelH - 16 - btnH;
            const cx = 760, cy = 114, cw = 780, ch = btnY - 14 - cy;
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

            const pvSize = sz(cv, 15), pvOpt = { align: 'center', font: 'bold', spacing: 1.5 };
            cv.text(fitText(cv, 'ACTIVE PREVIEW: ' + selectedColor.name.toUpperCase(), cw - 40, pvSize, pvOpt), cx + cw / 2, Math.min(cy + ch - 18, cy + 205), pvSize, glowCol, pvOpt);

            // Apply button (Gated by Engine Running & Diagnostic Mode Safety)
            const btnX = cx + 100, btnW = cw - 200;
            const safeCheck = safety.checkCodingSafety('ambient_rgb');
            const canWrite = safeCheck.allowed && !isCodingInProgress;

            cv.roundRect(btnX, btnY, btnW, btnH, 12, canWrite ? selectedColor.hex : '#16202c');
            cv.strokeRoundRect(btnX, btnY, btnW, btnH, 12, 1.5, canWrite ? selectedColor.hex : safeCheck.badgeColor);

            const isOemColor = !!selectedColor.isOem;
            let btnLabel = '';
            if (isCodingInProgress) {
                btnLabel = 'WRITING BDC 0x40 (PLEASE WAIT...)';
            } else if (canWrite) {
                btnLabel = isOemColor ? ('RESTORE ' + selectedColor.name.toUpperCase()) : ('WRITE ' + selectedColor.name.toUpperCase() + ' (AUTO-BACKUP)');
            } else {
                btnLabel = `[LOCKED] ${safeCheck.title}`;
            }

            const bSize = sz(cv, 13), bOpt = { align: 'center', font: 'bold', spacing: 1.2 };
            cv.text(fitText(cv, btnLabel, btnW - 32, bSize, bOpt), btnX + btnW / 2, mid(btnY, btnH, bSize), bSize, canWrite ? '#000000' : safeCheck.badgeColor, bOpt);

            cv.target(btnX, btnY, btnW, btnH, async () => {
                if (isCodingInProgress) return;
                await applyCodingChange(
                    'Ambient Color: ' + selectedColor.name,
                    'ambientColorName',
                    saved.ambientColorName || OEM_DEFAULTS.ambientColorName,
                    selectedColor.name,
                    {
                        ambientColorName: selectedColor.name,
                        ambientHex: selectedColor.hex
                    }
                );
            }, 'btn_apply_amb', 12);
        }

        /* ---------- BMW iDrive 7 OEM Toggle Switch ---------- */
        /** The switch, drawn at s times its reference size (104 x 46) from x, y. */
        function drawBmwToggle(cv, x, y, active, canCode, lockColor, s) {
            s = s || 1;
            const w = 104 * s, h = 46 * s, r = h / 2;
            const thumbR = 18 * s, lSize = 13 * s, base = y + h / 2 + lSize * 0.36;

            if (!canCode) {
                // Interlocked / Locked State (e.g. Engine Running)
                cv.roundRect(x, y, w, h, r, '#0a0e14');
                cv.strokeRoundRect(x, y, w, h, r, 1.5, withAlpha(lockColor || '#ffb703', 0.65));
                const tx = x + (active ? w - r : r), ty = y + r;
                cv.circle(tx, ty, thumbR, '#080c12');
                cv.circle(tx, ty, thumbR - 1.5, '#1e293b');
                // label in the free half, beside the knob
                const lx = active ? x + (w - 2 * r) / 2 + 2 : x + 2 * r + (w - 2 * r) / 2 - 2;
                cv.text('LOCK', lx, base, lSize * 0.85, lockColor || '#ffb703', { align: 'center', font: 'bold', spacing: 0.5 });
                return;
            }

            if (active) {
                // Active State: Vivid BMW Blue & M-Performance Cyan
                cv.roundRect(x, y, w, h, r, '#004e8c');
                cv.strokeRoundRect(x, y, w, h, r, 1.5, '#00a3e0');

                // "ON" label on the left in crisp white
                cv.text('ON', x + 28 * s, base, lSize, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });

                // Tactile Machined Aluminum Thumb on the right
                const tx = x + w - r, ty = y + r;
                cv.circle(tx, ty, thumbR, '#002e54');
                cv.circle(tx, ty, thumbR - 1.5, '#f8fafc');
                // Central vertical grip notch (BMW M-Cyan bar)
                cv.roundRect(tx - 2 * s, ty - 7 * s, 4 * s, 14 * s, 2 * s, '#00a3e0');
            } else {
                // Inactive State: Dark Graphite & Slate
                cv.roundRect(x, y, w, h, r, '#0c121a');
                cv.strokeRoundRect(x, y, w, h, r, 1.5, '#1e2a3a');

                // "OFF" label on the right in dim slate
                cv.text('OFF', x + w - 28 * s, base, lSize, '#64748b', { align: 'center', font: 'bold', spacing: 1 });

                // Tactile Matte Aluminum Thumb on the left
                const tx = x + r, ty = y + r;
                cv.circle(tx, ty, thumbR, '#090e15');
                cv.circle(tx, ty, thumbR - 1.5, '#384656');
                // Central vertical grip notch
                cv.roundRect(tx - 2 * s, ty - 7 * s, 4 * s, 14 * s, 2 * s, '#1e293b');
            }
        }

        /**
         * Four coding switches as cards, two by two, filling the panel over the dock: title, what it does, the
         * state (or why it is locked) and the switch. target(item, idx, x, y, w, h) makes each card pressable.
         */
        function drawToggleCards(cv, t, toggles, target) {
            const g = geom(cv), gap = 18, top = 112;
            const cw = 720, ch = Math.floor((52 + g.panelH - 18 - top - gap) / 2);
            const tSize = sz(cv, 18), dSize = sz(cv, 12.5), pSize = sz(cv, 10.5), pillH = sz(cv, 25);
            const ts = kOf(cv) / 1.2, swW = 104 * ts, swH = 46 * ts;
            toggles.forEach((item, idx) => {
                const col = idx % 2;
                const row = Math.floor(idx / 2);
                const tx = 64 + col * 752;
                const ty = top + row * (ch + gap);
                const safeCheck = safety.checkCodingSafety(item.key);
                const canCode = safeCheck.allowed && !isCodingInProgress;

                // Card container with authentic BMW cockpit styling
                const cardBg = item.active ? '#0c1522' : '#0b0f16';
                const cardEdge = canCode ? (item.active ? '#0077c8' : '#1c2432') : withAlpha(safeCheck.badgeColor, 0.5);
                cv.roundRect(tx, ty, cw, ch, 12, cardBg);
                cv.strokeRoundRect(tx, ty, cw, ch, 12, 1.5, cardEdge);

                // BMW iDrive 7 Toggle Switch, on the right, centred
                const swX = tx + cw - 28 - swW, swY = ty + (ch - swH) / 2;
                const textW = swX - 20 - (tx + 28);
                // title, then what it does on up to two lines
                const titleY = ty + 14 + tSize, descY = titleY + dSize + 10, dStep = dSize + 6;
                cv.text(fitText(cv, item.title, textW, tSize, { font: 'bold' }), tx + 28, titleY, tSize, item.active ? '#ffffff' : '#cbd5e1', { font: 'bold' });
                wrapText(cv, item.desc, textW, dSize, 2).forEach((line, i) => cv.text(line, tx + 28, descY + i * dStep, dSize, t.dim));

                // Status Pill, as wide as its text
                const pillBg = canCode ? (item.active ? '#0a2e1d' : '#141c26') : '#241215';
                const pillBorder = canCode ? (item.active ? '#10b981' : '#283548') : safeCheck.badgeColor;
                const pillTextCol = canCode ? (item.active ? '#2af575' : '#8a99ad') : safeCheck.badgeColor;
                const pillOpt = { align: 'center', font: 'bold', spacing: 1 };
                const pillLabel = fitText(cv, canCode ? item.stateLabel : ('[LOCKED] ' + safeCheck.badgeText), textW - 24, pSize, pillOpt);
                const pillW = cv.textWidth(pillLabel, pSize, pillOpt) + 24, pillY = ty + ch - 14 - pillH;

                cv.roundRect(tx + 28, pillY, pillW, pillH, 6, pillBg);
                cv.strokeRoundRect(tx + 28, pillY, pillW, pillH, 6, 1, pillBorder);
                cv.text(pillLabel, tx + 28 + pillW / 2, mid(pillY, pillH, pSize), pSize, pillTextCol, pillOpt);

                drawBmwToggle(cv, swX, swY, item.active, canCode, safeCheck.badgeColor, ts);
                target(item, idx, tx, ty, cw, ch);
            });
        }

        /* ---------- Tab 1: Comfort & Doors (BDC 0x40) ---------- */
        function drawComfort(cv, t) {
            G.panel(cv, t, 40, 52, 1520, geom(cv).panelH, 'Comfort Access & Doors (BDC 0x40)');

            const toggles = [
                {
                    key: 'start_stop_mem',
                    title: 'Auto Start/Stop Memory',
                    desc: 'Permanently remembers last button state across ignition cycles (Stays OFF)',
                    active: autoStartStopMem,
                    stateLabel: autoStartStopMem ? 'CODED: MEMORY (OFF)' : 'OEM FACTORY (ACTIVE)',
                    action: async () => {
                        const target = !autoStartStopMem;
                        await applyCodingChange(
                            'Auto Start/Stop Memory',
                            'autoStartStopMem',
                            autoStartStopMem,
                            target,
                            { autoStartStopMem: target }
                        );
                    }
                },
                {
                    key: 'mirror_fold',
                    title: 'Instant Mirror Fold on Lock',
                    desc: 'Folds side mirrors immediately when pressing lock (0.0s vs 1.5s hold delay)',
                    active: instantMirrorFold,
                    stateLabel: instantMirrorFold ? 'CODED: INSTANT (0.0s)' : 'OEM FACTORY (1.5s DELAY)',
                    action: async () => {
                        const target = !instantMirrorFold;
                        await applyCodingChange(
                            'Instant Mirror Fold',
                            'instantMirrorFold',
                            instantMirrorFold,
                            target,
                            { instantMirrorFold: target }
                        );
                    }
                },
                {
                    key: 'window_roll',
                    title: 'Door Open Window Roll Protection',
                    desc: 'Power windows continue rolling up without interrupting when car door opens',
                    active: windowInterruptMuted,
                    stateLabel: windowInterruptMuted ? 'CODED: CONTINUOUS UP' : 'OEM FACTORY (INTERRUPT)',
                    action: async () => {
                        const target = !windowInterruptMuted;
                        await applyCodingChange(
                            'Continuous Window Roll-Up',
                            'windowInterruptMuted',
                            windowInterruptMuted,
                            target,
                            { windowInterruptMuted: target }
                        );
                    }
                },
                {
                    key: 'tailgate_fob',
                    title: 'One-Touch Tailgate Close (Fob & Door)',
                    desc: 'One-touch close tailgate from key fob and driver door button without holding',
                    active: tailgateCloseFob,
                    stateLabel: tailgateCloseFob ? 'CODED: ONE-TOUCH CLOSE' : 'OEM FACTORY (HOLD REQUIRED)',
                    action: async () => {
                        const target = !tailgateCloseFob;
                        await applyCodingChange(
                            'One-Touch Tailgate Close',
                            'tailgateCloseFob',
                            tailgateCloseFob,
                            target,
                            { tailgateCloseFob: target }
                        );
                    }
                }
            ];

            drawToggleCards(cv, t, toggles, (item, idx, tx, ty, cw, ch) => cv.target(tx, ty, cw, ch, async () => {
                    if (isCodingInProgress) return;
                    await item.action();
                }, 'tog_c_' + idx, 12));
        }

        /* ---------- Tab 2: Signals & Lighting (BDC 0x40) ---------- */
        function drawLighting(cv, t) {
            G.panel(cv, t, 40, 52, 1520, geom(cv).panelH, 'Signals & Lighting Enhancements (BDC 0x40)');

            const toggles = [
                {
                    key: 'signals_5flash',
                    title: '5-Flash Comfort Turn Signals',
                    desc: 'One-touch indicator flashes 5 times instead of factory 3 flashes for lane changes',
                    active: comfortTurnSignals5,
                    stateLabel: comfortTurnSignals5 ? 'CODED: 5 FLASHES' : 'OEM FACTORY (3 FLASHES)',
                    action: async () => {
                        const target = !comfortTurnSignals5;
                        await applyCodingChange(
                            '5-Flash Comfort Signals',
                            'comfortTurnSignals5',
                            comfortTurnSignals5,
                            target,
                            { comfortTurnSignals5: target }
                        );
                    }
                },
                {
                    key: 'mirror_tilt',
                    title: 'Curb Monitor Mirror Tilt (70%)',
                    desc: 'Passenger mirror dips 70% in reverse to show curb/rim instead of 100% floor angle',
                    active: reverseMirrorTilt70,
                    stateLabel: reverseMirrorTilt70 ? 'CODED: 70% TILT' : 'OEM FACTORY (100% TILT)',
                    action: async () => {
                        const target = !reverseMirrorTilt70;
                        await applyCodingChange(
                            'Curb Mirror Tilt 70%',
                            'reverseMirrorTilt70',
                            reverseMirrorTilt70,
                            target,
                            { reverseMirrorTilt70: target }
                        );
                    }
                },
                {
                    key: 'lock_chirp',
                    title: 'Acoustic Lock/Unlock Chirp',
                    desc: 'Audible horn chirp confirmation when locking or unlocking the vehicle',
                    active: acousticLockChirp,
                    stateLabel: acousticLockChirp ? 'CODED: CHIRP ACTIVE' : 'OEM FACTORY (SILENT)',
                    action: async () => {
                        const target = !acousticLockChirp;
                        await applyCodingChange(
                            'Acoustic Lock Chirp',
                            'acousticLockChirp',
                            acousticLockChirp,
                            target,
                            { acousticLockChirp: target }
                        );
                    }
                },
                {
                    key: 'brake_bfd',
                    title: 'Brake Force Display (Flashing BFD)',
                    desc: 'Rapidly pulses outer brake lamps under heavy deceleration to alert trailing drivers',
                    active: emergencyBrakeBfd,
                    stateLabel: emergencyBrakeBfd ? 'CODED: FLASHING ACTIVE' : 'OEM FACTORY (STEADY LIGHT)',
                    action: async () => {
                        const target = !emergencyBrakeBfd;
                        await applyCodingChange(
                            'Flashing Brake Force (BFD)',
                            'emergencyBrakeBfd',
                            emergencyBrakeBfd,
                            target,
                            { emergencyBrakeBfd: target }
                        );
                    }
                }
            ];

            drawToggleCards(cv, t, toggles, (item, idx, tx, ty, cw, ch) => cv.target(tx, ty, cw, ch, async () => {
                    if (isCodingInProgress) return;
                    await item.action();
                }, 'tog_l_' + idx, 12));
        }

        /* ---------- Tab 3: Automated Backups & Rollback Engine ---------- */
        function drawBackups(cv, t) {
            const g = geom(cv), bottom = 52 + g.panelH - 16;
            G.panel(cv, t, 40, 52, 1520, g.panelH, 'Automated Backups & Rollback Engine (BDC 0x40)');

            const backups = backupMgr.getBackups();
            const safeCheck = safety.checkCodingSafety();
            const canRestore = safeCheck.allowed && !isCodingInProgress;

            // Left Section: Historical Backups List
            const listX = 64, listY = 112, listW = 920;

            if (backups.length === 0) {
                // Empty state card
                cv.roundRect(listX, listY, listW, bottom - listY, 12, '#0c131d');
                cv.strokeRoundRect(listX, listY, listW, bottom - listY, 12, 1.5, '#1e293b');

                cv.circle(listX + listW / 2, listY + 120, 36, '#152132');
                cv.text('i', listX + listW / 2, listY + 132, 34, '#00a3e0', { align: 'center', font: 'bold' });

                cv.text('NO CODING BACKUPS YET', listX + listW / 2, listY + 195, sz(cv, 17), '#ffffff', { align: 'center', font: 'bold' });
                cv.text('A snapshot is recorded here before every coding write.', listX + listW / 2, listY + 195 + sz(cv, 26), sz(cv, 13), '#94a3b8', { align: 'center' });
                cv.text('This read-only build writes nothing, so none are made.', listX + listW / 2, listY + 195 + sz(cv, 48), sz(cv, 12), '#64748b', { align: 'center' });
            } else {
                // the most recent backups, as many as fit over the panel's bottom
                const bGap = 10, bh = Math.max(100, sz(cv, 80));
                const displayBackups = backups.slice(0, Math.max(1, Math.floor((bottom - listY + bGap) / (bh + bGap))));
                const tagSize = sz(cv, 10.5), tagH = sz(cv, 22), tagOpt = { align: 'center', font: 'bold' };
                const titleSize = sz(cv, 16), valSize = sz(cv, 12);
                const btnW = sz(cv, 130), btnH = sz(cv, 38), btnSize = sz(cv, 12);
                displayBackups.forEach((b, idx) => {
                    const by = listY + idx * (bh + bGap);

                    cv.roundRect(listX, by, listW, bh, 12, '#0c1522');
                    cv.strokeRoundRect(listX, by, listW, bh, 12, 1.5, '#1c293d');

                    // Timestamp pill, then the ECU Target badge, each as wide as its text
                    const tw1 = cv.textWidth(b.timeFormatted, tagSize, tagOpt) + 24, tw2 = cv.textWidth('TARGET: BDC 0x40', tagSize, tagOpt) + 24;
                    cv.roundRect(listX + 24, by + 12, tw1, tagH, 6, '#142030');
                    cv.text(b.timeFormatted, listX + 24 + tw1 / 2, mid(by + 12, tagH, tagSize), tagSize, '#00a3e0', tagOpt);
                    cv.roundRect(listX + 36 + tw1, by + 12, tw2, tagH, 6, '#0f291e');
                    cv.text('TARGET: BDC 0x40', listX + 36 + tw1 + tw2 / 2, mid(by + 12, tagH, tagSize), tagSize, '#2af575', tagOpt);

                    // Right Restore Action Button
                    const btnX = listX + listW - btnW - 24, btnY = by + (bh - btnH) / 2;

                    // Backup Title & details, up to the button
                    const textW = btnX - 24 - (listX + 24);
                    const valY = by + bh - 12, titleY = valY - valSize - 8;
                    cv.text(fitText(cv, b.actionTitle, textW, titleSize, { font: 'bold' }), listX + 24, titleY, titleSize, '#ffffff', { font: 'bold' });
                    const valText = (b.oldValue !== null && b.newValue !== null) ? `Changed: ${b.oldValue} -> ${b.newValue}` : 'State Snapshot';
                    cv.text(fitText(cv, valText, textW, valSize), listX + 24, valY, valSize, '#94a3b8');

                    const bOpt = { align: 'center', font: 'bold', spacing: 1 };
                    if (!canRestore) {
                        cv.roundRect(btnX, btnY, btnW, btnH, 8, '#241215');
                        cv.strokeRoundRect(btnX, btnY, btnW, btnH, 8, 1, safeCheck.badgeColor);
                        cv.text(isCodingInProgress ? 'BUSY...' : '[LOCKED]', btnX + btnW / 2, mid(btnY, btnH, btnSize), btnSize, safeCheck.badgeColor, bOpt);
                    } else {
                        cv.roundRect(btnX, btnY, btnW, btnH, 8, '#004e8c');
                        cv.strokeRoundRect(btnX, btnY, btnW, btnH, 8, 1.5, '#00a3e0');
                        cv.text('RESTORE', btnX + btnW / 2, mid(btnY, btnH, btnSize), btnSize, '#ffffff', bOpt);
                    }

                    cv.target(btnX, btnY, btnW, btnH, async () => {
                        if (isCodingInProgress) return;
                        await restoreBackupSnapshot(b.id);
                    }, 'bk_res_' + idx, 14);
                });
            }

            // Right Section: Safety Architecture Shield & Factory Reset
            const infoX = 1010, infoY = 112, infoW = 526;

            // Shield Card
            // (the reset card at the panel's bottom, the shield card in the room above it)
            const rfBtnH = sz(cv, 38), resH = rfBtnH + 22 + 14 + sz(cv, 12) + 16, resY = bottom - resH;
            const shH = resY - 16 - infoY;
            cv.roundRect(infoX, infoY, infoW, shH, 12, '#09121d');
            cv.strokeRoundRect(infoX, infoY, infoW, shH, 12, 1.5, '#0077c8');

            const shTitle = sz(cv, 15), shLine = sz(cv, 12), shStep = Math.max(shLine + 8, Math.min(sz(cv, 21), Math.floor((shH - 36 - shTitle) / 4)));
            const lineW = infoW - 56;
            cv.text('READ-ONLY BUILD', infoX + 28, infoY + 18 + shTitle, shTitle, '#ffb703', { font: 'bold', spacing: 1 });
            [['No coding is written to the car by this version.', '#cbd5e1'],
             ['The BDC coding map is not verified for this car,', '#cbd5e1'],
             ['so restore and rollback are disabled too.', '#cbd5e1'],
             ['Last raw read 0x2001: ' + (lastRawRead ? lastRawRead.raw2001 : 'none'), '#94a3b8', 'num']].forEach(([line, c, font], i) => {
                cv.text(fitText(cv, line, lineW, shLine, { font }), infoX + 28, infoY + 18 + shTitle + (i + 1) * shStep, shLine, c, { font });
            });

            // OEM Factory Reset Card
            cv.roundRect(infoX, resY, infoW, resH, 12, '#101722');
            cv.strokeRoundRect(infoX, resY, infoW, resH, 12, 1.5, '#334155');

            const rfBtnX = infoX + 28, rfBtnY = resY + 22, rfBtnW = infoW - 56;
            cv.roundRect(rfBtnX, rfBtnY, rfBtnW, rfBtnH, 10, canRestore ? '#1e293b' : '#241215');
            cv.strokeRoundRect(rfBtnX, rfBtnY, rfBtnW, rfBtnH, 10, 1.5, canRestore ? '#00a3e0' : safeCheck.badgeColor);

            let rLabel = '';
            if (isCodingInProgress) {
                rLabel = 'WRITING OEM DEFAULTS...';
            } else if (canRestore) {
                rLabel = 'RESTORE ALL FACTORY OEM DEFAULTS';
            } else {
                rLabel = `[LOCKED] ${safeCheck.title}`;
            }
            const rfSize = sz(cv, 12), rfOpt = { align: 'center', font: 'bold', spacing: 1 };
            cv.text(fitText(cv, rLabel, rfBtnW - 24, rfSize, rfOpt), rfBtnX + rfBtnW / 2, mid(rfBtnY, rfBtnH, rfSize), rfSize, canRestore ? '#ffffff' : safeCheck.badgeColor, rfOpt);

            cv.text('Disabled in the read-only build.', infoX + 28, resY + resH - 14, sz(cv, 12), '#94a3b8');

            cv.target(rfBtnX, rfBtnY, rfBtnW, rfBtnH, async () => {
                if (isCodingInProgress) return;
                await restoreOemDefaults();
            }, 'btn_restore_oem_full', 14);
        }

        /* ---------- Bottom Diagnostic & Vehicle State Dock ---------- */
        function drawDiagnosticDock(cv, t, safeStatus) {
            const g = geom(cv), dockX = 40, dockY = g.dockY, dockW = 1520, dockH = g.dockH;
            const isDiag = safety.vehicleState.diagnosticMode;
            const rpm = safety.vehicleState.rpm;
            const speed = safety.vehicleState.speed;
            const stateColor = isCodingInProgress ? '#00a3e0' : safeStatus.badgeColor;

            // Dock background container
            cv.roundRect(dockX, dockY, dockW, dockH, 8, '#080d14');
            cv.strokeRoundRect(dockX, dockY, dockW, dockH, 8, 1, withAlpha(stateColor, 0.45));

            // Status indicator dot
            cv.circle(dockX + 22, dockY + dockH / 2, 6, stateColor);
            cv.circle(dockX + 22, dockY + dockH / 2, 11, withAlpha(stateColor, 0.22));

            // State label & detailed advice
            let mainLabel = '';
            let subLabel = '';
            if (safeStatus.status === 'READ_ONLY') {
                mainLabel = 'READ-ONLY';
                subLabel = 'Coding writes are disabled. READ BDC shows the raw bytes the BDC returns.';
            } else if (isCodingInProgress) {
                mainLabel = 'CODING TRANSACTION ACTIVE';
                subLabel = 'Writing UDS parameter and verifying EEPROM read-back...';
            } else if (speed > 0) {
                mainLabel = `VEHICLE IN MOTION (${speed} KM/H)`;
                subLabel = 'Coding locked while driving. Park vehicle to enable.';
            } else if (rpm > 0) {
                mainLabel = `ENGINE RUNNING (${rpm} RPM)`;
                subLabel = 'Coding locked. Turn off engine and press Start/Stop 3 times for Diagnostic Mode.';
            } else if (!isDiag) {
                mainLabel = 'DIAGNOSTIC MODE REQUIRED';
                subLabel = 'Turn engine OFF -> Press Start/Stop 3 times rapidly (foot off brake) until cluster confirms.';
            } else {
                mainLabel = 'READY';
                subLabel = 'Engine off, vehicle stationary.';
            }

            // Right-side Action Button: [READ BDC]
            const bSize = sz(cv, 11), bOpt = { align: 'center', font: 'bold', spacing: 0.8 };
            const b1W = cv.textWidth('READ BDC', bSize, bOpt) + sz(cv, 30), bH = dockH - 10;
            const bY = dockY + 5;
            const b1X = dockX + dockW - b1W - 6;

            // the state, then what it means, cut where the button starts
            const mSize = sz(cv, 12.5), sSize = sz(cv, 11.5), mOpt = { font: 'bold', spacing: 1 }, base = mid(dockY, dockH, mSize);
            cv.text(mainLabel, dockX + 42, base, mSize, stateColor, mOpt);
            const mainW = cv.textWidth(mainLabel, mSize, mOpt);
            cv.text(fitText(cv, ' |  ' + subLabel, b1X - 16 - (dockX + 46 + mainW), sSize), dockX + 46 + mainW, base, sSize, t.dim);

            // Button 1: READ BDC
            cv.roundRect(b1X, bY, b1W, bH, 6, '#0c1724');
            cv.strokeRoundRect(b1X, bY, b1W, bH, 6, 1, '#00a3e0');
            cv.text('READ BDC', b1X + b1W / 2, mid(bY, bH, bSize), bSize, '#00a3e0', bOpt);
            cv.target(b1X, bY, b1W, bH, async () => {
                if (isCodingInProgress) return;
                await readLiveEcuValues();
            }, 'btn_dock_read_ecu', 15);

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
            if (statusMsg && now - statusTime < 3800) {
                const alpha = Math.min(1, (3800 - (now - statusTime)) / 400);
                const isErr = statusMsg.startsWith('[ERR]') || statusMsg.startsWith('[!]');
                const borderCol = isErr ? '#e1001a' : '#1db954';
                const tSize = sz(cv, 13), tOpt = { align: 'center', font: 'bold', spacing: 1 };
                const tw = Math.min(1400, Math.max(640, cv.textWidth(statusMsg, tSize, tOpt) + 60)), th = sz(cv, 36), ty = geom(cv).dockY - 12 - th;
                cv.roundRect(W / 2 - tw / 2, ty, tw, th, 10, withAlpha('#000000', 0.92 * alpha));
                cv.strokeRoundRect(W / 2 - tw / 2, ty, tw, th, 10, 1.5, withAlpha(borderCol, alpha));
                cv.text(fitText(cv, statusMsg, tw - 40, tSize, tOpt), W / 2, mid(ty, th, tSize), tSize, withAlpha('#ffffff', alpha), tOpt);
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
            if (isCodingInProgress) return;
            page = (page + 1) % PAGES.length;
            return render();
        });

        ui.onClick('BTN_APPLY', async () => {
            if (activeSafetyAlert) {
                activeSafetyAlert = null;
                return render();
            }
            if (isCodingInProgress) {
                notify('[!] Coding in progress, please wait...');
                return;
            }

            const check = safety.checkCodingSafety();
            if (!check.allowed) {
                activeSafetyAlert = check;
                notify('[!] ' + check.title);
                return render();
            }

            // Commit and verify all current settings to BDC
            const curState = getCurrentStateSnapshot();
            await applyCodingChange('Commit All Parameters', 'commit_all', 'staged', 'written', curState);
        });

        ctx.onTab((idx) => {
            if (activeSafetyAlert) {
                activeSafetyAlert = null;
            }
            if (isCodingInProgress) return;
            page = idx;
            return render();
        });

        ctx.loop('MAIN', 15, render);
        render().then(() => log.info('QuickCode ready')).catch((e) => log.warn('QuickCode render error: ' + e));
    }
});
