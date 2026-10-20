#!/usr/bin/env python3
# rc_h264.py v3 —— 只用标准库：从 /dev/shm/ui.rgb 读原始 RGB 帧，直接喂 ffmpeg(libx264)
# 由 ffmpeg 自己完成 rgb24 -> yuv420p（实测 C3 上 1024x512 约 19 fps），
# 这样不依赖 cv2/numpy，刷机后不会因为环境缺失而挂。
# 用法: rc_h264.py [fps] [width] [bitrate] [gop]
import os, sys, time, struct, subprocess
try:
    import signal as _sig
except Exception:
    _sig = None

UIRGB = os.environ.get('RC_UI_RGB', '/dev/shm/ui.rgb')
SHM_FLAG = '/dev/shm/ui.cast.on'
FPS = float(sys.argv[1]) if len(sys.argv) > 1 else 20.0
WID = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
BITRATE = sys.argv[3] if len(sys.argv) > 3 else '800k'
GOP = int(sys.argv[4]) if len(sys.argv) > 4 else 20

def log(*a):
    print(*a, file=sys.stderr); sys.stderr.flush()

# 自己打开投屏开关
try:
    _f = os.open(SHM_FLAG, os.O_CREAT | os.O_WRONLY, 0o666)
    os.close(_f)
except Exception as e:
    log('打开开关失败: %s' % e)

# 清掉上一轮残留的同类进程（只认 python3，绝不碰 sshd 那层 shell）
try:
    _me = os.getpid()
    _ps = subprocess.run(['ps', '-eo', 'pid,args'], capture_output=True, text=True).stdout
    for _line in _ps.splitlines()[1:]:
        _line = _line.strip()
        if not _line:
            continue
        _pid, _, _args = _line.partition(' ')
        _args = _args.strip()
        if not _pid.isdigit() or int(_pid) == _me:
            continue
        if '/tmp/rc_h264.py' not in _args:
            continue
        _first = _args.split(' ', 1)[0]
        if not (_first.endswith('python3') or _first.endswith('python')):
            continue
        try:
            os.kill(int(_pid), 9)
            log('清掉残留取流进程 %s' % _pid)
        except Exception:
            pass
except Exception:
    pass

ff = None
ff_in = None
out = sys.stdout.buffer
_restarts = []

def start_ff(w, h):
    global ff, ff_in
    if ff is not None:
        try:
            if ff.poll() is None:
                ff.kill()
            ff.wait(timeout=3)
        except Exception:
            pass
        ff = None
        ff_in = None
    _now = time.time()
    while _restarts and _now - _restarts[0] > 10.0:
        _restarts.pop(0)
    if len(_restarts) >= 3:
        log('ffmpeg 10 秒内连续失败 3 次，退出（避免空转）')
        sys.exit(4)
    _restarts.append(_now)
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error',
           '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '%dx%d' % (w, h),
           '-r', ('%g' % FPS), '-i', 'pipe:0']
    if WID != w:
        cmd += ['-vf', 'scale=%d:trunc(ow/a/2)*2,format=yuv420p' % WID]
    else:
        cmd += ['-vf', 'format=yuv420p']
    cmd += ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
            '-profile:v', 'baseline', '-level', '3.1',
            '-b:v', BITRATE, '-maxrate', BITRATE, '-bufsize', '1M',
            '-g', str(GOP), '-flush_packets', '1',
            '-bsf:v', 'h264_metadata=aud=insert',
            '-f', 'h264', 'pipe:1']
    ff = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=out, stderr=sys.stderr)
    ff_in = ff.stdin
    log('ffmpeg 启动: %dx%d -> %dpx @%gfps %s gop=%d' % (w, h, WID, FPS, BITRATE, GOP))

fd_ = -1
last = -1
n = 0
t0 = time.time()

def _cleanup(*_a):
    try:
        if ff is not None:
            if ff.poll() is None:
                ff.kill()
            ff.wait(timeout=3)
    except Exception:
        pass
    sys.exit(0)

import atexit
atexit.register(_cleanup)
for _s in ('SIGTERM', 'SIGINT', 'SIGHUP'):
    try:
        _sig.signal(getattr(_sig, _s), _cleanup)
    except Exception:
        pass

def read_frame():
    """返回 (raw_rgb_bytes, w, h, seq)；读到撕裂/不完整就返回 None"""
    global fd_
    try:
        if fd_ < 0:
            fd_ = os.open(UIRGB, os.O_RDONLY)
        head = os.pread(fd_, 16, 0)
        if len(head) < 16:
            return None
        magic, w, h, seq = struct.unpack('<IIII', head)
        if magic != 0x55494831 or w <= 0 or h <= 0 or w > 4096 or h > 4096:
            return None
        need = w * h * 3
        body = os.pread(fd_, need, 16)
        if len(body) < need:
            return None
        if os.pread(fd_, 16, 0) != head:   # 读到一半被覆盖 -> 撕裂，丢弃
            return None
        return body, w, h, seq
    except Exception:
        try:
            os.close(fd_)
        except Exception:
            pass
        fd_ = -1
        return None

log('READY')
while True:
    t_frame = time.time()
    f = read_frame()
    if f is None:
        time.sleep(0.005); continue
    body, w, h, seq = f
    if seq == last:
        time.sleep(0.003); continue
    last = seq
    if ff is None or ff.poll() is not None:
        start_ff(w, h)
    try:
        ff_in.write(body)
    except Exception as e:
        log('写 ffmpeg 失败: %s' % e)
        break
    n += 1
    if n % 60 == 0:
        log('已编码 %d 帧，%.1f fps' % (n, n / (time.time() - t0)))
    dt = (1.0 / FPS) - (time.time() - t_frame)
    if dt > 0:
        time.sleep(dt)
