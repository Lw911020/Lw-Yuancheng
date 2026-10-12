'use strict';
// 本地持久化：config / 命令库 / 脚本索引。脚本正文以真实 .sh 文件存放。
const fs = require('fs');
const path = require('path');

class Store {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.configPath = path.join(userDataDir, 'config.json');
    this.commandsPath = path.join(userDataDir, 'commands.json');
    this.scriptsPath = path.join(userDataDir, 'scripts.json');
    fs.mkdirSync(userDataDir, { recursive: true });
    this.config = this.readJson(this.configPath, null);
    this.commands = this.readJson(this.commandsPath, null);
    this.scripts = this.readJson(this.scriptsPath, null);
  }

  readJson(p, dflt) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; }
  }

  writeJson(p, obj) {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  }

  init(defaultConfig) {
    // 老配置 + 新默认值深度合并：升级后新增的字段（如 easytier.autoStart）自动补齐
    this.config = this.config ? mergeConfig(defaultConfig, this.config) : defaultConfig;
    this.saveConfig();
    if (!this.commands) { this.commands = { items: DEFAULT_COMMANDS() }; this.saveCommands(); }
    if (!this.scripts) { this.scripts = { items: [] }; this.saveScripts(); }
    return this.config;
  }

  saveConfig() { this.writeJson(this.configPath, this.config); }
  saveCommands() { this.writeJson(this.commandsPath, this.commands); }
  saveScripts() { this.writeJson(this.scriptsPath, this.scripts); }

  target(id) { return (this.config.targets || []).find((t) => t.id === id) || null; }

  scriptsDir() {
    const d = this.config.scriptsDir;
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  listScripts() {
    return (this.scripts.items || []).map((s) => {
      const p = path.join(this.scriptsDir(), s.file);
      let size = 0;
      try { size = fs.statSync(p).size; } catch (e) { size = -1; }
      return Object.assign({}, s, { path: p, size: size });
    });
  }

  saveScript(meta, content) {
    const dir = this.scriptsDir();
    const file = meta.file || (safeName(meta.name) + '.sh');
    fs.writeFileSync(path.join(dir, file), content == null ? '' : String(content), 'utf8');
    const items = this.scripts.items || (this.scripts.items = []);
    const idx = items.findIndex((s) => s.id === meta.id);
    const rec = Object.assign({}, meta, { file: file });
    if (idx >= 0) items[idx] = Object.assign({}, items[idx], rec);
    else { rec.id = rec.id || ('s' + Date.now().toString(36)); rec.createdAt = Date.now(); items.push(rec); }
    this.saveScripts();
    return rec;
  }

  deleteScript(id) {
    const items = this.scripts.items || [];
    const i = items.findIndex((s) => s.id === id);
    if (i < 0) return { ok: false };
    const rec = items[i];
    try { fs.unlinkSync(path.join(this.scriptsDir(), rec.file)); } catch (e) { /* 忽略 */ }
    items.splice(i, 1);
    this.saveScripts();
    return { ok: true };
  }

  readScript(id) {
    const rec = (this.scripts.items || []).find((s) => s.id === id);
    if (!rec) return null;
    try { return { meta: rec, content: fs.readFileSync(path.join(this.scriptsDir(), rec.file), 'utf8') }; }
    catch (e) { return null; }
  }
}

function deepMerge(base, over) {
  if (over === undefined) return base;
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return over;
  const out = (base && typeof base === 'object' && !Array.isArray(base)) ? Object.assign({}, base) : {};
  Object.keys(over).forEach(function (k) {
    const b = base ? base[k] : undefined;
    const o = over[k];
    if (o && typeof o === 'object' && !Array.isArray(o) && b && typeof b === 'object' && !Array.isArray(b)) out[k] = deepMerge(b, o);
    else out[k] = o;
  });
  return out;
}

// targets 按 id 合并：保留用户改过的值，同时补齐新默认字段
function mergeConfig(defaults, stored) {
  const out = deepMerge(defaults, stored);
  if (Array.isArray(stored.targets) && Array.isArray(defaults.targets)) {
    const byId = {};
    defaults.targets.forEach(function (t) { byId[t.id] = t; });
    out.targets = stored.targets.map(function (t) { return byId[t.id] ? deepMerge(byId[t.id], t) : t; });
  }
  return out;
}

function safeName(n) {
  return String(n || 'script').replace(/[\\\\/:*?"<>|]/g, '_').slice(0, 60) || 'script';
}

function DEFAULT_COMMANDS() {
  return [
    { id: 'c-c3-1', name: 'C3 基本信息', targetId: 'c3', channel: 'ssh', note: 'openpilot 版本与分支', cmd: 'cd /data/openpilot && git rev-parse --abbrev-ref HEAD && git log -1 --oneline && uname -a' },
    { id: 'c-c3-2', name: 'C3 tmux 会话', targetId: 'c3', channel: 'ssh', note: '列出所有 tmux 会话', cmd: 'tmux ls' },
    { id: 'c-c3-3', name: 'C3 磁盘占用', targetId: 'c3', channel: 'ssh', note: '查看 /data 与大文件', cmd: 'df -h /data; du -sh /data/media/0/realdata 2>/dev/null' },
    { id: 'c-c3-4', name: 'C3 温度与负载', targetId: 'c3', channel: 'ssh', note: '', cmd: 'uptime; cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | head -5' },
    { id: 'c-u30-1', name: 'U30 版本信息', targetId: 'u30', channel: 'ufi', note: 'UFI-TOOLS 版本', path: '/api/version_info' },
    { id: 'c-u30-2', name: 'U30 设备状态', targetId: 'u30', channel: 'ufi', note: '电量/流量/存储', path: '/api/baseDeviceInfo' },
    { id: 'c-u30-3', name: 'U30 信号', targetId: 'u30', channel: 'ufi', note: 'RSRP/SINR/频段', path: '/api/connInfo' },
    { id: 'c-u30-4', name: 'U30 弱口令检查', targetId: 'u30', channel: 'ufi', note: '后台令牌是否弱口令', path: '/api/is_weak_token' },
    { id: 'c-u30-5', name: 'U30 root: 谁在联网', targetId: 'u30', channel: 'root', note: '当前联网进程', cmd: 'ss -tnp 2>/dev/null | head -20 || netstat -tnp 2>/dev/null | head -20' },
    { id: 'c-u30-6', name: 'U30 root: 防火墙规则', targetId: 'u30', channel: 'root', note: 'iptables NAT 规则', cmd: 'iptables -t nat -S 2>/dev/null | head -40' },
    { id: 'c-car-1', name: '车机型号', targetId: 'car', channel: 'adb', note: '', cmd: 'getprop ro.product.model; getprop ro.build.version.release; getprop ro.product.cpu.abi' },
    { id: 'c-car-2', name: '车机三方应用', targetId: 'car', channel: 'adb', note: '列出已安装第三方包', cmd: 'pm list packages -3' },
    { id: 'c-car-3', name: '车机存储', targetId: 'car', channel: 'adb', note: '', cmd: 'df -h /data /sdcard' },
    { id: 'c-local-1', name: '本机 adb 设备', targetId: 'local', channel: 'local', note: '', cmd: '& "D:\\移动WiFi\\pc-tools\\platform-tools\\adb.exe" devices -l' }
  ];
}

module.exports = { Store, safeName, DEFAULT_COMMANDS };
