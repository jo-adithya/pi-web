// Generic notification contents only: never render server-supplied URLs or capabilities.
self.addEventListener("push", event => {
  event.waitUntil(self.registration.showNotification("Pi Web", {
    body: "A workspace task finished. Open Pi Web to review.",
    tag: "pi-web-workspace-completion",
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) await existing.focus();
    else await self.clients.openWindow("/");
  })());
});
