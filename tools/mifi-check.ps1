# mifi-check.ps1 —— 移动 WiFi 一键自检（后台接口 + 签名 + ADB + root）
# 用法:
#   powershell -File tools\mifi-check.ps1
#   powershell -File tools\mifi-check.ps1 -Ip 10.126.126.3 -Port 2333 -Password admin
param(
  [string]$Ip = '10.126.126.1',
  [int]$Port = 2333,
  [string]$Password = 'admin',
  [string]$AdbAddr = '',
  [string]$AdbPath = '',
  [string]$Path = '/api/baseDeviceInfo'
)

$ErrorActionPreference = 'Continue'
if (-not $AdbAddr) { $AdbAddr = ($Ip + ':5555') }
if (-not $AdbPath) {
  $c = Join-Path (Split-Path $PSScriptRoot -Parent) 'app\远程控制台-win32-x64\adb\adb.exe'
  if (Test-Path $c) { $AdbPath = $c } else { $AdbPath = 'adb' }
}

$ok = 0; $fail = 0
function Step($name) { Write-Host ''; Write-Host ('=== ' + $name + ' ===') -ForegroundColor Cyan }
function Pass($msg) { Write-Host ('  [OK]   ' + $msg) -ForegroundColor Green; $script:ok++ }
function Fail($msg) { Write-Host ('  [FAIL] ' + $msg) -ForegroundColor Red; $script:fail++ }
function Warn($msg) { Write-Host ('  [--]   ' + $msg) -ForegroundColor Yellow }

Write-Host ''
Write-Host '移动 WiFi 自检' -ForegroundColor White
Write-Host ('  后台   http://' + $Ip + ':' + $Port)
Write-Host ('  ADB    ' + $AdbAddr)
Write-Host ('  adb    ' + $AdbPath)

# ---------- 1) 网络与端口 ----------
Step '1) 网络与端口'
$p1 = Test-Connection -ComputerName $Ip -Count 2 -Quiet -ErrorAction SilentlyContinue
if ($p1) { Pass ($Ip + ' ping 通') } else { Warn ($Ip + ' ping 不通（有些设备禁 ICMP，不代表不可用）') }
foreach ($pt in @($Port, 5555)) {
  $t = Test-NetConnection -ComputerName $Ip -Port $pt -WarningAction SilentlyContinue -InformationLevel Quiet
  if ($t) { Pass ('端口 ' + $pt + ' 开着') } else { Fail ('端口 ' + $pt + ' 不通') }
}

# ---------- 2) 后台接口（含签名计算）----------
Step '2) 后台接口鉴权'
try {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $auth = ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Password)) | ForEach-Object { $_.ToString('x2') }) -join ''
  $secret = 'minikano_kOyXz0Ciz4V7wR0IeKmJFYFQ20jd'
  $ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
  $msg = 'minikano' + 'GET' + $Path + $ts
  $hmac = New-Object System.Security.Cryptography.HMACMD5
  $hmac.Key = [Text.Encoding]::UTF8.GetBytes($secret)
  $h = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($msg))
  $half = [int]($h.Length / 2)
  $A = ($sha.ComputeHash($h[0..($half - 1)]) | ForEach-Object { $_.ToString('x2') }) -join ''
  $B = ($sha.ComputeHash($h[$half..($h.Length - 1)]) | ForEach-Object { $_.ToString('x2') }) -join ''
  $sign = ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($A + $B)) | ForEach-Object { $_.ToString('x2') }) -join ''

  $r = Invoke-RestMethod -Uri ('http://' + $Ip + ':' + $Port + $Path) -TimeoutSec 10 -Headers @{
    authorization = $auth; 'kano-t' = $ts; 'kano-sign' = $sign
  }
  $json = $r | ConvertTo-Json -Depth 5 -Compress
  Pass ('接口通了: ' + $Path)
  Write-Host ('         ' + $json.Substring(0, [Math]::Min(160, $json.Length)))
} catch {
  $code = ''
  try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
  if ($code -eq 401 -or $code -eq 403) { Fail ('鉴权失败(' + $code + ') —— 后台密码不对，或固件改了签名算法') }
  else { Fail ('接口调用失败: ' + $_.Exception.Message) }
}

# ---------- 3) ADB ----------
Step '3) ADB'
try {
  & $AdbPath connect $AdbAddr 2>&1 | Out-Null
  Start-Sleep -Seconds 2
  $devs = & $AdbPath devices 2>&1 | Out-String
  if ($devs -match ([regex]::Escape($AdbAddr) + '\s+device')) { Pass ('ADB 已连接: ' + $AdbAddr) }
  elseif ($devs -match ([regex]::Escape($AdbAddr) + '\s+offline')) { Fail 'ADB offline —— 去设备上关一下再打开 ADB 调试（授权状态坏了）' }
  elseif ($devs -match ([regex]::Escape($AdbAddr) + '\s+unauthorized')) { Fail 'ADB 未授权 —— 需要设备上点允许；不弹框的话部分设备无解' }
  else { Fail 'ADB 列表里没有这台设备' }

  $id = (& $AdbPath -s $AdbAddr shell id 2>&1 | Out-String).Trim()
  if ($id -match 'uid=') { Pass ('身份: ' + $id) } else { Fail ('shell 执行失败: ' + $id) }

  $ver = (& $AdbPath -s $AdbAddr shell getprop ro.build.version.release 2>&1 | Out-String).Trim()
  if ($ver) { Pass ('Android ' + $ver) }
} catch { Fail ('ADB 检查异常: ' + $_.Exception.Message) }

# ---------- 4) root ----------
Step '4) root 能力（决定 Root 命令台能不能用）'
try {
  $su = (& $AdbPath -s $AdbAddr shell su -c id 2>&1 | Out-String).Trim()
  if ($su -match 'uid=0') { Pass ('有 root: ' + $su) }
  elseif ($su -match 'not found') { Warn '设备上没有 su（没 root）—— 面板只读功能仍可用' }
  else { Warn ('su 被拒: ' + $su) }
} catch { Warn ('无法判断: ' + $_.Exception.Message) }

# ---------- 总结 ----------
Write-Host ''
Write-Host '================ 总结 ================' -ForegroundColor White
if ($fail -eq 0) {
  Write-Host ('  通过 ' + $ok + ' 项，失败 0 项 —— 这台设备可以接进来') -ForegroundColor Green
} else {
  Write-Host ('  通过 ' + $ok + ' 项，失败 ' + $fail + ' 项 —— 先按上面的 [FAIL] 逐条处理') -ForegroundColor Red
}
Write-Host ''
Write-Host '下一步：'
Write-Host '  - 全通过 → 在「设置」里把这台设备的地址/密码配上，就能用面板和终端了'
Write-Host '  - 想深度接入 → 看 docs/开发指南.md 写一个通道'
Write-Host ''
exit $fail
