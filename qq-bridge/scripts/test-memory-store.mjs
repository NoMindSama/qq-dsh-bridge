#!/usr/bin/env node
// 原文库（memory-store）的单元测试。
//
// 覆盖的是「坏了会静默丢记忆」的那些点：
//   · 同一 id 重复写入必须跳过（双源去重靠它）
//   · 正文超限必须截断并打标记（不然一次工具结果能把库撑爆）
//   · 索引删掉后必须能由 events 重建（索引是派生物，不能当真相）
//   · 月分片要按时间走（跨月不能写进同一个文件）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, makeId, readSessionRecords } from '../src/memory-store.js';

const tmpState = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-test-'));

test('makeId 对空值稳定，不会因为 null/undefined 抖动', () => {
  assert.equal(makeId({ src: 'qq', key: 'group:1', seq: 5 }), 'qq:group:1:5');
  assert.equal(makeId({ src: 'dsh', sid: 'session-a', seq: 5 }), 'dsh:session-a:5');
  assert.equal(makeId({ src: 'qq', key: null, seq: 0 }), 'qq::0');
});

test('append 写入后可查回，且同 id 第二次被跳过', () => {
  const dir = tmpState();
  const store = createStore({ dir });
  const rec = { src: 'qq', key: 'group:1', seq: 1, t: new Date('2026-10-27T10:00:00+08:00').getTime(), kind: 'msg', role: 'Wx.', text: '你好' };

  assert.equal(store.append([rec]).added, 1);
  assert.equal(store.append([rec]).added, 0, '同 id 必须跳过');
  assert.equal(store.append([rec]).skipped, 1);

  const got = store.query({ key: 'group:1' });
  assert.equal(got.length, 1);
  assert.equal(got[0].text, '你好');
  assert.equal(got[0].role, 'Wx.');
  store.close();
});

test('超过上限的正文被截断并标记 trunc', () => {
  const dir = tmpState();
  const store = createStore({ dir, maxTextChars: 10 });
  store.append([{ src: 'qq', key: 'group:1', seq: 2, t: Date.now(), text: 'x'.repeat(50) }]);
  const [rec] = store.query({ key: 'group:1' });
  assert.equal(rec.text.length, 10);
  assert.equal(rec.trunc, true);
  store.close();
});

test('缺少 seq 的记录被跳过（不能用 0/undefined 生成同名 id）', () => {
  const dir = tmpState();
  const store = createStore({ dir });
  const res = store.append([{ src: 'qq', key: 'group:1', t: Date.now(), text: '没有 seq' }]);
  assert.equal(res.added, 0);
  assert.equal(res.skipped, 1);
  store.close();
});

test('索引删掉后 rebuildIndex 能从 events 还原，且去重仍然有效', () => {
  const dir = tmpState();
  const store = createStore({ dir });
  store.append([
    { src: 'qq', key: 'group:1', seq: 1, t: Date.now(), text: 'a' },
    { src: 'qq', key: 'group:1', seq: 2, t: Date.now(), text: 'b' }
  ]);
  store.close();

  fs.rmSync(path.join(dir, 'memory', 'index'), { recursive: true, force: true });

  const reopened = createStore({ dir });
  assert.equal(reopened.stats().ids, 0, '索引没了，内存里应该是空的');
  assert.equal(reopened.rebuildIndex(), 2);
  reopened.close();

  const third = createStore({ dir });
  assert.equal(third.append([{ src: 'qq', key: 'group:1', seq: 1, t: Date.now(), text: 'a' }]).skipped, 1);
  third.close();
});

test('跨月分片：不同月份写进不同文件', () => {
  const dir = tmpState();
  const store = createStore({ dir });
  store.append([
    { src: 'qq', key: 'group:1', seq: 1, t: new Date('2026-09-30T23:00:00+08:00').getTime(), text: '九月' },
    { src: 'qq', key: 'group:1', seq: 2, t: new Date('2026-10-01T01:00:00+08:00').getTime(), text: '十月' }
  ]);
  const shards = store.listShards();
  assert.deepEqual(shards, ['2026-09', '2026-10']);
  store.close();
});

test('query 的时间范围是闭区间，limit 取最近的 N 条', () => {
  const dir = tmpState();
  const store = createStore({ dir });
  const base = new Date('2026-10-27T10:00:00+08:00').getTime();
  store.append([1, 2, 3, 4, 5].map((i) => ({ src: 'qq', key: 'group:1', seq: i, t: base + i * 1000, text: `m${i}` })));
  const tail = store.query({ key: 'group:1', limit: 2 });
  assert.deepEqual(tail.map((r) => r.text), ['m4', 'm5']);
  const ranged = store.query({ key: 'group:1', from: base + 2000, to: base + 4000 });
  assert.deepEqual(ranged.map((r) => r.text), ['m2', 'm3', 'm4']);
  store.close();
});

test('readSessionRecords 能从多帧 zstd 文件里解析出 JSONL（用真实文件，缺则跳过）', () => {
  const root = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'sessions');
  if (!fs.existsSync(root)) return;
  let file = null;
  for (const top of fs.readdirSync(root, { withFileTypes: true })) {
    if (!top.isDirectory()) continue;
    const topPath = path.join(root, top.name);
    for (const sub of fs.readdirSync(topPath, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const f = fs.readdirSync(path.join(topPath, sub.name)).find((n) => /^session\.v\d+\.jsonl\.zstd$/.test(n));
      if (f) { file = path.join(topPath, sub.name, f); break; }
    }
    if (file) break;
  }
  if (!file) return;
  const recs = readSessionRecords(fs.readFileSync(file));
  assert.ok(recs.length > 0, '至少要解出一条记录');
  assert.ok(recs.some((r) => r.type === 'session'), '第一条应该是 session header');
});