'use strict';
// C3 投屏通道
// 原理（参考 C3Shell 的做法）：把 uihook.so 用 LD_PRELOAD 挂进 openpilot 的 ui 进程，
// 它在 eglSwapBuffers 里调 glReadPixels 把画面（RGB24, 纵向已翻转）写到 /dev/shm/ui.rgb；
// 开关是 /dev/shm/ui.cast.on。本模块负责：装插件 / 开关 / 把帧流出来。
const fs = require('fs');
const path = require('path');
const ssh = require('./ssh');

const DSH = '/data/openpilot/.dsh';
const HOOK_SO = DSH + '/uihook.so';
const HOOK_C = DSH + '/uihook.c';
const FLAG = '/dev/shm/ui.cast.on';
const UIRGB = '/dev/shm/ui.rgb';
const PCONF = '/data/openpilot/system/manager/process_config.py';
const REMOTE_CAST = '/tmp/rc_cast.py';
const PY_CANDIDATES = ['/usr/local/venv/bin/python3', '/data/openpilot/.venv/bin/python3'];

function vendorDir() {
  const packaged = path.join(path.dirname(process.execPath), 'c3');
  if (require('fs').existsSync(path.join(packaged, 'uihook.c'))) return packaged;
  return path.join(__dirname, '..', '..', 'vendor', 'c3');
}
function vendorFile(name) {
  const p = path.join(vendorDir(), name);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

async function sh(target, cmd, timeoutMs) {
  const r = await ssh.exec(target, cmd, timeoutMs || 40000);
  return { code: r.code, out: (r.stdout || '') + (r.stderr || '') };
}

// 检查设备上的投屏环境
async function status(target) {
  const script = [
    'UI=$(pgrep -x ui | head -1)',
    'echo "UI_PID=$UI"',
    'echo "HOOK_SO=$([ -f ' + HOOK_SO + ' ] && echo 1 || echo 0)"',
    'echo "HOOK_C=$([ -f ' + HOOK_C + ' ] && echo 1 || echo 0)"',
    'echo "FLAG=$([ -f ' + FLAG + ' ] && echo 1 || echo 0)"',
    'echo "RGB=$([ -f ' + UIRGB + ' ] && echo 1 || echo 0)"',
    'if [ -n "$UI" ]; then echo "PRELOAD=$(grep -c LD_PRELOAD /proc/$UI/environ 2>/dev/null || echo 0)"; echo "INMAPS=$(grep -c uihook /proc/$UI/maps 2>/dev/null || echo 0)"; else echo "PRELOAD=0"; echo "INMAPS=0"; fi',
    'for p in ' + PY_CANDIDATES.join(' ') + '; do if [ -x "$p" ]; then echo "PY=$p"; break; fi; done'
  ].join('\n');
  const r = await sh(target, script, 25000);
  const g = (k) => { const m = r.out.match(new RegExp(k + '=(.*)')); return m ? m[1].trim() : ''; };
  return {
    hookSo: g('HOOK_SO') === '1',
    hookC: g('HOOK_C') === '1',
    flag: g('FLAG') === '1',
    rgb: g('RGB') === '1',
    uiPid: g('UI_PID'),
    preload: g('PRELOAD') !== '0' && g('PRELOAD') !== '',
    inMaps: g('INMAPS') !== '0' && g('INMAPS') !== '',
    python: g('PY'),
    raw: r.out
  };
}

// 装插件：编译 uihook.c + 改 process_config.py（自动备份 + 语法自检）
async function provision(target) {
  const steps = [];
  const st = await status(target);
  const src = vendorFile('uihook.c');
  if (!src) return { ok: false, message: '本地缺少 vendor/c3/uihook.c', steps: steps };
  // 先比对设备上的源码与本地是否一致（不一致 = 需要重装）
  let devMd5 = '';
  try {
    const rr = await sh(target, 'md5sum ' + HOOK_C + ' 2>/dev/null', 15000);
    devMd5 = ((rr.out || '').trim().split(/\s+/)[0]) || '';
  } catch (e) { devMd5 = ''; }
  const localMd5 = require('crypto').createHash('md5').update(src).digest('hex');
  const sameSrc = !!devMd5 && devMd5 === localMd5;
  if (st.hookSo && st.inMaps && sameSrc) {
    return { ok: true, message: '插件已是最新且已加载（源码一致，无需重装）', steps: steps };
  }


  await ssh.withSftp(target, (sftp) => new Promise((resolve, reject) => {
    const put = (p, buf) => new Promise((res, rej) => sftp.writeFile(p, buf, (e) => e ? rej(e) : res(true)));
    (async () => {
      await sh(target, 'mkdir -p ' + DSH, 15000);
      await put(HOOK_C, src);
      resolve(true);
    })().catch(reject);
  }));
  steps.push('已上传 uihook.c');

  const c1 = await sh(target, 'cd ' + DSH + ' && gcc -shared -fPIC -O2 -o uihook.so uihook.c -ldl -lpthread 2>&1', 180000);
  if (c1.code !== 0) return { ok: false, message: '编译失败：' + c1.out.slice(-300), steps: steps };
  steps.push('编译 uihook.so 成功');

  const cur = await sh(target, 'cat ' + PCONF, 30000);
  if (cur.out.indexOf('LD_PRELOAD') >= 0) {
    steps.push('process_config.py 已含 LD_PRELOAD，跳过');
  } else {
    const oldLine = '  NativeProcess("ui", "selfdrive/ui", ["./ui"], always_run';
    const newLine = '  NativeProcess("ui", "selfdrive/ui", ["env", "LD_PRELOAD=' + HOOK_SO + '", "./ui"], always_run';
    if (cur.out.split(oldLine).length - 1 !== 1) {
      return { ok: false, message: '在 process_config.py 里找不到唯一的 ui 行，需要人工处理', steps: steps };
    }
    const patched = cur.out.replace(oldLine, newLine);
    if (patched.indexOf('LD_PRELOAD') < 0) return { ok: false, message: '替换失败', steps: steps };
    const py = path.join(require('os').tmpdir(), 'rc_pconf_' + Date.now() + '.py');
    fs.writeFileSync(py, patched, 'utf8');
    await ssh.withSftp(target, (sftp) => new Promise((resolve, reject) => {
      sftp.fastPut(py, '/tmp/rc_pconf.py', (e) => e ? reject(e) : resolve(true));
    }));
    const c2 = await sh(target, 'cp -n ' + PCONF + ' ' + PCONF + '.dsh-bak; cp /tmp/rc_pconf.py ' + PCONF + '; python3 -c "import ast,sys; ast.parse(open(\'' + PCONF + '\').read())" && echo AST_OK', 30000);
    try { fs.unlinkSync(py); } catch (e) {}
    if (c2.out.indexOf('AST_OK') < 0) {
      await sh(target, 'cp ' + PCONF + '.dsh-bak ' + PCONF, 15000);
      return { ok: false, message: '语法自检失败，已回滚：' + c2.out.slice(-200), steps: steps };
    }
    steps.push('已改 process_config.py（备份在 .dsh-bak）');
  }

  // process_config.py 是 manager 启动时 import 进内存的：只 pkill ui 没用，
  // 拉起来还是旧配置。必须重启整个 openpilot，让 manager 重新读配置。
  const rr = await sh(target, 'sudo -n systemctl restart comma 2>&1; echo "RC=$?"', 120000);
  if (rr.out.indexOf('RC=0') >= 0) {
    steps.push('已重启 openpilot（约 30 秒，ui 会带插件重新拉起）');
  } else {
    await sh(target, 'pkill -f "selfdrive/ui" ; pkill -x ui', 15000);
    steps.push('服务重启失败，已改为只重启 ui：' + rr.out.slice(-160));
  }
  return { ok: true, message: '安装完成：openpilot 正在重启，约 30 秒后 ui 会带插件拉起', steps: steps, needWait: true };
}

async function enable(target) {
  const r = await sh(target, 'touch ' + FLAG + ' && echo OK', 15000);
  return { ok: r.out.indexOf('OK') >= 0, message: r.out.trim() };
}
async function disable(target) {
  const r = await sh(target, 'rm -f ' + FLAG + ' && echo OK', 15000);
  return { ok: r.out.indexOf('OK') >= 0, message: r.out.trim() };
}

let stream = null;
let lastTarget = null;

// 清掉设备上残留的取流脚本：pkill 的 [r] 写法可避免匹配到自己的命令行
function killRemote(target) {
  return sh(target, 'pkill -f "[r]c_cast.py" ; pkill -f "[r]c_cam.py" ; pkill -f "[r]c_h264.py" ; echo KILLED', 15000).catch(function () { return null; });
}

// 打开视频流：把 rc_cast.py 推上去，用带 cv2 的 python 跑，解析 <len><jpeg>
function start(target, opts, handlers) {
  return new Promise((resolve, reject) => {
    if (stream) { try { require('../log').info('cast', '关流'); } catch (x) {} try { stream.close(); } catch (x) {} stream = null; }
    lastTarget = target;
    const cam = !!(opts && opts.source === 'cam');       // ui = 截 UI 画面；cam = 摄像头原画（VisionIPC）
    const pyName = cam ? 'rc_cam.py' : 'rc_cast.py';
    const remote = cam ? '/tmp/rc_cam.py' : REMOTE_CAST;
    const py = vendorFile(pyName);
    if (!py) { reject(new Error('缺少 vendor/c3/' + pyName)); return; }
    const fps = String((opts && opts.fps) || 10);
    const wid = String((opts && opts.wid) || 640);
    const q = String((opts && opts.q) || (cam ? 70 : 65));
    const streamName = String((opts && opts.stream) || 'road');   // 别叫 stream，会遮蔽模块级的连接变量

    ssh.withSftp(target, (sftp) => new Promise((res, rej) => {
      sftp.writeFile(remote, py, (e) => e ? rej(e) : res(true));
    })).then(() => killRemote(target)).then(() => {
      const { Client } = require('ssh2');
      const conn = new Client();
      conn.on('ready', () => {
        const pypath = (opts && opts.python) || '/usr/local/venv/bin/python3';
        const cmd = pypath + ' -u ' + remote + ' ' + fps + ' ' + wid + ' ' + q + (cam ? (' ' + streamName) : '');
        conn.exec(cmd, (err, st) => {
          if (err) { conn.end(); reject(err); return; }
          let buf = Buffer.alloc(0);
          let count = 0;
          st.on('error', (e) => { try { handlers.onLog('[流错误] ' + (e && e.message) + '\n'); } catch (x) {} });
          st.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            while (buf.length >= 4) {
              const len = buf.readUInt32LE(0);
              if (len <= 0 || len > 8 * 1024 * 1024) { buf = Buffer.alloc(0); break; }
              if (buf.length < 4 + len) break;
              const jpg = buf.subarray(4, 4 + len);
              buf = buf.subarray(4 + len);
              count++;
              handlers.onFrame(jpg, count);
            }
          });
          st.stderr.on('data', (d) => handlers.onLog(d.toString('utf8')));
          st.on('close', () => { stream = null; conn.end(); handlers.onExit(); });
          try { require('../log').info('cast', (cam ? '摄像头原画' : 'UI画面') + ' 开流 ' + fps + 'fps/' + wid + 'px/q' + q); } catch (x) {}
          stream = {
            close: () => { try { st.close(); } catch (e) {} try { conn.end(); } catch (e) {} }
          };
          resolve({ ok: true, command: cmd });
        });
      });
      conn.on('error', (e) => { stream = null; reject(e); });
      try { conn.connect(ssh.connOptions(target)); } catch (e) { reject(e); }
    }).catch(reject);
  });
}

