// 上下文与记忆重构 · B0：原文库（append-only）
//
// 为什么要有它：
//   桥接侧的 state/social-v2.json 只保留每个会话最近 40 条消息（滑动窗口），
//   更早的原文直接消失；DSH 侧的 session.v4.jsonl.zstd 是私有格式、会被 compaction
//   改写，也没有备份。两边都靠不住，所以单独建一层「只追加、不修改」的原文库。
//
// 设计原则（与目标文档一致）：
//   1. 只追加：任何记录一旦写入就不再改、不再删。纠错靠追加新记录，不靠原地修改。
//   2. 索引是派生物：events/*.jsonl 是资产，index/ids.txt 只是加速启动的缓存，
//      删掉后能由 events 完整重建（rebuildIndex）。
//   3. 单进程写入：同一时刻只允许一个写入者（导入脚本或桥接进程二选一）。
//   4. 体积可控：单条正文有上限，超出截断并打标记，避免一次工具结果把库撑爆。
//
// 记录 schema（v1）：
//   {
//     id:   "qq:group:123:456" | "dsh:session-xxx:789"   全局唯一，去重键
//     v:    1
//     src:  "qq" | "dsh"
//     key:  "group:185246858" | "private:123456789" | null
//     sid:  DSH session id | null
//     seq:  源内序号（QQ 用桥接本地 seq；DSH 用事件 seq）
//     t:    毫秒时间戳
//     kind: "msg" | "ai" | "tool" | "system" | "admin"
//     role: 发言人昵称 / "assistant" / "tool" / "system"
//     text: 正文（已截断）
//     meta: 附加信息（messageId、media、tool 名、turn/step 等）
//     trunc: 是否被截断
//   }

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const MEMORY_VERSION = 1;
const DEFAULT_MAX_TEXT = 4000;

/** 生成去重键。空值会被写成空串，保证 id 稳定可比。 */
export function makeId({ src, key, sid, seq }) {
  const a = src === 'dsh' ? (sid ?? '') : (key ?? '');
  return `${src}:${a}:${seq ?? ''}`;
}

