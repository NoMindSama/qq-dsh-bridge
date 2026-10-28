/**
 * Feature: qq-bigfish — 在浮游球工具箱里管理「QQ 大肥鱼」机器人。
 *
 * 设计原则
 * ────────
 * 1. 本 feature **不直接读** qq-bridge 的 state 文件，而是把请求代理到桥接自带的
 *    本地控制台 HTTP API（默认 127.0.0.1:3100）。原因是桥接是唯一知道"当前真相"
 *    的进程——会话映射、社交状态、唤醒计时器、token 账本都在它内存里；直接读文件
 *    会看到过期快照。副作用是桥接升级时这里基本不用改。
 * 2. 控制台令牌只留在 host 侧，绝不发给页面。
 * 3. 找桥接目录**不需要用户配置**：setup-dsh.mjs 会把
 *    `<bridge>/plugins/qq-mode-console` 以 junction 挂到 `~/.dsh/plugins/` 下，
 *    解析这个链接再往上退两级就是仓库根。
 * 4. 写 `socialV2.config` 时**先读完整对象再整体写回**：该接口是浅合并，
 *    子对象（send/wait/wake…）会被整段替换，只发局部字段会清掉其余配置。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const LOCAL_STATE_FILE = path.join(DSH_HOME, '.dsh-qq-bigfish.json')

export const id = 'qq-bigfish'
export const title = 'QQ 大肥鱼'
export const hint = '把 DeepSeek 部署到 QQ 群'
export const routePath = '/dsh-thinking-zh/qq-bigfish'

/** 子路由：client 半按需调用，全部是精确路径（与 thinking-zh 同一套注册方式）。 */
export const ROUTES = {
  status: routePath,
  toggle: `${routePath}/toggle`,
  settings: `${routePath}/settings`,
  persona: `${routePath}/persona`,
  tokens: `${routePath}/tokens`,
  stickers: `${routePath}/stickers`,
  launchSnowluma: `${routePath}/launch-snowluma`,
  openSnowluma: `${routePath}/open-snowluma`,
  access: `${routePath}/access`,
  backend: `${routePath}/backend`,
  diagnose: `${routePath}/diagnose`,
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// ── 基础设施 ────────────────────────────────────────────────────────────────

function json(res, status, payload) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(payload))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 8 * 1024 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJsonBody(req) {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
    throw new Error('expected application/json')
  }
  const text = await readBody(req)
  return text ? JSON.parse(text) : {}
}

/** 定位 qq-bridge 目录（优先环境变量，其次 ~/.dsh/plugins 下的 junction）。 */
function findBridgeDir() {
  const fromEnv = process.env.QQ_BRIDGE_DIR
  if (fromEnv) {
    const dir = path.resolve(fromEnv)
    if (fs.existsSync(path.join(dir, 'config.json'))) return dir
  }
  for (const name of ['qq-mode-console', 'qq-agent-presets']) {
    try {
      // realpathSync 会解析 Windows junction / 符号链接，得到仓库里的真实目录
      const real = fs.realpathSync(path.join(DSH_HOME, 'plugins', name))
      const dir = path.dirname(path.dirname(real))
      if (fs.existsSync(path.join(dir, 'config.json'))) return dir
    } catch { /* 链接不存在或不可解析，试下一个 */ }
  }
  return null
}

function bridgeEnv() {
  const dir = findBridgeDir()
  if (!dir) {
    return {
      ok: false,
      error: '找不到 qq-bridge。~/.dsh/plugins 下没有 qq-mode-console 链接；请先在 qq-bridge 目录里跑 node scripts/setup-dsh.mjs',
    }
  }
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) } catch { /* 用默认端口 */ }
  let token = ''
  try { token = fs.readFileSync(path.join(dir, 'state', 'console-token'), 'utf8').trim() } catch { /* 无令牌 */ }
  const port = Number(cfg.consolePort) || 3100
  return { ok: true, dir, cfg, token, port, base: `http://127.0.0.1:${port}` }
}

/** 代理一次调用到桥接控制台。永远 resolve，失败信息放在返回值里。 */
async function bridgeApi(env, apiPath, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const headers = {}
  if (env.token) headers['x-console-token'] = env.token
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    const res = await fetch(env.base + apiPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let data
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text.slice(0, 500) } }
    return { ok: res.ok, status: res.status, data }
  } catch (error) {
    return { ok: false, status: 0, error: String((error && error.message) || error) }
  }
}