function stop() {
  if (stream) {
    try { require('../log').info('cast', '关流'); } catch (e) {}
    try { stream.close(); } catch (e) {} stream = null;
  }
  const t = lastTarget;
  if (!t) return { ok: true };
  // 关流时必须把设备上那个取流脚本也杀掉，并撤掉 /dev/shm/ui.cast.on。
  // 否则每开一次投屏就在 C3 上留一个吃 40% CPU 的孤儿进程，越用越卡。
  return sh(t, 'pkill -f "[r]c_cast.py" ; pkill -f "[r]c_cam.py" ; rm -f ' + FLAG + ' ; echo OK', 15000)
    .then(function () { return { ok: true }; })
    .catch(function () { return { ok: true }; });
}

// ---------- H.264 模式：设备端跑 rc_h264.py 输出 Annex-B，渲染层用 WebCodecs 解码 ----------
let h264 = null;

function startH264(target, opts, handlers) {
  return new Promise((resolve, reject) => {
    // 只关本地这条流；设备端的残留由 rc_h264.py 启动时自己清（排除自身），
    // 这样开流只需「推脚本(可选) + 一次 exec」，少一次 SSH 往返（实测省 ~2s）
    const cleanup = Promise.resolve(closeH264Local());
    const T0 = Date.now();
    lastTarget = target;
    const py = vendorFile('rc_h264.py');
    if (!py) { reject(new Error('缺少 vendor/c3/rc_h264.py')); return; }
    const remote = '/tmp/rc_h264.py';
    const fps = String((opts && opts.fps) || 20);
    const wid = String((opts && opts.wid) || 1024);
    const br = String((opts && opts.bitrate) || '800k');
    const gop = String((opts && opts.gop) || 20);
    // 脚本内容直接内联进命令：设备一重启 /tmp 就被清空（tmpfs），内联写法每次都能自愈，
    // 而且省掉一次 SFTP 握手。脚本自己会开 /dev/shm/ui.cast.on、自己清残留进程。
    const b64 = py.toString('base64');
    const prep = Promise.resolve(cleanup);
    prep.then(() => {
      try { require('../log').info('cast', 'H.264 准备完成 ' + (Date.now() - T0) + 'ms' + ('（脚本内联下发）')); } catch (x) {}
      const { Client } = require('ssh2');
      const conn = new Client();
      conn.on('ready', () => {
        const pypath = (opts && opts.python) || '/usr/local/venv/bin/python3';
        const cmd = 'echo ' + b64 + ' | base64 -d > ' + remote + ' && chmod 700 ' + remote +
                    ' && exec ' + pypath + ' -u ' + remote + ' ' + fps + ' ' + wid + ' ' + br + ' ' + gop;
        conn.exec(cmd, (err, st) => {
          if (err) { conn.end(); reject(err); return; }
          st.on('error', (e) => { try { handlers.onLog('[H.264 流错误] ' + (e && e.message) + '\n'); } catch (x) {} });
          try { require('../log').info('cast', 'H.264 起流 ' + (Date.now() - T0) + 'ms'); } catch (x) {}
          let firstData = true;
          st.on('data', (d) => {
            if (firstData) { firstData = false; try { require('../log').info('cast', 'H.264 首块数据 ' + (Date.now() - T0) + 'ms'); } catch (x) {} }
            try { handlers.onChunk(d); } catch (x) {}
          });
          st.stderr.on('data', (d) => { try { handlers.onLog(d.toString('utf8')); } catch (x) {} });
          st.on('close', () => { h264 = null; conn.end(); try { handlers.onExit(); } catch (x) {} });
          try { require('../log').info('cast', 'H.264 开流 ' + fps + 'fps/' + wid + 'px/' + br + ' gop' + gop); } catch (x) {}
          h264 = { close: () => { try { st.close(); } catch (e) {} try { conn.end(); } catch (e) {} } };
          resolve({ ok: true, command: cmd });
        });
      });
      conn.on('error', (e) => { h264 = null; reject(e); });
      try { conn.connect(ssh.connOptions(target)); } catch (e) { reject(e); }
    }).catch(reject);
  });
}

function closeH264Local() {
  if (h264) {
    try { require('../log').info('cast', 'H.264 关流'); } catch (e) {}
    try { h264.close(); } catch (e) {}
    h264 = null;
  }
}

function stopH264() {
  closeH264Local();
  const t = lastTarget;
  if (!t) return { ok: true };
  return sh(t, 'pkill -f "[r]c_h264.py" ; pkill -f "[r]c_cast.py" ; rm -f ' + FLAG + ' ; echo OK', 15000)
    .then(function () { return { ok: true }; })
    .catch(function () { return { ok: true }; });
}

module.exports = { status, provision, enable, disable, start, stop, startH264, stopH264, vendorDir };
