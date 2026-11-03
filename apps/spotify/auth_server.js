'use strict';
/**
 * In-Car Spotify Auth Server for BMW iDrive 7.
 *
 * Runs automatically inside the MGU head unit application (port 8888).
 * Enables any driver on any car to connect their personal Spotify account
 * by simply scanning the cockpit display QR code with their smartphone.
 *
 * Flow:
 *   1. Cockpit screen renders QR code: http://<car_ip>:8888/login
 *   2. Driver (connected to car Wi-Fi / CarPlay hotspot) scans with phone
 *   3. Mobile page opens -> Driver taps "Connect with Spotify"
 *   4. Phone redirects to Spotify OAuth -> Driver approves
 *   5. In-car server catches callback, exchanges code for tokens, and saves locally
 *   6. Cockpit screen immediately refreshes into live Spotify library!
 *   7. Zero terminal commands, zero SSH, zero node scripts needed.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 8888;
const SCOPES = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'playlist-read-private',
    'playlist-read-collaborative',
    'user-library-read'
].join(' ');

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

class SpotifyAuthServer {
    constructor(ctx, spotifyClient) {
        this.ctx = ctx;
        this.log = ctx.log || console;
        this.spotify = spotifyClient;
        this.server = null;
        this.port = PORT;
        this.ip = getLocalIp();
    }

    getLoginUrl() {
        return `http://${this.ip}:${this.port}/login`;
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

            // Route: Home -> Login
            if (url.pathname === '/' || url.pathname === '/login') {
                this.handleLogin(req, res, host);
                return;
            }

            // Route: Start OAuth Redirect
            if (url.pathname === '/authorize') {
                this.handleAuthorize(req, res, url, host);
                return;
            }

            // Route: OAuth Callback
            if (url.pathname === '/callback') {
                this.handleCallback(req, res, url, host);
                return;
            }

            // Route: Direct Token Save (Alternative)
            if (url.pathname === '/save_token' && req.method === 'POST') {
                this.handleSaveToken(req, res);
                return;
            }

            // Route: Status check
            if (url.pathname === '/status') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    isOnline: this.spotify.isOnline,
                    paired: this.spotify.paired,
                    activeDevice: this.spotify.activeDevice
                }));
                return;
            }

            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        });

        this.server.on('error', (err) => {
            this.log.warn('SpotifyAuthServer error: ' + err.message);
        });

        try {
            this.server.listen(this.port, '0.0.0.0', () => {
                this.log.info(`SpotifyAuthServer listening on http://0.0.0.0:${this.port} (Connect URL: ${this.getLoginUrl()})`);
            });
        } catch (e) {
            this.log.warn('Could not bind SpotifyAuthServer: ' + e.message);
        }
    }

    stop() {
        if (this.server) {
            try { this.server.close(); } catch (e) {}
            this.server = null;
        }
    }

    getSavedCredentials() {
        const paths = [
            this.ctx && this.ctx.dataDir ? path.join(this.ctx.dataDir, 'spotify_auth.json') : null,
            path.join(__dirname, 'spotify_auth.json')
        ].filter(Boolean);

        for (const p of paths) {
            try {
                if (fs.existsSync(p)) {
                    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
                    if (data.clientId) return data;
                }
            } catch (e) {}
        }
        return {};
    }

    saveCredentialsAndTokens(data) {
        const current = this.getSavedCredentials();
        const merged = Object.assign({}, current, data, { savedAt: new Date().toISOString() });

        const paths = [
            this.ctx && this.ctx.dataDir ? path.join(this.ctx.dataDir, 'spotify_auth.json') : null,
            path.join(__dirname, 'spotify_auth.json')
        ].filter(Boolean);

        paths.forEach(p => {
            try {
                fs.writeFileSync(p, JSON.stringify(merged, null, 2), 'utf8');
                this.log.info('Saved Spotify auth to ' + p);
            } catch (e) {
                this.log.warn('Could not save auth to ' + p + ': ' + e.message);
            }
        });

        // Notify client to immediately sync
        if (this.spotify && typeof this.spotify.reloadAuth === 'function') {
            this.spotify.reloadAuth();
        }
    }

    handleLogin(req, res, host) {
        const creds = this.getSavedCredentials();
        const clientId = creds.clientId || '';
        const clientSecret = creds.clientSecret || '';
        const isOnline = this.spotify && this.spotify.isOnline;

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.renderMobileHtml(host, clientId, clientSecret, isOnline));
    }

    handleAuthorize(req, res, url, host) {
        const qClientId = url.searchParams.get('client_id');
        const qClientSecret = url.searchParams.get('client_secret');

        const creds = this.getSavedCredentials();
        const clientId = (qClientId || creds.clientId || '').trim();
        const clientSecret = (qClientSecret || creds.clientSecret || '').trim();

        if (!clientId) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<h3>Error: Missing Client ID</h3><p>Please enter your Spotify Developer Client ID.</p>');
            return;
        }

        // Persist credentials
        if (clientSecret) {
            this.saveCredentialsAndTokens({ clientId, clientSecret });
        }

        // Redirect URI: use the exact host reachable by this phone
        const redirectUri = `http://${host}/callback`;

        const authParams = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            scope: SCOPES,
            redirect_uri: redirectUri,
            show_dialog: 'true'
        });

        res.writeHead(302, { Location: 'https://accounts.spotify.com/authorize?' + authParams.toString() });
        res.end();
    }

    handleCallback(req, res, url, host) {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
                <body style="background:#090d14;color:#fff;font-family:sans-serif;padding:30px;text-align:center;">
                    <h2 style="color:#e1001a;">Authorization Cancelled or Failed</h2>
                    <p>${error}</p>
                    <a href="/login" style="color:#00a3e0;">Return to Login</a>
                </body>
            `);
            return;
        }

        if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('No code provided');
            return;
        }

        const creds = this.getSavedCredentials();
        const redirectUri = `http://${host}/callback`;

        this.exchangeCode(code, redirectUri, creds.clientId, creds.clientSecret, (err, tokens) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`
                    <body style="background:#090d14;color:#fff;font-family:sans-serif;padding:30px;text-align:center;">
                        <h2 style="color:#e1001a;">Token Exchange Error</h2>
                        <p>${err.message}</p>
                        <p style="color:#888;">Ensure Redirect URI <code>${redirectUri}</code> is added to your Spotify Developer Dashboard.</p>
                        <a href="/login" style="color:#00a3e0;">Try Again</a>
                    </body>
                `);
                return;
            }

            this.saveCredentialsAndTokens({
                token: tokens.access_token,
                refreshToken: tokens.refresh_token,
                expiresAt: Date.now() + (tokens.expires_in * 1000)
            });

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.renderSuccessHtml());
        });
    }

    handleSaveToken(req, res) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const params = new URLSearchParams(body);
                const token = (params.get('token') || '').trim();
                if (token) {
                    this.saveCredentialsAndTokens({
                        token,
                        expiresAt: Date.now() + (3600 * 1000)
                    });
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(this.renderSuccessHtml());
                    return;
                }
            } catch (e) {}
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid token');
        });
    }

    exchangeCode(code, redirectUri, clientId, clientSecret, cb) {
        if (!clientId || !clientSecret) {
            return cb(new Error('Missing Client ID or Client Secret'));
        }

        const postData = new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: redirectUri
        }).toString();

        const authHeader = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

        const opt = {
            hostname: 'accounts.spotify.com',
            port: 443,
            path: '/api/token',
            method: 'POST',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(opt, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) {
                        return cb(new Error(parsed.error_description || parsed.error));
                    }
                    cb(null, parsed);
                } catch (e) {
                    cb(e);
                }
            });
        });

        req.on('error', cb);
        req.write(postData);
        req.end();
    }

    renderMobileHtml(host, clientId, clientSecret, isOnline) {
        const redirectUri = `http://${host}/callback`;
        const hasCreds = !!(clientId && clientSecret);

        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>BMW iDrive 7 - Spotify Connect</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: #070b12;
            color: #f1f5f9;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            padding: 24px 16px 40px;
            display: flex;
            flex-direction: column;
            align-items: center;
            min-height: 100vh;
        }
        .header {
            width: 100%;
            max-width: 440px;
            text-align: center;
            margin-bottom: 24px;
        }
        .badge {
            display: inline-block;
            background: #004e8c;
            color: #00f0ff;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 1.5px;
            padding: 4px 10px;
            border-radius: 6px;
            margin-bottom: 10px;
        }
        h1 {
            font-size: 24px;
            font-weight: 800;
            color: #ffffff;
            margin-bottom: 6px;
        }
        p.subtitle {
            font-size: 14px;
            color: #94a3b8;
        }
        .card {
            background: #0e1522;
            border: 1px solid #1e293b;
            border-radius: 16px;
            padding: 24px 20px;
            width: 100%;
            max-width: 440px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5);
            margin-bottom: 20px;
        }
        .btn-spotify {
            display: block;
            width: 100%;
            background: #1ed760;
            color: #000000;
            font-size: 16px;
            font-weight: 700;
            text-align: center;
            padding: 16px 0;
            border-radius: 30px;
            text-decoration: none;
            cursor: pointer;
            border: none;
            transition: transform 0.1s ease, background 0.2s ease;
            margin-top: 10px;
            margin-bottom: 12px;
        }
        .btn-spotify:active {
            transform: scale(0.98);
            background: #1ab250;
        }
        .status-pill {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            background: #141f2e;
            padding: 10px;
            border-radius: 10px;
            font-size: 13px;
            margin-bottom: 16px;
            color: ${isOnline ? '#2af575' : '#ffb703'};
            font-weight: 600;
        }
        .dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: ${isOnline ? '#2af575' : '#ffb703'};
        }
        .info-box {
            background: #070d16;
            border: 1px solid #1c2738;
            border-radius: 10px;
            padding: 12px;
            font-size: 12px;
            color: #94a3b8;
            margin-top: 14px;
            word-break: break-all;
        }
        .info-box code {
            color: #00f0ff;
            font-weight: bold;
        }
        label {
            display: block;
            font-size: 13px;
            color: #cbd5e1;
            margin-bottom: 6px;
            margin-top: 14px;
            font-weight: 600;
        }
        input[type="text"] {
            width: 100%;
            background: #060a10;
            border: 1px solid #253347;
            border-radius: 8px;
            padding: 12px;
            color: #ffffff;
            font-size: 14px;
            outline: none;
        }
        input[type="text"]:focus {
            border-color: #1ed760;
        }
        details {
            margin-top: 18px;
            border-top: 1px solid #1a2433;
            padding-top: 14px;
        }
        summary {
            font-size: 13px;
            color: #00a3e0;
            cursor: pointer;
            font-weight: 600;
            outline: none;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="badge">BMW iDrive 7 Cockpit</div>
        <h1>Spotify Connect</h1>
        <p class="subtitle">Connect your personal Spotify library to your car</p>
    </div>

    <div class="card">
        <div class="status-pill">
            <div class="dot"></div>
            <span>${isOnline ? 'Car Cockpit Connected' : 'Car Awaiting Authorization'}</span>
        </div>

        <form action="/authorize" method="GET">
            ${hasCreds ? `
                <input type="hidden" name="client_id" value="${clientId}">
                <input type="hidden" name="client_secret" value="${clientSecret}">
                <button type="submit" class="btn-spotify">Connect with Spotify</button>
                <p style="font-size: 12px; color: #94a3b8; text-align: center;">Tapping will open Spotify login to pair your account with this car.</p>
            ` : `
                <p style="font-size: 13px; color: #cbd5e1; margin-bottom: 12px;">Enter your Spotify Developer App keys (configured once per car):</p>
                <label>Spotify Client ID</label>
                <input type="text" name="client_id" placeholder="e.g. 5a1b2c3d..." required value="${clientId}">
                <label>Spotify Client Secret</label>
                <input type="text" name="client_secret" placeholder="e.g. 9f8e7d..." required value="${clientSecret}">
                <button type="submit" class="btn-spotify">Save & Connect Spotify</button>
            `}

            <details ${!hasCreds ? 'open' : ''}>
                <summary>${hasCreds ? 'Change API Keys or Setup Info' : 'Redirect URI Instructions'}</summary>
                <div class="info-box">
                    Add this exact Redirect URI to your Spotify Dashboard:<br>
                    <code>${redirectUri}</code>
                </div>
                ${hasCreds ? `
                    <div style="margin-top: 14px;">
                        <label>Custom Client ID</label>
                        <input type="text" name="client_id" value="${clientId}">
                        <label>Custom Client Secret</label>
                        <input type="text" name="client_secret" value="${clientSecret}">
                    </div>
                ` : ''}
            </details>
        </form>
    </div>

    <div class="card">
        <details>
            <summary>Direct Token Paste (Alternative)</summary>
            <form action="/save_token" method="POST" style="margin-top: 12px;">
                <label>Paste Temporary Spotify Bearer Token</label>
                <input type="text" name="token" placeholder="BQC..." required>
                <button type="submit" class="btn-spotify" style="background: #004e8c; color: #fff; margin-top: 14px;">Save Token to Car</button>
            </form>
        </details>
    </div>
</body>
</html>`;
    }

    renderSuccessHtml() {
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Connected - BMW iDrive 7</title>
    <style>
        body {
            background: #070b12;
            color: #f1f5f9;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            padding: 40px 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 80vh;
            text-align: center;
        }
        .box {
            background: #0e1522;
            border: 1px solid #1ed760;
            border-radius: 20px;
            padding: 36px 24px;
            max-width: 400px;
            box-shadow: 0 10px 30px rgba(30, 215, 96, 0.2);
        }
        .icon {
            width: 64px;
            height: 64px;
            background: #1ed760;
            color: #000;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 32px;
            font-weight: bold;
            margin: 0 auto 20px;
        }
        h2 { font-size: 22px; margin-bottom: 10px; color: #ffffff; }
        p { font-size: 14px; color: #94a3b8; line-height: 1.5; margin-bottom: 24px; }
        .tag { font-size: 12px; color: #00f0ff; background: #002b4d; padding: 6px 12px; border-radius: 20px; }
    </style>
</head>
<body>
    <div class="box">
        <div class="icon">&#10003;</div>
        <h2>Connected to BMW iDrive 7!</h2>
        <p>Your Spotify account is now authenticated. Your personal playlists, saved library, and active devices are live on your cockpit display.</p>
        <span class="tag">You may now close this browser tab</span>
    </div>
</body>
</html>`;
    }
}

module.exports = { SpotifyAuthServer };
