// 最小 Service Worker：只为满足「可安装」条件，让 Chrome 把它装成独立应用。
//
// 刻意不做任何缓存——这个项目的数据全在服务端，页面和脚本必须每次取最新的，
// 一旦离线缓存住旧版 app.js，改完前端用户还会看到旧页面（历史上踩过）。
// 不调用 event.respondWith()，请求就走浏览器默认的网络路径。

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  // 顺手清掉可能存在的历史缓存，避免旧版本残留
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", () => {
  // 空实现：交给浏览器处理
});
