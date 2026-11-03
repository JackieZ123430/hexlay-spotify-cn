'use strict';
/**
 * M-Copilot - AI Performance Co-Driver & Intelligent Assistant for BMW iDrive 7.
 *
 * Streamlined Architecture:
 *   1. Zero Duplicate Tabs:
 *      Single unified screen ('M-Copilot'). When unconfigured, it seamlessly displays the
 *      Setup & Pairing QR code. Once paired, it unlocks the full AI Co-Driver interface.
 *   2. Cloud Pairing (Zero 127.0.0.1 / localhost):
 *      QR Code points to https://hexlay.github.io/idrive7-custom-apps/copilot.html?channel=...
 *      Allows pairing from any smartphone over 4G/5G/Wi-Fi with free Google Gemini API Key.
 *   3. Mandatory Online Mode:
 *      Head unit verifies active vehicle uplink (cellular/hotspot). Gating screens if offline
 *      or unconfigured, preventing CPU-heavy local offline regex/NLP simulations.
 *   4. Ultra-Low CPU/GPU Adaptive Pacing:
 *      Eliminates continuous 66 fps loop in favor of 4 fps idle refresh (~250ms), dynamically
 *      switching to 25 fps (~40ms) ONLY while neural thinking animation is active.
 *   5. Vehicle Context Engine:
 *      Pours rich, safe, read-only CAN & UDS telemetry directly into Google Gemini with
 *      prompt-specific intent analysis (Launch control, Cooling, Grip, DTCs).
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { Diag } = require('./kit/diag');
const { AiBridge } = require('./ai');
const { CloudPairManager } = require('./cloud_pair');
const qrcodegen = require('./qrcodegen');

const W = 1600, H = 520;
const PAGES = ['M-Copilot'];

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

        let showPairing = false;
        let isThinking = false;
        let thinkTimer = null;
        let lastRenderTime = 0;
        let dialogueScroll = 0;

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
            showPairing = false;
            notify('AI Paired via Cloud! Gemini Ready.');
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
                showPairing = true;
                render(true).catch(() => {});
                return;
            }

            currentPrompt = title || 'Custom Query';
            dialogueScroll = 0;
            setThinking(true);
            currentResponse = 'Querying AI Co-Driver with live vehicle telemetry...';

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

        /* ---------- Helper: Text Formatting & Wrapping ---------- */
        function wrapLines(text, maxChars = 62) {
            if (!text) return [];
            // Clean markdown syntax & sanitize characters into atlas-supported glyphs
            const cleaned = text
                .replace(/\*\*(.*?)\*\*/g, '$1')   // bold asterisks removed
                .replace(/^[\*\-]\s+/gm, '- ')     // list bullet prefix to '- '
                .replace(/[•\u2022]/g, '- ')       // bullet dot to '- '
                .replace(/[≥]/g, '>=')
                .replace(/[≤]/g, '<=')
                .replace(/[✔]/g, '✓')
                .replace(/[⚠️⚠]/g, '[!]')
                .replace(/[“”]/g, '"')
                .replace(/[‘’]/g, "'")
                .replace(/\n{3,}/g, '\n\n');       // collapse excessive blank lines

            const rawLines = cleaned.split('\n');
            const lines = [];
            let lastEmpty = false;

            rawLines.forEach(rl => {
                const trimmed = rl.trim();
                if (!trimmed) {
                    if (!lastEmpty && lines.length > 0) {
                        lines.push('');
                        lastEmpty = true;
                    }
                    return;
                }
                lastEmpty = false;

                if (trimmed.length <= maxChars) {
                    lines.push(trimmed);
                } else {
                    const words = trimmed.split(' ');
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

        /* ---------- Setup Screen: Copilot Setup / Cloud Pairing ---------- */
        function drawSetupRequired(cv, t) {
            G.panel(cv, t, 40, 52, 1520, 410, 'M-Copilot Cloud Pairing & Setup');

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
            cv.roundRect(ix, 290, 380, 36, 8, withAlpha('#00a3e0', 0.15));
            cv.strokeRoundRect(ix, 290, 380, 36, 8, 1, '#00a3e0');
            cv.text('WAITING FOR PHONE PAIRING...', ix + 190, 314, 15, '#00f0ff', { align: 'center', font: 'bold' });

            // If already configured and opened via Re-pair, show Back button
            if (ai.isConfigured()) {
                const bBackX = ix, bBackY = 345, bBackW = 260, bBackH = 46;
                cv.roundRect(bBackX, bBackY, bBackW, bBackH, 10, '#004e8c');
                cv.strokeRoundRect(bBackX, bBackY, bBackW, bBackH, 10, 1.5, '#00a3e0');
                cv.text('BACK TO CO-DRIVER', bBackX + bBackW / 2, bBackY + 29, 16, '#ffffff', { align: 'center', font: 'bold' });
                cv.target(bBackX, bBackY, bBackW, bBackH, () => {
                    showPairing = false;
                    render(true);
                }, 'btn_back_copilot', 10);
            }
        }

        /* ---------- M-Copilot AI Main Screen ---------- */
        function drawMainCopilot(cv, t, now) {
            // Panel 1 (Left): AI Neural Core
            G.panel(cv, t, 40, 52, 380, 410, 'M Neural Core');

            drawNeuralOrb(cv, 230, 180, 84, now);

            // Status Badge (Interactive: displays connected provider & tap to re-pair)
            const prov = (ai.config.provider || (ai.config.mode === 'gemini' ? 'gemini' : 'custom')).toLowerCase();
            let tierLabel = 'GOOGLE GEMINI (FREE)';
            let tierCol = '#2af575';
            if (prov === 'groq') { tierLabel = 'GROQ LLAMA 3.3 (FAST)'; tierCol = '#ff6b35'; }
            else if (prov === 'claude') { tierLabel = 'ANTHROPIC CLAUDE'; tierCol = '#d97706'; }
            else if (prov === 'openai') { tierLabel = 'OPENAI GPT-4O'; tierCol = '#10a37f'; }
            else if (prov === 'openrouter') { tierLabel = 'OPENROUTER AI'; tierCol = '#6366f1'; }

            cv.roundRect(80, 280, 300, 30, 8, withAlpha(tierCol, 0.15));
            cv.strokeRoundRect(80, 280, 300, 30, 8, 1, tierCol);
            cv.text(tierLabel, 230, 300, 14, tierCol, { align: 'center', font: 'bold' });
            cv.target(80, 280, 300, 30, () => {
                showPairing = true;
                render(true);
            }, 'btn_relink', 8);

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

            // Render Response text with wrap and scroll
            const lines = wrapLines(currentResponse, 62);
            const maxVisibleLines = 11;
            const maxScroll = Math.max(0, lines.length - maxVisibleLines);
            if (dialogueScroll > maxScroll) dialogueScroll = maxScroll;

            const visible = lines.slice(dialogueScroll, dialogueScroll + maxVisibleLines);
            visible.forEach((line, idx) => {
                const ly = ry + 36 + idx * 26;
                let col = '#e2e8f0';
                let isBold = false;

                if (line.startsWith('[OK]') || line.startsWith('✓') || line.includes('PASS') || line.includes('OPTIMAL')) col = '#2af575';
                else if (line.startsWith('[!]') || line.includes('CAUTION') || line.includes('FAIL') || line.includes('Warning')) col = '#ffb703';
                else if ((line.startsWith('[') && line.endsWith(']')) || (line.startsWith('- ') && line.includes(':'))) {
                    isBold = true;
                    col = '#ffffff';
                } else if (/^\d+\./.test(line)) col = '#ffffff';

                cv.text(line, rx + 24, ly, 16, col, { font: isBold ? 'bold' : 'normal' });
            });

            // Scrollbar & Page indicator when content exceeds card
            if (lines.length > maxVisibleLines) {
                const sbX = rx + rw - 14, sbY = ry + 20, sbH = rh - 40;
                cv.roundRect(sbX, sbY, 4, sbH, 2, withAlpha(t.panelEdge, 0.4));
                const thumbH = Math.max(24, Math.floor((maxVisibleLines / lines.length) * sbH));
                const thumbY = sbY + Math.floor((dialogueScroll / maxScroll) * (sbH - thumbH));
                cv.roundRect(sbX, thumbY, 4, thumbH, 2, '#00a3e0');

                // Page badge
                const curPage = Math.floor(dialogueScroll / maxVisibleLines) + 1;
                const totPages = Math.ceil(lines.length / maxVisibleLines);
                cv.text(`PAGE ${curPage}/${totPages}`, rx + rw - 24, ry + rh - 12, 12, t.dim, { align: 'right', font: 'num' });

                // Touch targets to scroll
                cv.target(rx, ry, rw, rh / 2, () => {
                    dialogueScroll = Math.max(0, dialogueScroll - 4);
                    render(true);
                }, 'card_scroll_up', 4);

                cv.target(rx, ry + rh / 2, rw, rh / 2, () => {
                    dialogueScroll = Math.min(maxScroll, dialogueScroll + 4);
                    render(true);
                }, 'card_scroll_down', 4);
            }

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
            } else if (!ai.isConfigured() || showPairing) {
                drawSetupRequired(cv, t);
            } else {
                drawMainCopilot(cv, t, now);
            }

            // G-Series Live Cockpit frame tabs along the top: clean single title + live status badges
            const provName = (ai.config.provider || (ai.config.mode === 'gemini' ? 'gemini' : 'custom')).toUpperCase();
            G.frame(cv, t, PAGES, 0, [
                { text: telemetry.driveMode },
                { text: 'READ-ONLY SAFE', color: '#2af575' },
                { text: ai.isConfigured() ? `${provName} ONLINE` : 'SETUP REQUIRED', color: ai.isConfigured() ? '#00a3e0' : '#ffb703' }
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

        ui.onClick('BTN_REPAIR', () => {
            showPairing = !showPairing;
            return render(true);
        });

        ctx.onTab(() => {
            showPairing = false;
            return render(true);
        });

        // Run low-frequency idle loop (4 fps) to minimize CPU/GPU load by >85%
        ctx.loop('MAIN', 4, render);
        render(true).then(() => log.info('M-Copilot ready')).catch((e) => log.warn('M-Copilot render error: ' + e));
    }
});
