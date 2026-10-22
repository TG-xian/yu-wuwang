Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public class WinShot {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

$p = Get-Process electron -ErrorAction SilentlyContinue |
     Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output "NO_WINDOW"; exit 1 }

$h = $p.MainWindowHandle
$r = New-Object WinShot+RECT
[void][WinShot]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$hh = $r.Bottom - $r.Top
Write-Output ("hwnd={0} rect={1},{2} {3}x{4}" -f $h, $r.Left, $r.Top, $w, $hh)

if ($w -le 0 -or $hh -le 0) { Write-Output "BAD_RECT"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [WinShot]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save("C:\Users\tianz\Program\yu-wuwang\shot2.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("printwindow={0} saved=shot2.png" -f $ok)