/** 按月分片：一天几百条，一月一万条上下，单文件几 MB，便于 append 与备份。 */
function shardOf(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 打开（或创建）原文库。
 * @param {object} opts
 * @param {string} opts.dir          state 目录（其下建 memory/）
 * @param {number} [opts.maxTextChars] 单条正文上限
 */
export function createStore({ dir, maxTextChars = DEFAULT_MAX_TEXT }) {
  if (!dir) throw new Error('createStore: 缺少 dir');
  const root = path.join(dir, 'memory');
  const eventsDir = path.join(root, 'events');
  const indexDir = path.join(root, 'index');
  ensureDir(eventsDir);
  ensureDir(indexDir);

  const idsPath = path.join(indexDir, 'ids.txt');
  const manifestPath = path.join(root, 'manifest.json');

  // 启动时把已有 id 读进内存做去重。几万条也只是几 MB。
  const seen = new Set();
  if (fs.existsSync(idsPath)) {
    const raw = fs.readFileSync(idsPath, 'utf8');
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (s) seen.add(s);
    }
  }

  let manifest = { version: MEMORY_VERSION, createdAt: Date.now(), updatedAt: Date.now(), counts: {}, shards: {} };
  if (fs.existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (parsed && parsed.version === MEMORY_VERSION) manifest = parsed;
    } catch {
      // manifest 坏了不影响数据：events 才是真相，重建即可。
    }
  }

  let appendHandle = null;
  const openAppend = () => {
    if (!appendHandle) appendHandle = fs.openSync(idsPath, 'a');
    return appendHandle;
  };

  const normalize = (rec) => {
    const t = Number(rec.t) || Date.now();
    let text = rec.text == null ? '' : String(rec.text);
    let trunc = false;
    if (text.length > maxTextChars) {
      text = text.slice(0, maxTextChars);
      trunc = true;
    }
    const id = rec.id || makeId({ src: rec.src, key: rec.key, sid: rec.sid, seq: rec.seq });
    return {
      id,
      v: MEMORY_VERSION,
      src: rec.src === 'dsh' ? 'dsh' : 'qq',
      key: rec.key ?? null,
      sid: rec.sid ?? null,
      seq: rec.seq ?? null,
      t,
      kind: rec.kind || 'msg',
      role: rec.role ?? null,
      text,
      meta: rec.meta && typeof rec.meta === 'object' ? rec.meta : undefined,
      trunc: trunc || undefined
    };
  };

  /**
   * 批量追加。已存在的 id 会被静默跳过（这就是跨源去重）。
   * @returns {{added:number, skipped:number, byShard:Record<string,number>}}
   */
  function append(records) {
    const fresh = [];
    let skipped = 0;
    for (const rec of records || []) {
      if (!rec) continue;
      const norm = normalize(rec);
      if (!norm.seq && norm.seq !== 0) { skipped++; continue; }
      if (seen.has(norm.id)) { skipped++; continue; }
      seen.add(norm.id);
      fresh.push(norm);
    }
    if (!fresh.length) return { added: 0, skipped, byShard: {} };

    const byShard = new Map();
    for (const rec of fresh) {
      const s = shardOf(rec.t);
      if (!byShard.has(s)) byShard.set(s, []);
      byShard.get(s).push(rec);
    }

    const counts = {};
    for (const [shard, recs] of byShard) {
      const file = path.join(eventsDir, `${shard}.jsonl`);
      const payload = recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
      fs.appendFileSync(file, payload, 'utf8');
      counts[shard] = (counts[shard] || 0) + recs.length;
      const stat = manifest.shards[shard] || { count: 0, bytes: 0 };
      stat.count += recs.length;
      stat.bytes = fs.statSync(file).size;
      manifest.shards[shard] = stat;
    }

    // id 索引单独追加：它不是数据，坏了可以用 rebuildIndex 重建。
    const h = openAppend();
    fs.writeSync(h, fresh.map((r) => r.id).join('\n') + '\n');

    for (const r of fresh) manifest.counts[r.src] = (manifest.counts[r.src] || 0) + 1;
    manifest.updatedAt = Date.now();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    return { added: fresh.length, skipped, byShard: counts };
  }

  /** 简单查询：按会话 + 时间范围。检索（B3）会另建 FTS5，这里只做基础遍历。 */
  function query({ key = null, from = 0, to = Date.now(), limit = 100 } = {}) {
    const out = [];
    const shards = listShards();
    for (const shard of shards) {
      const file = path.join(eventsDir, `${shard}.jsonl`);
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec.t < from || rec.t > to) continue;
        if (key && rec.key !== key) continue;
        out.push(rec);
      }
    }
    out.sort((a, b) => a.t - b.t);
    return limit > 0 ? out.slice(-limit) : out;
  }

  function listShards() {
    return fs.readdirSync(eventsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace(/\.jsonl$/, ''))
      .sort();
  }

  function stats() {
    const shards = listShards();
    let totalBytes = 0;
    for (const s of shards) {
      try { totalBytes += fs.statSync(path.join(eventsDir, `${s}.jsonl`)).size; } catch {}
    }
    return {
      version: MEMORY_VERSION,
      root,
      shards: shards.map((s) => ({ shard: s, ...(manifest.shards[s] || {}) })),
      totalBytes,
      counts: { ...manifest.counts },
      ids: seen.size,
      updatedAt: manifest.updatedAt
    };
  }

  /** 由 events 重建 index/ids.txt（索引坏了、或手工合并过文件时用）。 */
  function rebuildIndex() {
    const ids = [];
    for (const shard of listShards()) {
      const raw = fs.readFileSync(path.join(eventsDir, `${shard}.jsonl`), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try { ids.push(JSON.parse(line).id); } catch {}
      }
    }
    const uniq = [...new Set(ids)];
    fs.writeFileSync(idsPath, uniq.join('\n') + '\n', 'utf8');
    seen.clear();
    for (const id of uniq) seen.add(id);
    return uniq.length;
  }

  function close() {
    if (appendHandle != null) {
      try { fs.closeSync(appendHandle); } catch {}
      appendHandle = null;
    }
  }

  return { root, eventsDir, append, query, stats, listShards, rebuildIndex, close };
}

/** 从 DSH 的 session.v4.jsonl.zstd 里解出所有 JSONL 行。 */
export function readSessionRecords(buffer) {
  const MAGIC = Buffer.from('28b52ffd', 'hex');
  const idx = [];
  let i = 0;
  while (true) {
    const j = buffer.indexOf(MAGIC, i);
    if (j < 0) break;
    idx.push(j);
    i = j + 1;
  }
  idx.push(buffer.length);
  const lines = [];
  for (let k = 0; k < idx.length - 1; k++) {
    try {
      const txt = zstdDecompress(buffer.subarray(idx[k], idx[k + 1]));
      for (const l of txt.split('\n')) if (l.trim()) lines.push(l);
    } catch {
      // 单帧坏了不影响其余帧；原文库宁可少一条，也不要整批失败。
    }
  }
  const recs = [];
  for (const l of lines) {
    try { recs.push(JSON.parse(l)); } catch {}
  }
  return recs;
}

// Node 22.15+ / 24+ 才有 zstd 解压；缺失时给一句人话，而不是 undefined is not a function。
function zstdDecompress(buf) {
  const fn = zlib.zstdDecompressSync;
  if (typeof fn !== 'function') throw new Error('当前 Node 不支持 zstd 解压（需要 Node 22.15+ 或 24+）');
  return fn(buf).toString('utf8');
}