# winprobe.ps1 —— 低成本系统探针（dsh-drop-by 专用）
#
# 一次调用返回：空闲毫秒、前台窗口标题/PID、音频峰值、进程名集合。
# 设计约束：
#   1) 只读，不改系统状态；
#   2) 不截屏、不取窗口内容；
#   3) 首次运行编译一次程序集到 winprobe.dll，之后只加载，避免每次重复编译。
#
# 输出：单行 JSON，Node 侧直接 JSON.parse。

param([switch]$ReadOnly)

$ErrorActionPreference = 'Stop'

# Node 按 UTF-8 读 stdout；不显式设成 UTF-8，中文窗口标题会变成乱码
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$dll = Join-Path $PSScriptRoot 'winprobe.dll'
$src = @'
using System;
using System.Runtime.InteropServices;

public static class WP {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

  [DllImport("user32.dll")]
  public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

  public static long IdleMs() {
    LASTINPUTINFO li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(li);
    if (!GetLastInputInfo(ref li)) return -1;
    long idle = (long)(Environment.TickCount & 0x7FFFFFFF) - (long)(li.dwTime & 0x7FFFFFFF);
    if (idle < 0) idle += 0x80000000L;
    return idle;
  }

  public static string FgTitle() {
    IntPtr h = GetForegroundWindow();
    var sb = new System.Text.StringBuilder(512);
    GetWindowTextW(h, sb, 512);
    return sb.ToString();
  }

  public static uint FgPid() {
    uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    return pid;
  }

  // 音频会话峰值：>0 说明当前确实在出声（audiodg 常驻，不能拿它判断）
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  private class MMDeviceEnumeratorComObject { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
                 [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }

  [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioMeterInformation {
    int GetPeakValue(out float peak);
  }

  public static double AudioPeak() {
    try {
      var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
      IMMDevice dev;
      if (en.GetDefaultAudioEndpoint(0 /*eRender*/, 1 /*eMultimedia*/, out dev) != 0) return -1;
      Guid iid = typeof(IAudioMeterInformation).GUID;
      object o;
      if (dev.Activate(ref iid, 1 /*CLSCTX_INPROC_SERVER*/, IntPtr.Zero, out o) != 0) return -1;
      float peak;
      if (((IAudioMeterInformation)o).GetPeakValue(out peak) != 0) return -1;
      return Math.Round((double)peak, 4);
    } catch { return -1; }
  }
}
'@

function Initialize-Probe {
  $script:probeReady = $false

  if (Test-Path $dll) {
    try {
      Add-Type -Path $dll
      $script:probeReady = $true
    } catch {
      # 缓存那份加载不了（被杀软动过、架构不匹配、文件被截断…）就重新编译。
      # 静默吞掉的话，出问题只能看到「找不到类型 [WP]」，没法定位。
      [Console]::Error.WriteLine('winprobe: cached dll failed -> ' + $_.Exception.Message)
    }
  }

  if (-not $script:probeReady -and -not $ReadOnly) {
    try {
      Add-Type -TypeDefinition $src -OutputAssembly $dll -Language CSharp
      Add-Type -Path $dll
      $script:probeReady = $true
    } catch {
      [Console]::Error.WriteLine('winprobe: build-to-file failed -> ' + $_.Exception.Message)
    }
  }

  if (-not $script:probeReady) {
    # 编译到文件失败（权限/占用/杀软锁）就退回内存编译，慢一点但不影响功能
    try {
      Add-Type -TypeDefinition $src -Language CSharp
      $script:probeReady = $true
    } catch {
      [Console]::Error.WriteLine('winprobe: in-memory build failed -> ' + $_.Exception.Message)
    }
  }
}

Initialize-Probe

$procs = @()
try {
  $procs = [System.Diagnostics.Process]::GetProcesses() |
    ForEach-Object { $_.ProcessName } |
    Sort-Object -Unique |
    ForEach-Object { $_.ToLowerInvariant() }
} catch { }

$fgPid = 0
$fgTitle = ''
$fgName = ''
try {
  $fgPid = [WP]::FgPid()
  $fgTitle = [WP]::FgTitle()
  if ($fgPid -gt 0) { $fgName = (Get-Process -Id $fgPid -ErrorAction Stop).ProcessName.ToLowerInvariant() }
} catch { }

$locked = $procs -contains 'logonui'

$obj = [ordered]@{
  ok         = $true
  idle_ms    = [WP]::IdleMs()
  locked     = [bool]$locked
  fg_pid     = $fgPid
  fg_title   = $fgTitle
  fg_name    = $fgName
  audio_peak = [WP]::AudioPeak()
  procs      = $procs
}
$obj | ConvertTo-Json -Compress -Depth 3
