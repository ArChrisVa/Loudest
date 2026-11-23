# Builds ..\icon.ico from the three drawings in this folder.
#
#   powershell -ExecutionPolicy Bypass -File icon\build.ps1
#
# Microsoft Edge draws the SVG files (it is already on every Windows PC), and
# the rest packs the results into one .ico file. Nothing is installed.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Each size Windows asks for, and the drawing used for it. The two smallest
# have their own simplified drawings; the full one blurs at those sizes.
$sizes = @(
  @(16, 'icon-16.svg'),
  @(24, 'icon-24.svg'),
  @(32, 'icon.svg'),
  @(48, 'icon.svg'),
  @(64, 'icon.svg'),
  @(256, 'icon.svg')
)

$icoPath = Join-Path (Split-Path $PSScriptRoot) 'icon.ico'
$work = Join-Path $env:TEMP 'loudest-icon-build'
New-Item -ItemType Directory -Force $work | Out-Null
$sheetHtml = Join-Path $work 'sheet.html'
$sheetPng = Join-Path $work 'sheet.png'

# 1. One web page with every size side by side on a see-through background.
$images = ''
$left = 0
foreach ($item in $sizes) {
  $source = 'file:///' + ((Join-Path $PSScriptRoot $item[1]) -replace '\\', '/')
  $images += "<img src='$source' width='$($item[0])' height='$($item[0])' style='position:absolute;top:0;left:${left}px'>"
  $left += $item[0]
}
$html = "<!doctype html><html><body style='margin:0;background:transparent'>$images</body></html>"
[System.IO.File]::WriteAllText($sheetHtml, $html, (New-Object System.Text.UTF8Encoding $false))

# 2. Edge, without a window, saves a picture of that page.
$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge was not found.' }
if (Test-Path $sheetPng) { Remove-Item $sheetPng }
$url = 'file:///' + ($sheetHtml -replace '\\', '/')
Start-Process $edge -Wait -ArgumentList @(
  '--headless', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--default-background-color=00000000',
  "--screenshot=`"$sheetPng`"",
  "--window-size=$([Math]::Max($left, 600)),300",
  "`"$url`""
)
if (-not (Test-Path $sheetPng)) { throw 'Edge did not produce a picture of the icons.' }

# 3. Cut each size out of the picture and store it the way .ico files expect:
#    the 256 size as a PNG, the smaller ones as plain bitmaps (blue, green,
#    red, alpha per pixel, rows from the bottom up, then an empty mask).
$sheet = [System.Drawing.Bitmap]::FromFile($sheetPng)
$blobs = @()
$left = 0
foreach ($item in $sizes) {
  $size = $item[0]
  $area = New-Object System.Drawing.Rectangle $left, 0, $size, $size
  $crop = $sheet.Clone($area, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stream = New-Object System.IO.MemoryStream
  if ($size -eq 256) {
    $crop.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  } else {
    $writer = New-Object System.IO.BinaryWriter $stream
    $writer.Write([int]40); $writer.Write([int]$size); $writer.Write([int]($size * 2))
    $writer.Write([int16]1); $writer.Write([int16]32)
    foreach ($unused in 1..6) { $writer.Write([int]0) }
    for ($y = $size - 1; $y -ge 0; $y--) {
      for ($x = 0; $x -lt $size; $x++) {
        $pixel = $crop.GetPixel($x, $y)
        $writer.Write([byte]$pixel.B); $writer.Write([byte]$pixel.G); $writer.Write([byte]$pixel.R); $writer.Write([byte]$pixel.A)
      }
    }
    $maskBytesPerRow = [int][Math]::Ceiling($size / 32.0) * 4
    $writer.Write((New-Object byte[] ($maskBytesPerRow * $size)))
    $writer.Flush()
  }
  $blobs += , $stream.ToArray()
  $crop.Dispose()
  $left += $size
}
$sheet.Dispose()

# 4. The .ico file: a short table of contents, then the pictures.
$out = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $out
$writer.Write([int16]0); $writer.Write([int16]1); $writer.Write([int16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $size = $sizes[$i][0]
  if ($size -eq 256) { $size = 0 }  # the format writes 256 as 0
  $writer.Write([byte]$size); $writer.Write([byte]$size); $writer.Write([byte]0); $writer.Write([byte]0)
  $writer.Write([int16]1); $writer.Write([int16]32)
  $writer.Write([int]$blobs[$i].Length); $writer.Write([int]$offset)
  $offset += $blobs[$i].Length
}
foreach ($blob in $blobs) { $writer.Write([byte[]]$blob) }
$writer.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $out.ToArray())

Remove-Item $work -Recurse -Force
"Wrote $icoPath ($($sizes.Count) sizes)"
