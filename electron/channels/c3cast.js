'use strict';
// C3 投屏通道
// 原理（参考 C3Shell 的做法）：把 uihook.so 用 LD_PRELOAD 挂进 openpilot 的 ui 进程，
// 它在 eglSwapBuffers 里调 glReadPixels 把画面（RGB24, 纵向已翻转）写到 /dev/shm/ui.rgb；
// 开关是 /dev/shm/ui.cast.on。本模块负责：装钩子 / 开关 / 把帧流出来。
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

// 装钩子：编译 uihook.c + 改 process_config.py（自动备份 + 语法自检）
async function provision(target) {
  const steps = [];
  const st = await status(target);
  if (st.hookSo && st.inMaps) return { ok: true, message: '钩子已装好且已加载', steps: steps };

  const src = vendorFile('uihook.c');
  if (!src) return { ok: false, message: '本地缺少 vendor/c3/uihook.c', steps: steps };

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

  // 让管理器重启 ui
  await sh(target, 'pkill -f "selfdrive/ui" ; pkill -x ui', 15000);
  steps.push('已请求重启 ui（管理器会在几秒内拉起并加载钩子）');
  return { ok: true, message: '安装完成，等 10 秒左右 ui 会自动重启并加载钩子', steps: steps, needWait: true };
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

// 打开视频流：把 rc_cast.py 推上去，用带 cv2 的 python 跑，解析 <len><jpeg>
function start(target, opts, handlers) {
  return new Promise((resolve, reject) => {
    stop();
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
    })).then(() => {
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
  return { ok: true };
}

module.exports = { status, provision, enable, disable, start, stop, vendorDir };
