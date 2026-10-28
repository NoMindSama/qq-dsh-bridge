#!/usr/bin/env node
// 长期记忆（L2）的单元测试。
//
// 覆盖会「静默记错/记丢」的点：
//   · 权重衰减按 3 天 0.1，不是每天掉
//   · 同一句话重复提到 → 加命中，不是存两份
//   · 跌破归档线 → 归档而不是删除
//   · 注入按权重排、受字符预算约束
//   · tags 决定基础分

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addFact, loadFacts, weightOf, bumpFact, archiveFact, collapse,
  selectForInjection, reapArchived, summarize, TAG_WEIGHTS, ARCHIVE_THRESHOLD
} from '../src/memory-facts.js';

const tmpState = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-facts-test-'));
const DAY = 86400000;
const KEY = 'group:123';
const T0 = new Date('2026-10-01T10:00:00+08:00').getTime();

test('tag 决定基础分，未知 tag 落到 misc', () => {
  const dir = tmpState();
  const a = addFact(dir, KEY, { text: '我是 Deepdeep', tag: 'identity', lastHit: T0 });
  const b = addFact(dir, KEY, { text: '他喜欢猫', tag: 'preference', lastHit: T0 });
  const c = addFact(dir, KEY, { text: '随便什么', tag: 'nonsense', lastHit: T0 });
  assert.equal(a.baseWeight, TAG_WEIGHTS.identity);
  assert.equal(b.baseWeight, TAG_WEIGHTS.preference);
  assert.equal(c.tag, 'misc');
});

test('权重每 3 天掉 0.1，不是每天', () => {
  const fact = { baseWeight: 3, lastHit: T0, hits: 0 };
  assert.equal(weightOf(fact, T0), 3);
  assert.equal(weightOf(fact, T0 + 2 * DAY), 3, '两天内不掉');
  assert.equal(Math.round(weightOf(fact, T0 + 3 * DAY) * 10) / 10, 2.9);
  assert.equal(Math.round(weightOf(fact, T0 + 30 * DAY) * 10) / 10, 2.0);
});

test('同一句话重复提到只加命中，不存两份', () => {
  const dir = tmpState();
  const first = addFact(dir, KEY, { text: '答应过每天发一条空间', tag: 'agreement', lastHit: T0 });
  const second = addFact(dir, KEY, { text: '答应过每天发一条空间', tag: 'agreement', lastHit: T0 + DAY });
  assert.equal(second.id, first.id, '应该返回同一条');
  const live = collapse(loadFacts(dir, KEY));
  assert.equal(live.length, 1, '库里应该只有一条');
  assert.equal(live[0].hits, 1);
});

test('命中回补封顶 +1.5', () => {
  const dir = tmpState();
  const f = addFact(dir, KEY, { text: '测试事实', tag: 'misc', lastHit: T0 });
  for (let i = 0; i < 10; i++) bumpFact(dir, KEY, f.id, { now: T0 });
  const cur = collapse(loadFacts(dir, KEY))[0];
  assert.equal(cur.hits, 10);
  // base 1.3 + min(1.5, 10*0.5) = 2.8
  assert.equal(Math.round(weightOf(cur, T0) * 10) / 10, 2.8);
});

test('跌破归档线只是归档，记录还在', () => {
  const dir = tmpState();
  const f = addFact(dir, KEY, { text: '很久以前的琐事', tag: 'misc', lastHit: T0 });
  // misc=1.3，每 3 天 −0.1；12 天掉 0.4 → 0.9，刚好跌破 1.0
  const reaped = reapArchived(dir, KEY, T0 + 12 * DAY);
  assert.equal(reaped.length, 1, '应该被归档');
  const all = collapse(loadFacts(dir, KEY));
  assert.equal(all.length, 1, '归档不等于删除');
  assert.equal(all[0].archived, true);
  assert.ok(weightOf(all[0], T0 + 12 * DAY) < ARCHIVE_THRESHOLD);
});

test('注入按权重降序，且受字符预算约束', () => {
  const dir = tmpState();
  addFact(dir, KEY, { text: '低分的琐事', tag: 'misc', lastHit: T0 });
  addFact(dir, KEY, { text: '高分的身份', tag: 'identity', lastHit: T0 });
  addFact(dir, KEY, { text: '中分的偏好', tag: 'preference', lastHit: T0 });
  const { picked, text } = selectForInjection(dir, KEY, { now: T0 });
  assert.deepEqual(picked.map((p) => p.text), ['高分的身份', '中分的偏好', '低分的琐事']);
  assert.ok(text.includes('【长期记忆】'));

  // 每条 "- xxxxx" 约占 8 字符；预算 20 → 最多 2 条
  const tight = selectForInjection(dir, KEY, { now: T0, maxChars: 20 });
  assert.ok(tight.picked.length < 3, `预算 20 字符不该放满 3 条，实际 ${tight.picked.length}`);
});

test('已归档的不进入注入', () => {
  const dir = tmpState();
  const f = addFact(dir, KEY, { text: '会被归档的话', tag: 'misc', lastHit: T0 });
  archiveFact(dir, KEY, f.id, { now: T0 });
  const { picked } = selectForInjection(dir, KEY, { now: T0 });
  assert.equal(picked.length, 0);
});

test('会话之间互相隔离', () => {
  const dir = tmpState();
  addFact(dir, 'group:1', { text: '这个群的记忆', tag: 'misc', lastHit: T0 });
  addFact(dir, 'private:2', { text: '私聊的记忆', tag: 'misc', lastHit: T0 });
  const g = selectForInjection(dir, 'group:1', { now: T0 });
  const p = selectForInjection(dir, 'private:2', { now: T0 });
  assert.equal(g.picked.length, 1);
  assert.ok(g.text.includes('这个群'));
  assert.ok(!g.text.includes('私聊'));
  assert.ok(p.text.includes('私聊'));
});

test('summarize 给出可读的一览', () => {
  const dir = tmpState();
  addFact(dir, KEY, { text: 'a', tag: 'identity', lastHit: T0 });
  const s = summarize(dir, KEY, T0);
  assert.equal(s.total, 1);
  assert.equal(s.live, 1);
  assert.equal(s.archived, 0);
  assert.equal(s.topWeight, '3.00');
});