'use strict';
/**
 * AI Bridge for M-Copilot.
 * Supports:
 *   1. Subscription Connect (ChatGPT Plus / Gemini Adv Web Session / Relay)
 *   2. Free Tier Mode (Google Gemini Flash 15 RPM @ $0.00)
 *   3. Custom API Key (OpenAI / Claude / Groq / OpenRouter)
 *   4. Offline ECU Expert Engine (Instant local telemetry synthesis)
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { KNOWLEDGE_BASE } = require('./knowledge');

const CONFIG_PATH = path.join(__dirname, 'copilot_auth.json');

class AiBridge {
    constructor(log) {
        this.log = log || console;
        this.config = this.loadConfig();
    }

    loadConfig() {
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            }
        } catch (e) {
            this.log.error('Failed to load copilot_auth.json: ' + e.message);
        }
        return {
            mode: 'subscription', // 'subscription', 'gemini_free', 'custom_api', 'offline'
            sessionToken: null,
            apiKey: null,
            relayUrl: 'https://api.openai.com/v1/chat/completions',
            geminiApiKey: null,
            paired: false
        };
    }

    saveConfig() {
        try {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf8');
        } catch (e) {
            this.log.error('Failed to save copilot_auth.json: ' + e.message);
        }
    }

    isConfigured(mode) {
        if (mode === 'offline') return true;
        if (mode === 'gemini_free') return !!this.config.geminiApiKey;
        if (mode === 'custom_api') return !!this.config.apiKey;
        if (mode === 'subscription') return !!(this.config.sessionToken || this.config.paired);
        return false;
    }

    buildSystemPrompt(persona, telemetry) {
        const vehicle = '2019 BMW M850i xDrive Coupe (G15, 4.4L Twin-Turbo V8 N63TU3, 530 hp, 750 Nm, ZF 8HP76)';
        const oil = telemetry.oilTemp || 95;
        const coolant = telemetry.coolantTemp || 90;
        const speed = telemetry.speed || 0;
        const rpm = telemetry.rpm || 650;
        const mode = telemetry.driveMode || 'SPORT+';
        const tires = telemetry.tireTemp || 38;

        let tone = 'You are the BMW M Performance AI Co-Driver for this M850i.';
        if (persona === 'concierge') {
            tone = 'You are the BMW Executive Concierge, refined, polite, and luxury-focused.';
        } else if (persona === 'mechanic') {
            tone = 'You are a BMW Master Certified Technician specializing in N63/S63 V8 engine mechanics and UDS diagnostics.';
        }

        return `${tone}
Vehicle: ${vehicle}
Current Realtime Telemetry:
- Speed: ${speed} km/h | Engine: ${rpm} RPM
- Drive Mode: ${mode}
- Engine Oil Temp: ${oil}°C (Norm 90-110°C) | Coolant: ${coolant}°C
- Tire Temperature: ${tires}°C | Pressures: FL 35.5, FR 35.8, RL 37.2, RR 37.0 psi
- DTC Fault Codes: 0 active

Guidelines:
- Keep answers clear, technical, concise and easily readable on an in-car ultrawide display.
- Maximum 3-4 bullet points or short paragraphs. Avoid long walls of text.
- Reference the vehicle's actual telemetry when relevant.`;
    }

    /**
     * Query the AI with a prompt and live telemetry.
     */
    async ask(prompt, telemetry, options = {}) {
        const mode = options.mode || this.config.mode || 'offline';
        const persona = options.persona || 'm_engineer';

        // Check if offline query matches a known quick topic
        const lower = prompt.toLowerCase();
        let matchedKey = null;
        if (lower.includes('launch') || lower.includes('acceleration') || lower.includes('0-100')) matchedKey = 'launch';
        else if (lower.includes('cooling') || lower.includes('turbo') || lower.includes('oil temp') || lower.includes('hot')) matchedKey = 'cooling';
        else if (lower.includes('tire') || lower.includes('grip') || lower.includes('pressure')) matchedKey = 'tires';
        else if (lower.includes('dtc') || lower.includes('fault') || lower.includes('error') || lower.includes('check engine') || lower.includes('scan')) matchedKey = 'diagnostics';
        else if (lower.includes('route') || lower.includes('pass') || lower.includes('mountain') || lower.includes('road') || lower.includes('georgia')) matchedKey = 'routes';
        else if (lower.includes('spec') || lower.includes('oil') || lower.includes('plug') || lower.includes('maintenance')) matchedKey = 'maintenance';

        if (mode === 'offline' || !this.isConfigured(mode)) {
            if (matchedKey && KNOWLEDGE_BASE[matchedKey]) {
                const res = KNOWLEDGE_BASE[matchedKey].analyze(telemetry);
                return `[ECU Offline Expert: ${KNOWLEDGE_BASE[matchedKey].title}]\n\n${res.text}`;
            }
            return `[ECU Offline Expert Mode]\n\nEngine Vitals: Oil ${telemetry.oilTemp || 95}°C | Coolant ${telemetry.coolantTemp || 90}°C | Mode: ${telemetry.driveMode || 'SPORT+'}\n\nTo enable full cloud conversational intelligence, scan the pairing QR code to link your ChatGPT/Gemini subscription or enter a free Gemini key in Settings.`;
        }

        // Cloud query: Gemini Free Tier
        if (mode === 'gemini_free' && this.config.geminiApiKey) {
            return this.queryGemini(prompt, telemetry, persona);
        }

        // Cloud query: Subscription Relay or Custom API
        return this.queryOpenAICompatible(prompt, telemetry, persona);
    }

    queryGemini(prompt, telemetry, persona) {
        return new Promise((resolve, reject) => {
            const systemPrompt = this.buildSystemPrompt(persona, telemetry);
            const body = JSON.stringify({
                contents: [
                    { role: 'user', parts: [{ text: `${systemPrompt}\n\nUser Question: ${prompt}` }] }
                ],
                generationConfig: {
                    maxOutputTokens: 350,
                    temperature: 0.7
                }
            });

            const apiKey = this.config.geminiApiKey;
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

            const req = https.request(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                },
                timeout: 10000
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.candidates && json.candidates[0] && json.candidates[0].content) {
                            const text = json.candidates[0].content.parts[0].text;
                            resolve(text.trim());
                        } else {
                            resolve(`Gemini response: ${data.slice(0, 200)}`);
                        }
                    } catch (e) {
                        resolve(`Parse error: ${e.message}`);
                    }
                });
            });

            req.on('error', (err) => resolve(`Connection error: ${err.message}`));
            req.on('timeout', () => { req.destroy(); resolve('Request timed out (Check phone hotspot uplink)'); });
            req.write(body);
            req.end();
        });
    }

    queryOpenAICompatible(prompt, telemetry, persona) {
        return new Promise((resolve) => {
            const systemPrompt = this.buildSystemPrompt(persona, telemetry);
            const token = this.config.sessionToken || this.config.apiKey;
            const urlStr = this.config.relayUrl || 'https://api.openai.com/v1/chat/completions';

            const body = JSON.stringify({
                model: this.config.model || 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 350,
                temperature: 0.7
            });

            const u = new URL(urlStr);
            const isHttps = u.protocol === 'https:';
            const client = isHttps ? https : http;

            const req = client.request(u, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                    'Content-Length': Buffer.byteLength(body)
                },
                timeout: 10000
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.choices && json.choices[0] && json.choices[0].message) {
                            resolve(json.choices[0].message.content.trim());
                        } else {
                            resolve(`AI Error: ${data.slice(0, 200)}`);
                        }
                    } catch (e) {
                        resolve(`Parse error: ${e.message}`);
                    }
                });
            });

            req.on('error', (err) => resolve(`Uplink error: ${err.message}`));
            req.on('timeout', () => { req.destroy(); resolve('Request timed out'); });
            req.write(body);
            req.end();
        });
    }
}

module.exports = { AiBridge, CONFIG_PATH };