function readLocalState() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCAL_STATE_FILE, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}

function writeLocalState(patch) {
  const next = { ...readLocalState(), ...(patch && typeof patch === 'object' ? patch : {}) }
  try {
    fs.mkdirSync(path.dirname(LOCAL_STATE_FILE), { recursive: true })
    const tmp = `${LOCAL_STATE_FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, LOCAL_STATE_FILE)
  } catch { /* 本地偏好写不进去不影响主流程 */ }
  return next
}

/**
 * 发现本机的 DSH 实例与端口。
 *
 * 桌面端端口由 Electron 运行时分配（实测 62295，但不应假设固定），所以按
 * 「进程 → 它监听的回环端口」反查。仅 Windows 实现；其他平台返回空数组，
 * 工具箱会退化成"只显示当前配置"。
 */
let backendCache = { at: 0, list: [] }

async function discoverBackends() {
  if (process.platform !== 'win32') return []
  // 5 秒缓存。这个函数要 spawn PowerShell（首次约 1~3 秒）；早期版本用的是
  // execFileSync —— 那是**同步阻塞**，等待期间会把整个 host 半卡住，
  // 连带把别的页签（诊断）的请求一起拖住。改为异步 + 缓存后，
  // 首次仍要等，之后 5 秒内直接命中缓存。
  const now = Date.now()
  if (now - backendCache.at < 30000) return backendCache.list
  const script = [
    '$out = @()',
    "foreach ($p in (Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" -ErrorAction SilentlyContinue)) {",
    "  if ($p.CommandLine -match '--type=') { continue }",
    '  $c = Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq \'127.0.0.1\' } | Select-Object -First 1',
    "  if ($c) { $out += [pscustomobject]@{ kind = 'desktop'; pid = $p.ProcessId; port = $c.LocalPort } }",
    '}',
    "foreach ($p in (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue)) {",
    "  if ($p.CommandLine -notmatch '@deepseek-ai[\\\\/]dsh[\\\\/]lib[\\\\/]bin\\.js') { continue }",
    '  $c = Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq \'127.0.0.1\' } | Select-Object -First 1',
    "  if ($c) { $out += [pscustomobject]@{ kind = 'cli'; pid = $p.ProcessId; port = $c.LocalPort } }",
    '}',
    '$out | ConvertTo-Json -Compress',
  ].join('\n')
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    })
    const raw = String(stdout || '').trim()
    if (!raw) {
      backendCache = { at: now, list: [] }
      return []
    }
    const parsed = JSON.parse(raw)
    const list = (Array.isArray(parsed) ? parsed : [parsed])
      .filter((item) => item && item.port)
      .map((item) => ({
        kind: item.kind,
        pid: item.pid,
        port: Number(item.port),
        url: `http://127.0.0.1:${item.port}`,
        label: item.kind === 'desktop' ? '桌面端 DSH' : 'CLI DSH',
      }))
    backendCache = { at: now, list }
    return list
  } catch {
    return backendCache.list
  }
}

// ── 各路由的实现 ────────────────────────────────────────────────────────────

/** GET 状态：桥接在哪、DSH 就绪没、上线/下线、SnowLuma 上游健康。 */
async function handleStatus(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  const r = await bridgeApi(env, '/api/status')
  if (!r.ok) {
    return json(res, 200, {
      ok: false,
      error: r.error || `桥接控制台返回 HTTP ${r.status}`,
      bridge: { dir: env.dir, port: env.port, running: false },
    })
  }
  const s = r.data || {}
  const online = s.socialV2Paused !== true
  return json(res, 200, {
    ok: true,
    // `state` 是浮游球面板通用的形状（client 半据此渲染开关）；其余字段供设置窗口用。
    state: { online },
    online,
    paused: s.socialV2Paused === true,
    dshReady: s.dshReady === true,
    mode: s.mode ?? null,
    role: s.role ?? null,
    roleMode: s.roleMode ?? null,
    ownerQQ: s.ownerQQ ?? null,
    allowPrivate: s.allowPrivate ?? [],
    allowGroups: s.allowGroups ?? [],
    snowluma: s.snowluma ?? null,
    bridge: {
      dir: env.dir,
      port: env.port,
      running: true,
      baseUrl: env.cfg?.dsh?.baseUrl ?? '',
      consoleUrl: env.base,
    },
    local: readLocalState(),
  })
}

