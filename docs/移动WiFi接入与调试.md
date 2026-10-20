# 移动 WiFi 接入与调试

## 零、先纠正一个说法：**本项目的移动 WiFi 侧是"零安装"的**

先说清楚，免得你去找一个不存在的"插件安装"：

| 用到的能力 | 是"装上去的"吗 | 说明 |
|---|---|---|
| 面板（电量/流量/信号/存储/温度） | ❌ 设备**自带** | UFI-TOOLS 的 REST 接口，出厂就有 |
| **Root 命令台** | ❌ 设备**自带** | `POST /api/root_shell`，是后台自己的功能 |
| 终端 / 文件管理 | ❌ 系统**自带** | 只要把**网络 ADB** 打开就行 |
| 令牌需求检查 | ❌ 设备**自带** | 部分固件没这个接口 |

**结论：U30 Air 这类设备，你什么都不用装。** 程序做的是"用设备已有的接口"，不是"往设备里塞东西"。

> 对比一下：**C3 才是需要装东西的** —— 投屏要往里面装一个 LD_PRELOAD 插件（`.so`），那个有「**安装插件**」按钮，一键搞定（编译 → 改配置 → 语法自检 → 回滚）。

---

## 一、什么情况下才需要"装东西"

按 [硬件选型与要求](硬件选型与要求.md) 的三类分：

| 类别 | 要不要装 | 装什么 |
|---|---|---|
| **A 类**（带插件/扩展能力，如 UFI-TOOLS） | **不用装** | 直接调它自带的接口 |
| **B 类**（能装 App 的 Android 随身 WiFi） | **要装** | 装一个"助手 App"，由它把数据吐成 HTTP 接口 |
| **C 类**（只能开 ADB） | 不用装 | 走 ADB，但拿不到厂家深度数据 |

所以"插件安装"只跟 **B 类设备**有关。

### B 类设备怎么装（举例）

```powershell
# 1) 确认能连上
adb connect <设备IP>:5555
adb shell id

# 2) 装一个助手 App（自己写的，或者现成的）
adb install -r .\mifi-helper.apk

# 3) 启动它（一般是 LAUNCHER 或 SERVICE）
adb shell monkey -p com.example.mifihelper -c android.intent.category.LAUNCHER 1

# 4) 助手 App 在设备上监听一个本地端口，供本项目取数据
#    本项目只需要在配置里加上这个地址
```

> ⚠️ **如果设备的后台本身有"插件/扩展"页**（A 类特征），优先用它 —— 那是最干净的接入方式：把你写的插件丢进去，它自己会调本地能力，你只要约定好它吐什么格式。

---

## 二、调试方法（手工验证，不依赖界面）

出问题时，**先用下面这几步确认是"接口问题"还是"程序问题"**。

### 第 1 步 · 网络通不通

```powershell
ping <设备IP>
Test-NetConnection <设备IP> -Port 2333      # 后台端口
Test-NetConnection <设备IP> -Port 5555      # ADB 端口
```

> 注意：程序里设备一般走 **EasyTier 虚拟网段**（如 `10.126.126.1`），不是你家 WiFi 的网段。先确认隧道起来了（顶栏「隧道」或「总览」的隧道卡片）。

### 第 2 步 · 后台接口通不通（含签名怎么算）

UFI-TOOLS 的接口需要三个头，算法如下（这是**逆向出来的**，排错时手算一次很有用）：

