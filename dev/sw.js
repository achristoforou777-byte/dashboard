// Service worker: shows the daily task notification and opens the app when tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json() } catch { d = { title: 'Ο πίνακάς μου', body: e.data ? e.data.text() : '' } }
  e.waitUntil(self.registration.showNotification(d.title || 'Ο πίνακάς μου', { body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png', data: { url: d.url || './' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) { c.navigate(url); return c.focus() }
    return clients.openWindow(url);
  }));
});
