param([string]$OutDir = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = (Get-Location).Path }

$ico    = Join-Path $OutDir 'icon.ico'
$png256 = Join-Path $OutDir 'icon.png'
$png512 = Join-Path $OutDir 'icon-512.png'

Write-Output '=== [1] System.Drawing.Icon can open the .ico ==='
try {
  $icon = New-Object System.Drawing.Icon($ico)
  Write-Output ("OK   Icon default size = {0} x {1}" -f $icon.Width, $icon.Height)
  $icon.Dispose()
} catch {
  Write-Output ("FAIL " + $_.Exception.ToString())
}

Write-Output ''
Write-Output '=== [1b] ICO directory: every entry ==='
$fs = [System.IO.File]::OpenRead($ico)
$br = New-Object System.IO.BinaryReader($fs)
$res  = $br.ReadUInt16()
$type = $br.ReadUInt16()
$cnt  = $br.ReadUInt16()
Write-Output ("ICONDIR reserved={0} type={1} imageCount={2}" -f $res, $type, $cnt)
$entries = @()
for ($i = 0; $i -lt $cnt; $i++) {
  $bw = $br.ReadByte(); $bh = $br.ReadByte(); $cc = $br.ReadByte(); $rs = $br.ReadByte()
  $pl = $br.ReadUInt16(); $bc = $br.ReadUInt16(); $len = $br.ReadUInt32(); $off = $br.ReadUInt32()
  $dw = $bw; if ($bw -eq 0) { $dw = 256 }
  $dh = $bh; if ($bh -eq 0) { $dh = 256 }
  $entries += [pscustomobject]@{ W = $dw; H = $dh; Len = $len; Off = $off; BC = $bc; PL = $pl; CC = $cc }
  Write-Output ("entry[{0}] bWidth={1} bHeight={2} (=> {3}x{4}) bColorCount={5} wPlanes={6} wBitCount={7} dwBytesInRes={8} dwImageOffset={9}" -f $i, $bw, $bh, $dw, $dh, $cc, $pl, $bc, $len, $off)
}
Write-Output ''
Write-Output '=== [1c] every entry is a real PNG that decodes to its declared size ==='
foreach ($e in $entries) {
  $fs.Position = $e.Off
  $data = New-Object byte[] $e.Len
  $read = $fs.Read($data, 0, [int]$e.Len)
  $isPng = ($data[0] -eq 0x89 -and $data[1] -eq 0x50 -and $data[2] -eq 0x4E -and $data[3] -eq 0x47 -and $data[4] -eq 0x0D -and $data[5] -eq 0x0A -and $data[6] -eq 0x1A -and $data[7] -eq 0x0A)
  $ms = New-Object System.IO.MemoryStream(,$data)
  $bm = New-Object System.Drawing.Bitmap($ms)
  Write-Output ("{0}x{1}: pngSig={2} read={3}/{4} decoded={5}x{6} pixelFormat={7}" -f $e.W, $e.H, $isPng, $read, $e.Len, $bm.Width, $bm.Height, $bm.PixelFormat)
  $bm.Dispose(); $ms.Dispose()
}
$br.Dispose(); $fs.Dispose()

Write-Output ''
Write-Output '=== [2] file sizes (bytes) ==='
Get-Item -LiteralPath $ico, $png256, $png512 | ForEach-Object {
  Write-Output ("{0}  =  {1} bytes" -f $_.FullName, $_.Length)
}

Write-Output ''
Write-Output '=== [3] load PNGs / re-save 256 as preview-256.png ==='
$b256 = New-Object System.Drawing.Bitmap($png256)
$b512 = New-Object System.Drawing.Bitmap($png512)
Write-Output ("icon.png     {0}x{1} pixelFormat={2}" -f $b256.Width, $b256.Height, $b256.PixelFormat)
Write-Output ("icon-512.png {0}x{1} pixelFormat={2}" -f $b512.Width, $b512.Height, $b512.PixelFormat)
$preview = Join-Path $OutDir 'preview-256.png'
$b256.Save($preview, [System.Drawing.Imaging.ImageFormat]::Png)
$pv = New-Object System.Drawing.Bitmap($preview)
Write-Output ("preview-256.png re-saved: {0}x{1}, {2} bytes, non-empty={3}" -f $pv.Width, $pv.Height, (Get-Item -LiteralPath $preview).Length, ($pv.Width -gt 0 -and $pv.Height -gt 0))
$pv.Dispose()

$set = New-Object 'System.Collections.Generic.HashSet[string]'
for ($y = 0; $y -lt $b256.Height; $y += 2) {
  for ($x = 0; $x -lt $b256.Width; $x += 2) {
    [void]$set.Add($b256.GetPixel($x, $y).ToArgb().ToString())
  }
}
Write-Output ("distinct colours sampled in icon.png (step 2) = {0}  (not-a-flat-image: {1})" -f $set.Count, ($set.Count -gt 1))

Write-Output ''
Write-Output '=== [4] corner alpha + centre colours on the 256 image ==='
$pts = @(@(0,0), @(255,0), @(0,255), @(255,255), @(2,2), @(253,253), @(0,128), @(128,0))
foreach ($p in $pts) {
  $c = $b256.GetPixel([int]$p[0], [int]$p[1])
  Write-Output ("  ({0,3},{1,3})  A={2,3}  R={3,3} G={4,3} B={5,3}" -f $p[0], $p[1], $c.A, $c.R, $c.G, $c.B)
}
Write-Output '  --- interior probes (design coords /4) ---'
$probes = @(
  @(128,128,'centre of canvas'),
  @(83,120,'U left arm stroke'),
  @(143,120,'U right arm stroke'),
  @(112,170,'U bottom arc stroke'),
  @(128,40,'background top centre'),
  @(20,20,'background near top-left'),
  @(214,89,'outer signal arc stroke'),
  @(175,100,'between the two arcs (expect background)')
)
foreach ($p in $probes) {
  $c = $b256.GetPixel([int]$p[0], [int]$p[1])
  Write-Output ("  ({0,3},{1,3})  A={2,3}  R={3,3} G={4,3} B={5,3}   {6}" -f $p[0], $p[1], $c.A, $c.R, $c.G, $c.B, $p[2])
}
$t = 0; $tot = 0
for ($y = 0; $y -lt $b256.Height; $y += 2) {
  for ($x = 0; $x -lt $b256.Width; $x += 2) {
    $tot++
    if ($b256.GetPixel($x, $y).A -lt 8) { $t++ }
  }
}
Write-Output ("fully transparent sample fraction = {0:P2} ({1}/{2})" -f ($t/$tot), $t, $tot)

$b256.Dispose(); $b512.Dispose()
