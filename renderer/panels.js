'use strict';
/* 远程控制台 · 各功能面板 */
window.__initPanels = function () {
  const A = window.APP;
  const rc = window.rc;
  const el = A.el;
  const PANELS = {};

  /* ---------- 小工具 ---------- */
  function card(k, v, s) {
    const c = el('div', 'card');
    c.appendChild(el('div', 'k', k));
    c.appendChild(el('div', 'v', v == null ? '-' : String(v)));
    if (s) c.appendChild(el('div', 's', s));
    return c;
  }
  function h2(box, t, d) {
    box.appendChild(el('h2', null, t));
    if (d) box.appendChild(el('div', 'desc', d));
  }
  function btn(label, fn, cls) {
    const b = el('button', 'btn' + (cls ? ' ' + cls : ''), label);
    b.onclick = fn;
    return b;
  }
  function row() { const r = el('div', 'row-flex'); r.style.margin = '10px 0'; return r; }
  function out(text) { const o = el('div', 'out'); o.textContent = text || ''; return o; }
  function j(o) { try { return JSON.stringify(o, null, 2); } catch (e) { return String(o); } }
  function cnAdb(s) {
    return { device: '已连接', unauthorized: '未授权（需装手机密钥）', offline: '离线', 'no permissions': '无权限' }[s] || s || '未知';
  }
  function cnKind(k) {
    return { local: '本机命令', ufi: '随身WiFi 后台', ssh: 'SSH 登录', adb: '安卓调试' }[k] || k;
  }
  function fmtBytes(n) {
    if (n == null) return '-';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, x = Number(n);
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return x.toFixed(i ? 2 : 0) + ' ' + u[i];
  }

  // 通用表单弹窗：fields = [{key,label,type,value,options,minH}]
  function formModal(title, fields, onSubmit, okLabel) {
    const mask = el('div', 'modal-mask');
    const m = el('div', 'modal');
    m.appendChild(el('h3', null, title));
    const inputs = {};
    fields.forEach(function (f) {
      const d = el('div', 'field');
      d.appendChild(el('label', null, f.label));
      let inp;
      if (f.type === 'textarea') { inp = el('textarea', 'txt'); inp.style.minHeight = f.minH || '90px'; }
      else if (f.type === 'select') {
        inp = el('select', 'txt');
        (f.options || []).forEach(function (o) { const op = el('option', null, o.label); op.value = o.value; inp.appendChild(op); });
      } else { inp = el('input', 'txt'); }
      inp.value = f.value == null ? '' : f.value;
      if (f.placeholder) inp.placeholder = f.placeholder;
      d.appendChild(inp);
      m.appendChild(d);
      inputs[f.key] = inp;
    });
    const r = el('div', 'row-flex');
    r.style.marginTop = '14px';
    r.style.justifyContent = 'flex-end';
    const cancel = btn('取消', function () { mask.remove(); });
    const ok = btn(okLabel || '保存', async function () {
      const v = {};
      Object.keys(inputs).forEach(function (k) { v[k] = inputs[k].value; });
      try { await onSubmit(v); mask.remove(); }
      catch (e) { A.toast(A.describeErr(e), 'fail'); }
    }, 'primary');
    r.appendChild(cancel); r.appendChild(ok);
    m.appendChild(r);
    mask.appendChild(m);
    document.getElementById('modal-root').appendChild(mask);
    return mask;
  }

  async function runInTerminal(targetId, kindCode, title, cmd, waitMs) {
    const tab = await A.openTerminal(targetId, kindCode, title);
    if (!tab || !tab.sessionId) return;
    await new Promise(function (r) { setTimeout(r, waitMs == null ? 1600 : waitMs); });
    await rc.sessionRun(tab.sessionId, cmd);
  }
  function channelKind(ch) { return { ssh: 'ssh', adb: 'adb', root: 'root', local: 'local' }[ch] || 'ssh'; }

  /* ================= 总览 ================= */
  PANELS.overview = function (pane) {
    const box = el('div', 'panel');
    pane.appendChild(box);
    h2(box, '总览', '三端设备与隧道状态 · 每次巡检都会刷新');
    const r = row();
    r.appendChild(el('div', 'spacer'));
    r.appendChild(btn('一键巡检', function () { A.runHealth(); }, 'primary'));
    r.appendChild(btn('重连 ADB', async function () {
      const list = await rc.adbEnsureAll();
      A.toast(list.map(function (x) { return x.id + '=' + x.state; }).join('  '));
      A.runHealth();
    }));
    box.appendChild(r);
    
    const cards = el('div', 'cards');
    box.appendChild(cards);
    const tblBox = el('div');
    tblBox.style.marginTop = '16px';
    box.appendChild(tblBox);

    function render() {
      cards.innerHTML = '';
      const running = A.state.healthRunning;
      const partial = A.state.healthPartial || [];
      const hs = A.state.health || (partial.length ? { steps: partial, at: Date.now(), partial: true } : null);
      if (running && partial.length) {
        const p = el('div', 'progbar');
        const fill = el('i');
        fill.style.width = Math.round(partial.length / 8 * 100) + '%';
        p.appendChild(fill);
        const line = el('div', 'row-flex');
        line.appendChild(p);
        line.appendChild(el('span', 'desc', '巡检中 ' + partial.length + '/8 · ' + (partial[partial.length - 1].name || '')));
        tblBox.appendChild(line);
      }
      // EasyTier 隧道卡片
      (function () {
        const ts = hs && hs.steps.find(function (x) { return x.name.indexOf('EasyTier') === 0; });
        const tc = card('EasyTier 隧道', running ? '检测中…' : (ts ? (ts.detail || '-') : '未检测'), '三台设备都走这条隧道');
        const tb = el('span', 'badge ' + (running ? 'warn' : (ts ? ts.status : 'warn')), running ? '巡检中' : (ts && ts.status === 'ok' ? '在线' : '离线'));
        tc.querySelector('.k').appendChild(document.createTextNode(' '));
        tc.querySelector('.k').appendChild(tb);
        if (ts) tc.title = '隧道检查：' + (ts.detail || '');
        cards.appendChild(tc);
      })();
      (A.state.cfg.targets || []).forEach(function (t) {
        if (t.id === 'local') return;
        let st = 'warn', detail = '';
        if (t.id === 'u30') {
          const a = hs && hs.steps.find(function (x) { return x.name.indexOf('U30 Air 后台') === 0; });
          const a2 = hs && hs.steps.find(function (x) { return x.name.indexOf('U30 Air ADB') === 0; });
          if (a && a.status === 'ok') { st = 'ok'; detail = a.detail || ''; }
          else if (a2 && a2.status === 'ok') { st = 'ok'; detail = a2.detail || ''; }
          else if (a2) { st = a2.status; detail = a2.detail || ''; }
          else if (a) { st = a.status; detail = a.detail || ''; }
        } else if (hs) {
          const key = t.id === 'c3' ? 'C3 SSH' : '车机 ADB';
          const s = hs.steps.find(function (x) { return x.name.indexOf(key) === 0; });
          if (s) { st = s.status; detail = s.detail || ''; }
        }
        const label = running ? '巡检中' : (!hs ? '未检测' : (st === 'ok' ? '在线' : (st === 'warn' ? '待确认' : '离线')));
        const c = card(t.name, running ? '检测中…' : (detail || '-'), t.note || '');
        const b = el('span', 'badge ' + (running ? 'warn' : st), label);
        c.querySelector('.k').appendChild(document.createTextNode(' '));
        c.querySelector('.k').appendChild(b);
        // 总览卡片可点击
        c.style.cursor = 'pointer';
        c.title = '点一下打开「' + t.name + '」';
        c.onclick = function () { var id = t.id === 'u30' ? 'u30' : (t.id === 'c3' ? 'c3' : (t.id === 'car' ? 'car' : 'overview')); var nm = t.id === 'u30' ? 'U30 Air 面板' : (t.id === 'c3' ? 'C3 面板' : (t.id === 'car' ? '车机面板' : '总览')); A.openPanel(id, nm); };
        cards.appendChild(c);
      });
      if (running && partial.length) return;
      tblBox.innerHTML = '';
      if (hs && hs.steps && hs.steps.length === 8) {
        const okN = hs.steps.filter(function (s) { return s.status === 'ok'; }).length;
        tblBox.appendChild(el('div', 'desc', '上次巡检：' + new Date(hs.at).toLocaleTimeString() + ' · ' + okN + '/8 通过'
          + (hs.elapsed ? ' · 耗时 ' + (hs.elapsed / 1000).toFixed(1) + ' 秒' : '')));
      }
      if (hs) {
        const tb = el('table', 'tbl');
        const head = el('tr');
        ['检查项', '结果', '详情', '耗时'].forEach(function (x) { head.appendChild(el('th', null, x)); });
        tb.appendChild(head);
        hs.steps.forEach(function (s) {
          const tr = el('tr');
          tr.appendChild(el('td', null, s.name));
          const td = el('td');
          td.appendChild(el('span', 'badge ' + s.status, s.status));
          tr.appendChild(td);
          tr.appendChild(el('td', null, s.detail || ''));
          tr.appendChild(el('td', null, s.ms == null ? '' : (s.ms >= 1000 ? (s.ms / 1000).toFixed(1) + 's' : s.ms + 'ms')));
          tb.appendChild(tr);
        });
        tblBox.appendChild(tb);
      }
    }
    pane.refresh = render;
    render();
  };

  /* ================= U30 Air ================= */
  PANELS.u30 = function (pane) {
    const box = el('div', 'panel');
    pane.appendChild(box);
    h2(box, 'U30 Air 面板', 'UFI-TOOLS 后台 (Ktor :2333) · 经 EasyTier 隧道访问');
    const r = row();
    r.appendChild(btn('↻ 刷新', load, 'primary'));
    r.appendChild(btn('Root 终端', function () { A.openTerminal('u30', 'root', 'U30 root'); }));
    r.appendChild(btn('Shell 终端', function () { A.openTerminal('u30', 'adb', 'U30 shell'); }));
    r.appendChild(btn('▤ 文件管理', function () { A.openPanel('files', '文件管理', 'u30'); }));
    r.appendChild(btn('令牌需求检查', function () { call('/api/need_token'); }));
    r.appendChild(btn('ADB 状态', function () { call('/api/adb_alive'); }));
    r.appendChild(btn('禁用系统更新', function () { call('/api/disable_fota'); }, 'danger'));
    r.appendChild(btn('打开官方后台', function () { rc.openExternal('http://10.126.126.1:2333'); }));
    box.appendChild(r);
    const cards = el('div', 'cards');
    box.appendChild(cards);
    const o = out();
    box.appendChild(o);

    async function call(path, method, body) {
      o.textContent = '调用 ' + path + ' …';
      try {
        const res = await rc.ufiApi({ targetId: 'u30', method: method || 'GET', path: path, body: body });
        o.textContent = path + '\n' + j(res.json != null ? res.json : res.text);
      } catch (e) { o.textContent = path + '\n错误：' + A.describeErr(e); }
    }

    async function load() {
      cards.innerHTML = '';
      o.textContent = '读取中…';
      const res = {};
      for (const p of ['/api/version_info', '/api/baseDeviceInfo', '/api/connInfo', '/api/adb_alive', '/api/is_weak_token', '/api/hasTTYD']) {
        try { res[p] = await rc.ufiApi({ targetId: 'u30', path: p, query: p === '/api/hasTTYD' ? { port: '7681' } : undefined }); }
        catch (e) { res[p] = { error: A.describeErr(e) }; }
      }
      const v = res['/api/version_info'] && res['/api/version_info'].json;
      const b = res['/api/baseDeviceInfo'] && res['/api/baseDeviceInfo'].json;
      const c = res['/api/connInfo'] && res['/api/connInfo'].json;
      cards.appendChild(card('UFI-TOOLS', v ? v.app_ver : '获取失败', v ? ('设备 ' + v.model) : ''));
      if (b) {
        cards.appendChild(card('电量', b.battery + '%', '最高温 ' + tempOf(b)));
        cards.appendChild(card('存储', fmtBytes(b.internal_used_storage) + ' / ' + fmtBytes(b.internal_total_storage), '可用 ' + fmtBytes(b.internal_available_storage)));
        cards.appendChild(card('今日流量', fmtBytes(b.daily_data), ''));
      }
      if (c && typeof c === 'object') {
        const keys = Object.keys(c).filter(function (k) { return typeof c[k] !== 'object'; });
        keys.slice(0, 10).forEach(function (k) { cards.appendChild(card(k, c[k], '')); });
      }
      const weak = res['/api/is_weak_token'] && res['/api/is_weak_token'].json;
      const need = res['/api/need_token'] && res['/api/need_token'].json;
      const adbAlive = res['/api/adb_alive'] && res['/api/adb_alive'].json;
      const weakErr = res['/api/is_weak_token'] && res['/api/is_weak_token'].error;
      cards.appendChild(card('后台令牌',
        weak ? (weak.is_weak ? '弱口令！' : '安全') : (need ? (need.need_token ? '已启用（需令牌）' : '未启用') : '-'),
        weak ? j(weak) : (weakErr ? '当前固件不支持弱口令检测' : '')));
      cards.appendChild(card('网络 ADB', adbAlive ? j(adbAlive) : '-', '远程控制的命门，必须保持可用'));
      o.textContent = j(res).slice(0, 5000);
    }
    function tempOf(b) {
      if (!b || !b.cpu_temp_list) return '-';
      const t = b.cpu_temp_list.map(function (x) { return x.temp; }).filter(function (x) { return x > 0; });
      return t.length ? (Math.max.apply(null, t) / 1000).toFixed(1) + ' ℃' : '-';
    }
    load();
  };

  /* ================= C3 ================= */
  PANELS.c3 = function (pane) {
    const box = el('div', 'panel');
    pane.appendChild(box);
    h2(box, 'C3 面板', 'comma three · openpilot · SSH');
    const r = row();
    r.appendChild(btn('↻ 刷新', load, 'primary'));
    r.appendChild(btn('⌨ 打开终端', function () { A.openTerminal('c3', 'ssh', 'C3 SSH'); }));
    r.appendChild(btn('投屏（可触控）', function () { A.openPanel('c3cast', 'C3 投屏'); }));
    r.appendChild(btn('参数（364 项 · 中文说明）', function () { A.openPanel('params', 'C3 参数'); }));
    r.appendChild(btn('▤ 文件管理', function () { A.openPanel('files', '文件管理', 'c3'); }));
    r.appendChild(btn('看 openpilot 服务窗口', function () {
      runInTerminal('c3', 'ssh', 'C3 服务窗口', 'tmux a -t comma', 3000);
    }));
    r.appendChild(btn('tmux 会话列表', function () { runInTerminal('c3', 'ssh', 'C3 tmux', 'tmux ls', 2500); }));
    r.appendChild(btn('Params 列表', function () { runInTerminal('c3', 'ssh', 'C3 params', 'ls /data/params/d | head -40', 2500); }));
    box.appendChild(r);
    const cards = el('div', 'cards');
    box.appendChild(cards);
    const o = out();
    box.appendChild(o);

    async function ex(cmd, ms) {
      try {
        const res = await Promise.race([
          rc.execOnce('c3', 'ssh', cmd),
          new Promise(function (_, rej) { setTimeout(function () { rej(new Error('命令超时（' + ((ms || 20000) / 1000) + ' 秒）')); }, ms || 20000); })
        ]);
        return ((res.stdout || '') + (res.stderr || '')).trim();
      } catch (e) { return '（读取失败：' + A.describeErr(e) + '）'; }
    }
    // ---- 把英文的原始输出翻成人话 ----
    function cnDur(u) {
      let s = String(u).trim(), days = 0;
      const dm = s.match(/^(\d+)\s+days?,\s*(.*)$/);
      if (dm) { days = Number(dm[1]); s = dm[2].trim(); }
      const hm = s.match(/^(\d+):(\d+)$/);
      let out = '';
      if (days) out += days + ' 天 ';
      if (hm) out += Number(hm[1]) + ' 小时 ' + Number(hm[2]) + ' 分';
      else out += s;
      return out.trim() || '未知';
    }
    function cnUptime(s) {
      const m = String(s).match(/up\s+(.+?),\s*(\d+)\s+users?,\s*load average:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
      if (!m) return String(s).trim() || '未知';
      const load = Number(m[3]);
      return '已运行 ' + cnDur(m[1]) + '\n登录 ' + m[2] + ' 人\n平均负载 ' + m[3] + ' / ' + m[4] + ' / ' + m[5]
        + '\n' + (load > 6 ? '（负载偏高）' : '（负载正常）');
    }
    function cnDf(s) {
      const m = String(s).match(/(\S+)\s+([\d.]+\w?)\s+([\d.]+\w?)\s+([\d.]+\w?)\s+(\d+)%/);
      if (!m) return String(s).trim() || '未知';
      const pct = Number(m[5]);
      return '已用 ' + m[3] + ' / 共 ' + m[2] + '（' + m[5] + '%）\n可用 ' + m[4]
        + (pct >= 85 ? ' —— 空间紧张' : '');
    }
    function cnTmux(s) {
      const t = String(s).trim();
      if (!t || /no server running|error connecting/i.test(t)) return '没有会话';
      const names = [];
      t.split('\n').forEach(function (line) {
        const m = line.match(/^([^:]+):\s*(\d+)\s+windows?/);
        if (m) names.push(m[1] + '（' + m[2] + ' 个窗口）');
      });
      return names.length ? '有 ' + names.length + ' 个会话\n' + names.join('、') : '有会话';
    }

    // 一次 SSH 拿回全部信息（比逐条连快得多，也不会因为某条卡住整个面板）
    const PROBE = [
      'cd /data/openpilot 2>/dev/null',
      // 直接读 .git 文件，不起 git 进程（设备负载高时 git 会卡住）
      'echo "@@BRANCH"; sed -n "s|^ref: refs/heads/||p" /data/openpilot/.git/HEAD 2>/dev/null; echo',
      'echo "@@COMMIT"; B=$(sed -n "s|^ref: refs/heads/||p" /data/openpilot/.git/HEAD 2>/dev/null); head -c 12 /data/openpilot/.git/refs/heads/$B 2>/dev/null; echo',
      'echo "@@BUILD"; cat build.json 2>/dev/null; echo',
      'echo "@@FORKS"; for d in carrot frogpilot sunnypilot dragonpilot; do [ -d selfdrive/$d ] && printf "%s " "$d"; done; echo',
      'echo "@@UP"; uptime; echo',
      'echo "@@DISK"; df -h /data 2>/dev/null | tail -1; echo',
      'echo "@@TMUX"; tmux ls 2>&1 | head -5; echo',
      'echo "@@WIN"; tmux list-windows -t comma 2>/dev/null | head -2; echo',
      'echo "@@TEMP"; cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null; echo'
    ].join('\n');

    function pick(raw, tag) {
      const m = String(raw).match(new RegExp('@@' + tag + '\\s*\\n([\\s\\S]*?)(?=\\n@@|$)'));
      return m ? m[1].trim() : '';
    }

    async function load() {
      cards.innerHTML = '';
      o.textContent = '读取中…';
      const RAW = await ex(PROBE, 25000);
      const branch = pick(RAW, 'BRANCH');
      const commit = pick(RAW, 'COMMIT');
      const buildRaw = pick(RAW, 'BUILD');
      const forks = pick(RAW, 'FORKS');
      const up = pick(RAW, 'UP');
      const disk = pick(RAW, 'DISK');
      const tmux = pick(RAW, 'TMUX');
      const win = pick(RAW, 'WIN');
      const temp = pick(RAW, 'TEMP');

      // build.json 里才是真正的"定制版本名"
      let bj = null;
      try { bj = JSON.parse(String(buildRaw).trim()); } catch (e) { bj = null; }
      const op = (bj && bj.openpilot) || {};
      const rel = String(op.release_notes || '').split('\n')[0].trim();   // 例：Carrot2-v9 (2025-09-21)
      const forkName = (rel.split('(')[0] || '').trim();
      const datePart = (rel.match(/\(([^)]+)\)/) || [])[1] || '';
      const forkList = String(forks).trim().split(/\s+/).filter(Boolean)
        .map(function (x) { return { carrot: 'CarrotPilot', frogpilot: 'FrogPilot', sunnypilot: 'SunnyPilot', dragonpilot: 'DragonPilot' }[x] || x; });

      const c = Number(temp) / 1000;
      cards.appendChild(card('定制版本', forkName || '未知',
        (datePart ? datePart + ' · ' : '') + '来自 build.json，这才是"Carrot/Frog"这类名字的来源'));
      cards.appendChild(card('基础 openpilot', op.version || '未知',
        '上游版本号' + (op.git_commit ? ' · 源码提交 ' + String(op.git_commit).slice(0, 7) : '')));
      cards.appendChild(card('git 分支', branch || '未知',
        '仓库里的分支名（被改成 Adapted_By_FangFei 了，跟版本名不是一回事）· 提交 ' + (String(commit).split(' ')[0] || '')));
      cards.appendChild(card('检测到的定制模块', forkList.length ? forkList.join(' + ') : '无',
        '从 /data/openpilot/selfdrive 下的目录判断'));
      cards.appendChild(card('运行时长', cnUptime(up), '设备开机到现在 / 登录人数 / CPU 平均负载（1、5、15 分钟）'));
      cards.appendChild(card('内置存储 /data', cnDf(disk), '行车记录和日志都放在这里'));
      cards.appendChild(card('openpilot 服务会话', cnTmux(tmux),
        'openpilot 的后台服务跑在这个 tmux 会话里（当前窗口：' + (String(win).split('\n')[0] || '未知') + '）。'
        + '它跟"终端"不是一回事：终端是你自己开的独立 shell，想看服务日志要 tmux a 进去'));
      cards.appendChild(card('SoC 温度', temp ? c.toFixed(1) + ' ℃' : '未知', c > 85 ? '偏高，注意散热' : '正常'));
      o.textContent = '原始输出：\n' + [branch, commit, up, disk, tmux, win].join('\n');
    }
    load();
  };

  /* ================= 车机 ================= */
  PANELS.car = function (pane) {
    const box = el('div', 'panel');
    pane.appendChild(box);
    h2(box, '车机面板', 'BYD DiLink 3.0 · ADB over EasyTier');
    const r = row();
    r.appendChild(btn('↻ 刷新', load, 'primary'));
    r.appendChild(btn('连接', async function () {
      const t = A.state.cfg.targets.find(function (x) { return x.id === 'car'; });
      const res = await rc.adbConnect(t.adb.addr);
      A.toast(res.message || (res.ok ? '已连接' : '连接失败'), res.ok ? undefined : 'fail');
      load();
    }));
    r.appendChild(btn('⌨ 打开终端', function () { A.openTerminal('car', 'adb', '车机 ADB'); }));
    r.appendChild(btn('▤ 文件管理', function () { A.openPanel('files', '文件管理', 'car'); }));
        r.appendChild(btn('投屏（车机画面）', function () { A.openPanel('carcast', '车机投屏'); }));
    box.appendChild(r);
    const cards = el('div', 'cards');
    box.appendChild(cards);
    const o = out();
    box.appendChild(o);

    async function load() {
      cards.innerHTML = '';
      const t = A.state.cfg.targets.find(function (x) { return x.id === 'car'; });
      o.textContent = '正在自动重连…';
      let ens = null;
      try { ens = await rc.adbEnsure(t.adb.addr); } catch (e) { /* 忽略 */ }
      let dv = [];
      try { dv = await rc.adbDevices(); } catch (e) { o.textContent = A.describeErr(e); return; }
      const me = dv.find(function (d) { return d.addr === t.adb.addr; });
      if (ens) cards.appendChild(card('网络探测', ens.state === 'device' ? '已连接' : (ens.state === 'offline' ? '不在网' : '在网但未授权'), ens.note || ''));
      cards.appendChild(card('ADB 状态', cnAdb(me ? me.state : ''), t.adb.addr));
      if (me && me.state === 'device') {
        try {
          const info = await rc.execOnce('car', 'adb', 'getprop ro.product.model; getprop ro.build.version.release; getprop ro.product.cpu.abi');
          cards.appendChild(card('设备信息', (info.stdout || '').split('\n').filter(Boolean).join(' / '), ''));
          const df = await rc.execOnce('car', 'adb', 'df -h /data | tail -1');
          cards.appendChild(card('/data', (df.stdout || '').trim(), ''));
        } catch (e) { /* 忽略 */ }
      } else if (me && me.state === 'unauthorized') {
        cards.appendChild(card('需要授权', 'unauthorized', '把手机 adbkey 装到本机即可免弹窗'));
      }
      o.textContent = 'ADB 设备：\n' + j(dv);
    }
    load();
  };



  /* ================= 运行日志 ================= */
  PANELS.logs = function (pane) {
    const box = el('div', 'panel');
    pane.appendChild(box);
    h2(box, '运行日志', '出问题先看这里');
    const r = row();
    r.appendChild(btn('↻ 刷新', load, 'primary'));
    r.appendChild(btn('打开日志目录', async function () {
      const x = await rc.logOpenDir();
      A.toast(x.message, x.ok ? undefined : 'fail');
    }));
    r.appendChild(btn('清空当前日志', async function () {
      await rc.logClear();
      A.toast('已清空');
      load();
    }));
    const fs2 = el('select', 'txt');
    fs2.onchange = function () { load(); };
    r.appendChild(fs2);
    const oe = el('input');
    oe.type = 'checkbox';
    oe.onchange = function () { load(); };
    const ow = el('label', 'badge');
    ow.style.cssText = 'display:flex;gap:6px;align-items:center;padding:4px 10px';
    ow.appendChild(oe);
    ow.appendChild(document.createTextNode('只看错误/警告'));
    r.appendChild(ow);
    box.appendChild(r);
    const stat = el('div', 'desc');
    box.appendChild(stat);
    const out = el('div', 'out');
    out.style.maxHeight = '560px';
    out.style.whiteSpace = 'pre-wrap';
    out.style.fontFamily = 'Consolas, monospace';
    out.style.fontSize = '12px';
    box.appendChild(out);

    async function load() {
      out.textContent = '读取中…';
      try {
        const files = await rc.logList();
        if (fs2.options.length !== files.length) {
          fs2.innerHTML = '';
          files.forEach(function (f) { const o = el('option', null, f); o.value = f; fs2.appendChild(o); });
          fs2.value = files[0] || '';
        }
        const name = fs2.value;
        const res = name ? { file: name, text: await rc.logRead(name) } : await rc.logTail(400);
        let lines = String(res.text || '').split('\n');
        if (oe.checked) lines = lines.filter(function (l) { return l.indexOf('[ERROR]') >= 0 || l.indexOf('[WARN ]') >= 0; });
        stat.textContent = '文件：' + (res.file || '无') + ' · 显示 ' + lines.length + ' 行'
          + (oe.checked ? '（已过滤）' : '') + ' · ' + new Date().toLocaleTimeString();
        out.textContent = lines.slice(-1200).join('\n') || '（没有内容）';
        out.scrollTop = out.scrollHeight;
      } catch (e) {
        out.textContent = '读取日志失败：' + A.describeErr(e);
      }
    }
    pane.refresh = function () { load(); };
    load();
  };

  /* ================= C3 参数（移植自 C3Shell 的 params_dump.py）================= */
  PANELS.params = function (pane) {
    const box = el('div', 'panel');
    pane.appendChild(box);
    h2(box, 'C3 参数', '点分组看参数；改完要重启对应服务');
    const r = row();
    r.appendChild(btn('读取 / 刷新', function () { load(true); }, 'primary'));
    const q = el('input', 'txt');
    q.placeholder = '搜索：中文名 / 参数名 / 说明 / 分组…';
    q.style.width = '300px';
    q.oninput = function () { render(); };
    r.appendChild(q);
    r.appendChild(el('span', 'desc', '（点下面的分组标签切换）'));
    const only = el('input');
    only.type = 'checkbox';
    only.onchange = function () { render(); };
    const ow = el('label', 'badge');
    ow.style.cssText = 'display:flex;gap:6px;align-items:center;padding:4px 10px';
    ow.appendChild(only);
    ow.appendChild(document.createTextNode('只看我改过的'));
    r.appendChild(ow);
    const ugc = el('input');
    ugc.type = 'checkbox';
    ugc.checked = true;                       // 未分组默认隐藏
    ugc.onchange = function () { renderChips(); render(); };
    const uw = el('label', 'badge');
    uw.style.cssText = 'display:flex;gap:6px;align-items:center;padding:4px 10px';
    uw.appendChild(ugc);
    uw.appendChild(document.createTextNode('隐藏未分组'));
    r.appendChild(uw);
    box.appendChild(r);

    const r2 = row();
    r2.appendChild(btn('保存快照', function () { snapSave(); }));
    r2.appendChild(btn('快照对比差异', function () { compare(); }));
    r2.appendChild(btn('管理快照', function () { manage(); }));
    box.appendChild(r2);
    const chips = el('div', 'chips');          // 分组：从左到右一排，点哪个看哪个
    box.appendChild(chips);
    const stat = el('div', 'desc');
    box.appendChild(stat);
    const list = el('div');
    box.appendChild(list);

    let data = null, loading = false, rows = [], gset = [];
    let curGroup = null;                // 当前选中的分组（null = 全部）

    async function load(force) {
      if (loading) return;
      loading = true;
      stat.textContent = force ? '正在从车机读取参数（第一次要十几秒）…' : '正在读取…';
      list.innerHTML = '';
      try {
        data = await rc.c3Params(!!force);
        build();
        stat.textContent = '共 ' + rows.length + ' 个参数 · ' + Object.keys(data.meta || {}).length + ' 个有中文说明'
          + (data.env && data.env.paramsDir ? ' · 活库 ' + data.env.paramsDir : '')
          + ' · 读取时间 ' + new Date().toLocaleTimeString();
        render();
      } catch (e) {
        stat.textContent = '读取失败：' + A.describeErr(e);
      } finally { loading = false; }
    }

    function build() {
      const reg = data.registry || [];
      const vals = data.values || {};
      const meta = data.meta || {};
      const defs = data.defaults || {};
      const grp = data.groups || {};
      const order = data.groupOrder || [];
      const idx = {};
      order.forEach(function (g, i) { idx[g] = i; });
      rows = reg.map(function (it) {
        const k = it.name;
        return {
          key: k,
          flags: it.flags || '',
          title: (meta[k] && (meta[k].title || meta[k].name)) || '',
          desc: (meta[k] && meta[k].desc) || '',
          group: grp[k] || '(未分组)',
          value: vals[k],
          def: defs[k]
        };
      });
      rows.sort(function (a, b) {
        const ia = idx[a.group] == null ? 99 : idx[a.group], ib = idx[b.group] == null ? 99 : idx[b.group];
        return ia - ib;
      });
      gset = [];
      rows.forEach(function (x) { if (gset.indexOf(x.group) < 0) gset.push(x.group); });
      renderChips();
    }

    function renderChips() {
      chips.innerHTML = '';
      const mk = function (label, g, cls) {
        const b = el('button', 'chip' + (curGroup === (g || null) ? ' on' : '') + (cls ? ' ' + cls : ''), label);
        b.onclick = function () {
          curGroup = (g && curGroup === g) ? null : (g || null);
          renderChips();
          render();
        };
        return b;
      };
      chips.appendChild(mk('全部 ' + rows.filter(function (x) { return ugc.checked ? x.group !== '(未分组)' : true; }).length, null));
      gset.forEach(function (g) {
        if (g === '(未分组)' && ugc.checked) return;
        const cnt = rows.filter(function (x) { return x.group === g; }).length;
        chips.appendChild(mk(g + ' ' + cnt, g, g === '(未分组)' ? 'dim' : ''));
      });
    }

    function changed(x) {
      return x.def != null && String(x.value) !== String(x.def) && x.value != null && x.value !== '';
    }

    function render() {
      list.innerHTML = '';
      if (!data) return;
      const kw = q.value.trim().toLowerCase();
      let arr = rows;
      if (ugc.checked) arr = arr.filter(function (x) { return x.group !== '(未分组)'; });
      if (curGroup) arr = arr.filter(function (x) { return x.group === curGroup; });
      if (only.checked) arr = arr.filter(changed);
      if (kw) {
        arr = arr.filter(function (x) {
          return (x.key + ' ' + x.title + ' ' + x.desc + ' ' + x.group + ' ' + String(x.value == null ? '' : x.value)).toLowerCase().indexOf(kw) >= 0;
        });
      }
      if (!arr.length) { list.appendChild(el('div', 'desc', '没有匹配的参数。')); return; }
      const CAP = 400;
      const show = arr.slice(0, CAP);
      let lastGroup = null;
      show.forEach(function (x) {
        if (x.group !== lastGroup) {
          const h = el('div', 'group-head');
          h.appendChild(el('span', null, x.group));
          h.appendChild(el('span', 'badge', arr.filter(function (y) { return y.group === x.group; }).length + ' 项'));
          list.appendChild(h);
          lastGroup = x.group;
        }
        // 直接摊开显示（不折叠）
        const li = el('div', 'list-item');
        const cur = x.value == null || x.value === '' ? '（空）' : String(x.value);
        const gg = el('div', 'grow');
        const nm = el('div', 'nm');
        nm.appendChild(document.createTextNode((x.title || x.key) + ' '));
        nm.appendChild(el('span', 'badge', x.key));
        if (changed(x)) nm.appendChild(el('span', 'badge warn', '已改'));
        if (x.flags && x.flags.indexOf('PERSISTENT') < 0) nm.appendChild(el('span', 'badge', '重启即失'));
        gg.appendChild(nm);
        if (x.desc) gg.appendChild(el('div', 'note', x.desc));
        gg.appendChild(el('div', 'cmd', '当前值：' + cur
          + (x.def != null && String(x.def) !== '' ? '    默认值：' + String(x.def) : '')
          + (x.flags ? '    属性：' + x.flags : '')));
        li.appendChild(gg);

        // 右侧直接改：输入框 + 保存 + 默认值（不再弹窗）
        const ed = el('div', 'pedit');
        const inp = el('input', 'txt pinput');
        inp.value = x.value == null ? '' : String(x.value);
        inp.spellcheck = false;
        inp.oninput = function () {
          const dirty = inp.value !== (x.value == null ? '' : String(x.value));
          inp.className = 'txt pinput' + (dirty ? ' dirty' : '');
          saveBtn.textContent = dirty ? '保存 *' : '保存';
          saveBtn.className = 'btn small' + (dirty ? ' primary' : '');
        };
        inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); doSave(); } };
        const doSave = async function () {
          try {
            const res = await rc.c3ParamSet(x.key, inp.value);
            x.value = res.value;
            inp.value = res.value == null ? '' : String(res.value);
            inp.className = 'txt pinput';
            saveBtn.textContent = '保存';
            saveBtn.className = 'btn small';
            A.toast('已保存 ' + x.key + ' = ' + (res.value == null || res.value === '' ? '(空)' : res.value));
          } catch (e) { A.toast(A.describeErr(e), 'fail'); }
        };
        const saveBtn = btn('✓ 保存', doSave, 'small');
        const defBtn = btn('↺ 默认值', function () {
          inp.value = x.def == null ? '' : String(x.def);
          inp.oninput();
          A.toast('已填入默认值 ' + (x.def == null || x.def === '' ? '(空)' : x.def) + '，点「保存」生效');
        }, 'small');
        ed.appendChild(inp);
        ed.appendChild(saveBtn);
        ed.appendChild(defBtn);
        li.appendChild(ed);

        list.appendChild(li);
      });
      if (arr.length > CAP) {
        list.appendChild(el('div', 'desc', '只显示了前 ' + CAP + ' 项（共 ' + arr.length + ' 项），用搜索或分组缩小范围。'));
      }
    }

    function edit(x) {
      formModal('修改参数 · ' + (x.title || x.key), [
        { key: 'v', label: '参数名（只读参考）', value: x.key },
        { key: 'val', label: '新值', value: x.value == null ? '' : String(x.value), placeholder: '留空表示清空' },
        { key: 'note', label: '说明', type: 'textarea', minH: '60px', value: (x.desc || '（这个参数没有中文说明）') + (x.def != null && String(x.def) !== '' ? '\n默认值：' + String(x.def) : '') }
      ], async function (v) {
        const res = await rc.c3ParamSet(x.key, v.val);
        A.toast('已写入 ' + x.key + ' = ' + (res.value == null ? '(空)' : res.value) + '（' + res.via + '）');
        x.value = res.value;
        render();
      });
    }

    // ---- 快照：自由命名 / 对比差异 / 管理 ----
    function currentValues() {
      const o = {};
      rows.forEach(function (x) { if (x.value != null && x.value !== '') o[x.key] = String(x.value); });
      return o;
    }

    function snapSave() {
      const cur = currentValues();
      formModal('保存参数快照', [
        { key: 'name', label: '名字（随便取，比如"改前""跑高速用"）', value: '快照 ' + new Date().toLocaleString() },
        { key: 'note', label: '说明（只存备注，不影响数据）', type: 'textarea', minH: '60px', value: '共 ' + Object.keys(cur).length + ' 个参数（只存有值的）' }
      ], async function (v) {
        await rc.c3SnapSave(v.name, cur);
        A.toast('已保存快照「' + v.name + '」· ' + Object.keys(cur).length + ' 个参数');
      });
    }

    async function compare() {
      const snaps = await rc.c3SnapList();
      if (!snaps.length) { A.toast('还没有快照，先点「保存快照」', 'fail'); return; }
      const srcs = [{ value: '__cur', label: '当前值（屏幕上的）' }].concat(snaps.map(function (s) {
        return { value: s.id, label: s.name + '（' + new Date(s.at).toLocaleString() + ' · ' + s.count + ' 项）' };
      }));
      const body = function (b) {
        const bar = el('div', 'row-flex');
        const mk = function (lbl, def) {
          const w = el('label', 'badge');
          w.style.cssText = 'display:flex;gap:6px;align-items:center;padding:4px 8px';
          w.appendChild(document.createTextNode(lbl));
          const s = el('select', 'txt');
          srcs.forEach(function (o) { const op = el('option', null, o.label); op.value = o.value; s.appendChild(op); });
          s.value = def;
          w.appendChild(s);
          bar.appendChild(w);
          return s;
        };
        const sa = mk('A：', snaps[0].id);
        const sb = mk('B：', '__cur');
        const ign = el('input');
        ign.type = 'checkbox';
        ign.checked = true;
        ign.onchange = function () { draw(); };
        const iw = el('label', 'badge');
        iw.style.cssText = 'display:flex;gap:6px;align-items:center;padding:4px 10px';
        iw.appendChild(ign);
        iw.appendChild(document.createTextNode('忽略空值'));
        bar.appendChild(iw);
        b.appendChild(bar);
        const ob = el('div');
        ob.style.marginTop = '10px';
        b.appendChild(ob);

        function vals(id) {
          if (id === '__cur') { const o = currentValues(); return o; }
          const s = snaps.find(function (y) { return y.id === id; });
          return (s && s.values) || {};
        }
        function draw() {
          ob.innerHTML = '';
          const va = vals(sa.value), vb = vals(sb.value);
          const keys = {};
          Object.keys(va).forEach(function (k) { keys[k] = 1; });
          Object.keys(vb).forEach(function (k) { keys[k] = 1; });
          const meta = (data && data.meta) || {};
          const sv = function (o, k) { return String(o[k] == null ? '' : o[k]); };
          let diffs = Object.keys(keys).filter(function (k) { return sv(va, k) !== sv(vb, k); }).sort();
          if (ign.checked) diffs = diffs.filter(function (k) { return sv(va, k) !== '' && sv(vb, k) !== ''; });
          ob.appendChild(el('div', 'desc', '差异 ' + diffs.length + ' 项 / 两边合计 ' + Object.keys(keys).length + ' 项'
            + (ign.checked ? '（已忽略"一边有值一边为空"的项）' : '')));
          if (!diffs.length) { ob.appendChild(el('div', 'desc', '两边完全一样 ✅')); return; }
          const tb = el('table', 'tbl');
          const hr = el('tr');
          ['参数', 'A：' + (sa.selectedOptions[0] ? sa.selectedOptions[0].textContent.slice(0, 14) : ''), 'B：' + (sb.selectedOptions[0] ? sb.selectedOptions[0].textContent.slice(0, 14) : '')].forEach(function (t) { hr.appendChild(el('th', null, t)); });
          tb.appendChild(hr);
          diffs.forEach(function (k) {
            const tr = el('tr');
            const td = el('td');
            td.appendChild(el('div', null, (meta[k] && (meta[k].title || meta[k].name)) || k));
            td.appendChild(el('span', 'badge', k));
            tr.appendChild(td);
            tr.appendChild(el('td', null, va[k] == null || va[k] === '' ? '（空）' : String(va[k])));
            tr.appendChild(el('td', null, vb[k] == null || vb[k] === '' ? '（空）' : String(vb[k])));
            tb.appendChild(tr);
          });
          ob.appendChild(tb);
        }
        sa.onchange = draw;
        sb.onchange = draw;
        draw();
      };
      A.modal('快照对比差异', body, async function () {}, '关闭');
    }

    async function manage() {
      const snaps = await rc.c3SnapList();
      if (!snaps.length) { A.toast('还没有快照', 'fail'); return; }
      const body = function (b) {
        snaps.forEach(function (s) {
          const li = el('div', 'list-item');
          const g = el('div', 'grow');
          const nm = el('div', 'nm');
          nm.appendChild(document.createTextNode(s.name + ' '));
          nm.appendChild(el('span', 'badge', s.count + ' 项'));
          g.appendChild(nm);
          g.appendChild(el('div', 'note', new Date(s.at).toLocaleString()));
          li.appendChild(g);
          li.appendChild(btn('改名', function () {
            formModal('快照改名', [{ key: 'name', label: '新名字', value: s.name }], async function (v) {
              await rc.c3SnapRename(s.id, v.name);
              A.toast('已改名');
              b.innerHTML = '';
              manage();
            });
          }, 'small'));
          li.appendChild(btn('✕ 删除', async function () {
            await rc.c3SnapDelete(s.id);
            A.toast('已删除');
            b.innerHTML = '';
            manage();
          }, 'small danger'));
          b.appendChild(li);
        });
      };
      A.modal('管理快照（最多留 50 个）', body, async function () {}, '关闭');
    }

    pane.refresh = function () { load(false); };
    load(false);
  };

  /* ================= 命令库 ================= */
  PANELS.commands = function (pane) {
    const box = el('div', 'panel');
    pane.appendChild(box);
    h2(box, '命令库', '保存常用命令 + 写备注，一键在对应设备上执行');
    const r = row();
    r.appendChild(btn('新增命令', function () { edit(null); }, 'primary'));
    const q = el('input', 'txt');
    q.placeholder = '搜索名称 / 备注 / 命令…';
    q.style.width = '260px';
    q.oninput = render;
    r.appendChild(q);
    box.appendChild(r);
    const list = el('div');
    box.appendChild(list);
    let items = [];

    const CHANNELS = [
      { value: 'ssh', label: 'ssh · SSH 登录 shell（C3）' },
      { value: 'root', label: 'root · U30 超级权限（UFI-TOOLS）' },
      { value: 'adb', label: 'adb · 安卓调试 shell' },
      { value: 'local', label: 'local · 本机 PowerShell' },
      { value: 'ufi', label: 'ufi · 后台 HTTP 接口' }
    ];

    function edit(rec) {
      const targets = A.state.cfg.targets || [];
      formModal(rec ? '编辑命令' : '新增命令', [
        { key: 'name', label: '名称', value: rec ? rec.name : '' },
        { key: 'note', label: '备注（这个命令是干什么的、什么时候用）', type: 'textarea', minH: '70px', value: rec ? rec.note : '' },
        { key: 'targetId', label: '目标设备', type: 'select', value: rec ? rec.targetId : 'c3', options: targets.map(function (t) { return { value: t.id, label: t.name }; }) },
        { key: 'channel', label: '通道', type: 'select', value: rec ? rec.channel : 'ssh', options: CHANNELS },
        { key: 'cmd', label: '命令内容', type: 'textarea', minH: '120px', value: rec ? rec.cmd : '' },
        { key: 'path', label: '接口路径（通道 = ufi 时填写）', value: rec ? (rec.path || '') : '', placeholder: '/api/baseDeviceInfo' }
      ], async function (v) {
        if (!v.name.trim()) throw new Error('名称不能为空');
        items = await rc.cmdlibSave({ id: rec ? rec.id : undefined, name: v.name.trim(), note: v.note, targetId: v.targetId, channel: v.channel, cmd: v.cmd, path: v.path.trim() });
        if (!Array.isArray(items)) items = await rc.cmdlibList();
        if (!Array.isArray(items)) throw new Error(String(items));
        render();
      });
    }

    function copyCmd(text) {
      try {
        navigator.clipboard.writeText(String(text));
        A.toast('已复制：' + String(text).slice(0, 40));
      } catch (e) { A.toast('复制失败：' + (e && e.message), 'fail'); }
    }

    function cmdRow(rec) {          // 注意：不能叫 row，会遮蔽外层的 row() 工具函数
      const li = el('div', 'list-item');
      const g = el('div', 'grow');
      const nm = el('div', 'nm');
      nm.appendChild(document.createTextNode(rec.name + ' '));
      nm.appendChild(el('span', 'badge', rec.channel));
      g.appendChild(nm);
      if (rec.note) g.appendChild(el('div', 'note', '备注：' + rec.note));
      const cmdText = rec.channel === 'ufi' ? ('GET ' + (rec.path || '')) : (rec.cmd || '');
      g.appendChild(el('div', 'cmd', cmdText));
      li.appendChild(g);
      li.appendChild(btn('▷ 执行', async function () {
        if (rec.channel === 'ufi') {
          try {
            const res = await rc.ufiApi({ targetId: rec.targetId, path: rec.path });
            const body = function (b) { b.appendChild(out(j(res.json != null ? res.json : res.text))); };
            A.modal('接口结果 · ' + rec.name, body, async function () {}, '关闭');
          } catch (e) { A.toast(A.describeErr(e), 'fail'); }
        } else {
          runInTerminal(rec.targetId, channelKind(rec.channel), rec.name, rec.cmd);
        }
      }, 'small'));
      li.appendChild(btn('⎘ 复制', function () { copyCmd(cmdText); }, 'small'));
      li.appendChild(btn('✎ 编辑', function () { edit(rec); }, 'small'));
      li.appendChild(btn('✕ 删除', async function () { items = await rc.cmdlibDelete(rec.id); render(); }, 'small danger'));
      return li;
    }

    function render() {
      const kw = q.value.trim().toLowerCase();
      list.innerHTML = '';
      let arr = Array.isArray(items) ? items.slice() : [];
      if (kw) arr = arr.filter(function (x) { return (x.name + ' ' + (x.note || '') + ' ' + (x.cmd || '') + ' ' + (x.path || '')).toLowerCase().indexOf(kw) >= 0; });
      if (!arr.length) { list.appendChild(el('div', 'desc', '还没有命令，点「新增命令」添加。')); return; }

      // 按设备分组，设备顺序跟侧栏一致
      const targets = A.state.cfg.targets || [];
      const groups = {};
      arr.forEach(function (rec) { const k = rec.targetId || '未指定'; (groups[k] = groups[k] || []).push(rec); });
      const PREF = ['c3', 'car', 'u30', 'local'];   // 常用顺序：C3 → 车机 → U30 → 本机
      Object.keys(groups).sort(function (a, b) {
        const ia = PREF.indexOf(a), ib = PREF.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      }).forEach(function (id) {
        const t = targets.find(function (x) { return x.id === id; });
        const head = el('div', 'group-head');
        head.appendChild(el('span', null, t ? t.name : id));
        head.appendChild(el('span', 'badge', groups[id].length + ' 条'));
        list.appendChild(head);
        groups[id].forEach(function (rec) { list.appendChild(cmdRow(rec)); });
      });
    }
    rc.cmdlibList().then(function (x) { items = x; render(); });
    pane.refresh = function () { rc.cmdlibList().then(function (x) { items = x; render(); }); };
  };

  /* ================= 脚本库 ================= */
  PANELS.scripts = function (pane) {
    const box = el('div', 'panel');
    pane.appendChild(box);
    h2(box, '脚本库（.sh）', '脚本以真实 .sh 文件保存，可写备注、可关联到设备，一键运行 / 导入导出');
    const r = row();
    r.appendChild(btn('新建脚本', function () { editor(null); }, 'primary'));
    r.appendChild(btn('导入 .sh', async function () { await rc.scriptImport(); load(); }));
    r.appendChild(btn('打开脚本目录', function () { rc.scriptOpenDir(); }));
    r.appendChild(btn('把 .sh 关联到本程序', async function () {
      const res = await rc.scriptAssociate();
      A.toast(res.message || (res.ok ? '已关联' : '关联失败'), res.ok ? undefined : 'fail');
    }));
    box.appendChild(r);
    const list = el('div');
    box.appendChild(list);
    let items = [];

    function editor(rec) {
      const loading = rec ? rc.scriptRead(rec.id) : Promise.resolve({ meta: { name: '新脚本', note: '', targetId: '', channel: 'ssh' }, content: '#!/bin/sh\n# 在这里写你的脚本\n' });
      loading.then(function (full) {
        const targets = [{ value: '', label: '（不关联）' }].concat((A.state.cfg.targets || []).map(function (t) { return { value: t.id, label: t.name }; }));
        const chans = [
          { value: 'ssh', label: 'ssh · C3' }, { value: 'root', label: 'root · U30 超级权限' },
          { value: 'adb', label: 'adb · 安卓调试' }, { value: 'local', label: 'local · 本机' }
        ];
        formModal((rec ? '编辑脚本 · ' : '新建脚本 · ') + (full.meta.name || ''), [
          { key: 'name', label: '脚本名（会作为 .sh 文件名）', value: full.meta.name },
          { key: 'note', label: '备注', type: 'textarea', minH: '64px', value: full.meta.note || '' },
          { key: 'targetId', label: '关联设备', type: 'select', value: full.meta.targetId || '', options: targets },
          { key: 'channel', label: '关联通道', type: 'select', value: full.meta.channel || 'ssh', options: chans },
          { key: 'content', label: '脚本内容', type: 'textarea', minH: '280px', value: full.content }
        ], async function (v) {
          const nm = v.name.trim() || (rec ? rec.name : '新脚本');
          await rc.scriptSave({ id: rec ? rec.id : undefined, name: nm, note: v.note, targetId: v.targetId, channel: v.channel }, v.content);
          load();
        });
      }).catch(function (e) { A.toast('打开脚本失败：' + A.describeErr(e), 'fail'); });
    }

    async function run(rec) {
      const full = await rc.scriptRead(rec.id);
      let targetId = rec.targetId;
      let channel = rec.channel || 'ssh';
      if (!targetId) {
        A.toast('这个脚本还没关联设备，请先点「编辑」选择关联设备与通道', 'fail');
        return;
      }
      const tab = await A.openTerminal(targetId, channelKind(channel), '脚本：' + rec.name, 2500);
      await new Promise(function (r) { setTimeout(r, 2200); });
      if (tab && tab.term) tab.term.write('\x1b[36m$ 运行脚本 ' + rec.file + ' …\x1b[0m\r\n');
      A.setBusy('正在运行脚本 ' + rec.name + ' …');
      try {
        const res = await rc.scriptRun(targetId, channel, full.content);
        const text = (res.stdout || '') + (res.stderr || '');
        if (tab && tab.term) tab.term.write(text.replace(/\r?\n/g, '\r\n') + '\r\n\x1b[90m[脚本结束，退出码 ' + res.code + ']\x1b[0m\r\n');
      } catch (e) {
        if (tab && tab.term) tab.term.write('\x1b[31m' + A.describeErr(e) + '\x1b[0m\r\n');
      } finally { A.clearBusy(); }
    }

    async function load() {
      items = await rc.scriptList();
      list.innerHTML = '';
      if (!items.length) { list.appendChild(el('div', 'desc', '还没有脚本，点「新建脚本」或「导入 .sh」。')); return; }
      items.forEach(function (rec) {
        const li = el('div', 'list-item');
        const g = el('div', 'grow');
        const nm = el('div', 'nm');
        nm.appendChild(document.createTextNode(rec.name + ' '));
        const t = (A.state.cfg.targets || []).find(function (x) { return x.id === rec.targetId; });
        nm.appendChild(el('span', 'badge', t ? (t.name + ' / ' + rec.channel) : '未关联'));
        g.appendChild(nm);
        if (rec.note) g.appendChild(el('div', 'note', '备注：' + rec.note));
        g.appendChild(el('div', 'cmd', rec.file + (rec.size >= 0 ? ('  (' + rec.size + ' 字节)') : '  (文件缺失)')));
        li.appendChild(g);
        li.appendChild(btn('运行', function () { run(rec); }, 'small primary'));
        li.appendChild(btn('✎ 编辑', function () { editor(rec); }, 'small'));
        li.appendChild(btn('导出', async function () {
          const full = await rc.scriptRead(rec.id);
          const res = await rc.scriptExport(full.content, rec.name);
          if (res.ok) A.toast('已导出到 ' + res.path);
        }, 'small'));
        li.appendChild(btn('✕ 删除', async function () { items = await rc.scriptDelete(rec.id); load(); }, 'small danger'));
        list.appendChild(li);
      });
    }
    load();
    pane.refresh = load;
  };

  /* ================= 巡检报告 ================= */
  PANELS.health = function (pane) {
    const box = el('div', 'panel');
    pane.appendChild(box);
    h2(box, '巡检报告', '本机 → 隧道 → U30 Air → 局域网 → C3 / 车机');
    const r = row();
    r.appendChild(btn('↻ 重新巡检', function () { A.runHealth(); }, 'primary'));
    box.appendChild(r);
    const body = el('div');
    box.appendChild(body);
    pane.refresh = function () {
      body.innerHTML = '';
      const partial = A.state.healthPartial || [];
      const hs = A.state.health || (partial.length ? { steps: partial, at: Date.now(), partial: true } : null);
      if (A.state.healthRunning && partial.length) {
        const p = el('div', 'progbar');
        const fill = el('i');
        fill.style.width = Math.round(partial.length / 8 * 100) + '%';
        p.appendChild(fill);
        body.appendChild(p);
        body.appendChild(el('div', 'desc', '正在巡检 ' + partial.length + '/8 …'));
      }
      if (!hs) { body.appendChild(el('div', 'desc', '尚未巡检')); return; }
      const tb = el('table', 'tbl');
      const head = el('tr');
      ['#', '检查项', '结果', '详情', '耗时'].forEach(function (x) { head.appendChild(el('th', null, x)); });
      tb.appendChild(head);
      hs.steps.forEach(function (s, i) {
        const tr = el('tr');
        tr.appendChild(el('td', null, String(i + 1)));
        tr.appendChild(el('td', null, s.name));
        const td = el('td');
        td.appendChild(el('span', 'badge ' + s.status, s.status === 'ok' ? '通过' : (s.status === 'warn' ? '注意' : '失败')));
        tr.appendChild(td);
        tr.appendChild(el('td', null, s.detail || ''));
        tr.appendChild(el('td', null, s.ms == null ? '' : (s.ms >= 1000 ? (s.ms / 1000).toFixed(1) + 's' : s.ms + 'ms')));
        tb.appendChild(tr);
      });
      body.appendChild(tb);
      body.appendChild(el('div', 'desc', '巡检时间：' + new Date(hs.at).toLocaleString()
        + (hs.elapsed ? ' · 总耗时 ' + (hs.elapsed / 1000).toFixed(1) + ' 秒' : '')));
    };
    pane.refresh();
  };

  /* ================= ADB 设备 ================= */
  PANELS.adb = function (pane) {
    const box = el('div', 'panel');
    pane.appendChild(box);
    h2(box, 'ADB 设备', 'U30 Air 与车机都走网络 ADB');
    const r = row();
    r.appendChild(btn('↻ 刷新', load, 'primary'));
    r.appendChild(btn('自动重连全部设备', async function () {
      const list = await rc.adbEnsureAll();
      A.toast(list.map(function (x) { return x.id + '=' + x.state; }).join('  '));
      load();
      if (A.refreshAllPanels) A.refreshAllPanels();
    }));
    const addr = el('input', 'txt');
    addr.placeholder = '192.168.0.100:5555';
    addr.style.width = '200px';
    r.appendChild(addr);
    r.appendChild(btn('连接', async function () {
      const res = await rc.adbConnect(addr.value.trim());
      A.toast(res.message, res.ok ? undefined : 'fail');
      load();
    }));
    r.appendChild(btn('断开', async function () {
      const res = await rc.adbDisconnect(addr.value.trim());
      A.toast(res.message);
      load();
    }));
    box.appendChild(r);
    const o = out();
    box.appendChild(o);
    async function load() {
      let list = [];
      try { list = await rc.adbDevices(); } catch (e) { o.textContent = A.describeErr(e); return; }
      o.textContent = '';
      if (!list || !list.length) { o.textContent = '当前没有已连接的网络 ADB 设备。' + String.fromCharCode(10) + 'U30 Air 是 10.126.126.1:5555，车机是 192.168.0.100:5555，点上面的「自动重连全部设备」试试。'; return; }
      const tb = el('table', 'tbl');
      const head = el('tr');
      ['设备地址', '状态', '说明'].forEach(function (x) { head.appendChild(el('th', null, x)); });
      tb.appendChild(head);
      list.forEach(function (d) {
        const tr = el('tr');
        tr.appendChild(el('td', null, d.addr));
        const td = el('td');
        const ok = d.state === 'device';
        td.appendChild(el('span', 'badge ' + (ok ? 'ok' : (d.state === 'unauthorized' ? 'warn' : 'fail')), cnAdb(d.state)));
        tr.appendChild(td);
        tr.appendChild(el('td', null, d.detail || ''));
        tb.appendChild(tr);
      });
      o.appendChild(tb);
    }
    load();
  };

  /* ================= 设置 ================= */
  PANELS.settings = function (pane) {
    const box = el('div', 'panel');
    pane.appendChild(box);
    h2(box, '设置', '设备连接参数与红线守卫');
    const body = el('div');
        try {
      const fxBox = el('div');
      fxBox.style.cssText = 'margin:0 0 18px;padding:0';
      h2(fxBox, '界面动效', '粒子背景 / 过渡动画 / 发光效果。觉得费电、或者老机器嫌卡，就在这里关掉。');
      const fxr = el('div', 'row-flex');
      const mkT = function (label, key) {
        const c = el('input'); c.type = 'checkbox';
        c.checked = !(A.state.cfg && A.state.cfg[key] === false);
        c.onchange = async function () {
          const v = c.checked;
          const o = {}; o[key] = v;
          await rc.cfgSet(o);
          if (A.state.cfg) A.state.cfg[key] = v;
          if (key === 'fx' && window.FX) window.FX.set(v);
          A.toast(label + '：' + (v ? '已开启' : '已关闭'));
        };
        const w = el('label', 'badge');
        w.style.cssText = 'display:flex;gap:6px;align-items:center;padding:6px 12px';
        w.appendChild(c); w.appendChild(document.createTextNode(label));
        return w;
      };
      fxr.appendChild(mkT('粒子背景 / 动效（科技风）', 'fx'));
      fxBox.appendChild(fxr);
      // 已在 box 内
    } catch (e) {}
box.appendChild(body);

    function render() {
      body.innerHTML = '';
      const c = A.state.cfg;
      body.appendChild(el('div', 'field')).appendChild(el('label', null, ''));
      ['adbPath', 'scrcpyDir'].forEach(function (k) {
        const d = el('div', 'field');
        d.appendChild(el('label', null, k === 'adbPath' ? 'adb.exe 路径' : 'scrcpy 目录'));
        const i = el('input', 'txt');
        i.value = c[k] || '';
        i.onchange = async function () { const p = {}; p[k] = i.value; A.state.cfg = await rc.cfgSet(p); A.toast('已保存'); };
        d.appendChild(i);
        body.appendChild(d);
      });
      const dth = el('div', 'field');
      dth.appendChild(el('label', null, '主题'));
      const wrap = el('div', 'row-flex');
      (A.themeList || []).forEach(function (th) {
        const cell = el('div');
        cell.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer';
        const s = el('div', 'swatch' + (A.state.theme === th.id ? ' active' : ''));
        s.style.background = 'linear-gradient(135deg, ' + th.bg + ' 0 55%, ' + th.fg + ' 55% 100%)';
        cell.appendChild(s);
        cell.appendChild(el('span', 'hint', th.name));
        cell.onclick = function () { A.applyTheme(th.id, true); render(); };
        wrap.appendChild(cell);
      });
      dth.appendChild(wrap);
      body.appendChild(dth);

      const dg = el('div', 'field');
      dg.appendChild(el('label', null, '红线守卫模式'));
      const sg = el('select', 'txt');
      [{ v: 'strict', l: '严格 —— 违反商家红线的操作代码级硬禁用（推荐）' }, { v: 'relaxed', l: '宽松 —— 允许执行，但必须手输确认文字' }].forEach(function (o) {
        const op = el('option', null, o.l); op.value = o.v; sg.appendChild(op);
      });
      sg.value = c.guard;
      sg.onchange = async function () {
        A.state.cfg = await rc.cfgSet({ guard: sg.value });
        document.getElementById('guard-mode').textContent = sg.value === 'strict' ? '严格（硬禁用）' : '宽松（需确认）';
        A.toast('已切换为' + (sg.value === 'strict' ? '严格' : '宽松') + '模式');
      };
      dg.appendChild(sg);
      body.appendChild(dg);

      body.appendChild(el('h2', null, '设备参数'));
      (c.targets || []).forEach(function (t) {
        const cardBox = el('div', 'card');
        cardBox.style.marginBottom = '10px';
        cardBox.appendChild(el('div', 'k', t.name + '（' + cnKind(t.kind) + '）'));
        const f = function (key, val, path) {
          const d = el('div', 'field');
          d.appendChild(el('label', null, key));
          const i = el('input', 'txt');
          i.value = val == null ? '' : val;
          i.onchange = async function () {
            const patch = JSON.parse(JSON.stringify(t));
            let obj = patch;
            const parts = path.split('.');
            for (let k = 0; k < parts.length - 1; k++) obj = obj[parts[k]];
            obj[parts[parts.length - 1]] = i.value;
            await rc.cfgSetTarget(t.id, patch);
            A.state.cfg = await rc.cfgGet();
            A.toast('已保存 ' + t.name + ' 的 ' + key);
          };
          d.appendChild(i);
          cardBox.appendChild(d);
        };
        if (t.ufi) { f('后台地址', t.ufi.base, 'ufi.base'); f('局域网后台地址', t.ufi.baseLan, 'ufi.baseLan'); f('后台令牌', t.ufi.token, 'ufi.token'); }
        if (t.adb) f('ADB 地址', t.adb.addr, 'adb.addr');
        if (t.ssh) { f('主机', t.ssh.host, 'ssh.host'); f('端口', t.ssh.port, 'ssh.port'); f('用户', t.ssh.user, 'ssh.user'); f('私钥路径', t.ssh.keyPath, 'ssh.keyPath'); }
        body.appendChild(cardBox);
      });

      const r2 = row();
      r2.appendChild(btn('打开数据目录', function () { rc.paths().then(function (p) { rc.openExternal('file:///' + p.scriptsDir.replace(/\\\\/g, '/')); }); }));
      body.appendChild(r2);
    }
    render();
  };

  /* ================= 关于 / 更新日志 ================= */
  PANELS.about = function (pane) {
    const box = el('div', 'panel');
    pane.appendChild(box);
    h2(box, '关于', '远程控制台 · U30 Air / C3 / 车机');
    const info = A.state.info || {};
    const cards = el('div', 'cards');
    cards.appendChild(card('版本', 'v' + (info.version || '?'), ''));
    cards.appendChild(card('Electron', info.electron || '-', 'Chromium ' + (info.chrome || '-') + ' · Node ' + (info.node || '-')));
    cards.appendChild(card('设备', (A.state.cfg.targets || []).map(function (t) { return t.name; }).join(' / '), ''));
    box.appendChild(cards);
    box.appendChild(el('h2', null, '更新日志'));
    const pre = el('div');
    pre.style.marginTop = '6px';
    String(info.changelog || '').split('\n').forEach(function (line) {
      const t = line.trim();
      if (!t) { pre.appendChild(el('div', null, '')); return; }
      if (t.indexOf('## ') === 0) {
        pre.appendChild(el('div', 'log-h', t.slice(3)));
      } else if (t.indexOf('# ') === 0) {
        // 文档大标题不重复显示
      } else if (t.indexOf('**') === 0) {
        pre.appendChild(el('div', 'log-b', t.replace(/\*\*/g, '')));
      } else {
        pre.appendChild(el('div', 'log-d', t.replace(/^- /, '· ').replace(/\*\*/g, '')));
      }
    });
    box.appendChild(pre);
  };

  window.PANELS = Object.assign(window.PANELS || {}, PANELS);
};
