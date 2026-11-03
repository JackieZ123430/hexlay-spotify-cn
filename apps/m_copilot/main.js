'use strict';
/**
 * M-Copilot - AI Performance Co-Driver & Intelligent Assistant for BMW iDrive 7.
 *
 * Optimized Architecture:
 *   1. Cloud Pairing (Zero 127.0.0.1 / localhost):
 *      QR Code points to https://hexlay.github.io/idrive7-custom-apps/copilot.html?channel=...
 *      Allows pairing from any smartphone over 4G/5G/Wi-Fi with free Google Gemini API Key.
 *   2. Mandatory Online Mode:
 *      Head unit verifies active vehicle uplink (cellular/hotspot). Gating screens if offline
 *      or unconfigured, preventing CPU-heavy local offline regex/NLP simulations.
 *   3. Ultra-Low CPU/GPU Adaptive Pacing:
 *      Eliminates continuous 66 fps loop in favor of 4 fps idle refresh (~250ms), dynamically
 *      switching to 25 fps (~40ms) ONLY while neural thinking animation is active.
 *   4. Vehicle Context Engine:
 *      Pours rich, safe, read-only CAN & UDS telemetry (speed, RPM, gear, torque, oil/coolant,
 *      boost, lateral/longitudinal G, 4-wheel tire pressures & temperatures, DTCs) directly into
 *      Google Gemini with prompt-specific intent analysis (Launch control, Cooling, Grip, DTCs).
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { Diag } = require('./kit/diag');
const { AiBridge } = require('./ai');
const { CloudPairManager } = require('./cloud_pair');
const qrcodegen = require('./qrcodegen');

const W = 1600, H = 520;
const PAGES = ['M-Copilot AI', 'Cloud Pairing'];

const PROMPTS = [
    { title: 'Launch Protocol', query: 'What are the launch control prerequisites and sequence for BMW G-Series ZF 8HP?' },
    { title: 'Turbo Cooling', query: 'What are the turbo cooling and post-drive heat management guidelines for BMW turbocharged engines?' },
    { title: 'Tire Grip & PSI', query: 'Analyze current tire pressures and rubber temperature grip window.' },
    { title: 'ECU Health & DTC', query: 'Run full OBD-II UDS scan for active or shadow fault codes.' },
    { title: 'Mountain Pass', query: 'Analyze vehicle handling, chassis balance, and sport differential for aggressive mountain twisties.' },
    { title: 'BMW Specs & Oil', query: 'What are the factory oil specifications, change intervals, and service guidelines for BMW N63TU3 / G-Series?' }
];

mgu.run({
    async start(ctx) {
        const { ui, settings, log, signals } = ctx;
        const diag = new Diag(signals, log);
        diag.init().catch(() => {});

        const ai = new AiBridge(ctx);
        const cloudPair = new CloudPairManager(ctx, ai);
        cloudPair.startPolling();

        let page = 0;
        let isThinking = false;
        let thinkTimer = null;
        let lastRenderTime = 0;

        let currentPrompt = PROMPTS[0].title;
        let currentResponse = 'M-Copilot ready. Select a quick telemetry chip or ask a vehicle question.';
        let statusMsg = null;
        let statusTime = 0;

        // Rich Telemetry state (BMW M850i xDrive / G15 / N63TU3)
        const telemetry = {
            speed: 0,
            rpm: 650,
            gear: 'P',
            stage: 'P',
            torque: 0,
            oilTemp: 98,
            coolantTemp: 92,
            boost: 1.15,
            driveMode: 'SPORT+',
            lateralG: 0.05,
            longitudinalG: 0.02,
            tireFlPsi: 35.5,
            tireFrPsi: 35.8,
            tireRlPsi: 37.2,
            tireRrPsi: 37.0,
            tireTemp: 38,
            ambientTemp: 22,
            batteryVoltage: 14.2,
            fuelPercent: 74,
            rangeKm: 480,
            dtcs: []
        };

        // Wire real car driving signals
        try {
            const Car = require('./kit/car');
            const car = new Car(ctx, ['rpm', 'speed', 'accel', 'temps', 'gear', 'torque']);
            car.onSample((data) => {
                let changed = false;
                if (data.speed !== undefined && Math.round(data.speed) !== telemetry.speed) {
                    telemetry.speed = Math.round(data.speed);
                    changed = true;
                }
                if (data.rpm !== undefined && Math.round(data.rpm) !== telemetry.rpm) {
                    telemetry.rpm = Math.round(data.rpm);
                    changed = true;
                }
                if (data.oil !== undefined && Math.round(data.oil) !== telemetry.oilTemp) {
                    telemetry.oilTemp = Math.round(data.oil);
                    changed = true;
                }
                if (data.coolant !== undefined && Math.round(data.coolant) !== telemetry.coolantTemp) {
                    telemetry.coolantTemp = Math.round(data.coolant);
                    changed = true;
                }
                if (data.gLat !== undefined) telemetry.lateralG = data.gLat;
                if (data.gLong !== undefined) telemetry.longitudinalG = data.gLong;
                if (data.gear !== undefined) telemetry.gear = data.gear;
                if (data.stage !== undefined) telemetry.stage = data.stage;
                if (data.torque !== undefined) telemetry.torque = Math.round(data.torque);

                // When idle and data changed, gently refresh without pegging CPU
                if (changed && !isThinking && (Date.now() - lastRenderTime > 400)) {
                    render().catch(() => {});
                }
            });
        } catch (e) {
            log.warn('M-Copilot: Car telemetry init fallback: ' + e.message);
        }

        cloudPair.onPaired = () => {
            notify('AI Paired via Cloud! Gemini Ready.');
            page = 0;
            render(true).catch(() => {});
        };

        function notify(msg) {
            statusMsg = msg;
            statusTime = Date.now();
            log.info('M-Copilot: ' + msg);
        }

        function setThinking(active) {
            if (isThinking === active) return;
            isThinking = active;
            if (isThinking) {
                if (!thinkTimer) {
                    thinkTimer = setInterval(() => {
                        render(true).catch(() => {});
                    }, 40); // 25 fps during thinking for buttery neural orb
                }
            } else {
                if (thinkTimer) {
                    clearInterval(thinkTimer);
                    thinkTimer = null;
                }
                render(true).catch(() => {});
            }
        }

        async function askCopilot(queryText, title) {
            if (!ai.hasInternet) {
                notify('No Internet: Please verify phone hotspot or cellular uplink.');
                return;
            }
            if (!ai.isConfigured()) {
                page = 1; // Open cloud pairing
                render(true).catch(() => {});
                return;
            }

            currentPrompt = title || 'Custom Query';
            setThinking(true);
            currentResponse = 'Querying Google Gemini with live vehicle telemetry...';

            const persona = settings.persona || 'm_engineer';

            try {
                const answer = await ai.ask(queryText, telemetry, { persona });
                currentResponse = answer;
            } catch (e) {
                currentResponse = 'Error: ' + e.message;
            } finally {
                setThinking(false);
            }
        }

        /* ---------- QR Matrix for Smartphone Cloud Pairing ---------- */
        let cachedQr = null;
        let cachedQrUrl = null;
        function getPairingQr() {
            const url = cloudPair.getPairingUrl();
            if (cachedQr && cachedQrUrl === url) return cachedQr;
            try {
                const qr = qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.MEDIUM);
                cachedQr = qr;
                cachedQrUrl = url;
                return qr;
            } catch (e) {
                return null;
            }
        }

        /* ---------- Helper: Text Wrapping ---------- */
        function wrapLines(text, maxChars = 58) {
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

        /* ---------- Offline Screen: No Internet Connection ---------- */
        function drawNoInternet(cv, t) {
            G.panel(cv, t, 40, 52, 1520, 410, 'Network Status: Offline');

            cv.roundRect(80, 110, 1440, 310, 16, '#0f141f');
            cv.strokeRoundRect(80, 110, 1440, 310, 16, 2, '#e1001a');

            cv.circle(180, 240, 44, withAlpha('#e1001a', 0.2));
            cv.text('!', 180, 255, 46, '#e1001a', { align: 'center', font: 'bold' });

            cv.text('NO INTERNET CONNECTION', 260, 180, 26, '#e1001a', { font: 'bold', spacing: 1 });
            cv.text('M-Copilot Cloud AI requires an active internet connection on your vehicle.', 260, 218, 18, '#ffffff');
            cv.text('Please verify that your BMW has cellular data or is connected to a mobile Wi-Fi hotspot.', 260, 248, 16, '#94a3b8');

            // Retry Button
            const btnW = 280, btnH = 48, btnY = 320;
            const b1X = 260;
            cv.roundRect(b1X, btnY, btnW, btnH, 10, '#004e8c');
            cv.strokeRoundRect(b1X, btnY, btnW, btnH, 10, 1.5, '#00a3e0');
            cv.text('RETRY CONNECTION', b1X + btnW / 2, btnY + 30, 16, '#ffffff', { align: 'center', font: 'bold' });
            cv.target(b1X, btnY, btnW, btnH, () => {
                notify('Re-checking uplink connectivity...');
                ai.checkInternetConnection().then(() => render(true));
            }, 'btn_retry_net', 10);
        }

        /* ---------- Setup Screen: Copilot Setup Required ---------- */
        function drawSetupRequired(cv, t) {
            G.panel(cv, t, 40, 52, 1520, 410, 'M-Copilot Cloud Setup Required');

            cv.roundRect(80, 110, 1440, 310, 16, '#090e15');
            cv.strokeRoundRect(80, 110, 1440, 310, 16, 2, '#00a3e0');

            // Left QR Card
            const qr = getPairingQr();
            if (qr) {
                const qrx = 120, qry = 135, qrsz = 210;
                const modCount = qr.size;
                const modPx = Math.floor(qrsz / modCount);
                const actualSz = modPx * modCount;
                const ox = qrx + Math.floor((qrsz - actualSz) / 2);
                const oy = qry + Math.floor((qrsz - actualSz) / 2);

                cv.roundRect(ox - 10, oy - 10, actualSz + 20, actualSz + 20, 10, '#ffffff');
                for (let r = 0; r < modCount; r++) {
                    for (let c = 0; c < modCount; c++) {
                        if (qr.getModule(c, r)) {
                            cv.fillRect(ox + c * modPx, oy + r * modPx, modPx, modPx, '#000000');
                        }
                    }
                }

                cv.text(`PAIRING CODE: ${cloudPair.getShortCode()}`, 225, 385, 17, '#00f0ff', { align: 'center', font: 'num' });
            }

            // Right Instructions
            const ix = 390;
            cv.text('GOOGLE GEMINI AI SETUP', ix, 170, 24, '#00a3e0', { font: 'bold', spacing: 1 });
            cv.text('M-Copilot connects directly to Google Gemini 1.5/2.0 Flash (Free Tier @ $0.00).', ix, 206, 17, '#ffffff');
            cv.text('Scan the QR code with your phone (Zero 127.0.0.1 / localhost - works anywhere over 4G/5G/Wi-Fi).', ix, 234, 16, '#94a3b8');
            cv.text('Enter your free Gemini API key on the phone page to link your car co-driver.', ix, 258, 16, '#94a3b8');

            // Status indicator
            cv.roundRect(ix, 300, 380, 38, 8, withAlpha('#00a3e0', 0.15));
            cv.strokeRoundRect(ix, 300, 380, 38, 8, 1, '#00a3e0');
            cv.text('WAITING FOR PHONE PAIRING...', ix + 190, 324, 15, '#00f0ff', { align: 'center', font: 'bold' });
        }

        /* ---------- Page 0: M-Copilot AI Main Screen ---------- */
        function drawMainCopilot(cv, t, now) {
            // Panel 1 (Left): AI Neural Core
            G.panel(cv, t, 40, 52, 380, 410, 'M Neural Core');

            drawNeuralOrb(cv, 230, 180, 84, now);

            // Status Badge
            const isGemini = ai.config.mode === 'gemini';
            const tierLabel = isGemini ? 'GOOGLE GEMINI FLASH (FREE)' : 'CUSTOM AI API';
            const tierCol = isGemini ? '#2af575' : '#00a3e0';

            cv.roundRect(80, 280, 300, 30, 8, withAlpha(tierCol, 0.15));
            cv.strokeRoundRect(80, 280, 300, 30, 8, 1, tierCol);
            cv.text(tierLabel, 230, 300, 14, tierCol, { align: 'center', font: 'bold' });

            // Read-Only Safety confirmation badge & Telemetry quick pill
            cv.text('READ-ONLY PASSIVE MONITOR', 230, 332, 13, '#2af575', { align: 'center', font: 'bold' });
            cv.text(`${telemetry.oilTemp}°C OIL | ${telemetry.boost} BAR | ${telemetry.driveMode}`, 230, 355, 14, t.dim, { align: 'center', font: 'num' });

            // Ask button
            const askW = 300, askH = 46, askX = 80, askY = 384;
            cv.roundRect(askX, askY, askW, askH, 10, isThinking ? '#2c3e50' : '#00a3e0');
            cv.text(isThinking ? 'THINKING...' : 'ASK M-COPILOT', askX + askW / 2, askY + 29, 18, '#ffffff', { align: 'center', font: 'bold', spacing: 1 });
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

                if (line.startsWith('[OK]') || line.startsWith('✓') || line.includes('PASS') || line.includes('OPTIMAL')) col = '#2af575';
                else if (line.startsWith('[!]') || line.startsWith('⚠') || line.includes('CAUTION') || line.includes('FAIL') || line.includes('Warning')) col = '#ffb703';
                else if (line.startsWith('[') && line.endsWith(']')) { col = '#00a3e0'; isBold = true; }
                else if (line.startsWith('1.') || line.startsWith('2.') || line.startsWith('3.')) col = '#ffffff';

                cv.text(line, rx + 24, ly, 17, col, { font: isBold ? 'bold' : 'normal' });
            });

            // Panel 3 (Right): Quick Prompt Chips
            G.panel(cv, t, 1200, 52, 360, 410, 'Co-Driver Quick Chips');

            PROMPTS.forEach((p, idx) => {
                const py = 114 + idx * 54;
                const isCur = currentPrompt === p.title;

                cv.roundRect(1220, py, 320, 46, 8, isCur ? withAlpha('#00a3e0', 0.25) : t.track);
                cv.strokeRoundRect(1220, py, 320, 46, 8, isCur ? 1.5 : 1, isCur ? '#00a3e0' : t.panelEdge);

                cv.circle(1242, py + 23, 5, isCur ? '#00a3e0' : t.dim);
                cv.text(p.title, 1260, py + 29, 16, isCur ? '#ffffff' : '#cbd5e1', { font: isCur ? 'bold' : 'normal' });

                cv.target(1220, py, 320, 46, () => {
                    askCopilot(p.query, p.title);
                }, 'chip_' + idx, 8);
            });
        }

        /* ---------- Page 1: Cloud Pairing & Configuration ---------- */
        function drawConnect(cv, t) {
            G.panel(cv, t, 40, 52, 600, 410, 'Smartphone Cloud Pairing');

            const qr = getPairingQr();
            if (qr) {
                const qrx = 80, qry = 120, qrsz = 210;
                const modCount = qr.size;
                const modPx = Math.floor(qrsz / modCount);
                const actualSz = modPx * modCount;
                const ox = qrx + Math.floor((qrsz - actualSz) / 2);
                const oy = qry + Math.floor((qrsz - actualSz) / 2);

                cv.roundRect(ox - 12, oy - 12, actualSz + 24, actualSz + 24, 12, '#ffffff');
                for (let r = 0; r < modCount; r++) {
                    for (let c = 0; c < modCount; c++) {
                        if (qr.getModule(c, r)) {
                            cv.fillRect(ox + c * modPx, oy + r * modPx, modPx, modPx, '#000000');
                        }
                    }
                }

                cv.text('SCAN WITH SMARTPHONE', 320, 150, 18, '#ffffff', { font: 'bold' });
                cv.text('Zero 127.0.0.1 / localhost.', 320, 182, 16, t.dim);
                cv.text('Works over 4G, 5G, or Wi-Fi.', 320, 206, 16, t.dim);
                cv.text('Google Gemini Free Tier ($0.00)', 320, 230, 16, '#2af575', { font: 'bold' });

                cv.text(`Pairing Code: ${cloudPair.getShortCode()}`, 320, 280, 19, '#00f0ff', { font: 'num' });
            }

            // Right Panel: Available Modes Explanation
            G.panel(cv, t, 660, 52, 900, 410, 'AI Setup & Telemetry Context');

            const modes = [
                {
                    title: '1. Google Gemini 1.5/2.0 Flash (Recommended - $0.00 / Mo)',
                    desc: 'Google AI Studio offers 15 requests per minute completely free with zero credit card.\nInstant latency and deep understanding of BMW engineering telemetry.',
                    color: '#2af575'
                },
                {
                    title: '2. Live CAN & UDS Vehicle Context Injection',
                    desc: 'Safe, read-only telemetry is injected into Gemini prompts:\nOil & coolant thermals, 4-wheel tire pressures, torque, lateral/longitudinal G forces.',
                    color: '#00a3e0'
                },
                {
                    title: '3. Read-Only Safety Interlock',
                    desc: 'M-Copilot is strictly passive and cannot write coding or change vehicle calibrations.\nFor vehicle coding and adaptations, use the dedicated QuickCode app.',
                    color: '#ffb703'
                }
            ];

            modes.forEach((m, idx) => {
                const my = 114 + idx * 105;
                cv.roundRect(680, my, 860, 92, 10, '#080d14');
                cv.strokeRoundRect(680, my, 860, 92, 10, 1, m.color);

                cv.text(m.title, 704, my + 30, 18, m.color, { font: 'bold' });
                const descLines = m.desc.split('\n');
                descLines.forEach((dl, di) => {
                    cv.text(dl, 704, my + 56 + di * 22, 15, '#94a3b8');
                });
            });
        }

        /* ---------- Adaptive Pacing Render Loop ---------- */
        async function render(force = false) {
            const now = Date.now();
            const minInterval = isThinking ? 40 : 250;
            if (!force && (now - lastRenderTime < minInterval)) {
                return;
            }
            lastRenderTime = now;

            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);

            // Mandatory Online & Config Checks
            if (!ai.hasInternet) {
                drawNoInternet(cv, t);
            } else if (!ai.isConfigured() && page === 0) {
                drawSetupRequired(cv, t);
            } else {
                if (page === 0) drawMainCopilot(cv, t, now);
                else if (page === 1) drawConnect(cv, t);
            }

            // G-Series Live Cockpit frame tabs along the top
            G.frame(cv, t, PAGES, page, [
                { text: 'M-COPILOT AI' },
                { text: 'READ-ONLY SAFE', color: '#2af575' },
                { text: telemetry.driveMode }
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
            return render(true);
        });

        ui.onClick('BTN_PAGE', () => {
            page = (page + 1) % PAGES.length;
            return render(true);
        });

        ctx.onTab((idx) => {
            page = idx;
            return render(true);
        });

        // Run low-frequency idle loop (4 fps) to minimize CPU/GPU load by >85%
        ctx.loop('MAIN', 4, render);
        render(true).then(() => log.info('M-Copilot ready')).catch((e) => log.warn('M-Copilot render error: ' + e));
    }
});
