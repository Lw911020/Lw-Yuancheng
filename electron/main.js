'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

const defaultConfig = require('./config');
const { Store } = require('./store');
const { SessionManager } = require('./sessions');
const guard = require('./guard');
const adb = require('./channels/adb');
const files = require('./channels/files');
const easytier = require('./channels/easytier');
const c3touch = require('./channels/c3touch');
const c3cast = require('./channels/c3cast');
const c3params = require('./channels/c3params');
const LOG = require('./log');
const dataBundle = require('./dataBundle');
const carcast = require('./channels/carcast');
const ssh = require('./channels/ssh');
const ufi = require('./channels/ufi');

let win = null;
let store = null;
let sessions = null;

function cfg() { return store.config; }

// 内置 EasyTier 内核的位置（打包后在 exe 同级的 easytier 目录）
function themeBg(name) {
  return { dark: '#0e1520', light: '#f2f5f9', blue: '#0a1424', purple: '#130f20', forest: '#0b1512', rose: '#1a1016', solar: '#00252e' }[name] || '#0e1520';
}

function etPath(name) {
  const base = app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), 'easytier')
    : path.join(__dirname, '..', 'vendor', 'easytier');
  return path.join(base, name);
}

// 老配置里指向外部 EasyTier 的路径如果失效，自动切到自带内核
// 把内核从"程序目录"复制到用户数据目录再运行：
// 这样内核不会锁住程序目录，以后升级/删旧版本都不会被占用
function installEasyTierRuntime() {
  const dir = path.join(app.getPath('userData'), 'easytier');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return null; }
  for (const f of ['easytier-core.exe', 'easytier-cli.exe', 'wintun.dll', 'Packet.dll']) {
    const s = etPath(f);
    const d = path.join(dir, f);
    if (!fs.existsSync(s)) continue;
    let need = true;
    try { need = fs.statSync(s).size !== fs.statSync(d).size; } catch (e) { need = true; }
    if (need) { try { fs.copyFileSync(s, d); } catch (e) { /* 内核正在跑时复制失败也无妨 */ } }
  }
  return dir;
}

// 随包分发的 adb 与 C3 私钥：换电脑免配置
function migrateBundledPaths() {
  const base = app.isPackaged ? path.dirname(app.getPath('exe')) : path.join(__dirname, '..');
  let changed = false;
  const adb = path.join(base, 'adb', 'adb.exe');
  if (fs.existsSync(adb) && store.config.adbPath !== adb) { store.config.adbPath = adb; changed = true; LOG.info('main', '使用随包 adb: ' + adb); }
  const key = path.join(base, 'c3-keys', 'c3_id_ed25519');
  if (fs.existsSync(key)) {
    (store.config.targets || []).forEach(function (t) {
      if (t.ssh && t.ssh.keyPath !== key) { t.ssh.keyPath = key; changed = true; LOG.info('main', '使用随包私钥: ' + key); }
    });
  }
  if (changed) store.saveConfig();
}
function migrateEasyTierPaths() {
  const et = store.config.easytier || (store.config.easytier = {});
  // 只要当前路径不在本程序自己的目录里，就切到自带内核（覆盖旧版外部路径、开发目录等）
  const runtime = installEasyTierRuntime();
  const appBase = app.isPackaged ? path.dirname(app.getPath('exe')) : path.join(__dirname, '..');
  let changed = false;
  const fix = function (key, file) {
    const p = runtime ? path.join(runtime, file) : etPath(file);
    if (!fs.existsSync(p)) return;
    const cur = et[key];
    const inside = cur && String(cur) === p;
    if (!cur || !fs.existsSync(cur) || !inside) { et[key] = p; changed = true; }
  };
  fix('coreExe', 'easytier-core.exe');
  fix('cliExe', 'easytier-cli.exe');
  if (changed) store.saveConfig();
  return changed;
}
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 940, minWidth: 1080, minHeight: 660,
    backgroundColor: themeBg((store.config && store.config.theme) || 'dark'),
    title: '远程控制台',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  win.webContents.on('console-message', function () {
    const a = Array.prototype.slice.call(arguments);
    const d = a[0] && a[0].details ? a[0].details : null;
    if (d) console.log('[renderer:' + d.level + '] ' + d.message + '  @' + (d.sourceId || '') + ':' + (d.lineNumber || 0));
    else console.log('[renderer] ' + a.slice(1).join(' | '));
  });
  win.webContents.on('did-fail-load', function (e, code, desc, url) { console.log('[did-fail-load] ' + code + ' ' + desc + ' ' + url); });
  win.webContents.on('render-process-gone', function (e, d) { console.log('[render-process-gone] ' + JSON.stringify(d)); });
  win.webContents.on('preload-error', function (e, p, err) { console.log('[preload-error] ' + p + ' :: ' + (err && err.message)); });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.env.RC_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
  win.on('closed', () => { win = null; });
  // 自愈：渲染进程崩了/卡死/加载失败就自动重载，免得留一个白屏窗口卡着单实例锁
  win.webContents.on('render-process-gone', () => { try { setTimeout(() => { try { win.reload(); } catch (e) {} }, 800); } catch (e) {} });
  win.webContents.on('unresponsive', () => { try { win.reload(); } catch (e) {} });
  win.webContents.on('did-fail-load', (e, code, desc) => { if (code !== -3) { try { win.reload(); } catch (e2) {} } });
}

