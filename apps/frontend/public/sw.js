self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let message = { title: 'Koala', body: '', path: '/' };
  try {
    message = { ...message, ...event.data.json() };
  } catch {
    message.body = event.data ? event.data.text() : '';
  }
  event.waitUntil(self.registration.showNotification(message.title, {
    body: message.body,
    tag: message.tag,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { path: message.path },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.path) || '/';
  const target = new URL(path, self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const here = open.find((client) => new URL(client.url).origin === self.location.origin);
    if (here) {
      await here.focus();
      if ('navigate' in here) await here.navigate(target);
      return;
    }
    await self.clients.openWindow(target);
  })());
});
