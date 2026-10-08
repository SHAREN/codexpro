param(
    [Parameter(Mandatory = $true)][ValidateSet('list', 'capture')][string]$Action,
    [ValidateSet('full', 'primary', 'monitor', 'foreground', 'window')][string]$Mode = 'full',
    [int]$MonitorIndex = 0,
    [Alias('Pid')][int]$WindowPid = 0,
    [string]$ProcessName = '',
    [string]$Title = '',
    [int]$MaxWidth = 1920,
    [int]$MaxHeight = 1200,
    [string]$OutputPath = '',
    [int]$Limit = 80,
    [switch]$IncludeMinimized
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
namespace CodexPro {
  public sealed class WindowInfo {
    public long Handle; public int Pid; public string ProcessName; public string Title;
    public bool Minimized; public int Left; public int Top; public int Width; public int Height;
  }
  public static class NativeWindowApi {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT rect, int size);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    private static bool Bounds(IntPtr hWnd, out RECT rect) {
      if (DwmGetWindowAttribute(hWnd, 9, out rect, Marshal.SizeOf(typeof(RECT))) == 0) return true;
      return GetWindowRect(hWnd, out rect);
    }
    public static List<WindowInfo> ListWindows() {
      var result = new List<WindowInfo>();
      EnumWindows(delegate(IntPtr hWnd, IntPtr unused) {
        if (!IsWindowVisible(hWnd)) return true;
        int length = GetWindowTextLength(hWnd); if (length <= 0) return true;
        var title = new StringBuilder(length + 1); GetWindowText(hWnd, title, title.Capacity);
        RECT rect; if (!Bounds(hWnd, out rect)) return true;
        int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top; if (width <= 1 || height <= 1) return true;
        uint pid; GetWindowThreadProcessId(hWnd, out pid); string processName = "";
        try { processName = Process.GetProcessById((int)pid).ProcessName; } catch { }
        result.Add(new WindowInfo { Handle=hWnd.ToInt64(), Pid=(int)pid, ProcessName=processName, Title=title.ToString(),
          Minimized=IsIconic(hWnd), Left=rect.Left, Top=rect.Top, Width=width, Height=height });
        return true;
      }, IntPtr.Zero);
      return result;
    }
  }
}
'@

[CodexPro.NativeWindowApi]::SetProcessDPIAware() | Out-Null

function Convert-Window($Window) {
    [ordered]@{
        handle = [long]$Window.Handle; pid = [int]$Window.Pid; processName = [string]$Window.ProcessName
        title = [string]$Window.Title; minimized = [bool]$Window.Minimized
        bounds = [ordered]@{ left=[int]$Window.Left; top=[int]$Window.Top; width=[int]$Window.Width; height=[int]$Window.Height }
    }
}

function Get-MatchingWindows {
    $windows = @([CodexPro.NativeWindowApi]::ListWindows())
    if ($WindowPid -gt 0) { $windows = @($windows | Where-Object { $_.Pid -eq $WindowPid }) }
    if ($ProcessName) { $windows = @($windows | Where-Object { $_.ProcessName -like "*$ProcessName*" }) }
    if ($Title) { $windows = @($windows | Where-Object { $_.Title -like "*$Title*" }) }
    if (-not $IncludeMinimized) { $windows = @($windows | Where-Object { -not $_.Minimized }) }
    @($windows | Sort-Object @{Expression={$_.Width * $_.Height};Descending=$true}, Title)
}

if ($Action -eq 'list') {
    $windows = @(Get-MatchingWindows | Select-Object -First ([Math]::Max(1, [Math]::Min(200, $Limit))))
    $items = @($windows | ForEach-Object { (Convert-Window $_) | ConvertTo-Json -Compress -Depth 5 })
    '[' + ($items -join ',') + ']'
    exit 0
}

if (-not $OutputPath) { throw 'OutputPath is required for capture.' }
$selected = $null; $windowHandle = [IntPtr]::Zero; $method = 'copy-from-screen'
switch ($Mode) {
    'full' { $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen }
    'primary' { $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds }
    'monitor' {
        $screens = [System.Windows.Forms.Screen]::AllScreens
        if ($MonitorIndex -lt 0 -or $MonitorIndex -ge $screens.Count) { throw "Monitor index $MonitorIndex is out of range; found $($screens.Count)." }
        $bounds = $screens[$MonitorIndex].Bounds
    }
    'foreground' {
        $handle = [CodexPro.NativeWindowApi]::GetForegroundWindow().ToInt64()
        $selected = @([CodexPro.NativeWindowApi]::ListWindows() | Where-Object { $_.Handle -eq $handle }) | Select-Object -First 1
        if (-not $selected) { throw 'No capturable foreground window was found.' }
    }
    'window' {
        if ($WindowPid -le 0 -and -not $ProcessName -and -not $Title) { throw 'Window capture requires pid, process_name, or title.' }
        $selected = @(Get-MatchingWindows) | Select-Object -First 1
        if (-not $selected) { throw 'No visible window matched the requested selector.' }
    }
}
if ($selected) {
    $bounds = [System.Drawing.Rectangle]::new($selected.Left, $selected.Top, $selected.Width, $selected.Height)
    $windowHandle = [IntPtr]::new([long]$selected.Handle)
}
if ($bounds.Width -le 1 -or $bounds.Height -le 1) { throw 'Capture bounds are empty.' }

$bitmap = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    if ($windowHandle -ne [IntPtr]::Zero) {
        $hdc = $graphics.GetHdc()
        try { $printed = [CodexPro.NativeWindowApi]::PrintWindow($windowHandle, $hdc, 2) } finally { $graphics.ReleaseHdc($hdc) }
        if ($printed) { $method = 'print-window' } else { $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size) }
    } else { $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size) }
} finally { $graphics.Dispose() }

$scale = [Math]::Min(1.0, [Math]::Min($MaxWidth / [double]$bitmap.Width, $MaxHeight / [double]$bitmap.Height))
$width = [Math]::Max(1, [int][Math]::Round($bitmap.Width * $scale)); $height = [Math]::Max(1, [int][Math]::Round($bitmap.Height * $scale))
$output = $bitmap
if ($width -ne $bitmap.Width -or $height -ne $bitmap.Height) {
    $output = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($output)
    try { $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $g.DrawImage($bitmap, 0, 0, $width, $height) } finally { $g.Dispose() }
}
try {
    $parent = Split-Path -Parent $OutputPath; if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $output.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally { if ($output -ne $bitmap) { $output.Dispose() }; $bitmap.Dispose() }

$result = [ordered]@{
    mode=$Mode; method=$method; width=$width; height=$height; originalWidth=$bounds.Width; originalHeight=$bounds.Height
    bounds=[ordered]@{ left=$bounds.Left; top=$bounds.Top; width=$bounds.Width; height=$bounds.Height }
}
if ($Mode -eq 'monitor') { $result.monitorIndex = $MonitorIndex }
if ($selected) { $result.window = Convert-Window $selected }
$result | ConvertTo-Json -Compress -Depth 6
