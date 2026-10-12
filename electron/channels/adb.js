'use strict';
// ADB 通道：交互式 shell（真实 PTY） + 一次性命令 + 设备/连接管理
const { spawn } = require('child_process');

function adbProc(adbPath, args) {
  return spawn(adbPath, args, { windowsHide: true });
}

function runOnce(adbPath, args, timeoutMs) {
  return new Promise((resolve) => {
    const p = adbProc(adbPath, args);
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill(); } catch (e) {} }, timeoutMs || 20000);
    p.stdout.on('data', (d) => { out += d.toString('utf8'); });
    p.stderr.on('data', (d) => { err += d.toString('utf8'); });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stdout: '', stderr: e.message }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code: code == null ? 0 : code, stdout: out, stderr: err }); });
  });
}

async function devices(adbPath) {
  const r = await runOnce(adbPath, ['devices', '-l'], 15000);
  const list = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(device|unauthorized|offline|no permissions)(.*)$/);
    if (m) list.push({ addr: m[1], state: m[2], detail: (m[3] || '').trim() });
  }
  return list;
}

async function connect(adbPath, addr) {
  const r = await runOnce(adbPath, ['connect', addr], 20000);
  return { ok: !/failed|cannot|refused|unable/i.test(r.stdout + r.stderr), message: (r.stdout + r.stderr).trim() };
}

async function disconnect(adbPath, addr) {
  const r = await runOnce(adbPath, ['disconnect', addr], 15000);
  return { message: (r.stdout + r.stderr).trim() };
}

async function shellOnce(adbPath, addr, cmd, timeoutMs) {
  const args = ['-s', addr, 'shell'].concat(String(cmd).split(' ').length ? [String(cmd)] : []);
  const r = await runOnce(adbPath, ['-s', addr, 'shell', String(cmd)], timeoutMs || 30000);
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

// 交互式 shell：必须 -t -t 才能在设备端强制分配 PTY（实测）
function openAdbSession(adbPath, addr, handlers) {
  const p = adbProc(adbPath, ['-s', addr, 'shell', '-t', '-t']);
  p.stdout.on('data', (d) => handlers.onData(d.toString('utf8')));
  p.stderr.on('data', (d) => handlers.onData(d.toString('utf8')));
  p.on('exit', (code) => handlers.onExit(code == null ? 0 : code));
  p.on('error', (e) => { handlers.onData('[ADB 错误] ' + e.message + '\r\n'); handlers.onExit(1); });
  return {
    kind: 'pty',
    writeRaw: (data) => { try { p.stdin.write(data); } catch (e) {} },
    resize: () => {},
    close: () => { try { p.stdin.write('exit\n'); } catch (e) {} try { p.kill(); } catch (e) {} }
  };
}

function push(adbPath, addr, local, remote) {
  return runOnce(adbPath, ['-s', addr, 'push', local, remote], 300000);
}
function pull(adbPath, addr, remote, local) {
  return runOnce(adbPath, ['-s', addr, 'pull', remote, local], 300000);
}

module.exports = { runOnce, devices, connect, disconnect, shellOnce, openAdbSession, push, pull };
