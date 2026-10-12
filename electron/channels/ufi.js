'use strict';
// UFI-TOOLS 后台 (Ktor :2333) 适配器
// 鉴权协议来自设备上的开源实现 modules/auth/KanoAuth.kt
const http = require('http');
const crypto = require('crypto');

const REQUEST_SECRET_KEY = 'minikano_kOyXz0Ciz4V7wR0IeKmJFYFQ20jd';
const WHITELIST = ['/api/get_custom_head', '/api/version_info', '/api/need_token', '/api/get_theme', '/api/SELinux'];

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

// 与 Kotlin KanoUtils.HmacSignature 完全一致
function hmacSignature(secret, data) {
  const mac = crypto.createHmac('md5', secret).update(Buffer.from(String(data), 'utf8')).digest();
  const mid = Math.floor(mac.length / 2);
  const a = crypto.createHash('sha256').update(mac.subarray(0, mid)).digest();
  const b = crypto.createHash('sha256').update(mac.subarray(mid)).digest();
  return crypto.createHash('sha256').update(Buffer.concat([a, b])).digest('hex');
}

function normalizePath(p) {
  let s = String(p || '/');
  s = s.split('\\').join('/');
  s = s.replace(/\/{2,}/g, '/');
  if (s.charAt(0) !== '/') s = '/' + s;
  return s;
}

function authToken(token) {
  const t = String(token == null ? '' : token).trim();
  if (/^[0-9a-f]{64}$/i.test(t)) return t;
  return sha256Hex(t);
}

