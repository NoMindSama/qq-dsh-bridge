/**
 * 工具箱 host 半的**离线**自检：不经过 DSH，直接 import feature 模块，
 * 用 mock 的 ctx.webServer 捕获它注册的路由，再逐个调用 handler。
 *
 * 为什么需要它：DSH 是否重新加载了插件代码不由我们控制，而这份检查能
 * 立刻回答「代码本身写对了吗」。两者互补。
 *
 * 用法：node tools/check-toolbox-host.mjs
 */
import * as feature from '../../dsh-plugins/dsh-thinking-zh/lib/features/qq-bigfish.js'

const routes = new Map()
const ctx = {
  webServer: {
    register({ path, handler }) {
      routes.set(path, handler)
      return () => routes.delete(path)
    },
  },
}

const dispose = feature.mount(ctx)
console.log(`feature id = ${feature.id}, 注册路由 ${routes.size} 个:`)
for (const p of routes.keys()) console.log('  · ' + p)
console.log('')

function mockRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(chunk) { this.body = String(chunk || '') },
  }
}

function mockReq(url, method = 'GET') {
  const listeners = {}
  return {
    url,
    method,
    headers: {},
    on(event, cb) { listeners[event] = cb; return this },
    destroy() {},
  }
}

const routesToTry = [
  '/dsh-thinking-zh/qq-bigfish',
  '/dsh-thinking-zh/qq-bigfish/settings',
  '/dsh-thinking-zh/qq-bigfish/persona',
  '/dsh-thinking-zh/qq-bigfish/tokens',
  '/dsh-thinking-zh/qq-bigfish/stickers',
  '/dsh-thinking-zh/qq-bigfish/backend',
  '/dsh-thinking-zh/qq-bigfish/diagnose',
]

let pass = 0
for (const path of routesToTry) {
  const handler = routes.get(path)
  if (!handler) {
    console.log(`✗ ${path} —— 未注册`)
    continue
  }
  const res = mockRes()
  try {
    await handler(mockReq(path), res)
    let parsed = null
    try { parsed = JSON.parse(res.body) } catch { /* 保留原文 */ }
    const okFlag = parsed && parsed.ok === true
    if (res.status === 200 && okFlag) pass += 1
    console.log(`${res.status === 200 && okFlag ? '✓' : '✗'} ${path}  →  HTTP ${res.status}`)
    if (parsed) {
      const brief = JSON.stringify(parsed)
      console.log(`     ${brief.length > 400 ? brief.slice(0, 400) + ' …' : brief}`)
    } else {
      console.log(`     ${res.body.slice(0, 200)}`)
    }
  } catch (error) {
    console.log(`✗ ${path}  →  抛错: ${error && error.message}`)
  }
}

try { dispose() } catch {}
console.log(`\n结果：${pass}/${routesToTry.length} 个路由返回 ok:true`)
process.exit(pass === routesToTry.length ? 0 : 1)