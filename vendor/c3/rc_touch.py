#!/usr/bin/env python3
# rc_touch.py - 往 C3 的触摸屏设备注入触点（stdin 收命令）
import os, sys, struct, time, fcntl, array

DEV = os.environ.get('RC_TOUCH_DEV', '/dev/input/event2')
EV_SYN, EV_KEY, EV_ABS = 0, 1, 3
SYN_REPORT = 0
BTN_TOUCH = 0x14a
ABS_MT_SLOT = 0x2f
ABS_MT_POSITION_X = 0x35
ABS_MT_POSITION_Y = 0x36
ABS_MT_TRACKING_ID = 0x39
ABS_MT_PRESSURE = 0x3a

def log(*a):
    print(*a); sys.stdout.flush()

fd = os.open(DEV, os.O_WRONLY | os.O_NONBLOCK)

def get_abs(code):
    buf = array.array('i', [0] * 6)
    try:
        fcntl.ioctl(fd, 0x80184540 + code, buf, True)
    except Exception:
        return (0, 0)
    return (buf[1], buf[2])

xmin, xmax = get_abs(ABS_MT_POSITION_X)
ymin, ymax = get_abs(ABS_MT_POSITION_Y)
log("DEV=%s x=%d..%d y=%d..%d" % (DEV, xmin, xmax, ymin, ymax))

def emit(t, c, v):
    os.write(fd, struct.pack('llHHi', 0, 0, t, c, v))

def syn():
    emit(EV_SYN, SYN_REPORT, 0)

def raw(u, v):
    # u: 屏幕横向比例, v: 纵向比例；面板是竖屏，默认按 90 度旋转映射
    x = int(xmin + v * (xmax - xmin))
    y = int(ymin + (1.0 - u) * (ymax - ymin))
    return x, y

def touch_down(u, v):
    x, y = raw(u, v)
    emit(EV_ABS, ABS_MT_SLOT, 0)
    emit(EV_ABS, ABS_MT_TRACKING_ID, 1)
    emit(EV_ABS, ABS_MT_POSITION_X, x)
    emit(EV_ABS, ABS_MT_POSITION_Y, y)
    emit(EV_ABS, ABS_MT_PRESSURE, 128)
    emit(EV_KEY, BTN_TOUCH, 1)
    syn()

def touch_move(u, v):
    x, y = raw(u, v)
    emit(EV_ABS, ABS_MT_POSITION_X, x)
    emit(EV_ABS, ABS_MT_POSITION_Y, y)
    syn()

def touch_up():
    emit(EV_ABS, ABS_MT_SLOT, 0)
    emit(EV_ABS, ABS_MT_TRACKING_ID, -1)
    emit(EV_KEY, BTN_TOUCH, 0)
    syn()

log("READY")
down = False
for line in sys.stdin:
    p = line.strip().split()
    if not p:
        continue
    cmd = p[0]
    try:
        if cmd == 'tap' and len(p) >= 3:
            u, v = float(p[1]), float(p[2])
            touch_down(u, v); time.sleep(0.06); touch_up()
            log("OK tap %.3f %.3f" % (u, v))
        elif cmd == 'down' and len(p) >= 3:
            touch_down(float(p[1]), float(p[2])); down = True; log("OK down")
        elif cmd == 'move' and len(p) >= 3:
            touch_move(float(p[1]), float(p[2])); log("OK move")
        elif cmd == 'up':
            touch_up(); down = False; log("OK up")
        elif cmd == 'swipe' and len(p) >= 5:
            u1, v1, u2, v2 = map(float, p[1:5])
            touch_down(u1, v1)
            steps = 8
            for i in range(1, steps + 1):
                touch_move(u1 + (u2 - u1) * i / steps, v1 + (v2 - v1) * i / steps)
                time.sleep(0.02)
            touch_up(); log("OK swipe")
        elif cmd == 'quit':
            break
        else:
            log("ERR unknown " + cmd)
    except Exception as e:
        log("ERR %s" % e)
log("BYE")