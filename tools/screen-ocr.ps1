# screen-ocr.ps1 —— L3 屏幕理解（presence-gate 专用）
#
# 抓当前前台窗口的画面，用系统自带的 OCR（Windows.Media.Ocr）读出文字。
# 设计约束：
#   1) 不抢焦点：CopyFromScreen 是 BitBlt，只读像素，不激活窗口；
#   2) 窗口最小化 / 尺寸异常 / 独占全屏（游戏）时直接返回 ok=false，不硬猜；
#   3) 大图先缩到 MaxWidth 再 OCR，避免 4K 全屏拖到几秒；
#   4) 临时 PNG 用完即删。
#
# 输出：单行 JSON，Node 侧直接 JSON.parse。

param(
  [int]$MaxWidth = 1600,
  [int]$MaxChars = 2000
)

$ErrorActionPreference = 'Stop'

try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$t0 = [DateTime]::UtcNow

function Fail($reason, $extra) {
  $obj = @{ ok = $false; reason = $reason; ms = [int](([DateTime]::UtcNow) - $t0).TotalMilliseconds }
  if ($extra) { $obj | Add-Member -NotePropertyMembers $extra }
  $obj | ConvertTo-Json -Compress
  exit 0
}

try {
  Add-Type -AssemblyName System.Drawing

  $cs = @'
using System;
using System.Runtime.InteropServices;

public static class SO {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);

  public static bool FgMinimized() { return IsIconic(GetForegroundWindow()); }

  public static RECT FgRect() {
    IntPtr h = GetForegroundWindow();
    RECT r;
    // DWMWA_EXTENDED_FRAME_BOUNDS = 9：去掉 Win10+ 窗口四周的透明拖拽边框
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) {
      GetWindowRect(h, out r);
    }
    return r;
  }
}
'@
  Add-Type -TypeDefinition $cs

  if ([SO]::FgMinimized()) { Fail 'MINIMIZED' $null }

  $r = [SO]::FgRect()
  $w = $r.Right - $r.Left
  $h = $r.Bottom - $r.Top
  if ($w -lt 80 -or $h -lt 80) { Fail 'TOO_SMALL' @{ w = $w; h = $h } }

  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $g.Dispose()

  if ($w -gt $MaxWidth) {
    $nh = [int]($h * $MaxWidth / $w)
    $small = New-Object System.Drawing.Bitmap $MaxWidth, $nh
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($bmp, 0, 0, $MaxWidth, $nh)
    $g2.Dispose()
    $bmp.Dispose()
    $bmp = $small
  }

  $tmp = Join-Path $env:TEMP ('pg-shot-' + [Guid]::NewGuid().ToString('N') + '.png')
  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $shotMs = [int](([DateTime]::UtcNow) - $t0).TotalMilliseconds
  $bmp.Dispose()

  Add-Type -AssemblyName System.Runtime.WindowsRuntime

  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

  function Await($op, $type) {
    $m = $asTaskGeneric.MakeGenericMethod($type)
    $task = $m.Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }

  [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine, Windows.Media, ContentType = WindowsRuntime] | Out-Null

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $soft = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $engine = $null
  try {
    $lang = New-Object Windows.Globalization.Language 'zh-Hans-CN'
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  } catch { }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Fail 'NO_OCR_ENGINE' $null
  }

  $result = Await ($engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])
  $text = [string]$result.Text

  Remove-Item $tmp -Force -ErrorAction SilentlyContinue

  if ([string]::IsNullOrWhiteSpace($text)) {
    # 独占全屏的游戏 / 受保护内容，截出来是全黑，OCR 一个字都读不到
    Fail 'NO_TEXT' @{ shot_ms = $shotMs; w = $w; h = $h }
  }

  if ($text.Length -gt $MaxChars) { $text = $text.Substring(0, $MaxChars) }

  @{
    ok = $true
    ms = [int](([DateTime]::UtcNow) - $t0).TotalMilliseconds
    shot_ms = $shotMs
    w = $w
    h = $h
    chars = $text.Length
    text = $text
  } | ConvertTo-Json -Compress
}
catch {
  Fail 'OCR_ERROR' @{ note = [string]$_.Exception.Message }
}
