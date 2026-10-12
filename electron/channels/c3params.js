'use strict';
// C3 参数：用你原来的 params_dump.py 拿全量注册表 + 中文说明，用 rc_param_set.py 写回
const fs = require('fs');
const path = require('path');
const ssh = require('./ssh');
const c3cast = require('./c3cast');

const REMOTE_DUMP = '/tmp/rc_params_dump.py';
const REMOTE_SET = '/tmp/rc_param_set.py';
const PY = '/usr/local/venv/bin/python3';

function vendorFile(name) {
  const p = path.join(c3cast.vendorDir(), name);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

async function upload(target, name, remote) {
  const buf = vendorFile(name);
  if (!buf) throw new Error('缺少 vendor/c3/' + name + '（打包时没带上？）');
  await ssh.withSftp(target, (sftp) => new Promise((res, rej) => {
    sftp.writeFile(remote, buf, (e) => (e ? rej(e) : res(true)));
  }));
}

let cached = null;
let cachedAt = 0;

async function dump(target, force) {
  if (!force && cached && Date.now() - cachedAt < 120000) return cached;
  await upload(target, 'params_dump.py', REMOTE_DUMP);
  const r = await ssh.exec(target, PY + ' ' + REMOTE_DUMP, 180000);
  const out = (r.stdout || '').trim();
  if (!out) throw new Error('设备没有输出：' + ((r.stderr || '').slice(-200) || '（可能是 python 环境变了）'));
  let j;
  try { j = JSON.parse(out); } catch (e) {
    throw new Error('返回不是 JSON：' + out.slice(0, 160));
  }
  if (j && j.ok === false) throw new Error(j.error || '读取失败');
  cached = j;
  cachedAt = Date.now();
  return j;
}

async function setParam(target, key, value) {
  if (!key) throw new Error('参数名为空');
  await upload(target, 'rc_param_set.py', REMOTE_SET);
  const b64 = Buffer.from(String(value), 'utf8').toString('base64');
  const cmd = PY + ' ' + REMOTE_SET + " '" + String(key).replace(/'/g, "'\\''") + "' '" + b64 + "'";
  const r = await ssh.exec(target, cmd, 40000);
  const out = (r.stdout || '').trim();
  let j = null;
  try { j = JSON.parse(out); } catch (e) { j = null; }
  if (!j) throw new Error('写入没有返回结果：' + (out.slice(0, 160) || (r.stderr || '').slice(-160)));
  if (!j.ok) throw new Error(j.error || '写入失败');
  cached = null;   // 让下次读取重新拉
  return j;
}

module.exports = { dump, setParam };
