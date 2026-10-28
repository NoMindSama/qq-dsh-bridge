/**
 * SnowLuma 一键启动 与 带 query 路由 的端到端测试。
 *
 * 注意：这个脚本会**真的启动 SnowLuma**（用 config.json 里的 launcherPath），
 * 并且会**真的打开一次 WebUI 浏览器窗口**。这是验证该功能的唯一可靠方式。
 *
 * 用法：node tools/test-snowluma-launch.mjs [http://127.0.0.1:3080]
 */
import { discoverDshSessionCookie } from '../qq-bridge/src/dsh-client.js'

const ORIGIN = process.argv[2] || 'http://127.0.0.1:3080'
const cookie = discoverDshSessionCookie(ORIGIN)
if (!cookie) { console.error('✗ 无法铸造 DSH Cookie'); process.exit(1) }
console.log(`目标 DSH: ${ORIGIN}\n`)

async function call(apiPath, method = 'GET') {
  const res = await fetch(ORIGIN + apiPath, {
    method,
    headers: Object.assign({ cookie }, method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    body: method === 'POST' ? '{}' : undefined,
    signal: AbortSignal.timeout(120000),
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 300) } }
  return { status: res.status, data }
}

const brief = (d, n = 320) => { const s = JSON.stringify(d); return s.length > n ? s.slice(0, n) + ' …' : s }

// ── 1) 带 query 的路由能不能命中 exact 匹配 ────────────────────────────────
console.log('【1】带 query 的请求是否命中 kind:exact 路由')
const bare = await call('/dsh-thinking-zh/qq-bigfish/persona')
console.log(`  不带 query            → HTTP ${bare.status}  ${brief(bare.data, 120)}`)
const withQ = await call('/dsh-thinking-zh/qq-bigfish/persona?name=' + encodeURIComponent('小鲸鱼'))
console.log(`  带 ?name=小鲸鱼        → HTTP ${withQ.status}  ${brief(withQ.data, 200)}`)
if (withQ.status === 404) {
  console.log('  ✗ 结论：exact 匹配把 query 也算进 path —— 人格页签"选中角色后读取全文"会失效，需要改成 POST 或路径参数。')
} else if (withQ.status === 200 && (withQ.data.content || withQ.data.text)) {
  console.log('  ✓ 结论：query 不影响 exact 匹配，人格页签读全文没问题。')
} else {
  console.log('  ? 结论：HTTP 200 但没拿到正文，需看返回结构。')
}

// ── 2) SnowLuma 启动前状态 ────────────────────────────────────────────────
console.log('\n【2】启动前的 SnowLuma 状态')
const before = await call('/dsh-thinking-zh/qq-bigfish')
console.log(`  connected=${before.data?.snowluma?.connected}  accountOnline=${before.data?.snowluma?.accountOnline}`)

// ── 3) 一键启动 ───────────────────────────────────────────────────────────
console.log('\n【3】调用 launch-snowluma（真的启动本机 SnowLuma，最多等 45 秒）')
const launched = await call('/dsh-thinking-zh/qq-bigfish/launch-snowluma', 'POST')
console.log(`  HTTP ${launched.status}`)
console.log(`  ${brief(launched.data, 500)}`)

// ── 4) 启动后状态 ─────────────────────────────────────────────────────────
console.log('\n【4】启动后等 8 秒再看状态')
await new Promise((r) => setTimeout(r, 8000))
const after = await call('/dsh-thinking-zh/qq-bigfish')
const sl = after.data?.snowluma || {}
console.log(`  connected=${sl.connected}  accountOnline=${sl.accountOnline}  good=${sl.good}  hint=${sl.hint || '(无)'}`)

// ── 5) 打开 WebUI（会真的弹浏览器，用于扫码场景） ─────────────────────────
console.log('\n【5】open-snowluma?target=webui（会真的打开浏览器窗口）')
const opened = await call('/dsh-thinking-zh/qq-bigfish/open-snowluma?target=webui')
console.log(`  HTTP ${opened.status}  ${brief(opened.data, 200)}`)

console.log('\n完成。')