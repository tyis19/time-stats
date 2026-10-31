param(
  [string]$Pids = '',
  [switch]$All,
  [Parameter(Mandatory = $true)][string]$OutFile
)

# 取进程的真实数据：进程号、进程名、完整路径。
# 只读，不修改任何进程。结果写成 UTF-8 的 JSON 文件（避开管道编码问题）。
# 输出：[{"pid":123,"name":"game.exe","path":"D:\\Games\\Foo\\game.exe"}]
# 拿不到路径的（受保护的系统进程）path 为空字符串。

$ErrorActionPreference = 'SilentlyContinue'

$items = @()

try {
  if ($All) {
    $items = Get-CimInstance Win32_Process | Select-Object ProcessId, Name, ExecutablePath
  }
  elseif ($Pids) {
    $ids = @()
    foreach ($x in ($Pids -split ',')) {
      $n = 0
      if ([int]::TryParse(('' + $x).Trim(), [ref]$n)) { $ids += $n }
    }
    if ($ids.Count -gt 0) {
      $filter = ($ids | ForEach-Object { "ProcessId=$_" }) -join ' or '
      $items = Get-CimInstance Win32_Process -Filter $filter | Select-Object ProcessId, Name, ExecutablePath
    }
  }
}
catch {
  $items = @()
}

$list = New-Object System.Collections.ArrayList
foreach ($i in @($items)) {
  if (-not $i) { continue }
  $p = ''
  if ($i.ExecutablePath) { $p = [string]$i.ExecutablePath }
  [void]$list.Add([pscustomobject]@{
      pid  = [int]$i.ProcessId
      name = [string]$i.Name
      path = $p
    })
}

if ($list.Count -eq 0) {
  $json = '[]'
}
else {
  $json = ConvertTo-Json -InputObject @($list) -Compress -Depth 3
  # PowerShell 5.1 在只有一个元素时会输出对象而不是数组，补一层方括号
  if ($list.Count -eq 1) { $json = '[' + $json + ']' }
}

try {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($OutFile, $json, $enc)
}
catch {
  exit 1
}

exit 0
