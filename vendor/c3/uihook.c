// uihook.c v3 — 安全半版（2026-09-24）
// 只做一件事：把「最近邻缩放打包 + 纵向翻转 + 写 /dev/shm/ui.rgb」从 UI 渲染线程挪到后台线程 ✓
// 完全不新加 GL 对象（不碰 FBO/Blit）→ 不会像 v2 那样读出黑屏 ✓
// UI 线程只做：glReadPixels 一次（原样全屏 RGBA）+ 移交缓冲指针
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
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
static void (*p_bindfb)(GLenum, unsigned int) = NULL;
static void (*p_readbuf)(GLenum) = NULL;
static int OUTW = 1024;
static double INTERVAL = 0.045;
static const char *FLAG = "/dev/shm/ui.cast.on";
static const char *SHM  = "/dev/shm/ui.rgb";
static const char *TSF  = "/dev/shm/ui.ts";
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
static double now(void){ struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec + ts.tv_nsec/1e9; }
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
  int fd = open("/dev/shm/uihook.log", O_WRONLY|O_CREAT|O_APPEND, 0666);
  if (fd >= 0){ char nl = 10; write(fd, tag, strlen(tag)); write(fd, &nl, 1); close(fd); }
}

/* 记录每个 EGLSurface 的交换次数：判断"弹窗"是不是独立窗口/表面 */
static void probe_surface(const char *tag, void *surf){
  static void *seen[8]; static unsigned long cnt[8]; static int n = 0; static unsigned long total = 0;
  int i;
  for (i = 0; i < n; i++) { if (seen[i] == surf) { cnt[i]++; break; } }
  if (i == n && n < 8) { seen[n] = surf; cnt[n] = 1; n++;
    int fd = open("/dev/shm/uihook.log", O_WRONLY|O_CREAT|O_APPEND, 0666);
    if (fd >= 0){ char b[128]; char nl = 10; int len = snprintf(b, sizeof b, "NEW %s surface=%p (count %d)", tag, surf, n);
      if (len > 0) { if (write(fd, b, len) < 0) {} } if (write(fd, &nl, 1) < 0) {} close(fd); }
  }
  total++;
  if (total % 400 == 0) {
    int fd = open("/dev/shm/uihook.log", O_WRONLY|O_CREAT|O_APPEND, 0666);
    if (fd >= 0){ char b[256]; char nl = 10; int off = 0; int k;
      off += snprintf(b+off, sizeof b-off, "SNAP %s surfaces=%d:", tag, n);
      for (k = 0; k < n && off < (int)sizeof b - 32; k++) off += snprintf(b+off, sizeof b-off, " %p=%lu", seen[k], cnt[k]);
      if (off > 0) { if (write(fd, b, off) < 0) {} }
      if (write(fd, &nl, 1) < 0) {}
      close(fd); }
  }
}

static void capture(void){
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
  size_t need = (size_t)W * (size_t)H * 4u;
  if (fb_cap < need){
    unsigned char *a = (unsigned char*)malloc(need);
    unsigned char *c = (unsigned char*)malloc(need);
    if (a && c){ for (int i = 0; i < 2; i++) free(fb[i]); fb[0] = a; fb[1] = c; fb_cap = need; }
    else { free(a); free(c); fb_cap = 0; }
  }
  if (fb_cap < need) return;
  int idx = -1;
  pthread_mutex_lock(&mtx);
  if (ready < 0){ for (int i = 0; i < 2; i++){ if (!inUse[i]){ inUse[i] = 1; idx = i; break; } } }
  pthread_mutex_unlock(&mtx);
  if (idx < 0) return;
  /* 关键：Qt 可能把自己的 FBO 留在绑定状态，那样 glReadPixels 读到的只是
     内部渲染目标（没有弹窗层）。读到之前强制绑回窗口表面。 */
  {
    GLint fbo = -1;
    if (!p_bindfb) p_bindfb = (void(*)(GLenum,unsigned int))dlsym(RTLD_NEXT, "glBindFramebuffer");
    if (!p_readbuf) p_readbuf = (void(*)(GLenum))dlsym(RTLD_NEXT, "glReadBuffer");
    if (!p_getiv) p_getiv = (void(*)(GLenum,GLint*))dlsym(RTLD_NEXT, "glGetIntegerv");
    if (p_getiv) p_getiv(0x8CA6 /*GL_FRAMEBUFFER_BINDING*/, &fbo);
    if (p_bindfb) p_bindfb(0x8D40 /*GL_FRAMEBUFFER*/, 0);
    if (p_readbuf) p_readbuf(0x0405 /*GL_BACK*/);
    /* 每 200 次记录一次当前 FBO，用来判断 Qt 有没有留非零 FBO */
    {
      static int probed = 0;
      if (probed < 6) {
        probed++;
        int fd = open("/dev/shm/uihook.log", O_WRONLY|O_CREAT|O_APPEND, 0666);
        if (fd >= 0){ char bb[128]; char nl = 10;
          int len = snprintf(bb, sizeof bb, "CAP fbo_before=%d viewport=%dx%d", fbo, W, H);
          if (len > 0) { if (write(fd, bb, len) < 0) {} }
          if (write(fd, &nl, 1) < 0) {} close(fd); }
      }
    }
  }
  p_read(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, fb[idx]);
  pthread_mutex_lock(&mtx);
  fw = W; fh = H; fseq = seq++; ready = idx;
  pthread_cond_signal(&cvd);
  pthread_mutex_unlock(&mtx);
}

EGLBoolean eglSwapBuffers(EGLDisplay dpy, EGLSurface surf){
  if (!p_swap) p_swap = (EGLBoolean(*)(EGLDisplay,EGLSurface))dlsym(RTLD_NEXT, "eglSwapBuffers");
  probe_once("eglSwapBuffers");
  probe_surface("eglSwapBuffers", (void*)surf);
  capture();
  if (!p_swap) return 1;
  return p_swap(dpy, surf);
}

EGLBoolean eglSwapBuffersWithDamageKHR(EGLDisplay dpy, EGLSurface surf, GLint *rects, GLint n_rects){
  static EGLBoolean (*p)(EGLDisplay,EGLSurface,GLint*,GLint) = NULL;
  if (!p) p = (EGLBoolean(*)(EGLDisplay,EGLSurface,GLint*,GLint))dlsym(RTLD_NEXT, "eglSwapBuffersWithDamageKHR");
  probe_once("eglSwapBuffersWithDamageKHR");
  probe_surface("eglSwapBuffersWithDamageKHR", (void*)surf);
  capture();
  if (!p) return eglSwapBuffers(dpy, surf);
  return p(dpy, surf, rects, n_rects);
}

EGLBoolean eglSwapBuffersWithDamageEXT(EGLDisplay dpy, EGLSurface surf, GLint *rects, GLint n_rects){
  static EGLBoolean (*p)(EGLDisplay,EGLSurface,GLint*,GLint) = NULL;
  if (!p) p = (EGLBoolean(*)(EGLDisplay,EGLSurface,GLint*,GLint))dlsym(RTLD_NEXT, "eglSwapBuffersWithDamageEXT");
  probe_once("eglSwapBuffersWithDamageEXT");
  probe_surface("eglSwapBuffersWithDamageEXT", (void*)surf);
  capture();
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