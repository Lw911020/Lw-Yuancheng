'use strict';
/* 远程控制台 · C3 投屏（uihook.so + glReadPixels → /dev/shm/ui.rgb → JPEG 流）
   画面区域可以直接点/拖 = 触摸 C3 */
(function () {
  const rc = window.rc;
  function E(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(label, fn, cls) { const b = E('button', 'btn' + (cls ? ' ' + cls : ''), label); b.onclick = fn; return b; }

  window.PANELS = window.PANELS || {};
  window.PANELS.c3cast = function (pane) {
    const APP = window.APP;
    const st = { running: false, frames: 0, fps: 10, wid: 640, q: 65, last: 0, dragging: false, touchReady: false, src: 'ui', stream: 'road',
      rot: (APP.state.cfg && APP.state.cfg.castRot) || '270' };   // 实机校准结果：270°
    const ROT = {
      '90':  function (u, v) { return [u, v]; },
      '270': function (u, v) { return [1 - u, 1 - v]; },
      '0':   function (u, v) { return [v, 1 - u]; },
      '180': function (u, v) { return [1 - v, u]; }
    };

    const box = E('div', 'panel');
    pane.appendChild(box);
    box.appendChild(E('h2', null, 'C3 投屏'));
    box.appendChild(E('div', 'desc', '点画面可以直接操作 C3'));

    const bar = E('div', 'row-flex'); bar.style.margin = '10px 0';
    const bHook = E('span', 'badge', '钩子 ?');
    const bFlag = E('span', 'badge', '开关 ?');
    const bFrame = E('span', 'badge', '帧 0');
    bar.appendChild(bHook); bar.appendChild(bFlag); bar.appendChild(bFrame);
    box.appendChild(bar);

    const bar2 = E('div', 'row-flex'); bar2.style.margin = '6px 0';
    // 只有一个按钮：没投屏时是绿色"开始投屏"，投屏中是红色"停止投屏"，不存在"两个都像选中"
    const toggleBtn = btn('▶ 开始投屏', function () { if (st.running) stop(); else start(); }, 'primary');
    toggleBtn.style.minWidth = '120px';
    bar2.appendChild(toggleBtn);
    function syncButtons() {
      toggleBtn.textContent = st.running ? '停止投屏' : '开始投屏';
      toggleBtn.className = 'btn ' + (st.running ? 'danger' : 'primary');
      toggleBtn.disabled = false;
    }
    bar2.appendChild(btn('安装钩子', async function () {
      APP.setBusy('正在安装投屏钩子（编译 + 改 openpilot 配置）…');
      try {
        const r = await rc.castProvision();
        APP.toast(r.message, r.ok ? undefined : 'fail');
        if (r.steps) r.steps.forEach(function (s) { APP.toast(s); });
      } catch (e) { APP.toast(APP.describeErr(e), 'fail'); }
      finally { APP.clearBusy(); await refresh(); }
    }));
    bar2.appendChild(btn('刷新状态', refresh));
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
    // 来源：截 UI 画面 / 摄像头原画
    const sw = E('label', 'badge');
    sw.style.cssText = 'padding:3px 8px;display:flex;gap:5px;align-items:center';
    sw.appendChild(document.createTextNode('来源'));
    const ssel = E('select', 'txt');
    ssel.style.padding = '1px 5px';
    [['ui', '车机画面（UI）'], ['cam', '摄像头原画']].forEach(function (o) {
      const op = E('option', null, o[1]); op.value = o[0]; ssel.appendChild(op);
    });
    ssel.onchange = function () {
      st.src = ssel.value;
      st.q = st.src === 'cam' ? 70 : 65;
      qsel.value = String(st.q);
      if (st.running) { stop(); setTimeout(start, 400); }
    };
    sw.appendChild(ssel);
    bar2.appendChild(sw);
    bar2.appendChild(mkSel('帧率', [5, 8, 10, 15], 'fps', 10));
    bar2.appendChild(mkSel('宽度', [480, 640, 800, 1024], 'wid', 640));
    const qsel = mkSel('画质', [50, 65, 70, 80], 'q', 65);
    bar2.appendChild(qsel);
    const rw = E('label', 'badge');
    rw.style.cssText = 'padding:3px 8px;display:flex;gap:5px;align-items:center';
    rw.appendChild(document.createTextNode('触点方向'));
    const rsel = E('select', 'txt');
    rsel.style.padding = '1px 5px';
    ['90', '270', '0', '180'].forEach(function (r) { const o = E('option', null, r + '°'); o.value = r; rsel.appendChild(o); });
    rsel.value = st.rot;
    rsel.onchange = function () {
      st.rot = rsel.value;
      rc.cfgSet({ castRot: st.rot });
      if (APP.state.cfg) APP.state.cfg.castRot = st.rot;
      APP.toast('触点方向已切到 ' + st.rot + '°（已记住）');
    };
    rw.appendChild(rsel);
    bar2.appendChild(rw);
    box.appendChild(bar2);

    // 画面区
    const wrap = E('div');
    wrap.style.cssText = 'position:relative;width:100%;max-width:1000px;background:#000;border:1px solid var(--line);border-radius:10px;overflow:hidden;cursor:crosshair';
    const img = E('img');
    img.style.cssText = 'display:block;width:100%;height:auto;user-select:none';
    img.draggable = false;
    wrap.appendChild(img);
    const dot = E('div');
    dot.style.cssText = 'position:absolute;width:16px;height:16px;border-radius:50%;background:rgba(18,184,134,.85);transform:translate(-50%,-50%);opacity:0;pointer-events:none;border:2px solid #fff';
    wrap.appendChild(dot);
    const grad = E('div');
    grad.style.cssText = 'display:flex;justify-content:space-between;color:var(--fg-dim);font-size:11px;padding:2px 4px';
    const gL = E('span', null, '0%'); const gR = E('span', null, '100%');
    grad.appendChild(gL); grad.appendChild(gR);
    box.appendChild(wrap);
    box.appendChild(grad);

    const out = E('div', 'out');
    out.style.maxHeight = '120px';
    box.appendChild(out);

    function log(t) { out.textContent += t; if (out.textContent.length > 3000) out.textContent = out.textContent.slice(-2000); out.scrollTop = out.scrollHeight; }

    async function refresh() {
      try {
        const s = await rc.castStatus();
        bHook.textContent = s.hookSo ? (s.inMaps ? '钩子 已加载' : '钩子 未加载') : '钩子 未安装';
        bHook.className = 'badge ' + (s.inMaps ? 'ok' : (s.hookSo ? 'warn' : 'fail'));
        bFlag.textContent = s.flag ? '开关 已开' : '开关 关';
        bFlag.className = 'badge ' + (s.flag ? 'ok' : '');
        bFrame.textContent = st.running ? ('投屏中 · 帧 ' + st.frames) : ('未投屏 · 帧 ' + st.frames);
        bFrame.className = 'badge ' + (st.running ? 'ok' : '');
        syncButtons();
        return s;
      } catch (e) { log('状态失败 ' + APP.describeErr(e) + '\n'); return null; }
    }

    async function start() {
      APP.setBusy('正在建立投屏…');
      try {
        await rc.castStart({ fps: st.fps, wid: st.wid, q: st.q, source: st.src, stream: st.stream });
        st.running = true;
        st.frames = 0;
        syncButtons();
        log('投屏已开始 ' + (st.src === 'cam' ? '摄像头原画' : '车机画面') + ' ' + st.wid + 'px @' + st.fps + 'fps\n');
      } catch (e) { APP.toast(APP.describeErr(e), 'fail'); log('启动失败：' + APP.describeErr(e) + '\n'); }
      finally { APP.clearBusy(); refresh(); }
    }
    async function stop() {
      await rc.castStop();
      st.running = false;
      log('投屏已停止\n');
      refresh();
    }

    rc.onCastFrame(function (p) {
      if (!p || !p.data) return;
      st.frames = p.n;
      img.src = 'data:image/jpeg;base64,' + p.data;
      const now = Date.now();
      if (now - st.last > 500) { st.last = now; st.frames = p.n; bFrame.textContent = '投屏中 · 帧 ' + p.n; bFrame.className = 'badge ok'; }
    });
    rc.onCastLog(function (p) { if (p && p.text) log(p.text); });
    rc.onCastExit(function () { st.running = false; log('[投屏流已结束]\n'); refresh(); });

    // 画面区 = 触摸板
    async function ensureTouch() {
      if (st.touchReady) return true;
      try { await rc.touchOpen('c3'); st.touchReady = true; return true; }
      catch (e) { APP.toast('触摸通道打开失败：' + APP.describeErr(e), 'fail'); return false; }
    }
    function uv(ev) {
      const r = img.getBoundingClientRect();
      let u = (ev.clientX - r.left) / r.width;
      let v = (ev.clientY - r.top) / r.height;
      u = Math.min(1, Math.max(0, u));
      v = Math.min(1, Math.max(0, v));
      return ROT[st.rot](u, v);
    }
    function showDot(ev) {
      const r = wrap.getBoundingClientRect();
      dot.style.left = (ev.clientX - r.left) + 'px';
      dot.style.top = (ev.clientY - r.top) + 'px';
      dot.style.opacity = '1';
    }
    async function send(cmd) { await ensureTouch(); rc.touchSend(cmd); }

    img.addEventListener('mousedown', async function (ev) {
      ev.preventDefault();
      st.dragging = true;
      showDot(ev);
      const p = uv(ev);
      await send('down ' + p[0].toFixed(4) + ' ' + p[1].toFixed(4));
    });
    img.addEventListener('mousemove', function (ev) {
      if (!st.dragging) return;
      showDot(ev);
      const p = uv(ev);
      rc.touchSend('move ' + p[0].toFixed(4) + ' ' + p[1].toFixed(4));
    });
    window.addEventListener('mouseup', function () {
      if (!st.dragging) return;
      st.dragging = false;
      rc.touchSend('up');
      setTimeout(function () { dot.style.opacity = '0'; }, 250);
    });

    refresh();
  };
})();