// 只允许开一个实例：再开一个就聚焦已有窗口（否则会出现两个窗口，第二个还可能空白）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      try { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } catch (e) {}
    } else {
      createWindow();
    }
  });

// ---- 日志：先接住所有未捕获异常，程序里的"那个错误弹窗"内容也会落到日志文件 ----
process.on('uncaughtException', (e) => { LOG.error('main', '未捕获异常（主进程）', e); });
process.on('unhandledRejection', (e) => { LOG.error('main', '未处理的 Promise 拒绝', e); });

app.whenReady().then(() => {
  LOG.init(app);
  LOG.info('main', '程序启动 v' + app.getVersion() + ' | 数据目录 ' + app.getPath('userData'));
  store = new Store(app.getPath('userData'));
  store.init(defaultConfig(app));
  migrateEasyTierPaths();
  migrateBundledPaths();
  sessions = new SessionManager(cfg, send);
  createWindow();
  Menu.setApplicationMenu(null);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  setTimeout(bootstrapTunnel, 2500);
});

/* ---------- EasyTier 隧道：开机自启 + 常驻守护 ---------- */
let etTimer = null;
let etFail = 0;

async function bootstrapTunnel() {
  const et = cfg().easytier || {};
  try {
    const st = await easytier.status(cfg());
    send('et:status', st);
    if (!st.running && et.autoStart) {
      send('et:alert', { level: 'warn', text: '隧道的没在运行，正在自动拉起 EasyTier…' });
      const r = await easytier.start(cfg());
      send('et:alert', { level: r.ok ? 'ok' : 'fail', text: r.message });
    }
  } catch (e) { send('et:alert', { level: 'fail', text: '隧道检查失败：' + e.message }); }
  startGuardian();
  try { await ensureAdbTargets(); } catch (e) { /* 忽略 */ }
}

function startGuardian() {
  if (etTimer) { clearInterval(etTimer); etTimer = null; }
  const et = cfg().easytier || {};
  if (!et.guardian) return;
  const ms = Math.max(10, Number(et.guardianIntervalSec) || 20) * 1000;
  etTimer = setInterval(async () => {
    try {
      const st = await easytier.status(cfg());
      send('et:status', st);
      if (st.tunnelOk) { etFail = 0; return; }
      etFail++;
      if (etFail === 2) send('et:alert', { level: 'warn', text: '隧道探测失败（' + st.probeIp + ' 不通）第 ' + etFail + ' 次' });
      if (etFail >= 3) {
        if ((cfg().easytier || {}).autoRestart) {
          send('et:alert', { level: 'warn', text: '连续 3 次探测失败，尝试自动重连…' });
          const r = await easytier.restart(cfg());
          send('et:alert', { level: r.ok ? 'ok' : 'fail', text: r.message });
        } else if (etFail === 3) {
          send('et:alert', { level: 'fail', text: '隧道已连续 3 次探测失败。可在 EasyTier 面板点「启动隧道」或「重启隧道」' });
        }
      }
    } catch (e) { /* 忽略单次异常 */ }
  }, ms);
}

}   // end single-instance

app.on('window-all-closed', () => {
  if (sessions) sessions.closeAll();
  if (process.platform !== 'darwin') app.quit();
});

function once(file, args, timeoutMs, stdinText) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(file, args, { windowsHide: true }); }
    catch (e) { resolve({ code: -1, stdout: '', stderr: e.message }); return; }
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill(); } catch (e) {} resolve({ code: -2, stdout: out, stderr: err + '\n[超时]' }); }, timeoutMs || 20000);
    p.stdout.on('data', (d) => { out += d.toString('utf8'); });
    p.stderr.on('data', (d) => { err += d.toString('utf8'); });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stdout: out, stderr: e.message }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code: code == null ? 0 : code, stdout: out, stderr: err }); });
    if (stdinText != null) { try { p.stdin.write(stdinText); p.stdin.end(); } catch (e) { /* 忽略 */ } }
  });
}

function pingOnce(ip, ms) {
  return once('ping', ['-n', '1', '-w', String(ms || 2500), ip], (ms || 2500) + 3000).then((r) => {
    const ok = r.code === 0 && /(TTL=|ttl=)/.test(r.stdout);
    const m = r.stdout.match(/[=<](\d+)ms/i);
    return { ok: ok, ms: m ? Number(m[1]) : null, raw: (r.stdout || r.stderr).slice(0, 300) };
  });
}

// ADB 状态判定：device=ok；unauthorized/端口不通=warn；不在网=fail
function adbStatusLevel(r) {
  if (!r) return 'fail';
  if (r.state === 'device') return 'ok';
  if (r.state === 'offline') return 'fail';
  return 'warn';
}

