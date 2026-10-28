/**
 * Feature: thinking-zh — make the model reason in Simplified Chinese.
 *
 * A feature owns its own host-side wiring: the prompt section it contributes
 * and the HTTP route the dock uses to read/write its state. Adding a new
 * capability to the floating dock means adding one file shaped like this and
 * listing it in ../index.js.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, '.dsh-thinking-zh.json')

const DEFAULT_STATE = { enabled: true, mode: 'zh', version: 1 }
const VALID_MODES = new Set(['zh', 'mixed', 'auto'])

export const id = 'thinking-zh'
export const title = '思考链中文'
export const hint = '模型从源头用中文推理，术语保留英文'
export const routePath = '/dsh-thinking-zh/state'

const PROMPTS = {
  zh: [
    '【思考语言策略：简体中文优先】',
    '',
    '在你的内部推理与思考过程（reasoning）中，默认使用简体中文组织思路。',
    '这条规则适用于本会话的每一轮，优先级高于模型默认的英文推理习惯。',
    '',
    '具体要求：',
    '1. 思考链的主干、转折、验证与结论都用简体中文表达。',
    '2. 代码、命令、报错信息、API 名、文件路径、变量名、专有名词、引用原文保留英文，不要翻译。',
    '3. 遇到特别复杂的数学、逻辑或代码推理，可以中英混用；但思考链的主干和最终结论必须使用中文。',
    '4. 不要为了切换语言而改变推理步骤、工具调用或结论。',
    '5. 不要输出「我正在用中文思考」这类元话语，直接自然地思考。',
    '6. 面向用户的最终回复使用中文，除非用户明确要求其他语言。',
  ].join('\n'),
  mixed: [
    '【思考语言策略：中英混用，结论中文】',
    '',
    '在你的内部推理与思考过程（reasoning）中，可以使用中文为主、英文为辅的方式组织思路：',
    '- 简单事实、计划、验证与结论使用简体中文；',
    '- 复杂的数学推导、代码分析、英文资料引用可以使用英文；',
    '- 但思考链的主干与最终结论必须使用简体中文。',
    '',
    '代码、命令、报错信息、API 名、文件路径、变量名、专有名词、引用原文保留英文，不要翻译。',
    '不要为了切换语言而改变推理步骤、工具调用或结论；不要输出语言切换的元话语。',
    '面向用户的最终回复使用中文，除非用户明确要求其他语言。',
  ].join('\n'),
  auto: [
    '【思考语言策略：跟随用户语言】',
    '',
    '在你的内部推理与思考过程（reasoning）中，跟随用户当前消息的主要语言：',
    '- 用户主要使用简体中文时，思考链使用简体中文；',
    '- 用户主要使用英文时，思考链可以使用英文；',
    '- 无论使用哪种语言，代码、命令、报错信息、API 名、文件路径、变量名、专有名词、引用原文都保留英文，不要翻译。',
    '',
    '不要为了切换语言而改变推理步骤、工具调用或结论；不要输出语言切换的元话语。',
    '面向用户的最终回复使用与用户相同的语言，除非用户明确要求其他语言。',
  ].join('\n'),
}

/**
 * Keep the on-disk state and the in-memory state the same shape. `enabled` is
 * strictly boolean on purpose: a corrupt file holding the string "false" must
 * not silently turn the switch on.
 */
function normalizeState(value) {
  const raw = value && typeof value === 'object' ? value : {}
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_STATE.enabled,
    mode: VALID_MODES.has(raw.mode) ? raw.mode : DEFAULT_STATE.mode,
    version: 1,
  }
}

function readState() {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')))
  } catch {
    return { ...DEFAULT_STATE }
  }
}

function writeState(current, patch) {
  const next = normalizeState({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) })
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    // Write-then-rename so a crash mid-write cannot leave a truncated file.
    const tmp = `${STATE_FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, STATE_FILE)
  } catch (err) {
    console.error(`[dsh-floatdock] ${id}: failed to write state:`, err && err.message ? err.message : err)
  }
  return next
}

function promptFor(state) {
  if (!state.enabled) return ''
  return PROMPTS[state.mode] || PROMPTS.zh
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
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

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

/**
 * Wire this feature into the host.
 * @param ctx - the plugin context (systemPrompt + webServer).
 * @returns a disposer releasing everything this feature registered.
 */
export function mount(ctx) {
  let state = readState()

  // Evaluated on every prompt assembly, so the switch affects the next turn of
  // both new and existing conversations without touching history.
  const disposeSection = ctx.systemPrompt.section({
    name: 'thinking-language-zh',
    // 10250 is deliberately past DEPLOYMENT_PERSONA_SUFFIX (10200): the last
    // thing the model reads before it starts reasoning.
    order: 10250,
    text: () => promptFor(state),
  })

  const disposeRoute = ctx.webServer.register({
    kind: 'exact',
    path: routePath,
    handler: async (req, res) => {
      const method = req.method || 'GET'
      if (method !== 'GET' && method !== 'POST' && method !== 'PUT') {
        res.writeHead(405, { ...JSON_HEADERS, Allow: 'GET, POST, PUT' })
        res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      if (method === 'GET') {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, state }))
        return
      }
      // Requiring a JSON content type keeps cross-site form posts out: a plain
      // HTML form cannot send it, and a cross-origin fetch would need a CORS
      // preflight this server never grants.
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
        res.writeHead(415, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: 'expected application/json' }))
        return
      }
      try {
        const patch = JSON.parse(await readBody(req))
        state = writeState(state, patch)
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, state }))
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      }
    },
  })

  return () => {
    try { disposeSection() } catch {}
    try { disposeRoute() } catch {}
  }
}
