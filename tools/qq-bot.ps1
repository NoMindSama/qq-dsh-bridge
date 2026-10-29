<#
  QQ 大肥鱼机器人 · 启动与后端管理
  ────────────────────────────────────────────────────────────────────────
  这是"发行层"的管理脚本，放在项目根目录的 tools/ 下，不侵入 qq-bridge 仓库。

  为什么需要它：
    qq-bridge 通过 config.json 的 dsh.baseUrl 指向一个 DSH 实例。本机有两个：
      · CLI 版   dsh --profile web   （端口固定 3080，独立进程，需要自己启动）
      · 桌面端   DeepSeek Harness    （端口由 Electron 运行时分配，如 62295，
                                      随机但不影响：本脚本按进程反查端口）
    桌面端端口不固定，所以不能把 baseUrl 写死。本脚本负责「发现 → 写配置 → 重启桥接」。

  用法：
    .\qq-bot.ps1 status             查看所有组件状态（默认）
    .\qq-bot.ps1 backends           列出发现的 DSH 实例与其端口
    .\qq-bot.ps1 use desktop        把桥接后端切到桌面端 DSH
    .\qq-bot.ps1 use cli            把桥接后端切到 CLI DSH
    .\qq-bot.ps1 start              启动桥接（守护方式，独立进程）
    .\qq-bot.ps1 stop               停止桥接
    .\qq-bot.ps1 restart            重启桥接
    .\qq-bot.ps1 logs [行数]        打印桥接最近日志

  注意：
    · 桥接同一时刻只能连一个 DSH。切换后端不会删除任何会话，
      因为两个 DSH 共用同一个 ~/.dsh/sessions；但请避免同时在两个 DSH 里
      打开同一个 QQ 会话，以免并发写同一份会话文件。
    · 本脚本只探测 SnowLuma，绝不启动它（其 EULA §5.4 禁止自动化部署）。
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('status', 'backends', 'use', 'start', 'stop', 'restart', 'logs')]
  [string]$Action = 'status',

  [Parameter(Position = 1)]
  [ValidateSet('desktop', 'cli', 'auto')]
  [string]$Target = 'auto',

  [Parameter(Position = 2)]
  [int]$Tail = 25
)

$ErrorActionPreference = 'Stop'

# ── 路径（全部相对脚本位置推导，便于整个项目搬家） ──────────────────────────
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BridgeDir   = Join-Path $ProjectRoot 'qq-bridge'
$ConfigPath  = Join-Path $BridgeDir 'config.json'
$StateDir    = Join-Path $BridgeDir 'state'
$LogPath     = Join-Path $StateDir 'bridge.log'
$TokenPath   = Join-Path $StateDir 'console-token'
$BridgeLog   = Join-Path $StateDir 'bridge.out.log'
$BridgeErr   = Join-Path $StateDir 'bridge.err.log'

function Write-Section($text) { Write-Host ""; Write-Host "── $text " -ForegroundColor Cyan -NoNewline; Write-Host ("─" * [Math]::Max(1, 56 - $text.Length)) -ForegroundColor DarkGray }
function Write-Ok($t)   { Write-Host "  ✓ $t" -ForegroundColor Green }
function Write-Bad($t)  { Write-Host "  ✗ $t" -ForegroundColor Red }
function Write-Warn2($t){ Write-Host "  ! $t" -ForegroundColor Yellow }
function Write-Info($t) { Write-Host "    $t" -ForegroundColor DarkGray }

# ── 探测 ────────────────────────────────────────────────────────────────────

function Get-DshPort {
  param([int]$ProcessId)
  $c = Get-NetTCPConnection -State Listen -OwningProcess $ProcessId -ErrorAction SilentlyContinue |
       Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1' } |
       Select-Object -First 1
  if ($c) { return [int]$c.LocalPort }
  return $null
}

function Get-DshBackends {
  $list = New-Object System.Collections.ArrayList

  # 桌面端：Electron 主进程（命令行不含 --type=，那是它的渲染/GPU 子进程）
  foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue)) {
    if ($p.CommandLine -match '--type=') { continue }
    $port = Get-DshPort -ProcessId $p.ProcessId
    if ($port) {
      [void]$list.Add([pscustomobject]@{
        kind = 'desktop'; label = '桌面端 DSH'; pid = $p.ProcessId
        port = $port; url = "http://127.0.0.1:$port"
      })
    }
  }

  # CLI：node 跑 @deepseek-ai/dsh/lib/bin.js（排除 MCP server 子进程）
  foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
    if ($p.CommandLine -notmatch '@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js') { continue }
    if ($p.CommandLine -match 'mcp-') { continue }
    $port = Get-DshPort -ProcessId $p.ProcessId
    if ($port) {
      [void]$list.Add([pscustomobject]@{
        kind = 'cli'; label = 'CLI DSH'; pid = $p.ProcessId
        port = $port; url = "http://127.0.0.1:$port"
      })
    }
  }

  return @($list)
}

function Get-BridgeProcess {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' })
}

