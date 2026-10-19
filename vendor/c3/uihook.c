// uihook.c v4 — 安全半版（2026-10-19）
// v3 只抓「触发 swap 的那个 surface」并「最新覆盖」，结果：弹窗（Qt 对话框 = 同进程另一个 EGL surface）
// 自己 swap 一帧后立刻被主窗口每 45ms 的刷新覆盖 → 投屏里看不到弹窗。
// v4 在 v3 基础上增加：
//   1) 记录第一个 swap 的 surface 作为「主窗口」，其余 surface 视为「浮层/弹窗」
//   2) 浮层出现后 HOLD_SEC 秒内，主窗口的帧不覆盖（避免弹窗只闪一帧）
//   3) 抓浮层时，把它按 alpha 居中合成到主窗口最后一帧上（没有主窗口底图时退化为直接显示浮层）
// 线程模型不变：UI 线程只做一次 glReadPixels + 移交缓冲，缩放/翻转/写文件都在后台线程
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <pthread.h>
#include <sys/stat.h>
typedef void* EGLDisplay; typedef void* EGLSurface; typedef unsigned int EGLBoolean;
typedef unsigned int GLenum; typedef int GLint; typedef int GLsizei;
#define GL_VIEWPORT 0x0BA2
#define GL_RGBA 0x1908
#define GL_UNSIGNED_BYTE 0x1401
static EGLBoolean (*p_swap)(EGLDisplay, EGLSurface) = NULL;
static void (*p_read)(GLint,GLint,GLsizei,GLsizei,GLenum,GLenum,void*) = NULL;
static void (*p_getiv)(GLenum, GLint*) = NULL;
static int OUTW = 1024;
static double INTERVAL = 0.045;
static double HOLD_SEC = 8.0;          // 浮层最后一次 swap 后，压住主窗口多久
static const char *FLAG = "/dev/shm/ui.cast.on";
static const char *SHM  = "/dev/shm/ui.rgb";
static const char *TSF  = "/dev/shm/ui.ts";
static const char *LOG  = "/dev/shm/uihook.log";
static unsigned char *fb[2] = {NULL, NULL};
static size_t fb_cap = 0;
static int inUse[2] = {0, 0};
static int ready = -1;
static int fw = 0, fh = 0; static uint32_t fseq = 0;
static pthread_mutex_t mtx = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cvd = PTHREAD_COND_INITIALIZER;
static unsigned char *line = NULL; static size_t line_cap = 0;
static int started = 0;
static double last_t = 0; static uint32_t seq = 0;
// ---- v4 浮层状态 ----
static EGLSurface s_primary = NULL, s_overlay = NULL;
static double s_overlay_t = 0;
static unsigned char *base = NULL; static size_t base_cap = 0; static int base_w = 0, base_h = 0;
static unsigned char *ovl = NULL; static size_t ovl_cap = 0;
static int log_lines = 0;
static double now(void){ struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec + ts.tv_nsec/1e9; }

static void logf(const char *fmt, ...){
  if (log_lines > 200) return;
  int fd = open(LOG, O_WRONLY|O_CREAT|O_APPEND, 0666);
  if (fd < 0) return;
  char buf[192]; va_list ap; va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (n > 0){ if (n > (int)sizeof buf - 2) n = (int)sizeof buf - 2; buf[n++] = '\n'; if (write(fd, buf, n) < 0) {} }
  close(fd);
  log_lines++;
}

static void *worker(void *arg){
  (void)arg;
  for (;;){
    int idx, W, H; uint32_t s;
    pthread_mutex_lock(&mtx);
    while (ready < 0) pthread_cond_wait(&cvd, &mtx);
    idx = ready; ready = -1; W = fw; H = fh; s = fseq;
    pthread_mutex_unlock(&mtx);
    unsigned char *src = fb[idx];
    if (src && W > 0 && H > 0){
      int outw = OUTW; if (outw > W) outw = W;
      int outh = (int)(((long long)H * outw) / W); if (outh < 1) outh = 1;
      if (line_cap < (size_t)outw*3u){ unsigned char *nl = (unsigned char*)malloc((size_t)outw*3u); if (nl){ free(line); line = nl; line_cap = (size_t)outw*3u; } }
      double fx = (double)W/(double)outw, fy = (double)H/(double)outh;
      int fd = open(SHM, O_RDWR|O_CREAT|O_TRUNC, 0666);
      if (fd >= 0 && line){
        uint32_t hdr[4]; hdr[0]=0x55494831u; hdr[1]=(uint32_t)outw; hdr[2]=(uint32_t)outh; hdr[3]=s;
        if (write(fd, hdr, sizeof(hdr)) == (ssize_t)sizeof(hdr)){
          for (int y = 0; y < outh; y++){
            long long sy = (long long)((double)(H-1) - (double)y*fy);
            if (sy < 0) sy = 0; if (sy > H-1) sy = H-1;
            const unsigned char *row = src + (size_t)sy*(size_t)W*4u;
            for (int x = 0; x < outw; x++){
              long long sx = (long long)((double)x*fx); if (sx > W-1) sx = W-1;
              const unsigned char *p = row + (size_t)sx*4u;
              line[x*3] = p[0]; line[x*3+1] = p[1]; line[x*3+2] = p[2];
            }
            if (write(fd, line, (size_t)outw*3u) < 0) break;
          }
        }
        close(fd);
        int tf = open(TSF, O_WRONLY|O_CREAT|O_TRUNC, 0666);
        if (tf >= 0){ char b2[32]; int n = snprintf(b2, sizeof b2, "%.4f", now()); if (n > 0){ if (write(tf, b2, n) < 0) {} } close(tf); }
      }
    }
    pthread_mutex_lock(&mtx); inUse[idx] = 0; pthread_mutex_unlock(&mtx);
  }
  return NULL;
}

