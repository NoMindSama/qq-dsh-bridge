/**
 * 浮游球 client 半的运行时测试。
 *
 * 为什么需要它：lib/client.js 是浏览器代码，host 半的那些自检完全碰不到它。
 * 这里用一个最小的 DOM 模拟器把它真正执行一遍 —— 实例化浮游球、打开面板、
 * 点齿轮、逐个切换页签 —— 并且让它的 fetch 真的打到本机 DSH，
 * 所以每个页签都是在**真实数据**下渲染的，能抓出未定义变量、错误的 DOM 用法、
 * 以及"点齿轮顺带把开关翻掉"这类冒泡 bug。
 *
 * 用法：node tools/test-toolbox-client.mjs [http://127.0.0.1:3080]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverDshSessionCookie } from '../qq-bridge/src/dsh-client.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
// dsh-plugins 与 qq-bridge 是平级的两棵目录树（发行层可以分别摆放）
const TOOLBOX_DIR = process.env.QQ_TOOLBOX_DIR || path.join(path.resolve(__dirname, '..', '..'), 'dsh-plugins', 'dsh-thinking-zh')
const CLIENT = path.join(TOOLBOX_DIR, 'lib', 'client.js')
const ORIGIN = process.argv[2] || 'http://127.0.0.1:3080'

let pass = 0
let fail = 0
function check(label, ok, extra) {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${extra ? '  ' + extra : ''}`) }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? '  ' + extra : ''}`) }
}

/* ── 最小 DOM ──────────────────────────────────────────────────────────── */

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.childNodes = []
    this.parentNode = null
    this.style = {}
    this.dataset = {}
    this.attributes = {}
    this.className = ''
    this.id = ''
    this.value = ''
    this.disabled = false
    this.files = null
    this._text = ''
    this._html = ''
    this._listeners = {}
  }
  get textContent() {
    let s = this._text
    for (const c of this.childNodes) s += c.textContent
    return s
  }
  // 真实 DOM 里给 textContent 赋值会移除全部子节点
  set textContent(v) { this._text = String(v); this.childNodes = [] }
  get innerHTML() { return this._html }
  set innerHTML(v) { this._html = String(v) }
  appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c }
  setAttribute(k, v) { this.attributes[k] = String(v) }
  getAttribute(k) { return this.attributes[k] }
  addEventListener(ev, cb) { (this._listeners[ev] || (this._listeners[ev] = [])).push(cb) }
  removeEventListener(ev, cb) {
    const list = this._listeners[ev]
    if (!list) return
    const i = list.indexOf(cb)
    if (i >= 0) list.splice(i, 1)
  }
  click() { this.dispatch('click') }
  /** 事件会逐级冒泡到父节点，直到有人 stopPropagation —— 与浏览器一致。 */
  dispatch(type, detail) {
    const evt = Object.assign({ type, target: this, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true } }, detail || {})
    let node = this
    while (node) {
      for (const cb of (node._listeners[type] || []).slice()) cb(evt)
      if (evt.stopped) break
      node = node.parentNode
    }
    return evt
  }
  contains(node) {
    let cur = node
    while (cur) { if (cur === this) return true; cur = cur.parentNode }
    return false
  }
  matches(sel) {
    if (sel.startsWith('.')) return String(this.className).split(/\s+/).includes(sel.slice(1))
    const attr = /^([a-z]+)\[([\w-]+)\]$/.exec(sel)
    if (attr) return this.tagName === attr[1].toUpperCase() && this.dataset[attr[2]] !== undefined
    return this.tagName === sel.toUpperCase()
  }
  walk(out) {
    for (const c of this.childNodes) { out.push(c); c.walk(out) }
    return out
  }
  querySelector(sel) { return this.walk([]).find((n) => n.matches(sel)) || null }
  querySelectorAll(sel) { return this.walk([]).filter((n) => n.matches(sel)) }
  getBoundingClientRect() { return { width: 304, height: 220, top: 10, left: 10, right: 314, bottom: 230 } }
}

const body = new El('body')
const head = new El('head')

const documentMock = {
  readyState: 'complete',
  hidden: false,
  body,
  head,
  createElement: (t) => new El(t),
  getElementById: (id) => body.walk([]).find((n) => n.id === id) || null,
  addEventListener() {},
  removeEventListener() {},
}

class MockFileReader {
  readAsDataURL() { this.result = 'data:image/png;base64,AAAA'; if (this.onload) this.onload() }
}

/* ── 加载 client.js ───────────────────────────────────────────────────── */

