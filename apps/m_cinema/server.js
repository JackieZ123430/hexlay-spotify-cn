'use strict';
/**
 * In-Car Cast Server for M-Cinema.
 * Runs on the BMW head unit to allow phones connected via Wi-Fi hotspot
 * to seamlessly cast YouTube, web videos, or local phone files to the iDrive 7 display.
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
                        let title = data.title;
                        if (!title) {
                            title = ytId ? `YouTube [${ytId}]` : (data.url ? 'Web Stream' : 'Phone Cast Video');
                        }

                        // Hardware thermal protection: Intel Atom A3960 CPU/GPU safe capping
                        // Strictly clamp to 720p or 1080p (never 2K or 4K to prevent head unit overheating)
                        const streamQuality = (data.quality === '1080p') ? '1080p 60' : '720p 60';

                        if (this.cb.onCast) {
                            this.cb.onCast({
                                title: title,
                                channel: data.channel || (ytId ? 'YouTube Stream' : 'Phone Mirror'),
                                duration: data.duration || 'Live Stream',
                                quality: streamQuality,
                                glow: ytId ? '#ff0000' : '#00a3e0',
                                views: 'Personal Cast',
                                desc: data.url || `Video ID: ${ytId || 'Local Media'}`,
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
    body { background: #070b11; color: #ffffff; padding: 16px; display: flex; flex-direction: column; align-items: center; min-height: 100vh; }
    .card { background: #0f1724; border: 1px solid #1e293b; border-radius: 20px; padding: 24px; width: 100%; max-width: 440px; box-shadow: 0 12px 40px rgba(0,0,0,0.6); }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 22px; }
    .title { font-size: 20px; font-weight: 800; letter-spacing: 1.5px; color: #ffffff; }
    .badge { background: rgba(0, 163, 224, 0.2); color: #00a3e0; border: 1px solid #00a3e0; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; }
    
    .btn-paste-cast { width: 100%; padding: 18px; background: linear-gradient(135deg, #00a3e0, #163a8a); color: #fff; border: none; border-radius: 14px; font-size: 16px; font-weight: 800; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; box-shadow: 0 6px 20px rgba(0, 163, 224, 0.45); margin-bottom: 18px; }
    .btn-paste-cast:active { transform: scale(0.98); }
    
    .divider { display: flex; align-items: center; text-align: center; color: #64748b; font-size: 12px; font-weight: 700; margin: 16px 0; }
    .divider::before, .divider::after { content: ''; flex: 1; border-bottom: 1px solid #1e293b; }
    .divider:not(:empty)::before { margin-right: .5em; }
    .divider:not(:empty)::after { margin-left: .5em; }

    .input-group { margin-bottom: 14px; }
    label { display: block; font-size: 13px; color: #94a3b8; margin-bottom: 8px; font-weight: 600; }
    input[type="text"] { width: 100%; padding: 14px 16px; background: #070b11; border: 1px solid #2a384c; border-radius: 12px; color: #fff; font-size: 15px; outline: none; }
    input[type="text"]:focus { border-color: #00a3e0; box-shadow: 0 0 0 2px rgba(0, 163, 224, 0.25); }
    
    .btn-secondary { width: 100%; padding: 14px; background: #162233; color: #cbd5e1; border: 1px solid #2a384c; border-radius: 12px; font-size: 14px; font-weight: 700; cursor: pointer; }
    .btn-secondary:active { background: #223147; }
    
    .controls { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 24px; padding-top: 20px; border-top: 1px solid #1e293b; }
    .btn-ctrl { padding: 14px; background: #131d2a; border: 1px solid #2a384c; border-radius: 12px; color: #e2e8f0; font-size: 14px; font-weight: 700; cursor: pointer; }
    .btn-ctrl:active { background: #1f2d40; }
    
    .status-box { margin-top: 14px; padding: 12px 16px; border-radius: 10px; font-size: 14px; font-weight: 600; text-align: center; display: none; }
    .status-success { background: rgba(42, 245, 117, 0.15); border: 1px solid #2af575; color: #2af575; }
    .status-err { background: rgba(225, 0, 26, 0.15); border: 1px solid #e1001a; color: #e1001a; }
    
    .history { margin-top: 24px; }
    .history-title { font-size: 12px; color: #64748b; font-weight: 700; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 1px; }
    .history-item { width: 100%; text-align: left; padding: 12px 14px; background: #0c121d; border: 1px solid #1a2638; border-radius: 10px; color: #94a3b8; font-size: 13px; font-weight: 600; margin-bottom: 8px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .history-item:hover { color: #fff; border-color: #00a3e0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="title">BMW M-CINEMA</div>
      <div class="badge">CAST REMOTE</div>
    </div>

    <!-- 1-Tap Paste and Cast Button -->
    <button class="btn-paste-cast" onclick="pasteAndCast()">
      <span>📋 1-TAP PASTE & CAST</span>
    </button>

    <div class="divider">OR ENTER LINK MANUALLY</div>

    <div class="input-group">
      <input type="text" id="ytUrl" placeholder="Paste YouTube / Web Video link">
    </div>

    <!-- Thermal Protection Quality Selector -->
    <div style="margin-bottom: 16px;">
      <label>STREAM QUALITY (INTEL ATOM SAFE CAP)</label>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
        <button type="button" id="q720" class="btn-ctrl" style="background: #18283d; border-color: #00a3e0; color: #00a3e0;" onclick="setQuality('720p')">✓ 720p (Cool & Safe)</button>
        <button type="button" id="q1080" class="btn-ctrl" onclick="setQuality('1080p')">1080p (Max Limit)</button>
      </div>
    </div>

    <button class="btn-secondary" onclick="castManual()">▶ CAST TO BMW DISPLAY</button>
    <div id="status" class="status-box"></div>

    <div class="controls">
      <button class="btn-ctrl" onclick="sendControl('seek', -10)">⏪ -10s</button>
      <button class="btn-ctrl" onclick="sendControl('toggle')">⏯ PLAY/PAUSE</button>
      <button class="btn-ctrl" onclick="sendControl('seek', 10)">⏩ +10s</button>
      <button class="btn-ctrl" style="grid-column: span 3; background: #18283d; border-color: #00a3e0; color: #00a3e0;" onclick="sendControl('fullscreen')">⛶ CINEMA FULLSCREEN (21:9)</button>
    </div>

    <div class="history" id="historyBox" style="display: none;">
      <div class="history-title">Recently Cast Videos</div>
      <div id="historyList"></div>
    </div>
  </div>

  <script>
    async function pasteAndCast() {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) {
          showStatus('Clipboard is empty! Copy a YouTube link first.', 'status-err');
          return;
        }
        document.getElementById('ytUrl').value = text;
        await sendCast(text);
      } catch (e) {
        // Fallback if clipboard permission denied
        const val = document.getElementById('ytUrl').value.trim();
        if (val) {
          await sendCast(val);
        } else {
          showStatus('Tap the box below and paste your link.', 'status-err');
        }
      }
    }

    function castManual() {
      const url = document.getElementById('ytUrl').value.trim();
      if (!url) {
        showStatus('Please paste a link first!', 'status-err');
        return;
      }
      sendCast(url);
    }

    async function sendCast(url) {
      showStatus('Casting to BMW display...', 'status-success');
      try {
        const res = await fetch('/api/cast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url, quality: currentQuality })
        });
        const data = await res.json();
        if (data.ok) {
          showStatus('✓ Playing on BMW 21:9 Ultrawide (' + currentQuality + ')!', 'status-success');
          saveHistory(url, data.title);
        } else {
          showStatus('Error: ' + (data.error || 'Failed to cast'), 'status-err');
        }
      } catch (e) {
        showStatus('Connection error: ' + e.message, 'status-err');
      }
    }

    let currentQuality = '720p';
    function setQuality(q) {
      currentQuality = q;
      const b720 = document.getElementById('q720');
      const b1080 = document.getElementById('q1080');
      if (q === '720p') {
        b720.style.background = '#18283d';
        b720.style.borderColor = '#00a3e0';
        b720.style.color = '#00a3e0';
        b720.textContent = '✓ 720p (Cool & Safe)';
        b1080.style.background = '#0d1522';
        b1080.style.borderColor = '#1e293b';
        b1080.style.color = '#cbd5e1';
        b1080.textContent = '1080p (Max Limit)';
      } else {
        b1080.style.background = '#18283d';
        b1080.style.borderColor = '#00a3e0';
        b1080.style.color = '#00a3e0';
        b1080.textContent = '✓ 1080p (Max Limit)';
        b720.style.background = '#0d1522';
        b720.style.borderColor = '#1e293b';
        b720.style.color = '#cbd5e1';
        b720.textContent = '720p (Cool & Safe)';
      }
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
      setTimeout(() => el.style.display = 'none', 4500);
    }

    function saveHistory(url, title) {
      let list = JSON.parse(localStorage.getItem('mcinema_history') || '[]');
      list = list.filter(item => item.url !== url);
      list.unshift({ url, title });
      if (list.length > 5) list = list.slice(0, 5);
      localStorage.setItem('mcinema_history', JSON.stringify(list));
      renderHistory();
    }

    function renderHistory() {
      const list = JSON.parse(localStorage.getItem('mcinema_history') || '[]');
      const box = document.getElementById('historyBox');
      const container = document.getElementById('historyList');
      if (!list.length) { box.style.display = 'none'; return; }
      box.style.display = 'block';
      container.innerHTML = '';
      list.forEach(item => {
        const btn = document.createElement('button');
        btn.className = 'history-item';
        btn.textContent = '▶ ' + item.title;
        btn.onclick = () => {
          document.getElementById('ytUrl').value = item.url;
          sendCast(item.url);
        };
        container.appendChild(btn);
      });
    }

    renderHistory();
  </script>
</body>
</html>`;
    }
}

module.exports = { CastServer };
