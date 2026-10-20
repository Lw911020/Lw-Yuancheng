#!/usr/bin/env python3
# rc_h264.py - 从 /dev/shm/ui.rgb 取帧，用 ffmpeg(libx264) 编成 fragmented MP4 写到 stdout
# 用法: rc_h264.py [fps] [width] [bitrate] [gop]
#   例: rc_h264.py 20 1024 800k 30
import os, sys, time, struct, subprocess
import numpy as np, cv2

UIRGB = os.environ.get('RC_UI_RGB', '/dev/shm/ui.rgb')
FPS = float(sys.argv[1]) if len(sys.argv) > 1 else 20.0
WID = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
BITRATE = sys.argv[3] if len(sys.argv) > 3 else '800k'
GOP = int(sys.argv[4]) if len(sys.argv) > 4 else 30

def log(*a):
    print(*a, file=sys.stderr); sys.stderr.flush()

# 自己打开投屏开关，省掉程序侧一次 SSH 往返
try:
    _f = os.open('/dev/shm/ui.cast.on', os.O_CREAT | os.O_WRONLY, 0o666)
    os.close(_f)
except Exception as _e:
    log('打开开关失败: %s' % _e)

# 清掉上一轮残留的同类进程（只认 python3，绝不碰 sshd 起的那层 shell，
# 否则会把整个 exec 会话带走、流刚起就断）
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

def ffmpeg_cmd(w, h):
    return ['ffmpeg', '-hide_banner', '-loglevel', 'error',
            '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', '%dx%d' % (w, h),
            '-r', ('%g' % FPS), '-i', 'pipe:0',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
            '-profile:v', 'baseline', '-level', '3.1',
            '-b:v', BITRATE, '-maxrate', BITRATE, '-bufsize', '1M',
            '-g', str(GOP), '-frag_duration', '100000', '-flush_packets', '1',
            '-bsf:v', 'h264_metadata=aud=insert',
            '-f', 'h264', 'pipe:1']


ff = None
ff_in = None
out = sys.stdout.buffer
os.makedirs('/dev/shm', exist_ok=True)

def start_ff(w, h):
    global ff, ff_in
    ff = subprocess.Popen(ffmpeg_cmd(w, h), stdin=subprocess.PIPE, stdout=out, stderr=sys.stderr)
    ff_in = ff.stdin
    log('ffmpeg 启动: %dx%d @%gfps %s gop=%d' % (w, h, FPS, BITRATE, GOP))

def read_frame():
    """返回 (rgb_hwc_array, w, h) 或 None；内部自己管 fd"""
    global fd_
    try:
        if fd_ < 0:
            fd_ = os.open(UIRGB, os.O_RDONLY)
        head = os.pread(fd_, 16, 0)
        if len(head) < 16:
            return None
        magic, w, h, seq = struct.unpack('<IIII', head)
        if magic != 0x55494831 or w <= 0 or h <= 0:
            return None
        body = os.pread(fd_, w*h*3, 16)
        if len(body) < w*h*3 or os.pread(fd_, 16, 0) != head:
            return None
        return np.frombuffer(body, np.uint8).reshape((h, w, 3)), w, h, seq
    except Exception:
        try: os.close(fd_)
        except Exception: pass
        fd_ = -1
        return None

fd_ = -1
last = -1
n = 0
t0 = time.time()
def _cleanup(*_a):
    try:
        if ff is not None:
            if ff.poll() is None: ff.kill()
            ff.wait(timeout=3)
    except Exception:
        pass
    sys.exit(0)
import atexit, signal as _sig
atexit.register(_cleanup)
for _s in ('SIGTERM', 'SIGINT', 'SIGHUP'):
    try: _sig.signal(getattr(_sig, _s), _cleanup)
    except Exception: pass
log('READY')

while True:
    t_frame = time.time()
    f = read_frame()
    if f is None:
        time.sleep(0.005); continue
    rgb, w, h, seq = f
    if seq == last:
        time.sleep(0.003); continue
    last = seq
    oh = max(2, (int(round(h * WID / float(w) / 2)) * 2))
    ow = WID if (WID != w) else w
    if ow != w:
        rgb = cv2.resize(rgb, (ow, oh), interpolation=cv2.INTER_AREA)
    else:
        oh = h
    yuv = cv2.cvtColor(rgb, cv2.COLOR_RGB2YUV_I420)
    if ff is None or ff.poll() is not None:
        start_ff(ow, oh)
    try:
        ff_in.write(yuv.tobytes())
    except Exception as e:
        log('写 ffmpeg 失败: %s' % e)
        break
    n += 1
    if n % 60 == 0:
        log('已编码 %d 帧，%.1f fps' % (n, n / (time.time() - t0)))
    dt = (1.0 / FPS) - (time.time() - t_frame)
    if dt > 0:
        time.sleep(dt)