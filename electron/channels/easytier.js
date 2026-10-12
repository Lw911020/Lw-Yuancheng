'use strict';
// EasyTier 隧道管理：状态探测 / 启动 / 停止 / 重启 / peer 与 route 表
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

function run(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(exe, args, { windowsHide: true }); }
    catch (e) { resolve({ code: -1, stdout: '', stderr: e.message }); return; }
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill(); } catch (e) {} resolve({ code: -2, stdout: out, stderr: err + ' [超时]' }); }, timeoutMs || 15000);
    p.stdout.on('data', (d) => { out += d.toString('utf8'); });
    p.stderr.on('data', (d) => { err += d.toString('utf8'); });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stdout: out, stderr: e.message }); });
    p.on('close', (c) => { clearTimeout(t); resolve({ code: c == null ? 0 : c, stdout: out, stderr: err }); });
  });
}

function ping(ip, ms) {
  return run('ping', ['-n', '1', '-w', String(ms || 2500), ip], (ms || 2500) + 3000).then((r) => {
    const ok = r.code === 0 && /(TTL=|ttl=)/.test(r.stdout);
    const m = r.stdout.match(/[=<](\d+)ms/i);
    return { ok: ok, ms: m ? Number(m[1]) : null };
  });
}

async function procList() {
  const r = await run('tasklist', ['/FO', 'CSV', '/NH'], 12000);
  const names = [];
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)"/);
    if (m && /easytier/i.test(m[1])) names.push(m[1].toLowerCase());
  }
  return {
    gui: names.some((n) => n.indexOf('gui') >= 0),
    core: names.some((n) => n.indexOf('core') >= 0),
    any: names.length > 0,
    names: [...new Set(names)]
  };
}

function parseTable(text) {
  const rows = [];
  let header = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.replace(/^\||\|$/g, '').split('|').map((s) => s.trim());
    if (cells.every((c) => /^[-: ]*$/.test(c))) continue;
    if (!header) { header = cells; continue; }
    const o = {};
    header.forEach((h, i) => { o[h || ('col' + i)] = cells[i] || ''; });
    rows.push(o);
  }
  return { header: header || [], rows: rows };
}

async function cli(cfg, args, timeoutMs) {
  const exe = (cfg.easytier && cfg.easytier.cliExe) || '';
  if (!exe) throw new Error('未配置 easytier-cli 路径');
  return await run(exe, args, timeoutMs || 12000);
}

async function status(cfg) {
  const et = cfg.easytier || {};
  const procs = await procList();
  const pingRes = et.probeIp ? await ping(et.probeIp, 2500) : { ok: false, ms: null };
  let peers = null, routes = null, selfIp = '', error = '';
  try {
    const p = await cli(cfg, ['peer'], 12000);
    peers = parseTable(p.stdout);
    if (!peers.rows.length && p.stderr) error = p.stderr.trim().slice(0, 200);
    const self = peers && peers.rows.find((r) => (r.cost || '').toLowerCase() === 'local');
    if (self) selfIp = (self.ipv4 || '').split('/')[0];
  } catch (e) { error = e.message; }
  try {
    const r2 = await cli(cfg, ['route'], 12000);
    routes = parseTable(r2.stdout);
  } catch (e) { /* 忽略 */ }

  const peerRows = (peers && peers.rows) || [];
  const others = peerRows.filter((r) => (r.cost || '').toLowerCase() !== 'local');
  const bestLat = others.map((r) => parseFloat(r['lat(ms)'])).filter((x) => !isNaN(x)).sort((a, b) => a - b)[0];
  const hasRelay = others.some((r) => /server|relay|public/i.test(r.hostname || ''));

  return {
    at: Date.now(),
    running: procs.any,
    gui: procs.gui,
    core: procs.core,
    processes: procs.names,
    tunnelOk: pingRes.ok,
    pingMs: pingRes.ms,
    probeIp: et.probeIp,
    selfIp: selfIp,
    peerCount: others.length,
    bestLatencyMs: isNaN(bestLat) ? null : bestLat,
    viaRelay: hasRelay,
    peers: peers,
    routes: routes,
    error: error
  };
}

let startInFlight = false;

// 内核日志落到文件里，控制台窗口隐藏（不然每次起隧道都弹一个黑框）
function logPaths() {
  const os = require('os');
  const dir = path.join(os.homedir(), '.remote-console');
  try { require('fs').mkdirSync(dir, { recursive: true }); } catch (e) { /* 忽略 */ }
  return { dir: dir, out: path.join(dir, 'easytier.log'), err: path.join(dir, 'easytier.err.log'), script: path.join(dir, 'start-easytier.ps1') };
}

async function start(cfg) {
  if (startInFlight) return { ok: true, message: '已经有一个启动请求在处理中，请稍候…', already: true };
  startInFlight = true;
  try {
    return await doStart(cfg);
  } finally {
    startInFlight = false;
  }
}

