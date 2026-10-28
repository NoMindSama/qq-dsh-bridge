# 桥接守护：由计划任务每分钟调用一次。只做三件事，然后静默退出。
#
# 为什么需要它：实测桥接会被"外部强杀"（bridge.log 没有任何错误就断在某一刻，
# 连 start.bat 的守护窗口和 CLI DSH 一起消失）。计划任务独立于任何会话与进程树，
# 所以它是最可靠的一层兜底 —— 桥接被杀了，最多 1 分钟内自动回来。
$ErrorActionPreference = 'SilentlyContinue'
# 从脚本自身位置推导仓库根，不写死绝对路径（换台机器/换个目录都能用）。
$RepoRoot = Split-Path -Parent $PSScriptRoot
$BridgeDir = Join-Path $RepoRoot 'qq-bridge'

$alive = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' })
if ($alive.Count -gt 0) { exit 0 }

# 后端端口会漂移（桌面端每次启动都换端口，实测 62295 → 65190 → 61371）：启动前对齐一次
$backends = @()
foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'")) {
  if ($p.CommandLine -match '--type=') { continue }
  $c = Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -First 1
  if ($c) { $backends += [pscustomobject]@{ kind = 'desktop'; url = "http://127.0.0.1:$($c.LocalPort)" } }
}
foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='node.exe'")) {
  if ($p.CommandLine -notmatch '@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js') { continue }
  $c = Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -First 1
  if ($c) { $backends += [pscustomobject]@{ kind = 'cli'; url = "http://127.0.0.1:$($c.LocalPort)" } }
}
$cfg = Join-Path $BridgeDir 'config.json'
$raw = Get-Content $cfg -Raw -Encoding UTF8
$cur = [regex]::Match($raw, '"baseUrl"\s*:\s*"([^"]*)"').Groups[1].Value
if ($backends.Count -gt 0 -and -not ($backends | Where-Object { $_.url -eq $cur.TrimEnd('/') })) {
  $pick = $backends | Where-Object { $_.kind -eq 'desktop' } | Select-Object -First 1
  if (-not $pick) { $pick = $backends[0] }
  $patched = [regex]::Replace($raw, '("baseUrl"\s*:\s*")[^"]*(")', ('${1}' + $pick.url + '${2}'), 1)
  [System.IO.File]::WriteAllText($cfg, $patched, (New-Object System.Text.UTF8Encoding($false)))
}

Remove-Item (Join-Path $BridgeDir 'state\bridge.lock') -Force
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'start.bat' -WorkingDirectory $BridgeDir -WindowStyle Hidden
exit 0