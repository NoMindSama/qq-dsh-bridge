#!/usr/bin/env node
// 长期记忆（L2）的命令行入口。
//
// 为什么需要它：记忆不该只由模型自己写（会变成流水账），也不能全靠自动提炼（早期提炼质量没保证）。
// 先给一个「人可读、可手改」的入口，把冷启动的几十条事实灌进去，后面再让提炼任务接管。
//
// 用法：
//   node scripts/memory-fact.mjs list   [key]
//   node scripts/memory-fact.mjs add    <key> <tag> <text...>
//   node scripts/memory-fact.mjs preview <key>
//   node scripts/memory-fact.mjs reap   [key]
//   node scripts/memory-fact.mjs stats
//
// key 形如 group:123456789 / private:123456789；tag 见 TAG_WEIGHTS
// （identity / agreement / emotion / preference / meme / misc）。

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  addFact, loadFacts, collapse, weightOf, selectForInjection,
  reapArchived, summarize, TAG_WEIGHTS, ARCHIVE_THRESHOLD
} from '../src/memory-facts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(HERE, '..', 'state');
const FACTS_DIR = path.join(STATE_DIR, 'memory', 'facts');

const [action, ...rest] = process.argv.slice(2);

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '-');

function knownKeys() {
  if (!fs.existsSync(FACTS_DIR)) return [];
  return fs.readdirSync(FACTS_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.replace(/\.jsonl$/, '').replace(/_/g, ':').replace(/:(\d)/g, ':$1'));
}

function cmdList(key) {
  const keys = key ? [key] : knownKeys();
  if (!keys.length) { console.log('还没有任何长期记忆。先 add 几条。'); return; }
  const now = Date.now();
  for (const k of keys) {
    const all = collapse(loadFacts(STATE_DIR, k));
    if (!all.length) continue;
    const s = summarize(STATE_DIR, k, now);
    console.log(`\n=== ${k}（${s.live} 条有效 / ${s.archived} 条归档，权重 ${s.bottomWeight}~${s.topWeight}）===`);
    for (const f of all.sort((a, b) => weightOf(b, now) - weightOf(a, now))) {
      const w = weightOf(f, now).toFixed(2);
      const flag = f.archived ? ' [已归档]' : '';
      console.log(`  ${w}  (${f.tag}) ${f.text}${flag}`);
    }
  }
}

function cmdAdd(key, tag, text) {
  if (!key || !tag || !text) {
    console.error('用法: memory-fact.mjs add <key> <tag> <text...>');
    process.exit(1);
  }
  if (!TAG_WEIGHTS[tag]) {
    console.error(`未知 tag「${tag}」，可选：${Object.keys(TAG_WEIGHTS).join(', ')}`);
    process.exit(1);
  }
  const fact = addFact(STATE_DIR, key, { text, tag, source: 'manual' });
  console.log(`已写入 ${key}：${fact.text}（${fact.tag}，基础分 ${fact.baseWeight}）`);
}

function cmdPreview(key) {
  if (!key) { console.error('用法: memory-fact.mjs preview <key>'); process.exit(1); }
  const { picked, text } = selectForInjection(STATE_DIR, key);
  if (!picked.length) { console.log(`${key} 没有可注入的记忆。`); return; }
  console.log(`将注入 ${picked.length} 条 / ${text.length} 字符：\n`);
  console.log(text);
}

function cmdReap(key) {
  const keys = key ? [key] : knownKeys();
  const now = Date.now();
  let total = 0;
  for (const k of keys) {
    const reaped = reapArchived(STATE_DIR, k, now);
    if (reaped.length) {
      total += reaped.length;
      console.log(`${k}：归档 ${reaped.length} 条（未删除）`);
      for (const f of reaped) console.log(`  - ${f.text}`);
    }
  }
  console.log(total ? `共归档 ${total} 条（阈值 ${ARCHIVE_THRESHOLD}，记录仍在库里）` : '没有跌破归档线的事实。');
}

function cmdStats() {
  const keys = knownKeys();
  if (!keys.length) { console.log('还没有任何长期记忆。'); return; }
  const now = Date.now();
  console.log('会话'.padEnd(24), '有效', '归档', '最高分', '最低分');
  for (const k of keys) {
    const s = summarize(STATE_DIR, k, now);
    if (!s.total) continue;
    console.log(k.padEnd(24), String(s.live).padStart(4), String(s.archived).padStart(4), s.topWeight.padStart(6), s.bottomWeight.padStart(6));
  }
}

switch (action) {
  case 'list': cmdList(rest[0]); break;
  case 'add': cmdAdd(rest[0], rest[1], rest.slice(2).join(' ')); break;
  case 'preview': cmdPreview(rest[0]); break;
  case 'reap': cmdReap(rest[0]); break;
  case 'stats': cmdStats(); break;
  default:
    console.log('用法：');
    console.log('  memory-fact.mjs list    [key]');
    console.log('  memory-fact.mjs add     <key> <tag> <text...>');
    console.log('  memory-fact.mjs preview <key>');
    console.log('  memory-fact.mjs reap    [key]');
    console.log('  memory-fact.mjs stats');
    console.log(`\ntag 可选：${Object.keys(TAG_WEIGHTS).join(', ')}`);
}