'use strict';
/* 远程控制台 · 渲染层核心（终端 / 标签页 / 侧栏） */
const rcApi = window.rc;

// 渲染进程的任何报错都写进日志文件，方便直接读
function showCrash(msg) {
  try {
    if (document.getElementById("crash-banner")) return;
    var d = document.createElement("div");
    d.id = "crash-banner";
    d.appendChild(document.createTextNode("界面出错了：" + String(msg).slice(0, 120)));
    var b = document.createElement("button");
    b.textContent = "打开运行日志";
    b.onclick = function () { try { openPanel("logs", "运行日志"); } catch (e) { rcApi.logOpenDir(); } };
    d.appendChild(b);
    document.body.appendChild(d);
  } catch (e) {}
}
window.addEventListener('error', function (e) {
  showCrash(e.message || e.error);
  try { rcApi.logWrite('error', '渲染错误: ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '') + (e.error && e.error.stack ? ('\n' + e.error.stack) : '')); } catch (x) {}
});
window.addEventListener('unhandledrejection', function (e) {
  try { const r = e.reason; rcApi.logWrite('error', '渲染未处理拒绝: ' + ((r && (r.stack || r.message)) || String(r))); } catch (x) {}
});

const state = {
  cfg: null,
  tabs: [],
  activeId: null,
  health: null,
  seq: 1
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function $(id) { return document.getElementById(id); }

const DARK_ANSI = {
  black: '#1b2637', red: '#ef4444', green: '#12b886', yellow: '#f59e0b',
  blue: '#3b82f6', magenta: '#a855f7', cyan: '#22d3ee', white: '#dfe7f1',
  brightBlack: '#64748b', brightRed: '#ff7b7b', brightGreen: '#3ddc97',
  brightYellow: '#ffc14d', brightBlue: '#7cb0ff', brightMagenta: '#c99cff',
  brightCyan: '#67e8f9', brightWhite: '#ffffff'
};
const LIGHT_ANSI = {
  black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#953800',
  blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37',
  brightYellow: '#bf8700', brightBlue: '#218bff', brightMagenta: '#a475f9',
  brightCyan: '#3192aa', brightWhite: '#8c959f'
};
const TERM_HEAD = {
  dark:   { bg: '#0b1119', fg: '#dfe7f1', cur: '#12b886', sel: '#2a4a63' },
  light:  { bg: '#ffffff', fg: '#1b2534', cur: '#0ca678', sel: '#cfe3ff' },
  blue:   { bg: '#071022', fg: '#dbe8f8', cur: '#3b82f6', sel: '#1d3f6b' },
  purple: { bg: '#0d0a16', fg: '#eae1f8', cur: '#a855f7', sel: '#3a2b57' },
  forest: { bg: '#08110e', fg: '#dcefe6', cur: '#22c55e', sel: '#1c4030' },
  rose:   { bg: '#150c12', fg: '#f8e5ef', cur: '#ec4899', sel: '#4c2c41' },
  solar:  { bg: '#00212a', fg: '#eee8d5', cur: '#859900', sel: '#0d5462' }
};
const THEME_LIST = [
  { id: 'dark', name: '暗夜', bg: '#0e1520', fg: '#12b886' },
  { id: 'light', name: '白昼', bg: '#f2f5f9', fg: '#0ca678' },
  { id: 'blue', name: '深海蓝', bg: '#0a1424', fg: '#3b82f6' },
  { id: 'purple', name: '暗紫', bg: '#130f20', fg: '#a855f7' },
  { id: 'forest', name: '墨绿', bg: '#0b1512', fg: '#22c55e' },
  { id: 'rose', name: '玫瑰', bg: '#1a1016', fg: '#ec4899' },
  { id: 'solar', name: 'Solarized', bg: '#00252e', fg: '#859900' }
];

function termTheme(name) {
  const h = TERM_HEAD[name] || TERM_HEAD.dark;
  const ansi = name === 'light' ? LIGHT_ANSI : DARK_ANSI;
  return Object.assign({}, ansi, {
    background: h.bg, foreground: h.fg, cursor: h.cursor, selectionBackground: h.sel,
    cursorAccent: h.bg
  });
}

function applyTheme(name, persist) {
  if (!TERM_HEAD[name]) name = 'dark';
  state.theme = name;
  document.documentElement.setAttribute('data-theme', name);
  try { if (window.FX) window.FX.set(!(state.cfg && state.cfg.fx === false)); } catch (e) {}
  const t = termTheme(name);
  state.tabs.forEach(function (tab) { if (tab.term) { try { tab.term.options.theme = t; } catch (e) {} } });
  Object.keys(state.dotStatus || {}).forEach(renderDot);
  if (persist) rcApi.cfgSet({ theme: name });
}

function showThemeMenu(x, y) {
  document.querySelectorAll('.term-menu').forEach(function (n) { n.remove(); });
  const m = el('div', 'term-menu');
  m.style.left = (x || 120) + 'px';
  m.style.top = (y || 56) + 'px';
  THEME_LIST.forEach(function (th) {
    const d = el('div', 'term-menu-item');
    const sw = el('span');
    sw.style.cssText = 'display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:8px;vertical-align:-1px;background:' + th.fg + ';border:1px solid ' + th.bg;
    d.appendChild(sw);
    d.appendChild(document.createTextNode(th.name + (state.theme === th.id ? '  ✓' : '')));
    d.onclick = function () { applyTheme(th.id, true); m.remove(); };
    m.appendChild(d);
  });
  document.body.appendChild(m);
  const close = function (ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('mousedown', close); } };
  setTimeout(function () { document.addEventListener('mousedown', close); }, 0);
}

/* ---------------- 标签页 ---------------- */
function tabById(id) { return state.tabs.find(function (t) { return t.id === id; }); }

function addTab(tab) {
  tab.el = el('div', 'pane');
  $('content').appendChild(tab.el);
  state.tabs.push(tab);
  renderTabs();
  activate(tab.id);
  return tab;
}

function renderTabs() {
  const box = $('tabs');
  box.innerHTML = '';
  state.tabs.forEach(function (t) {
    const active = t.id === state.activeId;
    const e = el('div', 'tab' + (active ? ' active' : ''));
    if (active) e.appendChild(el('span', 'tab-flag'));   // 明确标出"当前选中"
    e.appendChild(el('span', null, t.title));
    const x = el('span', 'x', '×');
    x.title = '关闭';
    x.onclick = function (ev) {
      ev.stopPropagation();
      closeTab(t.id);
    };
    e.appendChild(x);
    e.onclick = function () { activate(t.id); };
    box.appendChild(e);
  });
}

function activate(id) {
  state.activeId = id;
  state.tabs.forEach(function (t) { t.el.classList.toggle('active', t.id === id); });
  renderTabs();
  const t = tabById(id);
  if (t && t.fit) { setTimeout(function () { try { t.fit.fit(); } catch (e) {} }, 30); }
  if (t && t.onShow) t.onShow();
}

function closeTab(id) {
  const t = tabById(id);
  if (!t) return;
  if (t.sessionId) { rcApi.sessionClose(t.sessionId); }
  if (t.term) { try { t.term.dispose(); } catch (e) {} }
  t.el.remove();
  state.tabs = state.tabs.filter(function (x) { return x.id !== id; });
  if (state.activeId === id && state.tabs.length) activate(state.tabs[state.tabs.length - 1].id);
  if (!state.tabs.length) state.activeId = null;
  renderTabs();
}

function openPanel(name, title, arg) {
  const existing = state.tabs.find(function (t) { return t.panelName === name; });
  if (existing) {
    activate(existing.id);
    if (arg && typeof existing.el.setTarget === 'function') existing.el.setTarget(arg);
    return existing;
  }
  const tab = addTab({ id: 'tab-' + (state.seq++), kind: 'panel', title: title || name, panelName: name, arg: arg });
  tab.el.__arg = arg;
  const render = window.PANELS[name];
  if (render) render(tab.el, tab);
  return tab;
}

/* ---------------- 终端 ---------------- */
async function openTerminal(targetId, kindCode, title) {
  const target = (state.cfg.targets || []).find(function (t) { return t.id === targetId; });
  if (!target) { toast('未知设备：' + targetId, 'fail'); return; }
  // 已经有同设备同类型的终端就直接切过去，不再开一个重复的
  const exist = state.tabs.find(function (t) { return t.kind === 'term' && t.targetId === targetId && t.kindCode === kindCode && t.alive !== false; });
  if (exist) { activate(exist.id); return exist; }

  const host = el('div', 'term-host');
  const tab = addTab({ id: 'tab-' + (state.seq++), kind: 'term', title: title || (target.name + ' · ' + kindCode), targetId: targetId, kindCode: kindCode });
  tab.el.appendChild(host);

  const term = new Terminal({
    fontFamily: 'Consolas, "Cascadia Mono", "Microsoft YaHei Mono", monospace',
    fontSize: 13, lineHeight: 1.25, scrollback: 8000,
    cursorBlink: true, cursorStyle: 'block', cursorInactiveStyle: 'outline',
    allowProposedApi: true, theme: termTheme(state.theme), windowsMode: false
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  try { fit.fit(); } catch (e) {}
  tab.term = term;
  tab.fit = fit;

  const ro = new ResizeObserver(function () {
    try { fit.fit(); } catch (e) {}
    if (tab.sessionId && tab.mode === 'pty') rcApi.sessionResize(tab.sessionId, term.cols, term.rows);
  });
  ro.observe(host);
  tab.ro = ro;

  // 只写一行，连上后立刻清掉（用 \r + 清行，不留"一直正在连接"）
  term.write('\x1b[90m正在连接 ' + target.name + '（' + kindCode + '）…\x1b[0m');
  tab.ready = false;

  let sess;
  try {
    sess = await rcApi.sessionOpen({ targetId: targetId, kindCode: kindCode, cols: term.cols, rows: term.rows });
  } catch (e) {
    term.write('\r\x1b[2K\x1b[31m[连接失败] ' + describeErr(e) + '\x1b[0m\r\n');
    tab.ready = true;
    return;
  }
  // 兜底：8 秒还没收到任何数据，就把"正在连接"换成提示
  tab.readyTimer = setTimeout(function () {
    if (tab.ready) return;
    tab.ready = true;
    term.write('\r\x1b[2K\x1b[33m[已连接，但设备 8 秒内没有输出；按一下回车试试]\x1b[0m\r\n');
    term.focus();
  }, 8000);
  tab.sessionId = sess.id;
  tab.mode = sess.mode;
  tab.sessionIds = tab.sessionIds || {};
  sessionMap[sess.id] = tab;

  if (sess.mode === 'pty') {
    tab.sendInput = function (d) { rcApi.sessionWrite(sess.id, d); };
    term.onData(function (d) { tab.sendInput(d); });
    tab.onShow = function () { try { term.focus(); fit.fit(); } catch (e) {} };
  } else {
    attachRepl(tab);
  }
  setupClipboard(tab, term, host);
  return tab;
}

/* ---------------- 复制 / 粘贴 / 右键菜单 ---------------- */
function copySelection(term) {
  const sel = term.getSelection();
  if (!sel) return false;
  try {
    navigator.clipboard.writeText(sel);
    if (window.APP) window.APP.toast('已复制 ' + sel.length + ' 个字符');
  } catch (e) { /* 忽略 */ }
  return true;
}

async function pasteToTab(tab) {
  try {
    const text = await navigator.clipboard.readText();
    if (text && tab.sendInput) {
      tab.sendInput(text.replace(/\r?\n/g, tab.mode === 'pty' ? '\n' : '\r'));
      if (tab.term) tab.term.focus();
    }
  } catch (e) {
    if (window.APP) window.APP.toast('读取剪贴板失败：' + (e && e.message), 'fail');
  }
}

function showTermMenu(x, y, tab, term) {
  document.querySelectorAll('.term-menu').forEach(function (n) { n.remove(); });
  const m = document.createElement('div');
  m.className = 'term-menu';
  m.style.left = x + 'px';
  m.style.top = y + 'px';
  const item = function (label, fn) {
    const d = document.createElement('div');
    d.className = 'term-menu-item';
    d.textContent = label;
    d.onclick = function () { m.remove(); fn(); };
    m.appendChild(d);
  };
  item('复制' + (term.hasSelection() ? '（已选中 ' + term.getSelection().length + ' 字）' : ''), function () { copySelection(term); });
  item('粘贴', function () { pasteToTab(tab); });
  item('全选', function () { term.selectAll(); });
  item('清屏', function () { term.clear(); });
  item('保存会话日志', function () {
    const b = term.buffer.active;
    let s = '';
    for (let i = 0; i < b.length; i++) { const l = b.getLine(i); s += (l ? l.translateToString(true) : '') + '\r\n'; }
    const blob = new Blob([s], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (tab.title || 'session').replace(/[^\w\u4e00-\u9fa5-]+/g, '_') + '.log';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });
  document.body.appendChild(m);
  const close = function (ev) {
    if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('mousedown', close); }
  };
  setTimeout(function () { document.addEventListener('mousedown', close); }, 0);
}

function setupClipboard(tab, term, host) {
  if (host) {
    host.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      showTermMenu(ev.clientX, ev.clientY, tab, term);
    });
  }
  term.attachCustomKeyEventHandler(function (e) {
    if (e.type !== 'keydown') return true;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.shiftKey && e.code === 'KeyC') { copySelection(term); return false; }
    if (ctrl && e.shiftKey && e.code === 'KeyV') { pasteToTab(tab); return false; }
    if (ctrl && !e.shiftKey && e.code === 'KeyC' && term.hasSelection()) { copySelection(term); return false; }
    if (ctrl && !e.shiftKey && e.code === 'KeyV') { pasteToTab(tab); return false; }
    if (ctrl && e.code === 'Insert') { copySelection(term); return false; }
    if (e.shiftKey && e.code === 'Insert') { pasteToTab(tab); return false; }
    return true;
  });
}

const sessionMap = {};

function describeErr(e) {
  const s = (e && e.message) ? e.message : String(e);
  return s.replace(/^Error invoking remote method '[^']+':\s*/, '');
}

/* ---------------- REPL（本机 / root 命令台） ---------------- */
function attachRepl(tab) {
  const term = tab.term;
  const sid = tab.sessionId;
  const st = { buf: '', hist: [], hi: -1, busy: false, lastNl: true };

  function prompt(txt) {
    if (!st.lastNl) term.write('\r\n');
    term.write('\x1b[32m' + txt + '\x1b[0m');
    st.lastNl = false;
  }
  function redraw() {
    term.write('\r\x1b[K\x1b[32m' + tab.promptText + '\x1b[0m' + st.buf);
  }

  tab.repl = st;
  tab.onShow = function () { try { term.focus(); } catch (e) {} };

  function handleInput(d) {
    if (st.busy) { if (d === '\x03') term.write('^C'); return; }
    for (let i = 0; i < d.length; i++) {
      const ch = d[i];
      if (ch === '\r' || ch === '\n') { submit(); continue; }
      if (ch === '\x7f' || ch === '\b') { if (st.buf.length) { st.buf = st.buf.slice(0, -1); redraw(); } continue; }
      if (ch === '\x03') { term.write('^C\r\n'); st.buf = ''; term.write('\x1b[32m' + tab.promptText + '\x1b[0m'); continue; }
      if (ch === '\x0c') { term.clear(); term.write('\x1b[32m' + tab.promptText + '\x1b[0m' + st.buf); continue; }
      if (ch === '\x1b') {
        const seq = d.slice(i, i + 3);
        if (seq === '\x1b[A') { if (st.hi < st.hist.length - 1) { st.hi++; st.buf = st.hist[st.hist.length - 1 - st.hi] || ''; redraw(); } i += 2; continue; }
        if (seq === '\x1b[B') { if (st.hi > 0) { st.hi--; st.buf = st.hist[st.hist.length - 1 - st.hi] || ''; } else { st.hi = -1; st.buf = ''; } redraw(); i += 2; continue; }
        continue;
      }
      if (ch.charCodeAt(0) < 32) continue;
      st.buf += ch;
      term.write(ch);
      st.lastNl = false;
    }
  }
  term.onData(handleInput);
  tab.sendInput = handleInput;

  async function submit() {
    const cmd = st.buf;
    st.buf = '';
    term.write('\r\n');
    if (cmd.trim()) { st.hist.push(cmd); st.hi = -1; }
    st.busy = true;
    try { await rcApi.sessionRun(sid, cmd); } catch (e) { term.write('\x1b[31m' + describeErr(e) + '\x1b[0m\r\n'); }
    st.busy = false;
  }

  tab.setPrompt = function (txt) { tab.promptText = txt; };
  tab.promptText = '$ ';
  tab.writeOut = function (data) {
    term.write(data);
    st.lastNl = /[\r\n]$/.test(data);
  };
  tab.showPrompt = function (txt) { tab.promptText = txt; prompt(txt); };
}

/* ---------------- 事件接线 ---------------- */
rcApi.onSessionData(function (p) {
  const tab = sessionMap[p.id];
  if (!tab || !tab.term) return;
  if (!tab.ready) {                       // 第一条数据来了 = 真的连上了
    tab.ready = true;
    if (tab.readyTimer) clearTimeout(tab.readyTimer);
    tab.term.write('\r\x1b[2K');
    try { tab.term.focus(); } catch (e) {}
  }
  if (tab.repl && tab.repl.busy === undefined) { tab.term.write(p.data); return; }
  if (tab.writeOut) tab.writeOut(p.data);
  else tab.term.write(p.data);
});
rcApi.onSessionPrompt(function (p) {
  const tab = sessionMap[p.id];
  if (!tab) return;
  if (tab.repl) tab.repl.__promptShown = false;
  if (tab.showPrompt) tab.showPrompt(p.text);
  else if (tab.term) tab.term.write(p.text);
});
rcApi.onSessionClear(function (p) {
  const tab = sessionMap[p.id];
  if (tab && tab.term) { tab.term.clear(); }
});
rcApi.onHealthProgress(function (p) {
  if (!p || !state.healthRunning) return;
  state.healthPartial = p.steps || state.healthPartial;
  renderHealthProgress(p);
  refreshAllPanels();
});

rcApi.onSessionExit(function (p) {
  const tab = sessionMap[p.id];
  if (tab && tab.term) {
    tab.term.write('\r\n\x1b[90m[会话已结束，退出码 ' + p.code + ']\x1b[0m\r\n');
    if (tab.repl) tab.repl.busy = true;
  }
});

/* ---------------- 侧栏 ---------------- */
function buildSidebar() {
  const dl = $('device-list');
  dl.innerHTML = '';
  (state.cfg.targets || []).forEach(function (t) {
    const card = el('div', 'dev-card');
    const row = el('div', 'row');
    const dot = el('span', 'dot');
    dot.id = 'dot-' + t.id;
    if (t.color) { dot.dataset.color = t.color; dot.style.background = t.color; }
    row.appendChild(dot);
    row.appendChild(el('span', 'name', t.name));
    card.appendChild(row);
    if (t.note) card.appendChild(el('div', 'note', t.note));
    const acts = el('div', 'acts');
    const add = function (label, fn, cls) {
      const b = el('button', 'btn small' + (cls ? ' ' + cls : ''), label);
      b.onclick = fn;
      acts.appendChild(b);
    };
    // 设备卡只放两个入口：终端 + 面板（各设备的具体功能都收进面板里，避免一屏全是按钮）
    if (t.id === 'u30') {
      add('⌨ 终端', function () { openTerminal('u30', 'adb', 'U30 shell'); });
      add('▤ 文件', function () { openPanel('files', '文件管理', 'u30'); });
      add('▣ 面板', function () { openPanel('u30', 'U30 Air 面板'); });
    } else if (t.id === 'c3') {
      add('⌨ 终端', function () { openTerminal('c3', 'ssh', 'C3 SSH'); });
      add('▤ 文件', function () { openPanel('files', '文件管理', 'c3'); });
      add('▣ 面板', function () { openPanel('c3', 'C3 面板'); });
    } else if (t.id === 'car') {
      add('⌨ 终端', function () { openTerminal('car', 'adb', '车机 ADB'); });
      add('▤ 文件', function () { openPanel('files', '文件管理', 'car'); });
      add('▣ 面板', function () { openPanel('car', '车机面板'); });
    } else {
      add('⌨ 终端', function () { openTerminal(t.id, 'local', '本机'); });
    }
    card.appendChild(acts);
    dl.appendChild(card);
  });

  const tl = $('tool-list');
  tl.innerHTML = '';
  const tool = function (label, fn) {
    const e = el('div', 'tool-item', label);
    e.onclick = fn;
    tl.appendChild(e);
  };
  const group = function (title) { tl.appendChild(el('div', 'side-sub', title)); };  group('文件与脚本');
  tool('文件管理', function () { openPanel('files', '文件管理'); });
  tool('命令库', function () { openPanel('commands', '命令库'); });
  tool('脚本库（.sh）', function () { openPanel('scripts', '脚本库'); });
  group('网络与设备');  tool('ADB 设备', function () { openPanel('adb', 'ADB 设备'); });
  group('诊断与设置');
  tool('巡检报告', function () { openPanel('health', '巡检报告'); });
  tool('运行日志', function () { openPanel('logs', '运行日志'); });  tool('关于与更新日志', function () { openPanel('about', '关于'); });
}

function renderDot(id) {
  const d = $('dot-' + id);
  if (!d) return;
  const status = (state.dotStatus || {})[id];
  const v = { ok: '--accent', fail: '--danger', warn: '--warn' }[status];
  if (v) {
    const c = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    d.setAttribute('data-st', status);
    d.style.background = c;
    d.style.boxShadow = status === 'ok' ? '0 0 6px ' + c : 'none';
  } else {
    d.removeAttribute('data-st');
    d.style.background = d.dataset.color || '';
    d.style.boxShadow = 'none';
  }
}

function setDot(id, status) {
  state.dotStatus = state.dotStatus || {};
  state.dotStatus[id] = status;
  renderDot(id);
}

/* ---------------- 巡检 ---------------- */
function refreshAllPanels() {
  state.tabs.forEach(function (t) {
    if (t.el && typeof t.el.refresh === 'function') { try { t.el.refresh(); } catch (e) {} }
  });
}

function renderHealthProgress(p) {
  const box = $('status');
  const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
  box.innerHTML = '';
  const pill = el('span', 'pill prog');
  const bar = el('span', 'bar');
  const fill = el('i');
  fill.style.width = pct + '%';
  bar.appendChild(fill);
  pill.appendChild(bar);
  pill.appendChild(el('span', null, '巡检中 ' + p.done + '/' + p.total + (p.name ? ' · ' + p.name : '')));
  box.appendChild(pill);
}

function setBusy(text) {
  const b = $('busy');
  if (!b) return;
  b.textContent = text || '';
  b.style.display = text ? 'inline-flex' : 'none';
}
function clearBusy() { setBusy(''); }

async function runHealth() {
  const box = $('status');
  state.healthRunning = true;
  state.healthPartial = [];
  box.innerHTML = '<span class="pill"><span class="dot"></span>正在巡检…</span>';
  refreshAllPanels();
  let r;
  try { r = await rcApi.healthRun(); }
  catch (e) { state.healthRunning = false; box.innerHTML = ''; box.appendChild(el('span', 'pill fail', '巡检失败：' + describeErr(e))); return; }
  state.health = r;
  state.healthPartial = r.steps;
  state.healthRunning = false;
  box.innerHTML = '';
  // 顶部只放"真正要看"的几个，其余收进 +N（不然 8 个徽章放不下会被裁掉）
  const SHORT = [
    { key: 'EasyTier', label: '隧道' },
    { key: 'U30 Air 后台', label: 'U30 后台' },
    { key: 'U30 Air ADB', label: 'U30 ADB' },
    { key: 'C3 SSH', label: 'C3' },
    { key: '车机 ADB', label: '车机' }
  ];
  const picked = [];
  SHORT.forEach(function (m) {
    const s = r.steps.find(function (x) { return x.name.indexOf(m.key) === 0; });
    if (s) picked.push({ s: s, label: m.label });
  });
  picked.forEach(function (p) {
    const s = p.s;
    const node = el('span', 'pill ' + s.status);
    node.appendChild(el('span', 'dot'));
    node.appendChild(el('span', null, p.label));
    if (s.detail) node.appendChild(el('small', null, ' ' + String(s.detail).slice(0, 24)));
    node.title = s.name + '：' + (s.detail || s.status) + '（点击看完整巡检报告）';
    node.style.cursor = 'pointer';
    node.onclick = function () { openPanel('health', '巡检报告'); };
    box.appendChild(node);
  });
  const others = r.steps.filter(function (s) { return !picked.some(function (p) { return p.s === s; }); });
  if (others.length) {
    const o = el('span', 'pill');
    o.appendChild(el('span', 'dot'));
    o.appendChild(el('span', null, '+' + others.length));
    o.title = others.map(function (s) { return s.name + '：' + (s.detail || s.status); }).join('\n') + '\n（点击看完整巡检报告）';
    o.style.cursor = 'pointer';
    o.onclick = function () { openPanel('health', '巡检报告'); };
    box.appendChild(o);
  }
  ['c3', 'car'].forEach(function (id) {
    const name = { c3: 'C3 SSH', car: '车机 ADB' }[id];
    const s = r.steps.find(function (x) { return x.name.indexOf(name) === 0; });
    if (s) setDot(id, s.status);
  });
  const u = r.steps.find(function (x) { return x.name.indexOf('U30 Air 后台') === 0; });
  const ua = r.steps.find(function (x) { return x.name.indexOf('U30 Air ADB') === 0; });
  setDot('u30', (u && u.status === 'ok') ? 'ok' : (ua && ua.status === 'ok' ? 'warn' : 'fail'));
  const t = r.steps.find(function (x) { return x.name.indexOf('EasyTier') === 0; });
  if (t) setDot('local', t.status);
  refreshAllPanels();
}

/* ---------------- 弹窗 / 提示 ---------------- */
function toast(msg, kind) {
  const d = el('div', 'modal-mask');
  const m = el('div', 'modal');
  m.style.width = '430px';
  m.appendChild(el('h3', null, kind === 'fail' ? '出错了' : '提示'));
  m.appendChild(el('div', null, msg));
  const row = el('div', 'row-flex');
  row.style.marginTop = '14px';
  row.style.justifyContent = 'flex-end';
  const ok = el('button', 'btn primary', '知道了');
  ok.onclick = function () { d.remove(); };
  row.appendChild(ok);
  m.appendChild(row);
  d.appendChild(m);
  $('modal-root').appendChild(d);
}

function modal(title, buildBody, onOk, okLabel) {
  const mask = el('div', 'modal-mask');
  const m = el('div', 'modal');
  m.appendChild(el('h3', null, title));
  const body = el('div');
  m.appendChild(body);
  buildBody(body);
  const row = el('div', 'row-flex');
  row.style.marginTop = '14px';
  row.style.justifyContent = 'flex-end';
  const cancel = el('button', 'btn', '取消');
  cancel.onclick = function () { mask.remove(); };
  const ok = el('button', 'btn primary', okLabel || '保存');
  ok.onclick = async function () {
    try { await onOk(); mask.remove(); } catch (e) { toast(describeErr(e), 'fail'); }
  };
  row.appendChild(cancel);
  row.appendChild(ok);
  m.appendChild(row);
  mask.appendChild(m);
  $('modal-root').appendChild(mask);
  return mask;
}

/* ---------------- 启动 ---------------- */
function wireTop() {
  (function(){var _e=$('btn-overview'); if(_e) _e.onclick = function () { openPanel('overview', '总览'); };})();
(function(){var _e=$('btn-health'); if(_e) _e.onclick = runHealth;})();
  const bt = $('btn-tunnel');
  if (bt) bt.onclick = function () { openPanel('easytier', 'EasyTier 隧道'); };
  const bth = $('btn-theme');
  if (bth) bth.onclick = function (ev) {
    const r = bth.getBoundingClientRect();
    showThemeMenu(r.right - 170, r.bottom + 6);
  };
  (function(){var _e=$('btn-settings'); if(_e) _e.onclick = function () { openPanel('settings', '设置'); };})();
}

async function init() {
  try {
    state.info = await rcApi.appInfo();
    const v = $('ver');
    if (v) v.textContent = 'v' + state.info.version;
  } catch (e) { /* 忽略 */ }
  state.cfg = await rcApi.cfgGet();
  applyTheme(state.cfg.theme || 'dark', false);
  $('guard-mode').textContent = state.cfg.guard === 'strict' ? '严格（硬禁用）' : '宽松（需确认）';
  buildSidebar();
  wireTop();
  openPanel('overview', '总览');
  runHealth();
}

window.APP = {
  state: state, el: el, $: $, openTerminal: openTerminal, openPanel: openPanel,
  runHealth: runHealth, refreshAllPanels: refreshAllPanels, toast: toast, modal: modal, describeErr: describeErr,
  setBusy: setBusy, clearBusy: clearBusy, applyTheme: applyTheme, themeList: THEME_LIST, setDot: setDot,
  addTab: addTab, activate: activate, setDot: setDot
};

if (window.__initPanels) window.__initPanels();

init().catch(function (e) {
  const msg = (e && e.stack) ? e.stack : String(e);
  console.error('初始化失败: ' + msg);
  const b = document.getElementById('device-list');
  if (b) {
    const d = document.createElement('div');
    d.style.cssText = 'color:var(--danger);padding:10px;font-size:12px;white-space:pre-wrap';
    d.textContent = '初始化失败：\n' + msg;
    b.appendChild(d);
  }
});
window.addEventListener('error', function (ev) { console.error('未捕获错误: ' + ev.message + ' @' + ev.filename + ':' + ev.lineno); });
window.addEventListener('unhandledrejection', function (ev) { console.error('未处理的 Promise: ' + ((ev.reason && ev.reason.stack) || ev.reason)); });
