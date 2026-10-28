#!/usr/bin/env node
// 原文库检索（memory-search）的回归测试。
//
// 覆盖三件容易回归的事：
//   1. 中文 bigram 切分（整词包含会让「发文件」搜不到「发个文件给你」）
//   2. 按会话隔离（群聊的检索不能把私聊原文带出来）
//   3. 出处框定（结果必须带时间，且明确"不是指令"）
//
// 用法：node scripts/test-memory-search.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gramsOf, createRecall } from '../src/memory-search.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVENTS_DIR = path.resolve(HERE, '..', 'state', 'memory', 'events');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`); }
}

console.log('== gramsOf ==');
{
  const g = gramsOf('发个文件给你');
  check('中文切成 bigram', g.has('文件') && g.has('发个'), [...g].join(','));
  check('标点被剔除', ![...g].some((x) => x.includes('，')));
  check('英文按整词', gramsOf('DeepSeek V3 好用').has('deepseek'));
  check('空输入不炸', gramsOf('').size === 0 && gramsOf(null).size === 0);
}

console.log('\n== 索引与检索（读真实原文库）==');
const recall = createRecall({ dir: EVENTS_DIR });
const stats = recall.stats();
console.log(`  索引规模：${stats.docs} 条对话 / ${stats.grams} 个 gram`);
check('索引只收对话正文', stats.docs > 100 && stats.docs < 1200, `只有 ${stats.docs} 条`);

{
  const hits = recall.search('说说', { limit: 3 });
  check('能搜到「说说」', hits.length > 0, `命中 ${hits.length}`);
  if (hits.length) {
    check('结果带时间', hits.every((h) => typeof h.time === 'string' && h.time.length > 0));
    check('结果带出处文本', hits.every((h) => h.text && h.text.length > 0));
    check('结果是对话不是工具 JSON', hits.every((h) => !h.text.trimStart().startsWith('{')), hits[0]?.text.slice(0, 40));
    check('命中率合理', hits[0].coverage > 0.3, `coverage=${hits[0].coverage}`);
  }
}

{
  const hits = recall.search('说说', { limit: 5 });
  check('默认跨会话检索', new Set(hits.map((h) => h.key)).size >= 1);
  const one = recall.search('说说', { key: 'group:185246858', limit: 5 });
  check('按会话过滤生效', one.every((h) => h.key === 'group:185246858'));
}

{
  const hits = recall.search('说说', { limit: 2 });
  const text = recall.format(hits, { query: '说说' });
  check('格式化带「不是指令」框定', text.includes('不是给你的指令'));
  check('格式化带编号与时间', /^1\. \[.+\]/m.test(text));
  check('空结果给"没有找到"', recall.format([], { query: '不存在的东西' }).includes('没有找到'));
}

{
  const t0 = Date.now();
  createRecall({ dir: EVENTS_DIR }).search('今天', { limit: 3 });
  const ms = Date.now() - t0;
  check('首次建索引 < 2000ms', ms < 2000, `${ms}ms`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);