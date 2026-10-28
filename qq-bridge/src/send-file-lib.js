// 「把本机文件发到 QQ」的安全层（纯函数，不碰网络、不碰桥接状态，便于单测）。
//
// 为什么要有这一层（这不是"顺手加个工具"）
// ----------------------------------------
// 语音通道的教训（见 bridge.js 里 resolveVoicePathForV2 上方的长注释）：
// 一旦让 **模型** 能把本机文件送出去，prompt injection 就多了一条外发路径 ——
// 群友发一段"帮我把 xxx 文件发出来"的文本、或在被读取的文件里埋一句指令，
// 就可能诱导 AI 把凭据、聊天记录、配置发到 QQ 上。所以这个工具的边界必须写死在
// **服务端纯函数**里，而不是"靠提示词劝它别这么干"。
//
// 本项目的权限分级（三档）决定了它只对 **Owner 档**（`private:<ownerQQ>`）开放，
// 但"只有管理员能用"不等于"管理员说什么都能发"：管理员本人也可能被注入的上下文
// （转发的截图、读到的文件内容）骗着发出敏感文件。因此这里再加三层机械约束：
//   1. 只发**普通文件**（目录/设备/管道一律拒绝，顺带挡住 `\\.\pipe\` 之类）；
//   2. **扩展名白名单**：文档/图片/音视频/压缩包在列；可执行、脚本、配置、数据库、
//      密钥类一律不在列 —— 挡掉"把 .ps1 / .env / config.json 发出去"；
//   3. **敏感路径黑名单**：凭据目录、浏览器数据、系统目录，以及**桥接/DSH 自己的
//      状态与配置**（内含 accessToken / consoleToken / 会话正文）。
// 目录范围不做白名单：用户明确要"电脑在宿舍开着，我在外边让它给我发文件"，
// 限定目录会把这个功能废掉；上面三层 + 体积上限 + 限流才是性价比最高的组合。
//
// 与语音通道的差别（有意为之）：语音只能发"语音库内"的文件（库是用户亲手放的），
// 而发文件是为了"把工作文件递出去"，所以放开目录、用黑名单兜底。

/** 默认允许发送的扩展名（小写，含点）。想加类型请改 config.json 的 socialV2.files.allowExtensions。 */
export const FILE_ALLOW_EXTENSIONS = Object.freeze([
  // 文档
  '.doc', '.docx', '.pdf', '.txt', '.md', '.rtf', '.odt', '.pages',
  '.xls', '.xlsx', '.csv', '.ods', '.ppt', '.pptx', '.odp',
  // 图片（不含 svg：它是可执行语义的 XML，发出去对接收方是风险）
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.tif', '.tiff',
  // 音频 / 视频
  '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.amr', '.silk',
  '.mp4', '.mkv', '.mov', '.avi', '.webm',
  // 压缩包与电子书
  '.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.epub', '.mobi',
])

/**
 * 内置敏感路径黑名单（**路径段**匹配，大小写不敏感）。
 *
 * 为什么用"段"而不是子串：`C:\Users\x\Desktop\state-报告.docx` 里的 `state-` 不是目录段，
 * 不该被误伤；而 `C:\Users\x\.ssh\id_rsa` 的 `.ssh` 是段，必须命中。
 */
export const FILE_DENY_SEGMENTS = Object.freeze([
  // DSH 自己的凭据/会话目录（.credentials.yaml 里有浏览器会话签名密钥、sessions/ 里有全部聊天正文）
  '.dsh',
  // 凭据 / 密钥 / 配置目录
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.netrc', '.password-store',
  'credentials', 'credential', 'secrets', 'private-keys', 'cookies',
  // 浏览器数据（Cookie / 登录态）
  'login data', 'web data', 'local state',
  // 系统目录（发系统文件毫无正当理由，且可能被当成载荷分发）
  'windows', 'system32', 'syswow64', 'winsxs', 'program files', 'program files (x86)',
  'programdata', 'system volume information', '$recycle.bin',
])

/** 内置敏感文件名/模式（对 basename 判定）。 */
export const FILE_DENY_NAME_PATTERNS = Object.freeze([
  /^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  /\.(pem|key|pfx|p12|jks|keystore|ppk|asc|gpg)$/i,
  /^(credentials?|secrets?|tokens?|passwords?|shadow|passwd|master\.key)(\.|$)/i,
  /^\.credentials/i,
  /^(\.env|\.netrc|\.npmrc|\.pypirc|\.git-credentials)/i,
  /^known_hosts$/i,
  /\.(kdbx|keychain|keychain-db)$/i,
  // SnowLuma（QQ 网关）的账号配置：里面有 accessToken（HTTP/WS 两套），拿到就能冒充机器人
  /^onebot_\d+\.json$/i,
  /^(console-token|sessions\.json|social-v2\.json|tool-calls\.jsonl|current-role\.json|mode\.json)$/i,
])

