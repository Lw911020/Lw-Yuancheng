'use strict';
// 统一文件操作：C3 走 SFTP（结构化属性），车机/U30 走 ADB（ls -la 解析）
const fs = require('fs');
const path = require('path');
const ssh = require('./ssh');
const adb = require('./adb');
const guard = require('../guard');

const MAX_READ = 2 * 1024 * 1024;   // 文本编辑上限 2MB

/* ---------------- 工具 ---------------- */
function normalizeRemote(p) {
  let s = String(p == null ? '' : p).trim();
  if (!s) s = '/';
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}
function joinRemote(dir, name) {
  const d = normalizeRemote(dir);
  return (d === '/' ? '' : d) + '/' + name;
}
function parentOf(p) {
  const s = normalizeRemote(p);
  if (s === '/') return '/';
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}
function permText(mode) {
  const m = mode & 0o777;
  return ((mode & 0o400) ? 'r' : '-') + ((mode & 0o200) ? 'w' : '-') + ((mode & 0o100) ? 'x' : '-') +
    ((mode & 0o040) ? 'r' : '-') + ((mode & 0o020) ? 'w' : '-') + ((mode & 0o010) ? 'x' : '-') +
    ((mode & 0o004) ? 'r' : '-') + ((mode & 0o002) ? 'w' : '-') + ((mode & 0o001) ? 'x' : '-');
}
// 危险文件操作也过红线守卫
function guardPath(action, p, cfg) {
  const probe = action + ' ' + p;
  const g = guard.scan(probe, { guard: (cfg && cfg.guard) || 'strict' });
  if (g.action === 'blocked') throw new Error('【红线拦截】' + g.label + '：' + g.reason);
  return g;
}

/* ---------------- C3：SFTP ---------------- */
async function sshList(target, dir) {
  const d = normalizeRemote(dir);
  return await ssh.withSftp(target, (sftp) => new Promise((resolve, reject) => {
    sftp.readdir(d, (err, list) => {
      if (err) { reject(new Error('读取目录失败：' + err.message)); return; }
      const items = list.map((e) => {
        const isDir = (e.attrs.mode & 0o170000) === 0o040000;
        const isLink = (e.attrs.mode & 0o170000) === 0o120000;
        return {
          name: e.filename, dir: isDir, link: isLink,
          size: e.attrs.size, mtime: e.attrs.mtime * 1000,
          perm: permText(e.attrs.mode), mode: '0' + (e.attrs.mode & 0o777).toString(8)
        };
      });
      resolve({ path: d, parent: parentOf(d), items: sortItems(items) });
    });
  }));
}

async function sshRead(target, p, maxBytes) {
  const lim = maxBytes || MAX_READ;
  const st = await ssh.withSftp(target, (sftp) => new Promise((resolve, reject) => {
    sftp.stat(p, (err, a) => err ? reject(new Error('无法读取该路径：' + err.message)) : resolve(a));
  }));
  if ((st.mode & 0o170000) === 0o040000) throw new Error('这是一个目录');
  if (st.size > lim) throw new Error('文件太大（' + st.size + ' 字节），超过 ' + lim + ' 字节上限，请先下载到本机再编辑');
  const buf = await ssh.withSftp(target, (sftp) => new Promise((resolve, reject) => {
    const chunks = [];
    const rs = sftp.createReadStream(p);
    rs.on('data', (c) => chunks.push(c));
    rs.on('end', () => resolve(Buffer.concat(chunks)));
    rs.on('error', reject);
  }));
  const binary = buf.indexOf(0) >= 0;
  return { path: p, size: st.size, binary: binary, content: binary ? '' : buf.toString('utf8'), mode: '0' + (st.mode & 0o777).toString(8) };
}

