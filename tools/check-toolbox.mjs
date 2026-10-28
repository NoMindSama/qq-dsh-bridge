/**
 * 工具箱自检：直接打 DSP 的插件 HTTP 路由，确认「QQ 大肥鱼」的 host 半真的挂上了。
 *
 * 用法：
 *   node tools/check-toolbox.mjs                    # 默认打桌面端（自动发现端口）
 *   node tools/check-toolbox.mjs http://127.0.0.1:3080
 *
 * 为什么能直接调：DSH 的 API 要求一个会话 Cookie，而该 Cookie 可以用
 * ~/.dsh/.credentials.yaml 里的持久化签名密钥离线铸造（见 qq-bridge/src/dsh-client.js）。
 * 不需要知道任何进程的启动令牌。
 */
import { discoverDshSessionCookie } from '../qq-bridge/src/dsh-client.js'
import { execFileSync } from 'node:child_process'

function findDesktopPort() {
  if (process.platform !== 'win32') return null
  const script = [
    "foreach ($p in (Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" -ErrorAction SilentlyContinue)) {",
    "  if ($p.CommandLine -match '--type=') { continue }",
    "  $c = Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -First 1",
    '  if ($c) { $c.LocalPort; break }',
    '}',
  ].join('\n')
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    }).trim()
    return out ? Number(out.split('\n')[0].trim()) : null
  } catch { return null }
}

const arg = process.argv[2]
let base = arg
if (!base) {
  const port = findDesktopPort()
  base = port ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:3080'
}

console.log(`目标 DSH: ${base}`)
const cookie = discoverDshSessionCookie(base)
if (!cookie) {
  console.error('✗ Cookie 铸造失败：~/.dsh/.credentials.yaml 里没有可用的签名密钥')
  process.exit(1)
}
console.log(`✓ Cookie 已离线铸造（${cookie.slice(0, 16)}…）\n`)

const targets = [
  ['GET', '/dsh-thinking-zh/state'],
  ['GET', '/dsh-thinking-zh/qq-bigfish'],
  ['GET', '/dsh-thinking-zh/qq-bigfish/settings'],
  ['GET', '/dsh-thinking-zh/qq-bigfish/persona'],
  ['GET', '/dsh-thinking-zh/qq-bigfish/tokens'],
  ['GET', '/dsh-thinking-zh/qq-bigfish/stickers'],
  ['GET', '/dsh-thinking-zh/qq-bigfish/access'],
  ['GET', '/dsh-thinking-zh/qq-bigfish/backend'],
  ['GET', '/dsh-thinking-zh/qq-bigfish/diagnose'],
]

let ok = 0
for (const [method, path] of targets) {
  try {
    const res = await fetch(base + path, { method, headers: { cookie }, signal: AbortSignal.timeout(40000) })
    const text = await res.text()
    const mark = res.status === 200 ? '✓' : '✗'
    if (res.status === 200) ok += 1
    console.log(`${mark} ${path}  →  HTTP ${res.status}  (${text.length} 字节)`)
    if (res.status !== 200) {
      console.log(`     ${text.slice(0, 200)}`)
    } else if (path.endsWith('/qq-bigfish') || path.endsWith('/diagnose')) {
      // 这两个最能说明问题，多打一点
      console.log(`     ${text.slice(0, 700)}`)
    }
  } catch (error) {
    console.log(`✗ ${path}  →  异常: ${error.message}`)
  }
}

console.log(`\n结果：${ok}/${targets.length} 个路由可用`)
if (ok < targets.length) {
  console.log('提示：路由 404 通常意味着 DSH 还没重新加载插件（JS 代码改动需要重载）。')
  process.exit(1)
}
console.log('🎉 工具箱 host 半已就绪')