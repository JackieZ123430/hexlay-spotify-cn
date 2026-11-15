'use strict';

// M-Copilot's Cancel (apps/m_copilot/ai.js cancel()): a question to an AI that takes minutes is ended at once.
// A local server that takes the request and never answers stands in for a slow model: after cancel() the
// request is closed (the server sees its connection go), ask() resolves null at once, nothing is kept for
// follow-ups, and the next question is asked and answered as usual. No network or AI key needed:
//   node kit/tools/test_copilot_cancel.js

const assert = require('assert');
const http = require('http');
const path = require('path');
const Module = require('module');

// in a package the kit is at ./kit next to the app's files (build.py); here it is kit/runtime
const KIT = path.resolve(__dirname, '..', 'runtime'), APPS = path.resolve(__dirname, '..', '..', 'apps');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent) {
    const m = parent && parent.filename && parent.filename.indexOf(APPS) === 0 && /^\.\/kit\/(.+)$/.exec(request);
    return origResolve.apply(this, [m ? path.join(KIT, m[1]) : request].concat([].slice.call(arguments, 1)));
};
const { AiBridge } = require(path.join(APPS, 'm_copilot', 'ai'));

let answerNext = false, closed = 0, got = 0;
const server = http.createServer((req, res) => {
    got++;
    req.on('data', () => {});
    req.on('end', () => {
        if (answerNext) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ text: 'Oil is fine.' })); }
        // else: a model thinking for minutes, nothing sent
    });
    req.socket.on('close', () => { closed++; });
});

server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const quiet = { info() {}, warn() {}, error() {} };
    const ai = new AiBridge(quiet);
    ai.saveConfig = () => {};                       // no file written
    Object.assign(ai.config, { provider: 'gemini', mode: 'gemini', geminiApiKey: 'test-key' });
    ai.hasInternet = true;
    // the provider's request, sent to the local server instead of Google
    ai.queryGemini = async (prompt) => {
        const r = await ai._post('127.0.0.1', '/', {}, { prompt }, { url: { protocol: 'http:', port }, timeoutMs: 120000 });
        if (r.cancelled) return { ok: false, cancelled: true, text: '' };
        return r.json ? { ok: true, text: r.json.text } : { ok: false, text: 'AI: ' + (r.error || r.status) };
    };
    const t0 = Date.now();
    try {
        // 1. a slow answer, cancelled after 300 ms
        const pending = ai.ask('How is my oil?', { units: {} });
        await new Promise((r) => setTimeout(r, 300));
        assert.strictEqual(got, 1, 'the request reached the server');
        assert.strictEqual(ai.inflight.size, 1);
        ai.cancel();
        const answer = await pending;
        assert.strictEqual(answer, null, 'a cancelled ask() resolves null');
        assert.ok(Date.now() - t0 < 2000, 'resolved at once, not after the timeout');
        assert.strictEqual(ai.inflight.size, 0);
        assert.strictEqual(ai.lastOk, false);
        assert.strictEqual(ai.history.length, 0, 'nothing kept for follow-ups');
        await new Promise((r) => setTimeout(r, 200));
        assert.ok(closed >= 1, 'the connection to the AI is closed');

        // 2. the next question works as usual
        answerNext = true;
        const next = await ai.ask('And now?', { units: {} });
        assert.strictEqual(next, 'Oil is fine.');
        assert.strictEqual(ai.lastOk, true);
        assert.strictEqual(ai.history.length, 1);

        // 3. a cancel with nothing waiting does nothing to the next question
        ai.cancel();
        assert.strictEqual(await ai.ask('Once more', { units: {} }), 'Oil is fine.');
        console.log('test_copilot_cancel: all passed');
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        try { ai.agent.destroy(); } catch (e) { /* none */ }
        server.close();
        setTimeout(() => process.exit(process.exitCode || 0), 50);
    }
});