static void probe_once(const char *tag){
  static const char *seen[6]; static int n = 0; int i;
  for (i = 0; i < n; i++) if (seen[i] == tag) return;
  if (n >= 6) return;
  seen[n++] = tag;
  int fd = open(LOG, O_WRONLY|O_CREAT|O_APPEND, 0666);
  if (fd >= 0){ char nl = 10; write(fd, tag, strlen(tag)); write(fd, &nl, 1); close(fd); }
}

static int grab(int idx, int W, int H){
  size_t need = (size_t)W * (size_t)H * 4u;
  if (fb_cap < need) return 0;
  p_read(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, fb[idx]);
  return 1;
}

static void handoff(int idx, int W, int H){
  pthread_mutex_lock(&mtx);
  fw = W; fh = H; fseq = seq++; ready = idx;
  pthread_cond_signal(&cvd);
  pthread_mutex_unlock(&mtx);
}

static void capture(EGLSurface surf){
  if (access(FLAG, F_OK) != 0) return;
  double t = now();
  if (t - last_t <= INTERVAL) return;
  last_t = t;
  if (!p_read) p_read = (void(*)(GLint,GLint,GLsizei,GLsizei,GLenum,GLenum,void*))dlsym(RTLD_NEXT,"glReadPixels");
  if (!p_getiv) p_getiv = (void(*)(GLenum,GLint*))dlsym(RTLD_NEXT,"glGetIntegerv");
  if (!started){ started = 1; pthread_t th; pthread_create(&th, NULL, worker, NULL); }
  if (!p_read || !p_getiv) return;
  GLint vp[4] = {0,0,0,0};
  p_getiv(GL_VIEWPORT, vp);
  int W = vp[2], H = vp[3];
  if (W <= 0 || H <= 0) return;

  int is_primary;
  if (!s_primary){ s_primary = surf; is_primary = 1; logf("primary %p %dx%d", (void*)surf, W, H); }
  else if (surf == s_primary){ is_primary = 1; }
  else {
    is_primary = 0;
    if (surf != s_overlay) logf("overlay %p %dx%d", (void*)surf, W, H);
    s_overlay = surf; s_overlay_t = t;
  }
  // 浮层在位：主窗口的帧先别覆盖
  if (is_primary && s_overlay && (t - s_overlay_t) < HOLD_SEC) return;

  // 需要的缓冲：主窗口按 W*H，浮层合成按底图尺寸
  size_t need = (size_t)W * (size_t)H * 4u;
  size_t bneed = (base_w > 0 && base_h > 0) ? (size_t)base_w * (size_t)base_h * 4u : 0;
  size_t want = need > bneed ? need : bneed;
  if (fb_cap < want){
    int ncap = 2;
    unsigned char *a = (unsigned char*)malloc(want);
    unsigned char *c = (unsigned char*)malloc(want);
    if (a && c){ for (int i = 0; i < ncap; i++) free(fb[i]); fb[0] = a; fb[1] = c; fb_cap = want; }
    else { free(a); free(c); return; }
  }
  int idx = -1;
  pthread_mutex_lock(&mtx);
  if (ready < 0){ for (int i = 0; i < 2; i++){ if (!inUse[i]){ inUse[i] = 1; idx = i; break; } } }
  pthread_mutex_unlock(&mtx);
  if (idx < 0) return;

  if (is_primary){
    if (!grab(idx, W, H)){ pthread_mutex_lock(&mtx); inUse[idx] = 0; pthread_mutex_unlock(&mtx); return; }
    if (base_cap < need){ unsigned char *nb = (unsigned char*)malloc(need); if (nb){ free(base); base = nb; base_cap = need; } }
    if (base && base_cap >= need){ memcpy(base, fb[idx], need); base_w = W; base_h = H; }
    handoff(idx, W, H);
    return;
  }

  // 浮层：抓到 ovl，再合成
  if (ovl_cap < need){ unsigned char *no = (unsigned char*)malloc(need); if (no){ free(ovl); ovl = no; ovl_cap = need; } }
  if (!ovl || ovl_cap < need){ pthread_mutex_lock(&mtx); inUse[idx] = 0; pthread_mutex_unlock(&mtx); return; }
  p_read(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, ovl);
  if (!base || base_w <= 0 || base_h <= 0){
    // 没有底图：直接显示浮层本体（尺寸就是浮层的，worker 会缩放）
    if (grab(idx, W, H)) handoff(idx, W, H);
    else { pthread_mutex_lock(&mtx); inUse[idx] = 0; pthread_mutex_unlock(&mtx); }
    return;
  }
  // 有底图：拷贝底图 + 浮层按 alpha 居中合成
  memcpy(fb[idx], base, bneed);
  int ox = (base_w - W) / 2, oy = (base_h - H) / 2;
  for (int y = 0; y < H; y++){
    int by = oy + y; if (by < 0 || by >= base_h) continue;
    for (int x = 0; x < W; x++){
      int bx = ox + x; if (bx < 0 || bx >= base_w) continue;
      unsigned char *d = fb[idx] + ((size_t)by * (size_t)base_w + (size_t)bx) * 4u;
      const unsigned char *s = ovl + ((size_t)y * (size_t)W + (size_t)x) * 4u;
      unsigned a = s[3];
      if (a == 0) continue;
      if (a >= 255){ d[0]=s[0]; d[1]=s[1]; d[2]=s[2]; }
      else {
        unsigned inv = 255 - a;
        d[0] = (unsigned char)((s[0]*a + d[0]*inv) / 255);
        d[1] = (unsigned char)((s[1]*a + d[1]*inv) / 255);
        d[2] = (unsigned char)((s[2]*a + d[2]*inv) / 255);
      }
    }
  }
  handoff(idx, base_w, base_h);
}