/** POST 上线/下线：{ online: boolean } → socialV2.paused = !online。 */
async function handleToggle(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })
  let body
  try { body = await readJsonBody(req) } catch (error) { return json(res, 400, { ok: false, error: String(error.message || error) }) }
  const online = body.online === true
  const r = await bridgeApi(env, '/api/socialV2/activity', { method: 'POST', body: { paused: !online } })
  if (!r.ok) return json(res, 200, { ok: false, error: r.error || `HTTP ${r.status}` })
  return json(res, 200, { ok: true, state: { online }, online, paused: !online })
}

/** GET/POST 回复节奏（socialV2 的 send/wait/wake/context + autoReplyCheckMs）。 */
async function handleSettings(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  const current = await bridgeApi(env, '/api/socialV2/config')
  if (!current.ok) return json(res, 200, { ok: false, error: current.error || `HTTP ${current.status}` })
  const full = (current.data && current.data.config) || {}

  if ((req.method || 'GET') === 'GET') {
    const effort = await bridgeApi(env, '/api/dsh/model')
    return json(res, 200, {
      ok: true,
      rhythm: {
        autoReplyCheckMs: full.autoReplyCheckMs,
        send: full.send ?? {},
        wait: full.wait ?? {},
        wake: full.wake ?? {},
        context: full.context ?? {},
        proactive: full.proactive ?? {},
        // QQ 空间：它只是一个工具，这里只控制「能不能发 / 一天最多几条」，
        // 不控制"什么时候发" —— 那由它自己或操作者临场决定。
        qzone: full.qzone ?? {},
      },
      model: effort.ok ? effort.data : null,
      paused: full.paused === true,
    })
  }

  let body
  try { body = await readJsonBody(req) } catch (error) { return json(res, 400, { ok: false, error: String(error.message || error) }) }

  // ★ 必须是「完整对象整体写回」：该接口浅合并，子对象会被整段替换。
  const next = { ...full, ...(body.rhythm || {}) }
  if (body.paused !== undefined) next.paused = body.paused === true
  const saved = await bridgeApi(env, '/api/socialV2/config', { method: 'POST', body: next })
  if (!saved.ok) return json(res, 200, { ok: false, error: saved.error || `HTTP ${saved.status}` })
  return json(res, 200, { ok: true, saved: saved.data })
}

