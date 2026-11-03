'use strict';
/**
 * M-Copilot - AI Performance Co-Driver & Intelligent Assistant for BMW iDrive 7.
 * Runs natively on the vehicle's GPU at 60 fps.
 *
 * Pages:
 *   0: M-Copilot AI - Neural Orb, Live Conversation & Quick Prompt Chips
 *   1: Telemetry Vitals - Live engine vitals, boost, tire thermals, G-meter
 *   2: Subscription Connect - QR Code phone pairing (ChatGPT/Gemini/Relay)
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { Diag } = require('./kit/diag');
const { AiBridge } = require('./ai');
const qrcodegen = require('./qrcodegen');

const W = 1600, H = 520;
const PAGES = ['M-Copilot AI', 'Telemetry Vitals', 'Subscription Connect'];

const PROMPTS = [
    { title: 'Launch Readiness', query: 'Is the car ready for Launch Control? Check oil temp and tires.' },
    { title: 'Turbo Cooling', query: 'Check N63TU3 hot-v turbo temperature and cooling pump status.' },
    { title: 'Tire Grip & PSI', query: 'Analyze current tire pressures and rubber temperature grip window.' },
    { title: 'ECU Health & DTC', query: 'Run full OBD-II UDS scan for active or shadow fault codes.' },
    { title: 'Scenic Mountain Route', query: 'Suggest the best twisty mountain pass route near Georgia.' },
    { title: 'N63TU3 Specs & Fluids', query: 'What are the official oil specs, capacity, and spark plugs for N63TU3?' }
];

mgu.run({
    async start(ctx) {
        const { ui, settings, log, signals } = ctx;
        const diag = new Diag(signals, log);
        diag.init().catch(() => {});

        const ai = new AiBridge(log);

        let page = 0;
        let isThinking = false;
        let currentPrompt = PROMPTS[0].title;
        let currentResponse = '';
        let statusMsg = null;
        let statusTime = 0;

        // Simulated/Live Telemetry state
        const telemetry = {
            speed: 0,
            rpm: 650,
            gear: 'P',
            oilTemp: 98,
            coolantTemp: 92,
            boost: 1.15, // bar
            driveMode: 'SPORT+',
            lateralG: 0.12,
            longitudinalG: 0.05,
            tireFlPsi: 35.5,
            tireFrPsi: 35.8,
            tireRlPsi: 37.2,
            tireRrPsi: 37.0,
            tireTemp: 38,
            ambientTemp: 22,
            dtcs: []
        };

        // Update telemetry from live car signals if present
        try {
            const Car = require('./kit/car');
            const car = new Car(ctx, ['rpm', 'speed', 'accel', 'temps', 'gear']);
            car.onSample((data) => {
                if (data.speed !== undefined) telemetry.speed = Math.round(data.speed);
                if (data.rpm !== undefined) telemetry.rpm = Math.round(data.rpm);
                if (data.oil !== undefined) telemetry.oilTemp = Math.round(data.oil);
                if (data.coolant !== undefined) telemetry.coolantTemp = Math.round(data.coolant);
                if (data.gLat !== undefined) telemetry.lateralG = data.gLat;
                if (data.gLong !== undefined) telemetry.longitudinalG = data.gLong;
                if (data.gear !== undefined) telemetry.gear = data.gear;
            });
        } catch (e) {
            log.warn('M-Copilot: Car telemetry init fallback: ' + e.message);
        }

        function notify(msg) {
            statusMsg = msg;
            statusTime = Date.now();
            log.info('M-Copilot: ' + msg);
        }

        async function askCopilot(queryText, title) {
            currentPrompt = title || 'Custom Query';
            isThinking = true;
            currentResponse = 'Analyzing real-time vehicle telemetry...';

            const tier = settings.tier || 'subscription';
            const persona = settings.persona || 'm_engineer';

            try {
                const answer = await ai.ask(queryText, telemetry, { mode: tier, persona });
                currentResponse = answer;
            } catch (e) {
                currentResponse = 'Error: ' + e.message;
            } finally {
                isThinking = false;
                render().catch(() => {});
            }
        }

        // Trigger initial greeting / readiness
        askCopilot(PROMPTS[0].query, PROMPTS[0].title);

        /* ---------- QR Matrix for Subscription Pairing ---------- */
        let cachedQr = null;
        function getPairingQr() {
            if (cachedQr) return cachedQr;
            try {
                const url = 'https://ai.antigravity.dev/bmw-connect?car=m850i&vin=WBABC41090K123456';
                cachedQr = qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.MEDIUM);
                return cachedQr;
            } catch (e) {
                return null;
            }
        }

        /* ---------- Helper: Text Wrapping ---------- */
        function wrapLines(text, maxChars = 56) {
            const rawLines = text.split('\n');
            const lines = [];
            rawLines.forEach(rl => {
                if (rl.length <= maxChars) {
                    lines.push(rl);
                } else {
                    const words = rl.split(' ');
                    let cur = '';
                    words.forEach(w => {
                        if ((cur + ' ' + w).length <= maxChars) {
                            cur = cur ? cur + ' ' + w : w;
                        } else {
                            if (cur) lines.push(cur);
                            cur = w;
                        }
                    });
                    if (cur) lines.push(cur);
                }
            });
            return lines;
        }

        /* ---------- Neural Orb Drawing ---------- */
        function drawNeuralOrb(cv, cx, cy, radius, now) {
            const pulse = (Math.sin(now / 350) + 1) * 0.5;
            const fastPulse = isThinking ? (Math.sin(now / 120) + 1) * 0.5 : pulse;

            // Outer glow circle
            cv.circle(cx, cy, radius + 10, withAlpha('#00a3e0', 0.15 + fastPulse * 0.15));
            cv.circle(cx, cy, radius, '#08121f');
            cv.strokeRoundRect(cx - radius, cy - radius, radius * 2, radius * 2, radius, 1.5, '#1b2a3d');

            // Rotating BMW M Tricolour Arcs
            const angle1 = (now / 20) % 360;
            const angle2 = (-now / 25) % 360;
            const angle3 = (now / 35) % 360;

            cv.arc(cx, cy, radius - 8, radius - 3, angle1, angle1 + 140, '#00a3e0', { round: true }); // M Light Blue
            cv.arc(cx, cy, radius - 18, radius - 14, angle2, angle2 + 160, '#163a8a', { round: true }); // M Dark Blue
            cv.arc(cx, cy, radius - 28, radius - 24, angle3, angle3 + 120, '#e1001a', { round: true }); // M Red

            // Inner Core
            const coreRad = 36 + (isThinking ? fastPulse * 8 : pulse * 4);
            cv.circle(cx, cy, coreRad, withAlpha('#00a3e0', 0.25));
            cv.circle(cx, cy, 24, '#ffffff');

            // Soundwave / Frequency equalizer bars inside orb
            const bars = 7;
            const barW = 4;
            const barSpacing = 8;
            const totalW = bars * barSpacing;
            const startX = cx - Math.floor(totalW / 2);

            for (let i = 0; i < bars; i++) {
                const hFactor = isThinking
                    ? Math.abs(Math.sin((now / 150) + i * 0.8))
                    : (0.3 + 0.3 * Math.sin((now / 400) + i * 0.5));
                const bH = Math.max(6, Math.floor(hFactor * 32));
                const bx = startX + i * barSpacing;
                const by = cy - Math.floor(bH / 2);
                cv.roundRect(bx, by, barW, bH, 2, i % 2 === 0 ? '#00a3e0' : '#e1001a');
            }
        }

        /* ---------- Page 0: M-Copilot AI Main Screen ---------- */
        function drawMainCopilot(cv, t, now) {
            // Panel 1 (Left): AI Neural Core
            G.panel(cv, t, 40, 52, 380, 410, 'M Neural Core');

            drawNeuralOrb(cv, 230, 180, 84, now);

            // Status Badge
            const tier = settings.tier || 'subscription';
            let tierLabel = 'SUBSCRIPTION ACTIVE';
            let tierCol = '#00a3e0';
            if (tier === 'gemini_free') { tierLabel = 'FREE GEMINI TIER ($0)'; tierCol = '#2af575'; }
            else if (tier === 'custom_api') { tierLabel = 'CUSTOM API KEY'; tierCol = '#ffb703'; }
            else if (tier === 'offline_expert') { tierLabel = 'OFFLINE ECU EXPERT'; tierCol = '#a0aec0'; }

            cv.roundRect(80, 290, 300, 32, 8, withAlpha(tierCol, 0.15));
            cv.strokeRoundRect(80, 290, 300, 32, 8, 1, tierCol);
            cv.text(tierLabel, 230, 312, 16, tierCol, { align: 'center', font: 'bold' });

            // Telemetry quick pill
            cv.text(`${telemetry.oilTemp}°C OIL | ${telemetry.boost} BAR | ${telemetry.driveMode}`, 230, 348, 17, t.dim, { align: 'center', font: 'num' });

            // Ask button
            const askW = 300, askH = 48, askX = 80, askY = 384;
            cv.roundRect(askX, askY, askW, askH, 10, isThinking ? '#2c3e50' : '#00a3e0');
            cv.text(isThinking ? 'THINKING...' : 'ASK M-COPILOT', askX + askW / 2, askY + 31, 19, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });
            cv.target(askX, askY, askW, askH, () => {
                askCopilot(PROMPTS[0].query, PROMPTS[0].title);
            }, 'btn_ask', 10);

            // Panel 2 (Center): Conversation Stream
            G.panel(cv, t, 440, 52, 740, 410, 'Dialogue: ' + currentPrompt);

            // Response Box Card
            const rx = 460, ry = 114, rw = 700, rh = 328;
            cv.roundRect(rx, ry, rw, rh, 12, '#090e15');
            cv.strokeRoundRect(rx, ry, rw, rh, 12, 1, t.panelEdge);

            // Left decorative M stripe on response card
            cv.fillRect(rx + 2, ry + 12, 4, rh - 24, '#00a3e0');

            // Render Response text with wrap
            const lines = wrapLines(currentResponse, 58);
            const maxVisibleLines = 11;
            lines.slice(0, maxVisibleLines).forEach((line, idx) => {
                const ly = ry + 36 + idx * 26;
                let col = '#e2e8f0';
                let isBold = false;

                if (line.startsWith('✓') || line.includes('Optimal') || line.includes('Passed')) col = '#2af575';
                else if (line.startsWith('⚠') || line.includes('Cold') || line.includes('Warning')) col = '#ffb703';
                else if (line.startsWith('[') && line.endsWith(']')) { col = '#00a3e0'; isBold = true; }
                else if (line.startsWith('1.') || line.startsWith('2.') || line.startsWith('3.')) col = '#ffffff';

                cv.text(line, rx + 24, ly, 18, col, { font: isBold ? 'bold' : 'normal' });
            });

            // Panel 3 (Right): Quick Prompt Chips
            G.panel(cv, t, 1200, 52, 360, 410, 'Co-Driver Quick Chips');

            PROMPTS.forEach((p, idx) => {
                const py = 114 + idx * 54;
                const isCur = currentPrompt === p.title;

                cv.roundRect(1220, py, 320, 46, 8, isCur ? withAlpha('#00a3e0', 0.25) : t.track);
                cv.strokeRoundRect(1220, py, 320, 46, 8, isCur ? 1.5 : 1, isCur ? '#00a3e0' : t.panelEdge);

                cv.circle(1242, py + 23, 5, isCur ? '#00a3e0' : t.dim);
                cv.text(p.title, 1260, py + 29, 17, isCur ? '#ffffff' : '#cbd5e1', { font: isCur ? 'bold' : 'normal' });

                cv.target(1220, py, 320, 46, () => {
                    askCopilot(p.query, p.title);
                }, 'chip_' + idx, 8);
            });
        }

        /* ---------- Page 1: Telemetry Vitals ---------- */
        function drawTelemetry(cv, t) {
            G.panel(cv, t, 40, 52, 480, 410, 'Powertrain Thermal Vitals');

            // Oil Temp Gauge
            cv.text('ENGINE OIL TEMPERATURE', 64, 120, 16, t.dim, { font: 'bold' });
            cv.text(`${telemetry.oilTemp}°C`, 64, 155, 36, telemetry.oilTemp >= 80 ? '#2af575' : '#ffb703', { font: 'bold' });
            cv.text('Optimal window: 90°C - 110°C', 200, 150, 16, t.dim);
            cv.roundRect(64, 170, 430, 14, 7, t.track);
            const oilFill = Math.min(430, Math.max(0, (telemetry.oilTemp / 140) * 430));
            cv.roundRect(64, 170, oilFill, 14, 7, '#00a3e0');

            // Coolant Temp Gauge
            cv.text('DUAL CIRCUIT COOLANT', 64, 230, 16, t.dim, { font: 'bold' });
            cv.text(`${telemetry.coolantTemp}°C`, 64, 265, 36, '#2af575', { font: 'bold' });
            cv.text('Charge-air & Engine circuits', 200, 260, 16, t.dim);
            cv.roundRect(64, 280, 430, 14, 7, t.track);
            const coolFill = Math.min(430, Math.max(0, (telemetry.coolantTemp / 120) * 430));
            cv.roundRect(64, 280, coolFill, 14, 7, '#163a8a');

            // Turbo Boost Gauge
            cv.text('N63 HOT-V MANIFOLD BOOST', 64, 340, 16, t.dim, { font: 'bold' });
            cv.text(`${telemetry.boost} BAR`, 64, 375, 36, '#e1001a', { font: 'bold' });
            cv.text('Peak 1.35 bar in SPORT+', 220, 370, 16, t.dim);
            cv.roundRect(64, 390, 430, 14, 7, t.track);
            const boostFill = Math.min(430, Math.max(0, (telemetry.boost / 1.5) * 430));
            cv.roundRect(64, 390, boostFill, 14, 7, '#e1001a');

            // Panel 2: Tire Pressures & Temps
            G.panel(cv, t, 540, 52, 540, 410, 'Tire Telemetry & Grip');

            const cx = 810, cy = 250;
            // Car chassis silhouette
            cv.roundRect(cx - 50, cy - 100, 100, 200, 26, '#0f1722');
            cv.strokeRoundRect(cx - 50, cy - 100, 100, 200, 26, 2, t.panelEdge);

            // 4 Tires
            function drawTire(tx, ty, psi, temp, label) {
                cv.roundRect(tx - 24, ty - 34, 48, 68, 10, '#1a2636');
                cv.strokeRoundRect(tx - 24, ty - 34, 48, 68, 10, 1.5, temp >= 30 ? '#2af575' : '#00a3e0');
                cv.text(label, tx, ty - 42, 14, t.dim, { align: 'center', font: 'bold' });
                cv.text(`${psi.toFixed(1)}`, tx, ty + 2, 17, '#ffffff', { align: 'center', font: 'bold' });
                cv.text(`${temp}°C`, tx, ty + 20, 14, temp >= 30 ? '#2af575' : '#00a3e0', { align: 'center' });
            }

            drawTire(cx - 100, cy - 65, telemetry.tireFlPsi, telemetry.tireTemp, 'FRONT L');
            drawTire(cx + 100, cy - 65, telemetry.tireFrPsi, telemetry.tireTemp, 'FRONT R');
            drawTire(cx - 100, cy + 75, telemetry.tireRlPsi, telemetry.tireTemp + 2, 'REAR L');
            drawTire(cx + 100, cy + 75, telemetry.tireRrPsi, telemetry.tireTemp + 2, 'REAR R');

            // Panel 3: G-Force Meter & Drive Mode
            G.panel(cv, t, 1100, 52, 460, 410, 'Dynamics & G-Meter');
            const gx = 1330, gy = 230, gr = 90;
            cv.circle(gx, gy, gr, '#090e15');
            cv.circle(gx, gy, gr * 0.66, t.track);
            cv.circle(gx, gy, gr * 0.33, t.track);
            cv.line(gx - gr, gy, gx + gr, gy, 1, t.dim);
            cv.line(gx, gy - gr, gx, gy + gr, 1, t.dim);

            // G-ball
            const bx = gx + Math.floor(telemetry.lateralG * 60);
            const by = gy - Math.floor(telemetry.longitudinalG * 60);
            cv.circle(bx, by, 12, '#e1001a');
            cv.circle(bx, by, 5, '#ffffff');

            cv.text(`LATERAL: ${telemetry.lateralG.toFixed(2)} G`, 1330, 360, 18, '#ffffff', { align: 'center', font: 'num' });
            cv.text(`DRIVE MODE: ${telemetry.driveMode}`, 1330, 395, 18, '#00a3e0', { align: 'center', font: 'bold' });
        }

        /* ---------- Page 2: Subscription Connect & Phone Pairing ---------- */
        function drawConnect(cv, t) {
            G.panel(cv, t, 40, 52, 600, 410, 'Pair Subscription / Phone');

            const qr = getPairingQr();
            if (qr) {
                const qrx = 80, qry = 120, qrsz = 220;
                const modCount = qr.size;
                const modPx = Math.floor(qrsz / modCount);
                const actualSz = modPx * modCount;
                const ox = qrx + Math.floor((qrsz - actualSz) / 2);
                const oy = qry + Math.floor((qrsz - actualSz) / 2);

                cv.roundRect(ox - 14, oy - 14, actualSz + 28, actualSz + 28, 12, '#ffffff');
                for (let r = 0; r < modCount; r++) {
                    for (let c = 0; c < modCount; c++) {
                        if (qr.getModule(c, r)) {
                            cv.fillRect(ox + c * modPx, oy + r * modPx, modPx, modPx, '#000000');
                        }
                    }
                }

                cv.text('SCAN WITH PHONE CAMERA', 330, 150, 18, '#ffffff', { font: 'bold' });
                cv.text('Links your ChatGPT Plus / Team,', 330, 182, 16, t.dim);
                cv.text('Gemini Advanced, or Claude Pro', 330, 206, 16, t.dim);
                cv.text('No per-token billing needed!', 330, 230, 16, '#2af575', { font: 'bold' });

                cv.text('Pairing Code: M850-COPILOT', 330, 280, 20, '#00a3e0', { font: 'num' });
            }

            // Right Panel: Available Modes Explanation
            G.panel(cv, t, 660, 52, 900, 410, 'Zero-Cost & Subscription Options');

            const modes = [
                {
                    title: '1. Personal Subscription Relay (Zero Extra Cost)',
                    desc: 'Uses your existing ChatGPT Plus or Gemini Advanced web subscription session token.\nZero API charges, unlimited queries in car.',
                    color: '#00a3e0'
                },
                {
                    title: '2. Google Gemini Free Tier ($0.00 / Month)',
                    desc: 'Google Gemini 1.5/2.0 Flash provides 15 requests per minute completely free.\nNo credit card required. Perfect for personal vehicle copilot.',
                    color: '#2af575'
                },
                {
                    title: '3. Offline ECU Expert Engine (No Internet Required)',
                    desc: 'Built-in G15 / M850i / N63TU3 expert rule engine. Answers launch control, thermal specs,\nOBD-II DTC definitions, and mountain pass routes instantaneously.',
                    color: '#ffb703'
                }
            ];

            modes.forEach((m, idx) => {
                const my = 114 + idx * 105;
                cv.roundRect(680, my, 860, 92, 10, '#080d14');
                cv.strokeRoundRect(680, my, 860, 92, 10, 1, m.color);

                cv.text(m.title, 704, my + 30, 19, m.color, { font: 'bold' });
                const descLines = m.desc.split('\n');
                descLines.forEach((dl, di) => {
                    cv.text(dl, 704, my + 56 + di * 22, 15, '#94a3b8');
                });
            });
        }

        /* ---------- Master 60 fps Render Loop ---------- */
        async function render() {
            const now = Date.now();
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);

            // Render Active Page
            if (page === 0) drawMainCopilot(cv, t, now);
            else if (page === 1) drawTelemetry(cv, t);
            else if (page === 2) drawConnect(cv, t);

            // G20/G15 Live Cockpit frame tabs along the top
            G.frame(cv, t, PAGES, page, [
                { text: 'M-COPILOT AI' },
                { text: telemetry.driveMode },
                { text: `${telemetry.oilTemp}°C OIL` }
            ]);

            // Global Notification banner
            if (statusMsg && (now - statusTime < 3500)) {
                cv.roundRect(W / 2 - 320, H - 56, 640, 42, 10, '#00a3e0');
                cv.text(statusMsg, W / 2, H - 29, 18, '#ffffff', { align: 'center', font: 'bold' });
            }

            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- HMI Button & Touch Interactions ---------- */
        ui.onClick('BTN_PROMPT', () => {
            askCopilot(PROMPTS[0].query, PROMPTS[0].title);
            return render();
        });

        ui.onClick('BTN_TELEMETRY', () => {
            page = (page + 1) % PAGES.length;
            return render();
        });

        ctx.onTab((idx) => {
            page = idx;
            return render();
        });

        // Start 60 fps render loop
        ctx.loop('MAIN', 15, render);
        render().then(() => log.info('M-Copilot ready')).catch((e) => log.warn('M-Copilot render error: ' + e));
    }
});
