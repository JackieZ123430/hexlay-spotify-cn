'use strict';
/**
 * In-Car Cast Server for M-Cinema.
 * Runs on the BMW head unit as a local Wi-Fi fallback alongside the Cloud Relay.
 * Strictly focused on YouTube casting and cockpit playback.
 */
const http = require('http');
const os = require('os');
const { parseYouTubeId } = require('./cloud_cast');

const PORT = 8090;

function getLocalIp() {
    const ifaces = os.networkInterfaces();
    let candidates = [];
    for (const name of Object.keys(ifaces)) {
        for (const net of ifaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                if (net.address.startsWith('192.168.') || net.address.startsWith('172.') || net.address.startsWith('10.')) {
                    candidates.unshift(net.address);
                } else {
                    candidates.push(net.address);
                }
            }
        }
    }
    return candidates[0] || '127.0.0.1';
}

class CastServer {
    constructor(callbacks, log) {
        this.cb = callbacks || {};
        this.log = log || console;
        this.server = null;
        this.port = PORT;
        this.ip = getLocalIp();
        this.cloudUrl = null;
    }

    setCloudUrl(url) {
        this.cloudUrl = url;
    }

    start() {
        if (this.server) return;

        this.server = http.createServer((req, res) => {
            const host = req.headers.host || `${this.ip}:${this.port}`;
            const url = new URL(req.url, `http://${host}`);

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

            // API: Cast YouTube Video
            if (url.pathname === '/api/cast' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body || '{}');
                        const ytId = parseYouTubeId(data.url) || data.id || data.ytId;
                        let title = data.title;
                        if (!title) {
                            title = ytId ? `YouTube [${ytId}]` : 'YouTube Video';
                        }

                        // Intel Atom A3960 CPU/GPU thermal safe capping (720p or 1080p max)
                        const streamQuality = (data.quality === '1080p') ? '1080p 60' : '720p 60';

                        if (this.cb.onCast) {
                            this.cb.onCast({
                                title: title,
                                channel: data.channel || 'YouTube Stream',
                                duration: data.duration || '00:00',
                                quality: streamQuality,
                                glow: '#ff0000',
                                views: 'Local Cast',
                                desc: data.url || (ytId ? `https://youtu.be/${ytId}` : 'YouTube Video'),
                                ytId: ytId,
                                url: data.url || (ytId ? `https://www.youtube.com/watch?v=${ytId}` : null),
                                thumbnail: data.thumbnail || (ytId ? `https://img.youtube.com/vi/${ytId}/hqdefault.jpg` : null)
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
            if (err.code === 'EADDRINUSE') {
                this.log.info('M-Cinema local port 8090 busy; cloud relay active.');
            } else {
                this.log.warn('M-Cinema server error: ' + err.message);
            }
        });

        try {
            this.server.listen(this.port, '0.0.0.0', () => {
                this.log.info(`M-Cinema local fallback listening at http://${this.ip}:${this.port}/cast`);
            });
        } catch (e) {
            this.log.warn('M-Cinema server start warning: ' + e.message);
        }
    }

    getCastUrl() {
        return `http://${this.ip}:${this.port}/cast`;
    }

    renderMobileHtml() {
        const cloudRedirect = this.cloudUrl ? `<div style="margin-bottom: 16px; padding: 12px; background: rgba(0, 163, 224, 0.15); border: 1px solid #00a3e0; border-radius: 10px; font-size: 13px; text-align: center;">Tip: You can also use the cloud relay without car Wi-Fi: <a href="${this.cloudUrl}" style="color: #00f0ff; font-weight: bold;">Open Cloud Remote</a></div>` : '';

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>BMW M-Cinema YouTube Cast Remote</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body { background: #070b11; color: #ffffff; padding: 16px; display: flex; flex-direction: column; align-items: center; min-height: 100vh; }
    .card { background: #0f1724; border: 1px solid #1e293b; border-radius: 20px; padding: 24px; width: 100%; max-width: 440px; box-shadow: 0 12px 40px rgba(0,0,0,0.6); }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
    .title { font-size: 20px; font-weight: 800; letter-spacing: 1.5px; color: #ffffff; }
    .badge { background: rgba(255, 0, 0, 0.2); color: #ff4d4d; border: 1px solid #ff0000; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; }
    
    .btn-paste-cast { width: 100%; padding: 18px; background: linear-gradient(135deg, #ff0000, #b30000); color: #fff; border: none; border-radius: 14px; font-size: 16px; font-weight: 800; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; box-shadow: 0 6px 20px rgba(255, 0, 0, 0.4); margin-bottom: 18px; }
    .btn-paste-cast:active { transform: scale(0.98); }
    
    .input-group { margin-bottom: 14px; }
    label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 8px; font-weight: 700; letter-spacing: 0.5px; }
    input[type="text"] { width: 100%; padding: 14px 16px; background: #070b11; border: 1px solid #2a384c; border-radius: 12px; color: #fff; font-size: 15px; outline: none; }
    input[type="text"]:focus { border-color: #ff0000; box-shadow: 0 0 0 2px rgba(255, 0, 0, 0.25); }
    
    .btn-secondary { width: 100%; padding: 14px; background: #162233; color: #cbd5e1; border: 1px solid #2a384c; border-radius: 12px; font-size: 14px; font-weight: 700; cursor: pointer; }
    .btn-secondary:active { background: #223147; }
    
    .controls { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 24px; padding-top: 20px; border-top: 1px solid #1e293b; }
    .btn-ctrl { padding: 14px; background: #131d2a; border: 1px solid #2a384c; border-radius: 12px; color: #e2e8f0; font-size: 14px; font-weight: 700; cursor: pointer; }
    .btn-ctrl:active { background: #1f2d40; }
    
    .status-box { margin-top: 14px; padding: 12px 16px; border-radius: 10px; font-size: 14px; font-weight: 600; text-align: center; display: none; }
    .status-success { background: rgba(42, 245, 117, 0.15); border: 1px solid #2af575; color: #2af575; }
    .status-err { background: rgba(225, 0, 26, 0.15); border: 1px solid #e1001a; color: #e1001a; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="title">BMW M-CINEMA</div>
      <div class="badge">YOUTUBE CAST</div>
    </div>

    ${cloudRedirect}

    <button class="btn-paste-cast" onclick="pasteAndCast()">
      <span>📋 1-TAP PASTE & CAST</span>
    </button>

    <div class="input-group">
      <label>PASTE YOUTUBE VIDEO LINK</label>
      <input type="text" id="ytUrl" placeholder="https://youtu.be/... or watch?v=...">
    </div>

    <button class="btn-secondary" onclick="castManual()">▶ CAST TO BMW DISPLAY</button>
    <div id="status" class="status-box"></div>

    <div class="controls">
      <button class="btn-ctrl" onclick="sendControl('seek', -10)">⏪ -10s</button>
      <button class="btn-ctrl" onclick="sendControl('toggle')">⏯ PLAY/PAUSE</button>
      <button class="btn-ctrl" onclick="sendControl('seek', 10)">⏩ +10s</button>
      <button class="btn-ctrl" style="grid-column: span 3; background: #18283d; border-color: #00a3e0; color: #00a3e0;" onclick="sendControl('fullscreen')">⛶ CINEMA FULLSCREEN (21:9)</button>
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
        const val = document.getElementById('ytUrl').value.trim();
        if (val) await sendCast(val);
        else showStatus('Please paste your YouTube link below.', 'status-err');
      }
    }

    function castManual() {
      const url = document.getElementById('ytUrl').value.trim();
      if (!url) {
        showStatus('Please paste a YouTube link first!', 'status-err');
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
          body: JSON.stringify({ url: url, quality: '720p' })
        });
        const data = await res.json();
        if (data.ok) {
          showStatus('✓ Playing on BMW 21:9 Ultrawide!', 'status-success');
        } else {
          showStatus('Error: ' + (data.error || 'Failed to cast'), 'status-err');
        }
      } catch (e) {
        showStatus('Connection error: ' + e.message, 'status-err');
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
  </script>
</body>
</html>`;
    }
}

module.exports = { CastServer };
