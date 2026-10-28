# 记忆库每日备份（手动运行，或交给 Windows 计划任务）。
#
# 为什么要单独一个脚本：`scripts/memory-backup.mjs` 做完 gzip + sha256 + 行数自检 + 轮换（保留 14 份），
# 但需要一个"每天跑一次"的载体。桥接进程重启会丢定时器，计划任务不会。
#
# 用法（手动）：
#   powershell -ExecutionPolicy Bypass -File tools\memory-backup.ps1
#
# 注册成每天 04:10 的计划任务（需要管理员 PowerShell，只做一次）：
#   $act = New-ScheduledTaskAction -Execute 'powershell.exe' `
#     -Argument '-NoProfile -ExecutionPolicy Bypass -File "<你的仓库路径>\tools\memory-backup.ps1"'
#   $trg = New-ScheduledTaskTrigger -Daily -At 04:10
#   Register-ScheduledTask -TaskName 'QQ-Bridge-MemoryBackup' -Action $act -Trigger $trg -Description 'QQ 桥接记忆库每日备份'

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bridge = Join-Path $root 'qq-bridge'
$log = Join-Path $bridge 'state\memory-backup.log'

$ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Push-Location $bridge
try {
  $out = & node scripts/memory-backup.mjs 2>&1 | Out-String
  Add-Content -Path $log -Value "[$ts] OK`n$out" -Encoding UTF8
  Write-Host "[$ts] 备份完成，日志：$log"
  exit 0
} catch {
  Add-Content -Path $log -Value "[$ts] FAILED: $($_.Exception.Message)" -Encoding UTF8
  Write-Error "[$ts] 备份失败：$($_.Exception.Message)"
  exit 1
} finally {
  Pop-Location
}