```powershell
$ip = '10.126.126.1'; $port = 2333; $pass = 'admin'
$path = '/api/baseDeviceInfo'
$secret = 'minikano_kOyXz0Ciz4V7wR0IeKmJFYFQ20jd'

# authorization = sha256hex(密码)
$sha = [System.Security.Cryptography.SHA256]::Create()
$auth = ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($pass)) | ForEach-Object { $_.ToString('x2') }) -join ''

# kano-sign = HmacSignature(secret, "minikano" + METHOD + path + timestamp)
$ts  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
$msg = 'minikano' + 'GET' + $path + $ts
$hmac = New-Object System.Security.Cryptography.HMACMD5
$hmac.Key = [Text.Encoding]::UTF8.GetBytes($secret)
$h = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($msg))
$half = $h.Length / 2
$A = ($sha.ComputeHash($h[0..($half-1)]) | ForEach-Object { $_.ToString('x2') }) -join ''
$B = ($sha.ComputeHash($h[$half..($h.Length-1)]) | ForEach-Object { $_.ToString('x2') }) -join ''
$sign = ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($A + $B)) | ForEach-Object { $_.ToString('x2') }) -join ''

$r = Invoke-RestMethod -Uri ("http://{0}:{1}{2}" -f $ip,$port,$path) -Headers @{
  authorization = $auth; 'kano-t' = $ts; 'kano-sign' = $sign
} -TimeoutSec 10
$r | ConvertTo-Json -Depth 5
```

- 返回 JSON → **接口没问题**，那问题在程序侧（去看运行日志）
- 返回 401/403 → 密码不对（或固件改了鉴权）
- 超时 → 网络/隧道问题

### 第 3 步 · ADB 通不通

```powershell
adb connect <设备IP>:5555
adb devices              # 看是不是 device（offline/unauthorized 都不行）
adb shell id             # 应该返回 uid=2000(shell)
adb shell getprop ro.build.version.release
```

- `offline` / `unauthorized` → 去设备上**关一下再打开 ADB 调试**（授权状态坏了时不弹框，只能这样）
- 连不上 → 端口没开 / 不在同一网段 / 隧道没起来

### 第 4 步 · root 能力

```powershell
adb shell su -c id
```

- `uid=0` → 这台设备的 Root 台能真正干活
- `Permission denied` → 面板还能用（只读接口），但 Root 命令台会失败

### 第 5 步 · 看程序日志

```
%APPDATA%\远程控制台\logs\app-YYYY-MM-DD.log     程序日志（含未捕获异常堆栈）
~/.remote-console/easytier.log                        隧道内核日志
```

界面里「**运行日志**」面板 → 勾「只看错误/警告」。

---

## 三、一键自检

项目带了一个自检脚本，**把上面 5 步一次跑完**：

```powershell
# 默认参数（U30 Air 的常见值）
powershell -File tools\mifi-check.ps1

# 换设备 / 换密码
powershell -File tools\mifi-check.ps1 -Ip 10.126.126.3 -Port 2333 -Password admin

# ADB 用别的地址
powershell -File tools\mifi-check.ps1 -AdbAddr 10.126.126.3:5555
```

它会逐项打印 OK / 失败原因，最后给一行总结。**接一台新设备，先跑它**，能省很多来回。

---

## 四、常见故障对照

| 现象 | 最可能的原因 | 处理 |
|---|---|---|
| 面板一直"读取中" | 后台接口超时（设备忙/掉线/隧道抖） | 跑自检脚本第 1、2 步 |
| 面板显示但数据全空 | 固件没有对应接口（老版本） | 换用该固件支持的路径 |
| 401 / 403 | 后台密码错，或固件改了签名算法 | 自检脚本第 2 步手算对比 |
| Root 台报错 | 设备没有 `root_shell` 接口，或没权限 | 自检第 4 步 |
| ADB `offline` | 授权状态坏了 | 设备上关/开一次 ADB 调试 |
| ADB `unauthorized` | 需要授权，但设备不弹框 | 部分设备无解；有的能在开发者选项里重置 |
| 隧道通但设备不可达 | 设备不在隧道的代理网段里 | 看隧道面板的「代理网段/路由」 |

---

## 五、给新设备写接入前的检查清单

接一台**没见过的**随身 WiFi，按顺序确认（详细见 [硬件选型与要求](硬件选型与要求.md)）：

1. ☐ 后台有没有可编程接口（F12 抓一个 JSON 请求）
2. ☐ 请求怎么鉴权（签名？Cookie？）
3. ☐ 能不能开 ADB，`adb shell id` 通不通
4. ☐ 有没有 root / 插件扩展能力
5. ☐ 跑一遍 `tools/mifi-check.ps1`（参数换成这台设备）

全过之后，按 [开发指南](开发指南.md) 写一个通道就能接进来。
