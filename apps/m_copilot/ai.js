'use strict';
/**
 * AI bridge for M-Copilot: Google Gemini, Anthropic Claude, or an OpenAI-compatible API
 * (OpenAI, Groq, OpenRouter, a relay), with the key paired from the phone.
 *
 *   - The model gets only what the car reported (buildVehicleContext); a value it doesn't have
 *     is listed as not available, never filled in.
 *   - A short memory (the last exchanges) so a follow-up question works.
 *   - One kept-alive, certificate-checked connection per host (tls_dates.agent).
 *   - Read-only: nothing is ever written to the car.
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const urlMod = require('url');
const tlsDates = require('./tls_dates');

const CONFIG_PATH = path.join(__dirname, 'copilot_auth.json');

const REQUEST_TIMEOUT_MS = 30000;           // silence allowed on the connection: a model reasoning sends nothing meanwhile
const HISTORY_TURNS = 2;                    // exchanges sent along, for follow-up questions
const HISTORY_MS = 10 * 60 * 1000;          // a conversation older than this starts over
const ANTHROPIC_VERSION = '2026-10-21';
const MODEL_TRY_MS = 8000;                  // a model with another one after it: wait this long, then ask the next
const GEMINI_BUSY_MS = 10 * 60 * 1000;      // an overloaded Gemini model is skipped this long
const CLAUDE_DEFAULT_MODEL = 'claude-haiku-5-5';   // fast and cheap; the phone page can choose another

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
        // the credentials live in the data folder only: move an older copy next to the code there
        if (this.ctx && this.ctx.dataDir && fs.existsSync(CONFIG_PATH)) this.saveConfig();
        this.hasInternet = true;
        this.isCheckingInternet = false;
        this.agent = tlsDates.agent();      // reused connections: no TLS handshake per question
        this.history = [];                  // [{ q, a }], the last exchanges (follow-up questions)
        this.historyAt = 0;

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
            paired: false
        };
    }

    saveConfig() {
        const target = (this.ctx && this.ctx.dataDir) ? path.join(this.ctx.dataDir, 'copilot_auth.json') : CONFIG_PATH;
        try {
            fs.writeFileSync(target, JSON.stringify(this.config, null, 2), { encoding: 'utf8', mode: 0o600 });
            // no second copy of the keys next to the code
            if (target !== CONFIG_PATH) {
                try { fs.unlinkSync(CONFIG_PATH); } catch (e) {}
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
        this.config.paired = true;
        this.config.geminiModel = null;     // a new key: find the model that works for it again
        this.config.geminiPlain = null;
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
     * The car's state for the model: only values the car reported. Missing ones are named, so the
     * model says it doesn't have them instead of quoting a number.
     */
    buildVehicleContext(t) {
        t = t || {};
        const known = [], missing = [];
        const num = (v) => typeof v === 'number' && isFinite(v);
        // optional: a value many cars never send (M models only, sport display): left out when absent
        const add = (label, v, fmt, optional) => {
            if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) { if (!optional) missing.push(label); } else known.push(label + ': ' + fmt(v));
        };
        const r0 = (v) => String(Math.round(v)), r1 = (v) => (Math.round(v * 10) / 10).toFixed(1), r2 = (v) => v.toFixed(2);
        const CONDITIONS = { 1: 'parked', 2: 'parked', 3: 'parked, driver away', 5: 'parked, no ignition', 7: 'ignition on, not drive-ready',
            8: 'getting drive-ready', 10: 'drive-ready', 12: 'switching off' };
        add('Vehicle state', CONDITIONS[t.condition] || null, (v) => v, true);
        add('Engine', t.engine, (v) => v);
        add('Speed', t.speed, (v) => r0(v) + ' km/h');
        add('Engine speed', t.rpm, (v) => r0(v) + ' rpm');
        add('Gear selector', t.stage || (num(t.gear) ? (t.gear > 0 ? 'D' : null) : null), (v) => v + (num(t.gear) && t.gear > 0 ? ' (gear ' + t.gear + ')' : ''));
        add('Engine torque', t.torque, (v) => r0(v) + ' Nm');
        add('Power / torque, % of the engine maximum (sport display)', num(t.powerPct) && num(t.torquePct) ? [t.powerPct, t.torquePct] : null, (v) => r0(v[0]) + ' % / ' + r0(v[1]) + ' %', true);
        add('Boost (sport display)', t.boost, (v) => r2(v) + ' bar', true);
        add('Driving mode', t.mode, (v) => v);
        add('M xDrive setting', t.awd, (v) => v, true);
        add('Auto start-stop', t.msa, (v) => v, true);
        add('Parking brake', t.handbrake, (v) => v, true);
        add('Engine oil temperature', t.oilTemp, (v) => r0(v) + ' C');
        add('Coolant temperature', t.coolantTemp, (v) => r0(v) + ' C');
        add('Engine oil level', t.oilLevel, (v) => v);
        add('Outside temperature', t.ambient, (v) => r1(v) + ' C');
        add('Lateral / longitudinal acceleration', num(t.gLat) && num(t.gLong) ? [t.gLat, t.gLong] : null, (v) => r2(v[0]) + ' g / ' + r2(v[1]) + ' g');
        const corners = (o, fmt) => (o && ['fl', 'fr', 'rl', 'rr'].every((k) => num(o[k])) ? 'FL ' + fmt(o.fl) + ', FR ' + fmt(o.fr) + ', RL ' + fmt(o.rl) + ', RR ' + fmt(o.rr) : null);
        add('Tyre pressures', corners(t.tyres, r1), (v) => v + ' bar');
        add('Tyre pressure targets (set in the car)', corners(t.tyreTargets, r1), (v) => v + ' bar');
        add('Tyre temperatures', corners(t.tyreTemps, r0), (v) => v + ' C', true);
        add('Fuel in the tank', t.fuelL, (v) => r0(v) + ' l');
        add('Range', t.rangeKm, (v) => r0(v) + ' km');
        add('Average consumption (trip computer)', t.avgCons, (v) => r1(v.value) + ' ' + v.unit, true);
        add('Odometer', t.odoKm, (v) => r0(v) + ' km');
        add('12 V battery charge', t.batteryPct, (v) => r0(v) + ' %');
        add('Gearbox programme shown', t.programme, (v) => v, true);
        add('Air conditioning (A/C)', t.ac === null || t.ac === undefined ? null : t.ac ? 'on' : 'off', (v) => v, true);
        add('High-voltage battery temperature', t.hvTemp, (v) => r0(v) + ' C', true);
        add('High-voltage battery voltage', t.hvVolt, (v) => r0(v) + ' V', true);

        // the engine unit's own values, read when the question was asked (engine_snapshot.js)
        const es = t.engineSnap && t.engineSnap.values, eng = [];
        if (es) {
            const e = (label, v, fmt) => { if (v !== undefined && v !== null && !(typeof v === 'number' && !isFinite(v))) eng.push(label + ': ' + fmt(v)); };
            e('Boost actual / target', num(es.boostActual) && num(es.boostTarget) ? [es.boostActual, es.boostTarget] : null, (v) => r2(v[0]) + ' / ' + r2(v[1]) + ' bar');
            if (!(num(es.boostActual) && num(es.boostTarget))) e('Boost (engine unit)', es.boostActual, (v) => r2(v) + ' bar');
            e('Outside air pressure', es.baro, (v) => r0(v) + ' kPa');
            e('Intake air temperature', es.iat, (v) => r0(v) + ' C');
            e('Air charge (load) actual / target', num(es.loadActual) && num(es.loadTarget) ? [es.loadActual, es.loadTarget] : null, (v) => r0(v[0]) + ' / ' + r0(v[1]) + ' %');
            e('Ignition timing', es.timing, (v) => r1(v) + ' deg');
            e('High-pressure fuel (rail)', es.hpfp, (v) => r0(v) + ' bar');
            e('Low-pressure fuel', es.lpfp, (v) => r1(v) + ' bar');
            e('Engine oil temperature (engine unit)', es.oil, (v) => r0(v) + ' C');
            e('Gearbox oil temperature', es.gearboxOil, (v) => r0(v) + ' C');
            e('12 V system voltage', es.v12, (v) => r2(v) + ' V');
            e('Misfires this driving cycle, per cylinder', Array.isArray(es.misfire) ? es.misfire : null, (v) => v.map((n, i) => (i + 1) + ': ' + (n === null ? '?' : n)).join(', '));
            e('High-voltage battery charge', es.hvSoc, (v) => r0(v) + ' %');
            e('High-voltage battery health (SOH)', es.hvSoh, (v) => r0(v) + ' %');
        }

        const next = t.serviceNext && t.serviceNext.text
            ? 'Next service the car asks for: ' + t.serviceNext.text + (t.serviceNext.way ? ', in ' + t.serviceNext.way : '') + (t.serviceNext.date ? ', by ' + t.serviceNext.date : '') + '.' : '';
        const service = Array.isArray(t.service) && t.service.length
            ? 'Service list from the instrument cluster (what is due, by distance and / or date):\n' + t.service.map((i) => '- ' + i.name + ': '
                + (i.state === 'overdue' ? 'OVERDUE' : i.state === 'due soon' ? 'DUE SOON' : i.state === 'OK' ? 'not due yet' : 'status unknown')
                + (i.way ? ', in ' + i.way : '') + (i.date ? ', by ' + i.date : '')).join('\n')
            : 'Service list: not received from the car.';

        const cc = Array.isArray(t.checkControl)
            ? (t.checkControl.length ? 'Check Control messages shown in the instrument cluster now: ' + t.checkControl.join('; ') + '.'
                : 'Check Control: no warning messages active in the instrument cluster.')
            : 'Check Control messages: not received from the car.';

        let faults;
        const d = t.dtcScan;
        if (!d) faults = 'Fault memory: not read in this session.';
        else if (d.error) faults = 'Fault memory: could not be read (' + d.error + ').';
        else {
            const units = d.units.filter((u) => u.codes.length);
            const fault = (c) => (typeof c === 'string' ? c : c.code + (c.text ? ' "' + c.text + '"' : ' (no text known)'));
            faults = 'Fault memory (read ' + Math.max(0, Math.round((Date.now() - d.at) / 60000)) + ' min ago from ' + d.answered + ' control units): '
                + (units.length ? d.total + ' stored fault(s):\n' + units.map((u) => '- ' + u.name + ': ' + u.codes.map(fault).join('; ')).join('\n')
                    + '\nThe quoted texts are BMW\'s own fault descriptions: explain what they mean for the driver. A code without a text: do not guess its meaning.'
                    : 'no stored faults.');
        }

        const who = t.vehicle && typeof t.vehicle.lines === 'function' ? t.vehicle.lines() : [];
        const tuned = t.vehicle && t.vehicle.profile && t.vehicle.profile.tune && t.vehicle.profile.tune !== 'stock';

        return [
            'You are M-Copilot, an assistant on the central display of a BMW with iDrive 7. The driver may be driving, so be brief and practical.',
            '',
            'About this car:',
            who.length ? who.map((l) => '- ' + l).join('\n') : '- Model unknown (a BMW with iDrive 7, 2018 or later).',
            'Name the model only when it is given above or you are sure of the type code; otherwise say which models your answer fits. The owner\'s profile is more exact than the type code.',
            t.vehicle && t.vehicle.profile && t.vehicle.profile.model ? ''
                : 'If the answer depends on the exact model or tune, which are not given, end with this line: "For exact figures, add your model and tune under Your car on the M-Copilot phone page."',
            '',
            t.demo ? 'DEMO MODE: no car is connected. The readings below come from a driving simulator for testing the app: answer with them as if they were real, and say once, in a few words, that they are simulated.'
                : 'Live data from this car, read just now. These are the only readings you have; use them when you talk about the car\'s current state:',
            known.length ? known.map((l) => '- ' + l).join('\n') : '- (no live data yet)',
            missing.length ? 'Not available right now: ' + missing.join(', ') + '. If an answer depends on one of these, say you do not have it. Never estimate or invent a reading.' : '',
            eng.length ? 'Engine control unit, read just now (' + Math.max(0, Math.round((Date.now() - t.engineSnap.at) / 1000)) + ' s ago):\n' + eng.map((l) => '- ' + l).join('\n')
                + '\nUse these for questions about boost, heat soak, knock, fuelling, misfires or tune health: compare actual with target and say what a gap means.'
                : 'Engine control unit values (boost target, intake air, timing, fuel pressure, misfires): not read for this question.',
            service,
            next,
            cc,
            faults,
            '',
            tuned ? 'The car is tuned: take the higher load into account (fuel, oil, cooling, clutch or gearbox torque limits) and say where a tune changes the stock advice.'
                : 'Unless the profile says the car is tuned, assume factory specifications.',
            'Give numbers for this car\'s engine and gearbox when you know them; say when a figure depends on the exact model.',
            'Where the advice itself risks damage or a crash, say so in a few words. No general disclaimers.',
            'Answer in plain text for a car screen: at most 6 short lines, no markdown, no tables, under 110 words. Start with the answer, not a preamble.',
        ].filter((l) => l !== '').join('\n');
    }

    /** Forget the conversation (a new topic). */
    resetHistory() { this.history = []; }

    _messages(prompt) {
        if (Date.now() - this.historyAt > HISTORY_MS) this.history = [];
        return this.history.slice(-HISTORY_TURNS);
    }

    _remember(prompt, answer) {
        this.history.push({ q: prompt, a: answer });
        if (this.history.length > HISTORY_TURNS) this.history.shift();
        this.historyAt = Date.now();
    }

    /** Ask with the car's current state. Resolves with the answer text (errors as readable text). */
    async ask(prompt, telemetry, options) {
        options = options || {};
        if (!this.hasInternet) {
            await this.checkInternetConnection();
            if (!this.hasInternet) throw new Error('No internet uplink. Connect phone hotspot or vehicle Wi-Fi.');
        }
        if (!this.isConfigured()) {
            throw new Error('M-Copilot AI not configured. Scan the QR code with your phone to pair your free Gemini key.');
        }
        if (options.fresh) this.resetHistory();

        const lower = (prompt || '').toLowerCase();
        // read-only: requests to code or change the car are answered here, not by the model
        const codingTriggers = [
            'apply coding', 'code ecu', 'write ecu', 'flash ecu', 'disable start stop',
            'enable start stop', 'change ambient', 'unlock video', 'enable vim', 'change chime'
        ];
        if (codingTriggers.some((t) => lower.includes(t))) {
            return 'M-Copilot only reads the car: it cannot change coding or settings.\n\n'
                 + 'Vehicle coding (such as Start/Stop memory, ambient lighting, or chimes) is not available in these apps. Use E-Sys or BimmerCode.';
        }

        const system = this.buildVehicleContext(telemetry);
        const past = this._messages(prompt);
        const provider = this.config.provider || (this.config.geminiApiKey ? 'gemini' : 'openai');
        let res;
        if (provider === 'gemini' || (this.config.mode === 'gemini' && this.config.geminiApiKey)) res = await this.queryGemini(prompt, system, past);
        else if (provider === 'claude' || (this.config.apiKey && this.config.apiKey.startsWith('sk-ant-'))) res = await this.queryAnthropic(prompt, system, past);
        else res = await this.queryOpenAICompatible(prompt, system, past, provider);
        if (res.ok) this._remember(prompt, res.text);
        return res.text;
    }

    /** POST json to https://host/path (kept-alive connection); resolves { status, json, raw } or { error }. */
    _post(host, pathStr, headers, bodyObj, opts) {
        const body = JSON.stringify(bodyObj);
        const u = opts && opts.url;
        return new Promise((resolve) => {
            let done = false;
            const finish = (v) => { if (!done) { done = true; resolve(v); } };
            const isHttp = u && u.protocol === 'http:';
            const send = isHttp ? http.request : tlsDates.request;
            let req;
            try {
                req = send({
                    hostname: host, port: (u && u.port) || (isHttp ? 80 : 443), path: pathStr, method: 'POST',
                    agent: isHttp ? undefined : this.agent,
                    headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers),
                    timeout: (opts && opts.timeoutMs) || REQUEST_TIMEOUT_MS,
                }, (res) => {
                    let data = '';
                    res.setEncoding('utf8');
                    res.on('data', (c) => { data += c; });
                    res.on('end', () => {
                        let json = null;
                        try { json = JSON.parse(data); } catch (e) {}
                        finish({ status: res.statusCode, json, raw: data });
                    });
                    res.on('error', (e) => finish({ error: e.message }));
                });
            } catch (e) {
                return finish({ error: e.message });
            }
            let sent = false;                // the whole request reached the connection: a timeout is then the server being slow
            req.on('finish', () => { sent = true; });
            req.on('error', (e) => finish({ error: e.message }));
            req.on('timeout', () => { try { req.destroy(); } catch (e) {} finish({ error: 'timed out', slow: sent }); });
            req.write(body);
            req.end();
        });
    }

    async queryGemini(prompt, system, past) {
        const contents = [];
        past.forEach((h) => { contents.push({ role: 'user', parts: [{ text: h.q }] }, { role: 'model', parts: [{ text: h.a }] }); });
        contents.push({ role: 'user', parts: [{ text: prompt }] });
        // Flash models reason first (Gemini 3 Flash: "high" by default), which takes long and counts against
        // maxOutputTokens: a short car answer needs little of it. A model that refuses the field (400 about
        // thinking) is asked again without it, and remembered.
        const plain = this.config.geminiPlain || [];
        const bodyFor = (model) => ({
            systemInstruction: { parts: [{ text: system }] }, contents,
            generationConfig: Object.assign({ maxOutputTokens: 2048, temperature: 0.4 }, plain.indexOf(model) >= 0 ? {} : { thinkingConfig: { thinkingLevel: 'low' } }),
        });
        // the model that worked last time first, then Google's maintained aliases. A model that is
        // overloaded (503 "high demand", 429, 5xx) or goes silent is skipped for a while and the next
        // one answers instead; that stand-in is not remembered as the model to use.
        const configured = this.config.model && /gemini/i.test(this.config.model) ? this.config.model : null;
        const all = [this.config.geminiModel, configured, 'gemini-flash-latest', 'gemini-flash-lite-latest']
            .filter((m, i, a) => m && a.indexOf(m) === i);
        const busy = this.geminiBusy || (this.geminiBusy = {});
        const now = Date.now();
        const models = all.filter((m) => !(busy[m] > now));
        if (!models.length) models.push(all[all.length - 1]);
        let last = 'no model answered', standIn = models[0] !== all[0];
        const markBusy = (model, why) => {
            busy[model] = Date.now() + GEMINI_BUSY_MS;
            standIn = true;
            this.log.warn('AiBridge: Gemini model ' + model + ' ' + why + ', trying the next');
        };
        for (let i = 0; i < models.length; i++) {
            const model = models[i], lastTry = i === models.length - 1;
            const r = await this._post('generativelanguage.googleapis.com', `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
                { 'x-goog-api-key': this.config.geminiApiKey }, bodyFor(model),       // the key in a header, not in the URL
                { timeoutMs: lastTry ? REQUEST_TIMEOUT_MS : MODEL_TRY_MS });
            if (r.error) {
                if (r.slow && !lastTry) { markBusy(model, 'did not answer in time'); last = 'took too long to answer'; continue; }
                return { ok: false, text: r.slow ? 'Gemini took too long to answer. Please try again.'
                    : 'Gemini: ' + r.error + '. Please check the phone hotspot connection.' };
            }
            const j = r.json || {};
            const cand = j.candidates && j.candidates[0];
            if (r.status >= 200 && r.status < 300 && cand && cand.content) {
                const text = (cand.content.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join('').trim();
                if (text) {
                    if (!standIn && this.config.geminiModel !== model) { this.config.geminiModel = model; this.saveConfig(); }
                    return { ok: true, text };
                }
                last = cand.finishReason ? 'no answer (' + cand.finishReason + ')' : 'empty answer';
                continue;
            }
            last = (j.error && j.error.message) || ('HTTP ' + r.status);
            if (r.status === 400 && plain.indexOf(model) < 0 && /thinking/i.test(last)) {
                this.log.warn('AiBridge: Gemini model ' + model + ' takes no thinking level, asking without it');
                plain.push(model);
                this.config.geminiPlain = plain;
                this.saveConfig();
                i--;                        // the same model again
                continue;
            }
            if (r.status === 429 || r.status >= 500) { markBusy(model, 'is busy (' + r.status + ')'); continue; }
            // only a model that doesn't exist / isn't allowed for this key tries the next one
            if (r.status !== 404 && r.status !== 400 && r.status !== 403) break;
            this.log.warn('AiBridge: Gemini model ' + model + ' unavailable (' + r.status + '), trying the next');
            if (this.config.geminiModel === model) this.config.geminiModel = null;
        }
        if (/high demand|overloaded|try again later/i.test(last)) last = 'Google\'s servers are busy right now. Please try again in a minute.';
        return { ok: false, text: 'Gemini: ' + last };
    }

    async queryAnthropic(prompt, system, past) {
        const messages = [];
        past.forEach((h) => { messages.push({ role: 'user', content: h.q }, { role: 'assistant', content: h.a }); });
        messages.push({ role: 'user', content: prompt });
        const model = this.config.model && /^claude-/.test(this.config.model) ? this.config.model : CLAUDE_DEFAULT_MODEL;
        const r = await this._post('api.anthropic.com', '/v1/messages', { 'x-api-key': this.config.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
            { model, max_tokens: 2048, system, messages, output_config: { effort: 'low' } });
        if (r.error) return { ok: false, text: r.slow ? 'Claude took too long to answer. Please try again.' : 'Claude: ' + r.error + '. Please check the phone hotspot connection.' };
        const j = r.json || {};
        if (j.type === 'error' || j.error) return { ok: false, text: 'Claude: ' + ((j.error && j.error.message) || ('HTTP ' + r.status)) };
        if (j.stop_reason === 'refusal') return { ok: false, text: 'Claude declined to answer this question.' };
        const text = (j.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();
        return text ? { ok: true, text } : { ok: false, text: 'Claude: empty answer (' + (j.stop_reason || 'HTTP ' + r.status) + ')' };
    }

    async queryOpenAICompatible(prompt, system, past, provider) {
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
        // Node 8: no global URL
        let u = null;
        try { u = urlMod.parse(urlStr); } catch (e) {}
        if (!u || !u.hostname || (u.protocol !== 'https:' && u.protocol !== 'http:')) return { ok: false, text: 'Invalid relay URL: ' + urlStr };
        const messages = [{ role: 'system', content: system }];
        past.forEach((h) => { messages.push({ role: 'user', content: h.q }, { role: 'assistant', content: h.a }); });
        messages.push({ role: 'user', content: prompt });
        const r = await this._post(u.hostname, u.path || '/', Object.assign({ Authorization: 'Bearer ' + token }, extraHeaders),
            { model, messages, max_tokens: 600, temperature: 0.4 }, { url: u });
        if (r.error) return { ok: false, text: r.slow ? 'The AI took too long to answer. Please try again.' : 'AI: ' + r.error + '. Please check the phone hotspot connection.' };
        const j = r.json || {};
        const msg = j.choices && j.choices[0] && j.choices[0].message;
        if (msg && msg.content) return { ok: true, text: String(msg.content).trim() };
        return { ok: false, text: 'AI: ' + ((j.error && j.error.message) || ('HTTP ' + r.status + ' ' + String(r.raw || '').slice(0, 120))) };
    }
}

module.exports = { AiBridge, CONFIG_PATH };
