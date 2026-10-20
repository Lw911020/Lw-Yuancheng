'use strict';
// C3 触控通道：把触摸事件注入 /dev/input/event2（Samsung Touchscreen）
const ssh = require('./ssh');

const HELPER_PATH = '/tmp/rc_touch.py';
const HELPER_SRC = "#!/usr/bin/env python3\n# rc_touch.py - 往 C3 的触摸屏设备注入触点（stdin 收命令）\nimport os, sys, struct, time, fcntl, array\n\nDEV = os.environ.get('RC_TOUCH_DEV', '/dev/input/event2')\nEV_SYN, EV_KEY, EV_ABS = 0, 1, 3\nSYN_REPORT = 0\nBTN_TOUCH = 0x14a\nABS_MT_SLOT = 0x2f\nABS_MT_POSITION_X = 0x35\nABS_MT_POSITION_Y = 0x36\nABS_MT_TRACKING_ID = 0x39\nABS_MT_PRESSURE = 0x3a\n\ndef log(*a):\n    print(*a); sys.stdout.flush()\n\nfd = os.open(DEV, os.O_WRONLY | os.O_NONBLOCK)\n\ndef get_abs(code):\n    buf = array.array('i', [0] * 6)\n    try:\n        fcntl.ioctl(fd, 0x80184540 + code, buf, True)\n    except Exception:\n        return (0, 0)\n    return (buf[1], buf[2])\n\nxmin, xmax = get_abs(ABS_MT_POSITION_X)\nymin, ymax = get_abs(ABS_MT_POSITION_Y)\nlog(\"DEV=%s x=%d..%d y=%d..%d\" % (DEV, xmin, xmax, ymin, ymax))\n\ndef emit(t, c, v):\n    os.write(fd, struct.pack('llHHi', 0, 0, t, c, v))\n\ndef syn():\n    emit(EV_SYN, SYN_REPORT, 0)\n\ndef raw(u, v):\n    # u: 屏幕横向比例, v: 纵向比例；面板是竖屏，默认按 90 度旋转映射\n    x = int(xmin + v * (xmax - xmin))\n    y = int(ymin + (1.0 - u) * (ymax - ymin))\n    return x, y\n\ndef touch_down(u, v):\n    x, y = raw(u, v)\n    emit(EV_ABS, ABS_MT_SLOT, 0)\n    emit(EV_ABS, ABS_MT_TRACKING_ID, 1)\n    emit(EV_ABS, ABS_MT_POSITION_X, x)\n    emit(EV_ABS, ABS_MT_POSITION_Y, y)\n    emit(EV_ABS, ABS_MT_PRESSURE, 128)\n    emit(EV_KEY, BTN_TOUCH, 1)\n    syn()\n\ndef touch_move(u, v):\n    x, y = raw(u, v)\n    emit(EV_ABS, ABS_MT_POSITION_X, x)\n    emit(EV_ABS, ABS_MT_POSITION_Y, y)\n    syn()\n\ndef touch_up():\n    emit(EV_ABS, ABS_MT_SLOT, 0)\n    emit(EV_ABS, ABS_MT_TRACKING_ID, -1)\n    emit(EV_KEY, BTN_TOUCH, 0)\n    syn()\n\nlog(\"READY\")\ndown = False\nfor line in sys.stdin:\n    p = line.strip().split()\n    if not p:\n        continue\n    cmd = p[0]\n    try:\n        if cmd == 'tap' and len(p) >= 3:\n            u, v = float(p[1]), float(p[2])\n            touch_down(u, v); time.sleep(0.05); touch_move(min(1.0, u + 0.004), v); time.sleep(0.10); touch_up()\n            log(\"OK tap %.3f %.3f\" % (u, v))\n        elif cmd == 'down' and len(p) >= 3:\n            touch_down(float(p[1]), float(p[2])); down = True; log(\"OK down\")\n        elif cmd == 'move' and len(p) >= 3:\n            touch_move(float(p[1]), float(p[2])); log(\"OK move\")\n        elif cmd == 'up':\n            touch_up(); down = False; log(\"OK up\")\n        elif cmd == 'swipe' and len(p) >= 5:\n            u1, v1, u2, v2 = map(float, p[1:5])\n            touch_down(u1, v1)\n            steps = 8\n            for i in range(1, steps + 1):\n                touch_move(u1 + (u2 - u1) * i / steps, v1 + (v2 - v1) * i / steps)\n                time.sleep(0.02)\n            touch_up(); log(\"OK swipe\")\n        elif cmd == 'quit':\n            break\n        else:\n            log(\"ERR unknown \" + cmd)\n    except Exception as e:\n        log(\"ERR %s\" % e)\nlog(\"BYE\")";

let session = null;

async function ensureHelper(target) {
  const need = await ssh.withSftp(target, (sftp) => new Promise((resolve) => {
    sftp.stat(HELPER_PATH, (err, st) => {
      if (!err && st && st.size === Buffer.byteLength(HELPER_SRC)) { resolve(false); return; }
      sftp.writeFile(HELPER_PATH, Buffer.from(HELPER_SRC, 'utf8'), (e2) => resolve(!e2));
    });
  }));
  return need;
}

// 打开一个常驻的触摸注入会话
function open(target, handlers) {
  return new Promise((resolve, reject) => {
    ensureHelper(target).then(() => {
      let stream = null;
      ssh.connectAny(target).then((conn) => {
        conn.exec('python3 -u ' + HELPER_PATH, (err, st) => {
          if (err) { conn.end(); reject(err); return; }
          stream = st;
          st.on('data', (d) => handlers.onData(d.toString('utf8')));
          st.stderr.on('data', (d) => handlers.onData(d.toString('utf8')));
          st.on('close', () => { conn.end(); session = null; handlers.onExit(); });
          session = {
            write: (cmd) => { try { st.write(String(cmd) + '\n'); } catch (e) { /* 忽略 */ } },
            close: () => { try { st.write('quit\n'); st.end(); } catch (e) {} try { conn.end(); } catch (e) {} }
          };
          resolve(session);
        });
      });
    }).catch((e) => { session = null; reject(e); });
  });
}

function current() { return session; }
function send(cmd) { if (session) session.write(cmd); return !!session; }
function close() { if (session) { session.close(); session = null; } }

module.exports = { open, send, close, current, HELPER_SRC, HELPER_PATH };