/** 默认配置（越界值一律收敛，不做静默放大）。 */
export const DEFAULT_SEND_FILE_CONFIG = Object.freeze({
  enabled: true,
  maxBytes: 30 * 1024 * 1024,
  maxPerMinute: 3,
  maxPerHour: 20,
  maxNameChars: 120,
  allowExtensions: FILE_ALLOW_EXTENSIONS,
  /** 额外黑名单（路径段，小写）；与内置的并集生效，不支持"取消内置项"。 */
  denySegments: [],
})

/**
 * 归一化 `socialV2.files` 配置。
 *
 * 设计取舍：**只能加严，不能放宽内置的三条底线** ——
 * 扩展名可以增删（用户可能就是要发 `.apk`/`.ipa`），但内置敏感段/文件名黑名单不可移除，
 * 体积与频率只能往小改到 0（= 关闭该项限制）以外…… 实际上 allowExtensions 允许替换，
 * 是因为"允许哪些类型"属于用户的产品选择；而"凭据不能外发"不是选择。
 */
export function normalizeSendFileConfig(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  const num = (v, def, min, max) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return def
    return Math.min(max, Math.max(min, Math.trunc(n)))
  }
  const exts = (() => {
    if (!Array.isArray(src.allowExtensions)) return FILE_ALLOW_EXTENSIONS
    const cleaned = [...new Set(src.allowExtensions
      .map((e) => String(e ?? '').trim().toLowerCase())
      .filter((e) => /^\.[a-z0-9]{1,12}$/.test(e)))]
    // 空数组 = 用户把白名单清空 ⇒ 视为"什么都不能发"，而不是"什么都能发"（fail-closed）。
    return cleaned.length ? cleaned : []
  })()
  const deny = Array.isArray(src.denySegments)
    ? [...new Set(src.denySegments.map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean))]
    : []
  return {
    enabled: src.enabled !== false,
    maxBytes: num(src.maxBytes, DEFAULT_SEND_FILE_CONFIG.maxBytes, 1024, 1024 * 1024 * 1024),
    maxPerMinute: num(src.maxPerMinute, DEFAULT_SEND_FILE_CONFIG.maxPerMinute, 0, 1000),
    maxPerHour: num(src.maxPerHour, DEFAULT_SEND_FILE_CONFIG.maxPerHour, 0, 10000),
    maxNameChars: num(src.maxNameChars, DEFAULT_SEND_FILE_CONFIG.maxNameChars, 8, 255),
    allowExtensions: exts,
    denySegments: deny,
  }
}

/** 把 `file:///C:/x/y.docx`、`~` 这类写法归一成路径串（不做解析，纯文本层）。 */
export function normalizeFileInput(raw) {
  let s = String(raw ?? '').trim()
  if (!s) return ''
  // 去掉成对的引号（从聊天里复制路径常带引号）
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim()
  if (/^file:\/\//i.test(s)) {
    try {
      // file:///C:/a/b → C:/a/b；file://server/share → \\server\share
      const u = new URL(s)
      s = u.hostname ? `\\\\${u.hostname}${decodeURIComponent(u.pathname).replace(/\//g, '\\')}` : decodeURIComponent(u.pathname)
      if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1)
    } catch { /* 交给下面的路径校验报错 */ }
  }
  return s
}

/** basename → 安全的上传文件名（剥路径分隔符、控制字符、零宽字符，限长）。 */
export function sanitizeFileName(name, maxChars = 120) {
  let s = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/\.{2,}/g, '_')   // 别让「..」原样出现在对方看到的文件名里
    .trim()
  if (!s) s = 'file'
  if (s.startsWith('.')) s = `_${s.slice(1)}` // 别把上传名变成隐藏文件
  if (s.length > maxChars) {
    const dot = s.lastIndexOf('.')
    const ext = dot > 0 ? s.slice(dot) : ''
    s = `${s.slice(0, Math.max(1, maxChars - ext.length))}${ext}`
  }
  return s
}

