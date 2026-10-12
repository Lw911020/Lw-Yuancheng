'use strict';
// 会话管理：pty（原始字节流）与 repl（逐行命令）两种模式
const local = require('./channels/local');
const adb = require('./channels/adb');
const ssh = require('./channels/ssh');
const ufi = require('./channels/ufi');

class SessionManager {
  constructor(getConfig, emit) {
    this.getConfig = getConfig;   // () => config
    this.emit = emit;             // (channel, payload) => void
    this.sessions = new Map();
    this.seq = 1;
  }

  list() {
    return [...this.sessions.values()].map((s) => ({ id: s.id, title: s.title, targetId: s.targetId, kindCode: s.kindCode, mode: s.mode, alive: s.alive }));
  }

  open(opts) {
    const cfg = this.getConfig();
    const target = (cfg.targets || []).find((t) => t.id === opts.targetId);
    if (!target) throw new Error('未知设备：' + opts.targetId);
    const id = 'sess-' + (this.seq++);
    const handlers = {
      onData: (data) => this.emit('session:data', { id: id, data: data }),
      onPrompt: (text) => this.emit('session:prompt', { id: id, text: text }),
      onClear: () => this.emit('session:clear', { id: id }),
      onExit: (code) => {
        const s = this.sessions.get(id);
        if (s) { s.alive = false; }
        this.emit('session:exit', { id: id, code: code });
      }
    };

    let handle = null;
    const kindCode = opts.kindCode || 'shell';

    if (opts.kindCode === 'local') {
      handle = local.openLocalSession(handlers);
    } else if (opts.kindCode === 'ssh') {
      handle = ssh.openSshSession(target, opts, handlers);
    } else if (opts.kindCode === 'adb') {
      const addr = (target.adb && target.adb.addr) || opts.addr;
      handle = adb.openAdbSession(cfg.adbPath, addr, handlers);
    } else if (opts.kindCode === 'root') {
      handle = ufi.openRootConsole(target, handlers);
    } else if (opts.kindCode === 'ufi-user') {
      handle = ufi.openUserConsole(target, handlers);
    } else {
      throw new Error('不支持的会话类型：' + opts.kindCode);
    }

    const rec = {
      id: id, targetId: opts.targetId, title: opts.title || target.name,
      kindCode: kindCode, mode: handle.kind, alive: true, handle: handle
    };
    this.sessions.set(id, rec);
    return { id: id, mode: handle.kind, title: rec.title, targetId: rec.targetId, kindCode: kindCode };
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (s && s.alive && s.mode === 'pty') s.handle.writeRaw(data);
  }

  async run(id, cmd) {
    const s = this.sessions.get(id);
    if (!s || !s.alive) return;
    if (s.mode === 'repl') await s.handle.run(cmd);
    else s.handle.writeRaw(cmd + '\n');
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (s && s.alive && s.handle.resize) s.handle.resize(cols, rows);
  }

  close(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    try { s.handle.close(); } catch (e) { /* 忽略 */ }
    this.sessions.delete(id);
  }

  closeAll() { for (const id of [...this.sessions.keys()]) this.close(id); }
}

module.exports = { SessionManager };
