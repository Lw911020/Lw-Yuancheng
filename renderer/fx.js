'use strict';
/* 科技风粒子背景（可在设置里关掉） */
(function () {
  let cv = null, ctx = null, raf = null, ps = [], W = 0, H = 0, last = 0;
  function accent() {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      return v || '#12b886';
    } catch (e) { return '#12b886'; }
  }
  function rgba(hex, a) {
    const h = hex.replace('#', '');
    const n = h.length === 3 ? h.split('').map(function (c) { return c + c; }).join('') : h;
    const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function place() {
    if (!cv) return;
    var w = window.innerWidth;
    var hh = window.innerHeight;
    cv.style.left = "0px";
    cv.style.top = "0px";
    cv.style.width = w + "px";
    cv.style.height = hh + "px";
    W = cv.width = w;
    H = cv.height = hh;
    var n = Math.min(70, Math.max(20, Math.round(W * H / 32000)));
    ps = [];
    for (var i = 0; i < n; i++) ps.push({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .3, vy: (Math.random() - .5) * .3, r: Math.random() * 1.4 + .5 });
  }
  function resize() {
    place();
    const n = Math.min(90, Math.max(30, Math.round(W * H / 26000)));
    ps = [];
    for (let i = 0; i < n; i++) {
      ps.push({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35, r: Math.random() * 1.6 + .6 });
    }
  }
  function loop(t) {
    raf = requestAnimationFrame(loop);
    if (t - last < 33) return;      // 约 30fps，别太吃 CPU
    last = t;
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const ac = accent();
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, 6.2832);
      ctx.fillStyle = rgba(ac, .55);
      ctx.fill();
      for (let j = i + 1; j < ps.length; j++) {
        const q = ps[j], dx = p.x - q.x, dy = p.y - q.y, d2 = dx * dx + dy * dy;
        if (d2 < 20000) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
          ctx.strokeStyle = rgba(ac, (1 - d2 / 20000) * .16);
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }
  }
  const FX = {
    on: false,
    init: function () {
      if (cv) return;
      cv = document.createElement('canvas');
      cv.id = 'fx';
      document.body.appendChild(cv);
      ctx = cv.getContext('2d');
      window.addEventListener('resize', resize);
    },
    set: function (v) {
      this.on = !!v;
      document.documentElement.setAttribute('data-fx', this.on ? 'on' : 'off');
      if (this.on) { this.init(); cv.style.display = 'block'; resize(); if (!raf) raf = requestAnimationFrame(loop); }
      else { if (raf) { cancelAnimationFrame(raf); raf = null; } if (cv) cv.style.display = 'none'; }
    }
  };
  window.FX = FX;
})();
