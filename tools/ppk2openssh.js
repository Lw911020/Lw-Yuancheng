#!/usr/bin/env node
// ppk2openssh.js —— 把 PuTTY 的 .ppk 私钥转成 OpenSSH/PEM（ssh2 能读的格式）
// 用法: node tools/ppk2openssh.js <输入.ppk> [输出.pem]
// 说明: 只支持未加密的 PPK v2/v3；加密的请先用 puttygen 解密。
'use strict';
const fs = require('fs');
const path = require('path');

function derLen(len) {
  if (len < 0x80) return Buffer.from([len]);
  const bytes = [];
  let x = len;
  while (x > 0) { bytes.unshift(x & 0xff); x = Math.floor(x / 256); }
  return Buffer.from([0x80 | bytes.length].concat(bytes));
}
function derInt(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return Buffer.concat([Buffer.from([0x02]), derLen(b.length), b]);
}
function readStr(buf, off) {
  const len = buf.readUInt32BE(off);
  return { data: buf.subarray(off + 4, off + 4 + len), next: off + 4 + len };
}
const toBig = (b) => { let x = 0n; for (const byte of b) x = (x << 8n) | BigInt(byte); return x; };
const toBuf = (x) => { if (x === 0n) return Buffer.from([0]); let h = x.toString(16); if (h.length % 2) h = '0' + h; return Buffer.from(h, 'hex'); };

function convert(ppkText) {
  const lines = ppkText.split(/\r?\n/);
  const getH = (k) => { const l = lines.find((x) => x.startsWith(k + ':')); return l ? l.slice(k.length + 1).trim() : ''; };
  const type = getH('PuTTY-User-Key-File-3') || getH('PuTTY-User-Key-File-2');
  if (!type) throw new Error('不是 PuTTY 私钥（找不到 PuTTY-User-Key-File-2/3 头）');
  if (type !== 'ssh-rsa') throw new Error('只支持 ssh-rsa，当前是 ' + type);
  const enc = getH('Encryption');
  if (String(enc).toLowerCase() !== 'none') throw new Error('这个 ppk 是加密的（' + enc + '），请先用 puttygen 解密导出');

  const pubLines = Number(getH('Public-Lines'));
  const privLines = Number(getH('Private-Lines'));
  if (!pubLines || !privLines) throw new Error('Public-Lines / Private-Lines 缺失');
  const sp = lines.findIndex((l) => /^Public-Lines:/.test(l)) + 1;
  const spv = lines.findIndex((l) => /^Private-Lines:/.test(l)) + 1;
  const pub = Buffer.from(lines.slice(sp, sp + pubLines).join(''), 'base64');
  const priv = Buffer.from(lines.slice(spv, spv + privLines).join(''), 'base64');

  const t = readStr(pub, 0); let off = t.next;
  const e = readStr(pub, off); off = e.next;
  const n = readStr(pub, off);
  let po = 0;
  const d = readStr(priv, po); po = d.next;
  const p = readStr(priv, po); po = p.next;
  const q = readStr(priv, po); po = q.next;
  const iqmp = readStr(priv, po);

  const D = toBig(d.data), P = toBig(p.data), Q = toBig(q.data);
  const seq = Buffer.concat([
    derInt(Buffer.from([0])), derInt(n.data), derInt(e.data), derInt(d.data),
    derInt(p.data), derInt(q.data), derInt(toBuf(D % (P - 1n))), derInt(toBuf(D % (Q - 1n))), derInt(iqmp.data)
  ]);
  const der = Buffer.concat([Buffer.from([0x30]), derLen(seq.length), seq]);
  return {
    pem: '-----BEGIN RSA PRIVATE KEY-----\n' + der.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END RSA PRIVATE KEY-----\n',
    bits: n.data.length * 8,
    publicKey: 'ssh-rsa ' + pub.toString('base64') + ' ' + (getH('Comment') || '')
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args.length) { console.error('用法: node tools/ppk2openssh.js <输入.ppk> [输出.pem]'); process.exit(1); }
  const src = args[0];
  const dst = args[1] || src.replace(/\.ppk$/i, '') + '_openssh.pem';
  const r = convert(fs.readFileSync(src, 'utf8'));
  fs.writeFileSync(dst, r.pem, 'utf8');
  console.log('已转换: ' + src + ' -> ' + dst + '（' + r.bits + ' bit）');
  console.log('公钥（可加到设备 authorized_keys）:\n' + r.publicKey);
}

module.exports = { convert };
