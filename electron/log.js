'use strict';
// 统一日志：写到 用户目录\logs\app-YYYY-MM-DD.log，程序里能直接看
const fs = require('fs');
const path = require('path');

let dir = null, file = null, stream = null, day = '';

function pad(n, w) { return String(n).padStart(w || 2, '0'); }
function stamp() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' '
    + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
}

function init(app) {
  try {
    dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    open();
    // 只留最近 7 个日志文件
    const files = fs.readdirSync(dir).filter((f) => /^app-.*\.log$/.test(f)).sort();
    while (files.length > 7) { try { fs.unlinkSync(path.join(dir, files.shift())); } catch (e) {} }
  } catch (e) { /* 日志系统自己不能把程序搞挂 */ }
}

function open() {
  const d = new Date();
  day = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  file = path.join(dir, 'app-' + day + '.log');
  try { stream = fs.createWriteStream(file, { flags: 'a' }); } catch (e) { stream = null; }
}

function write(level, tag, msg) {
  const line = stamp() + ' [' + String(level).padEnd(5) + '] [' + (tag || 'main') + '] ' + msg;
  try {
    if (!stream) open();
    if (file && path.basename(file) !== 'app-' + day + '.log') open();
    if (stream) stream.write(line + '\n');
  } catch (e) {}
  if (level === 'ERROR') { try { console.error(line); } catch (e) {} }
}

function fmtErr(e) {
  if (!e) return '(无信息)';
  if (e instanceof Error) return (e.message || '') + '\n' + (e.stack || '');
  try { return typeof e === 'string' ? e : JSON.stringify(e); } catch (x) { return String(e); }
}

const api = {
  init: init,
  info: (tag, msg) => write('INFO', tag, msg),
  warn: (tag, msg) => write('WARN', tag, msg),
  error: (tag, msg, e) => write('ERROR', tag, msg + (e ? ' :: ' + fmtErr(e) : '')),
  file: () => file,
  dir: () => dir,
  tail: function (n) {
    try {
      const txt = fs.readFileSync(file, 'utf8');
      const lines = txt.split('\n');
      return lines.slice(Math.max(0, lines.length - (n || 400))).join('\n');
    } catch (e) { return '(还没有日志)'; }
  },
  list: function () {
    try { return fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort().reverse(); } catch (e) { return []; }
  },
  readFile: function (name) {
    try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch (e) { return '(读不到 ' + name + ')'; }
  },
  clear: function () {
    try { if (stream) { stream.end(); stream = null; } fs.writeFileSync(file, ''); open(); return true; } catch (e) { return false; }
  }
};
module.exports = api;