function Get-BridgeStatus {
  if (-not (Test-Path $TokenPath)) { return $null }
  $tok = (Get-Content $TokenPath -Raw -Encoding UTF8).Trim()
  try {
    return Invoke-RestMethod -Uri 'http://127.0.0.1:3100/api/status' -Headers @{ 'x-console-token' = $tok } -TimeoutSec 6
  } catch { return $null }
}

function Get-ConfiguredBaseUrl {
  $raw = Get-Content $ConfigPath -Raw -Encoding UTF8
  $m = [regex]::Match($raw, '"baseUrl"\s*:\s*"([^"]*)"')
  if ($m.Success) { return $m.Groups[1].Value }
  return ''
}

# ── 动作 ────────────────────────────────────────────────────────────────────

function Show-Backends {
  Write-Section '发现的 DSH 实例'
  $backends = Get-DshBackends
  if ($backends.Count -eq 0) { Write-Bad '没有发现任何运行中的 DSH（CLI 与桌面端都没有）'; return }
  $current = Get-ConfiguredBaseUrl
  foreach ($b in $backends) {
    $isCurrent = ($current -and $current.TrimEnd('/') -eq $b.url)
    $mark = ''; $color = 'Gray'
    if ($isCurrent) { $mark = ' ← 桥接当前指向'; $color = 'Green' }
    Write-Host ("  [{0,-7}] {1,-12} PID={2,-6} {3}{4}" -f $b.kind, $b.label, $b.pid, $b.url, $mark) -ForegroundColor $color
  }
}

function Use-Backend {
  param([string]$Kind)

  $backends = Get-DshBackends
  if ($Kind -eq 'auto') {
    # 优先桌面端（更省事），回退 CLI
    $pick = $backends | Where-Object { $_.kind -eq 'desktop' } | Select-Object -First 1
    if (-not $pick) { $pick = $backends | Where-Object { $_.kind -eq 'cli' } | Select-Object -First 1 }
  } else {
    $pick = $backends | Where-Object { $_.kind -eq $Kind } | Select-Object -First 1
  }

  if (-not $pick) { Write-Bad ("没有发现可用的 {0} 后端" -f $Kind); return $false }

  $old = Get-ConfiguredBaseUrl
  if ($old.TrimEnd('/') -eq $pick.url) {
    Write-Ok ("后端已经是 {0}（{1}），无需切换" -f $pick.label, $pick.url)
  } else {
    # 只替换 baseUrl 一行，其余配置原样保留（避免重新序列化整个 JSON）
    $raw = Get-Content $ConfigPath -Raw -Encoding UTF8
    $new = [regex]::Replace($raw, '("baseUrl"\s*:\s*")[^"]*(")', ('${1}' + $pick.url + '${2}'), 1)
    if ($new -eq $raw -and -not $raw.Contains($pick.url)) {
      Write-Bad 'config.json 里没找到 dsh.baseUrl 字段，未做修改'; return $false
    }
    # 备份后写入（UTF-8 无 BOM，DSH 与桥接都按 UTF-8 读）
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item $ConfigPath "$StateDir\config.json.bak-$stamp" -Force
    [System.IO.File]::WriteAllText($ConfigPath, $new, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok ("dsh.baseUrl: {0}  →  {1}" -f $old, $pick.url)
    Write-Info ("已备份 state\config.json.bak-$stamp")
  }

  Restart-Bridge
  return $true
}

function Sync-BackendPort {
  <#
    config.json 的 dsh.baseUrl 可能指向一个已经消失的端口 —— 典型场景是「后端选了桌面端」，
    而桌面端每次启动都由 Electron 重新分配端口（实测 62295 → 65190）。
    每次启动/重启桥接前对齐一次，避免"上次能用、这次连不上"。
  #>
  $current = Get-ConfiguredBaseUrl
  if (-not $current) { return $current }
  $backends = Get-DshBackends
  if ($backends | Where-Object { $_.url -eq $current.TrimEnd('/') }) { return $current }
  $pick = $backends | Where-Object { $_.kind -eq 'desktop' } | Select-Object -First 1
  if (-not $pick) { $pick = $backends | Select-Object -First 1 }
  if (-not $pick) {
    Write-Warn2 ("config 指向的 " + $current + " 已不在监听，且没发现别的 DSH")
    return $current
  }
  $raw = Get-Content $ConfigPath -Raw -Encoding UTF8
  $patched = [regex]::Replace($raw, '("baseUrl"\s*:\s*")[^"]*(")', ('${1}' + $pick.url + '${2}'), 1)
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item $ConfigPath "$StateDir\config.json.bak-$stamp" -Force
  [System.IO.File]::WriteAllText($ConfigPath, $patched, (New-Object System.Text.UTF8Encoding($false)))
  Write-Warn2 ("后端端口已漂移：" + $current + " → " + $pick.url + "（已自动对齐）")
  return $pick.url
}

function Start-Bridge {
  if ((Get-BridgeProcess).Count -gt 0) { Write-Warn2 '桥接已经在运行（单实例锁），未重复启动'; return }
  if (-not (Test-Path $BridgeDir)) { Write-Bad ("桥接目录不存在: " + $BridgeDir); return }

  [void](Sync-BackendPort)
  Remove-Item (Join-Path $StateDir 'bridge.lock') -Force -ErrorAction SilentlyContinue
  # 重定向 stdout/stderr：桥接自身把业务日志写入 state/bridge.log，
  # 但若无人消费它的控制台输出，缓冲写满会让进程阻塞（实测过 DSH 的同类问题）。
  # 用 start.bat 启动：它自带守护（崩溃 5 秒后拉起）。这点很关键 ——
  # 桥接自带的 /api/restart（工具箱「切换后端」会调它）会让进程退出并期待被拉起；
  # 如果这里用裸 Start-Process 启动，退出后就再也没人管了（实测踩过这个坑）。
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','start.bat' -WorkingDirectory $BridgeDir -WindowStyle Hidden

  Write-Host '  启动中' -NoNewline -ForegroundColor DarkGray
  # 判定以「3100 端口开始监听」为准。旧逻辑先查 WMI 的 CommandLine，而新进程刚起来时
  # 那一段可能还是空的 —— 于是每次 restart 都误报「未能启动」，实际 5 秒内就在跑。
  $listening = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500; Write-Host '.' -NoNewline -ForegroundColor DarkGray
    if (Get-NetTCPConnection -State Listen -LocalPort 3100 -ErrorAction SilentlyContinue) { $listening = $true; break }
  }
  if (-not $listening) {
    # 再给一点宽限：端口刚绑定（或 3100 被占、桥接换了端口）时，进程仍然算起来了。
    Start-Sleep -Seconds 3
    $listening = [bool](Get-NetTCPConnection -State Listen -LocalPort 3100 -ErrorAction SilentlyContinue)
  }
  Write-Host ''
  if ($listening -or (Get-BridgeProcess).Count -gt 0) { Write-Ok '桥接进程已启动' }
  else { Write-Bad '桥接未能启动，请查看 state\bridge.err.log' }
}