// 先查列表；不在或 offline 就自动 adb connect 一次，再查
async function ensureAdb(adbPath, addr) {
  if (!addr) return { state: 'none', note: '未配置 ADB 地址' };
  let dv = await adb.devices(adbPath);
  let d = dv.find((x) => x.addr === addr);
  if (!d || d.state === 'offline') {
    try { await adb.connect(adbPath, addr); } catch (e) { /* 忽略 */ }
    await new Promise((r) => setTimeout(r, 1500));
    dv = await adb.devices(adbPath);
    d = dv.find((x) => x.addr === addr);
  }
  const ip = String(addr).split(':')[0];
  if (d && d.state === 'device') return { state: 'device', device: d };
  const pg = await pingOnce(ip, 2500);
  const lat = pg.ms == null ? '' : '(' + pg.ms + 'ms)';
  if (d && d.state === 'unauthorized') {
    return { state: 'unauthorized', device: d, ping: pg, note: pg.ok ? ('在网' + lat + '，但 ADB 未授权 —— 装手机密钥即可') : 'ADB 未授权' };
  }
  if (pg.ok) return { state: 'no-port', device: d, ping: pg, note: '设备在网' + lat + '，但 5555 连不上（ADB 关了？）' };
  return { state: 'offline', device: d, ping: pg, note: '不在网 —— 设备关机 / 不在这个 WiFi / IP 变了' };
}

// 打开程序时把所有配了 ADB 的设备接一遍
async function ensureAdbTargets() {
  const c = cfg();
  const out = [];
  for (const t of (c.targets || [])) {
    if (!t.adb || !t.adb.addr) continue;
    try {
      const r = await ensureAdb(c.adbPath, t.adb.addr);
      out.push({ id: t.id, addr: t.adb.addr, state: r.state, note: r.note || '' });
    } catch (e) { out.push({ id: t.id, addr: t.adb.addr, state: 'error', note: e.message }); }
  }
  if (out.length) send('adb:auto', out);
  return out;
}

async function healthCheck() {
  const c = cfg();
  const t = (id) => (c.targets || []).find((x) => x.id === id) || {};
  const steps = [];
  const TOTAL = 8;
  const startedAt = Date.now();
  let mark = startedAt;
  send('health:progress', { done: 0, total: TOTAL, name: '开始巡检', steps: [] });
  const push = (name, status, detail) => {
    const now = Date.now();
    steps.push({ name: name, status: status, detail: detail, ms: now - mark });
    mark = now;
    send('health:progress', { done: steps.length, total: TOTAL, name: name, status: status, detail: detail, steps: steps.slice() });
  };

  // 1. 本机 adb
  const adbv = await once(c.adbPath, ['version'], 10000);
  push('本机 adb 可用', adbv.code === 0 ? 'ok' : 'fail', (adbv.stdout || adbv.stderr).trim().split('\n')[0]);

  // 2. 隧道
  const p1 = await pingOnce(c.easytier.probeIp, 2500);
  push('EasyTier 隧道 (' + c.easytier.probeIp + ')', p1.ok ? 'ok' : 'fail', p1.ok ? (p1.ms + ' ms') : '不通 —— 检查 EasyTier 是否在运行');

  // 3. 局域网
  const p2 = await pingOnce((t('c3').ssh || {}).host || '192.168.0.66', 3000);
  push('局域网 192.168.0.0/24', p2.ok ? 'ok' : 'fail', p2.ok ? (p2.ms + ' ms') : 'C3 不可达');

  // 4. U30 后台
  try {
    const r = await ufi.request(t('u30'), { path: '/api/version_info', timeoutMs: 8000 });
    push('U30 Air 后台 (:2333)', 'ok', 'UFI-TOOLS ' + ((r.json && r.json.app_ver) || '?'));
  } catch (e) { push('U30 Air 后台 (:2333)', 'fail', e.message); }

  // 5. U30 ADB（先自动重连，再判断状态）
  const addrU = t('u30').adb ? t('u30').adb.addr : '';
  const u = await ensureAdb(c.adbPath, addrU);
  push('U30 Air ADB (' + addrU + ')', adbStatusLevel(u), u.state === 'device' ? 'device' : (u.note || u.state));

  // 6. C3 SSH
  const c3 = await ssh.test(t('c3'), 10000);
  push('C3 SSH (comma@' + (t('c3').ssh || {}).host + ')', c3.ok ? 'ok' : 'fail', c3.message);

  // 7. 车机 ADB（同样先自动重连）
  const addrC = t('car').adb ? t('car').adb.addr : '';
  const car = await ensureAdb(c.adbPath, addrC);
  push('车机 ADB (' + addrC + ')', adbStatusLevel(car), car.state === 'device' ? 'device' : (car.note || car.state));

  // 8. 红线守卫
  push('红线守卫', cfg().guard === 'strict' ? 'ok' : 'warn',
    cfg().guard === 'strict' ? '严格模式：恢复出厂/OTA 已硬禁用' : '宽松模式：危险操作需手输确认');

  return { steps: steps, at: Date.now(), elapsed: Date.now() - startedAt };
}

