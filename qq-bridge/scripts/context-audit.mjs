#!/usr/bin/env node
// 上下文成本审计（B0 埋点的"离线版"）。
//
// 为什么先做离线：B0 的约定是**不改线上行为**。成本结构其实已经躺在两个文件里了：
//   · state/token-usage.jsonl  每步的 cacheMiss / cacheHit / output
//   · DSH session 文件         每轮的系统提示词、工具定义、唤醒包体积
// 把它们对齐，就能回答"这一轮的钱到底花在哪"，而且零风险。
//
// 用法：
//   node scripts/context-audit.mjs                # 最近 3 天
//   node scripts/context-audit.mjs --days 7
//   node scripts/context-audit.mjs --detail       # 附每轮明细

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { priceUsage } from '../src/model-prices.js';
import { readSessionRecords } from '../src/memory-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(HERE, '..');
const STATE_DIR = path.join(BRIDGE_ROOT, 'state');
const LEDGER = path.join(STATE_DIR, 'token-usage.jsonl');

const argv = process.argv.slice(2);
const days = Number((() => { const i = argv.indexOf('--days'); return i >= 0 ? argv[i + 1] : '3'; })()) || 3;
const detail = argv.includes('--detail');

const p2 = (n) => String(n).padStart(2, '0');
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const wan = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n));
const yuan = (n) => `¥${n.toFixed(2)}`;

function loadTurns() {
  const rows = [];
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.k === 'turn') rows.push(r);
    } catch {}
  }
  const byTurn = new Map();
  for (const r of rows) {
    const id = `${r.sid}#${r.turn}`;
    if (!byTurn.has(id)) byTurn.set(id, { sid: r.sid, turn: r.turn, key: r.key, model: r.model, provider: r.provider, steps: [] });
    byTurn.get(id).steps.push(r);
  }
  const turns = [...byTurn.values()];
  for (const t of turns) {
    t.steps.sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
    t.first = t.steps[0];
    t.t = t.first.t;
    t.agg = t.steps.reduce((a, s) => {
      const b = s.b || {};
      a.miss += b.cacheMiss || 0;
      a.hit += b.cacheHit || 0;
      a.out += b.output || 0;
      a.write += b.cacheWrite || 0;
      return a;
    }, { miss: 0, hit: 0, out: 0, write: 0 });
    const priced = priceUsage(
      { cacheMiss: t.agg.miss, cacheHit: t.agg.hit, cacheWrite: t.agg.write, output: t.agg.out },
      { model: t.model, at: t.t }
    );
    t.price = priced?.cost?.total ?? 0;
  }
  return turns.sort((a, b) => a.t - b.t);
}

function loadContextShape() {
  // 取最近的桥接会话文件，量一下「每轮固定开销」：系统提示词 + 工具定义。
  const root = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'sessions');
  if (!fs.existsSync(root)) return null;
  let best = null;
  const fileRe = /^session\.v\d+\.jsonl\.zstd$/;
  for (const top of fs.readdirSync(root, { withFileTypes: true })) {
    if (!top.isDirectory() || !/qq-bridge-state-agents/.test(top.name)) continue;
    for (const sub of fs.readdirSync(path.join(root, top.name), { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(root, top.name, sub.name))) {
        if (!fileRe.test(f)) continue;
        const file = path.join(root, top.name, sub.name, f);
        const mtime = fs.statSync(file).mtimeMs;
        if (!best || mtime > best.mtime) best = { file, mtime };
      }
    }
  }
  if (!best) return null;
  const recs = readSessionRecords(fs.readFileSync(best.file));
  // 取**最后一条** request/header。会话里的第一条是改造前的旧快照，
  // 用它量「当前固定开销」会一直显示旧数字（曾长期显示 45 工具 / 34,050 字符）。
  const headers = recs.filter((r) => r.type === 'request/header');
  const header = headers[headers.length - 1];
  // 系统提示词取**第一条** system/message：它是常驻前缀，各轮相同；
  // 取最后一条会偶发取空（有些轮次不再重复落一帧）。
  // 唤醒包取最后一条**非压缩检查点**的 user/message：压缩后的摘要也是 user/message
  // （带 <compacted-summary>，8k 字符起），混进来会把"唤醒包"统计放大四倍。
  const sys = recs.find((r) => r.type === 'system/message');
  const users = recs.filter((r) => r.type === 'user/message').filter((r) => {
    const t = JSON.stringify(r.data?.content ?? '');
    return !t.includes('automatically generated checkpoint') && !t.includes('<compacted-summary>');
  });
  const user = users[users.length - 1];
  const tools = header?.data?.header?.tools || [];
  const len = (o) => JSON.stringify(o ?? '').length;
  return {
    file: path.basename(path.dirname(best.file)),
    headersCount: headers.length,
    toolsCount: tools.length,
    toolsChars: len(tools),
    sysChars: len(sys?.data?.message?.content),
    promptChars: len(user?.data?.content)
  };
}