function Stop-Bridge {
  # 先杀守护窗口，否则 start.bat 会在 5 秒后把桥接重新拉起
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*start.bat*' -and $_.CommandLine -notlike '*restart.bat*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $procs = Get-BridgeProcess
  if ($procs.Count -eq 0) { Write-Warn2 '桥接没有在运行'; return }
  foreach ($p in $procs) { Write-Info ("停止 PID " + $p.ProcessId); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  [void](Sync-BackendPort)
  Remove-Item (Join-Path $StateDir 'bridge.lock') -Force -ErrorAction SilentlyContinue
  Write-Ok '桥接已停止'
}

function Restart-Bridge {
  Stop-Bridge
  Start-Sleep -Seconds 1
  Start-Bridge
}

function Show-Status {
  Write-Section '外部依赖（本脚本只探测，不代启动）'
  $sl = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*SnowLuma*index.mjs*' }
  if ($sl) {
    Write-Ok ("SnowLuma 运行中（PID " + ($sl | Select-Object -First 1).ProcessId + "）")
    foreach ($port in 3000, 3001, 5099) {
      $c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
      if ($c) { Write-Info ("端口 $port ✓") } else { Write-Warn2 ("端口 $port 未监听") }
    }
  } else {
    Write-Bad 'SnowLuma 未运行 —— QQ 侧会完全收不到消息，请先启动你自己的 SnowLuma（双击它目录下的 launcher.bat）'
  }

  Show-Backends

  Write-Section '桥接'
  $bp = Get-BridgeProcess
  if ($bp.Count -eq 0) {
    Write-Bad '桥接未运行（.\\qq-bot.ps1 start 可启动）'
  } else {
    Write-Ok ("桥接运行中（PID " + ($bp | Select-Object -First 1).ProcessId + "）")
    $st = Get-BridgeStatus
    if ($st) {
      $ready = '✗'; if ($st.dshReady) { $ready = '✓' }
      Write-Host ("    DSH 就绪: $ready   模式: " + $st.mode)
      if ($st.snowluma) {
        Write-Host ("    SnowLuma: 连接=" + $st.snowluma.connected + "  账号在线=" + $st.snowluma.accountOnline + "  上游健康=" + $st.snowluma.good)
        if ($st.snowluma.degraded) { Write-Warn2 ("上游退化：" + $st.snowluma.hint) }
      }
      Write-Info ("控制台 http://127.0.0.1:3100（令牌在 state\console-token）")
    } else {
      Write-Warn2 '拿不到 /api/status（控制台令牌可能已变）'
    }
  }
}

function Show-Logs {
  if (-not (Test-Path $LogPath)) { Write-Bad '没有 state\bridge.log'; return }
  Write-Section ("桥接日志（最近 $Tail 行）")
  Get-Content $LogPath -Encoding UTF8 -Tail $Tail
}

# ── 入口 ────────────────────────────────────────────────────────────────────

switch ($Action) {
  'status'   { Show-Status }
  'backends' { Show-Backends }
  'use'      { [void](Use-Backend -Kind $Target) }
  'start'    { Start-Bridge }
  'stop'     { Stop-Bridge }
  'restart'  { Restart-Bridge }
  'logs'     { Show-Logs }
}