EGLBoolean eglSwapBuffers(EGLDisplay dpy, EGLSurface surf){
  if (!p_swap) p_swap = (EGLBoolean(*)(EGLDisplay,EGLSurface))dlsym(RTLD_NEXT, "eglSwapBuffers");
  probe_once("eglSwapBuffers");
  capture(surf);
  if (!p_swap) return 1;
  return p_swap(dpy, surf);
}

EGLBoolean eglSwapBuffersWithDamageKHR(EGLDisplay dpy, EGLSurface surf, GLint *rects, GLint n_rects){
  static EGLBoolean (*p)(EGLDisplay,EGLSurface,GLint*,GLint) = NULL;
  if (!p) p = (EGLBoolean(*)(EGLDisplay,EGLSurface,GLint*,GLint))dlsym(RTLD_NEXT, "eglSwapBuffersWithDamageKHR");
  probe_once("eglSwapBuffersWithDamageKHR");
  capture(surf);
  if (!p) return eglSwapBuffers(dpy, surf);
  return p(dpy, surf, rects, n_rects);
}

EGLBoolean eglSwapBuffersWithDamageEXT(EGLDisplay dpy, EGLSurface surf, GLint *rects, GLint n_rects){
  static EGLBoolean (*p)(EGLDisplay,EGLSurface,GLint*,GLint) = NULL;
  if (!p) p = (EGLBoolean(*)(EGLDisplay,EGLSurface,GLint*,GLint))dlsym(RTLD_NEXT, "eglSwapBuffersWithDamageEXT");
  probe_once("eglSwapBuffersWithDamageEXT");
  capture(surf);
  if (!p) return eglSwapBuffers(dpy, surf);
  return p(dpy, surf, rects, n_rects);
}

void *eglGetProcAddress(const char *name){
  static void *(*real)(const char*) = NULL;
  if (!real) real = (void*(*)(const char*))dlsym(RTLD_NEXT, "eglGetProcAddress");
  if (name){
    if (!strcmp(name, "eglSwapBuffers")) return (void*)eglSwapBuffers;
    if (!strcmp(name, "eglSwapBuffersWithDamageKHR")) return (void*)eglSwapBuffersWithDamageKHR;
    if (!strcmp(name, "eglSwapBuffersWithDamageEXT")) return (void*)eglSwapBuffersWithDamageEXT;
  }
  return real ? real(name) : NULL;
}
