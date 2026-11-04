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
 *   3. 20 Technical Co-Driver Topics across 4 Categories:
 *      - Dynamics & Track (Launch, Drift/xDrive, Mountain Pass, M Brakes, Shift Speed)
 *      - Thermal & DME (Turbo Cooling, Oil Warm-Up, Intercooling, Air Flaps, Cat Warm)
 *      - Chassis & Tires (Tire Grip/PSI, Adaptive EDC Damper, Differential, Steering, Camber)
 *      - Service & Health (BMW Oil Specs, ECU Fault Scan, ZF 8HP, 12V/48V, Fuel Octane)
 *   4. Instant Auto-Prompt & On-Screen Touch Keyboard:
 *      Tapping any topic chip immediately asks M-Copilot. An in-car touch keyboard
 *      allows asking custom vehicle queries with live telemetry synthesis.
 *   5. Ultra-Low CPU/GPU Adaptive Pacing:
 *      Eliminates continuous 66 fps loop in favor of 4 fps idle refresh (~250ms), dynamically
 *      switching to 25 fps (~40ms) ONLY while neural thinking animation is active.
 *   6. Vehicle Context Engine:
 *      Pours rich, safe, read-only CAN & UDS telemetry directly into Google Gemini with
 *      prompt-specific intent analysis (Launch control, Cooling, Grip, DTCs, Brakes).
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