async function sshWrite(target, p, content) {
  await ssh.withSftp(target, (sftp) => new Promise((resolve, reject) => {
    sftp.writeFile(p, Buffer.from(String(content), 'utf8'), (err) => err ? reject(new Error('写入失败：' + err.message)) : resolve(true));
  }));
  return { ok: true, path: p };
}
async function sshMkdir(target, p) {
  await ssh.withSftp(target, (sftp) => new Promise((resolve, reject) => {
    sftp.mkdir(p, (err) => err ? reject(new Error('新建目录失败：' + err.message)) : resolve(true));
  }));
  return { ok: true };
}
async function sshMove(target, from, to) {
  await ssh.withSftp(target, (sftp) => new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => err ? reject(new Error('移动/重命名失败：' + err.message)) : resolve(true));
  }));
  return { ok: true };
}
async function sshRemove(target, p, recursive) {
  const st = await ssh.withSftp(target, (sftp) => new Promise((resolve, reject) => {
    sftp.lstat(p, (err, a) => err ? reject(new Error('路径不存在：' + err.message)) : resolve(a));
  }));
  const isDir = (st.mode & 0o170000) === 0o040000;
  if (isDir && !recursive) throw new Error('这是目录，删除需要勾选"递归删除"');
  await ssh.withSftp(target, (sftp) => new Promise((resolve, reject) => {
    const done = (err) => err ? reject(new Error('删除失败：' + err.message)) : resolve(true);
    if (isDir) sftp.rmdir(p, (e) => e ? reject(new Error('目录非空或删除失败：' + e.message)) : resolve(true));
    else sftp.unlink(p, done);
  }));
  return { ok: true };
}
async function sshChmod(target, p, mode) {
  await ssh.withSftp(target, (sftp) => new Promise((resolve, reject) => {
    sftp.chmod(p, parseInt(String(mode), 8), (err) => err ? reject(new Error('改权限失败：' + err.message)) : resolve(true));
  }));
  return { ok: true };
}
async function sshUpload(target, localPath, remotePath) {
  await ssh.withSftp(target, (sftp) => new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (err) => err ? reject(new Error('上传失败：' + err.message)) : resolve(true));
  }));
  return { ok: true };
}
async function sshDownload(target, remotePath, localPath) {
  const st = await ssh.withSftp(target, (sftp) => new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, a) => err ? reject(new Error('文件不存在：' + err.message)) : resolve(a));
  }));
  if ((st.mode & 0o170000) === 0o040000) throw new Error('不支持直接下载目录，请逐个下载或先在设备上打包');
  await ssh.withSftp(target, (sftp) => new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (err) => err ? reject(new Error('下载失败：' + err.message)) : resolve(true));
  }));
  return { ok: true, path: localPath, size: st.size };
}

/* ---------------- 车机 / U30：ADB ---------------- */
function parseLsLine(line) {
  const t = line.trim();
  if (!t || t.startsWith('total ')) return null;
  const m = t.match(/^([-dlbcps][rwxsStT-]{9})[+.@]?\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.*)$/);
  if (m) {
    const name = m[8];
    return {
      name: name, dir: m[1].charAt(0) === 'd', link: m[1].charAt(0) === 'l',
      size: Number(m[5]), mtime: Date.parse(m[6] + 'T' + m[7] + ':00'),
      perm: m[1].slice(1), mode: ''
    };
  }
  // 兜底：老式 ls（Jan  1 12:00）
  const m2 = t.match(/^([-dlbcps][rwxsStT-]{9})[+.@]?\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+\s+\d+\s+[\d:]+)\s+(.*)$/);
  if (m2) {
    const name = m2[8];
    return { name: name, dir: m2[1].charAt(0) === 'd', link: m2[1].charAt(0) === 'l', size: Number(m2[5]), mtime: Date.parse(m2[6]), perm: m2[1].slice(1), mode: '' };
  }
  return null;
}
function sortItems(items) {
  return items
    .filter((x) => x.name !== '.' && x.name !== '..')
    .sort((a, b) => (a.dir === b.dir) ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1));
}
async function adbList(adbPath, addr, dir) {
  const d = normalizeRemote(dir);
  const r = await adb.shellOnce(adbPath, addr, 'ls -la ' + JSON.stringify(d === '/' ? '/' : d + '/'), 30000);
  const text = (r.stdout || '') + (r.stderr || '');
  if (/unauthorized/i.test(text)) throw new Error('该设备 ADB 未授权：先在 D:\\移动WiFi\\pc-tools 里运行 install-phone-adbkey.cmd 换成手机密钥，再点「连接」');
  if (/device offline|no devices|not found/i.test(text)) throw new Error('设备不在线或 ADB 未连接：请先在「ADB 设备」面板点连接');
  if (/No such file|Permission denied|inaccessible/i.test(text)) throw new Error('读取目录失败：' + text.trim().split('\n')[0]);
  if (!r.stdout && !r.stderr) throw new Error('设备没有返回任何内容（可能未授权或已离线）');
  const items = text.split(/\r?\n/).map(parseLsLine).filter(Boolean);
  return { path: d, parent: parentOf(d), items: sortItems(items), raw: items.length ? undefined : text.slice(0, 300) };
}
async function adbRead(adbPath, addr, p, maxBytes) {
  const lim = maxBytes || MAX_READ;
  const ls = await adb.shellOnce(adbPath, addr, 'ls -la ' + JSON.stringify(p), 20000);
  const one = (ls.stdout || '').split(/\r?\n/).map(parseLsLine).filter(Boolean)[0];
  if (one && one.dir) throw new Error('这是一个目录');
  if (one && one.size > lim) throw new Error('文件太大（' + one.size + ' 字节），超过上限，请先 pull 到本机');
  const r = await adb.shellOnce(adbPath, addr, 'cat ' + JSON.stringify(p), 30000);
  const out = r.stdout || '';
  if (/No such file|Permission denied|inaccessible/i.test(out + r.stderr)) throw new Error('读取失败：' + (r.stderr || out).trim().split('\n')[0]);
  const binary = /[\x00-\x08\x0e-\x1f]/.test(out.slice(0, 2000));
  return { path: p, size: one ? one.size : out.length, binary: binary, content: binary ? '' : out, mode: one ? one.mode : '' };
}
async function adbWrite(adbPath, addr, p, content) {
  const tmp = path.join(require('os').tmpdir(), 'rc_up_' + Date.now().toString(36) + '.txt');
  fs.writeFileSync(tmp, String(content), 'utf8');
  try {
    const r = await adb.push(adbPath, addr, tmp, p);
    if (r.code !== 0) throw new Error('写入失败：' + (r.stderr || r.stdout).trim().split('\n').slice(-1)[0]);
  } finally { try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ } }
  return { ok: true, path: p };
}
async function adbMkdir(adbPath, addr, p) {
  const r = await adb.shellOnce(adbPath, addr, 'mkdir -p ' + JSON.stringify(p), 20000);
  if (r.stderr && /denied|not found/i.test(r.stderr)) throw new Error('新建目录失败：' + r.stderr.trim());
  return { ok: true };
}
async function adbMove(adbPath, addr, from, to) {
  const r = await adb.shellOnce(adbPath, addr, 'mv ' + JSON.stringify(from) + ' ' + JSON.stringify(to), 30000);
  if (r.stderr && r.stderr.trim()) throw new Error('移动失败：' + r.stderr.trim());
  return { ok: true };
}
async function adbRemove(adbPath, addr, p, recursive) {
  const cmd = recursive ? 'rm -rf ' + JSON.stringify(p) : 'rm ' + JSON.stringify(p);
  const r = await adb.shellOnce(adbPath, addr, cmd, 30000);
  if (r.stderr && r.stderr.trim()) throw new Error('删除失败：' + r.stderr.trim());
  return { ok: true };
}
async function adbChmod(adbPath, addr, p, mode) {
  const r = await adb.shellOnce(adbPath, addr, 'chmod ' + String(mode) + ' ' + JSON.stringify(p), 20000);
  if (r.stderr && r.stderr.trim()) throw new Error('改权限失败：' + r.stderr.trim());
  return { ok: true };
}

