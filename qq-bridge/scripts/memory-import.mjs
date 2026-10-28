#!/usr/bin/env node
// 原文库历史回填：把「能拿到的历史」一次性灌进 state/memory/。
//
// 能拿到什么、拿不到什么（这就是为什么要现在就建库）：
//   · 桥接 state/social-v2.json —— 每个会话只留最近 40 条，更早的已经没了。
//   · DSH session 文件 —— 有全量的 user/message（唤醒包）、assistant 回复、工具调用，
//     但唤醒包里的消息快照已被 compactModelMessage 改成 at/ago，原始毫秒时间戳被删掉，
//     只能按 ago 反推（分钟级精度）。
//   · qq-activity.log —— 纯文本、无发送者、无 id，只适合做旁证。
//
// 所以：历史只能"尽量补"，从今天起才是"全量"。本脚本把两者都吃进来，靠 id 去重。
//
// 用法：
//   node scripts/memory-import.mjs            # 导入
//   node scripts/memory-import.mjs --dry-run  # 只看会导入多少，不落盘
//   node scripts/memory-import.mjs --rebuild  # 用 events 重建 id 索引

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStore, readSessionRecords } from '../src/memory-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const BRIDGE_ROOT = path.resolve(HERE, '..');
const STATE_DIR = path.join(BRIDGE_ROOT, 'state');
const DSH_SESSIONS = process.env.DSH_SESSIONS_ROOT || path.join(os.homedir(), '.dsh', 'sessions');

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const REBUILD = args.has('--rebuild');
const VERBOSE = args.has('--verbose');

