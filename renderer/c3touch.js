'use strict';
/* 远程控制台 · C3 触控面板
   说明：C3 的画面在本固件上无法抓取（详见使用说明），所以这里是「盲触」控制板：
   你看着 C3 的实体屏幕，用鼠标/触控板在电脑上操作它。 */
(function () {
  const rc = window.rc;
  function E(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(label, fn, cls) { const b = E('button', 'btn' + (cls ? ' ' + cls : ''), label); b.onclick = fn; return b; }

  const ROT = {
    '90':  function (u, v) { return [u, v]; },
    '270': function (u, v) { return [1 - u, 1 - v]; },
    '0':   function (u, v) { return [v, 1 - u]; },
    '180': function (u, v) { return [1 - v, u]; }
  };

  window.PANELS = window.PANELS || {};
  window.PANELS.c3touch = function (pane) {
    const APP = window.APP;
    const st = { connected: false, rot: '90', dragging: false, lastDown: 0 };

    const box = E('div', 'panel');
    pane.appendChild(box);
    box.appendChild(E('h2', null, 'C3 触控'));
    box.appendChild(E('div', 'desc', '把鼠标操作转成 C3 触摸屏事件（注入 /dev/input/event2）。看着 C3 的实体屏幕操作即可。'));

    const bar = E('div', 'row-flex'); bar.style.margin = '10px 0';
    const state = E('span', 'badge', '未连接');
    bar.appendChild(state);
    bar.appendChild(btn('连接', async function () {
      try {
        await rc.touchOpen('c3');
        st.connected = true; state.textContent = '已连接'; state.className = 'badge ok';
        APP.toast('C3 触控已就绪');
      } catch (e) { APP.toast('连接失败：' + APP.describeErr(e), 'fail'); }
    }, 'primary'));
    bar.appendChild(btn('断开', async function () {
      await rc.touchClose(); st.connected = false;
      state.textContent = '未连接'; state.className = 'badge';
    }));
    const rotSel = E('select', 'txt');
    ['90', '270', '0', '180'].forEach(function (r) { const o = E('option', null, '方向 ' + r + '°'); o.value = r; rotSel.appendChild(o); });
    rotSel.value = st.rot;
    rotSel.onchange = function () { st.rot = rotSel.value; APP.toast('触摸方向已切到 ' + st.rot + '°'); };
    bar.appendChild(rotSel);
    box.appendChild(bar);

    // 触摸板（按 2160x1080 比例）
    const pad = E('div');
    pad.style.cssText = 'position:relative;width:100%;max-width:860px;aspect-ratio:2/1;background:var(--term-bg);border:1px solid var(--line);border-radius:10px;cursor:crosshair;overflow:hidden;user-select:none';
    const grid = E('div');
    grid.style.cssText = 'position:absolute;inset:0;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:10% 20%;opacity:.35';
    pad.appendChild(grid);
    const hint = E('div', null, '点一下 = 点击屏幕 · 按住拖动 = 滑动');
    hint.style.cssText = 'position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);text-align:center;color:var(--fg-dim);font-size:12.5px;pointer-events:none';
    pad.appendChild(hint);
    const dot = E('div');
    dot.style.cssText = 'position:absolute;width:14px;height:14px;border-radius:50%;background:var(--accent);opacity:0;transform:translate(-50%,-50%);pointer-events:none';
    pad.appendChild(dot);
    box.appendChild(pad);

    function uv(ev) {
      const r = pad.getBoundingClientRect();
      let u = (ev.clientX - r.left) / r.width;
      let v = (ev.clientY - r.top) / r.height;
      u = Math.min(1, Math.max(0, u));
      v = Math.min(1, Math.max(0, v));
      return ROT[st.rot](u, v);
    }
    function showDot(ev) {
      const r = pad.getBoundingClientRect();
      dot.style.left = (ev.clientX - r.left) + 'px';
      dot.style.top = (ev.clientY - r.top) + 'px';
      dot.style.opacity = '1';
    }
    function send(cmd) {
      if (!st.connected) { APP.toast('先点「连接」', 'fail'); return; }
      rc.touchSend(cmd);
    }

    pad.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      st.dragging = true;
      st.moved = false;
      showDot(ev);
      const p = uv(ev);
      send('down ' + p[0].toFixed(4) + ' ' + p[1].toFixed(4));
    });
    pad.addEventListener('mousemove', function (ev) {
      if (!st.dragging) return;
      showDot(ev);
      st.moved = true;
      const p = uv(ev);
      send('move ' + p[0].toFixed(4) + ' ' + p[1].toFixed(4));
    });
    pad.addEventListener('mouseup', function (ev) {
      if (!st.dragging) return;
      st.dragging = false;
      send('up');
      setTimeout(function () { dot.style.opacity = '0'; }, 300);
    });
    pad.addEventListener('mouseleave', function () {
      if (st.dragging) { st.dragging = false; send('up'); }
    });

    const gestures = E('div', 'row-flex');
    gestures.style.margin = '12px 0';
    [
      ['点击屏幕中心', 'tap 0.5 0.5'],
      ['返回（右滑）', 'swipe 0.25 0.5 0.8 0.5'],
      ['回到左页（左滑）', 'swipe 0.8 0.5 0.25 0.5'],
      ['上滑', 'swipe 0.5 0.75 0.5 0.2'],
      ['下滑', 'swipe 0.5 0.2 0.5 0.75']
    ].forEach(function (g) {
      gestures.appendChild(btn(g[0], function () { send(g[1]); }, 'small'));
    });
    box.appendChild(gestures);

    const out = E('div', 'out');
    out.style.maxHeight = '160px';
    box.appendChild(out);

    rc.onTouchLog(function (p) {
      if (!p || !p.text) return;
      out.textContent += p.text;
      if (out.textContent.length > 4000) out.textContent = out.textContent.slice(-3000);
      out.scrollTop = out.scrollHeight;
      if (/READY/.test(p.text)) { st.connected = true; state.textContent = '已连接'; state.className = 'badge ok'; }
    });
    rc.onTouchExit(function () {
      st.connected = false;
      state.textContent = '已断开'; state.className = 'badge fail';
      out.textContent += '[会话已结束]\n';
    });

    box.appendChild(E('div', 'desc', '提示：本固件无法抓取 C3 屏幕画面，所以没有实时画面。如果你需要看画面，可以：'
      + '① 直接看 C3 实体屏幕配这个触控板；② 用 openpilot 车机端自己的界面。'));
  };
})();
