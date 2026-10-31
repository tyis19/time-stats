$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$assets = Join-Path $root 'src\assets'
New-Item -ItemType Directory -Force -Path $assets | Out-Null

function New-ClockBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $r = [int]($size * 0.22)
  $d = $r * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($size - $d, 0, $d, $d, 270, 90)
  $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $path.AddArc(0, $size - $d, $d, $d, 90, 90)
  $path.CloseFigure()

  $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 27, 40, 56))
  $g.FillPath($bg, $path)

  $penW = [float]($size * 0.07)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 102, 192, 244), $penW)
  $m = [float]($size * 0.23)
  $g.DrawEllipse($pen, $m, $m, $size - 2 * $m, $size - 2 * $m)

  $handW = [float]($size * 0.055)
  $hand = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 199, 213, 224), $handW)
  $hand.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $hand.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $cx = $size / 2
  $cy = $size / 2
  $g.DrawLine($hand, $cx, $cy, $cx, [float]($size * 0.31))
  $g.DrawLine($hand, $cx, $cy, [float]($size * 0.68), [float]($size * 0.60))

  $dotR = [float]($size * 0.05)
  $dot = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 102, 192, 244))
  $g.FillEllipse($dot, $cx - $dotR, $cy - $dotR, $dotR * 2, $dotR * 2)

  $pen.Dispose()
  $hand.Dispose()
  $bg.Dispose()
  $dot.Dispose()
  $path.Dispose()
  $g.Dispose()
  return $bmp
}

$b256 = New-ClockBitmap 256
$b256.Save((Join-Path $assets 'icon-256.png'), [System.Drawing.Imaging.ImageFormat]::Png)

$b64 = New-ClockBitmap 64
$b64.Save((Join-Path $assets 'icon-64.png'), [System.Drawing.Imaging.ImageFormat]::Png)

$b32 = New-ClockBitmap 32
$b32.Save((Join-Path $assets 'tray-32.png'), [System.Drawing.Imaging.ImageFormat]::Png)

$hicon = $b256.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hicon)
$icoPath = Join-Path $assets 'app.ico'
$fs = [System.IO.File]::Create($icoPath)
$icon.Save($fs)
$fs.Close()
$icon.Dispose()

$b256.Dispose()
$b64.Dispose()
$b32.Dispose()

Write-Output 'icons generated:'
Get-ChildItem $assets | ForEach-Object { Write-Output ("  " + $_.Name + '  ' + $_.Length + ' bytes') }
