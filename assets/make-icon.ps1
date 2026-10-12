param(
  [string]$OutDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = (Get-Location).Path }
if (-not (Test-Path -LiteralPath $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

# ---------------------------------------------------------------
# Artwork is authored on a 1024x1024 design grid, then scaled by $k.
#   background : rounded square, corner radius = 22% of the side,
#                linear gradient #12B886 -> #0B7285 (TL -> BR) + faint vignette
#   glyph "U"  : hand built GraphicsPath stroked with a 112u round-cap/round-join pen
#                outer box 330 x 380, visual centre (440, 550)
#   signal arcs: 2 concentric arcs, centre (645,585), radii 135 / 296,
#                sweep -75deg .. -12deg, same 112u round-cap pen
# ---------------------------------------------------------------

function New-RoundedPath {
  param([single]$x, [single]$y, [single]$w, [single]$h, [single]$rad)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [single]($rad * 2.0)
  $p.AddArc($x, $y, $d, $d, 180.0, 90.0)
  $p.AddArc([single]($x + $w - $d), $y, $d, $d, 270.0, 90.0)
  $p.AddArc([single]($x + $w - $d), [single]($y + $h - $d), $d, $d, 0.0, 90.0)
  $p.AddArc($x, [single]($y + $h - $d), $d, $d, 90.0, 90.0)
  $p.CloseFigure()
  return $p
}

function New-GlyphUPath {
  param([single]$k, [single]$uScale, [single]$targetCx, [single]$targetCy)
  $bcx = 440.0
  $bcy = 550.0
  $tx = [single]($targetCx - $uScale * $bcx)
  $ty = [single]($targetCy - $uScale * $bcy)
  $lx  = [single](($uScale * 331.0 + $tx) * $k)
  $rx  = [single](($uScale * 549.0 + $tx) * $k)
  $tyv = [single](($uScale * 416.0 + $ty) * $k)
  $cyv = [single](($uScale * 575.0 + $ty) * $k)
  $rad = [single]($uScale * 109.0 * $k)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddLine($lx, $tyv, $lx, $cyv)
  $p.AddArc([single]($lx - $rad), [single]($cyv - $rad), [single]($rad * 2.0), [single]($rad * 2.0), 180.0, -180.0)
  $p.AddLine($rx, $cyv, $rx, $tyv)
  return $p
}

function New-ArcPath {
  param([single]$cx, [single]$cy, [single]$r, [single]$a0, [single]$a1)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc([single]($cx - $r), [single]($cy - $r), [single]($r * 2.0), [single]($r * 2.0), $a0, [single]($a1 - $a0))
  return $p
}

function New-Pen {
  param([System.Drawing.Color]$color, [single]$width)
  $pen = New-Object System.Drawing.Pen($color, $width)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  return $pen
}

function Draw-Background {
  param([System.Drawing.Graphics]$g, [single]$S)
  $rad = [single]($S * 0.22)
  $path = New-RoundedPath 0.0 0.0 $S $S $rad
  $c1 = [System.Drawing.Color]::FromArgb(255, 0x12, 0xB8, 0x86)
  $c2 = [System.Drawing.Color]::FromArgb(255, 0x0B, 0x72, 0x85)
  $p1 = New-Object System.Drawing.PointF(0.0, 0.0)
  $p2 = New-Object System.Drawing.PointF($S, $S)
  $lg = New-Object System.Drawing.Drawing2D.LinearGradientBrush($p1, $p2, $c1, $c2)
  $g.FillPath($lg, $path)
  $lg.Dispose()

  # very light vignette: fully transparent centre -> faint black rim
  $vp = New-RoundedPath 0.0 0.0 $S $S $rad
  $pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($vp)
  $pgb.CenterPoint = New-Object System.Drawing.PointF([single]($S / 2.0), [single]($S / 2.0))
  $pgb.CenterColor = [System.Drawing.Color]::FromArgb(0, 0, 0, 0)
  $edge = [System.Drawing.Color]::FromArgb(42, 0, 0, 0)
  $n = $vp.PointCount
  $cols = New-Object 'System.Drawing.Color[]' $n
  for ($i = 0; $i -lt $n; $i++) { $cols[$i] = $edge }
  $pgb.SurroundColors = $cols
  $g.FillPath($pgb, $vp)
  $pgb.Dispose()
  $vp.Dispose()
  $path.Dispose()
}

function New-Master {
  param([int]$Size, [bool]$WithArcs, [single]$UScale, [single]$StrokeMul, [single]$TargetCx, [single]$TargetCy)

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.TextRenderingHint  = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)

  Draw-Background -g $g -S $Size

  $k = [single]($Size / 1024.0)
  $white = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)

  $upath = New-GlyphUPath -k $k -uScale $UScale -targetCx $TargetCx -targetCy $TargetCy
  $upen  = New-Pen -color $white -width ([single](112.0 * $k * $UScale * $StrokeMul))
  $g.DrawPath($upen, $upath)
  $upen.Dispose()
  $upath.Dispose()

  if ($WithArcs) {
    $acx = [single](645.0 * $k)
    $acy = [single](585.0 * $k)
    foreach ($rd in @(135.0, 296.0)) {
      $ap = New-ArcPath -cx $acx -cy $acy -r ([single]($rd * $k)) -a0 -75.0 -a1 -12.0
      $apen = New-Pen -color $white -width ([single](112.0 * $k))
      $g.DrawPath($apen, $ap)
      $apen.Dispose()
      $ap.Dispose()
    }
  }

  $g.Dispose()
  return $bmp
}