/* ---------------- 统一入口 ---------------- */
function ctx(target, cfg) {
  if (target.kind === 'ssh') return { kind: 'ssh', target: target };
  if (target.kind === 'adb' || target.adb) return { kind: 'adb', adbPath: cfg.adbPath, addr: (target.adb || {}).addr };
  throw new Error('该设备不支持文件管理：' + target.name);
}

async function list(target, cfg, dir) {
  const c = ctx(target, cfg);
  if (c.kind === 'ssh') return await sshList(target, dir);
  return await adbList(c.adbPath, c.addr, dir);
}
async function read(target, cfg, p) {
  const c = ctx(target, cfg);
  if (c.kind === 'ssh') return await sshRead(target, p);
  return await adbRead(c.adbPath, c.addr, p);
}
async function write(target, cfg, p, content) {
  const c = ctx(target, cfg);
  if (c.kind === 'ssh') return await sshWrite(target, p, content);
  return await adbWrite(c.adbPath, c.addr, p, content);
}
async function mkdir(target, cfg, p) {
  guardPath('mkdir', p, cfg);
  const c = ctx(target, cfg);
  if (c.kind === 'ssh') return await sshMkdir(target, p);
  return await adbMkdir(c.adbPath, c.addr, p);
}
async function move(target, cfg, from, to) {
  guardPath('mv', from, cfg);
  guardPath('mv', to, cfg);
  const c = ctx(target, cfg);
  if (c.kind === 'ssh') return await sshMove(target, from, to);
  return await adbMove(c.adbPath, c.addr, from, to);
}
async function remove(target, cfg, p, recursive) {
  guardPath(recursive ? 'rm -rf' : 'rm', p, cfg);
  const c = ctx(target, cfg);
  if (c.kind === 'ssh') return await sshRemove(target, p, recursive);
  return await adbRemove(c.adbPath, c.addr, p, recursive);
}
async function chmod(target, cfg, p, mode) {
  const c = ctx(target, cfg);
  if (c.kind === 'ssh') return await sshChmod(target, p, mode);
  return await adbChmod(c.adbPath, c.addr, p, mode);
}
async function upload(target, cfg, localPath, remotePath) {
  guardPath('cp', remotePath, cfg);
  const c = ctx(target, cfg);
  if (c.kind === 'ssh') return await sshUpload(target, localPath, remotePath);
  const r = await adb.push(c.adbPath, c.addr, localPath, remotePath);
  if (r.code !== 0) throw new Error('上传失败：' + (r.stderr || r.stdout).trim().split('\n').slice(-1)[0]);
  return { ok: true };
}
async function download(target, cfg, remotePath, localPath) {
  const c = ctx(target, cfg);
  if (c.kind === 'ssh') return await sshDownload(target, remotePath, localPath);
  const r = await adb.pull(c.adbPath, c.addr, remotePath, localPath);
  if (r.code !== 0) throw new Error('下载失败：' + (r.stderr || r.stdout).trim().split('\n').slice(-1)[0]);
  return { ok: true, path: localPath };
}

module.exports = { list, read, write, mkdir, move, remove, chmod, upload, download, parseLsLine, sortItems, parentOf, joinRemote };