function main() {
  if (!fs.existsSync(LEDGER)) { console.error(`找不到账本：${LEDGER}`); process.exit(1); }
  const turns = loadTurns();
  const since = Date.now() - days * 86400000;
  const recent = turns.filter((t) => t.t >= since);

  console.log(`=== 最近 ${days} 天成本审计（${recent.length} 轮）===\n`);
  console.log('日期        轮   步  步/轮  首步miss均   总输入      输出     花费');
  const byDay = new Map();
  for (const t of recent) {
    const d = dayKey(t.t);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(t);
  }
  let grand = 0;
  for (const [d, ts] of [...byDay.entries()].sort()) {
    const steps = ts.reduce((a, t) => a + t.steps.length, 0);
    const firstMiss = ts.reduce((a, t) => a + (t.first?.b?.cacheMiss || 0), 0) / ts.length;
    const inp = ts.reduce((a, t) => a + t.agg.miss + t.agg.hit, 0);
    const out = ts.reduce((a, t) => a + t.agg.out, 0);
    const cost = ts.reduce((a, t) => a + t.price, 0);
    grand += cost;
    console.log(
      `${d}  ${String(ts.length).padStart(3)}  ${String(steps).padStart(3)}  ${(steps / ts.length).toFixed(1).padStart(5)}  ` +
      `${wan(firstMiss).padStart(9)}  ${wan(inp).padStart(9)}  ${wan(out).padStart(7)}  ${yuan(cost).padStart(7)}`
    );
  }
  console.log(`\n合计：${yuan(grand)}；平均每轮 ${yuan(grand / Math.max(1, recent.length))}`);

  const worst = [...recent].sort((a, b) => b.agg.miss - a.agg.miss).slice(0, 5);
  console.log('\n最贵的 5 轮（按未命中）：');
  for (const t of worst) {
    const d = new Date(t.t).toLocaleString('zh-CN', { hour12: false });
    console.log(`  ${d}  ${t.key || t.sid.slice(0, 12)}  ${t.steps.length} 步  首步 miss ${wan(t.first?.b?.cacheMiss || 0)}  合计 miss ${wan(t.agg.miss)}  ${yuan(t.price)}`);
  }

  const shape = loadContextShape();
  if (shape) {
    const tok = (c) => Math.round(c / 3); // 中文一字约 1 token、英文 4 字符约 1 token，粗估取 1/3
    console.log(`\n每轮固定开销（会话 ${shape.file.slice(0, 20)}… 的第 ${shape.headersCount} 次请求）:`);
    console.log(`  系统提示词    ${String(shape.sysChars).padStart(7)} 字符  ≈ ${tok(shape.sysChars)} token`);
    console.log(`  工具定义      ${String(shape.toolsChars).padStart(7)} 字符  ≈ ${tok(shape.toolsChars)} token（${shape.toolsCount} 个工具）`);
    console.log(`  唤醒包        ${String(shape.promptChars).padStart(7)} 字符  ≈ ${tok(shape.promptChars)} token`);
    console.log(`  固定部分合计  ≈ ${tok(shape.sysChars + shape.toolsChars)} token —— 这部分每轮都要重算一次`);
  }
  // 当前上下文规模：取最后一轮最后一步的 hit+miss（不是整轮累计，别把 24 步 × 33 万当成 33 万）。
  const lastTurn = recent[recent.length - 1];
  const lastStep = lastTurn?.steps?.[lastTurn.steps.length - 1];
  if (lastStep) {
    const ctx = (lastStep.b?.cacheHit || 0) + (lastStep.b?.cacheMiss || 0);
    console.log(`  当前上下文    ≈ ${wan(ctx)} token（最后一轮第 ${lastStep.step} 步，${lastTurn.key || lastTurn.sid.slice(0, 12)}）`);
  }

  if (detail) {
    console.log('\n每轮明细：');
    for (const t of recent) {
      const d = new Date(t.t).toLocaleString('zh-CN', { hour12: false });
      console.log(
        `  ${d}  ${String(t.key || t.sid.slice(0, 14)).padEnd(20)} ${String(t.steps.length).padStart(2)}步  ` +
        `首步miss ${wan(t.first?.b?.cacheMiss || 0).padStart(7)}  总miss ${wan(t.agg.miss).padStart(7)}  ${yuan(t.price)}`
      );
    }
  }
}

main();