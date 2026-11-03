'use strict';
/**
 * Spotify Auth Helper for BMW iDrive 7 App.
 *
 * Usage:
 *   1) Direct token:
 *      node apps/spotify/auth.js --token "BQC...your_token_here..."
 *
 *   2) Automatic OAuth login via browser:
 *      node apps/spotify/auth.js --client-id <CLIENT_ID> --client-secret <CLIENT_SECRET>
 *      (Opens browser, listens on http://127.0.0.1:8888/callback, exchanges code & saves tokens)
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const AUTH_FILE = path.join(__dirname, 'spotify_auth.json');

const SCOPES = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'playlist-read-private',
    'playlist-read-collaborative',
    'user-library-read'
].join(' ');

const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const directToken = getArg('--token');
const clientId = getArg('--client-id');
const clientSecret = getArg('--client-secret');

// Direct token write
if (directToken) {
    const data = {
        token: directToken,
        savedAt: new Date().toISOString()
    };
    fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
    console.log('✓ Successfully saved Spotify token to ' + AUTH_FILE);
    console.log('Your emulator will automatically reload and connect to live Spotify!');
    process.exit(0);
}

if (!clientId || !clientSecret) {
    console.log(`
Spotify Auth Setup for iDrive 7 MGU
===================================
Option A: Quick Token (Expires in 1 hour)
  Get a temporary token from: https://developer.spotify.com/documentation/web-api
  Run:
    node apps/spotify/auth.js --token "<PASTE_TOKEN>"

Option B: Full Automatic OAuth (Auto-refreshes forever)
  1. Go to https://developer.spotify.com/dashboard and create an app.
  2. In your app settings, add Redirect URI:
     ${REDIRECT_URI}
  3. Run:
    node apps/spotify/auth.js --client-id <YOUR_CLIENT_ID> --client-secret <YOUR_CLIENT_SECRET>
`);
    process.exit(1);
}

// OAuth Flow
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(`<h2>Authorization Error</h2><p>${error}</p>`);
            console.error('Authorization error: ' + error);
            server.close();
            process.exit(1);
        }

        if (code) {
            exchangeCodeForToken(code, (err, tokens) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/html' });
                    res.end(`<h2>Token Exchange Failed</h2><p>${err.message}</p>`);
                    console.error('Token exchange failed:', err);
                } else {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(`
                        <body style="font-family: sans-serif; background: #050708; color: #ffffff; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
                            <div style="background: #111a16; padding: 40px; border-radius: 16px; border: 1px solid #1db954; text-align: center;">
                                <h1 style="color: #1db954; margin-top: 0;">Connected to BMW iDrive Spotify!</h1>
                                <p style="color: #aaaaaa;">Tokens saved successfully. You can close this tab and check your emulator.</p>
                            </div>
                        </body>
                    `);
                    console.log('✓ Successfully authenticated! Tokens saved to ' + AUTH_FILE);
                    console.log('The emulator is now connected to your live Spotify account!');
                }
                server.close();
                process.exit(0);
            });
        }
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(PORT, '127.0.0.1', () => {
    const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        scope: SCOPES,
        redirect_uri: REDIRECT_URI,
    }).toString();

    console.log('Waiting for authorization on ' + REDIRECT_URI + '...');
    console.log('Opening browser for Spotify login...');
    console.log('URL: ' + authUrl);
    exec(`open "${authUrl}"`);
});

function exchangeCodeForToken(code, callback) {
    const postData = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI,
    }).toString();

    const authHeader = Buffer.from(clientId + ':' + clientSecret).toString('base64');
    const req = https.request({
        hostname: 'accounts.spotify.com',
        path: '/api/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + authHeader,
            'Content-Length': Buffer.byteLength(postData)
        }
    }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.access_token) {
                    const toSave = {
                        token: data.access_token,
                        refreshToken: data.refresh_token,
                        expiresAt: Date.now() + (data.expires_in * 1000),
                        clientId: clientId,
                        clientSecret: clientSecret,
                        savedAt: new Date().toISOString()
                    };
                    fs.writeFileSync(AUTH_FILE, JSON.stringify(toSave, null, 2));
                    callback(null, toSave);
                } else {
                    callback(new Error(data.error_description || body));
                }
            } catch (e) {
                callback(e);
            }
        });
    });
    req.on('error', callback);
    req.write(postData);
    req.end();
}
