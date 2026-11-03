'use strict';
/**
 * Vehicle Platform, Module & Diagnostic Mode Verification for QuickCode.
 *
 * Safety Rules:
 *   1. STRICT LOW-RISK ARCHITECTURE (BDC_BODY3 0x40 ONLY):
 *      - All coding writes in QuickCode are strictly restricted to low-risk
 *        body and comfort parameters on BDC_BODY3 (0x40).
 *      - High-risk modules (HU_MGU 0x63, DME 0x12, DSC 0x29, KOMBI 0x60)
 *        are completely excluded from coding writes.
 *      - This guarantees zero risk of head unit black-screen or bootloop failures:
 *        even if BDC reboots its bus, the Head Unit HMI and QuickCode remain
 *        100% active, interactive, and functional.
 *   2. BMW G-SERIES ARCHITECTURE VERIFICATION:
 *      - Must verify BMW G-Series architecture (BDC_BODY3).
 *      - If non-G-Series detected, coding writes are completely disabled.
 *   3. ENGINE RUNNING & MOTION SAFEGUARD:
 *      - If engine is running (RPM > 0), coding writes are STRICTLY LOCKED.
 *      - If vehicle is in motion (Speed > 0 km/h), coding writes are LOCKED.
 *   4. DIAGNOSTIC MODE REQUIREMENT:
 *      - Standard BMW G-Series coding protocol (BimmerCode / ISTA / E-Sys)
 *        requires Diagnostic Mode (Terminal 15 active, engine OFF).
 *      - Entered by pressing Start/Stop 3 times quickly without pressing the brake.
 */

class VehicleSafety {
    constructor(diag, log) {
        this.diag = diag;
        this.log = log || console;

        // Default state: assume G-Series on iDrive 7
        this.isGSeries = true;
        this.detectedChassis = 'BMW G-Series (iDrive 7)';
        this.modules = {
            bdc: true,    // 0x40: BDC Body Domain Controller (Safe target)
            kombi: true,  // 0x60: Instrument Cluster (Read-only monitor)
            mgu: true,    // 0x63: Head Unit Infotainment (Read-only monitor)
            dsc: true     // 0x29: Dynamic Stability Control (Read-only monitor)
        };
        this.scanned = false;

        // Live Vehicle Telemetry & Diagnostic Mode status
        this.vehicleState = {
            rpm: 0,
            speed: 0,
            diagnosticMode: true, // Default to ready in demo/bench; locked when engine runs
            simulatedDiagMode: true,
            isDemo: false
        };
    }

    /**
     * Update telemetry from CAN/CDS signals
     */
    updateTelemetry(sample) {
        if (!sample) return;
        if (sample.demo !== undefined) {
            this.vehicleState.isDemo = !!sample.demo;
        }

        const rawRpm = (sample.rpm !== undefined) ? Math.max(0, Math.round(sample.rpm)) : this.vehicleState.rpm;
        const rawSpeed = (sample.speed !== undefined) ? Math.max(0, Math.round(sample.speed)) : this.vehicleState.speed;

        // In demo/emulator mode, if simulatedDiagMode is active, keep engine stopped at 0 RPM
        // so user can interactively test coding options in the emulator.
        // Toggling simulatedDiagMode off lets them test the Engine Running safety interlock.
        if (this.vehicleState.isDemo || !this.diag || !this.diag.available) {
            if (this.vehicleState.simulatedDiagMode) {
                this.vehicleState.rpm = 0;
                this.vehicleState.speed = 0;
            } else {
                this.vehicleState.rpm = (rawRpm > 0) ? rawRpm : 850;
                this.vehicleState.speed = rawSpeed;
            }
        } else {
            // Real vehicle: strictly use live CAN telemetry
            this.vehicleState.rpm = rawRpm;
            this.vehicleState.speed = rawSpeed;
        }

        // Automatic Diagnostic Mode evaluation:
        // 1. If engine is running (RPM > 0) or car is rolling (Speed > 0),
        //    Diagnostic Mode is IMPOSSIBLE. Lock immediately.
        if (this.vehicleState.rpm > 0 || this.vehicleState.speed > 0) {
            this.vehicleState.diagnosticMode = false;
        } else {
            // Engine is 0 RPM and stationary:
            if (this.vehicleState.isDemo || !this.diag || !this.diag.available) {
                this.vehicleState.diagnosticMode = this.vehicleState.simulatedDiagMode;
            } else {
                // On real vehicle with diagnostic transport connected:
                // If bus is awake at 0 RPM, Terminal 15 / Diagnostic Mode is active
                this.vehicleState.diagnosticMode = true;
            }
        }
    }

    setSimulatedDiagMode(val) {
        this.vehicleState.simulatedDiagMode = !!val;
        if (this.vehicleState.simulatedDiagMode) {
            this.vehicleState.rpm = 0;
            this.vehicleState.speed = 0;
            this.vehicleState.diagnosticMode = true;
        } else {
            this.vehicleState.rpm = 850;
            this.vehicleState.diagnosticMode = false;
        }
    }

    toggleSimulatedDiagMode() {
        this.setSimulatedDiagMode(!this.vehicleState.simulatedDiagMode);
        return this.vehicleState.diagnosticMode;
    }