function request(target, opts) {
  return new Promise((resolve, reject) => {
    const cfg = target.ufi || {};
    const base = (opts && opts.base) || cfg.base;
    const timeoutMs = (opts && opts.timeoutMs) || cfg.timeoutMs || 30000;
    const method = String((opts && opts.method) || 'GET').toUpperCase();
    const pathOnly = normalizePath((opts && opts.path) || '/');
    let p = pathOnly;
    if (opts && opts.query && Object.keys(opts.query).length) {
      p += (p.indexOf('?') >= 0 ? '&' : '?') + new URLSearchParams(opts.query).toString();
    }
    const u = new URL(base);
    const bodyBuf = opts && opts.body != null
      ? Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body), 'utf8')
      : null;

    const headers = { Accept: 'application/json' };
    const isApi = pathOnly === '/api' || pathOnly.indexOf('/api/') === 0;
    const noAuth = !isApi || WHITELIST.indexOf(pathOnly) >= 0 || pathOnly.indexOf('/api/uploads') === 0;
    if (!noAuth) {
      const ts = String(Date.now());
      headers.authorization = authToken(cfg.token);
      headers['kano-t'] = ts;
      headers['kano-sign'] = hmacSignature(REQUEST_SECRET_KEY, 'minikano' + method + pathOnly + ts);
    }
    if (bodyBuf) headers['Content-Type'] = 'application/json';

    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: p, method, headers, timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        if (res.statusCode === 401) {
          reject(new Error('401 未授权：后台令牌不正确（当前 token=' + (cfg.token || '') + '）'));
          return;
        }
        if (res.statusCode >= 400) {
          const msg = (json && (json.error || json.message)) || text.slice(0, 300);
          reject(new Error('HTTP ' + res.statusCode + '：' + msg));
          return;
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时（' + timeoutMs + 'ms）：' + pathOnly)));
    req.on('error', (e) => reject(e));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// 统一解析 ShellResult：可能是 {done,content}，也可能整个 result 就是输出字符串
function unwrapShell(r) {
  const res = r.json && r.json.result;
  if (res && typeof res === 'object') return { done: !!res.done, content: String(res.content == null ? '' : res.content) };
  if (typeof res === 'string') {
    let s = res;
    try {
      const inner = JSON.parse(s);
      if (inner && typeof inner === 'object' && typeof inner.result === 'string') s = inner.result;
    } catch (e) { /* 原样 */ }
    return { done: true, content: s };
  }
  if (r.json && r.json.error) throw new Error(String(r.json.error));
  return { done: true, content: r.text };
}

async function rootShell(target, command, timeoutMs) {
  const ms = Math.min(timeoutMs || 60000, 100000);
  const r = await request(target, {
    method: 'POST', path: '/api/root_shell',
    body: { command: String(command), timeout: ms },
    timeoutMs: ms + 15000
  });
  return unwrapShell(r);
}

async function userShell(target, command, timeoutMs) {
  const r = await request(target, {
    method: 'POST', path: '/api/user_shell',
    body: { command: String(command) }, timeoutMs: (timeoutMs || 30000) + 5000
  });
  return unwrapShell(r);
}

async function at(target, cmd) {
  const r = await request(target, { path: '/api/AT', query: cmd ? { cmd: cmd } : {} });
  return r.json != null ? r.json : r.text;
}

function toCrlf(s) {
  return String(s).replace(/\r?\n/g, '\r\n');
}

// UFI 的 shell 接口每次都是一个全新的 sh，cwd 不会保留 —— 由客户端补 cd
function shQuote(p) {
  return "'" + String(p).split("'").join("'\\''") + "'";
}

function buildCmd(cwd, cmd) {
  if (!cwd || cwd === '/') return cmd;
  return 'cd ' + shQuote(cwd) + ' && ' + cmd;
}

// root 命令台：逐行执行（非交互式 TTY）
function openRootConsole(target, handlers) {
  let closed = false;
  let cwd = '/';
  const prompt = () => handlers.onPrompt('root@U30Air ' + cwd + ' # ');
  handlers.onData('\x1b[32m● U30 Air Root 命令台\x1b[0m（root 权限，逐行执行；不支持 top/vi 这类全屏交互程序）\r\n');
  prompt();

  async function run(raw) {
    if (closed) return;
    const c = String(raw == null ? '' : raw).trim();
    if (!c) { prompt(); return; }
    if (/^clear$/i.test(c)) { handlers.onClear(); prompt(); return; }
    try {
      const cd = c.match(/^cd(?:\s+(.*))?$/);
      if (cd) {
        const r = await rootShell(target, buildCmd(cwd, 'cd ' + (cd[1] || '~') + ' 2>&1 && pwd'), 20000);
        const out = (r.content || '').trim();
        if (out && out.charAt(0) === '/') cwd = out.split(/\r?\n/).pop().trim();
        else if (out) handlers.onData('\x1b[31m' + toCrlf(out) + '\x1b[0m');
      } else {
        const r = await rootShell(target, buildCmd(cwd, c), 90000);
        if (r.content) handlers.onData(toCrlf(r.content));
        if (!r.done) handlers.onData('\x1b[31m[命令未正常结束或超时]\x1b[0m\r\n');
      }
    } catch (e) {
      handlers.onData('\x1b[31m[错误] ' + e.message + '\x1b[0m\r\n');
    }
    prompt();
  }

  return { kind: 'repl', writeRaw: () => {}, run, resize: () => {}, close: () => { closed = true; } };
}

function openUserConsole(target, handlers) {
  let closed = false;
  handlers.onData('\x1b[33m● U30 Air 用户命令台\x1b[0m（shell 用户权限）\r\n');
  handlers.onPrompt('shell@U30Air $ ');
  async function run(cmd) {
    if (closed) return;
    const c = String(cmd == null ? '' : cmd).trim();
    if (!c) { handlers.onPrompt('shell@U30Air $ '); return; }
    try {
      const r = await userShell(target, c, 60000);
      if (r.content) handlers.onData(toCrlf(r.content));
      if (!r.done) handlers.onData('\x1b[31m[命令未正常结束或超时]\x1b[0m\r\n');
    } catch (e) {
      handlers.onData('\x1b[31m[错误] ' + e.message + '\x1b[0m\r\n');
    }
    handlers.onPrompt('shell@U30Air $ ');
  }
  return { kind: 'repl', writeRaw: () => {}, run, resize: () => {}, close: () => { closed = true; } };
}

module.exports = {
  sha256Hex, hmacSignature, normalizePath, authToken, request,
  rootShell, userShell, at, openRootConsole, openUserConsole,
  WHITELIST, REQUEST_SECRET_KEY
};
