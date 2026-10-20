'use strict';
// 档 A：把「工作台数据」打成一个 JSON 包，换机器一键搬。
// 包含：设置与设备连接、命令库、脚本（索引 + 正文）、参数快照
// 不含：日志、备份（体积大，且换机器意义不大）
const fs = require('fs');
const path = require('path');

const KIND = 'remote-console-backup';
const VERSION = 1;
const FILES = ['config.json', 'commands.json', 'scripts.json', 'param-snapshots.json'];

function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; } }
function exists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }

// 打包当前 dataDir
function build(dataDir, extra) {
  const cfg = readJson(path.join(dataDir, 'config.json'), {});
  const commands = readJson(path.join(dataDir, 'commands.json'), { items: [] });
  const index = readJson(path.join(dataDir, 'scripts.json'), { items: [] });
  const snapshots = readJson(path.join(dataDir, 'param-snapshots.json'), null);
  const scriptsDir = cfg.scriptsDir || path.join(dataDir, 'scripts');
  const scripts = [];
  for (const s of (index.items || [])) {
    let content = '';
    try { content = fs.readFileSync(path.join(scriptsDir, s.file), 'utf8'); } catch (e) { content = ''; }
    scripts.push({ meta: s, content: content });
  }
  const snapCount = Array.isArray(snapshots) ? snapshots.length : (snapshots ? Object.keys(snapshots).length : 0);
  return {
    kind: KIND,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    app: (extra && extra.app) || '',
    dataDir: dataDir,
    counts: {
      targets: (cfg.targets || []).length,
      commands: (commands.items || []).length,
      scripts: scripts.length,
      snapshots: snapCount
    },
    config: cfg,
    commands: commands,
    scriptsIndex: index,
    scripts: scripts,
    snapshots: snapshots
  };
}

function parse(text) {
  let b = null;
  try { b = JSON.parse(text); } catch (e) { return { ok: false, message: '不是合法的 JSON：' + e.message }; }
  if (!b || b.kind !== KIND) return { ok: false, message: '这不是本程序导出的数据包（缺少 kind 标记）' };
  if (!b.config) return { ok: false, message: '数据包里没有配置内容' };
  return { ok: true, bundle: b };
}

// 机器相关路径检查：换到另一台电脑时，这些绝对路径常常不存在
function checkPaths(bundle, dflt) {
  dflt = dflt || {};
  const c = bundle.config || {};
  const out = [];
  const add = function (label, key, value, fallback) {
    if (!value) return;
    out.push({ label: label, key: key, value: value, exists: exists(value), fallback: fallback || '' });
  };
  add('adb.exe 路径', 'adbPath', c.adbPath, dflt.adbPath);
  add('scrcpy 目录', 'scrcpyDir', c.scrcpyDir, dflt.scrcpyDir);
  add('EasyTier 内核', 'easytier.coreExe', c.easytier && c.easytier.coreExe, dflt.easytier && dflt.easytier.coreExe);
  add('EasyTier CLI', 'easytier.cliExe', c.easytier && c.easytier.cliExe, dflt.easytier && dflt.easytier.cliExe);
  add('EasyTier GUI 快捷方式', 'easytier.guiLnk', c.easytier && c.easytier.guiLnk, dflt.easytier && dflt.easytier.guiLnk);
  for (const t of (c.targets || [])) {
    if (t.ssh && t.ssh.keyPath) add('SSH 密钥（' + (t.name || t.id) + '）', 'target:' + t.id, t.ssh.keyPath, '');
  }
  return out;
}

// 原数据先备份到 backups/pre-import-<stamp>，再写入导入包
function apply(dataDir, bundle, opts) {
  opts = opts || {};
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupDir = path.join(dataDir, 'backups', 'pre-import-' + stamp);
  fs.mkdirSync(backupDir, { recursive: true });

  // 1) 备份现有数据
  const backed = [];
  for (const f of FILES) {
    const p = path.join(dataDir, f);
    if (exists(p)) { try { fs.copyFileSync(p, path.join(backupDir, f)); backed.push(f); } catch (e) {} }
  }
  const oldCfg = readJson(path.join(dataDir, 'config.json'), {});
  const oldScriptsDir = oldCfg.scriptsDir || path.join(dataDir, 'scripts');
  // 备份本机现有的全部 .sh —— 导入时会把不在包里的脚本删掉，所以必须全备
  try {
    for (const f of fs.readdirSync(oldScriptsDir)) {
      if (!/\.(sh|bash)$/i.test(f)) continue;
      const p = path.join(oldScriptsDir, f);
      if (exists(p)) { try { fs.copyFileSync(p, path.join(backupDir, 'script-' + f)); backed.push('script-' + f); } catch (e) {} }
    }
  } catch (e) {}

  // 2) 配置：脚本/备份目录强制指向本机；可选修正机器相关路径
  const cfg = JSON.parse(JSON.stringify(bundle.config || {}));
  const fixed = [];
  if (opts.fixPaths) {
    const defaults = opts.defaults || {};
    for (const chk of checkPaths(bundle, defaults)) {
      if (chk.exists || !chk.fallback) continue;
      if (chk.key === 'adbPath') cfg.adbPath = chk.fallback;
      else if (chk.key === 'scrcpyDir') cfg.scrcpyDir = chk.fallback;
      else if (chk.key === 'easytier.coreExe') cfg.easytier.coreExe = chk.fallback;
      else if (chk.key === 'easytier.cliExe') cfg.easytier.cliExe = chk.fallback;
      else if (chk.key === 'easytier.guiLnk') cfg.easytier.guiLnk = chk.fallback;
      else continue;
      fixed.push(chk.label + '：' + chk.value + ' → ' + chk.fallback);
    }
  }
  cfg.scriptsDir = path.join(dataDir, 'scripts');
  cfg.backupsDir = path.join(dataDir, 'backups');
  fs.mkdirSync(cfg.scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');

  // 3) 命令库
  if (bundle.commands) fs.writeFileSync(path.join(dataDir, 'commands.json'), JSON.stringify(bundle.commands, null, 2), 'utf8');

  // 4) 脚本：写入导入包里的 .sh，清掉本机多出来的 .sh
  const keep = {};
  for (const s of (bundle.scripts || [])) {
    const file = (s.meta && s.meta.file) || '';
    if (!file) continue;
    keep[file] = 1;
    fs.writeFileSync(path.join(cfg.scriptsDir, file), s.content == null ? '' : String(s.content), 'utf8');
  }
  try {
    for (const f of fs.readdirSync(cfg.scriptsDir)) {
      if (/\.(sh|bash)$/i.test(f) && !keep[f]) { try { fs.unlinkSync(path.join(cfg.scriptsDir, f)); } catch (e) {} }
    }
  } catch (e) {}

  // 5) 脚本索引 + 参数快照
  const index = bundle.scriptsIndex || { items: [] };
  index.items = (bundle.scripts || []).map(function (s) { return s.meta; }).filter(Boolean);
  fs.writeFileSync(path.join(dataDir, 'scripts.json'), JSON.stringify(index, null, 2), 'utf8');
  const snapPath = path.join(dataDir, 'param-snapshots.json');
  if (bundle.snapshots != null) fs.writeFileSync(snapPath, JSON.stringify(bundle.snapshots, null, 2), 'utf8');
  else { try { fs.unlinkSync(snapPath); } catch (e) {} }

  return { backupDir: backupDir, backed: backed, fixed: fixed };
}

module.exports = { KIND: KIND, VERSION: VERSION, FILES: FILES, build: build, parse: parse, checkPaths: checkPaths, apply: apply };
