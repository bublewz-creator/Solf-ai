/*
 * Solf.ai — Service Worker "kill-switch".
 *
 * ЗАЧЕМ ОН ВООБЩЕ НУЖЕН:
 *   У некоторых пользователей в браузере остался ЗАЛИПШИЙ Service Worker от прошлой
 *   версии сайта. Тот старый SW кешировал внешние CDN (jsdelivr, Google Fonts, Google
 *   аватарки), и без VPN падал с ошибкой:
 *       "Failed to execute 'put' on 'Cache': Cache.put() encountered a network error"
 *   Он же отдавал 404 на favicon-32.png из мёртвого кеша.
 *
 * ЧТО ДЕЛАЕТ ЭТОТ ФАЙЛ:
 *   1) Принудительно становится активным (skipWaiting + clients.claim).
 *   2) Удаляет ВСЕ caches.
 *   3) Снимает регистрацию (unregister) — следующий визит будет уже без SW.
 *   4) НИЧЕГО не перехватывает: запросы идут напрямую в сеть. Никаких fetch-handler'ов.
 *
 * ОТКАТ:
 *   Если когда-то решишь снова делать оффлайн-режим — замени этот файл на нормальный SW
 *   и верни регистрацию в app.js (см. блок около строки 2444 в старой версии).
 */

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        (async () => {
            try {
                const keys = await caches.keys();
                await Promise.all(keys.map((k) => caches.delete(k)));
            } catch (_) { /* плевать, на этой стадии всё равно сносим */ }
        })()
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            try {
                const keys = await caches.keys();
                await Promise.all(keys.map((k) => caches.delete(k)));
            } catch (_) {}
            try { await self.clients.claim(); } catch (_) {}
            try { await self.registration.unregister(); } catch (_) {}
            // После unregister просим клиентов перезагрузиться, чтобы запросы пошли
            // уже в обход killed SW и пользователь сразу получил рабочий сайт.
            try {
                const clientsList = await self.clients.matchAll({ type: 'window' });
                for (const client of clientsList) {
                    try { client.navigate(client.url); } catch (_) {}
                }
            } catch (_) {}
        })()
    );
});

// Намеренно НЕТ fetch-handler'а: браузер пойдёт в сеть напрямую без посредников.
