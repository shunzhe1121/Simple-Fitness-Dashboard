/* Service Worker：离线缓存核心资源，cache-first + 网络兜底。
 * 更新版本号（CACHE 名）即可让已安装用户刷新缓存。
 */
"use strict";

var CACHE = "fit-pwa-v1";

var CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./js/utils.js",
  "./js/nutrition.js",
  "./js/parser.js",
  "./js/db.js",
  "./js/agent.js",
  "./js/localapi.js",
  "./js/app.js",
  "./vendor/vue.global.prod.js",
  "./vendor/chart.umd.min.js",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(CORE_ASSETS).catch(function (err) {
        // 个别资源失败不阻塞安装，下次 fetch 再补
        console.warn("SW precache partial:", err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return; // 跨域（如 CDN）不拦截

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok && (res.type === "basic" || res.type === "default")) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () {
        // 离线且未缓存：index.html 兜底
        if (req.mode === "navigate") return caches.match("./index.html");
        return new Response("离线不可用", { status: 503, statusText: "Offline" });
      });
    })
  );
});
