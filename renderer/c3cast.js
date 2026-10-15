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
      mode: (APP.state.cfg && APP.state.cfg.castMode) || 'h264', bitrate: '800k', gop: 20,
      touch: (APP.state.cfg && APP.state.cfg.castTouch) || 'v' };   // 触屏调整：normal / v(上下) / h(左右) / diag(对角)
    // 默认参数：H.264 走全分辨率/20fps；MJPEG 走 480px（老链路带宽小）
    if (st.mode === 'h264') { st.wid = 1024; st.fps = 20; } else { st.wid = 480; st.fps = 10; st.q = 50; }
    // 发给 rc_touch.py 的 (u', v')；脚本内部换算成面板坐标 fx = v'、fy = 1 - u'。
    // 面板是竖屏(1080x2160)、屏幕是横屏(2160x1080)，所以真实落点 (fx,fy) 必然属于"对角互换"那一族：
    //   normal → (fx,fy) = (v, u)      上下互换 → (1-v, u)
    //   左右互换 → (v, 1-u)            对角互换 → (1-v, 1-u)
    // 2026-10-14 实机反馈：默认取「上下互换」。
    const TOUCH = {
      normal: function (u, v) { return [1 - u, v]; },
      v:      function (u, v) { return [1 - u, 1 - v]; },   // 上下互换
      h:      function (u, v) { return [u, v]; },           // 左右互换
      diag:   function (u, v) { return [u, 1 - v]; }        // 对角互换
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
      w.sel = s;
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
    // 模式：H.264（低延迟，WebCodecs 解码）/ MJPEG（兼容老链路）
    const mw = E('label', 'badge');
    mw.style.cssText = 'padding:3px 8px;display:flex;gap:5px;align-items:center';
    mw.appendChild(document.createTextNode('模式'));
    const msel = E('select', 'txt');
    msel.style.padding = '1px 5px';
    [['h264', 'H.264 低延迟'], ['mjpeg', 'MJPEG 兼容']].forEach(function (o) { const op = E('option', null, o[1]); op.value = o[0]; msel.appendChild(op); });
    msel.value = st.mode;
    msel.onchange = function () {
      st.mode = msel.value;
      rc.cfgSet({ castMode: st.mode });
      if (st.mode === 'h264') { st.wid = 1024; st.fps = 20; } else { st.wid = 480; st.fps = 10; st.q = 50; }
      if (widSel && widSel.sel) widSel.sel.value = String(st.wid);
      if (fpsSel && fpsSel.sel) fpsSel.sel.value = String(st.fps);
      if (qsel && qsel.sel) qsel.sel.value = String(st.q);
      APP.toast(st.mode === 'h264' ? '已切到 H.264（1024px / 20fps）' : '已切到 MJPEG（480px / 10fps）');
      if (st.running) { stop(); setTimeout(start, 400); }
    };
    mw.appendChild(msel);
    bar2.appendChild(mw);
    const fpsSel = mkSel('帧率', [8, 10, 15, 20, 25, 30], 'fps', st.fps);
    bar2.appendChild(fpsSel);
    const widSel = mkSel('宽度', [480, 640, 800, 1024], 'wid', st.wid);
    bar2.appendChild(widSel);
    const qsel = mkSel('画质', [50, 65, 70, 80], 'q', st.q);
    bar2.appendChild(qsel);
    const rw = E('label', 'badge');
    rw.style.cssText = 'padding:3px 8px;display:flex;gap:5px;align-items:center';
    rw.appendChild(document.createTextNode('触屏调整'));
    const rsel = E('select', 'txt');
    rsel.style.padding = '1px 5px';
    [['normal', '正常'], ['v', '上下互换'], ['h', '左右互换'], ['diag', '对角互换']].forEach(function (o) { const op = E('option', null, o[1]); op.value = o[0]; rsel.appendChild(op); });
    rsel.value = st.touch;
    rsel.onchange = function () {
      st.touch = rsel.value;
      rc.cfgSet({ castTouch: st.touch });
      APP.toast('触屏调整：' + rsel.options[rsel.selectedIndex].text + '（点一下画面试试）');
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
    // H.264 模式用 canvas 显示（WebCodecs 解出来的 VideoFrame 直接画上去）
    const canvas = E('canvas');
    canvas.style.cssText = 'display:none;width:100%;height:auto;background:#000';
    wrap.appendChild(canvas);
    function activeEl() { return st.mode === 'h264' ? canvas : img; }
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
        if (st.mode === 'h264') {
          resetH264();
          await ensureDec();
          await rc.castStartH264({ fps: st.fps, wid: st.wid, bitrate: st.bitrate, gop: st.gop });
          img.style.display = 'none'; canvas.style.display = 'block';
          log('投屏已开始 H.264 ' + st.wid + 'px @' + st.fps + 'fps ' + st.bitrate + '\n');
        } else {
          await rc.castStart({ fps: st.fps, wid: st.wid, q: st.q, source: st.src, stream: st.stream });
          canvas.style.display = 'none'; img.style.display = 'block';
          log('投屏已开始 ' + (st.src === 'cam' ? '摄像头原画' : '车机画面') + ' ' + st.wid + 'px @' + st.fps + 'fps\n');
        }
        st.running = true;
        st.frames = 0;
        h264Frames = 0;
        syncButtons();
      } catch (e) { APP.toast(APP.describeErr(e), 'fail'); log('启动失败：' + APP.describeErr(e) + '\n'); }
      finally { APP.clearBusy(); refresh(); }
    }
    async function stop() {
      try { if (st.mode === 'h264') await rc.castStopH264(); else await rc.castStop(); } catch (e) { /* 忽略 */ }
      st.running = false;
      resetH264();
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
    rc.onCastH264(function (buf) { feedH264(buf); });

    /* ---------- H.264 播放器：Annex-B → WebCodecs → canvas ---------- */
    let dec = null, pendH264 = new Uint8Array(0), tsH264 = 0, h264Frames = 0, decCodec = 'avc1.42c01f';
    window.__h264 = { chunks: 0, aus: 0, decoded: 0, err: null, bytes: 0 };
    const H264_CODECS = ['avc1.42c01f', 'avc1.42E01E', 'avc1.4D401F', 'avc1.640028'];
    async function ensureDec() {
      if (dec) return dec;
      if (typeof VideoDecoder === 'undefined') throw new Error('这个 Electron 没有 WebCodecs');
      let codec = null;
      for (let i = 0; i < H264_CODECS.length; i++) {
        try { const s = await VideoDecoder.isConfigSupported({ codec: H264_CODECS[i], optimizeForLatency: true }); if (s.supported) { codec = H264_CODECS[i]; break; } } catch (e) {}
      }
      if (!codec) throw new Error('没有可用的 H.264 解码器');
      dec = new VideoDecoder({
        output: function (f) {
          try {
            if (canvas.width !== f.displayWidth || canvas.height !== f.displayHeight) { canvas.width = f.displayWidth; canvas.height = f.displayHeight; }
            canvas.getContext('2d').drawImage(f, 0, 0);
            h264Frames++;
            if (window.__h264) window.__h264.decoded++;
            const now = Date.now();
            if (now - st.last > 500) { st.last = now; bFrame.textContent = '投屏中 · 帧 ' + h264Frames; bFrame.className = 'badge ok'; }
          } catch (e) {} finally { try { f.close(); } catch (e) {} }
        },
        error: function (e) { log('解码错误：' + (e && e.message) + '\n'); }
      });
      decCodec = codec;
      dec.configure({ codec: codec, optimizeForLatency: true });
      log('H.264 解码器已就绪：' + codec + '\n');
      return dec;
    }
    function resetH264() {
      try { if (dec && dec.state !== 'closed') dec.close(); } catch (e) {}
      dec = null; pendH264 = new Uint8Array(0); tsH264 = 0;
    }
    function decodeAU(m, s, e) {
      let isKey = false;
      for (let j = s; j + 3 < e; j++) {
        if (m[j] === 0 && m[j + 1] === 0 && m[j + 2] === 1) {
          const t = m[j + 3] & 0x1f;
          if (t === 5 || t === 7) { isKey = true; break; }
        }
      }
      try {
        dec.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: tsH264, data: m.slice(s, e) }));
        tsH264 += Math.round(1000000 / (st.fps || 20));
        if (window.__h264) { window.__h264.aus++; window.__h264.bytes += (e - s); }
      } catch (err) {
        const msg = String((err && err.message) || err);
        if (window.__h264) window.__h264.err = 'decode: ' + msg;
        // 丢包后第一帧不是关键帧：reset 一下等下一个关键帧，避免整条流废掉
        if (msg.indexOf('key frame') >= 0) {
          try { dec.reset(); dec.configure({ codec: decCodec, optimizeForLatency: true }); if (window.__h264) window.__h264.resets = (window.__h264.resets || 0) + 1; } catch (e) {}
        } else { log('送帧失败：' + msg + '\n'); }
      }
    }
    function feedH264(buf) {
      if (!dec || dec.state !== 'configured') { if (window.__h264) window.__h264.err = 'dec not ready: ' + (dec ? dec.state : 'null'); return; }
      if (window.__h264) window.__h264.chunks++;
      let chunk = null;
      if (buf instanceof Uint8Array) chunk = buf;
      else if (buf && buf.byteLength != null) chunk = new Uint8Array(buf);
      else if (buf && buf.data) { const b = atob(buf.data); chunk = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) chunk[i] = b.charCodeAt(i); }
      if (!chunk) return;
      const m = new Uint8Array(pendH264.length + chunk.length);
      m.set(pendH264, 0); m.set(chunk, pendH264.length);
      const starts = [];
      for (let i = 0; i + 4 < m.length; i++) {
        if (m[i] !== 0 || m[i + 1] !== 0) continue;
        let h;
        if (m[i + 2] === 0 && m[i + 3] === 1) h = i + 4;                       // 4 字节起始码
        else if (m[i + 2] === 1) { if (i > 0 && m[i - 1] === 0) continue; h = i + 3; }   // 3 字节（且不是 4 字节码的后半段）
        else continue;
        if ((m[h] & 0x1f) === 9) starts.push(i);
      }
      for (let k = 0; k + 1 < starts.length; k++) decodeAU(m, starts[k], starts[k + 1]);
      pendH264 = starts.length ? m.slice(starts[starts.length - 1]) : m.slice(Math.max(0, m.length - 4));
    }

    // 画面区 = 触摸板
    async function ensureTouch() {
      if (st.touchReady) return true;
      try { await rc.touchOpen('c3'); st.touchReady = true; return true; }
      catch (e) { APP.toast('触摸通道打开失败：' + APP.describeErr(e), 'fail'); return false; }
    }
    function uv(ev) {
      const r = activeEl().getBoundingClientRect();
      let u = (ev.clientX - r.left) / r.width;
      let v = (ev.clientY - r.top) / r.height;
      u = Math.min(1, Math.max(0, u));
      v = Math.min(1, Math.max(0, v));
      return (TOUCH[st.touch] || TOUCH.v)(u, v);
    }
    function showDot(ev) {
      const r = wrap.getBoundingClientRect();
      dot.style.left = (ev.clientX - r.left) + 'px';
      dot.style.top = (ev.clientY - r.top) + 'px';
      dot.style.opacity = '1';
    }
    async function send(cmd) { await ensureTouch(); rc.touchSend(cmd); }

    wrap.addEventListener('mousedown', async function (ev) {
      ev.preventDefault();
      st.dragging = true;
      showDot(ev);
      const p = uv(ev);
      await send('down ' + p[0].toFixed(4) + ' ' + p[1].toFixed(4));
    });
    wrap.addEventListener('mousemove', function (ev) {
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
