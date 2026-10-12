'use strict';
/* 远程控制台 · EasyTier 隧道面板 */
(function () {
  const rc = window.rc;
  function E(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function card(k, v, s, cls) {
    const c = E('div', 'card');
    c.appendChild(E('div', 'k', k));
    const vv = E('div', 'v' + (cls ? ' ' + cls : ''), v == null || v === '' ? '-' : String(v));
    c.appendChild(vv);
    if (s) c.appendChild(E('div', 's', s));
    return c;
  }
  function btn(label, fn, cls) { const b = E('button', 'btn' + (cls ? ' ' + cls : ''), label); b.onclick = fn; return b; }

  // 隧道告警 → 右上角浮层
  try {
    rc.onEtAlert(function (p) {
      if (window.APP && window.APP.toast && p && p.level !== 'ok') window.APP.toast(p.text, p.level === 'fail' ? 'fail' : undefined);
      else if (window.APP && window.APP.toast) window.APP.toast(p.text);
    });
  } catch (e) { /* 忽略 */ }

  window.PANELS = window.PANELS || {};
  window.PANELS.easytier = function (pane) {
    const APP = window.APP;
    const box = E('div', 'panel');
    pane.appendChild(box);
    box.appendChild(E('h2', null, 'EasyTier 隧道'));
    box.appendChild(E('div', 'desc', '程序可以直接管理这条隧道：状态探测、启动 / 停止 / 重启、常驻守护、掉线自动重连。所有远程功能都跑在它上面。'));
    box.appendChild(E('div', 'desc', '提示：隧道内核现在会**隐藏窗口**启动，日志写到 用户目录\.remote-console\easytier.log（点「看隧道日志」打开）。'
      + '如果你现在看到的还是那个黑色控制台窗口，那是旧方式启动的——点一次「重启隧道」就会变成隐藏的（需要点一下 UAC）。'));

    const cards = E('div', 'cards');
    box.appendChild(cards);
    const bar = E('div', 'row-flex'); bar.style.margin = '12px 0';
    bar.appendChild(btn('↻ 刷新', load, 'primary'));
    bar.appendChild(btn('启动隧道', async function () {
      APP.setBusy('正在启动隧道…');
      try { const r = await rc.etStart(); APP.toast(r.message, r.ok ? undefined : 'fail'); } finally { APP.clearBusy(); }
      setTimeout(load, 3000);
    }));
    bar.appendChild(btn('停止隧道', async function () {
      APP.setBusy('正在停止隧道…');
      try { const r = await rc.etStop(); APP.toast(r.message, r.ok ? undefined : 'fail'); } finally { APP.clearBusy(); }
      setTimeout(load, 1500);
    }, 'danger'));
    bar.appendChild(btn('重启隧道', async function () {
      APP.setBusy('正在重启隧道…');
      try { const r = await rc.etRestart(); APP.toast(r.message, r.ok ? undefined : 'fail'); } finally { APP.clearBusy(); }
      setTimeout(load, 6000);
    }));
    bar.appendChild(btn('打开 EasyTier GUI', async function () {
      const r = await rc.etOpenGui(); APP.toast(r.message, r.ok ? undefined : 'fail');
    }));
    bar.appendChild(btn('看隧道日志', async function () {
      const r = await rc.etOpenLog();
      APP.toast(r.message, r.ok ? undefined : 'fail');
    }, 'small'));
    bar.appendChild(btn('查看诊断文本', async function () {
      const text = await rc.etDiagnose();
      APP.modal('隧道诊断', function (b) {
        const o = E('div', 'out'); o.textContent = text; b.appendChild(o);
      }, async function () {}, '关闭');
    }));
    box.appendChild(bar);

    const statusLine = E('div', 'desc');
    box.appendChild(statusLine);

    const peerTitle = E('h2'); peerTitle.textContent = '对端（peer）'; peerTitle.style.marginTop = '10px';
    box.appendChild(peerTitle);
    const peerBox = E('div');
    box.appendChild(peerBox);
    const routeTitle = E('h2'); routeTitle.textContent = '路由（route）'; routeTitle.style.marginTop = '16px';
    box.appendChild(routeTitle);
    const routeBox = E('div');
    box.appendChild(routeBox);

    const setTitle = E('h2'); setTitle.textContent = '隧道设置'; setTitle.style.marginTop = '18px';
    box.appendChild(setTitle);
    const settingsBox = E('div');
    box.appendChild(settingsBox);

    function table(headers, rows) {
      const tb = E('table', 'tbl');
      const head = E('tr');
      headers.forEach(function (h) { head.appendChild(E('th', null, h)); });
      tb.appendChild(head);
      rows.forEach(function (r) {
        const tr = E('tr');
        r.forEach(function (c) { tr.appendChild(E('td', null, c == null ? '' : String(c))); });
        tb.appendChild(tr);
      });
      return tb;
    }

    function renderSettings() {
      const et = APP.state.cfg.easytier || {};
      settingsBox.innerHTML = '';
      const row1 = E('div', 'row-flex'); row1.style.margin = '6px 0';
      const sw = function (label, key, val) {
        const l = E('label', 'badge');
        l.style.cursor = 'pointer';
        l.style.padding = '4px 10px';
        const cb = E('input'); cb.type = 'checkbox'; cb.checked = !!val;
        cb.onchange = async function () {
          const nv = await rc.etSetConfig({ [key]: cb.checked });
          APP.state.cfg.easytier = nv;
          APP.toast(label + '：' + (cb.checked ? '已开启' : '已关闭'));
        };
        l.appendChild(cb); l.appendChild(document.createTextNode(' ' + label));
        return l;
      };
      const modeWrap = E('label', 'badge');
      modeWrap.style.cssText = 'padding:4px 10px;display:flex;align-items:center;gap:6px';
      modeWrap.appendChild(document.createTextNode('启动方式'));
      const modeSel = E('select', 'txt');
      modeSel.style.padding = '2px 6px';
      [{ v: 'core', l: '内置内核（推荐，不依赖外部 GUI）' }, { v: 'gui', l: '外部 EasyTier GUI' }].forEach(function (o) {
        const op = E('option', null, o.l); op.value = o.v; modeSel.appendChild(op);
      });
      modeSel.value = et.startMode || 'core';
      modeSel.onchange = async function () {
        const nv = await rc.etSetConfig({ startMode: modeSel.value });
        APP.state.cfg.easytier = nv;
        APP.toast('启动方式：' + (modeSel.value === 'core' ? '内置内核' : '外部 GUI'));
      };
      modeWrap.appendChild(modeSel);
      row1.appendChild(modeWrap);
      row1.appendChild(sw('打开程序自动启动隧道', 'autoStart', et.autoStart));
      row1.appendChild(sw('常驻守护（掉线告警）', 'guardian', et.guardian));
      row1.appendChild(sw('掉线自动重连（会弹 UAC）', 'autoRestart', et.autoRestart));
      row1.appendChild(sw('停止时一并关闭 GUI', 'stopGui', et.stopGui));
      settingsBox.appendChild(row1);

      const fields = [
        { k: 'probeIp', label: '隧道探测地址' },
        { k: 'guiLnk', label: 'EasyTier GUI 快捷方式' },
        { k: 'cliExe', label: 'easytier-cli 路径' },
        { k: 'coreExe', label: 'easytier-core 路径' },
        { k: 'guardianIntervalSec', label: '守护探测间隔（秒）' }
      ];
      fields.forEach(function (f) {
        const d = E('div', 'field');
        d.appendChild(E('label', null, f.label));
        const i = E('input', 'txt');
        i.value = et[f.k] == null ? '' : et[f.k];
        i.onchange = async function () {
          const nv = await rc.etSetConfig({ [f.k]: i.value });
          APP.state.cfg.easytier = nv;
          APP.toast(f.label + ' 已保存');
        };
        d.appendChild(i);
        settingsBox.appendChild(d);
      });

      const d2 = E('div', 'field');
      d2.appendChild(E('label', null, '组网参数（每行一个，会作为 easytier-core 的启动参数；GUI 启动方式不使用）'));
      const ta = E('textarea', 'txt');
      ta.style.minHeight = '90px';
      ta.value = (et.args || []).join('\n');
      ta.onchange = async function () {
        const arr = ta.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
        const nv = await rc.etSetConfig({ args: arr });
        APP.state.cfg.easytier = nv;
        APP.toast('启动参数已保存');
      };
      d2.appendChild(ta);
      settingsBox.appendChild(d2);
    }

    function cn(v) {
      const s = String(v == null ? '' : v);
      if (/^local$/i.test(s)) return '本机';
      if (/^direct$/i.test(s)) return '直连';
      if (/^p2p$/i.test(s)) return '点对点';
      return s;
    }

    async function load() {
      cards.innerHTML = '';
      statusLine.textContent = '探测中…';
      let st;
      try { st = await rc.etStatus(); }
      catch (e) { statusLine.textContent = '状态获取失败：' + APP.describeErr(e); return; }
      APP.state.tunnel = st;

      cards.appendChild(card('隧道进程', st.running ? '运行中' : '未运行',
        (st.processes && st.processes.length ? st.processes.join(', ') : '没有检测到 easytier 进程'),
        st.running ? 'ok' : 'fail'));
      cards.appendChild(card('本机虚拟 IP', st.selfIp || '-', 'EasyTier 分配'));
      cards.appendChild(card('探测 ' + st.probeIp, st.tunnelOk ? '通' : '不通',
        st.pingMs == null ? '' : (st.pingMs + ' ms'), st.tunnelOk ? 'ok' : 'fail'));
      cards.appendChild(card('对端数量', st.peerCount, st.viaRelay ? '含中继节点' : ''));
      cards.appendChild(card('最优延迟', st.bestLatencyMs == null ? '-' : (st.bestLatencyMs + ' ms'),
        st.bestLatencyMs != null && st.bestLatencyMs < 100 ? '直连质量良好' : '延迟偏高（可能在走中继）'));
      statusLine.textContent = '最后刷新：' + new Date(st.at).toLocaleTimeString() + (st.error ? ' · ' + st.error : '');

      const peers = (st.peers && st.peers.rows) || [];
      peerBox.innerHTML = '';
      if (peers.length) {
        peerBox.appendChild(table(['虚拟 IP', '主机名', '路由方式', '协议', '延迟（毫秒）', '丢包率', '已接收', '已发送', '网络类型', '内核版本'],
          peers.map(function (r) { return [r.ipv4, r.hostname, cn(r.cost), cn(r.tunnel), r['lat(ms)'], r.loss, r.rx, r.tx, cn(r.NAT), r.version]; })));
      } else {
        peerBox.appendChild(E('div', 'desc', '没有对端数据（隧道可能未运行）'));
      }

      const routes = (st.routes && st.routes.rows) || [];
      routeBox.innerHTML = '';
      if (routes.length) {
        routeBox.appendChild(table(['虚拟 IP', '主机名', '代理网段', '下一跳', '路径延迟（毫秒）'],
          routes.map(function (r) { return [r.ipv4, r.hostname, r.proxy_cidrs, cn(r.next_hop_hostname), r['path_latency']]; })));
      } else {
        routeBox.appendChild(E('div', 'desc', '没有路由数据'));
      }
      renderSettings();
    }

    rc.onEtStatus(function (st) {
      if (!st) return;
      APP.state.tunnel = st;
      if (APP.setDot) APP.setDot('local', st.tunnelOk ? 'ok' : (st.running ? 'warn' : 'fail'));
    });

    load();
    const t = setInterval(function () {
      if (pane.classList.contains('active')) load();
    }, 15000);
    pane._timer = t;
    pane.refresh = load;
  };
})();
