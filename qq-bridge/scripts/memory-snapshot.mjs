#!/usr/bin/env node
// reset 前的「记忆固化」：把当前会话里值得留下的东西，压成一页交接卡。
//
// 为什么需要：`/reset` 会停用旧 DSH 会话、清空映射。原文库还在（可 qq_recall），
// facts 还在（进系统提示词），但模型不会主动去翻——它需要一张"我曾经经历过什么"的卡。
// 这个脚本从**原文库 + 当前轻量记忆 + facts** 生成这张卡，不调用模型，零成本、可重复跑。
//
// 用法：
//   node scripts/memory-snapshot.mjs --key private:123456789
//   node scripts/memory-snapshot.mjs --key private:123456789 --days 14
//   node scripts/memory-snapshot.mjs --key private:123456789 --write-initial
//
//   --write-initial  同时把摘要写进 state/initial-prompts.json 的该 key（会覆盖旧值，先备份）
//
// 输出：state/memory/snapshots/<safeKey>-<YYYYMMDD>.md

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE = path.join(ROOT, 'state');
const EVENTS = path.join(STATE, 'memory', 'events');
const FACTS = path.join(STATE, 'memory', 'facts');
const SNAPSHOTS = path.join(STATE, 'memory', 'snapshots');

const argv = process.argv.slice(2);
const arg = (name, dflt = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? String(argv[i + 1] ?? dflt) : dflt;
};
const key = arg('key');
const days = Math.max(1, Number(arg('days', '14')) || 14);
const writeInitial = argv.includes('--write-initial');
if (!key) { console.error('用法：node scripts/memory-snapshot.mjs --key private:QQ号 [--days 14] [--write-initial]'); process.exit(1); }

const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
const cutoff = Date.now() - days * 86400000;

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// 原文库：只收对话正文（tool-call / think / system 不进交接卡）。
const msgs = [];
for (const f of fs.readdirSync(EVENTS).filter((x) => x.endsWith('.jsonl'))) {
  for (const r of readJsonl(path.join(EVENTS, f))) {
    if ((r.key || r.meta?.key) !== key) continue;
    if (!['msg', 'ai', 'user'].includes(r.kind)) continue;
    if (['wake-prompt', 'inject', 'system'].includes(String(r.role || ''))) continue;
    if (!r.t || r.t < cutoff) continue;
    msgs.push(r);
  }
}
msgs.sort((a, b) => a.t - b.t);

// 轻量记忆与 facts。
let social = {};
try { social = JSON.parse(fs.readFileSync(path.join(STATE, 'social-v2.json'), 'utf8')); } catch {}
const conv = social?.conversations?.[key] || {};
const mem = conv.memory || {};
const facts = readJsonl(path.join(FACTS, `${safeKey}.jsonl`)).filter((f) => !f.archived);

const byDay = new Map();
for (const m of msgs) {
  const d = new Date(m.t).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  if (!byDay.has(d)) byDay.set(d, []);
  byDay.get(d).push(m);
}

const short = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const lines = [];
lines.push(`# 记忆交接卡 · ${key}`);
lines.push('');
lines.push(`> 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
lines.push(`> 覆盖范围：最近 ${days} 天，共 ${msgs.length} 条对话（原文库）`);
lines.push(`> 用途：reset / 换会话后，让下一个自己先读这一页，再决定要不要 qq_recall 翻细节。`);
lines.push('');
lines.push('## 一、我们聊过什么（按天）');
lines.push('');
for (const [d, list] of [...byDay.entries()].sort()) {
  lines.push(`### ${d}（${list.length} 条）`);
  const shown = list.slice(-24);
  for (const m of shown) {
    const who = m.kind === 'ai' ? '我' : '他';
    lines.push(`- ${new Date(m.t).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })} ${who}：${short(m.text, 90)}`);
  }
  if (list.length > shown.length) lines.push(`- ……另有 ${list.length - shown.length} 条（qq_recall 可查）`);
  lines.push('');
}

lines.push('## 二、还挂着的事（轻量记忆）');
lines.push('');
const topics = Array.isArray(mem.activeTopic) ? mem.activeTopic : [];
const thoughts = Array.isArray(mem.pendingThought) ? mem.pendingThought : [];
if (topics.length) for (const t of topics.slice(0, 10)) lines.push(`- 话题：${short(t.text || t, 80)}`);
if (thoughts.length) for (const t of thoughts.slice(0, 10)) lines.push(`- 想说未说：${short(t.text || t, 80)}`);
if (!topics.length && !thoughts.length) lines.push('- （空）');
lines.push('');

lines.push('## 三、长期记得的事（facts）');
lines.push('');
if (facts.length) for (const f of facts.slice(0, 30)) lines.push(`- [${f.tag}] ${short(f.text, 80)}`);
else lines.push('- （空）');
lines.push('');
lines.push('## 四、怎么用');
lines.push('');
lines.push('1. reset 之后，这份卡会作为「初始提示词」在首次唤醒时注入一次（`--write-initial` 才会写）。');
lines.push('2. 细节想不起来时，用 `qq_recall(query=…)` 查原文库，不要凭印象编。');
lines.push('3. 卡里没写的事，就是真的没记；说“记不清了”比编一个更好。');
lines.push('');

fs.mkdirSync(SNAPSHOTS, { recursive: true });
const stamp = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');
const out = path.join(SNAPSHOTS, `${safeKey}-${stamp}.md`);
fs.writeFileSync(out, lines.join('\n'), 'utf8');
console.log(`已生成：${out}`);
console.log(`  对话 ${msgs.length} 条 / ${byDay.size} 天；话题 ${topics.length}；想说未说 ${thoughts.length}；facts ${facts.length}`);

if (writeInitial) {
  const file = path.join(STATE, 'initial-prompts.json');
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const text = lines.join('\n');
  // 初始提示词有长度上限（config.socialV2.initialPromptMaxChars，默认 2000）；
  // 超了会被桥接截断，这里先压到 1900 字，避免"看起来写了、实际被砍"。
  const clipped = text.length > 1900 ? `${text.slice(0, 1900)}\n…（完整版见 ${path.basename(out)}）` : text;
  if (all[key]) fs.writeFileSync(`${file}.bak-${Date.now()}`, JSON.stringify(all, null, 2), 'utf8');
  all[key] = clipped;
  fs.writeFileSync(file, JSON.stringify(all, null, 2), 'utf8');
  console.log(`已写入 initial-prompts.json（${clipped.length} 字符，原值已备份）`);
  console.log('提示：初始提示词只在“首次唤醒”注入；下次会话重建时生效。');
}