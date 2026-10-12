'use strict';
/* 远程控制台 · 车机投屏（ADB screencap 连续抓帧，PNG 直接显示） */
(function () {
  const rc = window.rc;
  function E(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(label, fn, cls) { const b = E('button', 'btn' + (cls ? ' ' + cls : ''), label); b.onclick = fn; return b; }

  const CAM_APPS = [
    { pkg: 'com.byd.auto_camera', name: '自动摄像头（全景/转向）' },
    { pkg: 'com.byd.bydcamera', name: 'BYD 相机' },
    { pkg: 'com.byd.cameramanager', name: '相机管理' }
  ];

  window.PANELS = window.PANELS || {};
  window.PANELS.carcast = function (pane) {
    const APP = window.APP;
    const st = { running: false, frames: 0, fps: 2, last: 0, sw: 1080, sh: 1920, dragging: false };
    function pngSize(b64) {
      try {
        const head = atob(String(b64).slice(0, 120));
        const w = (head.charCodeAt(16) << 24 | head.charCodeAt(17) << 16 | head.charCodeAt(18) << 8 | head.charCodeAt(19)) >>> 0;
        const h = (head.charCodeAt(20) << 24 | head.charCodeAt(21) << 16 | head.charCodeAt(22) << 8 | head.charCodeAt(23)) >>> 0;
        return (w > 100 && h > 100) ? [w, h] : null;
      } catch (e) { return null; }
    }

    const box = E('div', 'panel');
    pane.appendChild(box);
    box.appendChild(E('h2', null, '车机投屏'));
    box.appendChild(E('div', 'desc', '车机屏幕（含 360 全景），不需要 root'));
    

    const bar = E('div', 'row-flex'); bar.style.margin = '10px 0';
    const bState = E('span', 'badge', '未投屏');
    const bFrame = E('span', 'badge', '帧 0');
    bar.appendChild(bState); bar.appendChild(bFrame);
    box.appendChild(bar);

    const bar2 = E('div', 'row-flex'); bar2.style.margin = '6px 0';
    const toggle = btn('▶ 开始投屏', function () { if (st.running) stop(); else start(); }, 'primary');
    toggle.style.minWidth = '120px';
    bar2.appendChild(toggle);
    const panBtn = btn('◎ 一键看全景', async function () {
      const r = await rc.carLaunch('com.byd.auto_camera');
      APP.toast(r.message, r.ok ? undefined : 'fail');
      log((r.ok ? '已拉起 ' : '拉起失败 ') + r.message + '\n');
    });
    bar2.appendChild(panBtn);
    const mkSel = function (label, opts, key, def) {
      const w = E('label', 'badge');
      w.style.cssText = 'padding:3px 8px;display:flex;gap:5px;align-items:center';
      w.appendChild(document.createTextNode(label));
      const s = E('select', 'txt');
      s.style.padding = '1px 5px';
      opts.forEach(function (o) { const op = E('option', null, String(o)); op.value = String(o); s.appendChild(op); });
      s.value = String(def);
      s.onchange = function () { st[key] = Number(s.value); if (st.running) { stop(); setTimeout(start, 300); } };
      w.appendChild(s);
      return w;
    };
    bar2.appendChild(mkSel('帧率', [1, 2, 3, 5], 'fps', 2));
    // 其它相机 App 也放一个下拉
    const aw = E('label', 'badge');
    aw.style.cssText = 'padding:3px 8px;display:flex;gap:5px;align-items:center';
    aw.appendChild(document.createTextNode('其它画面'));
    const asel = E('select', 'txt');
    asel.style.padding = '1px 5px';
    CAM_APPS.forEach(function (a) { const o = E('option', null, a.name); o.value = a.pkg; asel.appendChild(o); });
    aw.appendChild(asel);
    aw.appendChild(btn('▷ 打开', async function () {
      const r = await rc.carLaunch(asel.value);
      APP.toast(r.message, r.ok ? undefined : 'fail');
      log((r.ok ? '已拉起 ' : '拉起失败 ') + r.message + '\n');
    }, 'small'));
    bar2.appendChild(aw);
    // 常用按键
    [['返回', 4], ['主页', 3], ['任务', 187]].forEach(function (k) {
      bar2.appendChild(btn(k[0], function () { rc.carKey(k[1]); }, 'small'));
    });
    box.appendChild(bar2);

    function syncButtons() {
      toggle.textContent = st.running ? '停止投屏' : '开始投屏';
      toggle.className = 'btn ' + (st.running ? 'danger' : 'primary');
      bState.textContent = st.running ? '投屏中' : '未投屏';
      bState.className = 'badge ' + (st.running ? 'ok' : '');
    }

    const wrap = E('div');
    wrap.style.cssText = 'width:100%;max-width:1000px;background:#000;border:1px solid var(--line);border-radius:10px;overflow:hidden';
    const img = E('img');
    img.style.cssText = 'display:block;width:100%;height:auto';
    img.draggable = false;
    wrap.appendChild(img);
    wrap.style.cursor = 'crosshair';
    const dot = E('div');
    dot.style.cssText = 'position:absolute;width:16px;height:16px;border-radius:50%;background:rgba(18,184,134,.85);transform:translate(-50%,-50%);opacity:0;pointer-events:none;border:2px solid #fff';
    wrap.appendChild(dot);
    box.appendChild(wrap);
    

    function toScreen(ev) {
      const r = img.getBoundingClientRect();
      const u = (ev.clientX - r.left) / r.width;
      const v = (ev.clientY - r.top) / r.height;
      return [u * st.sw, v * st.sh];
    }
    function showDot(ev) {
      const r = wrap.getBoundingClientRect();
      dot.style.left = (ev.clientX - r.left) + 'px';
      dot.style.top = (ev.clientY - r.top) + 'px';
      dot.style.opacity = '1';
    }
    img.addEventListener('mousedown', async function (ev) {
      ev.preventDefault();
      st.dragging = true; showDot(ev);
      st.x0 = ev.clientX; st.y0 = ev.clientY;
      const p = toScreen(ev);
      rc.carTap(p[0], p[1]);
    });
    img.addEventListener('mousemove', function (ev) { if (st.dragging) showDot(ev); });
    window.addEventListener('mouseup', async function (ev) {
      if (!st.dragging) return;
      st.dragging = false;
      const dx = Math.abs(ev.clientX - (st.x0 || 0)), dy = Math.abs(ev.clientY - (st.y0 || 0));
      if (dx > 12 || dy > 12) {                       // 拖动了 = 滑动
        const a = toScreen({ clientX: st.x0, clientY: st.y0 });
        const b = toScreen(ev);
        rc.carSwipe(a[0], a[1], b[0], b[1], 250);
      }
      setTimeout(function () { dot.style.opacity = '0'; }, 250);
    });

    const out = E('div', 'out');
    out.style.maxHeight = '110px';
    box.appendChild(out);
    function log(t) { out.textContent += t; if (out.textContent.length > 2000) out.textContent = out.textContent.slice(-1500); out.scrollTop = out.scrollHeight; }

    async function start() {
      APP.setBusy('正在连接车机画面…');
      try {
        await rc.carCastStart({ fps: st.fps });
        st.running = true; st.frames = 0;
        syncButtons();
        log('已开始抓车机屏幕 ' + st.fps + ' fps\n');
      } catch (e) { APP.toast(APP.describeErr(e), 'fail'); log('启动失败：' + APP.describeErr(e) + '\n'); }
      finally { APP.clearBusy(); }
    }
    async function stop() {
      await rc.carCastStop();
      st.running = false; syncButtons();
      log('已停止\n');
    }

    rc.onCarFrame(function (p) {
      if (!p || !p.data) return;
      const sz = pngSize(p.data);
      if (sz) { st.sw = sz[0]; st.sh = sz[1]; }
      img.src = 'data:image/png;base64,' + p.data;
      const now = Date.now();
      if (now - st.last > 600) { st.last = now; st.frames = p.n; bFrame.textContent = '帧 ' + p.n + '（约 ' + Math.round(p.data.length * 0.75 / 1024) + ' KB/帧）'; }
    });
    rc.onCarLog(function (p) { if (p && p.text) log(p.text); });
    rc.onCarExit(function () { st.running = false; syncButtons(); log('[抓屏流已结束]\n'); });

    syncButtons();
  };
})();