const cookie = discoverDshSessionCookie(ORIGIN)
if (!cookie) { console.error('✗ 无法铸造 DSH Cookie'); process.exit(1) }
console.log(`目标 DSH: ${ORIGIN}（Cookie 已铸造）\n`)

const calls = []
async function proxiedFetch(url, options) {
  const opts = options || {}
  const method = String(opts.method || 'GET').toUpperCase()
  calls.push({ method, url })
  const res = await fetch(ORIGIN + url, {
    method,
    headers: Object.assign({ cookie }, opts.headers || {}),
    body: opts.body,
    signal: AbortSignal.timeout(40000),
  })
  const text = await res.text()
  return { ok: res.ok, status: res.status, json: async () => JSON.parse(text) }
}

let factory = null
const windowMock = {
  __ModuleLoader__: { load: (spec) => { factory = spec.factory } },
  localStorage: { getItem: () => null, setItem() {} },
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener() {},
  removeEventListener() {},
  prompt() { return null },
}

const src = fs.readFileSync(CLIENT, 'utf8')
// eslint-disable-next-line no-new-func
const run = new Function('window', 'document', 'FileReader', 'fetch', 'console', 'setTimeout', 'clearTimeout', src)
run(windowMock, documentMock, MockFileReader, proxiedFetch, console, setTimeout, clearTimeout)

check('client.js 注册到模块加载器', typeof factory === 'function')
const exportsObj = factory(function () { return {} })
check('client 半导出 apply()', typeof exportsObj.apply === 'function')

exportsObj.apply()
await new Promise((r) => setTimeout(r, 50))

const ball = body.walk([]).find((n) => String(n.className).includes('dsh-fb-ball'))
check('浮游球已挂到页面', !!ball)

/* ── 打开面板 ─────────────────────────────────────────────────────────── */

ball.dispatch('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 1 })
ball.dispatch('pointerup')
await new Promise((r) => setTimeout(r, 30))

let panel = body.walk([]).find((n) => String(n.className).includes('dsh-fb-panel'))
check('点击后展开面板', !!panel)

const rows = panel ? panel.querySelectorAll('.dsh-fb-row') : []
check('面板里有 2 个功能行', rows.length === 2, `实际 ${rows.length}`)

const gear = panel ? panel.querySelector('.dsh-fb-gear') : null
check('存在设置齿轮按钮', !!gear)

const fishRow = rows[1]
const fishTitle = fishRow ? fishRow.querySelector('b') : null
check('第二行是「QQ 大肥鱼」', fishTitle && fishTitle.textContent === 'QQ 大肥鱼', fishTitle ? fishTitle.textContent : '(无)')

/* ── 冒泡测试：点齿轮不能顺带切开关 ───────────────────────────────────── */

const before = calls.filter((c) => c.url.includes('/qq-bigfish/toggle')).length
gear.dispatch('click')
await new Promise((r) => setTimeout(r, 30))
const after = calls.filter((c) => c.url.includes('/qq-bigfish/toggle')).length
check('点齿轮没有触发开关切换（stopPropagation 生效）', after === before, `toggle 调用 ${before} → ${after}`)

/* ── 大设置窗口 ───────────────────────────────────────────────────────── */

let modal = body.walk([]).find((n) => String(n.className).includes('dsh-fb-modal'))
check('齿轮打开了设置窗口', !!modal)

const tabs = modal ? modal.querySelectorAll('.dsh-fb-tab') : []
check('窗口里有 8 个页签', tabs.length === 8, tabs.map((t) => t.textContent).join(' / '))

/* ── 逐个页签渲染（真实数据） ─────────────────────────────────────────── */

const tabNames = tabs.map((t) => t.textContent)
for (let i = 0; i < tabs.length; i++) {
  tabs[i].dispatch('click')
  await new Promise((r) => setTimeout(r, 5000))
  modal = body.walk([]).find((n) => String(n.className).includes('dsh-fb-modal'))
  const dlgBody = modal ? modal.querySelector('.dsh-fb-body') || modal.querySelector('.dsh-fb-dlg-body') : null
  const text = dlgBody ? dlgBody.textContent : ''
  console.log('      -> ' + String(text).slice(0, 110).replace(/\s+/g, ' '))
  const stuck = /加载中/.test(text)
  check(`页签「${tabNames[i]}」渲染完成`, !!dlgBody && !stuck && text.length > 0, `${text.length} 字符${stuck ? '（卡在加载中）' : ''}`)
}

/* ── 汇总 ─────────────────────────────────────────────────────────────── */

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
console.log(`（本次共向 DSH 发出 ${calls.length} 次请求）`)
process.exit(fail === 0 ? 0 : 1)