/** GET/POST 人格（角色卡）。GET 带 ?name= 时返回该角色全文。 */
async function handlePersona(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const name = url.searchParams.get('name')

  if ((req.method || 'GET') === 'GET') {
    if (name) {
      const one = await bridgeApi(env, `/api/roles/content?name=${encodeURIComponent(name)}`)
      return json(res, 200, one.ok ? { ok: true, ...(one.data || {}) } : { ok: false, error: one.error || `HTTP ${one.status}` })
    }
    const list = await bridgeApi(env, '/api/roles')
    return json(res, 200, list.ok ? { ok: true, ...(list.data || {}) } : { ok: false, error: list.error || `HTTP ${list.status}` })
  }

  let body
  try { body = await readJsonBody(req) } catch (error) { return json(res, 400, { ok: false, error: String(error.message || error) }) }
  const action = String(body.action || '')

  if (action === 'save') {
    // 已存在则 update，否则 create —— 先查列表，避免把已有角色当新建而报错
    const list = await bridgeApi(env, '/api/roles')
    const names = (list.data && Array.isArray(list.data.roles)) ? list.data.roles : []
    const exists = names.includes(body.name)
    const r = await bridgeApi(env, exists ? '/api/roles/update' : '/api/roles/create', {
      method: 'POST',
      body: { name: body.name, content: body.content },
    })
    return json(res, 200, r.ok ? { ok: true, created: !exists, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  if (action === 'activate') {
    // 桥接的 /api/role 认的是 `role`（传 null 表示清除）。这里以前传 `name`，
    // 桥接只认 role 时会把 undefined 当成"清除"，于是点「设为当前角色」反而
    // 把角色清空了，还回 ok:true。字段名必须和桥接对齐。
    const r = await bridgeApi(env, '/api/role', { method: 'POST', body: { role: body.name || null } })
    return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  if (action === 'delete') {
    const r = await bridgeApi(env, '/api/roles/delete', { method: 'POST', body: { name: body.name } })
    return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  if (action === 'limit') {
    const r = await bridgeApi(env, '/api/roles/limit', { method: 'POST', body: { injectMaxChars: Number(body.injectMaxChars) } })
    return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  return json(res, 400, { ok: false, error: `未知 action: ${action}` })
}

/** GET Token 用量与花费（桥接按 provider 上报的 usage 折叠，价格来自价目表）。 */
async function handleTokens(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const window = url.searchParams.get('window') || 'today'
  const r = await bridgeApi(env, `/api/tokens/summary?window=${encodeURIComponent(window)}`)
  return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
}

/** GET/POST 表情素材：列出、上传（加进 QQ 收藏）、改备注、删除、强制同步。 */
async function handleStickers(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  if ((req.method || 'GET') === 'GET') {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const count = url.searchParams.get('count') || '60'
    const r = await bridgeApi(env, `/api/stickers?count=${encodeURIComponent(count)}`, { timeoutMs: 60000 })
    return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  let body
  try { body = await readJsonBody(req) } catch (error) { return json(res, 400, { ok: false, error: String(error.message || error) }) }
  const action = String(body.action || '')

  const forward = async (apiPath, payload, timeoutMs) => {
    const r = await bridgeApi(env, apiPath, { method: 'POST', body: payload, timeoutMs })
    return r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` }
  }

  // 上传的 base64 会经此转发到桥接；图片本体上限由桥接的 socialV2.sticker.uploadMaxBytes 把关。
  if (action === 'upload') {
    if (!body.data) return json(res, 400, { ok: false, error: 'data 不能为空' })
    return json(res, 200, await forward('/api/stickers/upload', { data: body.data, note: body.note }, 180000))
  }
  if (action === 'sync') return json(res, 200, await forward('/api/stickers/sync', {}, 90000))
  if (action === 'note') return json(res, 200, await forward('/api/stickers/note', { stickerId: body.stickerId, note: body.note, tags: body.tags, usage: body.usage }))
  if (action === 'remark') return json(res, 200, await forward('/api/stickers/remark', { stickerId: body.stickerId, remark: body.remark }, 60000))
  if (action === 'delete') return json(res, 200, await forward('/api/stickers/delete', { stickerId: body.stickerId }, 60000))
  return json(res, 400, { ok: false, error: `未知 action: ${action}` })
}

// ── SnowLuma 的启动与打开 ─────────────────────────────────────────────────
//
// ⚠️ 合规边界（写在最前面，方便日后回看）：SnowLuma 的 EULA §5.4 规定「将其并入
// 第三方安装包或 Docker 镜像、通过自动化脚本部署」须事先取得书面授权。上游
// qq-bridge 因此只探测、不部署，并在 0.2.1 删掉了早期版本的 start_snowluma /
// stop_snowluma 与 allowProcessControl 开关。
//
// 这里采取的是**本机自用**取向的折中，边界卡在三点上：
//   1. 不下载、不解压、不打包、不分发 SnowLuma —— 只启动你机器上**已经存在**的
//      launcher.bat，路径完全来自 config.json 的 snowluma.launcherPath / homeDir；
//   2. 只在你**点击按钮**时触发，没有任何自动或定时启动；
//   3. 保留配置层开关 snowluma.allowProcessControl，显式设为 false 即彻底禁用。
//
// 若日后要对外分发，请把 allowProcessControl 默认置 false（或删掉这两条路由），
// 以与上游一致的「只探测不部署」姿态发布。

/** 探一下端口是否有人监听（判断 SnowLuma 是否已经起来）。 */
function probePort(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function waitForPorts(ports, totalMs) {
  const deadline = Date.now() + totalMs
  for (;;) {
    const results = await Promise.all(ports.map((p) => probePort(p)))
    if (results.every(Boolean)) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 1500))
  }
}

/** POST 启动本机已安装的 SnowLuma。 */
async function handleLaunchSnowluma(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  if (env.cfg?.snowluma?.allowProcessControl === false) {
    return json(res, 403, {
      ok: false,
      error: 'config.json 里 snowluma.allowProcessControl 为 false —— 已在配置层禁用代启动。要启用就把它改成 true 或删掉这一项。',
    })
  }

  if (await probePort(3001)) {
    return json(res, 200, { ok: true, already: true, message: 'SnowLuma 似乎已经在运行（3001 已在监听）' })
  }

  const homeDir = String(env.cfg?.snowluma?.homeDir || '').trim()
  let launcher = String(env.cfg?.snowluma?.launcherPath || '').trim()
  if (!launcher && homeDir) launcher = path.join(homeDir, 'launcher.bat')
  if (!launcher || !fs.existsSync(launcher)) {
    return json(res, 200, {
      ok: false,
      error: `找不到 SnowLuma 启动器：${launcher || '(未配置)'}。请在 config.json 里设置 snowluma.launcherPath 或 snowluma.homeDir。`,
    })
  }

  try {
    // detached + unref：SnowLuma 必须独立于 DSH 的生命周期，否则 DSH 一重启就把它带走。
    // stdio:'ignore'：它的输出很多，捕获会撑满管道缓冲把进程卡死（同类坑踩过一次）。
    // cwd 设为安装目录：launcher.bat 里用的是相对路径（node ./index.mjs）。
    const child = spawn('cmd.exe', ['/c', 'start', '', launcher], {
      cwd: path.dirname(launcher),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.unref()
  } catch (error) {
    return json(res, 500, { ok: false, error: `启动失败：${String(error?.message ?? error)}` })
  }

  const ready = await waitForPorts([3000, 3001], 45000)

  // 端口就绪 ≠ 桥接已连上：桥接对 SnowLuma 用的是**指数退避**重连，
  // 反复失败后实测间隔可达 30 秒。所以这里继续轮询桥接状态，
  // 等到真正 connected 再返回 —— 否则用户会以为「启动了但没反应」。
  let connected = false
  if (ready) {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      const st = await bridgeApi(env, '/api/status', { timeoutMs: 8000 })
      if (st.ok && st.data?.snowluma?.connected === true) { connected = true; break }
      await new Promise((r) => setTimeout(r, 2500))
    }
  }

  return json(res, 200, {
    ok: true,
    launched: true,
    ready,
    connected,
    launcher,
    message: !ready
      ? '进程已启动，但 45 秒内没等到 3000/3001 监听。可能需要在 WebUI 里扫码登录，或它启动得比较慢 —— 点「打开 WebUI」看看。'
      : connected
        ? 'SnowLuma 已启动，桥接也已连上。'
        : 'SnowLuma 已启动（端口在监听），但桥接还没连上 —— 它用的指数退避可能要再等一会儿，稍后刷新本页即可。',
  })
}

/** GET 打开 SnowLuma 的 WebUI 或安装目录。 */
async function handleOpenSnowluma(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const target = url.searchParams.get('target') || 'webui'
  const homeDir = String(env.cfg?.snowluma?.homeDir || '').trim()

  let openTarget = ''
  if (target === 'webui') {
    let port = 5099
    try {
      const runtime = JSON.parse(fs.readFileSync(path.join(homeDir, 'config', 'runtime.json'), 'utf8'))
      if (Number(runtime?.webuiPort) > 0) port = Number(runtime.webuiPort)
    } catch { /* 用默认端口 */ }
    openTarget = `http://127.0.0.1:${port}`
  } else if (target === 'dir') {
    if (!homeDir || !fs.existsSync(homeDir)) {
      return json(res, 200, { ok: false, error: `SnowLuma 目录不存在：${homeDir || '(未配置 snowluma.homeDir)'}` })
    }
    openTarget = homeDir
  } else {
    return json(res, 400, { ok: false, error: `未知 target: ${target}` })
  }

  try {
    const child = spawn('cmd.exe', ['/c', 'start', '', openTarget], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return json(res, 200, { ok: true, opened: openTarget })
  } catch (error) {
    return json(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
}

/** GET/POST 访问控制：白名单 / 黑名单 / 管理员。
 *
 * 桥接侧已经有 GET+POST /api/whitelist，且 deny 在事件入口就 return（消息不入库、
 * 不进上下文）。这里只是把它包装成「新手也能点」的接口：
 *   · 一键踢出 = 从 allow 移除 + 加入 deny（全链路静默）
 *   · 解除拉黑 = 从 deny 移除并回到 allow
 * allow / deny 互斥，避免同一个 id 同时出现在两个名单里造成语义歧义。
 * 注意：这里**不写 ownerQQ**（不传该字段 = 桥接保留原值），改管理员请去桥接控制台。
 */
async function handleAccess(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  if ((req.method || 'GET') === 'GET') {
    const r = await bridgeApi(env, '/api/whitelist', { timeoutMs: 15000 })
    return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  let body
  try { body = await readJsonBody(req) } catch (error) {
    return json(res, 400, { ok: false, error: String(error.message || error) })
  }

  // 先读现状再改，避免并发覆盖（桥接的 POST 是部分更新，但这里要整体回写）
  const cur = await bridgeApi(env, '/api/whitelist', { timeoutMs: 15000 })
  if (!cur.ok) return json(res, 200, { ok: false, error: cur.error || '读不到当前名单，已放弃写入' })

  const allow = {
    private: [...(cur.data?.allow?.private || [])],
    groups: [...(cur.data?.allow?.groups || [])],
  }
  const deny = {
    private: [...(cur.data?.deny?.private || [])],
    groups: [...(cur.data?.deny?.groups || [])],
  }

  const action = String(body.action || '')
  const bucket = body.kind === 'group' ? 'groups' : 'private'
  const idNum = Number(String(body.id ?? '').trim())
  const drop = (arr, n) => { const i = arr.indexOf(n); if (i >= 0) arr.splice(i, 1) }

  if (action === 'allow' || action === 'block' || action === 'unblock') {
    if (!Number.isInteger(idNum) || idNum <= 0) {
      return json(res, 400, { ok: false, error: 'id 必须是正整数（QQ 号或群号）' })
    }
    if (action === 'block') {
      drop(allow[bucket], idNum)
      if (!deny[bucket].includes(idNum)) deny[bucket].push(idNum)
    } else if (action === 'unblock') {
      drop(deny[bucket], idNum)
      if (!allow[bucket].includes(idNum)) allow[bucket].push(idNum)
    } else {
      drop(deny[bucket], idNum)
      if (!allow[bucket].includes(idNum)) allow[bucket].push(idNum)
    }
  } else if (action === 'drop') {
    if (!Number.isInteger(idNum) || idNum <= 0) return json(res, 400, { ok: false, error: 'id 无效' })
    drop(allow[bucket], idNum)
    drop(deny[bucket], idNum)
  } else {
    return json(res, 400, { ok: false, error: `未知 action: ${action}` })
  }

  const r = await bridgeApi(env, '/api/whitelist', {
    method: 'POST',
    body: { allow, deny },
    timeoutMs: 20000,
  })
  return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
}

/** GET/POST 后端（DSH 实例）：列出发现结果，或切换 baseUrl。 */
async function handleBackend(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  if ((req.method || 'GET') === 'GET') {
    const backends = await discoverBackends()
    const currentUrl = String(env.cfg?.dsh?.baseUrl || '').replace(/\/+$/, '')
    return json(res, 200, {
      ok: true,
      current: currentUrl,
      backends: backends.map((b) => ({ ...b, current: b.url === currentUrl })),
      supported: process.platform === 'win32',
    })
  }

  let body
  try { body = await readJsonBody(req) } catch (error) { return json(res, 400, { ok: false, error: String(error.message || error) }) }
  const targetUrl = String(body.url || '').replace(/\/+$/, '')
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(targetUrl)) {
    return json(res, 400, { ok: false, error: '只接受 http://127.0.0.1:<port> 形式的后端地址' })
  }

  // 只替换 baseUrl 一行，其余配置原样保留（不重新序列化整个 JSON）
  const configPath = path.join(env.dir, 'config.json')
  let raw
  try { raw = fs.readFileSync(configPath, 'utf8') } catch (error) { return json(res, 500, { ok: false, error: String(error.message || error) }) }
  const patched = raw.replace(/("baseUrl"\s*:\s*")[^"]*(")/, `$1${targetUrl}$2`)
  if (patched === raw && !raw.includes(targetUrl)) {
    return json(res, 500, { ok: false, error: 'config.json 里没有 dsh.baseUrl 字段' })
  }
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    fs.copyFileSync(configPath, path.join(env.dir, 'state', `config.json.bak-${stamp}`))
    fs.writeFileSync(configPath, patched, 'utf8')
  } catch (error) {
    return json(res, 500, { ok: false, error: `写入 config.json 失败: ${String(error.message || error)}` })
  }

  // 切换后让下次 discovery 重新探测，而不是拿 30 秒内的旧列表
  backendCache = { at: 0, list: [] }

  // 桥接自带重启端点：写完立刻生效
  const restarted = await bridgeApi(env, '/api/restart', { method: 'POST', body: {} })
  return json(res, 200, {
    ok: true,
    backend: targetUrl,
    restarted: restarted.ok,
    restartNote: restarted.ok ? '桥接已重启' : `已写入配置，但自动重启失败（${restarted.error || restarted.status}），请手动重启桥接`,
  })
}

/** GET 连接诊断：一次把排查要看的都拿齐。 */
async function handleDiagnose(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  const [status, presets, model] = await Promise.all([
    bridgeApi(env, '/api/status'),
    bridgeApi(env, '/api/presets'),
    bridgeApi(env, '/api/dsh/model'),
  ])
  const s = (status.data || {})
  const presetIds = (presets.data && Array.isArray(presets.data.presets)) ? presets.data.presets.map((p) => p.id) : []
  const checks = [
    { name: '桥接控制台可达', ok: status.ok, detail: status.ok ? env.base : (status.error || `HTTP ${status.status}`) },
    { name: 'DSH 已就绪', ok: s.dshReady === true, detail: s.dshReady === true ? `模式 ${s.mode}` : '桥接连不上 DSH（看 state/bridge.log）' },
    { name: 'SnowLuma 已连接', ok: s.snowluma?.connected === true, detail: s.snowluma?.connected ? `账号在线=${s.snowluma.accountOnline}` : 'WebSocket 未连接' },
    { name: 'SnowLuma 上游健康', ok: s.snowluma?.good === true, detail: s.snowluma?.good ? `来源 ${s.snowluma.goodSource || 'heartbeat'}` : (s.snowluma?.hint || '收不到 QQ 数据（注入退化）') },
    { name: 'qq-chat-v2 preset 已装', ok: presetIds.includes('qq-chat-v2'), detail: presetIds.length ? presetIds.join(', ') : '拿不到 preset 列表' },
    { name: '机器人上线中', ok: s.socialV2Paused !== true, detail: s.socialV2Paused === true ? '当前处于下线（暂停）状态' : '正常' },
  ]
  return json(res, 200, {
    ok: checks.every((c) => c.ok),
    checks,
    model: model.ok ? model.data : null,
    bridge: { dir: env.dir, port: env.port, baseUrl: env.cfg?.dsh?.baseUrl ?? '' },
  })
}

// ── 挂载 ────────────────────────────────────────────────────────────────────

export function mount(ctx) {
  // 预热后端发现：首次要 spawn PowerShell（实测 1~3 秒）。这里后台跑一次，
  // 于是用户点开「后端」页签时多半已命中 5 秒缓存，而不是先看到"加载中…"。
  discoverBackends().catch(() => {})

  const table = [
    [ROUTES.status, handleStatus],
    [ROUTES.toggle, handleToggle],
    [ROUTES.settings, handleSettings],
    [ROUTES.persona, handlePersona],
    [ROUTES.tokens, handleTokens],
    [ROUTES.stickers, handleStickers],
    [ROUTES.launchSnowluma, handleLaunchSnowluma],
    [ROUTES.openSnowluma, handleOpenSnowluma],
    [ROUTES.access, handleAccess],
    [ROUTES.backend, handleBackend],
    [ROUTES.diagnose, handleDiagnose],
  ]

  const disposers = table.map(([routePath, impl]) =>
    ctx.webServer.register({
      kind: 'exact',
      path: routePath,
      handler: async (req, res) => {
        try {
          await impl(req, res)
        } catch (error) {
          try { json(res, 500, { ok: false, error: String((error && error.message) || error) }) } catch {}
        }
      },
    })
  )

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  }
}