function New-Scaled {
  param([System.Drawing.Bitmap]$Src, [int]$Size)
  $dst = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.CompositingMode    = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $rect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
  $g.DrawImage($Src, $rect)
  $g.Dispose()
  return $dst
}

function ConvertTo-PngBytes {
  param([System.Drawing.Bitmap]$Bmp)
  $ms = New-Object System.IO.MemoryStream
  $Bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  return ,$bytes
}

function Write-Ico {
  param([string]$Path, [System.Drawing.Bitmap[]]$Bitmaps, [byte[][]]$Pngs)
  $n = $Pngs.Count
  $fs = [System.IO.File]::Create($Path)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([uint16]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]$n)
  $offset = 6 + 16 * $n
  for ($i = 0; $i -lt $n; $i++) {
    $sz = $Bitmaps[$i].Width
    $dim = [byte]0
    if ($sz -lt 256) { $dim = [byte]$sz }
    $bw.Write([byte]$dim)
    $bw.Write([byte]$dim)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]$Pngs[$i].Length)
    $bw.Write([uint32]$offset)
    $offset = $offset + $Pngs[$i].Length
  }
  for ($i = 0; $i -lt $n; $i++) { $bw.Write($Pngs[$i]) }
  $bw.Flush()
  $bw.Dispose()
  $fs.Dispose()
}

# ---------------------------------------------------------------
$MASTER = 2048

$masterFull   = New-Master -Size $MASTER -WithArcs $true  -UScale 1.0  -StrokeMul 1.0  -TargetCx 440.0 -TargetCy 550.0
$masterSimple = New-Master -Size $MASTER -WithArcs $false -UScale 1.25 -StrokeMul 1.10 -TargetCx 512.0 -TargetCy 515.0

$plan = @(
  @{ Size = 16;  Src = $masterSimple },
  @{ Size = 24;  Src = $masterSimple },
  @{ Size = 32;  Src = $masterSimple },
  @{ Size = 48;  Src = $masterFull   },
  @{ Size = 64;  Src = $masterFull   },
  @{ Size = 128; Src = $masterFull   },
  @{ Size = 256; Src = $masterFull   }
)

$bmpList = New-Object System.Collections.Generic.List[System.Drawing.Bitmap]
$pngList = New-Object System.Collections.Generic.List[byte[]]
$bySize  = @{}
foreach ($item in $plan) {
  $b = New-Scaled -Src $item.Src -Size $item.Size
  $bmpList.Add($b)
  $pngList.Add((ConvertTo-PngBytes -Bmp $b))
  $bySize[$item.Size] = $b
}

$icon256 = $bySize[256]
$icon512 = New-Scaled -Src $masterFull -Size 512
$iconPng = Join-Path $OutDir 'icon.png'
$icon512Png = Join-Path $OutDir 'icon-512.png'
$icon512.Save($icon512Png, [System.Drawing.Imaging.ImageFormat]::Png)
$icon256.Save($iconPng, [System.Drawing.Imaging.ImageFormat]::Png)

$icoPath = Join-Path $OutDir 'icon.ico'
Write-Ico -Path $icoPath -Bitmaps $bmpList.ToArray() -Pngs $pngList.ToArray()

$icon512.Dispose()
foreach ($b in $bmpList) { $b.Dispose() }
$masterFull.Dispose()
$masterSimple.Dispose()

Write-Output ('ICO   : ' + $icoPath)
Write-Output ('PNG256: ' + $iconPng)
Write-Output ('PNG512: ' + $icon512Png)
