param(
  [Parameter(Mandatory=$true)][string]$ExePath,
  [Parameter(Mandatory=$true)][string]$OutFile
)
$ErrorActionPreference = 'Stop'
try {
  $f = Get-Item -LiteralPath $ExePath
  $v = $f.VersionInfo
  $o = [ordered]@{
    description = [string]$v.FileDescription
    product     = [string]$v.ProductName
    version     = [string]$v.FileVersion
    size        = [int64]$f.Length
    mtime       = [int64]($f.LastWriteTimeUtc - [datetime]'1970-01-01').TotalMilliseconds
  }
  $json = $o | ConvertTo-Json -Compress
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($OutFile, $json, $enc)
  exit 0
} catch {
  exit 1
}
