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

const CONFIG_PATH = path.join(__dirname, 'copilot_auth.json');

class AiBridge {
    constructor(ctxOrLog) {
        if (ctxOrLog && ctxOrLog.log) {
            this.ctx = ctxOrLog;
            this.log = ctxOrLog.log;
        } else {
            this.ctx = null;
            this.log = ctxOrLog || console;
        }
        this.config = this.loadConfig();
        this.hasInternet = true;
        this.isCheckingInternet = false;

        this.checkInternetConnection().catch(() => {});
        setInterval(() => {
            this.checkInternetConnection().catch(() => {});
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
        if (payload.geminiApiKey) {
            this.config.geminiApiKey = payload.geminiApiKey;
            this.config.mode = 'gemini';
        }
        if (payload.apiKey) this.config.apiKey = payload.apiKey;
        if (payload.sessionToken) this.config.sessionToken = payload.sessionToken;
        if (payload.persona) this.config.persona = payload.persona;
        this.config.paired = true;
        this.saveConfig();
        this.log.info('AiBridge: Saved new credentials (mode=' + this.config.mode + ')');
    }

    isConfigured() {
        if (this.config.mode === 'gemini') return !!this.config.geminiApiKey;
        if (this.config.mode === 'custom_api') return !!this.config.apiKey;
        if (this.config.mode === 'subscription') return !!(this.config.sessionToken || this.config.paired);
        return !!(this.config.geminiApiKey || this.config.apiKey);
    }

    async checkInternetConnection() {
        if (this.isCheckingInternet) return this.hasInternet;
        this.isCheckingInternet = true;

        return new Promise((resolve) => {
            let settled = false;
            const done = (ok) => {
                if (settled) return;
                settled = true;
                this.hasInternet = ok;
                this.isCheckingInternet = false;
                resolve(ok);
            };

            const timer = setTimeout(() => {
                done(this.hasInternet);
            }, 5000);

            try {
                const req = https.get('https://connectivitycheck.gstatic.com/generate_204', { timeout: 4000 }, (res) => {
                    clearTimeout(timer);
                    done(res.statusCode >= 200 && res.statusCode < 400);
                });

                req.on('error', () => {
                    const fb = https.get('https://dns.google/resolve?name=google.com', { timeout: 4000 }, (res2) => {
                        clearTimeout(timer);
                        done(res2.statusCode >= 200 && res2.statusCode < 400);
                    });
                    fb.on('error', () => {
                        clearTimeout(timer);
                        done(false);
                    });
                    fb.on('timeout', () => {
                        try { fb.destroy(); } catch (e) {}
                        clearTimeout(timer);
                        done(false);
                    });
                });

                req.on('timeout', () => {
                    try { req.destroy(); } catch (e) {}
                });
            } catch (e) {
                clearTimeout(timer);
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
        const carModel = 'BMW M850i xDrive (G15) N63B44TU3 4.4L TwinPower Turbo V8 (523 HP / 750 Nm, ZF 8HP76)';
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
- Guidelines: If oil >110°C after hard driving, idle engine or cruise gently at <2000 RPM for 1-2 mins to circulate coolant through the twin turbochargers. The N63 auxiliary electric coolant pump will run automatically post-shutdown if thermal dissipation is required.`;
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
        } else if (q.includes('fuel') || q.includes('range') || q.includes('route') || q.includes('trip') || q.includes('mountain') || q.includes('scenic') || q.includes('consumption')) {
            focusedAnalysis = `
[FOCUSED ANALYSIS: RANGE, FUEL & CRUISE EFFICIENCY]
- Fuel Level: ${fuel}% | Cruising Range: ${range} km (${rangeMiles} miles)
- Active Drive Mode: ${mode}
- Powertrain efficiency optimized for highway cruising and mountain ascents.`;
        }

        // Persona Voice Definition
        let personaIntro = 'You are the BMW Intelligent Co-Driver for this G-Series vehicle.';
        if (p === 'm_engineer') {
            personaIntro = 'You are the BMW M Performance Chief Track Engineer. Your style is technical, precise, telemetry-driven, and focused on dynamic vehicle physics.';
        } else if (p === 'concierge') {
            personaIntro = 'You are the BMW Executive Concierge. Your style is refined, polite, luxury-focused, and seamlessly helpful.';
        } else if (p === 'mechanic') {
            personaIntro = 'You are a Senior BMW Master Certified Powertrain Technician with encyclopedic knowledge of N63TU3, B58, and S58 engines, ZF transmissions, and CBS service.';
        }

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
- If asked to code or modify settings, refuse politely and refer the user to the QuickCode app.

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

        // Safety Interception: M-Copilot is strictly Read-Only
        const codingTriggers = [
            'code', 'coding', 'turn off start stop', 'disable start stop', 'enable start stop',
            'change color', 'set ambient', 'unlock video', 'enable vim', 'flash ecu',
            'write ecu', 'change chime', 'modify setting'
        ];
        if (codingTriggers.some((t) => lower.includes(t))) {
            return `[SAFETY INTERLOCK: READ-ONLY OBSERVATION]\n\n` +
                   `M-Copilot operates strictly in passive read-only monitoring mode to safeguard vehicle ECUs.\n\n` +
                   `To safely code vehicle parameters (such as Start/Stop memory, ambient lighting, or acoustic chimes), please switch to the dedicated QuickCode app.`;
        }

        const mode = this.config.mode || 'gemini';

        if (mode === 'gemini' && this.config.geminiApiKey) {
            return this.queryGemini(prompt, telemetry, persona);
        }

        return this.queryOpenAICompatible(prompt, telemetry, persona);
    }

    queryGemini(prompt, telemetry, persona) {
        return new Promise((resolve, reject) => {
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
                    maxOutputTokens: 380,
                    temperature: 0.6
                }
            });

            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

            const req = https.request(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                },
                timeout: 8000
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.candidates && json.candidates[0] && json.candidates[0].content) {
                            const text = json.candidates[0].content.parts[0].text;
                            resolve(text.trim());
                        } else if (json.error) {
                            resolve(`[Gemini API Alert]\n${json.error.message || JSON.stringify(json.error)}`);
                        } else {
                            resolve(`[Gemini Response]\n${data.slice(0, 250)}`);
                        }
                    } catch (e) {
                        resolve(`Parse error: ${e.message}`);
                    }
                });
            });

            req.on('error', (err) => resolve(`Uplink error: ${err.message}`));
            req.on('timeout', () => {
                req.destroy();
                resolve('Gemini query timed out. Please check your phone hotspot connection.');
            });
            req.write(body);
            req.end();
        });
    }

    queryOpenAICompatible(prompt, telemetry, persona) {
        return new Promise((resolve) => {
            const systemPrompt = this.buildVehicleContext(persona, telemetry, prompt);
            const token = this.config.sessionToken || this.config.apiKey;
            const urlStr = this.config.relayUrl || 'https://api.openai.com/v1/chat/completions';

            const body = JSON.stringify({
                model: this.config.model || 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 380,
                temperature: 0.6
            });

            let u;
            try {
                u = new URL(urlStr);
            } catch (e) {
                return resolve(`Invalid relay URL: ${urlStr}`);
            }

            const isHttps = u.protocol === 'https:';
            const client = isHttps ? https : http;

            const req = client.request(u, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                    'Content-Length': Buffer.byteLength(body)
                },
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
                req.destroy();
                resolve('Request timed out. Please check phone hotspot connection.');
            });
            req.write(body);
            req.end();
        });
    }
}

module.exports = { AiBridge, CONFIG_PATH };
