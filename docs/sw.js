/*
 * sw.js - shows the car's notifications. Registered once per paired car, with the scope
 * n/<channel>/ (carlink.js), so each car's push subscription is separate.
 *
 * The browser decrypts each push (the car encrypted it for this browser only, RFC 8291)
 * before this worker sees it. Nothing is cached and no page is controlled.
 */
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function carChannel() {
    const m = /\/n\/(bmw_copilot_[0-9a-f]{24})\/$/.exec(self.registration.scope);
    return m ? m[1] : null;
}

self.addEventListener('push', (e) => {
    let d = {};
    try { d = e.data ? e.data.json() : {}; } catch (x) { d = {}; }
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    const ch = carChannel();
    const title = str(d.title, 60) || 'Your car';
    const page = ch ? 'copilot.html?channel=' + ch : 'index.html';
    e.waitUntil(self.registration.showNotification(title, {
        body: str(d.body, 300),
        tag: (ch || 'car') + ':' + (/^[a-z]{1,12}$/.test(d.tag || '') ? d.tag : 'car'),
        icon: new URL('../../icons/icon-192.png', self.registration.scope).href,
        badge: new URL('../../icons/icon-192.png', self.registration.scope).href,
        data: { url: new URL('../../' + page, self.registration.scope).href },
    }));
});

self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    const url = (e.notification.data && e.notification.data.url) || new URL('../../index.html', self.registration.scope).href;
    e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
        for (const c of list) { if (c.url === url && 'focus' in c) return c.focus(); }
        return self.clients.openWindow(url);
    }));
});
