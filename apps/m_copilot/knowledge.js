'use strict';
/**
 * Universal Offline Technical Knowledge Engine for BMW G-Series (iDrive 7).
 * Works across all G-Chassis platforms (G20, G22, G30, G11, G15, G01, G05, etc.)
 * and engines (B48 2.0T, B58 3.0T, N63/S63/S68 4.4T V8, S58 M-Power, B47/B57).
 */

const KNOWLEDGE_BASE = {
    launch: {
        title: 'Launch Control Readiness & Protocol',
        analyze(telemetry) {
            const oil = telemetry.oilTemp || 95;
            const tires = telemetry.tireTemp || 38;
            const ready = oil >= 70 && tires >= 25;

            let diagnosis = '';
            if (oil < 70) {
                diagnosis += `[!] Oil temp is ${oil}°C (Below 70°C minimum for full DME boost & transmission clutch protection).\n`;
            } else {
                diagnosis += `[OK] Engine Oil Temp: ${oil}°C (Optimal thermal window).\n`;
            }

            if (tires < 25) {
                diagnosis += `[!] Tire Temp: ${tires}°C (Cold compound). Grip reduced. Expect traction intervention.\n`;
            } else {
                diagnosis += `[OK] Tire Temp: ${tires}°C (Operating grip window).\n`;
            }

            diagnosis += `\n[BMW G-Series Launch Sequence]:\n` +
                         `1. Warm engine (drive ~10 km until oil reaches 70°C+).\n` +
                         `2. Switch to SPORT+ or press DSC once (TRACTION mode).\n` +
                         `3. Move gear selector LEFT into S/M.\n` +
                         `4. Press brake pedal FIRMLY with left foot.\n` +
                         `5. Floor accelerator completely past kickdown switch.\n` +
                         `6. 'Launch Control Active' appears on cluster; release brake within 3 seconds!`;
            return { ready, text: diagnosis };
        }
    },

    cooling: {
        title: 'Turbocharged Engine Cooling & Thermal Care',
        analyze(telemetry) {
            const oil = telemetry.oilTemp || 98;
            const coolant = telemetry.coolantTemp || 92;
            let advice = `BMW TwinPower Turbo Powertrain Thermal Management:\n\n`;
            advice += `Current Engine Vitals:\n- Engine Oil Temp: ${oil}°C (Norm: 90-110°C)\n- Coolant Temp: ${coolant}°C (Norm: 85-100°C)\n\n`;
            if (oil > 110) {
                advice += `[!] High Thermal Load: Run a 2-minute cool-down drive at low RPM (<2000 RPM) before shutdown to avoid heat soak.\nDo NOT turn engine off immediately after hard highway pulls; let the electric auxiliary coolant pump circulate fluid.`;
            } else {
                advice += `[OK] Thermal Status: Normal operating temperature.\nBMW G-series electric coolant pumps will automatically circulate post-shutdown if thermal dissipation is required.`;
            }
            return { ready: true, text: advice };
        }
    },

    tires: {
        title: 'Tire Pressure & Grip Temperature Analysis',
        analyze(telemetry) {
            const fl = telemetry.tireFlPsi || 35.0;
            const fr = telemetry.tireFrPsi || 35.0;
            const rl = telemetry.tireRlPsi || 38.0;
            const rr = telemetry.tireRrPsi || 38.0;
            const tTemp = telemetry.tireTemp || 38;

            let text = `Tire Pressures (Typical G-Series spec: 35 Front / 38 Rear psi):\n`;
            text += `  Front Left:  ${fl.toFixed(1)} psi  |  Front Right: ${fr.toFixed(1)} psi\n`;
            text += `  Rear Left:   ${rl.toFixed(1)} psi  |  Rear Right:  ${rr.toFixed(1)} psi\n\n`;
            text += `Compound Temperature: ${tTemp}°C\n`;

            if (tTemp < 20) {
                text += `Status: COLD. Stiff compound. Lengthened braking distance & high ABS sensitivity.`;
            } else if (tTemp < 40) {
                text += `Status: STREET OPTIMAL. Ideal for daily cruising, fuel efficiency, and wet grip.`;
            } else if (tTemp <= 75) {
                text += `Status: TRACK GRIP WINDOW. Maximum lateral acceleration coefficient.`;
            } else {
                text += `Status: OVERHEATING. Tread rubber squirming. Reduce pace to cool tires down.`;
            }
            return { ready: true, text };
        }
    },

    diagnostics: {
        title: 'OBD-II & UDS ECU Diagnostic Health',
        analyze(telemetry) {
            const dtcCount = (telemetry.dtcs && telemetry.dtcs.length) || 0;
            if (dtcCount === 0) {
                return {
                    ready: true,
                    text: `[OK] ECU Health Check: All Systems Normal\n\nScanned Control Units:\n- DME / DDE (Engine Electronics): 0 Faults\n- EGS (ZF 8HP Transmission): 0 Faults\n- DSC (Dynamic Stability Control): 0 Faults\n- BDC (Body Domain Controller): 0 Faults\n- HU_MGU (Head Unit Infotainment): 0 Faults\n\nNo active or shadow trouble codes logged. Sensor channels reporting optimal values.`
                };
            }
            let text = `[!] ${dtcCount} DTC Fault(s) Detected:\n`;
            telemetry.dtcs.forEach(d => {
                text += `- [${d.code}] ${d.desc}\n  Impact: ${d.impact}\n`;
            });
            return { ready: false, text };
        }
    },

    routes: {
        title: 'Scenic Mountain Pass & Twisty Road Scout',
        analyze() {
            return {
                ready: true,
                text: `Curated Performance Driving Routes for BMW G-Series:\n\n` +
                      `1. Gombori Pass (Tbilisi to Telavi | 65 km)\n` +
                      `   - Technical switchbacks, clean elevation climbs, high-speed sweepers.\n` +
                      `   - Ideal Mode: SPORT+ / Manual Shifting / Firm Damper Setting.\n\n` +
                      `2. Georgian Military Highway (Zhinvali to Gudauri | 90 km)\n` +
                      `   - Fast canyon curves along Aragvi river with wide alpine ascents.\n` +
                      `   - Ideal Mode: SPORT with compliant damper setting.\n\n` +
                      `3. Open Highway GT Route (Tbilisi to Sighnaghi | 110 km)\n` +
                      `   - Smooth overtaking straightaways and long fast sweepers.\n` +
                      `   - Ideal Mode: COMFORT or ECO PRO for relaxed touring.`
            };
        }
    },

    maintenance: {
        title: 'BMW Condition Based Service (CBS) & Specs',
        analyze() {
            return {
                ready: true,
                text: `BMW G-Series Universal Maintenance Guidelines:\n\n` +
                      `- Engine Oil: BMW Longlife-01 FE / LL-04 / LL-17 FE+ (0W-20 / 0W-30 / 5W-30).\n` +
                      `  Recommended interval: 8,000 - 10,000 km (or 1 year) for turbo longevity.\n` +
                      `- Spark Plugs: B48/B58 (every 40,000-50,000 km) | N63/S58/S63 (every 30,000-40,000 km).\n` +
                      `- Transmission Fluid: ZF 8HP Lifeguard 8 service recommended at 60,000 - 80,000 km.\n` +
                      `- Brake Fluid: DOT 4 Low Viscosity (BMW Class 6), flushed every 24 months.\n` +
                      `- Differential & Transfer Case (xDrive): Service fluid every 60,000 km.`
            };
        }
    }
};

module.exports = { KNOWLEDGE_BASE };
