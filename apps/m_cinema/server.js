'use strict';
/**
 * Lightweight In-Car Cast Server for M-Cinema.
 * Runs on the BMW head unit to allow phones connected via Wi-Fi hotspot
 * to cast any YouTube video or web stream directly to the iDrive 7 display.
 */
const http = require('http');
const os = require('os');

const PORT = 8090;

function getLocalIp() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const net of ifaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return '127.0.0.1';
}

function parseYouTubeId(url) {
    if (!url) return null;
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

class CastServer {
    constructor(callbacks, log) {
        this.cb = callbacks || {};
        this.log = log || console;
        this.server = null;
        this.port = PORT;
        this.ip = getLocalIp();
    }

    start() {
        if (this.server) return;

        this.server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

            // CORS headers
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            // Web Remote Interface for Smartphone
            if (url.pathname === '/' || url.pathname === '/cast') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(this.renderMobileHtml());
                return;
            }

            // API: Cast Video
            if (url.pathname === '/api/cast' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body || '{}');
                        const ytId = parseYouTubeId(data.url) || data.id;
                        const title = data.title || (ytId ? `YouTube Video [${ytId}]` : 'Custom Cast Stream');

                        if (this.cb.onCast) {
                            this.cb.onCast({
                                title: title,
                                channel: data.channel || 'YouTube Cast',
                                duration: data.duration || 'Stream',
                                quality: '1080p 60',
                                glow: '#ff0000',
                                views: 'Live Cast',
                                desc: data.url || `YouTube ID: ${ytId}`,
                                ytId: ytId,
                                url: data.url
                            });
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: true, ytId, title }));
                    } catch (e) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: e.message }));
                    }
                });
                return;
            }

            // API: Playback Control
            if (url.pathname === '/api/control' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body || '{}');
                        if (this.cb.onControl) this.cb.onControl(data.action, data.value);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: true }));
                    } catch (e) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: e.message }));
                    }
                });
                return;
            }

            // 404
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        });

        this.server.on('error', (err) => {
            this.log.warn('M-Cinema Cast server: ' + err.message);
        });

        this.server.listen(this.port, '0.0.0.0', () => {
            this.log.info(`M-Cinema Cast server running at http://${this.ip}:${this.port}/cast`);
        });
    }

    getCastUrl() {
        return `http://${this.ip}:${this.port}/cast`;
    }

    renderMobileHtml() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>BMW M-Cinema Cast Remote</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body { background: #070b11; color: #ffffff; padding: 20px; display: flex; flex-direction: column; align-items: center; }
    .card { background: #0f1622; border: 1px solid #1e293b; border-radius: 16px; padding: 24px; width: 100%; max-width: 440px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
    .title { font-size: 20px; font-weight: 800; letter-spacing: 1px; color: #ffffff; }
    .badge { background: rgba(0, 163, 224, 0.2); color: #00a3e0; border: 1px solid #00a3e0; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; }
    .input-group { margin-bottom: 18px; }
    label { display: block; font-size: 13px; color: #94a3b8; margin-bottom: 8px; font-weight: 600; }
    input[type="text"] { width: 100%; padding: 14px 16px; background: #070b11; border: 1px solid #2a384c; border-radius: 10px; color: #fff; font-size: 15px; outline: none; }
    input[type="text"]:focus { border-color: #00a3e0; box-shadow: 0 0 0 2px rgba(0, 163, 224, 0.25); }
    .btn-cast { width: 100%; padding: 16px; background: linear-gradient(135deg, #00a3e0, #163a8a); color: #fff; border: none; border-radius: 12px; font-size: 16px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 14px rgba(0, 163, 224, 0.4); }
    .btn-cast:active { transform: scale(0.98); }
    .controls { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 24px; padding-top: 20px; border-top: 1px solid #1e293b; }
    .btn-ctrl { padding: 12px; background: #16202e; border: 1px solid #2a384c; border-radius: 10px; color: #cbd5e1; font-size: 14px; font-weight: 600; cursor: pointer; }
    .btn-ctrl:active { background: #223147; }
    .quick-list { margin-top: 24px; }
    .quick-title { font-size: 13px; color: #64748b; font-weight: 700; margin-bottom: 10px; text-transform: uppercase; }
    .quick-btn { width: 100%; text-align: left; padding: 12px 14px; background: #121a28; border: 1px solid #1e293b; border-radius: 8px; color: #e2e8f0; font-size: 13px; font-weight: 600; margin-bottom: 8px; cursor: pointer; }
    .status-box { margin-top: 16px; padding: 12px; border-radius: 8px; font-size: 13px; display: none; }
    .status-success { background: rgba(42, 245, 117, 0.15); border: 1px solid #2af575; color: #2af575; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="title">BMW M-CINEMA</div>
      <div class="badge">CAST REMOTE</div>
    </div>

    <div class="input-group">
      <label>PASTE YOUTUBE VIDEO LINK</label>
      <input type="text" id="ytUrl" placeholder="https://youtu.be/... or watch?v=...">
    </div>

    <button class="btn-cast" onclick="castVideo()">▶ CAST TO BMW DISPLAY</button>
    <div id="status" class="status-box"></div>

    <div class="controls">
      <button class="btn-ctrl" onclick="sendControl('seek', -10)">⏪ -10s</button>
      <button class="btn-ctrl" onclick="sendControl('toggle')">⏯ PLAY/PAUSE</button>
      <button class="btn-ctrl" onclick="sendControl('seek', 10)">⏩ +10s</button>
      <button class="btn-ctrl" style="grid-column: span 3;" onclick="sendControl('fullscreen')">⛶ FULLSCREEN (21:9)</button>
    </div>

    <div class="quick-list">
      <div class="quick-title">Quick Automotive Feeds</div>
      <button class="quick-btn" onclick="castPreset('https://youtu.be/M4_GT3_NURB', 'BMW M4 GT3 - 24h Nurburgring Pole Lap')">🏁 BMW M4 GT3 24h Nurburgring Lap</button>
      <button class="quick-btn" onclick="castPreset('https://youtu.be/M850_TOP_SPEED', 'BMW M850i - 320 km/h Autobahn GPS')">🚀 BMW M850i 320 km/h Autobahn Run</button>
      <button class="quick-btn" onclick="castPreset('https://youtu.be/CARWOW_M8_911', 'BMW M8 vs Porsche 911 Turbo S Drag')">🔥 Carwow Drag Race: M8 vs 911 Turbo</button>
    </div>
  </div>

  <script>
    async function castVideo() {
      const url = document.getElementById('ytUrl').value.trim();
      if (!url) return;
      showStatus('Casting to BMW display...', 'status-success');
      try {
        const res = await fetch('/api/cast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url })
        });
        const data = await res.json();
        if (data.ok) showStatus('✓ Playing on BMW 21:9 Screen!', 'status-success');
      } catch (e) {
        showStatus('Error: ' + e.message, 'status-box');
      }
    }

    function castPreset(url, title) {
      document.getElementById('ytUrl').value = url;
      fetch('/api/cast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, title })
      }).then(() => showStatus('✓ Casting ' + title, 'status-success'));
    }

    function sendControl(action, val) {
      fetch('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, value: val })
      });
    }

    function showStatus(msg, cls) {
      const el = document.getElementById('status');
      el.textContent = msg;
      el.className = 'status-box ' + cls;
      el.style.display = 'block';
      setTimeout(() => el.style.display = 'none', 4000);
    }
  </script>
</body>
</html>`;
    }
}

module.exports = { CastServer };
