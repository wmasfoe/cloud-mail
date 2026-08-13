/**
 * PWA Service Worker:接收 Web Push 通知并弹通知
 * (纯推送,不预缓存;静态资源走常规 HTTP 缓存)
 */
/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching';

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// 预缓存构建产物
precacheAndRoute(self.__WB_MANIFEST);

// 收到推送 → 弹通知
self.addEventListener('push', (event) => {
    let title = '新邮件';
    let body = '';
    let data = {};
    try {
        const payload = event.data ? event.data.json() : null;
        if (payload) {
            title = payload.title || title;
            body = payload.body || '';
            data = payload.data || {};
        }
    } catch (e) {
        body = event.data ? event.data.text() : '';
    }
    event.waitUntil(
        self.registration.showNotification(title, {
            body,
            icon: '/mail-pwa.png',
            badge: '/mail-pwa.png',
            tag: 'new-mail-' + Date.now(),
            data,
        })
    );
});

// 点通知 → 打开网页端
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) return client.focus();
            }
            return self.clients.openWindow('/');
        })
    );
});
