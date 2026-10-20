# 远程控制台 (Remote Console)

> 一台 Windows 电脑，同时管理 **U30 Air 随身 WiFi**、**C3 (comma three / openpilot)**、**BYD DiLink 车机** —— 经 EasyTier 异网组网，无需同一局域网。

![版本](https://img.shields.io/badge/version-0.8.10-blue) ![平台](https://img.shields.io/badge/platform-Windows%20x64-lightgrey) ![许可](https://img.shields.io/badge/license-MIT-green)
![CI](https://github.com/Lw911020/Lw-Yuancheng/actions/workflows/ci.yml/badge.svg)

---

## 获取

```bash
git clone git@github.com:Lw911020/Lw-Yuancheng.git
cd Lw-Yuancheng
npm install && npm start          # 开发模式
node recon/pack.mjs app           # 打包（产物在 app/）
```

想**直接用**（不装 Node）：到 [Releases](https://github.com/Lw911020/Lw-Yuancheng/releases) 下载 Windows 压缩包，解压双击即可。

---

## 这是什么

一个**便携式桌面控制台**（解压即用，不装不写注册表），把三台设备的日常运维集中到一个界面：

| 设备 | 接入方式 | 能做什么 |
|---|---|---|
| **U30 Air 随身 WiFi** | WiFi 后台接口 + 网络 ADB | 终端（含 root 命令台）、文件管理、UFI-TOOLS 面板（电量/流量/信号/存储）、令牌检查 |
| **C3 (comma three)** | SSH | **投屏（可触控）**、**参数面板（364 项 / 209 个中文说明）**、终端、文件管理、服务窗口 |
| **BYD DiLink 车机** | 网络 ADB | **投屏（画面可直接点击操作车机）**、终端、文件管理 |

组网用内置的 **EasyTier**，程序自己拉起隧道内核，跨网络把三台设备变成"一个虚拟局域网"。

---

## 硬件选择与要求

> **核心原则：跟型号无关，取决于「有可编程接口」+「能开高级权限」两条。**
> 只要满足，原则上**任何带插件/扩展能力、或能开 ADB 的随身 WiFi 都能接进来**。
> 详细判定方法和自查清单见 [docs/硬件选型与要求.md](docs/硬件选型与要求.md)
> **接入新设备的完整调试流程 + 一键自检脚本**见 [docs/移动WiFi接入与调试.md](docs/移动WiFi接入与调试.md)

### 一、随身 WiFi：必须是 **中兴 U30 Air**

**为什么指定这一款**：本项目的随身 WiFi 能力**完全依赖 UFI-TOOLS 后台接口**，而 U30 Air 是验证过的型号。

| 要求 | 说明 |
|---|---|
| **型号** | 中兴 **U30 Air**（不是 U30 Pro、不是其它随身 WiFi） |
| **后台固件** | 带 **UFI-TOOLS**，实测 **3.8.0**（旧版接口可能不同） |
| **后台端口** | TCP **2333** |
| **网络 ADB** | 必须能打开（Android 13，ADB 端口 **5555**） |
| **数据卡** | 小鲸卡或任意能上网的卡（**本项目不会动卡、不换卡**） |
| **默认口令** | 未改过则用 `admin` |

**接口鉴权（逆向所得，供排错用）**：

```
authorization = sha256hex(后台密码)              # 默认 admin
kano-t        = 任意数字串
kano-sign     = HmacSignature(
                  secret = "minikano_kOyXz0Ciz4V7wR0IeKmJFYFQ20jd",
                  msg    = "minikano" + METHOD + path + timestamp)
  其中 HmacSignature = HMAC-MD5 → 结果对半切 → 两半各 sha256 → sha256(前半 || 后半) 十六进制
```

拿到后台会话后，`POST /api/root_shell` 可执行 **root 命令**（这就是"Root 台"按钮的原理）。

### 二、C3 (comma three)

| 要求 | 说明 |
|---|---|
| 系统 | AGNOS（实测 12.8，内核 4.9.103 aarch64） |
| openpilot | 官方 / SunnyPilot / FrogPilot / **CarrotPilot** 等分支都可（实测 Carrot2-v9 + FrogPilot 合并版） |
| SSH | 开放，密码或密钥登录（推荐密钥） |
| 权限 | 有 `sudo`（免密） |
| 投屏额外要求 | root 可写 `/data/openpilot`（要改 `process_config.py` 挂 LD_PRELOAD 插件） |

**投屏原理**（不怕显卡压缩格式的关键）：把一个 `.so` 用 `LD_PRELOAD` 挂进 openpilot 的 **ui 进程**，它在 `eglSwapBuffers` 里直接 `glReadPixels` 读自己的帧缓冲，写成 RGB24 到 `/dev/shm/ui.rgb`。**在 GL 上下文内部读，格式天生线性** —— 这是"进程外读 DRM 扫描输出"走不通的根本原因。

### 三、BYD DiLink 车机

| 要求 | 说明 |
|---|---|
| 车型 | BYD DiLink 3.0（实测 Android 10） |
| 网络 ADB | 开发者选项里打开，端口 **5555** |
| root | **不需要**（投屏用 `screencap`，操作车机用 `input tap`） |

> ⚠️ 车机**摄像头实时取流**目前走不通（Magisk 禁 shell 提权 + BYD 相机服务有 `isThirdPartyApp` 白名单）。调查结论见 [docs/车机摄像头调查.md](docs/车机摄像头调查.md)。

### 四、电脑

- **Windows 10/11 x64**
- 首次启动需要**同意一次 UAC**（EasyTier 创建虚拟网卡）
- 不需要装 Node.js / Python / adb（都内置了）

---

## 快速开始

> 详细步骤见 [docs/部署流程.md](docs/部署流程.md)

### 1. 准备

- 电脑能上网（WiFi 或有线都行）
- U30 Air 通电、能上网，记下它的**后台密码**
- C3 通电、能 SSH
- 车机通电、开了网络 ADB

### 2. 解压运行

```
远程控制台-v0.8.10-win64.zip
  └─ 远程控制台-win32-x64/
       └─ 远程控制台.exe      ← 双击
```

首次启动会弹一次 **UAC**，点是（创建虚拟网卡、拉起 EasyTier 内核）。程序会**自动建隧道**，把三台设备拉进同一个虚拟网段。

> 内置的 adb 和 C3 私钥在 `adb/` 和 `c3-keys/`，**启动时会自动接管配置** —— 换电脑、换路径都不用改设置。

### 3. 三步走通

```
① 顶栏「总览」→ 看 4 张卡（隧道 / U30 / C3 / 车机）是不是都"在线"
② 有掉线的 → 点「重连 ADB」，或点卡片进该设备面板排查
③ 全绿之后：进各设备面板用投屏 / 终端 / 参数
```

### 4. 日常入口

```
顶栏    总览 · 隧道 · 主题 · 设置
侧栏    文件管理 · 命令库 · 脚本库 · ADB 设备 · 巡检报告 · 运行日志 · 关于
设备卡  终端 · 文件 · 面板        ← 每台设备的主要入口
面板里  投屏 / 参数 / 服务窗口     ← 该设备的进阶功能
```

---

## 功能清单

### C3 投屏（可触控）
- **两种画面源**：车机 UI 画面（含速度/温度/车道线） / **摄像头原画**（走 VisionIPC 拿 NV12 原始帧）
- **画面区域直接点 = 点 C3**，按住拖动 = 滑动
- 触点方向可选（实测默认 **270°**）
- 帧率 5/8/10/15 · 宽度 480~1024 · 画质可调
- 设备上没装插件时，一键安装（编译 + 改配置 + 语法自检 + 自动回滚）

### C3 参数面板
- **364 个参数**，其中 **209 个带中文名和说明**，按你车机的分组排（开始/巡航/导航/速度/调节/显示/轨迹…）
- 搜索 / 分组横向标签 / 只看已改 / 隐藏未分组
- **每行右侧直接改值**：「保存」写回车机（走官方 `Params().put()`），「默认值」回填
- **参数快照**：自由命名保存、快照之间对比差异（可忽略空值）

### 车机投屏（可操作）
- ADB `screencap` 连续抓屏（**不需要 root**），帧用 PNG 的 IEND 标记自定界
- **画面点一下 = 车机点一下**（`input tap`），拖动 = 滑动
- 常用按键：返回 / 主页 / 任务
- 看 360 全景：用车上的实体键或挡位叫出全景，镜像里直接操作机位

### 通用能力
- **终端**：真实 PTY，多标签，同设备同类型不重复开
- **文件管理**：浏览/上传/下载/删除/重命名
- **命令库**：按设备分组，一键执行 / 复制，支持备注
- **脚本库**：脚本以真实 `.sh` 文件保存，可关联设备
- **巡检报告**：8 项连通性检查，带耗时
- **运行日志**：主/渲染进程的未捕获异常（含堆栈）都落盘，界面里直接看
- **7 套主题** + 粒子动效（可关）

### 稳定性设计
- **单实例锁**：重复启动只聚焦已有窗口
- **白屏自愈**：渲染进程崩溃/卡死自动重载
- **崩溃横幅**：初始化失败时底部弹红色横幅 + 「打开运行日志」
- **打包前语法闸**：任何 js 语法不过直接拒绝打包

---

## 安全红线（重要）

本项目**内置"红线守卫"**，严格模式下**硬禁用**以下操作（防止误触导致设备被锁或失去保修）：

- 恢复出厂 / 格式化
- OTA / FOTA 升级 / 刷机
- 安装 APK（`install_apk`）
- SIM 卡相关操作（**换卡 / 换设备**）
- 破坏性命令（`rm -rf /`、`/data`、`mkfs`、`dd of=/dev`、`git clean -f`、`DROP TABLE`）

**特别注意随身 WiFi**：很多"无限流量卡"是**机卡绑定**的，换设备或换卡会触发锁卡。本项目**不提供任何规避手段**，也请不要在界面外手动尝试。

---

## 项目结构

```
ufi-console/
├─ electron/             主进程
│  ├─ main.js            窗口 / IPC / 隧道守护 / 路径接管
│  ├─ store.js           配置、命令库、脚本库（JSON + 真实 .sh 文件）
│  ├─ guard.js           红线守卫（有单元测试）
│  ├─ log.js             统一日志（按天分文件，留 7 天）
│  └─ channels/          各设备通道：ufi / ssh / adb / local / files / easytier / c3cast / c3params / carcast
├─ renderer/             界面（原生 JS，无框架）
├─ vendor/
│  ├─ easytier/          EasyTier 内核与 cli（打包用）
│  └─ c3/                C3 设备侧脚本（投屏/参数/触控）
├─ recon/                开发用：打包脚本、逆向与验证脚本、UI 测试（不入库）
├─ docs/                 文档
├─ assets/               图标
└─ CHANGELOG.md          更新日志
```

---

## 开发

```bash
npm install
npm start                 # 开发模式跑 Electron

# 打包（Windows）
node recon/pack.mjs app   # 产物在 app/远程控制台-win32-x64/
```

打包脚本会**自动检查所有 js 的语法**，不过就拒绝打包。

---

## 常见问题

**Q: 隧道起不来 / 提示需要 UAC？**
EasyTier 要创建虚拟网卡，必须提权。点"是"。内核窗口是**隐藏**的，日志在 `%APPDATA%\远程控制台\logs` 和 `~/.remote-console/easytier.log`。

**Q: 设备显示"离线"？**
先点「重连 ADB」。U30 的 ADB 是 `10.126.126.1:5555`，车机是 `192.168.0.100:5555`。车机 ADB 偶发"offline"（授权状态坏了）时，需要在车机上**关一下再打开 USB 调试**或**重启车机**。

**Q: C3 投屏黑屏？**
先看「插件是否已加载」（面板上的徽章）。没装就点「安装插件」。装了还黑，去「运行日志」看。

**Q: 改了参数车机行为变了？**
参数是**真写进车机**的。改之前可以先「保存快照」，出问题再改回来。

**Q: 换电脑要改配置吗？**
不用。内置 adb 和私钥会在启动时自动接管。

---

## 许可

MIT，见 [LICENSE](LICENSE)。

> 本项目与中兴、comma.ai、比亚迪均无隶属关系。请遵守当地法规与设备保修条款使用。
