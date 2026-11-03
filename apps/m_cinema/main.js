'use strict';
/**
 * M-Cinema - Native BMW iDrive 7 (MGU) YouTube Cockpit Theater & Video Cast.
 * Styled after BMW ConnectedDrive & Live Cockpit Professional design language.
 *
 * Capabilities:
 *   1. In-Car YouTube Search:
 *      Search YouTube videos directly from the iDrive 7 central display using an
 *      on-screen BMW speller keyboard, category chips, and live results list.
 *   2. Official YouTube App TV Casting ("Link with TV code"):
 *      Pairs with the official YouTube mobile app on iPhone & Android via Google's
 *      Lounge on TV protocol (Settings > Watch on TV > Link with TV code).
 *   3. Zero-127.0.0.1 Cloud Relay & Mobile Remote:
 *      QR code connects to https://hexlay.github.io/idrive7-custom-apps/cinema.html
 *      for instant 1-tap paste & cast over 4G, 5G, or Wi-Fi.
 *   4. Real YouTube Thumbnail Decoder:
 *      Downloads and renders high-resolution video artwork directly onto the cockpit canvas.
 *   5. Intel Atom A3960 Hardware Thermal Safe Cap:
 *      Clamps streams to 720p or 1080p 60 to protect head unit CPU/GPU.
 *
 * Pages:
 *   0: Now Playing - 21:9 Widescreen player with live ambient accent
 *   1: Search - In-car YouTube search, speller keyboard & video results
 *   2: Connect - YouTube TV Link Code & Smartphone QR remote
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { CastServer } = require('./server');
const { CloudCastManager, parseYouTubeId } = require('./cloud_cast');
const { YouTubeSearchEngine } = require('./youtube_search');
const { YouTubeLoungeReceiver } = require('./lounge');
const { YouTubeThumbnailManager, THUMB_IMG_ID } = require('./thumbnail');
const qrcodegen = require('./qrcodegen');

const W = 1600, H = 520;
const PAGES = ['Now Playing', 'Search', 'Connect'];

// String truncation with clean ellipsis
function trunc(str, maxLen) {
    if (!str || typeof str !== 'string') return '';
    return str.length > maxLen ? str.slice(0, maxLen - 1) + '..' : str;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log, signals } = ctx;

        let page = 0;
        let isPlaying = true;
        let playProgress = 0.25;
        let isFullscreen = false;
        let vehicleSpeed = 0;
        let statusMsg = null;
        let statusTime = 0;

        // In-Car Search State
        let searchQuery = '';
        let searchScroll = 0;
        const searchEngine = new YouTubeSearchEngine(log);
        let searchResults = searchEngine.getFeatured();

        // Active YouTube video
        let activeCastVideo = {
            title: 'Ready to Cast',
            channel: 'YouTube Receiver',
            duration: '00:00',
            quality: (settings.quality === '1080p') ? '1080p 60' : '720p 60',
            glow: '#0066b1',
            views: 'Connected',
            desc: 'Search YouTube directly from iDrive in Search tab or link phone in Connect tab.',
            ytId: null,
            url: null,
            thumbnail: null
        };

        // Monitor vehicle speed for safety
        try {
            const Car = require('./kit/car');
            const car = new Car(ctx, ['speed']);
            car.onSample((data) => {
                if (data.speed !== undefined) vehicleSpeed = Math.round(data.speed);
            });
        } catch (e) {
            log.warn('M-Cinema: Speed monitor fallback: ' + e.message);
        }

        function notify(msg) {
            statusMsg = msg;
            statusTime = Date.now();
            log.info('M-Cinema: ' + msg);
        }

        /* ---------- Helper: Text Formatting & Wrapping ---------- */
        function wrapLines(text, maxChars = 42) {
            if (!text) return [];
            const rawLines = text.split('\n');
            const lines = [];
            rawLines.forEach(rl => {
                const words = rl.split(' ');
                let cur = '';
                words.forEach(w => {
                    if ((cur ? cur + ' ' + w : w).length <= maxChars) {
                        cur = cur ? cur + ' ' + w : w;
                    } else {
                        if (cur) lines.push(cur);
                        cur = w;
                    }
                });
                if (cur) lines.push(cur);
            });
            return lines;
        }

        // Initialize Thumbnail Manager
        const thumbnailManager = new YouTubeThumbnailManager(log, () => {
            render().catch(() => {});
        });

        // Common handler for playing any video (cast or searched)
        function playVideo(video) {
            if (settings.quality === '720p') {
                video.quality = '720p 60';
            }
            activeCastVideo = video;
            page = 0; // jump directly to Now Playing
            isPlaying = true;
            playProgress = 0;

            if (video.ytId || video.thumbnail) {
                thumbnailManager.load(video.ytId, video.thumbnail);
            }

            notify('Playing: ' + video.title);
            render().catch(() => {});
        }

        // Initialize Official YouTube on TV Lounge Receiver
        const loungeReceiver = new YouTubeLoungeReceiver({
            onCast(video) {
                playVideo(video);
            }
        }, log);
        loungeReceiver.start().catch((e) => log.warn('Lounge start err: ' + e.message));

        // Initialize Cloud Cast Relay
        const cloudCast = new CloudCastManager(ctx, {
            onCast(video) {
                playVideo(video);
            },
            onControl(cmd, val) {
                if (cmd === 'toggle') isPlaying = !isPlaying;
                else if (cmd === 'play') isPlaying = true;
                else if (cmd === 'pause') isPlaying = false;
                else if (cmd === 'fullscreen') isFullscreen = !isFullscreen;
                else if (cmd === 'seek') {
                    playProgress = Math.max(0, Math.min(1, playProgress + (val || 0) * 0.02));
                }
                render().catch(() => {});
            }
        });
        cloudCast.startPolling();

        // Initialize Local In-Car Fallback Server
        const castServer = new CastServer({
            onCast(video) {
                playVideo(video);
            },
            onControl(action, val) {
                if (action === 'toggle') isPlaying = !isPlaying;
                else if (action === 'fullscreen') isFullscreen = !isFullscreen;
                else if (action === 'seek') playProgress = Math.max(0, Math.min(1, playProgress + (val || 0) * 0.02));
                render().catch(() => {});
            }
        }, log);
        castServer.setCloudUrl(cloudCast.getCastUrl());
        castServer.start();

        /* ---------- QR Code for Smartphone Cloud Cast ---------- */
        let cachedQr = null;
        let cachedQrUrl = null;
        function getCastQr() {
            const url = cloudCast.getCastUrl();
            if (cachedQr && cachedQrUrl === url) return cachedQr;
            try {
                const qr = qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.MEDIUM);
                cachedQr = qr;
                cachedQrUrl = url;
                return cachedQr;
            } catch (e) {
                return null;
            }
        }

        /* ---------- Vector Play Icon ---------- */
        function drawPlayGlyph(cv, cx, cy, sz, col) {
            const hw = sz * 0.46, hh = sz * 0.52;
            const p0 = [cx - hw * 0.6, cy - hh];
            const p1 = [cx + hw * 1.1, cy];
            const p2 = [cx - hw * 0.6, cy + hh];
            if (cv.triangle) cv.triangle([p0, p1, p2], col);
            else cv.quad([p0, p1, p2, p2], col);
        }

        /* ---------- Execute In-Car Search ---------- */
        async function runInCarSearch(query) {
            if (!query || !query.trim()) return;
            searchQuery = query.trim();
            notify('Searching YouTube: ' + searchQuery);
            render().catch(() => {});

            try {
                const list = await searchEngine.search(searchQuery);
                if (list && list.length > 0) {
                    searchResults = list;
                    searchScroll = 0;
                    notify(`Found ${list.length} videos`);
                } else {
                    notify('No videos found for: ' + searchQuery);
                }
            } catch (e) {
                notify('Search error: ' + e.message);
            }
            render().catch(() => {});
        }

        /* ---------- Page 0: Now Playing (OEM BMW Media Layout) ---------- */
        function drawPlayer(cv, t, now) {
            const video = activeCastVideo;
            const isParked = vehicleSpeed === 0;
            const interlock = settings.interlock || 'auto';
            const motionLocked = !isParked && interlock === 'strict';

            if (isFullscreen) {
                drawVideoScreen(cv, 0, 0, W, H, video, true, now, motionLocked);
                return;
            }

            // Left / Main Media Viewport (1040 x 410)
            G.panel(cv, t, 40, 52, 1040, 410, 'Video Display');

            const vx = 64, vy = 114, vw = 992, vh = 280;

            if (settings.ambilight !== 'off' && !motionLocked) {
                cv.roundRect(vx - 2, vy - 2, vw + 4, vh + 4, 12, withAlpha('#0066b1', 0.25));
            }

            drawVideoScreen(cv, vx, vy, vw, vh, video, false, now, motionLocked);

            // Scrubber Bar
            const sy = 405, sw = 992;
            cv.roundRect(vx, sy, sw, 6, 3, t.track);
            cv.roundRect(vx, sy, Math.floor(sw * playProgress), 6, 3, '#0066b1');
            cv.circle(vx + Math.floor(sw * playProgress), sy + 3, 6, '#ffffff');

            cv.target(vx, sy - 10, sw, 28, (x) => {
                const rel = Math.max(0, Math.min(1, (x - vx) / sw));
                playProgress = rel;
                notify(`Seek: ${Math.floor(rel * 100)}%`);
            }, 'scrub', 8);

            cv.text('02:15 / ' + (video.duration || '00:00'), vx, 442, 15, t.dim, { font: 'num' });
            cv.text(video.quality, vx + 160, 442, 13, '#00a3e0', { font: 'bold' });
            cv.text(isPlaying ? 'PLAYING' : 'PAUSED', vx + sw - 120, 442, 15, isPlaying ? '#2af575' : '#ffb703', { font: 'bold', align: 'right' });

            // Right Panel (460px): Track Info & Controls
            G.panel(cv, t, 1100, 52, 460, 410, 'Track Info');

            cv.roundRect(1124, 114, 96, 24, 4, '#131e2d');
            cv.strokeRoundRect(1124, 114, 96, 24, 4, 1, '#1e324c');
            cv.text('YOUTUBE', 1172, 131, 11, '#00a3e0', { align: 'center', font: 'bold', spacing: 1 });

            const titleText = trunc(video.title || 'Ready to Cast', 32);
            cv.text(titleText, 1124, 168, 20, '#ffffff', { font: 'bold' });
            cv.text(video.channel || 'YouTube Receiver', 1124, 196, 16, '#00a3e0', { font: 'bold' });
            cv.text(video.views || 'Ready', 1124, 220, 14, t.dim);

            const descBoxX = 1124, descBoxY = 236, descBoxW = 412, descBoxH = 76;
            cv.roundRect(descBoxX, descBoxY, descBoxW, descBoxH, 8, '#080d15');
            cv.strokeRoundRect(descBoxX, descBoxY, descBoxW, descBoxH, 8, 1, t.panelEdge);

            const descLines = wrapLines(video.desc, 44);
            descLines.slice(0, 2).forEach((line, idx) => {
                cv.text(line, descBoxX + 14, descBoxY + 28 + idx * 22, 13, '#94a3b8');
            });

            // Transport Buttons
            const btnW = 196, btnH = 44;
            cv.roundRect(1124, 326, btnW, btnH, 8, isPlaying ? '#162233' : '#0066b1');
            cv.strokeRoundRect(1124, 326, btnW, btnH, 8, 1, isPlaying ? '#23364f' : '#00a3e0');
            cv.text(isPlaying ? 'PAUSE' : 'PLAY', 1124 + btnW / 2, 353, 16, '#ffffff', { align: 'center', font: 'bold' });
            cv.target(1124, 326, btnW, btnH, () => {
                isPlaying = !isPlaying;
                notify(isPlaying ? 'Resumed' : 'Paused');
            }, 'btn_play_toggle', 10);

            cv.roundRect(1340, 326, btnW, btnH, 8, '#162233');
            cv.strokeRoundRect(1340, 326, btnW, btnH, 8, 1, '#23364f');
            cv.text('21:9 WIDESCREEN', 1340 + btnW / 2, 353, 15, '#ffffff', { align: 'center', font: 'bold' });
            cv.target(1340, 326, btnW, btnH, () => {
                isFullscreen = !isFullscreen;
                notify(isFullscreen ? '21:9 Fullscreen' : 'Standard View');
            }, 'btn_fs_toggle', 10);

            // In-Car Search Tab Shortcut
            cv.roundRect(1124, 384, 412, 44, 8, '#0f1724');
            cv.strokeRoundRect(1124, 384, 412, 44, 8, 1, '#0066b1');
            cv.text('SEARCH YOUTUBE IN IDRIVE  >', 1124 + 206, 411, 14, '#00f0ff', { align: 'center', font: 'bold' });
            cv.target(1124, 384, 412, 44, () => {
                page = 1;
            }, 'btn_go_search', 10);
        }

        /* ---------- Video Screen Canvas Renderer ---------- */
        function drawVideoScreen(cv, x, y, w, h, video, isFs, now, motionLocked) {
            cv.roundRect(x, y, w, h, isFs ? 0 : 8, '#06090e');
            if (!isFs) cv.strokeRoundRect(x, y, w, h, 8, 1, '#1a2536');

            if (motionLocked) {
                cv.roundRect(x + 40, y + 40, w - 80, h - 80, 12, '#0c121c');
                cv.strokeRoundRect(x + 40, y + 40, w - 80, h - 80, 12, 1.5, '#e1001a');
                cv.text('[!] VIDEO LOCKED WHILE IN MOTION', x + w / 2, y + h / 2 - 16, 22, '#e1001a', { align: 'center', font: 'bold' });
                cv.text('Audio continues. Park vehicle to resume video playback (' + vehicleSpeed + ' km/h).', x + w / 2, y + h / 2 + 18, 15, '#cbd5e1', { align: 'center' });
                return;
            }

            const cx = x + w / 2;
            const cy = y + h / 2;

            if (thumbnailManager.hasThumbnail) {
                cv.image(THUMB_IMG_ID, x, y, w, h);
                cv.fillRect(x, y, w, 44, withAlpha('#000000', 0.65));
                cv.fillRect(x, y + h - 44, w, 44, withAlpha('#000000', 0.65));
                cv.text(trunc(video.title, 48), x + 20, y + 28, 14, '#ffffff', { font: 'bold' });
            } else {
                cv.fillRect(x, y, w, h, '#070b12');
                cv.circle(cx, cy - 14, 40, '#0e1724');
                cv.arc(cx, cy - 14, 38.5, 40, 0, 360, '#1e2d42');
                drawPlayGlyph(cv, cx + 3, cy - 14, 24, '#00a3e0');

                cv.text('Waiting for YouTube Stream', cx, cy + 48, 16, '#cbd5e1', { align: 'center', font: 'bold' });
                cv.text('Search in iDrive or cast from phone YouTube app', cx, cy + 72, 13, '#64748b', { align: 'center' });
            }

            if (!isPlaying && thumbnailManager.hasThumbnail) {
                cv.circle(cx, cy, 38, withAlpha('#000000', 0.7));
                cv.arc(cx, cy, 36.5, 38, 0, 360, '#00a3e0');
                drawPlayGlyph(cv, cx + 3, cy, 22, '#ffffff');
            }

            cv.target(x, y, w, h, () => {
                if (isFs) isFullscreen = false;
                else isPlaying = !isPlaying;
            }, 'vid_screen', 10);
        }

        /* ---------- Page 1: In-Car YouTube Search & Speller ---------- */
        function drawSearch(cv, t) {
            // Left Panel (1040px): Search Query & Speller Keyboard
            G.panel(cv, t, 40, 52, 1040, 410, 'Search YouTube in iDrive');

            const sx = 64, sy = 106, sw = 992;

            // Search Bar Input Box
            cv.roundRect(sx, sy, sw - 120, 42, 8, '#080d15');
            cv.strokeRoundRect(sx, sy, sw - 120, 42, 8, 1, searchQuery ? '#0066b1' : '#1e2d42');

            const displayQuery = searchQuery ? searchQuery : 'Type with keyboard below or tap a category...';
            cv.text(displayQuery, sx + 16, sy + 27, 16, searchQuery ? '#ffffff' : '#64748b', { font: searchQuery ? 'bold' : 'normal' });

            // Clear Button [ X ]
            if (searchQuery) {
                cv.roundRect(sx + sw - 165, sy + 7, 34, 28, 6, '#131e2d');
                cv.text('X', sx + sw - 148, sy + 26, 14, '#cbd5e1', { align: 'center', font: 'bold' });
                cv.target(sx + sw - 165, sy + 7, 34, 28, () => {
                    searchQuery = '';
                    render().catch(() => {});
                }, 'btn_clear_q', 10);
            }

            // Search Trigger Button [ SEARCH ]
            cv.roundRect(sx + sw - 110, sy, 110, 42, 8, '#0066b1');
            cv.text('SEARCH', sx + sw - 55, sy + 26, 15, '#ffffff', { align: 'center', font: 'bold' });
            cv.target(sx + sw - 110, sy, 110, 42, () => {
                runInCarSearch(searchQuery);
            }, 'btn_do_search', 10);

            // Category Chips Row (1-Tap Search)
            const chips = ['BMW M3', 'Nürburgring', 'Car Reviews', 'Drag Race', 'Top Gear', 'Lofi Drive'];
            let chipX = sx;
            chips.forEach((ch, idx) => {
                const cW = 152;
                cv.roundRect(chipX, sy + 54, cW, 32, 6, '#101a28');
                cv.strokeRoundRect(chipX, sy + 54, cW, 32, 6, 1, '#1e2e44');
                cv.text(ch, chipX + cW / 2, sy + 75, 13, '#00a3e0', { align: 'center', font: 'bold' });
                cv.target(chipX, sy + 54, cW, 32, () => {
                    searchQuery = ch;
                    runInCarSearch(ch);
                }, 'chip_' + idx, 10);
                chipX += cW + 16;
            });

            // On-Screen Speller Keyboard (QWERTY + Numbers)
            const kbY = sy + 102;
            const r1 = ['Q','W','E','R','T','Y','U','I','O','P','1','2','3'];
            const r2 = ['A','S','D','F','G','H','J','K','L','4','5','6'];
            const r3 = ['Z','X','C','V','B','N','M','7','8','9','0'];

            function drawKeyRow(row, startX, y, keyW, keyH, gap) {
                row.forEach((k, idx) => {
                    const kx = startX + idx * (keyW + gap);
                    cv.roundRect(kx, y, keyW, keyH, 6, '#0e1724');
                    cv.strokeRoundRect(kx, y, keyW, keyH, 6, 1, '#1a2738');
                    cv.text(k, kx + keyW / 2, y + 25, 16, '#cbd5e1', { align: 'center', font: 'bold' });
                    cv.target(kx, y, keyW, keyH, () => {
                        searchQuery += k;
                        render().catch(() => {});
                    }, 'k_' + k, 8);
                });
            }

            drawKeyRow(r1, sx, kbY, 68, 38, 9);
            drawKeyRow(r2, sx + 20, kbY + 46, 68, 38, 9);
            drawKeyRow(r3, sx + 40, kbY + 92, 68, 38, 9);

            // Bottom Speller Actions (Space, Backspace, Search)
            const bSpaceW = 420, bSpaceX = sx + 180, bSpaceY = kbY + 140;
            cv.roundRect(bSpaceX, bSpaceY, bSpaceW, 38, 6, '#131e2d');
            cv.strokeRoundRect(bSpaceX, bSpaceY, bSpaceW, 38, 6, 1, '#1f3047');
            cv.text('SPACE', bSpaceX + bSpaceW / 2, bSpaceY + 24, 14, '#cbd5e1', { align: 'center', font: 'bold' });
            cv.target(bSpaceX, bSpaceY, bSpaceW, 38, () => {
                searchQuery += ' ';
                render().catch(() => {});
            }, 'k_space', 10);

            // Backspace Key
            const bBspX = bSpaceX + bSpaceW + 14, bBspW = 160;
            cv.roundRect(bBspX, bSpaceY, bBspW, 38, 6, '#16202e');
            cv.strokeRoundRect(bBspX, bSpaceY, bBspW, 38, 6, 1, '#25354c');
            cv.text('⌫ BACK', bBspX + bBspW / 2, bSpaceY + 24, 14, '#ff4d4d', { align: 'center', font: 'bold' });
            cv.target(bBspX, bSpaceY, bBspW, 38, () => {
                if (searchQuery.length > 0) {
                    searchQuery = searchQuery.slice(0, -1);
                    render().catch(() => {});
                }
            }, 'k_bsp', 10);

            // Right Panel (460px): Search Results List
            G.panel(cv, t, 1100, 52, 460, 410, 'Results (Tap to Play)');

            if (searchEngine.isSearching) {
                cv.text('Searching YouTube...', 1330, 240, 16, '#00a3e0', { align: 'center', font: 'bold' });
                return;
            }

            if (!searchResults || searchResults.length === 0) {
                cv.text('No results found.', 1330, 220, 15, '#94a3b8', { align: 'center' });
                cv.text('Try another query above.', 1330, 246, 13, t.dim, { align: 'center' });
                return;
            }

            // Render up to 4 results
            const visibleCount = 4;
            const items = searchResults.slice(searchScroll, searchScroll + visibleCount);
            let itemY = 110;

            items.forEach((item, idx) => {
                const itemH = 68;
                cv.roundRect(1124, itemY, 412, itemH, 8, '#080d15');
                cv.strokeRoundRect(1124, itemY, 412, itemH, 8, 1, '#182436');

                // Mini thumbnail container
                cv.roundRect(1132, itemY + 8, 86, 52, 4, '#000000');
                drawPlayGlyph(cv, 1175, itemY + 34, 16, '#0066b1');

                // Title & Details
                cv.text(trunc(item.title, 30), 1228, itemY + 26, 14, '#ffffff', { font: 'bold' });
                cv.text(trunc(item.channel, 20) + ' · ' + (item.duration || ''), 1228, itemY + 48, 12, '#94a3b8');

                // Tap Target to play immediately
                cv.target(1124, itemY, 412, itemH, () => {
                    playVideo({
                        ytId: item.id,
                        title: item.title,
                        channel: item.channel,
                        duration: item.duration,
                        views: item.views,
                        quality: (settings.quality === '1080p') ? '1080p 60' : '720p 60',
                        glow: '#0066b1',
                        desc: item.url,
                        url: item.url,
                        thumbnail: item.thumbnail
                    });
                }, 'res_' + (searchScroll + idx), 10);

                itemY += itemH + 8;
            });

            // Scroll Buttons if more results
            if (searchResults.length > visibleCount) {
                const bScrollY = 416;
                if (searchScroll > 0) {
                    cv.roundRect(1124, bScrollY, 196, 32, 6, '#101a28');
                    cv.text('▲ PREVIOUS', 1222, bScrollY + 21, 13, '#00a3e0', { align: 'center', font: 'bold' });
                    cv.target(1124, bScrollY, 196, 32, () => {
                        searchScroll = Math.max(0, searchScroll - visibleCount);
                        render().catch(() => {});
                    }, 'btn_res_prev', 10);
                }
                if (searchScroll + visibleCount < searchResults.length) {
                    cv.roundRect(1340, bScrollY, 196, 32, 6, '#101a28');
                    cv.text('▼ MORE RESULTS', 1438, bScrollY + 21, 13, '#00a3e0', { align: 'center', font: 'bold' });
                    cv.target(1340, bScrollY, 196, 32, () => {
                        searchScroll = Math.min(searchResults.length - visibleCount, searchScroll + visibleCount);
                        render().catch(() => {});
                    }, 'btn_res_next', 10);
                }
            }
        }

        /* ---------- Page 2: Connect (Official YouTube TV Code & QR) ---------- */
        function drawConnect(cv, t) {
            // Left Panel (740px): Official YouTube on TV "Link with TV Code"
            G.panel(cv, t, 40, 52, 740, 410, 'Official YouTube App (Link with TV Code)');

            const lx = 64, ly = 114;

            // 12-Digit TV Code Card
            cv.roundRect(lx, ly, 692, 92, 10, '#090e15');
            cv.strokeRoundRect(lx, ly, 692, 92, 10, 1.5, '#0066b1');

            cv.text('YOUTUBE TV PAIRING CODE', lx + 24, ly + 32, 13, '#00a3e0', { font: 'bold', spacing: 1 });
            cv.text(loungeReceiver.getPairingCode(), lx + 24, ly + 68, 28, '#00f0ff', { font: 'num' });

            // Instructions to pair official YouTube mobile app
            cv.roundRect(lx, ly + 108, 692, 210, 10, '#070c14');
            cv.strokeRoundRect(lx, ly + 108, 692, 210, 10, 1, '#1e2d42');

            cv.text('HOW TO CAST FROM OFFICIAL YOUTUBE APP:', lx + 24, ly + 140, 16, '#ffffff', { font: 'bold' });
            cv.text('1. Open official YouTube app on iPhone or Android', lx + 24, ly + 170, 14, '#cbd5e1');
            cv.text('2. Tap Settings (gear icon) > Watch on TV', lx + 24, ly + 198, 14, '#cbd5e1');
            cv.text('3. Tap "Link with TV code" and type the 12-digit code above', lx + 24, ly + 226, 14, '#00a3e0', { font: 'bold' });
            cv.text('4. Tap Cast icon in YouTube app — vehicle appears as "BMW iDrive 7"!', lx + 24, ly + 254, 14, '#cbd5e1');
            cv.text('5. Any video you tap on phone streams straight to your cockpit.', lx + 24, ly + 282, 14, '#2af575', { font: 'bold' });

            // Right Panel (740px): Smartphone QR Remote (No App Needed)
            G.panel(cv, t, 820, 52, 740, 410, 'Instant Web Remote (QR Code)');

            const qr = getCastQr();
            if (qr) {
                const qrx = 850, qry = 120, qrsz = 200;
                const modCount = qr.size;
                const modPx = Math.floor(qrsz / modCount);
                const actualSz = modPx * modCount;
                const ox = qrx + Math.floor((qrsz - actualSz) / 2);
                const oy = qry + Math.floor((qrsz - actualSz) / 2);

                cv.roundRect(ox - 10, oy - 10, actualSz + 20, actualSz + 20, 8, '#ffffff');
                for (let r = 0; r < modCount; r++) {
                    for (let c = 0; c < modCount; c++) {
                        if (qr.getModule(c, r)) {
                            cv.fillRect(ox + c * modPx, oy + r * modPx, modPx, modPx, '#000000');
                        }
                    }
                }

                const sx = 1080, sy = 120;
                cv.text('INSTANT WEB CAST', sx, sy + 18, 18, '#ffffff', { font: 'bold' });
                cv.text('For passengers or quick paste:', sx, sy + 44, 14, '#cbd5e1');
                cv.text('· Scan QR code with any camera', sx, sy + 70, 13, '#94a3b8');
                cv.text('· 1-Tap Paste any YouTube link', sx, sy + 94, 13, '#94a3b8');
                cv.text('· Works over 4G, 5G, or car Wi-Fi', sx, sy + 118, 13, '#00a3e0');

                // Short Code Pill
                cv.roundRect(sx, sy + 144, 430, 34, 6, '#0b131f');
                cv.strokeRoundRect(sx, sy + 144, 430, 34, 6, 1, '#0066b1');
                cv.text('WEB CODE: ' + cloudCast.getShortCode(), sx + 215, sy + 167, 14, '#00f0ff', { align: 'center', font: 'num' });

                cv.text('hexlay.github.io/idrive7-custom-apps/cinema.html', sx + 215, sy + 202, 12, '#64748b', { align: 'center' });
            }

            // Thermal Protection badge below QR
            cv.roundRect(850, 336, 680, 80, 8, '#080d15');
            cv.strokeRoundRect(850, 336, 680, 80, 8, 1, '#1e2d42');
            cv.text('INTEL ATOM HARDWARE PROTECTION: ' + (settings.quality === '1080p' ? '1080P FHD MAX' : '720P HD COOL'), 874, 364, 14, '#cbd5e1', { font: 'bold' });
            cv.text('Head unit safely downsamples high-bandwidth streams to prevent processor overheating.', 874, 390, 13, '#94a3b8');
        }

        /* ---------- Master 60 fps Render Loop ---------- */
        async function render() {
            const now = Date.now();
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);

            if (!isFullscreen) {
                if (page === 0) drawPlayer(cv, t, now);
                else if (page === 1) drawSearch(cv, t);
                else if (page === 2) drawConnect(cv, t);

                // G-Series Live Cockpit frame tabs along the top
                G.frame(cv, t, PAGES, page, [
                    { text: 'M-CINEMA' },
                    { text: activeCastVideo.quality },
                    { text: isPlaying ? 'PLAYING' : 'PAUSED' }
                ]);
            } else {
                drawVideoScreen(cv, 0, 0, W, H, activeCastVideo, true, now, vehicleSpeed > 0 && settings.interlock === 'strict');
            }

            if (statusMsg && (now - statusTime < 3200)) {
                cv.roundRect(W / 2 - 280, H - 52, 560, 38, 8, '#0066b1');
                cv.text(statusMsg, W / 2, H - 28, 16, '#ffffff', { align: 'center', font: 'bold' });
            }

            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- HMI Button & Touch Interactions ---------- */
        ui.onClick('BTN_PLAY', () => {
            isPlaying = !isPlaying;
            notify(isPlaying ? 'Play' : 'Pause');
            return render();
        });

        ui.onClick('BTN_SEARCH', () => {
            page = 1; // switch to Search
            return render();
        });

        ui.onClick('BTN_PAGE', () => {
            page = (page + 1) % PAGES.length;
            return render();
        });

        ctx.onTab((idx) => {
            page = idx;
            return render();
        });

        // Controller rotary knob & tilt
        ctx.controller.grab(true);
        ctx.controller.onInput((ev) => {
            if (page === 0 && ev.knobTicks) {
                playProgress = Math.max(0, Math.min(1, playProgress + ev.knobTicks * 0.02));
                render().catch(() => {});
            } else if (page === 1 && ev.knobTicks) {
                // Scroll search results
                if (ev.knobTicks > 0) {
                    searchScroll = Math.min(Math.max(0, searchResults.length - 4), searchScroll + 1);
                } else {
                    searchScroll = Math.max(0, searchScroll - 1);
                }
                render().catch(() => {});
            }
            if (ev.press) {
                if (page === 0) {
                    isPlaying = !isPlaying;
                    notify(isPlaying ? 'Play' : 'Pause');
                } else if (page === 1 && searchResults.length > 0) {
                    // Play currently highlighted search result
                    const first = searchResults[searchScroll];
                    if (first) {
                        playVideo({
                            ytId: first.id,
                            title: first.title,
                            channel: first.channel,
                            duration: first.duration,
                            views: first.views,
                            quality: (settings.quality === '1080p') ? '1080p 60' : '720p 60',
                            glow: '#0066b1',
                            desc: first.url,
                            url: first.url,
                            thumbnail: first.thumbnail
                        });
                    }
                }
                render().catch(() => {});
            }
        });

        // Start 60 fps render loop
        ctx.loop('MAIN', 15, render);
        render().then(() => log.info('M-Cinema ready')).catch((e) => log.warn('M-Cinema render error: ' + e));
    }
});
