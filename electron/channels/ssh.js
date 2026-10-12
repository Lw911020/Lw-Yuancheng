'use strict';
// SSH 通道（C3 / comma three）：基于 ssh2，完整 PTY
const fs = require('fs');
const { Client } = require('ssh2');

function connOptions(target) {
  const c = target.ssh || {};
  const o = {
    host: c.host,
    port: c.port || 22,
    username: c.user || 'comma',
    readyTimeout: c.readyTimeout || 20000,
    keepaliveInterval: 15000
  };
  if (c.password) o.password = c.password;
  if (c.keyPath) {
    o.privateKey = fs.readFileSync(c.keyPath);
    if (c.passphrase) o.passphrase = c.passphrase;
  }
  return o;
}

function openSshSession(target, opts, handlers) {
  const conn = new Client();
  let stream = null;
  let dead = false;

  conn.on('ready', () => {
    conn.shell({
      term: 'xterm-256color',
      cols: (opts && opts.cols) || 120,
      rows: (opts && opts.rows) || 30
    }, (err, st) => {
      if (err) { handlers.onData('\x1b[31m[SSH 会话失败] ' + err.message + '\x1b[0m\r\n'); handlers.onExit(1); return; }
      stream = st;
      st.on('data', (d) => handlers.onData(d.toString('utf8')));
      st.stderr.on('data', (d) => handlers.onData(d.toString('utf8')));
      st.on('close', () => { if (!dead) { dead = true; conn.end(); handlers.onExit(0); } });
    });
  });

  conn.on('error', (e) => {
    if (!dead) { dead = true; handlers.onData('\x1b[31m[SSH 错误] ' + e.message + '\x1b[0m\r\n'); handlers.onExit(1); }
  });
  conn.on('close', () => { if (!dead) { dead = true; handlers.onExit(0); } });

  try { conn.connect(connOptions(target)); }
  catch (e) { handlers.onData('\x1b[31m[SSH 配置错误] ' + e.message + '\x1b[0m\r\n'); handlers.onExit(1); }

  return {
    kind: 'pty',
    writeRaw: (data) => { if (stream) { try { stream.write(data); } catch (e) {} } },
    resize: (cols, rows) => { if (stream) { try { stream.setWindow(rows, cols, 0, 0); } catch (e) {} } },
    close: () => { try { if (stream) stream.end(); } catch (e) {} try { conn.end(); } catch (e) {} }
  };
}

function exec(target, cmd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const t = setTimeout(() => { try { conn.end(); } catch (e) {} reject(new Error('SSH 命令超时')); }, timeoutMs || 30000);
    conn.on('ready', () => {
      conn.exec(String(cmd), (err, st) => {
        if (err) { clearTimeout(t); conn.end(); reject(err); return; }
        let out = '', errOut = '';
        st.on('data', (d) => { out += d.toString('utf8'); });
        st.stderr.on('data', (d) => { errOut += d.toString('utf8'); });
        st.on('close', (code) => { clearTimeout(t); conn.end(); resolve({ code: code == null ? 0 : code, stdout: out, stderr: errOut }); });
      });
    });
    conn.on('error', (e) => { clearTimeout(t); reject(e); });
    try { conn.connect(connOptions(target)); } catch (e) { clearTimeout(t); reject(e); }
  });
}

function test(target, timeoutMs) {
  return new Promise((resolve) => {
    const conn = new Client();
    const t = setTimeout(() => { try { conn.end(); } catch (e) {} resolve({ ok: false, message: '连接超时' }); }, timeoutMs || 12000);
    conn.on('ready', () => { clearTimeout(t); conn.end(); resolve({ ok: true, message: 'SSH 登录成功' }); });
    conn.on('error', (e) => { clearTimeout(t); resolve({ ok: false, message: e.message }); });
    try { conn.connect(connOptions(target)); } catch (e) { clearTimeout(t); resolve({ ok: false, message: e.message }); }
  });
}

// SFTP 单次会话（文件浏览 / 下载 / 上传）
function withSftp(target, fn) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const t = setTimeout(() => { try { conn.end(); } catch (e) {} reject(new Error('SFTP 超时')); }, 60000);
    conn.on('ready', () => {
      conn.sftp(async (err, sftp) => {
        if (err) { clearTimeout(t); conn.end(); reject(err); return; }
        try {
          const r = await fn(sftp);
          clearTimeout(t); conn.end(); resolve(r);
        } catch (e) {
          clearTimeout(t); conn.end(); reject(e);
        }
      });
    });
    conn.on('error', (e) => { clearTimeout(t); reject(e); });
    try { conn.connect(connOptions(target)); } catch (e) { clearTimeout(t); reject(e); }
  });
}

module.exports = { openSshSession, exec, test, withSftp, connOptions };
