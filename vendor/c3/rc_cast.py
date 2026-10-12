#!/usr/bin/env python3
# rc_cast.py — 从 /dev/shm/ui.rgb（uihook.so 写出来的 RGB24）取帧，JPEG 编码后按 <长度><JPEG> 写到 stdout
import sys, os, time, struct
import numpy as np, cv2

UIRGB = os.environ.get('RC_UI_RGB', '/dev/shm/ui.rgb')
FPS = float(sys.argv[1]) if len(sys.argv) > 1 else 10.0
WID = int(sys.argv[2]) if len(sys.argv) > 2 else 640
Q = int(sys.argv[3]) if len(sys.argv) > 3 else 65

out = sys.stdout.buffer
fd = -1
last = -1
sys.stderr.write('rc_cast ready fps=%.1f wid=%d q=%d\n' % (FPS, WID, Q)); sys.stderr.flush()

while True:
    t0 = time.time()
    if fd < 0:
        try:
            fd = os.open(UIRGB, os.O_RDONLY)
        except Exception:
            time.sleep(0.2)
            continue
    try:
        head = os.pread(fd, 16, 0)
        if len(head) < 16:
            time.sleep(0.02); continue
        magic, w, h, seq = struct.unpack('<IIII', head)
        if seq == last or magic != 0x55494831 or w <= 0 or h <= 0:
            time.sleep(0.005); continue
        body = os.pread(fd, w * h * 3, 16)
        head2 = os.pread(fd, 16, 0)
        if len(body) < w * h * 3 or head2 != head:
            continue
        last = seq
    except Exception:
        try: os.close(fd)
        except Exception: pass
        fd = -1
        continue
    rgb = np.frombuffer(body, np.uint8).reshape((h, w, 3))
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    if WID and w != WID:
        nh = max(1, int(h * WID / w))
        bgr = cv2.resize(bgr, (WID, nh), interpolation=cv2.INTER_AREA)
    ok, jpg = cv2.imencode('.jpg', bgr, [cv2.IMWRITE_JPEG_QUALITY, Q])
    if ok:
        b = jpg.tobytes()
        out.write(struct.pack('<I', len(b)))
        out.write(b)
        out.flush()
    dt = (1.0 / FPS) - (time.time() - t0)
    if dt > 0:
        time.sleep(dt)