async function doStart(cfg) {
  const et = cfg.easytier || {};
  const fs = require('fs');
  const before = await procList();
  if (before.any) return { ok: true, message: '隧道已经在运行（' + before.names.join(', ') + '）', already: true };
  // 等 1 秒再确认一次，避免并发启动出两个内核
  await new Promise((r) => setTimeout(r, 1000));
  const again = await procList();
  if (again.any) return { ok: true, message: '隧道已经在运行（' + again.names.join(', ') + '）', already: true };

  const lnk = et.guiLnk;
  const haveLnk = lnk && fs.existsSync(lnk);
  const exe = et.coreExe;
  const haveCore = exe && fs.existsSync(exe);
  const useGui = et.startMode === 'gui';

  // 用外部 GUI 启动（配置在 GUI 里，会自行提权）
  if ((useGui || !haveCore) && haveLnk) {
    try {
      spawn('cmd.exe', ['/c', 'start', '""', lnk], { windowsHide: true, detached: true }).unref();
      return { ok: true, message: '已通过快捷方式启动外部 EasyTier GUI' + (useGui ? '' : '（没找到内置内核，回退到 GUI）') };
    } catch (e) { /* 继续 */ }
  }

  // 用内置内核启动
  if (!haveCore) {
    return { ok: false, message: '找不到 EasyTier 内核：' + (exe || '未配置') + '（可在设置里改 coreExe 或切到 GUI 模式）' };
  }
  const args = (et.args || []);
  const lp = logPaths();

  // 用一个临时 ps1：提权 + 隐藏窗口 + 日志重定向到文件
  const inner = [
    '$ErrorActionPreference = "Stop"',
    'Start-Process -FilePath "' + exe + '" -ArgumentList @(' + args.map(function (a) { return "'" + String(a).replace(/'/g, "''") + "'"; }).join(',') + ') ' +
      '-WindowStyle Hidden -RedirectStandardOutput "' + lp.out + '" -RedirectStandardError "' + lp.err + '"'
  ].join('\n');
  // 必须带 UTF-8 BOM：PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI 解，把中文路径读成乱码
  try { require('fs').writeFileSync(lp.script, '\ufeff' + inner, 'utf8'); } catch (e) {
    return { ok: false, message: '写启动脚本失败：' + e.message };
  }
  try { require('fs').writeFileSync(lp.out, '', 'utf8'); require('fs').writeFileSync(lp.err, '', 'utf8'); } catch (e) { /* 忽略 */ }

  const ps = 'Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File","' + lp.script + '") -Verb RunAs';
  const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], 30000);
  if (r.code !== 0) return { ok: false, message: '启动失败（需要同意 UAC 才能创建虚拟网卡）：' + (r.stderr || r.stdout).trim().slice(0, 200) };
  // 等一下再确认是不是真的起来了（不能谎报成功）
  for (let i = 0; i < 10; i++) {
    await new Promise((r2) => setTimeout(r2, 1200));
    const now = await procList();
    if (now.any) {
      return { ok: true, message: '已用【内置内核】启动隧道（窗口已隐藏，日志：' + lp.out + '）' };
    }
  }
  let detail = '';
  try { detail = require('fs').readFileSync(lp.err, 'utf8').trim(); } catch (e) { /* 忽略 */ }
  if (!detail) { try { detail = require('fs').readFileSync(lp.out, 'utf8').trim().slice(-300); } catch (e) { /* 忽略 */ } }
  return {
    ok: false,
    message: '隧道没起来。' + (detail ? '内核输出：' + detail : '（大概是在 UAC 弹窗上点了"否"，或者路径不可用）')
  };
}

async function stop(cfg) {
  const et = cfg.easytier || {};
  const before = await procList();
  if (!before.any) return { ok: true, message: '隧道本来就没在运行', already: true };
  const r1 = await run('taskkill', ['/IM', 'easytier-core.exe', '/F'], 15000);
  let r2 = { code: 0, stdout: '', stderr: '' };
  if (et.stopGui) r2 = await run('taskkill', ['/IM', 'easytier-gui.exe', '/F'], 15000);
  await new Promise((r) => setTimeout(r, 2000));

  // 内核通常是提权启动的，普通权限杀不掉 —— 再提权杀一次
  const left = await procList();
  if (left.any) {
    const ps = "Start-Process -FilePath taskkill.exe -ArgumentList '/IM easytier-core.exe /F' -Verb RunAs -Wait";
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], 30000);
    await new Promise((r) => setTimeout(r, 2000));
    const left2 = await procList();
    return {
      ok: !left2.any,
      message: left2.any
        ? '还有内核没结束（可能没点 UAC）：' + left2.names.join(', ')
        : '已结束隧道（用了提权，UAC 需要点"是"）'
    };
  }
  return {
    ok: true,
    message: '已结束：' + before.names.join(', ')
  };
}

async function restart(cfg) {
  await stop(cfg);
  await new Promise((r) => setTimeout(r, 2500));
  return await start(cfg);
}

function diagnose(cfg, st) {
  const lines = [];
  lines.push('远程控制台 · EasyTier 隧道诊断');
  lines.push('时间：' + new Date().toLocaleString());
  lines.push('进程：' + (st.processes && st.processes.length ? st.processes.join(', ') : '无'));
  lines.push('探测 ' + st.probeIp + '：' + (st.tunnelOk ? ('通 ' + (st.pingMs == null ? '' : st.pingMs + 'ms')) : '不通'));
  lines.push('本机虚拟 IP：' + (st.selfIp || '未知'));
  lines.push('对端数：' + st.peerCount + '，最优延迟：' + (st.bestLatencyMs == null ? '未知' : st.bestLatencyMs + 'ms'));
  if (st.error) lines.push('错误：' + st.error);
  (st.peers && st.peers.rows || []).forEach((r) => lines.push('  peer ' + [r.ipv4, r.hostname, r.tunnel, r['lat(ms)'], r.NAT].join(' | ')));
  (st.routes && st.routes.rows || []).forEach((r) => lines.push('  route ' + [r.ipv4, r.hostname, r.proxy_cidrs, r['path_latency']].join(' | ')));
  return lines.join('\n');
}

function logs() { return logPaths(); }

module.exports = { status, start, stop, restart, cli, ping, procList, parseTable, diagnose, run, logs };
