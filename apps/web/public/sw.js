/* eslint-disable no-restricted-globals */
// Service worker центра уведомлений (core/notifications, канал web push).
// Payload от API: { title, body, href, notificationId, icon, tag }.
// Клик — фокус открытой вкладки приложения (и переход по href), иначе новая вкладка.
// Веб при загрузке `href?n=<id>` помечает строку прочитанной.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'SuperApp6';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { href: data.href || '/notifications', notificationId: data.notificationId || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const href = (event.notification.data && event.notification.data.href) || '/notifications';
  const target = new URL(href, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        if (!('focus' in client) || new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        // navigate() отказывает на вкладке, которую этот SW не контролирует (её открыли
        // до регистрации). Молчаливый отказ оставил бы человека на прежней странице —
        // отступаем на новое окно, а не теряем переход.
        if ('navigate' in client) {
          try {
            const navigated = await client.navigate(target);
            if (navigated) return navigated;
          } catch {
            return self.clients.openWindow(target);
          }
        }
        return self.clients.openWindow(target);
      }
      return self.clients.openWindow(target);
    }),
  );
});
