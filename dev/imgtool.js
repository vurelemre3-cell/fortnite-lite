// imgtool.js resize <in> <out> <maxSize> [jpegQuality]
// Shrink a texture so a 2048² bark map does not ship at 1 MB. Zero dependencies:
// on Windows it drives System.Drawing through PowerShell; elsewhere it falls back
// to copying the file untouched (and says so). PNG keeps its alpha, .jpg output
// is re-encoded at the given quality (default 82).
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');

const [, , cmd, src, dst, sizeArg, qArg] = process.argv;
if (cmd !== 'resize' || !src || !dst || !sizeArg) { console.log('usage: imgtool.js resize <in> <out> <maxSize> [jpegQuality]'); process.exit(1); }
const max = parseInt(sizeArg, 10), q = parseInt(qArg || '82', 10);
fs.mkdirSync(path.dirname(dst), { recursive: true });

if (process.platform !== 'win32') {
  fs.copyFileSync(src, dst);
  console.log('imgtool: no resizer on this platform, copied ' + path.basename(src) + ' as is');
  process.exit(0);
}

const ps = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${path.resolve(src).replace(/'/g, "''")}')
$w = $src.Width; $h = $src.Height; $k = [Math]::Min(1.0, ${max} / [Math]::Max($w, $h))
$nw = [Math]::Max(1, [int]($w * $k)); $nh = [Math]::Max(1, [int]($h * $k))
$bmp = New-Object System.Drawing.Bitmap $nw, $nh, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gfx.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HalfPixel
$gfx.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
$gfx.DrawImage($src, 0, 0, $nw, $nh)
$out = '${path.resolve(dst).replace(/'/g, "''")}'
if ($out -match '\\.jpe?g$') {
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $prm = New-Object System.Drawing.Imaging.EncoderParameters 1
  $prm.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]${q})
  $rgb = New-Object System.Drawing.Bitmap $nw, $nh, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g2 = [System.Drawing.Graphics]::FromImage($rgb); $g2.DrawImage($bmp, 0, 0, $nw, $nh); $g2.Dispose()
  $rgb.Save($out, $codec, $prm); $rgb.Dispose()
} else { $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png) }
$gfx.Dispose(); $bmp.Dispose(); $src.Dispose()
Write-Output ("$w" + "x" + "$h -> " + "$nw" + "x" + "$nh")
`;
const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }
console.log(path.basename(dst).padEnd(28) + r.stdout.trim() + '  ' + fs.statSync(dst).size + ' bytes');
