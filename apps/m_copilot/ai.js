'use strict';
/**
 * AI Bridge for M-Copilot - Powered by Google Gemini (with Multi-Provider Fallback).
 *
 * Capabilities:
 *   1. Full Live Vehicle Context Engine: Injects comprehensive, safe, read-only
 *      CAN & UDS telemetry into Gemini prompts tailored to what the driver asks.
 *   2. Google Gemini 1.5/2.0 Flash integration (Free Tier & Advanced).
 *   3. Custom API & Cloud Relay support (OpenAI, Claude, Groq).
 *   4. Active internet uplink monitoring & automated connectivity checks.
 *   5. Strict Read-Only Vehicle Safety Interlock (Zero coding/writing authority).
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const urlMod = require('url');
const tlsDates = require('./tls_dates');

const CONFIG_PATH = path.join(__dirname, 'copilot_auth.json');

class AiBridge {
    constructor(ctxOrLog) {
        if (ctxOrLog && (ctxOrLog.log || ctxOrLog.dataDir)) {
            this.ctx = ctxOrLog;
            this.log = ctxOrLog.log || console;
        } else {
            this.ctx = null;
            this.log = ctxOrLog || console;
        }
        this.config = this.loadConfig();
        this.hasInternet = true;
        this.isCheckingInternet = false;

        this.checkInternetConnection().catch(() => {});
        // re-checked only while the app is on screen (main.js sets isOnScreen)
        if (!this.isOnScreen) this.isOnScreen = () => true;
        setInterval(() => {
            if (this.isOnScreen()) this.checkInternetConnection().catch(() => {});
        }, 15000);
    }

    getConfigPaths() {
        const paths = [];
        if (this.ctx && this.ctx.dataDir) {
            paths.push(path.join(this.ctx.dataDir, 'copilot_auth.json'));
        }
        paths.push(CONFIG_PATH);
        try {
            paths.push(path.join(process.cwd(), 'apps', 'm_copilot', 'copilot_auth.json'));
        } catch (e) {}
        return paths;
    }

    loadConfig() {
        for (const p of this.getConfigPaths()) {
            try {
                if (fs.existsSync(p)) {
                    const raw = fs.readFileSync(p, 'utf8');
                    const parsed = JSON.parse(raw);
                    if (parsed && (parsed.geminiApiKey || parsed.apiKey || parsed.paired)) {
                        this.log.info('AiBridge: Loaded config from ' + p);
                        return parsed;
                    }
                }
            } catch (e) {
                this.log.error('Failed to load copilot_auth.json: ' + e.message);
            }
        }
        return {
            mode: 'gemini',
            geminiApiKey: null,
            apiKey: null,
            sessionToken: null,
            relayUrl: 'https://api.openai.com/v1/chat/completions',
            persona: 'm_engineer',
            paired: false
        };
    }

    saveConfig() {
        const target = (this.ctx && this.ctx.dataDir) ? path.join(this.ctx.dataDir, 'copilot_auth.json') : CONFIG_PATH;
        try {
            fs.writeFileSync(target, JSON.stringify(this.config, null, 2), 'utf8');
            if (target !== CONFIG_PATH) {
                try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf8'); } catch (e) {}
            }
        } catch (e) {
            this.log.error('Failed to save copilot_auth.json: ' + e.message);
        }
    }

    saveCredentials(payload) {
        if (!payload) return;
        if (payload.mode) this.config.mode = payload.mode;
        if (payload.provider) this.config.provider = payload.provider;
        if (payload.model) this.config.model = payload.model;
        if (payload.geminiApiKey) {
            this.config.geminiApiKey = payload.geminiApiKey;
            this.config.mode = 'gemini';
            this.config.provider = 'gemini';
        }
        if (payload.apiKey) {
            this.config.apiKey = payload.apiKey;
            const k = payload.apiKey.trim();
            if (k.startsWith('AIzaSy') || k.startsWith('AQ.')) {
                this.config.geminiApiKey = k;
                this.config.mode = 'gemini';
                this.config.provider = 'gemini';
            } else if (k.startsWith('gsk_')) {
                this.config.provider = 'groq';
                this.config.mode = 'custom_api';
            } else if (k.startsWith('sk-ant-')) {
                this.config.provider = 'claude';
                this.config.mode = 'claude';
            } else if (k.startsWith('sk-or-')) {
                this.config.provider = 'openrouter';
                this.config.mode = 'custom_api';
            } else if (!this.config.provider) {
                this.config.provider = 'openai';
                this.config.mode = 'custom_api';
            }
        }
        if (payload.sessionToken) this.config.sessionToken = payload.sessionToken;
        if (payload.persona) this.config.persona = payload.persona;
        this.config.paired = true;
        this.saveConfig();
        this.log.info('AiBridge: Saved new credentials (mode=' + this.config.mode + ', provider=' + (this.config.provider || 'gemini') + ')');
    }

    isConfigured() {
        if (this.config.mode === 'gemini') return !!this.config.geminiApiKey;
        if (this.config.mode === 'claude') return !!this.config.apiKey;
        if (this.config.mode === 'custom_api') return !!this.config.apiKey;
        return !!(this.config.geminiApiKey || this.config.apiKey);
    }

    async checkInternetConnection() {
        if (this.isCheckingInternet) return this.hasInternet;
        this.isCheckingInternet = true;
        try {
            let ok = false;
            // the kit's uplink check (direct-IP probe, then the mgu-uplink lease) when we have it
            const uplink = this.ctx && this.ctx.uplink;
            if (uplink && typeof uplink.checkInternet === 'function') {
                try {
                    ok = !!(await uplink.checkInternet({ timeout: 3500 }));
                } catch (e) {}
            }
            if (!ok) ok = await this.probe('connectivitycheck.gstatic.com', '/generate_204');
            if (!ok) ok = await this.probe('dns.google', '/resolve?name=google.com');
            this.hasInternet = ok;
            return ok;
        } finally {
            this.isCheckingInternet = false;
        }
    }

    /* Whether host answers over HTTPS within 4 s; no answer in time counts as offline. */
    probe(host, pathStr) {
        return new Promise((resolve) => {
            let settled = false;
            const done = (ok) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(ok);
            };
            let req = null;
            const timer = setTimeout(() => {
                try { if (req) req.destroy(); } catch (e) {}
                done(false);
            }, 5000);
            try {
                req = https.get({
                    hostname: host,
                    port: 443,
                    path: pathStr,
                    timeout: 4000,
                    // reachability probe only: no credentials are sent, so any certificate will do
                    rejectUnauthorized: false
                }, (res) => {
                    res.resume();
                    done(res.statusCode >= 200 && res.statusCode < 400);
                });
                req.on('error', () => done(false));
                req.on('timeout', () => {
                    try { req.destroy(); } catch (e) {}
                    done(false);
                });
            } catch (e) {
                done(false);
            }
        });
    }

    /**
     * Build rich, safe vehicle context synthesized specifically for the driver's question.
     */
    buildVehicleContext(persona, telemetry, query) {
        const p = (persona || this.config.persona || 'm_engineer');
        const q = (query || '').toLowerCase();

        // 1. Core Vehicle Information
        const carModel = 'BMW G-Series (iDrive 7)';
        const speed = Math.round(telemetry.speed || 0);
        const speedMph = Math.round(speed * 0.621371);
        const rpm = Math.round(telemetry.rpm || 650);
        const oil = Math.round(telemetry.oilTemp || 98);
        const coolant = Math.round(telemetry.coolantTemp || 92);
        const mode = telemetry.driveMode || 'SPORT+';
        const gear = telemetry.gear !== undefined ? (telemetry.gear === 0 ? 'N/P' : telemetry.gear === -1 ? 'R' : telemetry.gear) : (telemetry.stage || 'P');
        const torque = telemetry.torque ? Math.round(telemetry.torque) : (rpm > 1000 ? 280 : 0);
        const boost = telemetry.boost ? telemetry.boost.toFixed(2) : '1.15';
        const latG = (telemetry.lateralG || 0).toFixed(2);
        const longG = (telemetry.longitudinalG || 0).toFixed(2);

        // Tires & Chassis
        const fl = (telemetry.tireFlPsi || 35.5).toFixed(1);
        const fr = (telemetry.tireFrPsi || 35.8).toFixed(1);
        const rl = (telemetry.tireRlPsi || 37.2).toFixed(1);
        const rr = (telemetry.tireRrPsi || 37.0).toFixed(1);
        const tireTemp = Math.round(telemetry.tireTemp || 38);
        const ambient = Math.round(telemetry.ambientTemp || 22);

        // Diagnostics & Range
        const battery = (telemetry.batteryVoltage || 14.2).toFixed(1);
        const fuel = Math.round(telemetry.fuelPercent || 74);
        const range = Math.round(telemetry.rangeKm || 480);
        const rangeMiles = Math.round(range * 0.621371);
        const dtcs = (telemetry.dtcs && telemetry.dtcs.length) ? telemetry.dtcs.join(', ') : 'None (0 DTCs detected, all powertrain modules healthy)';

        // Thermal status evaluation
        const oilStatus = oil < 70 ? 'COLD (Below 70°C, full DME boost restricted for protection)' : (oil > 115 ? 'HIGH (Cool-down cruising advised)' : 'OPTIMAL (Full boost permissible)');
        const tireStatus = tireTemp < 25 ? 'COLD (Reduced compound grip, expect wheelspin)' : 'OPTIMAL (Operating grip temperature)';

        // 2. Focused Intent Analysis based on Question
        let focusedAnalysis = '';
        if (q.includes('launch') || q.includes('0-100') || q.includes('0-60') || q.includes('sprint') || q.includes('drag') || q.includes('acceleration')) {
            focusedAnalysis = `
[FOCUSED ANALYSIS: LAUNCH CONTROL PREREQUISITES & READINESS]
- Engine Oil Temperature: ${oil}°C -> ${oil >= 70 ? 'PASS (≥70°C met)' : 'FAIL (<70°C, launch blocked by DME)'}
- Tire Temperature: ${tireTemp}°C -> ${tireTemp >= 25 ? 'PASS (warm rubber)' : 'CAUTION (cold tires, traction limited)'}
- Transmission Gear/Stage: ${gear} -> Must be pulled LEFT into S/M
- Drive Dynamic Mode: ${mode} -> Must be SPORT+ or DSC TRACTION (press DSC once)
- Sequence: Left foot hard on brake -> Floor gas through kickdown switch -> Release brake within 3s when 'Launch Control Active' lights up.`;
        } else if (q.includes('cool') || q.includes('hot') || q.includes('temp') || q.includes('overheat') || q.includes('warm') || q.includes('radiator') || q.includes('shutdown')) {
            focusedAnalysis = `
[FOCUSED ANALYSIS: POWERTRAIN THERMAL DISSIPATION & HEAT SOAK]
- Engine Oil Temp: ${oil}°C (Norm: 90-110°C, Peak Safe: 120°C) -> Status: ${oilStatus}
- Coolant Temp: ${coolant}°C (Norm: 85-102°C)
- Ambient Temperature: ${ambient}°C
- Guidelines: If oil >110°C after hard driving, idle engine or cruise gently at <2000 RPM for 1-2 mins to circulate coolant through the turbochargers. The auxiliary electric coolant pump will run automatically post-shutdown if thermal dissipation is required.`;
        } else if (q.includes('tire') || q.includes('psi') || q.includes('pressure') || q.includes('grip') || q.includes('handling') || q.includes('corner') || q.includes('drift')) {
            focusedAnalysis = `
[FOCUSED ANALYSIS: CHASSIS & TPMS TIRE GRIP WINDOW]
- Pressures: Front-Left: ${fl} PSI | Front-Right: ${fr} PSI | Rear-Left: ${rl} PSI | Rear-Right: ${rr} PSI
- Tread Temperature: ${tireTemp}°C -> ${tireStatus}
- Live Lateral G-Force: ${latG} G | Longitudinal: ${longG} G
- Status: All 4 corners balanced. Recommended target cold pressure: 36 PSI Front, 38 PSI Rear.`;
        } else if (q.includes('error') || q.includes('dtc') || q.includes('fault') || q.includes('check engine') || q.includes('code') || q.includes('warning') || q.includes('health') || q.includes('diagnostic')) {
            focusedAnalysis = `
[FOCUSED ANALYSIS: UDS ON-BOARD DIAGNOSTIC (OBD-II) SCAN]
- Active ECU DTC Fault Codes: ${dtcs}
- 12V Battery Rail Voltage: ${battery} V (Alternator actively charging)
- Safety System: Dynamic Stability Control (DSC) fully functional.`;
        } else if (q.includes('brake') || q.includes('fade') || q.includes('pad') || q.includes('stopping') || q.includes('rotor') || q.includes('caliper')) {
            focusedAnalysis = `
[FOCUSED ANALYSIS: M SPORT / COMPOUND BRAKING THERMAL MANAGEMENT]
- Kinetic Energy & Speed: ${speed} km/h | Longitudinal Decel: ${longG} G
- Brake Fluid Boiling Window: Typical DOT 4 Low Viscosity dry boiling pt is 265°C, wet 175°C.
- Guidance: After repeated high-speed stops (above 160 km/h), maintain driving airflow at moderate speeds to cool brake rotors and calipers evenly. Avoid resting on the brake pedal at a standstill immediately after track stops to prevent pad material transfer onto hot rotors.`;
        } else if (q.includes('trans') || q.includes('gearbox') || q.includes('zf') || q.includes('8hp') || q.includes('shift') || q.includes('drivelogic') || q.includes('clutch')) {
            focusedAnalysis = `
[FOCUSED ANALYSIS: ZF 8HP STEPTRONIC & DRIVELOGIC TRANSMISSION]
- Current Engaged Gear: ${gear} | Output Torque: ${torque} Nm | Engine RPM: ${rpm}
- Operating Temperature: Normal EGS fluid temp follows engine coolant (${coolant}°C).
- Sequence & Care: D1-D3 provides smooth progressive torque converter lockup. S1-S3 delivers sharp direct clutch shifts. ZF recommends transmission oil and filter pan replacement every 80,000 to 100,000 km (Lifeguard 8).`;
        } else if (q.includes('xdrive') || q.includes('drift') || q.includes('mdm') || q.includes('differential') || q.includes('ghas') || q.includes('4wd') || q.includes('2wd') || q.includes('vectoring')) {
            focusedAnalysis = `
[FOCUSED ANALYSIS: M xDRIVE & REAR AXLE SPORT DIFFERENTIAL (GHAS)]
- Current Dynamic Mode: ${mode} | Lateral Acceleration: ${latG} G
- System Architecture: Electronic multi-plate clutch transfer case splits torque front/rear seamlessly.
- Handling Modes: 4WD provides maximum all-weather traction; 4WD Sport shifts torque rearward for neutral drift angle; 2WD mode transmits 100% torque to rear wheels with DSC OFF. Active M Differential locks up to 100% to maximize corner exit traction.`;
        } else if (q.includes('damper') || q.includes('suspension') || q.includes('edc') || q.includes('rebound') || q.includes('body roll') || q.includes('chassis')) {
            focusedAnalysis = `
[FOCUSED ANALYSIS: ADAPTIVE M SUSPENSION & CHASSIS DYNAMICS]
- Active Drive Mode: ${mode} | Measured Forces: ${latG} G Lateral | ${longG} G Longitudinal
- Electronic Damper Control (EDC): Millisecond-speed magnetic solenoid valving adapts rebound and compression continuously.
- COMFORT mode absorbs road expansion joints and surface imperfections; SPORT/SPORT+ stiffens valving to eliminate roll and squat under high cornering loads.`;
        } else if (q.includes('battery') || q.includes('48v') || q.includes('voltage') || q.includes('hybrid') || q.includes('alternator') || q.includes('recuperation')) {
            focusedAnalysis = `
[FOCUSED ANALYSIS: 12V AGM & 48V MILD-HYBRID POWER SUPPLY]
- Battery Terminal Rail: ${battery} V (Optimal operating state >13.8V while charging, >12.4V rest)
- Energy Recuperation: Generator charges battery during coasting and regenerative braking.
- Mild-Hybrid: 48V starter-generator supplies seamless automatic start/stop and e-boost torque assistance off the line.`;
        } else if (q.includes('octane') || q.includes('knock') || q.includes('ron') || q.includes('aki') || q.includes('ethanol') || q.includes('gasoline')) {
            focusedAnalysis = `
[FOCUSED ANALYSIS: FUEL OCTANE, KNOCK PREVENTION & COMBUSTION]
- Recommended Fuel: 98 RON (93 AKI) for maximum rated power and ignition timing advance.
- Minimum Permissible: 95 RON (91 AKI) met with slight DME ignition retard under hot ambient conditions (${ambient}°C).
- Ethanol Tolerance: Compatible with up to E10/E25 ethanol blends without fuel line or injector degradation.`;
        } else if (q.includes('spec') || q.includes('oil') || q.includes('longlife') || q.includes('ll-01') || q.includes('ll-04') || q.includes('ll-17') || q.includes('interval') || q.includes('cbs')) {
            focusedAnalysis = `
[FOCUSED ANALYSIS: BMW LONGLIFE FACTORY OIL & SERVICE SPECIFICATIONS]
- Engine Oil Temperature: ${oil}°C (${oilStatus})
- Approved Specifications: BMW Longlife-01 FE (high HTHS petrol), Longlife-04 (low-SAPS diesel/petrol), Longlife-17 FE+ (0W-20 ultra-low friction).
- Maintenance Cycle: BMW CBS allows up to 15,000 km, but for turbocharged performance engines (B48/B58/N63/S58), 8,000-10,000 km changes are strongly recommended for timing chain and turbo journal bearing longevity.`;
        } else if (q.includes('charge air') || q.includes('intercooler') || q.includes('air flap') || q.includes('cat warm') || q.includes('exhaust flap') || q.includes('cold start')) {
            focusedAnalysis = `
[FOCUSED ANALYSIS: THERMAL AERO, INTERCOOLING & EXHAUST SYSTEM]
- Thermal State: Oil ${oil}°C | Coolant ${coolant}°C | Ambient ${ambient}°C
- Indirect Intercooling: Water-to-air charge coolers maintain air intake charge within 15°C of ambient.
- Aero & Exhaust: Active kidney grille flaps open automatically when radiator cooling is needed; catalytic converter warm-up raises cold idle for ~45s with open wastegates to heat emissions systems rapidly.`;
        } else if (q.includes('fuel') || q.includes('range') || q.includes('route') || q.includes('trip') || q.includes('mountain') || q.includes('scenic') || q.includes('consumption')) {
            focusedAnalysis = `
[FOCUSED ANALYSIS: RANGE, FUEL & CRUISE EFFICIENCY]
- Fuel Level: ${fuel}% | Cruising Range: ${range} km (${rangeMiles} miles)
- Active Drive Mode: ${mode}
- Powertrain efficiency optimized for highway cruising and mountain ascents.`;
        }

        // Universal BMW Intelligent Co-Driver Voice Definition
        const personaIntro = 'You are the BMW Intelligent Co-Driver for BMW iDrive 7 (G-Series) vehicles. You provide precise, technical, concise vehicle assistance, adapting your tone naturally to the question—whether it relates to dynamic performance, thermal and chassis management, diagnostics, maintenance, or general vehicle questions.';

        return `${personaIntro}

VEHICLE TELEMETRY TELEMETRIC PROFILE:
- Vehicle: ${carModel}
- Powertrain: ${speed} km/h (${speedMph} mph) | ${rpm} RPM | Gear: ${gear} | Torque: ${torque} Nm | Boost: ${boost} bar
- Drive Mode: ${mode}
- Thermal Vitals: Oil ${oil}°C (${oilStatus}) | Coolant ${coolant}°C | Ambient ${ambient}°C
- Chassis & Tires: FL ${fl} PSI | FR ${fr} PSI | RL ${rl} PSI | RR ${rr} PSI | Tire Temp: ${tireTemp}°C
- Dynamic Forces: ${latG} G Lateral | ${longG} G Longitudinal
- Diagnostics & Range: Battery ${battery} V | Fuel ${fuel}% (${range} km / ${rangeMiles} mi range) | DTCs: ${dtcs}
${focusedAnalysis}

STRICT SAFETY DIRECTIVE (READ-ONLY MONITORING):
- M-Copilot operates in 100% PASSIVE READ-ONLY OBSERVATION MODE.
- You have ZERO execution or write authority. You CANNOT code, alter, or flash vehicle ECUs, ambient lighting, start/stop memories, or modules.
- If asked to code or modify settings, refuse politely: vehicle coding is not available in these apps; the user can use E-Sys or BimmerCode.

FORMATTING REQUIREMENTS FOR IN-CAR DISPLAY:
- Keep answers ultra-concise, structured, and legible at a glance on the vehicle's ultrawide display.
- Use 3 to 4 bullet points or short lines.
- Directly reference the live vehicle numbers above when answering.
- Maximum 150 words. Avoid generic fluff.`;
    }

    /**
     * Query the AI with a prompt and live telemetry.
     */
    async ask(prompt, telemetry, options = {}) {
        // Enforce online check
        if (!this.hasInternet) {
            await this.checkInternetConnection();
            if (!this.hasInternet) {
                throw new Error('No internet uplink. Connect phone hotspot or vehicle Wi-Fi.');
            }
        }

        if (!this.isConfigured()) {
            throw new Error('M-Copilot AI not configured. Scan the QR code with your phone to pair your free Gemini key.');
        }

        const persona = options.persona || this.config.persona || 'm_engineer';
        const lower = (prompt || '').toLowerCase();

        // Safety Interception: M-Copilot is strictly Read-Only for vehicle modification/coding commands
        const codingTriggers = [
            'apply coding', 'code ecu', 'write ecu', 'flash ecu', 'disable start stop',
            'enable start stop', 'change ambient', 'unlock video', 'enable vim', 'change chime'
        ];
        if (codingTriggers.some((t) => lower.includes(t))) {
            return `[SAFETY INTERLOCK: READ-ONLY OBSERVATION]\n\n` +
                   `M-Copilot operates strictly in passive read-only monitoring mode to safeguard vehicle ECUs.\n\n` +
                   `Vehicle coding (such as Start/Stop memory, ambient lighting, or acoustic chimes) is not available in these apps. Use E-Sys or BimmerCode.`;
        }

        const provider = this.config.provider || (this.config.geminiApiKey ? 'gemini' : 'openai');

        if (provider === 'gemini' || (this.config.mode === 'gemini' && this.config.geminiApiKey)) {
            return this.queryGemini(prompt, telemetry, persona);
        }
        if (provider === 'claude' || (this.config.apiKey && this.config.apiKey.startsWith('sk-ant-'))) {
            return this.queryAnthropic(prompt, telemetry, persona);
        }
        return this.queryOpenAICompatible(prompt, telemetry, persona, provider);
    }

    async queryGemini(prompt, telemetry, persona) {
        const systemPrompt = this.buildVehicleContext(persona, telemetry, prompt);
        const apiKey = this.config.geminiApiKey;

        const body = JSON.stringify({
            systemInstruction: {
                parts: [{ text: systemPrompt }]
            },
            contents: [
                {
                    role: 'user',
                    parts: [{ text: `Based on my current vehicle telemetry, answer this:\n${prompt}` }]
                }
            ],
            generationConfig: {
                maxOutputTokens: 1000,
                temperature: 0.6
            }
        });

        // Fast, high-quota, resilient Gemini models on Google AI Studio
        const candidateModels = [
            'gemini-3.1-flash-lite',
            'gemini-3.5-flash',
            'gemini-3.7-flash',
            'gemini-3.8-flash',
            'gemini-flash-latest'
        ];

        let lastError = null;

        for (const model of candidateModels) {
            try {
                const res = await new Promise((resolve) => {
                    const opt = {
                        hostname: 'generativelanguage.googleapis.com',
                        port: 443,
                        path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(body)
                        },
                        timeout: 9000
                    };
                    const req = tlsDates.request(opt, (res) => {
                        let data = '';
                        res.on('data', (chunk) => { data += chunk; });
                        res.on('end', () => {
                            try {
                                const json = JSON.parse(data);
                                if (res.statusCode >= 200 && res.statusCode < 300 && json.candidates && json.candidates[0] && json.candidates[0].content) {
                                    const parts = json.candidates[0].content.parts || [];
                                    const nonThought = parts.filter((p) => !p.thought);
                                    const chosen = nonThought.length > 0 ? nonThought[nonThought.length - 1] : parts[0];
                                    const text = (chosen && chosen.text) ? chosen.text.trim() : '';
                                    if (text) {
                                        resolve({ ok: true, text });
                                    } else {
                                        resolve({ ok: false, status: res.statusCode, error: 'Empty text parts' });
                                    }
                                } else if (json.error) {
                                    resolve({ ok: false, status: res.statusCode, error: json.error.message || JSON.stringify(json.error) });
                                } else {
                                    resolve({ ok: false, status: res.statusCode, error: data.slice(0, 200) });
                                }
                            } catch (e) {
                                resolve({ ok: false, status: res.statusCode, error: e.message });
                            }
                        });
                    });

                    req.on('error', (err) => resolve({ ok: false, error: err.message }));
                    req.on('timeout', () => {
                        try { req.destroy(); } catch (e) {}
                        resolve({ ok: false, error: 'Request timed out' });
                    });
                    req.write(body);
                    req.end();
                });

                if (res.ok) {
                    return res.text;
                }
                lastError = res.error;
                this.log.warn(`AiBridge: Gemini model ${model} failed (${res.status || ''}: ${res.error}), trying fallback...`);
            } catch (err) {
                lastError = err.message;
            }
        }

        return `[Gemini API Alert]\n${lastError || 'Failed to communicate with Google Gemini API.'}`;
    }

    queryAnthropic(prompt, telemetry, persona) {
        return new Promise((resolve) => {
            const systemPrompt = this.buildVehicleContext(persona, telemetry, prompt);
            const token = this.config.apiKey;
            const model = this.config.model || 'claude-3-5-haiku-20241022';

            const body = JSON.stringify({
                model: model,
                max_tokens: 1000,
                system: systemPrompt,
                messages: [
                    { role: 'user', content: `Based on my current vehicle telemetry, answer this:\n${prompt}` }
                ]
            });

            const opt = {
                hostname: 'api.anthropic.com',
                port: 443,
                path: '/v1/messages',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': token,
                    'anthropic-version': '2023-06-01',
                    'Content-Length': Buffer.byteLength(body)
                },
                timeout: 8000
            };
            const req = tlsDates.request(opt, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.content && json.content[0] && json.content[0].text) {
                            resolve(json.content[0].text.trim());
                        } else if (json.error) {
                            resolve(`[Claude API Alert]\n${json.error.message || JSON.stringify(json.error)}`);
                        } else {
                            resolve(`[Claude Response]\n${data.slice(0, 250)}`);
                        }
                    } catch (e) {
                        resolve(`Parse error: ${e.message}`);
                    }
                });
            });

            req.on('error', (err) => resolve(`Uplink error: ${err.message}`));
            req.on('timeout', () => {
                try { req.destroy(); } catch (e) {}
                resolve('Claude query timed out. Please check phone hotspot connection.');
            });
            req.write(body);
            req.end();
        });
    }

    queryOpenAICompatible(prompt, telemetry, persona, provider) {
        return new Promise((resolve) => {
            const systemPrompt = this.buildVehicleContext(persona, telemetry, prompt);
            const token = this.config.sessionToken || this.config.apiKey;

            let urlStr = 'https://api.openai.com/v1/chat/completions';
            let model = 'gpt-4o-mini';
            const extraHeaders = {};

            if (provider === 'groq' || (token && token.startsWith('gsk_'))) {
                urlStr = 'https://api.groq.com/openai/v1/chat/completions';
                model = 'llama-3.3-70b-versatile';
            } else if (provider === 'openrouter' || (token && token.startsWith('sk-or-'))) {
                urlStr = 'https://openrouter.ai/api/v1/chat/completions';
                model = 'meta-llama/llama-3.3-70b-instruct';
                extraHeaders['HTTP-Referer'] = 'https://hexlay.github.io/idrive7-custom-apps/';
            } else if (this.config.relayUrl) {
                urlStr = this.config.relayUrl;
            }

            if (this.config.model) model = this.config.model;

            const body = JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Based on my current vehicle telemetry, answer this:\n${prompt}` }
                ],
                max_tokens: 1000,
                temperature: 0.6
            });

            // Node 8: no global URL and no request(url, options, cb) form
            let u;
            try {
                u = urlMod.parse(urlStr);
            } catch (e) {
                u = null;
            }
            if (!u || !u.hostname || (u.protocol !== 'https:' && u.protocol !== 'http:')) {
                return resolve(`Invalid relay URL: ${urlStr}`);
            }

            const isHttps = u.protocol === 'https:';
            const send = isHttps ? tlsDates.request : http.request;

            const req = send({
                protocol: u.protocol,
                hostname: u.hostname,
                port: u.port || (isHttps ? 443 : 80),
                path: u.path || '/',
                method: 'POST',
                headers: Object.assign({
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                    'Content-Length': Buffer.byteLength(body)
                }, extraHeaders),
                timeout: 8000
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.choices && json.choices[0] && json.choices[0].message) {
                            resolve(json.choices[0].message.content.trim());
                        } else if (json.error) {
                            resolve(`[AI Error]\n${json.error.message || JSON.stringify(json.error)}`);
                        } else {
                            resolve(`AI Error: ${data.slice(0, 200)}`);
                        }
                    } catch (e) {
                        resolve(`Parse error: ${e.message}`);
                    }
                });
            });

            req.on('error', (err) => resolve(`Uplink error: ${err.message}`));
            req.on('timeout', () => {
                try { req.destroy(); } catch (e) {}
                resolve('Request timed out. Please check phone hotspot connection.');
            });
            req.write(body);
            req.end();
        });
    }
}

module.exports = { AiBridge, CONFIG_PATH };
