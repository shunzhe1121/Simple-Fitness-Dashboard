/* ============================================================================
   光尘流场（ambient dust field）
   ----------------------------------------------------------------------------
   一块全屏 canvas，画的是「空气里的尘埃」：粒子沿一个缓慢变化的向量场漂移，
   鼠标周围会亮起一盏灯，走过的地方尘埃被轻轻推开。

   为什么不用 three.js / particle 库：
   · 这套界面要的是「有空气」，不是 3D 场景，用不上矩阵和光照管线；
   · 零依赖 = 零额外下载、零额外出错可能，代码不到 200 行；
   · 全部是 2D 的柔和光点，GPU 压力极小（一块 sprite 反复贴图，不建渐变）。

   性能与礼貌：
   · 只有窗口可见时才跑，切走即停；
   · 系统要求「减少动态效果」时只静态铺一层，不跑循环；
   · 帧率封顶 30fps —— 尘埃不需要 60fps，省电；
   · DPR 上限 2，4K 屏也不会把 canvas 画成 8 倍面积。
   ========================================================================== */

(function () {
  "use strict";

  const canvas = document.querySelector(".atmos");
  if (!canvas) return;

  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  const COUNT = 86;
  const MAX_DPR = 2;
  const FRAME_MS = 1000 / 30;

  let W = 0;
  let H = 0;
  let dpr = 1;
  let raf = 0;
  let running = false;
  let last = 0;
  let clock = 0;
  let dust = [];
  let dot = null;      // 粒子贴图
  let lamp = null;     // 鼠标光斑贴图
  let tint = [255, 255, 255];
  let accent = [255, 90, 50];

  const pointer = { x: -9999, y: -9999, on: false };

  /* -------------------------------------------------------------- 工具 */

  function readColor(name, fallback) {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    let m = v.match(/^#([0-9a-f]{6})$/i);
    if (m) {
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    m = v.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (m) return [+m[1], +m[2], +m[3]];
    return fallback;
  }

  function rgba(c, a) {
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";
  }

  /* 预渲染一张径向渐变贴图：之后每帧只是 drawImage，不再创建渐变对象 */
  function makeSprite(size, color) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const r = size / 2;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, rgba(color, 1));
    grad.addColorStop(0.35, rgba(color, 0.55));
    grad.addColorStop(1, rgba(color, 0));
    g.fillStyle = grad;
    g.beginPath();
    g.arc(r, r, r, 0, Math.PI * 2);
    g.fill();
    return c;
  }

  /* -------------------------------------------------------------- 尺寸 */

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function seed() {
    dust = new Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const depth = Math.random();               // 0 远 1 近
      dust[i] = {
        x: Math.random() * W,
        y: Math.random() * H,
        px: 0,
        py: 0,
        depth: depth,
        size: 1.2 + depth * 7 + Math.random() * 2,
        alpha: 0.05 + depth * 0.16 + Math.random() * 0.05,
        speed: 6 + depth * 16,                   // px / 秒
        phase: Math.random() * Math.PI * 2,
      };
    }
  }

  /* -------------------------------------------------------------- 配色 */

  function recolor() {
    // 暗色下尘埃发白，亮色下尘埃发灰——统一跟随正文色，两种主题都成立
    tint = readColor("--text", [245, 246, 248]);
    accent = readColor("--accent", [255, 90, 50]);
    dot = makeSprite(48, tint);
    lamp = makeSprite(256, accent);
  }

  /* -------------------------------------------------------------- 场 */

  function angleAt(x, y, ph) {
    const nx = x / Math.max(W, 1);
    const ny = y / Math.max(H, 1);
    return (
      Math.sin(nx * 2.1 + clock * 0.11 + ph) * 1.05 +
      Math.cos(ny * 1.7 - clock * 0.08) * 1.05
    );
  }

  function step(dt) {
    for (let i = 0; i < COUNT; i++) {
      const p = dust[i];
      const a = angleAt(p.x, p.y, p.phase);
      let vx = Math.cos(a) * p.speed;
      let vy = Math.sin(a) * p.speed * 0.7;

      // 鼠标推开：越近推力越大，衰减平滑
      if (pointer.on) {
        const dx = p.x - pointer.x;
        const dy = p.y - pointer.y;
        const d2 = dx * dx + dy * dy;
        const R = 170;
        if (d2 < R * R) {
          const d = Math.sqrt(d2) || 1;
          const f = (1 - d / R) * 46;
          vx += (dx / d) * f;
          vy += (dy / d) * f;
        }
      }

      p.px = p.x;
      p.py = p.y;
      p.x += vx * dt;
      p.y += vy * dt;

      // 环绕出界即从对面回来，不留边界
      if (p.x < -40) p.x = W + 40;
      else if (p.x > W + 40) p.x = -40;
      if (p.y < -40) p.y = H + 40;
      else if (p.y > H + 40) p.y = -40;
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // 鼠标灯：一层很淡的强调色光晕，走到哪儿亮到哪儿
    if (pointer.on && lamp) {
      const S = 520;
      ctx.globalAlpha = 0.1;
      ctx.drawImage(lamp, pointer.x - S / 2, pointer.y - S / 2, S, S);
    }

    // 尘埃：先画远的（暗、小），再画近的（亮、大）
    for (let i = 0; i < COUNT; i++) {
      const p = dust[i];
      const s = p.size * 4;
      ctx.globalAlpha = p.alpha;
      ctx.drawImage(dot, p.x - s / 2, p.y - s / 2, s, s);
    }

    ctx.globalAlpha = 1;
  }

  /* -------------------------------------------------------------- 循环 */

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - last < FRAME_MS) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    clock += dt;
    step(dt);
    draw();
  }

  function motionOff() {
    if (window.FX && typeof window.FX.motionOff === "function") {
      return window.FX.motionOff();
    }
    return (
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function start() {
    if (running || motionOff()) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function sync() {
    if (document.visibilityState === "hidden" || motionOff()) stop();
    else start();
  }

  /* -------------------------------------------------------------- 事件 */

  window.addEventListener("resize", function () {
    resize();
    if (!running) draw();
  });

  window.addEventListener(
    "pointermove",
    function (e) {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.on = true;
    },
    { passive: true }
  );

  window.addEventListener("pointerleave", function () {
    pointer.on = false;
  });

  document.addEventListener("visibilitychange", sync);

  // 主题切换会改变尘埃颜色，重算贴图
  new MutationObserver(function () {
    recolor();
    if (!running) draw();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-motion"],
  });

  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) {
      mq.addEventListener("change", function () {
        recolor();
        sync();
      });
    }
  }

  resize();
  recolor();
  draw();
  sync();
})();