// ---------- 一次性命令执行（统一入口） ----------
async function execOnce(targetId, channel, cmd) {
  const c = cfg();
  const target = (c.targets || []).find((x) => x.id === targetId);
  if (!target) throw new Error('未知设备');
  const g = guard.scan(cmd, { guard: c.guard });
  if (g.action === 'blocked') throw new Error('【红线拦截】' + g.label + '：' + g.reason);

  if (channel === 'ssh') return await ssh.exec(target, cmd, 60000);
  if (channel === 'adb') {
    const addr = (target.adb || {}).addr;
    return await adb.shellOnce(c.adbPath, addr, cmd, 60000);
  }
  if (channel === 'root') {
    const r = await ufi.rootShell(target, cmd, 90000);
    return { code: r.done ? 0 : 1, stdout: r.content, stderr: r.done ? '' : '命令未正常结束或超时' };
  }
  if (channel === 'ufi' || channel === 'ufi-user') {
    const r = await ufi.userShell(target, cmd, 60000);
    return { code: r.done ? 0 : 1, stdout: r.content, stderr: '' };
  }
  if (channel === 'local') {
    const r = await once('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], 60000);
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  }
  throw new Error('未知通道：' + channel);
}

// ---------- 脚本执行（.sh） ----------
async function runScriptOn(targetId, channel, content, name) {
  const c = cfg();
  const target = (c.targets || []).find((x) => x.id === targetId);
  if (!target) throw new Error('未知设备');
  const g = guard.scan(content, { guard: c.guard });
  if (g.action === 'blocked') throw new Error('【红线拦截】脚本命中「' + g.label + '」：' + g.reason);

  const b64 = Buffer.from(content, 'utf8').toString('base64');
  // 文件名带上脚本名，方便在设备上复查：/data/rc_scripts/名字_时间戳.sh
  const safe = String(name || 'script').replace(/[^\w\u4e00-\u9fa5.\-]+/g, '_').slice(0, 40) || 'script';
  const stamp = safe + '_' + Date.now().toString(36) + '.sh';

  if (channel === 'ssh') {
    // 放 /data 下（tmpfs 的 /tmp 重启就没了，且 /data 可持久复查）；
    // 用 cd /data && sh 脚本 运行 —— 很多 openpilot 脚本依赖 cwd=/data 或相对路径
    const dir = '/data/rc_scripts';
    const remote = dir + '/' + stamp;
    const r1 = await ssh.exec(target,
      'mkdir -p ' + dir + ' && printf %s ' + JSON.stringify(b64) + ' | base64 -d > ' + remote + ' && chmod +x ' + remote, 40000);
    if (r1.code !== 0) throw new Error('上传脚本失败：' + (r1.stderr || r1.stdout));
    const r2 = await ssh.exec(target, 'cd /data && sh ' + remote, 300000);
    // 只留最近 20 个，别把 /data 塞满
    try {
      await ssh.exec(target, 'ls -t ' + dir + '/*.sh 2>/dev/null | tail -n +21 | xargs -r rm -f', 20000);
    } catch (e) { /* 清理失败不影响脚本结果 */ }
    return Object.assign(r2, { remote: remote, cwd: '/data' });
  }
  if (channel === 'root') {
    const cmd = 'printf %s ' + JSON.stringify(b64) + ' | base64 -d > /data/local/tmp/' + stamp + ' && chmod 755 /data/local/tmp/' + stamp + ' && sh /data/local/tmp/' + stamp;
    const r = await ufi.rootShell(target, cmd, 100000);
    return { code: r.done ? 0 : 1, stdout: r.content, stderr: r.done ? '' : '超时或未正常结束' };
  }
  if (channel === 'adb') {
    const addr = (target.adb || {}).addr;
    const cmd = 'printf %s ' + JSON.stringify(b64) + ' | base64 -d > /data/local/tmp/' + stamp + ' && chmod 755 /data/local/tmp/' + stamp + ' && sh /data/local/tmp/' + stamp;
    return await adb.shellOnce(c.adbPath, addr, cmd, 300000);
  }
  if (channel === 'local') {
    const tmp = path.join(app.getPath('temp'), stamp);
    fs.writeFileSync(tmp, content, 'utf8');
    const r = await once('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], 300000);
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  }
  throw new Error('脚本不支持该通道：' + channel);
}

// ---------- IPC ----------
function ipc() {
  ipcMain.handle('cfg:get', () => {
    const c = JSON.parse(JSON.stringify(cfg()));
    delete c.scriptsDir;
    return c;
  });
  ipcMain.handle('cfg:set', (e, patch) => {
    store.config = Object.assign({}, store.config, patch || {});
    store.saveConfig();
    return cfg();
  });
  ipcMain.handle('cfg:setTarget', (e, { id, patch }) => {
    const list = store.config.targets || [];
    const i = list.findIndex((t) => t.id === id);
    if (i >= 0) list[i] = Object.assign({}, list[i], patch || {});
    store.saveConfig();
    return list;
  });

  ipcMain.handle('session:open', (e, opts) => sessions.open(opts || {}));
  ipcMain.handle('session:write', (e, { id, data }) => { sessions.write(id, data); return true; });
  ipcMain.handle('session:run', async (e, { id, cmd }) => { await sessions.run(id, cmd); return true; });
  ipcMain.handle('session:resize', (e, { id, cols, rows }) => { sessions.resize(id, cols, rows); return true; });
  ipcMain.handle('session:close', (e, { id }) => { sessions.close(id); return true; });
  ipcMain.handle('session:list', () => sessions.list());

  ipcMain.handle('exec:once', async (e, { targetId, channel, cmd }) => execOnce(targetId, channel, cmd));

  ipcMain.handle('adb:devices', () => adb.devices(cfg().adbPath));
  ipcMain.handle('adb:ensureAll', () => ensureAdbTargets());
  ipcMain.handle('adb:ensure', async (e, { addr }) => {
    const r = await ensureAdb(cfg().adbPath, addr);
    return { state: r.state, note: r.note || r.state };
  });
  ipcMain.handle('adb:connect', (e, { addr }) => adb.connect(cfg().adbPath, addr));
  ipcMain.handle('adb:disconnect', (e, { addr }) => adb.disconnect(cfg().adbPath, addr));

  ipcMain.handle('ufi:api', async (e, { targetId, method, path: p, query, body, base }) => {
    const target = (cfg().targets || []).find((t) => t.id === targetId);
    const r = await ufi.request(target, { method: method, path: p, query: query, body: body, base: base });
    return { status: r.status, json: r.json, text: r.text };
  });

  ipcMain.handle('health:run', () => healthCheck());
  ipcMain.handle('guard:scan', (e, { cmd }) => guard.scan(cmd, { guard: cfg().guard }));

  ipcMain.handle('cmdlib:list', () => store.commands.items || []);
  ipcMain.handle('cmdlib:save', (e, rec) => {
    const items = store.commands.items || (store.commands.items = []);
    const i = items.findIndex((x) => x.id === rec.id);
    if (i >= 0) items[i] = Object.assign({}, items[i], rec);
    else { rec.id = rec.id || ('c' + Date.now().toString(36)); items.push(rec); }
    store.saveCommands();
    return items;
  });
  ipcMain.handle('cmdlib:delete', (e, { id }) => {
    const items = store.commands.items || [];
    store.commands.items = items.filter((x) => x.id !== id);
    store.saveCommands();
    return store.commands.items;
  });

  ipcMain.handle('script:list', () => store.listScripts());
  ipcMain.handle('script:read', (e, { id }) => store.readScript(id));
  ipcMain.handle('script:save', (e, { meta, content }) => store.saveScript(meta, content));
  ipcMain.handle('script:delete', (e, { id }) => { store.deleteScript(id); return store.listScripts(); });
  ipcMain.handle('script:run', async (e, { targetId, channel, content, name }) => runScriptOn(targetId, channel, content, name));
  ipcMain.handle('script:openDir', () => shell.openPath(store.scriptsDir()));
  ipcMain.handle('script:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '导入 .sh 脚本', filters: [{ name: 'Shell 脚本', extensions: ['sh', 'bash', 'txt'] }], properties: ['openFile', 'multiSelections']
    });
    if (r.canceled) return [];
    const out = [];
    for (const f of r.filePaths) {
      const content = fs.readFileSync(f, 'utf8');
      out.push(store.saveScript({ name: path.basename(f, path.extname(f)), note: '导入自 ' + f, targetId: '', channel: 'ssh' }, content));
    }
    return out;
  });
  ipcMain.handle('script:export', async (e, { content, name }) => {
    const r = await dialog.showSaveDialog(win, { title: '导出 .sh 脚本', defaultPath: (name || 'script') + '.sh', filters: [{ name: 'Shell 脚本', extensions: ['sh'] }] });
    if (r.canceled || !r.filePath) return { ok: false };
    fs.writeFileSync(r.filePath, content, 'utf8');
    return { ok: true, path: r.filePath };
  });
  ipcMain.handle('script:associate', async () => {
    // 只写 HKCU，可撤销
    const exe = process.execPath;
    const cmds = [
      ['add', 'HKCU\\Software\\Classes\\.sh', '/ve', '/d', 'RemoteConsole.sh', '/f'],
      ['add', 'HKCU\\Software\\Classes\\RemoteConsole.sh', '/ve', '/d', 'Shell Script', '/f'],
      ['add', 'HKCU\\Software\\Classes\\RemoteConsole.sh\\shell\\open\\command', '/ve', '/d', '"' + exe + '" "%1"', '/f']
    ];
    for (const args of cmds) {
      const r = await once('reg', args, 10000);
      if (r.code !== 0) return { ok: false, message: (r.stderr || r.stdout).trim() };
    }
    return { ok: true, message: '.sh 已关联到远程控制台（仅当前用户）' };
  });
  ipcMain.handle('script:unassociate', async () => {
    const r = await once('reg', ['delete', 'HKCU\\Software\\Classes\\.sh', '/f'], 10000);
    return { ok: r.code === 0, message: r.code === 0 ? '已取消关联' : (r.stderr || '').trim() };
  });

  ipcMain.handle('term:external', async (e, { targetId, kindCode }) => {
    const c = cfg();
    const t = (c.targets || []).find((x) => x.id === targetId);
    if (!t) return { ok: false, message: '未知设备' };
    let cmdline = '';
    if (kindCode === 'ssh') {
      cmdline = 'ssh -i "' + (t.ssh.keyPath || '') + '" ' + t.ssh.user + '@' + t.ssh.host;
    } else if (kindCode === 'adb') {
      cmdline = '"' + c.adbPath + '" -s ' + t.adb.addr + ' shell';
    } else if (kindCode === 'root') {
      return { ok: false, message: 'root 命令台没有独立的本地终端，请用内置标签页' };
    } else {
      cmdline = 'powershell';
    }
    await once('cmd.exe', ['/c', 'start', '""', 'wt.exe', '-d', process.env.USERPROFILE || '.', 'cmd', '/k', cmdline], 10000);
    return { ok: true, message: '已尝试打开外部终端' };
  });

  // ---------- 文件管理 ----------
  const tgt = (id) => {
    const t = (cfg().targets || []).find((x) => x.id === id);
    if (!t) throw new Error('未知设备：' + id);
    return t;
  };
  ipcMain.handle('files:list', (e, { targetId, path: p }) => files.list(tgt(targetId), cfg(), p));
  ipcMain.handle('files:read', (e, { targetId, path: p }) => files.read(tgt(targetId), cfg(), p));
  ipcMain.handle('files:write', (e, { targetId, path: p, content }) => files.write(tgt(targetId), cfg(), p, content));
  ipcMain.handle('files:mkdir', (e, { targetId, path: p }) => files.mkdir(tgt(targetId), cfg(), p));
  ipcMain.handle('files:move', (e, { targetId, from, to }) => files.move(tgt(targetId), cfg(), from, to));
  ipcMain.handle('files:remove', (e, { targetId, path: p, recursive }) => files.remove(tgt(targetId), cfg(), p, recursive));
  ipcMain.handle('files:chmod', (e, { targetId, path: p, mode }) => files.chmod(tgt(targetId), cfg(), p, mode));
  ipcMain.handle('files:download', async (e, { targetId, path: p, name }) => {
    const r = await dialog.showSaveDialog(win, { title: '下载到本机', defaultPath: name || path.basename(p) });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const res = await files.download(tgt(targetId), cfg(), p, r.filePath);
    return Object.assign(res, { local: r.filePath });
  });
  ipcMain.handle('files:upload', async (e, { targetId, dir }) => {
    const r = await dialog.showOpenDialog(win, { title: '选择要上传的文件', properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return { ok: false, canceled: true };
    const out = [];
    for (const f of r.filePaths) {
      const remote = (String(dir).replace(/\/$/, '') || '') + '/' + path.basename(f);
      await files.upload(tgt(targetId), cfg(), f, remote);
      out.push(remote);
    }
    return { ok: true, files: out };
  });
  ipcMain.handle('files:downloadDir', async (e, { targetId, path: p }) => {
    const r = await dialog.showOpenDialog(win, { title: '选择保存目录', properties: ['openDirectory'] });
    if (r.canceled) return { ok: false, canceled: true };
    const res = await files.download(tgt(targetId), cfg(), p, require('path').join(r.filePaths[0], require('path').basename(p)));
    return Object.assign(res, { local: r.filePaths[0] });
  });

  // ---------- EasyTier 隧道 ----------
  ipcMain.handle('et:status', async () => await easytier.status(cfg()));
  ipcMain.handle('et:start', async () => { const r = await easytier.start(cfg()); setTimeout(() => send('et:status', null) || 0, 0); return r; });
  ipcMain.handle('et:stop', () => easytier.stop(cfg()));
  ipcMain.handle('et:restart', () => easytier.restart(cfg()));
  ipcMain.handle('et:diagnose', async () => easytier.diagnose(cfg(), await easytier.status(cfg())));
  ipcMain.handle('et:cli', async (e, { args }) => {
    const r = await easytier.cli(cfg(), Array.isArray(args) ? args : String(args || '').split(' ').filter(Boolean));
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  });
  ipcMain.handle('et:setConfig', (e, patch) => {
    store.config.easytier = Object.assign({}, store.config.easytier, patch || {});
    store.saveConfig();
    startGuardian();
    return store.config.easytier;
  });
  ipcMain.handle('et:logs', () => easytier.logs());
  ipcMain.handle('et:openLog', async () => {
    const lp = easytier.logs();
    if (!require('fs').existsSync(lp.out)) return { ok: false, message: '还没有日志文件：' + lp.out };
    const err = await shell.openPath(lp.out);
    return { ok: !err, message: err || ('已打开 ' + lp.out) };
  });

  ipcMain.handle('et:openGui', async () => {
    const lnk = (cfg().easytier || {}).guiLnk;
    if (lnk && require('fs').existsSync(lnk)) { await once('cmd.exe', ['/c', 'start', '""', lnk], 8000); return { ok: true, message: '已打开 EasyTier GUI' }; }
    return { ok: false, message: '找不到 EasyTier GUI 快捷方式，请在设置里填对路径' };
  });

  // ---------- C3 触控 ----------
  ipcMain.handle('touch:open', async (e, { targetId }) => {
    const t = (cfg().targets || []).find((x) => x.id === targetId);
    if (!t) throw new Error('未知设备');
    if (c3touch.current()) return { ok: true, already: true };
    await c3touch.open(t, {
      onData: (d) => send('touch:log', { text: d }),
      onExit: () => send('touch:exit', {})
    });
    return { ok: true };
  });
  ipcMain.handle('touch:send', (e, { cmd }) => ({ ok: c3touch.send(cmd) }));
  ipcMain.handle('touch:close', () => { c3touch.close(); return { ok: true }; });

  // ---------- C3 投屏 ----------
  const c3t = () => {
    const t = (cfg().targets || []).find((x) => x.id === 'c3');
    if (!t) throw new Error('找不到 C3');
    return t;
  };
  ipcMain.handle('cast:status', () => c3cast.status(c3t()));
  ipcMain.handle('cast:provision', () => c3cast.provision(c3t()));
  ipcMain.handle('cast:enable', () => c3cast.enable(c3t()));
  ipcMain.handle('cast:disable', () => c3cast.disable(c3t()));
  ipcMain.handle('cast:stop', () => c3cast.stop());
  ipcMain.handle('cast:startH264', async (e, opts) => {
    // 不再先 status()+enable()：设备端脚本自己会开开关，省掉两次 SSH 往返（每次都要完整握手）
    return await c3cast.startH264(c3t(), opts || {}, {
      onChunk: (buf) => send('cast:h264', buf),
      onLog: (text) => send('cast:log', { text: text }),
      onExit: () => send('cast:exit', {})
    });
  });
  ipcMain.handle('cast:stopH264', () => c3cast.stopH264());
  ipcMain.handle('cast:start', async (e, opts) => {
    const st = await c3cast.status(c3t());
    if (!st.hookSo || !st.inMaps) throw new Error('C3 上还没装投屏钩子（点「安装钩子」）');
    if (!st.flag) await c3cast.enable(c3t());
    await c3cast.start(c3t(), Object.assign({ python: st.python }, opts || {}), {
      onFrame: (jpg, n) => send('cast:frame', { data: jpg.toString('base64'), n: n }),
      onLog: (text) => send('cast:log', { text: text }),
      onExit: () => send('cast:exit', {})
    });
    return { ok: true, status: st };
  });

  // ---------- 参数快照 ----------
  const SNAP = path.join(app.getPath('userData'), 'param-snapshots.json');
  const readSnaps = function () { try { const a = JSON.parse(fs.readFileSync(SNAP, 'utf8')); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  const writeSnaps = function (a) { try { fs.writeFileSync(SNAP, JSON.stringify(a, null, 2), 'utf8'); } catch (e) {} return a; };
  ipcMain.handle('c3:snapList', () => readSnaps());
  ipcMain.handle('c3:snapSave', (e, p) => {
    const a = readSnaps();
    const vals = p && p.values ? p.values : {};
    a.unshift({ id: 's' + Date.now(), name: (p && p.name) || ('快照 ' + new Date().toLocaleString()), at: Date.now(), values: vals, count: Object.keys(vals).length });
    if (a.length > 50) a.length = 50;
    return writeSnaps(a);
  });
  ipcMain.handle('c3:snapDelete', (e, id) => writeSnaps(readSnaps().filter((x) => x.id !== id)));
  ipcMain.handle('c3:snapRename', (e, p) => {
    const a = readSnaps();
    const r = a.find((x) => x.id === p.id);
    if (r) r.name = p.name;
    return writeSnaps(a);
  });

  // ---------- C3 参数 ----------
  ipcMain.handle('c3:params', (e, force) => c3params.dump(c3t(), !!force));
  ipcMain.handle('c3:paramSet', (e, p) => c3params.setParam(c3t(), p.key, p.value));

  // ---------- 车机投屏 ----------
  const carT = () => {
    const t = (cfg().targets || []).find((x) => x.id === 'car');
    if (!t) throw new Error('找不到车机');
    return t;
  };
  ipcMain.handle('car:castStart', async (e, opts) => {
    const t = carT();
    await adb.connect(cfg().adbPath, t.adb.addr).catch(() => {});
    return carcast.start(cfg().adbPath, t.adb.addr, opts || {}, {
      onFrame: (png, n) => send('car:frame', { data: png.toString('base64'), n: n }),
      onLog: (text) => send('car:log', { text: text }),
      onExit: () => send('car:exit', {})
    });
  });
  ipcMain.handle('car:castStop', () => carcast.stop());
  ipcMain.handle('car:launch', (e, pkg) => carcast.launch(cfg().adbPath, carT().adb.addr, pkg || 'com.byd.auto_camera'));
  ipcMain.handle('car:tap', (e, p) => carcast.tap(cfg().adbPath, carT().adb.addr, p.x, p.y));
  ipcMain.handle('car:swipe', (e, p) => carcast.swipe(cfg().adbPath, carT().adb.addr, p.x1, p.y1, p.x2, p.y2, p.ms));
  ipcMain.handle('car:key', (e, code) => carcast.key(cfg().adbPath, carT().adb.addr, code));

  // ---------- 日志 ----------
  ipcMain.handle('log:tail', (e, n) => ({ file: LOG.file(), text: LOG.tail(n || 400) }));
  ipcMain.handle('log:list', () => LOG.list());
  ipcMain.handle('log:read', (e, name) => LOG.readFile(name));
  ipcMain.handle('log:clear', () => LOG.clear());
  ipcMain.handle('log:openDir', async () => { const r = await shell.openPath(LOG.dir()); return { ok: !r, message: r || LOG.dir() }; });
  ipcMain.handle('log:write', (e, p) => { LOG.write ? null : null; LOG[p && p.level === 'error' ? 'error' : (p && p.level === 'warn' ? 'warn' : 'info')]('renderer', (p && p.text) || ''); return true; });

  ipcMain.handle('app:info', () => {
    let log = '';
    try { log = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'); } catch (e) { log = '（读不到更新日志）'; }
    return { version: app.getVersion(), changelog: log, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node };
  });

  ipcMain.handle('sys:openExternal', (e, { url }) => shell.openExternal(url));
  ipcMain.handle('sys:paths', () => ({ userData: app.getPath('userData'), scriptsDir: cfg().scriptsDir, backupsDir: cfg().backupsDir }));
  // ---------- 档 A：全部数据 导出 / 导入（换机器一键搬）----------
  let pendingImport = null;

  ipcMain.handle('data:exportAll', async () => {
    const bundle = dataBundle.build(app.getPath('userData'), { app: app.getVersion() });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
    const r = await dialog.showSaveDialog(win, {
      title: '导出全部数据',
      defaultPath: '远程控制台数据-' + stamp + '.json',
      filters: [{ name: '远程控制台数据包', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, JSON.stringify(bundle, null, 2), 'utf8');
    let bytes = 0;
    try { bytes = fs.statSync(r.filePath).size; } catch (e) {}
    LOG.info('main', '导出数据包：' + r.filePath + '（' + bytes + ' 字节）');
    return { ok: true, path: r.filePath, bytes: bytes, counts: bundle.counts };
  });

  ipcMain.handle('data:pickImport', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择要导入的数据包',
      filters: [{ name: '远程控制台数据包', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    const file = r.filePaths[0];
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, message: '读不到文件：' + e.message }; }
    const pr = dataBundle.parse(text);
    if (!pr.ok) return pr;
    const checks = dataBundle.checkPaths(pr.bundle, defaultConfig(app));
    const id = 'imp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    pendingImport = { id: id, bundle: pr.bundle, path: file, at: Date.now() };
    return {
      ok: true, id: id, path: file, at: pendingImport.at,
      exportedAt: pr.bundle.exportedAt || '', app: pr.bundle.app || '', dataDir: pr.bundle.dataDir || '',
      counts: pr.bundle.counts || {}, checks: checks
    };
  });

  ipcMain.handle('data:applyImport', async (e, o) => {
    o = o || {};
    if (!pendingImport || (o.id && o.id !== pendingImport.id)) return { ok: false, message: '导入会话已过期，请重新选择文件' };
    const bundle = pendingImport.bundle;
    pendingImport = null;
    let res = null;
    try {
      res = dataBundle.apply(app.getPath('userData'), bundle, { fixPaths: !!o.fixPaths, defaults: defaultConfig(app) });
    } catch (err) {
      return { ok: false, message: '写入失败：' + (err && err.message ? err.message : String(err)) };
    }
    LOG.info('main', '导入数据包完成 | 原数据备份：' + res.backupDir + ' | 自动修正 ' + (res.fixed || []).length + ' 处路径');
    return { ok: true, backupDir: res.backupDir, backed: res.backed, fixed: res.fixed };
  });

  ipcMain.handle('app:relaunch', () => { app.relaunch(); app.exit(0); return { ok: true }; });
  ipcMain.handle('win:minimize', () => { win.minimize(); });
  ipcMain.handle('win:maximize', () => { win.isMaximized() ? win.unmaximize() : win.maximize(); });
  ipcMain.handle('win:close', () => { win.close(); });
}

ipc();