const TOPIC_CATEGORIES = [
    {
        id: 'dynamics',
        name: 'DYNAMICS',
        label: 'Performance & Track',
        topics: [
            { title: 'Launch Protocol', query: 'What are the launch control prerequisites and sequence for BMW G-Series ZF 8HP?' },
            { title: 'Drift & xDrive Modes', query: 'Explain 4WD Sport, 2WD rear-wheel-drive mode, DSC OFF, and MDM (M Dynamic Mode) handling characteristics.' },
            { title: 'Mountain Pass', query: 'Analyze vehicle handling, chassis balance, and sport differential for aggressive mountain twisties.' },
            { title: 'M Brakes & Fade', query: 'Analyze M Sport brake temperatures, pad bite, brake fluid boiling threshold, and thermal fade resistance.' },
            { title: 'Gearbox & Shift Speed', query: 'Explain D1-D3 and S1-S3 Drivelogic shift speeds, torque converter lockup, and manual paddle response.' }
        ]
    },
    {
        id: 'thermal',
        name: 'THERMAL',
        label: 'Thermal & DME',
        topics: [
            { title: 'Turbo Cooling', query: 'What are the turbo cooling and post-drive heat management guidelines for BMW turbocharged engines?' },
            { title: 'Oil Warm-Up & Boost', query: 'What are the exact engine oil temperature thresholds before full DME turbo boost is unlocked?' },
            { title: 'Charge Air & Cooling', query: 'Explain indirect charge air intercooling, low-temp coolant loop, and heat-soak management on hard runs.' },
            { title: 'Radiator & Air Flaps', query: 'How do the active kidney grille air flaps and auxiliary engine oil coolers manage high ambient heat?' },
            { title: 'Cold Start & Cat Warm', query: 'What occurs during BMW catalytic converter heating cycle, cold start high idle, and exhaust flap operation?' }
        ]
    },
    {
        id: 'chassis',
        name: 'CHASSIS',
        label: 'Chassis & Tires',
        topics: [
            { title: 'Tire Grip & PSI', query: 'Analyze current tire pressures, cold vs hot delta, and rubber temperature grip window.' },
            { title: 'Adaptive M Damper', query: 'Compare COMFORT, SPORT, and SPORT+ adaptive EDC damper stiffness, body roll, and rebound damping.' },
            { title: 'Sport Differential', query: 'How does the electronically controlled M rear axle limited-slip differential (GHAS) manage torque vectoring?' },
            { title: 'Steering & Agility', query: 'Analyze Servotronic variable sport steering ratio, high-speed on-center stability, and turn-in sharpness.' },
            { title: 'Wheel Alignment & Wear', query: 'What are factory negative camber and toe alignment recommendations for high-speed stability and track wear?' }
        ]
    },
    {
        id: 'care',
        name: 'CARE',
        label: 'Service & Health',
        topics: [
            { title: 'BMW Specs & Oil', query: 'What are the factory oil specifications, change intervals, and Longlife (LL-01 / LL-04 / LL-17FE+) service guidelines for BMW G-Series engines?' },
            { title: 'ECU Fault & Health', query: 'Run an OBD-II UDS diagnostic health check across DME, EGS transmission, DSC, and electrical sensors.' },
            { title: 'ZF 8HP Service', query: 'What are the transmission fluid service intervals, pan filter replacement, and adaptation resets for ZF 8HP?' },
            { title: '12V & 48V Hybrid', query: 'Analyze 12V AGM battery state of health, charging voltage, and 48V mild-hybrid regenerative braking.' },
            { title: 'Fuel Octane & Knock', query: 'Explain 98 RON / 93 AKI minimum octane requirements, ignition timing pull, and ethanol (E10/E25) compatibility.' }
        ]
    }
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

        let activeCategory = 0;
        let selectedTopicIdx = 0;
        let showKeyboard = false;
        let customQuery = '';

        let currentPrompt = TOPIC_CATEGORIES[0].topics[0].title;
        let currentResponse = 'M-Copilot ready. Select a category & topic chip or ask a custom question.';
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

        cloudPair.onUnpaired = () => {
            ai.config.geminiApiKey = null;
            ai.config.apiKey = null;
            ai.config.sessionToken = null;
            ai.config.paired = false;
            ai.saveConfig();
            cachedQr = null;
            cachedQrUrl = null;
            cloudPair.reset();
            cloudPair.startPolling();
            showPairing = true;
            notify('Phone disconnected AI. Scan QR code to re-pair.');
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

        /* ---------- On-Screen Touch Keyboard (Panel 2) ---------- */
        function drawKeyboard(cv, t, now) {
            G.panel(cv, t, 510, 52, 1050, 410, 'Ask Custom Question');

            // Live Engine Vitals in header
            cv.text(`${telemetry.oilTemp}°C OIL  ·  ${telemetry.coolantTemp}°C COOLANT  ·  ${telemetry.batteryVoltage}V`, 1530, 80, 13, t.dim, { align: 'right', font: 'num' });

            const kx = 540, kw = 990;

            // 1. Query Input Display Box
            const qBoxY = 104, qBoxH = 46;
            cv.roundRect(kx, qBoxY, kw, qBoxH, 8, '#080d14');
            cv.strokeRoundRect(kx, qBoxY, kw, qBoxH, 8, 1.5, '#00a3e0');

            const hasText = !!customQuery.trim();
            const displayText = hasText ? (customQuery + '_') : 'Type your question with touch keyboard or tap a preset below...';
            cv.text(displayText, kx + 18, qBoxY + 30, 15, hasText ? '#ffffff' : '#64748b', { font: hasText ? 'bold' : 'normal' });

            // Clear button inside input bar
            if (hasText) {
                const clrW = 70, clrH = 32, clrX = kx + kw - 78, clrY = qBoxY + 7;
                cv.roundRect(clrX, clrY, clrW, clrH, 6, withAlpha('#e1001a', 0.22));
                cv.strokeRoundRect(clrX, clrY, clrW, clrH, 6, 1, '#e1001a');
                cv.text('CLEAR', clrX + clrW / 2, clrY + 21, 12, '#ff6b6b', { align: 'center', font: 'bold' });
                cv.target(clrX, clrY, clrW, clrH, () => {
                    customQuery = '';
                    render(true);
                }, 'kb_btn_clear', 8);
            }

            // 2. Quick Preset Chips Row
            const presetY = 158, presetH = 26;
            const presets = [
                'What is my boost?',
                'Brake pad health',
                'Cold start high idle',
                'Recommended oil spec',
                'Scan active fault codes'
            ];
            let px = kx;
            presets.forEach((pr, pIdx) => {
                const pw = pr.length * 8 + 20;
                cv.roundRect(px, presetY, pw, presetH, 13, '#101a28');
                cv.strokeRoundRect(px, presetY, pw, presetH, 13, 1, '#1e324c');
                cv.text(pr, px + pw / 2, presetY + 17, 12, '#cbd5e1', { align: 'center' });
                cv.target(px, presetY, pw, presetH, () => {
                    customQuery = pr;
                    render(true);
                }, 'kb_preset_' + pIdx, 6);
                px += pw + 10;
            });

            // 3. Speller Keyboard Key Rows
            const kbY = 194;
            const keyH = 38;
            const keyGap = 6;

            const rows = [
                ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '?'],
                ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
                ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
                ['Z', 'X', 'C', 'V', 'B', 'N', 'M', '.', ',']
            ];

            rows.forEach((row, rIdx) => {
                const ry = kbY + rIdx * (keyH + keyGap);
                const count = row.length;
                const keyW = Math.floor((kw - (count - 1) * keyGap) / count);

                row.forEach((k, cIdx) => {
                    const kxPos = kx + cIdx * (keyW + keyGap);
                    cv.roundRect(kxPos, ry, keyW, keyH, 6, '#0f1724');
                    cv.strokeRoundRect(kxPos, ry, keyW, keyH, 6, 1, '#1e2d42');
                    cv.text(k, kxPos + keyW / 2, ry + 25, 16, '#ffffff', { align: 'center', font: 'bold' });

                    cv.target(kxPos, ry, keyW, keyH, () => {
                        customQuery += k;
                        render(true);
                    }, 'kb_k_' + rIdx + '_' + cIdx, 6);
                });
            });

            // 4. Action Row (Row 5)
            const aY = kbY + 4 * (keyH + keyGap);
            const aH = 42;

            // Cancel button
            const canW = 140, canX = kx;
            cv.roundRect(canX, aY, canW, aH, 8, '#141f2e');
            cv.strokeRoundRect(canX, aY, canW, aH, 8, 1, '#253347');
            cv.text('CANCEL', canX + canW / 2, aY + 27, 14, '#94a3b8', { align: 'center', font: 'bold' });
            cv.target(canX, aY, canW, aH, () => {
                showKeyboard = false;
                render(true);
            }, 'kb_act_cancel', 8);

            // Spacebar
            const spW = 410, spX = canX + canW + keyGap;
            cv.roundRect(spX, aY, spW, aH, 8, '#0f1724');
            cv.strokeRoundRect(spX, aY, spW, aH, 8, 1, '#1e2d42');
            cv.text('SPACEBAR', spX + spW / 2, aY + 27, 14, '#cbd5e1', { align: 'center', font: 'bold' });
            cv.target(spX, aY, spW, aH, () => {
                customQuery += ' ';
                render(true);
            }, 'kb_act_space', 8);

            // Backspace / Del
            const delW = 150, delX = spX + spW + keyGap;
            cv.roundRect(delX, aY, delW, aH, 8, '#1f1418');
            cv.strokeRoundRect(delX, aY, delW, aH, 8, 1, '#421a22');
            cv.text('BACKSPACE', delX + delW / 2, aY + 27, 13, '#ff8080', { align: 'center', font: 'bold' });
            cv.target(delX, aY, delW, aH, () => {
                customQuery = customQuery.slice(0, -1);
                render(true);
            }, 'kb_act_del', 8);

            // Ask Copilot / Submit
            const askW = 270, askX = delX + delW + keyGap;
            cv.roundRect(askX, aY, askW, aH, 8, hasText ? '#00a3e0' : '#1e293b');
            if (hasText) cv.strokeRoundRect(askX, aY, askW, aH, 8, 1.5, '#00f0ff');
            cv.text('ASK M-COPILOT >', askX + askW / 2, aY + 27, 15, hasText ? '#ffffff' : '#64748b', { align: 'center', font: 'bold', spacing: 1 });
            cv.target(askX, aY, askW, aH, () => {
                if (hasText) {
                    const q = customQuery.trim();
                    customQuery = '';
                    showKeyboard = false;
                    askCopilot(q, 'Custom: ' + (q.length > 25 ? q.slice(0, 25) + '...' : q));
                }
            }, 'kb_act_go', 10);
        }

        /* ---------- M-Copilot AI Main Screen (2-Panel Wide Architecture) ---------- */
        function drawMainCopilot(cv, t, now) {
            const curCat = TOPIC_CATEGORIES[activeCategory] || TOPIC_CATEGORIES[0];
            const topics = curCat.topics;

            // Panel 1 (Left): Quick Topics & Custom Query Action (No header text)
            G.panel(cv, t, 40, 52, 440, 410, '');

            // Category Selector Tabs Bar (Moved up to y=66)
            const tabY = 66, tabH = 28;
            TOPIC_CATEGORIES.forEach((cat, cIdx) => {
                const tabW = 96;
                const tabX = 60 + cIdx * 101;
                const isCurCat = activeCategory === cIdx;

                cv.roundRect(tabX, tabY, tabW, tabH, 6, isCurCat ? '#004e8c' : t.track);
                cv.strokeRoundRect(tabX, tabY, tabW, tabH, 6, 1, isCurCat ? '#00a3e0' : t.panelEdge);
                cv.text(cat.name, tabX + tabW / 2, tabY + 19, 11, isCurCat ? '#00f0ff' : '#94a3b8', { align: 'center', font: isCurCat ? 'bold' : 'normal' });

                cv.target(tabX, tabY, tabW, tabH, () => {
                    activeCategory = cIdx;
                    selectedTopicIdx = 0;
                    currentPrompt = cat.topics[0].title;
                    render(true);
                }, 'cat_' + cIdx, 6);
            });

            // 5 Topic Chips for selected category (Moved up to y=104, auto-sends prompt on click)
            topics.forEach((p, idx) => {
                const py = 104 + idx * 42;
                const isSelected = selectedTopicIdx === idx;
                const isCur = currentPrompt === p.title;

                cv.roundRect(60, py, 400, 36, 8, isSelected ? withAlpha('#00a3e0', 0.22) : t.track);
                cv.strokeRoundRect(60, py, 400, 36, 8, isSelected ? 1.5 : 1, isSelected ? '#00a3e0' : t.panelEdge);

                cv.circle(80, py + 18, 4.5, isCur ? '#00f0ff' : (isSelected ? '#00a3e0' : t.dim));
                cv.text(p.title, 98, py + 23, 14, isSelected ? '#ffffff' : '#cbd5e1', { font: isSelected ? 'bold' : 'normal' });

                // Auto-sends prompt immediately upon clicking topic chip
                cv.target(60, py, 400, 36, () => {
                    selectedTopicIdx = idx;
                    showKeyboard = false;
                    askCopilot(p.query, p.title);
                }, 'chip_' + idx, 8);
            });

            // Custom Text Input Button (Replaces redundant Ask button, opens on-screen keyboard)
            const inputW = 400, inputH = 44, inputX = 60, inputY = 320;
            cv.roundRect(inputX, inputY, inputW, inputH, 8, showKeyboard ? withAlpha('#00a3e0', 0.25) : '#0b111a');
            cv.strokeRoundRect(inputX, inputY, inputW, inputH, 8, showKeyboard ? 1.5 : 1, showKeyboard ? '#00f0ff' : '#1e2d42');

            const hasCustom = !!customQuery.trim();
            const inputLabel = hasCustom ? (customQuery + (showKeyboard ? '_' : '')) : (showKeyboard ? 'Typing custom question..._' : 'Ask Custom Question...');
            cv.text(inputLabel, inputX + 16, inputY + 27, 14, hasCustom ? '#ffffff' : (showKeyboard ? '#00f0ff' : '#94a3b8'), { font: (hasCustom || showKeyboard) ? 'bold' : 'normal' });
            cv.target(inputX, inputY, inputW, inputH, () => {
                showKeyboard = !showKeyboard;
                render(true);
            }, 'btn_custom_input', 10);

            // Dynamic Pair vs Unpair/Re-pair Button
            const isPaired = ai.isConfigured();
            const pairW = 400, pairH = 40, pairX = 60, pairY = 376;
            const pairBg = isPaired ? withAlpha('#e1001a', 0.12) : withAlpha('#00a3e0', 0.12);
            const pairBorder = isPaired ? '#e1001a' : '#00a3e0';
            const pairTextCol = isPaired ? '#ff6b6b' : '#00a3e0';
            const pairLabel = isPaired ? 'UNPAIR / RE-PAIR' : 'PAIR PHONE / QR CODE';

            cv.roundRect(pairX, pairY, pairW, pairH, 8, pairBg);
            cv.strokeRoundRect(pairX, pairY, pairW, pairH, 8, 1.5, pairBorder);
            cv.text(pairLabel, pairX + pairW / 2, pairY + 25, 14, pairTextCol, { align: 'center', font: 'bold', spacing: 1 });
            cv.target(pairX, pairY, pairW, pairH, () => {
                if (isPaired) {
                    cloudPair.notifyUnpair();
                    ai.config.geminiApiKey = null;
                    ai.config.apiKey = null;
                    ai.config.sessionToken = null;
                    ai.config.paired = false;
                    ai.saveConfig();
                    cachedQr = null;
                    cachedQrUrl = null;
                    cloudPair.reset();
                    cloudPair.startPolling();
                    showPairing = true;
                    notify('AI Unpaired. Scan QR code to re-pair.');
                } else {
                    showPairing = true;
                }
                render(true);
            }, 'btn_pair_unpair', 8);

            // Panel 2 (Right): Interactive Touch Keyboard OR Dialogue Stream
            if (showKeyboard) {
                drawKeyboard(cv, t, now);
                return;
            }

            G.panel(cv, t, 510, 52, 1050, 410, 'Dialogue: ' + currentPrompt);

            // Live Engine Vitals in header
            cv.text(`${telemetry.oilTemp}°C OIL  ·  ${telemetry.coolantTemp}°C COOLANT  ·  ${telemetry.batteryVoltage}V`, 1530, 80, 13, t.dim, { align: 'right', font: 'num' });

            // Response Box Card
            const rx = 530, ry = 104, rw = 1010, rh = 340;
            cv.roundRect(rx, ry, rw, rh, 12, '#090e15');
            cv.strokeRoundRect(rx, ry, rw, rh, 12, 1, t.panelEdge);

            // Left decorative M stripe on response card
            cv.fillRect(rx + 2, ry + 12, 4, rh - 24, '#00a3e0');

            // Render Response text with wrap and scroll
            const lines = wrapLines(currentResponse, 88);
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
            if (showKeyboard && customQuery.trim()) {
                const q = customQuery.trim();
                customQuery = '';
                showKeyboard = false;
                askCopilot(q, 'Custom: ' + (q.length > 25 ? q.slice(0, 25) + '...' : q));
            } else {
                const currentCat = TOPIC_CATEGORIES[activeCategory] || TOPIC_CATEGORIES[0];
                const currentTopic = currentCat.topics[selectedTopicIdx] || currentCat.topics[0];
                askCopilot(currentTopic.query, currentTopic.title);
            }
            return render(true);
        });

        ui.onClick('BTN_REPAIR', () => {
            showPairing = !showPairing;
            showKeyboard = false;
            return render(true);
        });

        ctx.onTab(() => {
            showPairing = false;
            showKeyboard = false;
            return render(true);
        });

        // Run low-frequency idle loop (4 fps) to minimize CPU/GPU load by >85%
        ctx.loop('MAIN', 4, render);
        render(true).then(() => log.info('M-Copilot ready')).catch((e) => log.warn('M-Copilot render error: ' + e));
    }
});
