#!/usr/bin/env python3
# rc_cam.py — 从 camerad 拿原始摄像头画面（VisionIPC），JPEG 后按 <长度><JPEG> 输出到 stdout
# 用法: python3 rc_cam.py <fps> <宽度> <画质> [road|wide|driver]
import sys, os, time, struct
sys.path.insert(0, '/data/openpilot')
import numpy as np, cv2

FPS = float(sys.argv[1]) if len(sys.argv) > 1 else 10.0
WID = int(sys.argv[2]) if len(sys.argv) > 2 else 640
Q   = int(sys.argv[3]) if len(sys.argv) > 3 else 70
STREAM = sys.argv[4] if len(sys.argv) > 4 else 'road'

out = sys.stdout.buffer
try:
    from msgq.visionipc import VisionIpcClient, VisionStreamType
except Exception as e:
    sys.stderr.write('import visionipc failed: %s\n' % e); sys.exit(3)

TYPES = {'road': VisionStreamType.VISION_STREAM_ROAD,
         'wide': VisionStreamType.VISION_STREAM_WIDE_ROAD,
         'driver': getattr(VisionStreamType, 'VISION_STREAM_DRIVER', VisionStreamType.VISION_STREAM_ROAD)}
st = TYPES.get(STREAM, VisionStreamType.VISION_STREAM_ROAD)

cli = VisionIpcClient("camerad", st, True)
if not cli.connect(True):
    sys.stderr.write('connect camerad failed\n'); sys.exit(4)
t0 = time.time()
while not cli.is_connected and time.time() - t0 < 8:
    time.sleep(0.05)


def nv12_to_bgr(b):
    W, H, S = int(b.width), int(b.height), int(b.stride)
    raw = np.frombuffer(bytes(b.data), dtype=np.uint8)
    need = S * H + S * (H // 2)
    if raw.size < need:
        return None
    Y = raw[:S * H].reshape((H, S))
    UV = raw[S * H:S * H + S * (H // 2)].reshape((H // 2, S // 2, 2))
    Ys = Y[:, :W]
    Us = UV[:, :W // 2, 0]
    Vs = UV[:, :W // 2, 1]
    if WID and WID < W:
        step = max(1, int(round(W / float(WID))))
        Ys = Ys[::step, ::step]
        Us = Us[::step, ::step]
        Vs = Vs[::step, ::step]
    h2 = (Ys.shape[0] // 2) * 2
    w2 = (Ys.shape[1] // 2) * 2
    Ys = Ys[:h2, :w2]
    Us = Us[:h2 // 2, :w2 // 2]
    Vs = Vs[:h2 // 2, :w2 // 2]
    nv = np.vstack((Ys, np.dstack((Us, Vs)).reshape(h2 // 2, w2)))
    return cv2.cvtColor(nv, cv2.COLOR_YUV2BGR_NV12)


sys.stderr.write('rc_cam ready stream=%s wid=%d q=%d\n' % (STREAM, WID, Q)); sys.stderr.flush()
while True:
    t = time.time()
    try:
        b = cli.recv()
    except Exception:
        time.sleep(0.05); continue
    if b is None:
        time.sleep(0.02); continue
    try:
        bgr = nv12_to_bgr(b)
    except Exception:
        bgr = None
    if bgr is not None:
        ok, jpg = cv2.imencode('.jpg', bgr, [cv2.IMWRITE_JPEG_QUALITY, Q])
        if ok:
            d = jpg.tobytes()
            out.write(struct.pack('<I', len(d)))
            out.write(d)
            out.flush()
    dt = (1.0 / FPS) - (time.time() - t)
    if dt > 0:
        time.sleep(dt)
