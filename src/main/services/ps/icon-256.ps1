param(
  [Parameter(Mandatory=$true)][string]$ExePath,
  [Parameter(Mandatory=$true)][string]$OutPng
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = @'
using System;
using System.Runtime.InteropServices;

public static class ShellIcon256 {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern int SHDefExtractIcon(string pszIconFile, int iIndex, uint uFlags,
        out IntPtr phiconLarge, out IntPtr phiconSmall, uint nIconSize);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool DestroyIcon(IntPtr hIcon);
}
'@

if (-not ([System.Management.Automation.PSTypeName]'ShellIcon256').Type) {
    Add-Type -TypeDefinition $src
}

$large = [IntPtr]::Zero
$small = [IntPtr]::Zero
$size = 256
$packed = [uint32]($size -bor ($size -shl 16))

try {
    [void][ShellIcon256]::SHDefExtractIcon($ExePath, 0, 0, [ref]$large, [ref]$small, $packed)
} catch {
    exit 2
}

if ($large -eq [IntPtr]::Zero) { exit 3 }

try {
    $icon = [System.Drawing.Icon]::FromHandle($large)
    $bmp = $icon.ToBitmap()
    $bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
    $w = $bmp.Width
    $h = $bmp.Height
    $bmp.Dispose()
    $icon.Dispose()
    Write-Output ("{0}x{1}" -f $w, $h)
    exit 0
} catch {
    exit 4
} finally {
    [void][ShellIcon256]::DestroyIcon($large)
    if ($small -ne [IntPtr]::Zero) { [void][ShellIcon256]::DestroyIcon($small) }
}
