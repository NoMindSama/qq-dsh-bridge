// 临时探针：确认经过工具索引后，DSH 侧实际发给模型的工具面有多大。
// 做法：建一个 qq-chat-v2 会话 → 发一条"只回 ok"的 prompt → 读它落盘的 request/header。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { probeCookie, probeRpc, probeWorkspaceDir } from './probe-auth.mjs';
import { readSessionRecords } from '../src/memory-store.js';

const cookie = probeCookie();
const rpc = probeRpc(cookie);
const PRESET = process.argv[2] || 'qq-chat-v2';
const dir = probeWorkspaceDir('toolface');

const ws = await rpc('workspace/create', { request: { path: dir } });
const wsId = ws.value.workspace.workspaceId;
const sc = await rpc('session/create', { request: { workspaceId: wsId, agentPreset: PRESET } });
if (!sc.ok) { console.error(`preset 挂载失败: ${sc.error.code}: ${sc.error.message}`); process.exit(2); }
const sessionId = sc.value.sessionId;
console.log(`session ${sessionId} (preset=${PRESET})`);

const p = await rpc('session/prompt', {
  request: {
    sessionId, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'text', text: '只回复两个字：收到。不要调用任何工具。' }]
  }
});
console.log('prompt ->', JSON.stringify(p).slice(0, 160));

// 等 turn 落盘（最多 90 秒）
const root = path.join(os.homedir(), '.dsh', 'sessions');
let file = null;
for (let i = 0; i < 90 && !file; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  for (const top of fs.readdirSync(root, { withFileTypes: true })) {
    if (!top.isDirectory()) continue;
    const sub = path.join(root, top.name, sessionId);
    if (!fs.existsSync(sub)) continue;
    const hit = fs.readdirSync(sub).find((n) => /^session\.v4\.jsonl\.zstd$/.test(n));
    if (hit) { file = path.join(sub, hit); break; }
  }
  if (file) {
    const recs = readSessionRecords(fs.readFileSync(file));
    if (recs.some((r) => r.type === 'request/header')) break;
    file = null;
  }
}

if (file) {
  const recs = readSessionRecords(fs.readFileSync(file));
  const header = recs.find((r) => r.type === 'request/header');
  const tools = header?.data?.header?.tools || [];
  const names = tools.map((t) => t.name).sort();
  console.log(`\n工具数: ${tools.length}`);
  console.log(`schema 字符: ${JSON.stringify(tools).length}`);
  console.log(`工具名: ${names.join(', ')}`);
  const sys = recs.find((r) => r.type === 'system/message');
  const sysText = JSON.stringify(sys?.data?.message?.content ?? '');
  console.log(`系统提示词含「工具索引」: ${sysText.includes('工具索引')}`);
  console.log(`系统提示词含 qq_find_tool: ${sysText.includes('qq_find_tool')}`);
  console.log(`系统提示词字符数: ${sysText.length}`);
} else {
  console.log('没等到 request/header');
}

try { await rpc('workspace/archiveSession', { request: { sessionId } }); } catch {}
try { await rpc('workspace/delete', { request: { workspaceId: wsId } }); } catch {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log('[cleanup] done');
process.exit(0);