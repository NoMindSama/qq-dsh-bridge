// 产物索引（L3）：大块文本/文件不进上下文，只留一条"地址"。
//
// 为什么需要：owner 私聊里经常出现"把这份 3 万字的报告/代码整理一下"。
// 这些内容一旦进对话历史，就会跟着每一轮重发（缓存命中后便宜，但仍占上下文、
// 还会被 compaction 的摘要吃掉细节）。正确做法是：正文落盘，模型只记住
// `id + 一句话描述 + 大小 + 校验和`；需要时按 id 取回，取回时校验没被改过。
//
// 设计边界：
//   · 只服务 owner（由桥接的 sessionTier 把关）——群聊不需要文件柜，只会增加攻击面。
//   · 取回必须校验 sha256：文件被改过就明说"已变更"，**不许模型凭记忆复述**。
//   · 索引里不存正文，只存元数据；正文单独一个文件。
//
// 存储布局：
//   state/memory/artifacts/index.jsonl     每行一条 {id, desc, file, bytes, sha256, kind, createdAt, scope}
//   state/memory/artifacts/<id>.txt        正文（utf8）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_BYTES = 2 * 1024 * 1024;      // 单件上限 2 MB
const GET_MAX_CHARS = 12000;            // 一次取回给模型的上限（超出让调用方分段取）
const LIST_LIMIT = 50;

// 归档本机文件时禁止的路径片段：凭据类即使 owner 明确指定也不该复制进记忆库。
const DENY_SEGMENTS = ['.ssh', '.aws', '.gnupg', 'console-token', 'config.json', '.credentials', 'id_rsa', 'id_ed25519'];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function newId() {
  return `art_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

export function createArtifactStore({ dir, maxBytes = MAX_BYTES } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = path.join(dir, 'index.jsonl');

  function readIndex() {
    let raw = '';
    try { raw = fs.readFileSync(indexFile, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  }

  function appendIndex(entry) {
    fs.appendFileSync(indexFile, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** 写入一条产物。content 或 sourcePath 二选一。返回索引元数据。 */
  function put({ desc, content, sourcePath, kind = 'text', scope = '' }) {
    const text = String(desc || '').trim();
    if (!text) throw new Error('desc 不能为空（一句话说明这是什么，模型以后靠它找）');
    if (!scope) throw new Error('scope 不能为空');
    if (!content && !sourcePath) throw new Error('content 与 path 至少给一个');

    let buf;
    if (content != null) {
      buf = Buffer.from(String(content), 'utf8');
      if (buf.length > maxBytes) throw new Error(`内容 ${buf.length} 字节，超过上限 ${maxBytes}`);
    } else {
      const abs = path.resolve(String(sourcePath));
      const lower = abs.toLowerCase();
      for (const seg of DENY_SEGMENTS) {
        if (lower.includes(seg)) throw new Error(`拒绝归档敏感路径（含 ${seg}）：${abs}`);
      }
      const st = fs.statSync(abs);
      if (!st.isFile()) throw new Error(`不是文件：${abs}`);
      if (st.size > maxBytes) throw new Error(`文件 ${st.size} 字节，超过上限 ${maxBytes}`);
      buf = fs.readFileSync(abs);
    }

    const id = newId();
    const file = `${id}.txt`;
    fs.writeFileSync(path.join(dir, file), buf);
    const entry = {
      id,
      desc: text.slice(0, 200),
      file,
      bytes: buf.length,
      sha256: sha256(buf),
      kind: String(kind || 'text').slice(0, 20),
      scope,
      createdAt: Date.now()
    };
    appendIndex(entry);
    return entry;
  }

  /** 按 id 取回。校验 scope 与 sha256；被改过就明确失败，不返回可疑内容。 */
  function get(id, { scope = '', maxChars = GET_MAX_CHARS } = {}) {
    const entry = readIndex().find((e) => e.id === String(id));
    if (!entry) throw new Error(`没有这个产物：${id}（先用 qq_artifact_list 看有哪些）`);
    if (scope && entry.scope !== scope) throw new Error('这个产物不属于当前会话');
    const file = path.join(dir, entry.file);
    let buf;
    try { buf = fs.readFileSync(file); } catch { throw new Error(`产物文件不在了：${entry.file}（索引还在，正文已丢失）`); }
    if (sha256(buf) !== entry.sha256) throw new Error('产物文件已被改动（sha256 不匹配），不能当作原文引用');
    const text = buf.toString('utf8');
    const truncated = text.length > maxChars;
    return {
      ...entry,
      text: truncated ? text.slice(0, maxChars) : text,
      truncated,
      totalChars: text.length
    };
  }

  function list({ scope = '', limit = 20 } = {}) {
    const all = readIndex()
      .filter((e) => !scope || e.scope === scope)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(LIST_LIMIT, Number(limit) || 20)));
    return all.map(({ id, desc, bytes, kind, createdAt }) => ({ id, desc, bytes, kind, createdAt }));
  }

  function stats() {
    const all = readIndex();
    return { count: all.length, bytes: all.reduce((s, e) => s + (e.bytes || 0), 0) };
  }

  return { put, get, list, stats, dir };
}