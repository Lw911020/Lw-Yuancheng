'use strict';
// 本机 PowerShell 通道（命令模式 REPL）
// Windows 上 Node/Electron 拿不到 ConPTY，所以本机终端做成"逐行命令"模式：
// 渲染层负责行编辑与回显，这里只负责执行并把 cwd 带回去。
const { spawn } = require('child_process');

const MARK = '@@RC_CWD@@';

function openLocalSession(handlers) {
  const child = spawn('powershell.exe',
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    { windowsHide: true });

  let pending = '';
  let closed = false;

  function onChunk(s) {
    pending += s;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      const i = line.indexOf(MARK);
      if (i >= 0) {
        const cwd = line.slice(i + MARK.length).trim() || '?';
        handlers.onPrompt('PS ' + cwd + '> ');
      } else {
        handlers.onData(line + '\r\n');
      }
    }
  }

  child.stdout.on('data', (d) => onChunk(d.toString('utf8')));
  child.stderr.on('data', (d) => onChunk(d.toString('utf8')));
  child.on('exit', (code) => { closed = true; handlers.onExit(code == null ? 0 : code); });
  child.on('error', (e) => { handlers.onData('[本机通道错误] ' + e.message + '\r\n'); handlers.onExit(1); });

  handlers.onData('\x1b[32m● 本机 PowerShell\x1b[0m（命令模式：支持历史、退格；交互式程序请点右上角"独立窗口"）\r\n');
  run('$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference="Continue"');

  function run(cmd) {
    if (closed) return;
    const c = String(cmd == null ? '' : cmd);
    if (!c.trim()) { run2(''); return; }
    run2(c);
  }

  function run2(c) {
    try {
      child.stdin.write(c + '\n');
      child.stdin.write('Write-Host "' + MARK + '$($PWD.Path)"\n');
    } catch (e) {
      handlers.onData('[写入失败] ' + e.message + '\r\n');
    }
  }

  return {
    kind: 'repl',
    writeRaw: () => {},
    run,
    resize: () => {},
    close: () => { try { child.stdin.write('exit\n'); } catch (e) {} try { child.kill(); } catch (e) {} }
  };
}

module.exports = { openLocalSession };