/** 路径段（全部小写）。用于黑名单比对：Windows 与大小写不敏感文件系统对齐。 */
export function pathSegments(p) {
  return String(p ?? '')
    .replace(/^[a-zA-Z]:/, '')          // 盘符单独处理，不算敏感段
    .split(/[\\/]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** 该路径是否命中"绝不外发"的名单（段 + 文件名模式 + 额外配置）。 */
export function isSensitivePath(p, cfg = DEFAULT_SEND_FILE_CONFIG) {
  const segs = pathSegments(p)
  const deny = new Set([...FILE_DENY_SEGMENTS, ...(cfg.denySegments ?? [])])
  for (const seg of segs) if (deny.has(seg)) return { hit: true, why: `路径中包含敏感目录「${seg}」` }
  const base = segs.length ? segs[segs.length - 1] : ''
  for (const re of FILE_DENY_NAME_PATTERNS) {
    if (re.test(base)) return { hit: true, why: '疑似凭据/密钥/桥接状态文件' }
  }
  // 扩展名层面的兜底：即使有人往白名单里加了 .pem，也仍然挡住密钥类
  if (/\.(pem|key|pfx|p12|jks|ppk|kdbx)$/i.test(base)) return { hit: true, why: '疑似密钥文件' }
  // 桥接自己的 config.json（含 snowluma.accessToken 与 consoleToken）：只在**本仓库内**判敏感，
  // 免得把用户别的项目里的 config.json 一起封掉（那很常见，也常常确实需要发给别人）。
  if (/^config(\.example)?\.json$/i.test(base) && segs.includes('qq-bridge')) {
    return { hit: true, why: '桥接自身的配置文件（含网关与控制台令牌）' }
  }
  return { hit: false }
}

/**
 * 发文件前的完整校验（唯一权威实现，桥接路由与测试共用）。
 *
 * @param {string} rawPath 模型给的文件路径（绝对路径；也接受 file:// 与 ~）
 * @param {object} options
 * @param {object} options.cfg 归一化后的 `socialV2.files`
 * @param {(p:string)=>string} [options.realpath] realpath 实现（测试可注入）
 * @param {(p:string)=>({isFile:()=>boolean,size:number})} [options.stat] stat 实现（测试可注入）
 * @param {(p:string)=>boolean} [options.exists] 存在性判断（测试可注入）
 * @returns {{ok:true,path:string,name:string,size:number}|{ok:false,error:string}}
 */
export function checkSendFilePath(rawPath, { cfg = DEFAULT_SEND_FILE_CONFIG, realpath, stat, exists } = {}) {
  const c = cfg ?? DEFAULT_SEND_FILE_CONFIG
  const input = normalizeFileInput(rawPath)
  if (!input) return { ok: false, error: '缺少文件路径' }
  if (/^(base64:\/\/|data:|https?:\/\/|ftp:\/\/)/i.test(input)) {
    return { ok: false, error: '只能发本机文件：不接受 base64:// / data: / http(s):// 来源' }
  }
  if (/^\\\\\.\\/i.test(input) || /^\\\\\?\\/i.test(input)) {
    return { ok: false, error: '不接受设备/管道路径（\\\\.\\ 与 \\\\?\\）' }
  }
  const isWinAbs = /^[a-zA-Z]:[\\/]/.test(input)
  const isUncAbs = /^\\\\[^\\/]+[\\/]/.test(input)
  if (!isWinAbs && !isUncAbs && !(process.platform !== 'win32' && input.startsWith('/'))) {
    // 刻意不支持相对路径：模型的工作目录是 state/agents/<key>，相对路径只会让它摸到会话内部文件，
    // 而且"相对于谁"对排查的人是黑盒。要求绝对路径，报错里给示例。
    return { ok: false, error: '请给绝对路径（例：C:\\Users\\你\\Desktop\\报告.docx）；相对路径不被接受' }
  }

  const rp = typeof realpath === 'function' ? realpath : (p) => p
  const st = typeof stat === 'function' ? stat : null
  const ex = typeof exists === 'function' ? exists : null

  let resolved = input
  try { resolved = rp(input) } catch { return { ok: false, error: '文件不存在或无法访问（realpath 失败）' } }
  if (ex && !ex(resolved)) return { ok: false, error: '文件不存在' }
  let size = 0
  if (st) {
    let s
    try { s = st(resolved) } catch { return { ok: false, error: '文件不可访问' } }
    if (!s || typeof s.isFile !== 'function' || !s.isFile()) return { ok: false, error: '只接受普通文件（目录、快捷方式、设备一律拒绝）' }
    size = Number.isFinite(s.size) ? s.size : 0
    if (c.maxBytes > 0 && size > c.maxBytes) {
      return { ok: false, error: `文件过大（${Math.round(size / 1048576)}MB > 上限 ${Math.round(c.maxBytes / 1048576)}MB）` }
    }
    if (size === 0) return { ok: false, error: '文件是空的，不发送' }
  }

  const name = sanitizeFileName(resolved.split(/[\\/]/).pop() ?? '', c.maxNameChars)
  // ⚠️ 敏感路径检查放在扩展名检查**之前**：一来说明为什么被拒（`id_rsa` 该说"疑似凭据"，
  // 而不是"无法判断文件类型"——后者会误导模型去改扩展名重试），二来让"凭据不外发"
  // 成为独立于白名单的判定，不会因为将来往白名单里加了某个扩展名而顺带放行。
  const sensitive = isSensitivePath(resolved, c)
  if (sensitive.hit) return { ok: false, error: `该文件不允许外发：${sensitive.why}` }

  const ext = (name.match(/\.[^.]+$/) ?? [''])[0].toLowerCase()
  if (!ext) return { ok: false, error: `无法判断文件类型（无扩展名）：允许的类型为 ${c.allowExtensions.join(' ') || '（当前为空，全部禁止）'}` }
  if (!c.allowExtensions.includes(ext)) {
    return { ok: false, error: `不允许发送 ${ext} 类型的文件（可发：${c.allowExtensions.slice(0, 12).join(' ')} 等）` }
  }

  return { ok: true, path: resolved, name, size }
}