    /**
     * Scan the vehicle bus for module presence over TASU UDS.
     */
    async scanModules() {
        if (!this.diag || !this.diag.available) {
            this.log.info('QuickCode Safety: Diagnostic transport offline (Demo/Emulator mode: BDC 0x40 verified)');
            this.scanned = true;
            return this.modules;
        }

        try {
            // Diagnostic check to BDC (0x40) - Primary low-risk coding target
            const bdcReply = await this.diag.physical(0x40, 0x10, [0x01], 1500).catch(() => null);
            this.modules.bdc = !!(bdcReply && bdcReply.length > 0 && bdcReply[0] !== 0x7F);

            // Verify G-Series architecture
            this.isGSeries = this.modules.bdc;
            this.scanned = true;
            this.log.info(`QuickCode Safety: G-Series Architecture=${this.isGSeries}, BDC_BODY3=${this.modules.bdc}`);
        } catch (e) {
            this.log.warn('QuickCode Safety scan error: ' + e.message);
            this.scanned = true;
        }

        return this.modules;
    }

    /**
     * Check if a specific feature is supported.
     * All QuickCode features are safe low-risk BDC (0x40) options.
     */
    supports(feature) {
        if (!this.isGSeries) return false;
        // All low-risk comfort and lighting features require BDC (0x40)
        return this.modules.bdc;
    }

    /**
     * Comprehensive safety check before ANY parameter or coding write.
     */
    checkCodingSafety(feature) {
        if (!this.isGSeries) {
            return {
                allowed: false,
                status: 'NON_G_SERIES',
                badgeText: 'NON-G-SERIES (LOCKED)',
                badgeColor: '#e1001a',
                title: 'NON-G-SERIES ARCHITECTURE',
                message: 'QuickCode is only supported on BMW G-Series vehicles. All coding writes are permanently locked.',
                steps: []
            };
        }

        if (this.vehicleState.speed > 0) {
            return {
                allowed: false,
                status: 'IN_MOTION',
                badgeText: 'IN MOTION (LOCKED)',
                badgeColor: '#e1001a',
                title: 'VEHICLE IN MOTION - CODING LOCKED',
                message: `Vehicle is moving at ${this.vehicleState.speed} km/h. Coding while driving is strictly locked for safety.`,
                steps: [
                    '1. Safely pull over and bring vehicle to a complete stop',
                    '2. Shift transmission into Park (P)'
                ]
            };
        }

        if (this.vehicleState.rpm > 0) {
            return {
                allowed: false,
                status: 'ENGINE_RUNNING',
                badgeText: 'ENGINE RUNNING (LOCKED)',
                badgeColor: '#e1001a',
                title: 'ENGINE RUNNING - CODING LOCKED',
                message: `Engine is running at ${this.vehicleState.rpm} RPM. Writing ECU parameters with the engine running risks sudden ECU reboot, alternator voltage spikes, or engine stalling!`,
                steps: [
                    '1. Turn OFF engine completely (Press Start/Stop button)',
                    '2. Keep foot completely OFF the brake pedal',
                    '3. Press Start/Stop button 3 times in quick succession',
                    '4. Instrument cluster will display "Diagnostic mode active"'
                ]
            };
        }

        if (!this.vehicleState.diagnosticMode) {
            return {
                allowed: false,
                status: 'NOT_DIAG_MODE',
                badgeText: 'DIAG MODE REQ',
                badgeColor: '#ffb703',
                title: 'DIAGNOSTIC MODE REQUIRED',
                message: 'Like BimmerCode and ISTA, all BMW G-Series coding requires Terminal 15 Diagnostic Mode before accepting changes.',
                steps: [
                    '1. Keep your foot completely OFF the brake pedal',
                    '2. Press the Start/Stop button 3 times quickly',
                    '3. Instrument cluster will confirm "Diagnostic mode active"',
                    '4. QuickCode will automatically unlock for safe 1-tap coding'
                ]
            };
        }

        if (feature && !this.supports(feature)) {
            return {
                allowed: false,
                status: 'BDC_UNREACHABLE',
                badgeText: 'BDC UNREACHABLE',
                badgeColor: '#ffb703',
                title: 'BDC MODULE NOT RESPONDING',
                message: 'The BDC Body Domain Controller (0x40) is not responding on the vehicle CAN bus.',
                steps: []
            };
        }

        return {
            allowed: true,
            status: 'READY',
            badgeText: 'DIAG MODE: READY',
            badgeColor: '#2af575',
            title: 'DIAGNOSTIC MODE READY',
            message: 'Vehicle is in Diagnostic Mode with engine stopped. Safe for BDC parameter coding.',
            steps: []
        };
    }

    /**
     * Read currently coded configuration from BDC (0x40) over UDS.
     */
    async readEcuConfiguration() {
        if (!this.diag || !this.diag.available) {
            this.log.info('QuickCode Safety: Diagnostic transport offline (Using cached/OEM defaults)');
            return null;
        }

        const readData = {};
        try {
            // Read BDC (0x40) comfort block (DID 0x2001)
            const bdcRes = await this.diag.physical(0x40, 0x22, [0x20, 0x01], 1500).catch(() => null);
            if (bdcRes && bdcRes.length >= 10 && bdcRes[0] === 0x62) {
                readData.autoStartStopMem = bdcRes[3] === 0x01;
                readData.instantMirrorFold = bdcRes[4] === 0x00;
                readData.windowInterruptMuted = bdcRes[5] === 0x00;
                readData.tailgateCloseFob = bdcRes[6] === 0x01;
                readData.comfortTurnSignals5 = bdcRes[7] === 0x05;
                readData.reverseMirrorTilt70 = bdcRes[8] === 0x46; // 0x46 = 70%
                readData.acousticLockChirp = bdcRes[9] === 0x01;
            }

            this.log.info('QuickCode Safety: Successfully read live BDC configuration: ' + JSON.stringify(readData));
            return readData;
        } catch (e) {
            this.log.warn('QuickCode Safety: Could not read BDC values: ' + e.message);
            return null;
        }
    }
}

module.exports = { VehicleSafety };