/** "38m" / "3s" / "2h" / "3d" → 毫秒。解析不了返回 null。 */
export function parseAgo(text) {
  const m = /^(\d+)\s*([smhd])$/.exec(String(text || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
  return Number.isFinite(n) ? n * unit : null;
}

/** 从唤醒包里抠出【本次消息快照】的 JSON。括号配对扫描，避免被正文里的花括号带偏。 */
export function extractSnapshot(promptText) {
  const marker = '【本次消息快照】';
  const i = promptText.indexOf(marker);
  if (i < 0) return null;
  const start = promptText.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let p = start; p < promptText.length; p++) {
    const c = promptText[p];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(promptText.slice(start, p + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** 消息快照里一条消息 → 库记录。时间优先用 ago 反推，缺失时退回快照生成时刻。 */
function snapshotMessageToRecord(msg, { key, baseTime, now }) {
  const seq = Number.isSafeInteger(msg.seq) && msg.seq > 0 ? msg.seq : null;
  const agoMs = parseAgo(msg.ago);
  let t = baseTime;
  let timeFrom = 'snapshot';
  if (agoMs != null) { t = baseTime - agoMs; timeFrom = 'ago'; }
  else if (msg.at) { timeFrom = 'at-only'; }
  const text = msg.text ?? msg.plain ?? '';
  if (!text && !msg.media) return null;
  return {
    src: 'qq',
    key,
    seq: seq ?? t, // 私聊早期消息没有 seq，用时间兜底，保证 id 唯一可复现
    t: Number.isFinite(t) ? t : baseTime,
    kind: 'msg',
    role: msg.sender || null,
    text,
    meta: {
      messageId: msg.messageId,
      userId: msg.userId,
      media: msg.media ? msg.media.length : undefined,
      hasForward: msg.forwardIds ? true : undefined,
      syntheticSeq: seq == null || undefined,
      timeFrom,
      capturedAt: now
    }
  };
}

/** 从 sessions.json 建立 sid → QQ 会话 key 的映射。 */
function loadSessionKeyMap() {
  const map = new Map();
  const p = path.join(STATE_DIR, 'sessions.json');
  if (!fs.existsSync(p)) return map;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const [key, sid] of Object.entries(j.sessions || {})) map.set(sid, key);
  } catch {}
  return map;
}

/** 列出属于 QQ 桥接的 session 文件（按 header 里的 cwd 精确判定）。
 *  DSH 的布局是 sessions/<按 cwd 编码的目录>/<session-id>/session.vN.jsonl.zstd，两层。 */
function findBridgeSessions() {
  if (!fs.existsSync(DSH_SESSIONS)) return [];
  const out = [];
  const fileRe = /^session\.v\d+\.jsonl\.zstd$/;
  for (const top of fs.readdirSync(DSH_SESSIONS, { withFileTypes: true })) {
    if (!top.isDirectory()) continue;
    const topPath = path.join(DSH_SESSIONS, top.name);
    let subs = [];
    try { subs = fs.readdirSync(topPath, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const sub of subs) {
      const subPath = path.join(topPath, sub.name);
      let files = [];
      try { files = fs.readdirSync(subPath).filter((f) => fileRe.test(f)); } catch { continue; }
      for (const f of files) {
        const file = path.join(subPath, f);
        try {
          const recs = readSessionRecords(fs.readFileSync(file));
          const header = recs.find((r) => r.type === 'session');
          if (!header) continue;
          const cwd = String(header.cwd || '');
          // 桥接 agent 的 cwd 是 <项目>/qq-bridge/state/agents
          if (!/qq-bridge[\\/]state[\\/]agents$/i.test(cwd)) continue;
          out.push({ file, sid: header.id, cwd, mtime: fs.statSync(file).mtimeMs, records: recs });
        } catch { /* 单文件坏了跳过 */ }
      }
    }
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

/** 会话已从 sessions.json 退役（key 丢失）时，从唤醒包里把 key 捞回来。 */
function inferKeyFromRecords(records) {
  for (const rec of records) {
    if (rec.type !== 'user/message') continue;
    const text = (rec.data?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const m = /(group|private):(\d{5,12})/.exec(text);
    if (m) return `${m[1]}:${m[2]}`;
  }
  return null;
}

function main() {
  if (!fs.existsSync(STATE_DIR)) {
    console.error(`找不到 state 目录：${STATE_DIR}`);
    process.exit(1);
  }
  const store = createStore({ dir: STATE_DIR });

  if (REBUILD) {
    const n = store.rebuildIndex();
    console.log(`索引已重建：${n} 条 id`);
    store.close();
    return;
  }

  const keyBySid = loadSessionKeyMap();
  const sessions = findBridgeSessions();
  const all = [];
  const perSession = [];

  for (const s of sessions) {
    const key = keyBySid.get(s.sid) || inferKeyFromRecords(s.records) || null;
    let qqMsgs = 0, aiMsgs = 0, prompts = 0, tools = 0;

    for (const rec of s.records) {
      if (rec.type === 'user/message') {
        const text = (rec.data?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        if (!text) continue;
        const snap = extractSnapshot(text);
        if (snap) {
          for (const msg of [...(snap.messages || []), ...(snap.recent || [])]) {
            const r = snapshotMessageToRecord(msg, { key, baseTime: rec.time, now: rec.time });
            if (r && key) { all.push(r); qqMsgs++; }
          }
          prompts++;
          // 唤醒包本身也留一份：以后复盘「当时它到底看到了什么」只能靠它。
          all.push({
            src: 'dsh', sid: s.sid, seq: rec.seq, t: rec.time, kind: 'user', role: 'wake-prompt',
            text, meta: { key, unreadCount: snap.unreadCount, partial: snap.partial, readThroughSeq: snap.readThroughSeq }
          });
        } else {
          all.push({
            src: 'dsh', sid: s.sid, seq: rec.seq, t: rec.time, kind: 'system', role: 'inject',
            text, meta: { key, long: text.length > 400 }
          });
        }
      } else if (rec.type === 'assistant/message') {
        const parts = rec.data?.message?.content || [];
        const say = parts.filter((c) => c.type === 'text').map((c) => c.text).join('');
        const think = parts.filter((c) => c.type === 'reasoning').map((c) => c.text).join('');
        if (say.trim()) {
          all.push({
            src: 'dsh', sid: s.sid, seq: rec.seq, t: rec.time, kind: 'ai', role: 'Deepdeep',
            text: say, meta: { key, turn: rec.data?.turn, step: rec.data?.step }
          });
          aiMsgs++;
        }
        if (think.trim()) {
          // 思考链只留开头：它体积大、复用价值低，但复盘「为什么这么说」时最有用。
          all.push({
            src: 'dsh', sid: s.sid, seq: `${rec.seq}#think`, t: rec.time, kind: 'think', role: 'Deepdeep',
            text: think.slice(0, 600), meta: { key, thinkChars: think.length, truncatedThink: think.length > 600 }
          });
        }
      } else if (rec.type === 'tool/call') {
        const name = rec.data?.name || '';
        const arg = String(rec.data?.arguments || '');
        all.push({
          src: 'dsh', sid: s.sid, seq: rec.seq, t: rec.time, kind: 'tool-call', role: name,
          text: arg.slice(0, 300), meta: { key, callId: rec.data?.callId, turn: rec.data?.turn, step: rec.data?.step }
        });
        tools++;
      } else if (rec.type === 'tool/result') {
        const parts = rec.data?.message?.content || [];
        const text = parts.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        if (!text) continue;
        all.push({
          src: 'dsh', sid: s.sid, seq: rec.seq, t: rec.time, kind: 'tool-result',
          role: rec.data?.message?.toolCallId || 'tool',
          text: text.slice(0, 800),
          meta: { key, resultChars: text.length }
        });
      }
    }

    perSession.push({ sid: s.sid, key, qqMsgs, prompts, aiMsgs, tools, records: s.records.length });
  }

  // 桥接侧滑动窗口（最近 40 条）：带原始毫秒时间 + seq，能补上 ago 反推的精度损失。
  let bridgeMsgs = 0;
  const sv2 = path.join(STATE_DIR, 'social-v2.json');
  if (fs.existsSync(sv2)) {
    try {
      const j = JSON.parse(fs.readFileSync(sv2, 'utf8'));
      for (const [key, conv] of Object.entries(j.conversations || {})) {
        for (const msg of [...(conv.recentMessages || []), ...(conv.unread || [])]) {
          if (!msg || !msg.text && !msg.plain) continue;
          const seq = Number.isSafeInteger(msg.seq) && msg.seq > 0 ? msg.seq : (Number(msg.time) || 0);
          all.push({
            src: 'qq', key, seq, t: Number(msg.time) || Date.now(),
            kind: 'msg', role: msg.sender || null, text: msg.text ?? msg.plain ?? '',
            meta: { messageId: msg.messageId, userId: msg.userId, isSelf: msg.isSelf || undefined, fromBridgeWindow: true }
          });
          bridgeMsgs++;
        }
      }
    } catch (e) {
      console.warn(`social-v2.json 读取失败：${e.message}`);
    }
  }

  const qqTotal = all.filter((r) => r.src === 'qq').length;
  console.log(`扫描到桥接会话 ${sessions.length} 个；待写入 ${all.length} 条（其中 QQ 消息 ${qqTotal} 条，桥接窗口补 ${bridgeMsgs} 条）`);
  for (const p of perSession) {
    console.log(`  · ${p.key || '(未映射)'}  ${p.sid.slice(0, 16)}…  快照 ${p.prompts} 个 / QQ 消息 ${p.qqMsgs} / AI 回复 ${p.aiMsgs} / 工具 ${p.tools}`);
  }

  if (DRY) {
    console.log('--dry-run：未落盘。');
    store.close();
    return;
  }

  const res = store.append(all);
  console.log(`写入完成：新增 ${res.added} 条，跳过 ${res.skipped} 条（重复或无效）`);
  for (const [shard, n] of Object.entries(res.byShard)) console.log(`  · ${shard}: +${n}`);
  console.log(JSON.stringify(store.stats(), null, 2));
  store.close();
}

// 允许被测试直接 import，也允许命令行直接跑。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}