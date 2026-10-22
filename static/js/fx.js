/* fx.js —— 动效与音效层（不依赖框架，暴露 window.FX）
 *
 * 设计语言跟界面一致：像是在操作一台测量仪器，而不是给按钮加弹跳。
 *  - 数字从刻度起点扫到目标值，像仪表上电；
 *  - 环形进度带一点过冲再落定，像指针靠阻尼停住；
 *  - 按钮是 0.97 的物理按压，不是发光；
 *  - 音效全部用 WebAudio 现场合成，不下载任何音频文件，整套约 0 字节资源。
 *
 * 用户偏好存在 localStorage：
 *   fit-sound   on | off
 *   fit-sound-vol  0-100
 *   fit-motion  auto | full | reduced
 */
(function () {
  "use strict";

  if (window.FX) return;

  const LS_SOUND = "fit-sound";
  const LS_VOL = "fit-sound-vol";
  const LS_MOTION = "fit-motion";

  // ------------------------------------------------------------------ 偏好

  function pref(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null || v === "" ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function setPref(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch (e) {
      /* 隐私模式下写不进去就算了 */
    }
  }

  const systemReduced = () =>
    !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  function motionOff() {
    const mode = pref(LS_MOTION, "auto");
    if (mode === "reduced") return true;
    if (mode === "full") return false;
    return systemReduced();
  }

  // 把偏好同步到 <html data-motion>，CSS 靠它总开关
  function applyMotionAttr() {
    const mode = pref(LS_MOTION, "auto");
    const root = document.documentElement;
    if (mode === "auto") root.removeAttribute("data-motion");
    else root.setAttribute("data-motion", mode);
  }

  function soundOn() {
    return pref(LS_SOUND, "on") !== "off";
  }

  function volume() {
    const v = Number(pref(LS_VOL, "55"));
    if (!isFinite(v)) return 0.55;
    return Math.min(1, Math.max(0, v / 100));
  }

  // ------------------------------------------------------------------ 音频

  let ac = null;
  let master = null;
  let noiseBuf = null;

  function audio() {
    if (ac) return ac;
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    try {
      ac = new C();
    } catch (e) {
      return null;
    }
    master = ac.createGain();
    master.gain.value = 0.6 * volume();
    master.connect(ac.destination);
    return ac;
  }

  function noiseBuffer(c) {
    if (noiseBuf) return noiseBuf;
    const len = Math.floor(c.sampleRate * 0.3);
    noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  // 一段振荡器音，可选频率滑音与低通
  function tone(c, t, o) {
    const osc = c.createOscillator();
    osc.type = o.type || "sine";
    osc.frequency.setValueAtTime(o.f0, t);
    if (o.f1 != null) osc.frequency.exponentialRampToValueAtTime(Math.max(24, o.f1), t + o.dur);

    const g = c.createGain();
    const attack = o.attack || 0.004;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + o.dur);

    let node = osc;
    if (o.filter) {
      const bq = c.createBiquadFilter();
      bq.type = o.filter.type || "lowpass";
      bq.frequency.value = o.filter.freq || 1000;
      bq.Q.value = o.filter.q == null ? 0.7 : o.filter.q;
      osc.connect(bq);
      node = bq;
    }
    node.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + attack + o.dur + 0.03);
  }

  // 一段带通噪声，可做频率扫掠（滑轨、气流、触点）
  function hiss(c, t, o) {
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c);
    src.loop = true;

    const bq = c.createBiquadFilter();
    bq.type = o.type || "bandpass";
    bq.Q.value = o.q == null ? 1.2 : o.q;
    bq.frequency.setValueAtTime(o.freq || 2400, t);
    if (o.sweep) bq.frequency.exponentialRampToValueAtTime(o.sweep, t + o.dur);

    const g = c.createGain();
    const attack = o.attack || 0.002;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);

    src.connect(bq).connect(g).connect(master);
    src.start(t);
    src.stop(t + o.dur + 0.03);
  }

  // 音色表：都是短促的机械声，没有一个「音符」式的旋律
  const SFX = {
    // 轻触 —— 一次极短的触点声
    tap(c, t) {
      hiss(c, t, { dur: 0.032, peak: 0.07, freq: 2700, q: 1.8 });
    },
    // 换页 —— 低频推进，高频余韵
    page(c, t) {
      tone(c, t, { type: "sine", f0: 400, f1: 250, dur: 0.1, peak: 0.06, attack: 0.005 });
      hiss(c, t + 0.012, { dur: 0.055, peak: 0.04, freq: 3200, q: 0.9 });
    },
    // 入库成功 —— 继电器闭合，再叠一记上行确认音
    commit(c, t) {
      tone(c, t, { type: "sine", f0: 208, f1: 130, dur: 0.15, peak: 0.18, attack: 0.003 });
      hiss(c, t, { dur: 0.038, peak: 0.07, freq: 2100, q: 1.2 });
      tone(c, t + 0.048, { type: "triangle", f0: 620, f1: 840, dur: 0.1, peak: 0.055, attack: 0.007 });
    },
    // 失败 —— 两声下行的钝响，不刺耳
    error(c, t) {
      tone(c, t, {
        type: "square", f0: 248, f1: 168, dur: 0.12, peak: 0.06, attack: 0.006,
        filter: { type: "lowpass", freq: 1000, q: 0.7 },
      });
      tone(c, t + 0.125, {
        type: "square", f0: 184, f1: 122, dur: 0.16, peak: 0.045, attack: 0.006,
        filter: { type: "lowpass", freq: 820, q: 0.7 },
      });
    },
    // 面板打开 / 收起 —— 气动滑轨
    open(c, t) {
      hiss(c, t, { dur: 0.17, peak: 0.045, freq: 560, sweep: 2300, q: 0.85 });
    },
    close(c, t) {
      hiss(c, t, { dur: 0.16, peak: 0.038, freq: 2000, sweep: 520, q: 0.85 });
    },
    // 数值落定 —— 一声极轻的刻度
    tick(c, t) {
      tone(c, t, { type: "sine", f0: 1500, dur: 0.026, peak: 0.032, attack: 0.002 });
    },
    // 文件落入 —— 重一点的落位
    drop(c, t) {
      tone(c, t, { type: "sine", f0: 118, f1: 60, dur: 0.19, peak: 0.16, attack: 0.003 });
      hiss(c, t, { dur: 0.09, peak: 0.055, freq: 1400, q: 0.7 });
    },
  };

  // 同一个音 55ms 内不重复，避免连点变成机关枪
  const lastAt = {};

  function play(name) {
    if (!soundOn()) return;
    const fn = SFX[name];
    if (!fn) return;
    const now = performance.now();
    if (lastAt[name] && now - lastAt[name] < 55) return;
    lastAt[name] = now;

    const c = audio();
    if (!c) return;
    if (c.state === "suspended") c.resume().catch(function () {});
    try {
      fn(c, c.currentTime + 0.001);
    } catch (e) {
      /* 音频线程被回收时静默降级 */
    }
  }

  function setSound(on) {
    setPref(LS_SOUND, on ? "on" : "off");
    if (on) unlock();
  }

  function setVolume(pct) {
    setPref(LS_VOL, Math.min(100, Math.max(0, Math.round(pct))));
    if (master) master.gain.value = 0.6 * volume();
  }

  // 浏览器要求音频在用户手势里初始化，第一次点屏幕时解锁
  let unlocked = false;
  function unlock() {
    if (unlocked) return;
    const c = audio();
    if (!c) return;
    unlocked = true;
    if (c.state === "suspended") c.resume().catch(function () {});
  }

  // ------------------------------------------------------------------ 数字

  function toNum(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  }

  function paint(el, n) {
    const dec = parseInt(el.getAttribute("data-dec") || "0", 10) || 0;
    const pre = el.getAttribute("data-prefix") || "";
    const suf = el.getAttribute("data-suffix") || "";
    el.textContent = pre + n.toFixed(dec) + suf;
  }

  function tween(el, from, to, dur) {
    if (el.__fxRaf) {
      cancelAnimationFrame(el.__fxRaf);
      el.__fxRaf = 0;
    }
    if (motionOff() || dur <= 0) {
      paint(el, to);
      return;
    }
    const t0 = performance.now();
    const step = function () {
      const t = Math.min(1, (performance.now() - t0) / dur);
      // easeOutQuart：起手快、收尾慢，像指针靠阻尼停住
      const p = 1 - Math.pow(1 - t, 4);
      paint(el, from + (to - from) * p);
      if (t < 1) {
        el.__fxRaf = requestAnimationFrame(step);
      } else {
        el.__fxRaf = 0;
      }
    };
    el.__fxRaf = requestAnimationFrame(step);
  }

  // Vue 指令：v-num="value"，data-dec 控制小数位，data-prefix / data-suffix 拼前后缀。
  // 元素内部不能写插值，文本完全由指令接管，否则和 Vue 的 patch 打架。
  const numDirective = {
    mounted(el, binding) {
      const to = toNum(binding.value);
      el.__fxTo = to;
      if (to === null) {
        el.textContent = el.getAttribute("data-empty") || "—";
        return;
      }
      // 首次挂载从 0 扫到目标值（仪表上电）
      tween(el, 0, to, 720);
    },
    updated(el, binding) {
      const to = toNum(binding.value);
      if (to === el.__fxTo) return;
      const from = el.__fxTo === null ? 0 : el.__fxTo;
      el.__fxTo = to;
      if (to === null) {
        el.textContent = el.getAttribute("data-empty") || "—";
        return;
      }
      tween(el, from, to, 520);
    },
    unmounted(el) {
      if (el.__fxRaf) cancelAnimationFrame(el.__fxRaf);
    },
  };

  // ------------------------------------------------------------------ 微交互

  const INK_HOSTS = ["primary-btn", "ghost-btn", "danger-btn", "ok-btn", "fab"];

  function makeInk(btn, ev) {
    if (btn.classList.contains("fx-ink-clip")) return;
    // 已经定位的元素（fixed/absolute）只加裁剪，不改 position，否则会把浮窗按钮拉回文档流
    if (getComputedStyle(btn).position === "static") btn.classList.add("fx-ink-pos");
    btn.classList.add("fx-ink-clip");

    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2.1;
    const span = document.createElement("span");
    span.className = "fx-ink";
    span.style.width = span.style.height = size + "px";
    span.style.left = ev.clientX - rect.left + "px";
    span.style.top = ev.clientY - rect.top + "px";
    btn.appendChild(span);
    setTimeout(function () {
      span.remove();
      btn.classList.remove("fx-ink-clip", "fx-ink-pos");
    }, 620);
  }

  function inkHost(btn) {
    for (let i = 0; i < INK_HOSTS.length; i++) {
      if (btn.classList.contains(INK_HOSTS[i])) return true;
    }
    return false;
  }

  // 新插入的一行闪一下：左侧亮起一道强调色，像扫描到该行
  function flash(el, ms) {
    if (!el) return;
    el.classList.remove("fx-new");
    void el.offsetWidth; // 强制重排，让动画能重复触发
    el.classList.add("fx-new");
    setTimeout(function () {
      el.classList.remove("fx-new");
    }, ms || 1400);
  }

  function flashById(id, ms) {
    if (id == null) return;
    const el = document.querySelector('[data-rid="' + id + '"]');
    flash(el, ms);
  }

  // 删除前先让它退出：淡出 + 右移，再交给调用方真正删数据
  function leave(el, cb) {
    if (!el || motionOff()) {
      if (cb) cb();
      return;
    }
    el.classList.add("fx-leaving");
    let done = false;
    const finish = function () {
      if (done) return;
      done = true;
      if (cb) cb();
    };
    el.addEventListener("animationend", finish, { once: true });
    setTimeout(finish, 340);
  }

  function byId(id) {
    return id == null ? null : document.querySelector('[data-rid="' + id + '"]');
  }

  // ------------------------------------------------------------------ 装配

  function attachScroller() {
    const sc = document.querySelector(".scroll");
    const main = document.querySelector(".main");
    if (!sc || !main) return;
    if (sc.__fxScroll) return;
    sc.__fxScroll = true;
    const sync = function () {
      main.classList.toggle("is-scrolled", sc.scrollTop > 3);
    };
    sc.addEventListener("scroll", sync, { passive: true });
    sync();
  }

  function attachGlobal() {
    if (document.__fxBound) return;
    document.__fxBound = true;

    // 音频解锁放在最前面，用户第一次碰屏幕就建好 AudioContext
    const unlockOnce = function () {
      unlock();
      document.removeEventListener("pointerdown", unlockOnce, true);
    };
    document.addEventListener("pointerdown", unlockOnce, true);

    document.addEventListener(
      "pointerdown",
      function (ev) {
        const btn = ev.target.closest && ev.target.closest("button");
        if (!btn || btn.disabled || ev.button > 0) return;
        if (inkHost(btn)) makeInk(btn, ev);
      },
      true
    );

    // 点击音效统一用捕获阶段，避免被各处的 stopPropagation 吞掉
    document.addEventListener(
      "click",
      function (ev) {
        const btn = ev.target.closest && ev.target.closest("button, .file-btn");
        if (!btn || btn.disabled) return;
        if (btn.classList.contains("nav-item")) play("page");
        else if (btn.classList.contains("fab")) play(btn.classList.contains("open") ? "close" : "open");
        else play("tap");
      },
      true
    );
  }

  function init() {
    applyMotionAttr();
    attachGlobal();
    attachScroller();
  }

  window.FX = {
    init: init,
    refreshScroll: attachScroller,
    // 动效
    numDirective: numDirective,
    motionOff: motionOff,
    getMotion: function () {
      return pref(LS_MOTION, "auto");
    },
    setMotion: function (mode) {
      setPref(LS_MOTION, mode);
      applyMotionAttr();
    },
    flash: flash,
    flashById: flashById,
    leave: leave,
    byId: byId,
    // 音效
    sound: {
      play: play,
      on: soundOn,
      setOn: setSound,
      volume: function () {
        return Math.round(volume() * 100);
      },
      setVolume: setVolume,
      unlock: unlock,
    },
    // 手机上给一次短促触感，桌面浏览器忽略
    haptic: function (ms) {
      if (navigator.vibrate) {
        try {
          navigator.vibrate(ms || 8);
        } catch (e) {
          /* 不支持就算了 */
        }
      }
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
