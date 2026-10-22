Add-Type @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
public struct AsioDevInfo {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string name;
    public uint driver;
}

public class AsioNative {
    [DllImport(@"C:\Users\tianz\Program\yu-wuwang\native\win32-x64\bassasio.dll",
        CallingConvention = CallingConvention.StdCall)]
    public static extern int BASS_ASIO_GetDeviceInfo(uint device, ref AsioDevInfo info);
}
'@

Write-Output "=== P/Invoke 枚举 ASIO 驱动 ==="
for ($i = 0; $i -lt 16; $i++) {
    $d = New-Object AsioDevInfo
    $r = [AsioNative]::BASS_ASIO_GetDeviceInfo([uint32]$i, [ref]$d)
    if ($r -eq 0) { break }
    Write-Output ("  [{0}] name='{1}' driver={2}" -f $i, $d.name, $d.driver)
}
