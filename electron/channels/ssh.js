'use strict';
// SSH 通道（C3 / comma three）：基于 ssh2，完整 PTY
// 多地址回退：C3 会在「家里网 192.168.31.x」和「U30 热点 192.168.0.x」之间来回切，
// 所以 target.ssh.host 连不上时依次试 target.ssh.alt（逗号分隔），并记住上次成功的地址优先用。
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const lastGood = {};        // targetId -> host（上次握手成功的地址）
const lastGoodKey = {};     // targetId -> keyPath（上次认证成功的私钥）

function hostList(target) {
  const c = (target && target.ssh) || {};
  const out = [];
  const push = (h) => { h = String(h || '').trim(); if (h && out.indexOf(h) < 0) out.push(h); };
  push(lastGood[target.id]);
  push(c.host);
  String(c.alt || '').split(',').forEach(push);
  return out;
}

// 设备被刷机后 authorized_keys 会变，但 c3-keys 目录里通常还留着旧钥匙/备份，
// 这里把「配置的主钥匙 + 同目录下同名前缀的其它私钥」都作为候选，认证失败时自动换一把。
function keyCandidates(target) {
  const c = (target && target.ssh) || {};
  const out = [];
  const add = (p) => {
    if (!p) return;
    if (/\.ppk$/i.test(p)) return;            // PuTTY 格式用不了，跳过
    if (out.indexOf(p) >= 0) return;
    out.push(p);
  };
  if (lastGoodKey[target.id]) add(lastGoodKey[target.id]);
  if (c.keyPath) {
    add(c.keyPath);
    try {
      const dir = path.dirname(c.keyPath);
      const base = path.basename(c.keyPath);
      for (const f of fs.readdirSync(dir)) {
        if (f === base) continue;
        if (f.indexOf(base) === 0) add(path.join(dir, f));
      }
    } catch (e) { /* 目录读不到就用主钥匙 */ }
  }
  return out;
}

function connOptions(target, host, timeoutMs) {
  const c = (target && target.ssh) || {};
  const o = {
    host: host || c.host,
    port: c.port || 22,
    username: c.user || 'comma',
    readyTimeout: timeoutMs || c.readyTimeout || 20000,
    keepaliveInterval: 15000
  };
  if (c.password) o.password = c.password;
  const kp = arguments.length > 3 && arguments[3] ? arguments[3] : c.keyPath;
  if (kp) {
    if (/\.ppk$/i.test(kp)) {
      throw new Error('这个私钥是 PuTTY 格式（.ppk），本程序只支持 OpenSSH/PEM 私钥；请改用 OpenSSH 私钥（如 c3_id_ed25519），或先用 puttygen 转成 OpenSSH 格式');
    }
    o.privateKey = fs.readFileSync(kp);
    if (c.passphrase) o.passphrase = c.passphrase;
  }
  return o;
}

// 依次尝试「地址 × 钥匙」组合，返回已 ready 的 Client
function connectAny(target, timeoutMs) {
  const hosts = hostList(target);
  const keys = keyCandidates(target);
  const per = timeoutMs || Math.min(((target && target.ssh && target.ssh.readyTimeout) || 20000), 8000);
  const combos = [];
  for (const h of hosts) {
    if (!keys.length) combos.push({ host: h, key: null });
    else for (const k of keys) combos.push({ host: h, key: k });
  }
  return new Promise((resolve, reject) => {
    let i = 0;
    let lastErr = null;
    const next = () => {
      if (i >= combos.length) {
        const tried = combos.map((c) => c.host + (c.key ? ' (' + path.basename(c.key) + ')' : '')).join(' / ');
        reject(new Error('SSH 连不上（试过 ' + tried + '）' + (lastErr ? '：' + lastErr.message : '')));
        return;
      }
      const combo = combos[i++];
      const conn = new Client();
      let settled = false;
      const finish = (ok, err) => {
        if (settled) return;
        settled = true;
        if (ok) {
          lastGood[target.id] = combo.host;
          if (combo.key) lastGoodKey[target.id] = combo.key;
          resolve(conn);
        } else { lastErr = err; try { conn.end(); } catch (e) {} next(); }
      };
      conn.on('ready', () => finish(true));
      conn.on('error', (e) => finish(false, e));
      try { conn.connect(connOptions(target, combo.host, per, combo.key)); } catch (e) { finish(false, e); }
    };
    next();
  });
}

function openSshSession(target, opts, handlers) {
  let stream = null;
  let dead = false;
  connectAny(target).then((conn) => {
    conn.on('error', (e) => { if (!dead) { dead = true; handlers.onData('\x1b[31m[SSH 错误] ' + e.message + '\x1b[0m\r\n'); handlers.onExit(1); } });
    conn.on('close', () => { if (!dead) { dead = true; handlers.onExit(0); } });
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
  }).catch((e) => {
    if (!dead) { dead = true; handlers.onData('\x1b[31m[SSH 连接失败] ' + e.message + '\x1b[0m\r\n'); handlers.onExit(1); }
  });

  return {
    kind: 'pty',
    writeRaw: (data) => { if (stream) { try { stream.write(data); } catch (e) {} } },
    resize: (cols, rows) => { if (stream) { try { stream.setWindow(rows, cols, 0, 0); } catch (e) {} } },
    close: () => { try { if (stream) stream.end(); } catch (e) {} }
  };
}

function exec(target, cmd, timeoutMs) {
  return connectAny(target).then((conn) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { try { conn.end(); } catch (e) {} reject(new Error('SSH 命令超时')); }, timeoutMs || 30000);
    conn.on('error', (e) => { clearTimeout(t); try { conn.end(); } catch (x) {} reject(e); });
    conn.exec(String(cmd), (err, st) => {
      if (err) { clearTimeout(t); conn.end(); reject(err); return; }
      let out = '', errOut = '';
      st.on('data', (d) => { out += d.toString('utf8'); });
      st.stderr.on('data', (d) => { errOut += d.toString('utf8'); });
      st.on('close', (code) => { clearTimeout(t); conn.end(); resolve({ code: code == null ? 0 : code, stdout: out, stderr: errOut }); });
    });
  }));
}

function test(target, timeoutMs) {
  const hosts = hostList(target);
  return connectAny(target, timeoutMs).then((conn) => {
    const host = lastGood[target.id] || (target.ssh && target.ssh.host);
    try { conn.end(); } catch (e) {}
    return { ok: true, message: 'SSH 登录成功（' + host + '）', host: host };
  }).catch((e) => ({ ok: false, message: e.message, hosts: hosts }));
}

// SFTP 单次会话（文件浏览 / 下载 / 上传）
function withSftp(target, fn) {
  return connectAny(target).then((conn) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { try { conn.end(); } catch (e) {} reject(new Error('SFTP 超时')); }, 60000);
    conn.on('error', (e) => { clearTimeout(t); try { conn.end(); } catch (x) {} reject(e); });
    conn.sftp(async (err, sftp) => {
      if (err) { clearTimeout(t); conn.end(); reject(err); return; }
      try {
        const r = await fn(sftp);
        clearTimeout(t); conn.end(); resolve(r);
      } catch (e) {
        clearTimeout(t); conn.end(); reject(e);
      }
    });
  }));
}

module.exports = { openSshSession, exec, test, withSftp, connOptions, connectAny, hostList, keyCandidates, lastGood, lastGoodKey };
