'use strict';
// 车机投屏：adb exec-out screencap -p 连续抓帧（PNG 自定界，按 IEND 切帧）
const { spawn } = require('child_process');
const LOG = require('../log');
const IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
let proc = null;

function start(adbPath, serial, opts, handlers) {
  return new Promise((resolve, reject) => {
    stop();
    const fps = Math.max(0.5, Math.min(5, Number((opts && opts.fps) || 2)));
    const gap = (1 / fps).toFixed(2);
    const sh = 'while true; do screencap -p; sleep ' + gap + '; done';
    let p;
    try { p = spawn(adbPath, ['-s', serial, 'exec-out', sh], { windowsHide: true }); }
    catch (e) { reject(e); return; }
    let buf = Buffer.alloc(0), n = 0;
    p.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > 16 * 1024 * 1024) buf = buf.subarray(buf.length - 6 * 1024 * 1024);
      for (;;) {
        const i = buf.indexOf(IEND);
        if (i < 0) break;
        const frame = buf.subarray(0, i + IEND.length);
        buf = buf.subarray(i + IEND.length);
        if (frame.length > 100 && frame[0] === 0x89 && frame[1] === 0x50) { n++; handlers.onFrame(frame, n); }
      }
    });
    p.stderr.on('data', (d) => { try { handlers.onLog(d.toString('utf8')); } catch (e) {} });
    p.on('error', (e) => { try { handlers.onLog('[adb 错误] ' + e.message + '\n'); } catch (x) {} });
    p.on('close', () => { proc = null; handlers.onExit(); });
    proc = { kill: () => { try { p.kill(); } catch (e) {} } };
    LOG.info('carcast', '车机抓屏开流 ' + fps + 'fps（screencap）');
    resolve({ ok: true, fps: fps });
  });
}

function stop() {
  if (proc) { try { LOG.info('carcast', '车机关流'); } catch (e) {} try { proc.kill(); } catch (e) {} proc = null; }
  return { ok: true };
}

// 拉起车机上的 App（monkey 最省事，不用知道 Activity 名）
function launch(adbPath, serial, pkg) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(adbPath, ['-s', serial, 'shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], { windowsHide: true }); }
    catch (e) { resolve({ ok: false, message: e.message }); return; }
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => {
      const tail = String(out).trim().split('\n').filter(Boolean).pop() || ('rc=' + code);
      const ok = code === 0 && !/No activities found|Error/i.test(String(out));
      try { LOG.info('carcast', '启动 ' + pkg + ' -> ' + ok); } catch (e) {}
      resolve({ ok: ok, message: ok ? ('已启动 ' + pkg) : tail });
    });
    p.on('error', (e) => resolve({ ok: false, message: e.message }));
  });
}

// 往车机注入触摸（不需要 root）：input tap x y   —— 这样镜像画面就能直接操作车机（含 360 的机位按钮）
function shellSh(adbPath, serial, cmdStr) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(adbPath, ['-s', serial, 'shell', cmdStr], { windowsHide: true }); }
    catch (e) { resolve({ ok: false, message: e.message }); return; }
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ ok: code === 0, message: String(out).trim().slice(0, 200) }));
    p.on('error', (e) => resolve({ ok: false, message: e.message }));
  });
}
function tap(adbPath, serial, x, y) {
  return shellSh(adbPath, serial, 'input tap ' + Math.round(x) + ' ' + Math.round(y));
}
function swipe(adbPath, serial, x1, y1, x2, y2, ms) {
  return shellSh(adbPath, serial, 'input swipe ' + Math.round(x1) + ' ' + Math.round(y1) + ' '
    + Math.round(x2) + ' ' + Math.round(y2) + ' ' + (ms || 200));
}
function key(adbPath, serial, code) {
  return shellSh(adbPath, serial, 'input keyevent ' + Number(code || 4));
}

// 启动：先试具体 Activity（有些 BYD App 没有 LAUNCHER），再退回 monkey
const CANDIDATES = {
  'com.byd.auto_camera': ['com.byd.auto_camera/.MainActivity', 'com.byd.auto_camera/.AutoCameraActivity'],
  'com.byd.bydcamera': ['com.byd.bydcamera/.MainActivity', 'com.byd.bydcamera/.CameraActivity'],
  'com.byd.cameramanager': ['com.byd.cameramanager/.MainActivity']
};

async function launch2(adbPath, serial, pkg) {
  const list = (CANDIDATES[pkg] || []).map((a) => 'am start -n ' + a);
  list.push('monkey -p ' + pkg + ' -c android.intent.category.LAUNCHER 1');
  let last = '';
  for (const cmd of list) {
    const r = await shellSh(adbPath, serial, cmd);
    const bad = /No activities found|Error:|does not exist|Unable to find|monkey aborted/i.test(r.message);
    if (r.ok && !bad) {
      try { LOG.info('carcast', '启动 ' + pkg + ' 成功: ' + cmd); } catch (e) {}
      return { ok: true, message: '已启动 ' + pkg };
    }
    last = r.message || last;
  }
  return { ok: false, message: '这个 App 没有可以直接打开的界面（多半是被其它程序/信号触发的后台服务）。' +
    '可以：①用车上的实体键/语音叫出全景；②直接在下面的镜像画面上点（鼠标点=车机点）。原始信息：' + last.slice(0, 80) };
}

module.exports = { start, stop, launch: launch2, tap, swipe, key, shellSh };
