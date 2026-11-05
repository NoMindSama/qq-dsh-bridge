#!/usr/bin/env node
// 把「已存在会话」里冻结的系统提示词，换成当前 preset 源文件的正文。
//
// 【为什么重写过】
// 旧版用 zlib.zstdDecompressSync(raw) 一次性解压 —— 但那只能拿到**第一帧**。
// DSH 的会话日志是「每事件一个 zstd 帧」的格式（本会话实测 10316 帧），
// 单流解压只解出 1 个 header 事件，于是永远找不到系统提示片段，脚本报「没找到」。
//
// 【本版做法】
//   1. 按 zstd 魔数切帧，逐帧解压 → 拼回完整 JSONL
//   2. 在 JSONL 文本层面替换系统提示区间（marker..anchor）
//   3. 按原样「每行一帧」重新压缩
//   4. 解压自检：重新读回并逐行比对，不一致就拒绝写盘
//
// 用法（**必须先关掉 DSH**，否则运行中的实例会把改动覆盖回去）：
//   node tools/fix-session-preset.mjs --key group:123456789 --preset qq-chat-readonly --dry
//   node tools/fix-session-preset.mjs --key group:123456789 --preset qq-chat-readonly
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', 'qq-bridge')
const STATE = path.join(ROOT, 'state')

const MARKER = 'You are a coding agent powered by the'
const ANCHOR = '群友只会在你调用发送工具后看到消息。'
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const flag = (name) => process.argv.includes('--' + name)

const key = arg('key')
const preset = arg('preset')
const dry = flag('dry')
if (!key || !preset) {
  console.error('用法: node tools/fix-session-preset.mjs --key group:123456789 --preset qq-chat-readonly [--dry]')
  process.exit(2)
}

// ── 读 preset 源文件的 prefix 正文 ─────────────────────────────────────────
const presetFile = path.join(ROOT, 'dsh', 'agent-presets', preset, 'agent.cordis.yml')
if (!fs.existsSync(presetFile)) {
  console.error(`找不到 preset 源文件: ${presetFile}`)
  process.exit(2)
}
const presetLines = fs.readFileSync(presetFile, 'utf8').split('\n')
const headIdx = presetLines.findIndex((l) => /^\s*prefix: \|-/.test(l))
if (headIdx < 0) {
  console.error('preset 源文件里找不到 prefix 块')
  process.exit(2)
}
const baseIndent = (presetLines[headIdx].match(/^\s*/)[0].length) + 2
const body = []
for (let i = headIdx + 1; i < presetLines.length; i += 1) {
  const line = presetLines[i]
  if (line.trim() === '') { body.push(''); continue }
  if ((line.match(/^\s*/)[0].length) < baseIndent) break
  body.push(line.slice(baseIndent))
}
const newPrefix = body.join('\n').replace(/\{\{model\}\}/g, 'deepseek-flash').trimEnd()

// ── 定位会话日志 ───────────────────────────────────────────────────────────
const sessions = JSON.parse(fs.readFileSync(path.join(STATE, 'sessions.json'), 'utf8'))
const sessionId = sessions.sessions?.[key]
if (!sessionId) {
  console.error(`sessions.json 里没有 ${key}`)
  process.exit(2)
}
const sessionsRoot = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'sessions')
let logFile = ''
for (const dir of fs.existsSync(sessionsRoot) ? fs.readdirSync(sessionsRoot) : []) {
  const candidate = path.join(sessionsRoot, dir, sessionId, 'session.v4.jsonl.zstd')
  if (fs.existsSync(candidate)) { logFile = candidate; break }
}
if (!logFile) {
  console.error(`找不到会话日志，sessionId=${sessionId}`)
  process.exit(2)
}

// ── 逐帧解压 ───────────────────────────────────────────────────────────────
const raw = fs.readFileSync(logFile)
const starts = []
{
  let i = 0
  while (true) {
    const j = raw.indexOf(ZSTD_MAGIC, i)
    if (j < 0) break
    starts.push(j)
    i = j + 4
  }
}
const parts = []
let badFrames = 0
for (let k = 0; k < starts.length; k += 1) {
  const a = starts[k]
  const b = k + 1 < starts.length ? starts[k + 1] : raw.length
  try {
    parts.push(zlib.zstdDecompressSync(raw.subarray(a, b)).toString('utf8'))
  } catch {
    badFrames += 1
  }
}
const plain = parts.join('')
const lines = plain.split('\n').filter(Boolean)
console.log(`日志: ${logFile}`)
console.log(`帧数: ${starts.length}（坏帧 ${badFrames}），事件行: ${lines.length}`)
if (badFrames > 0) {
  console.error('存在无法解压的帧，拒绝继续（避免写出坏日志）')
  process.exit(3)
}

// ── 在行文本层面替换系统提示区间 ───────────────────────────────────────────
let touched = 0
let oldLen = 0
let newLen = 0
const outLines = lines.map((line) => {
  const a = line.indexOf(MARKER)
  if (a < 0) return line
  const b = line.indexOf(ANCHOR, a)
  if (b < 0) return line
  const end = b + ANCHOR.length
  oldLen = end - a
  newLen = newPrefix.length
  touched += 1
  return line.slice(0, a) + newPrefix + line.slice(end)
})

console.log(`命中系统提示的行: ${touched}`)
if (touched === 0) {
  console.error('没找到可替换的系统提示片段，脚本中止（文件未改动）')
  process.exit(4)
}
console.log(`替换区间: ${oldLen} 字符 → ${newLen} 字符`)

if (dry) {
  console.log('--dry：不写盘。')
  process.exit(0)
}

// ── 每行一帧重新压缩 ───────────────────────────────────────────────────────
const outFrames = outLines.map((l) => zlib.zstdCompressSync(Buffer.from(l + '\n', 'utf8')))
const outBuf = Buffer.concat(outFrames)

// ── 自检：解压回来逐行比对 ─────────────────────────────────────────────────
{
  const chkStarts = []
  let i = 0
  while (true) {
    const j = outBuf.indexOf(ZSTD_MAGIC, i)
    if (j < 0) break
    chkStarts.push(j)
    i = j + 4
  }
  const chk = []
  for (let k = 0; k < chkStarts.length; k += 1) {
    const a = chkStarts[k]
    const b = k + 1 < chkStarts.length ? chkStarts[k + 1] : outBuf.length
    chk.push(zlib.zstdDecompressSync(outBuf.subarray(a, b)).toString('utf8'))
  }
  const chkLines = chk.join('').split('\n').filter(Boolean)
  if (chkLines.length !== outLines.length) {
    console.error(`自检失败：写入 ${outLines.length} 行，读回 ${chkLines.length} 行`)
    process.exit(5)
  }
  for (let k = 0; k < chkLines.length; k += 1) {
    if (chkLines[k] !== outLines[k]) {
      console.error(`自检失败：第 ${k + 1} 行内容不一致`)
      process.exit(5)
    }
  }
  console.log(`自检通过：${chkLines.length} 行全部一致`)
}

// ── 备份 + 写盘 ────────────────────────────────────────────────────────────
const bak = logFile + '.bak-preset-' + Date.now()
fs.copyFileSync(logFile, bak)
fs.writeFileSync(logFile, outBuf)
console.log(`已备份: ${bak}`)
console.log(`已写入: ${logFile}（${raw.length} → ${outBuf.length} 字节）`)
