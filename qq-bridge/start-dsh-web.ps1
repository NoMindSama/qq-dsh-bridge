<#
  启动 qq-bridge 专用的 DSH Web（固定 3080），并让桥接能自动发现 launch token。

  为什么需要这个脚本：
  qq-bridge v0.1.5 用「launch token 换 Cookie」鉴权。它的自动发现逻辑
  （src/dsh-client.js 的 discoverDshLaunchToken）只读
  ~/.dsh/guard/logs/server-*.out.log 里形如 ?token=xxx 的那一行。
  直接在终端里跑 `dsh web` 不会生成该日志，桥接就拿不到 token，
  表现为 /api/settings/describe 一路 HTTP 401。

  两个已经踩过的坑，别改回去：
  1) 必须用 cmd 的 ">" 重定向，不能用 PowerShell 的 "*>"。
     PowerShell 5.1 的 *> 会独占文件句柄，node 的 readFileSync 直接
     报共享冲突，被桥接的 try/catch 静默吞掉 → 仍然 401。
     cmd 的重定向是共享读的，node 能正常读。
  2) 日志每次必须覆盖写（不是追加）。发现逻辑取文件中第一个 token 匹配值，
     追加会让它读到上一次的陈旧 token。

  用法：
    powershell -ExecutionPolicy Bypass -File start-dsh-web.ps1
#>
$ErrorActionPreference = 'Stop'

$port   = 3080
$logDir = Join-Path $env:USERPROFILE '.dsh\guard\logs'
$log    = Join-Path $logDir 'server-web.out.log'

# 端口已被占用就别重复起，避免两个 DSH 抢同一个 3080。
$busy = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if ($busy) {
  Write-Host "端口 $port 已被 PID $($busy[0].OwningProcess) 占用，未启动。" -ForegroundColor Yellow
  exit 0
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# 清掉旧日志，保证自动发现读到的是本次进程的 token。
if (Test-Path $log) { Remove-Item $log -Force }

Write-Host "启动 DSH Web（profile=web, port=$port）..." -ForegroundColor Cyan
Write-Host "启动日志: $log"

# 用 cmd 做重定向：共享读，桥接的 token 自动发现才读得到。
$cmdLine = 'dsh --profile web --port ' + $port + ' --no-open > "' + $log + '" 2>&1'
& cmd /c $cmdLine