/**
 * 表情上传接口的端到端测试。
 *
 * 会真的调用 OneBot 的 add_custom_face —— 也就是**真的往 QQ 账号收藏里加一张表情**。
 * 这是验证这条链路唯一可靠的方式（接口的成功与否完全取决于 QQ 侧的响应）。
 * 默认用仓库自带 assets/deepseek娘.png（机器人形象，留着也合适）。
 *
 * 用法：node tools/test-sticker-upload.mjs [图片路径]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const BRIDGE = path.join(ROOT, 'qq-bridge')
const ORIGIN = 'http://127.0.0.1:3100'

const token = fs.readFileSync(path.join(BRIDGE, 'state', 'console-token'), 'utf8').trim()

async function post(apiPath, body) {
  const res = await fetch(ORIGIN + apiPath, {
    method: 'POST',
    headers: { 'x-console-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 300) } }
  return { status: res.status, data }
}

async function get(apiPath) {
  const res = await fetch(ORIGIN + apiPath, { headers: { 'x-console-token': token }, signal: AbortSignal.timeout(30000) })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 300) } }
  return { status: res.status, data }
}

const show = (label, r) => {
  const s = JSON.stringify(r.data)
  console.log(`  HTTP ${r.status}  ${s.length > 400 ? s.slice(0, 400) + ' …' : s}`)
}

// ── 1) 校验逻辑（无副作用） ────────────────────────────────────────────────
console.log('【1】非法 base64 —— 应被拒绝')
show('', await post('/api/stickers/upload', { data: 'not!base64!' }))

console.log('\n【2】合法 base64 但不是图片 —— 应被拒绝')
show('', await post('/api/stickers/upload', { data: Buffer.from('hello world, definitely not an image').toString('base64') }))

console.log('\n【3】空 data —— 应被拒绝')
show('', await post('/api/stickers/upload', {}))

// ── 2) 真实上传（有副作用：会进 QQ 收藏） ─────────────────────────────────
const imgPath = process.argv[2] || path.join(BRIDGE, 'assets', 'deepseek娘.png')
if (!fs.existsSync(imgPath)) {
  console.log(`\n跳过真实上传：找不到图片 ${imgPath}`)
  process.exit(0)
}
const buf = fs.readFileSync(imgPath)
console.log(`\n【4】真实上传 ${path.basename(imgPath)}（${(buf.length / 1024).toFixed(0)} KB）`)
const uploaded = await post('/api/stickers/upload', { data: buf.toString('base64'), note: '大肥鱼本鱼' })
show('', uploaded)

if (uploaded.data && uploaded.data.emojiId) {
  console.log(`  → 新表情 emoji_id = ${uploaded.data.emojiId}`)
} else {
  console.log('  ⚠ 没有拿到 emoji_id（可能 QQ 收藏已达上限，或网关不支持 add_custom_face）')
}

// ── 3) 确认它出现在列表里 ─────────────────────────────────────────────────
console.log('\n【5】确认它进了表情列表')
const list = await get('/api/stickers?count=10')
console.log(`  HTTP ${list.status}  total=${list.data?.total}  matched=${list.data?.matched}`)
if (Array.isArray(list.data?.stickers)) {
  for (const s of list.data.stickers.slice(0, 5)) {
    console.log(`   · id=${s.id} desc="${s.desc || ''}" note="${s.localNote || ''}" url=${String(s.url || '').slice(0, 60)}`)
  }
}

console.log('\n完成。上面【4】若返回 ok:true，说明「上传即成为 QQ 收藏表情」这条链路是通的。')