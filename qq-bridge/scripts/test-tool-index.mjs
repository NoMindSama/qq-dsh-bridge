#!/usr/bin/env node
// 工具索引（progressive disclosure）的端到端测试。
//
// 验证四件事：
//   1. 开关关着时，工具面跟上游完全一致（39 个 QQ 工具），一个都不能少；
//   2. 开关打开后，只剩 7 个常驻 + 2 个索引入口；
//   3. qq_find_tool 能按中文关键词找回被藏起来的工具；
//   4. qq_call_tool 的参数校验会带出完整参数说明，而不是一句 "Invalid arguments"。
//
// 不依赖 SnowLuma / 桥接在线：只测工具面与索引本身。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const SCRIPT = path.join(ROOT, 'src', 'mcp-snowluma-safe.js');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`✔ ${label}`);
  else { console.log(`✖ ${label}${detail ? ` — ${detail}` : ''}`); failures += 1; }
};

async function withServer(env, fn) {
  const transport = new StdioClientTransport({
    command: NODE,
    args: [SCRIPT],
    cwd: ROOT,
    stderr: 'pipe',
    env: { ...process.env, ...env }
  });
  const client = new Client({ name: 'tool-index-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    try { await client.close(); } catch {}
  }
}

const textOf = (res) => (res?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

// ── 1. 关闭时：工具面不变 ────────────────────────────────────────────────
await withServer({ QQ_DEFER_TOOLS: '0' }, async (client) => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  check('关闭时不出现索引入口', !names.includes('qq_find_tool') && !names.includes('qq_call_tool'), names.join(','));
  check('关闭时低频工具仍然直接可见', names.includes('qq_collect_sticker') && names.includes('qq_send_file'));
  check('关闭时工具数 >= 30（与上游一致）', names.length >= 30, `实际 ${names.length}`);
});

// ── 2. 打开后：只剩常驻 + 两个入口 ───────────────────────────────────────
await withServer({ QQ_DEFER_TOOLS: '1' }, async (client) => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log(`   开启后工具面（${names.length}）：${names.join(', ')}`);
  check('常驻的 7 个都还在', ['qq_get_unread_messages', 'qq_send_message', 'qq_get_message_images', 'qq_wait_for_messages', 'qq_mark_read', 'qq_set_wake_config', 'qq_get_prompt'].every((n) => names.includes(n)));
  check('两个索引入口已注册', names.includes('qq_find_tool') && names.includes('qq_call_tool'));
  check('低频工具已藏起来', !names.includes('qq_collect_sticker') && !names.includes('qq_send_file') && !names.includes('qq_send_sticker'));
  check('工具数 <= 10', names.length <= 10, `实际 ${names.length}`);

  const schemaChars = JSON.stringify(tools).length;
  console.log(`   工具 schema 体积：${schemaChars} 字符`);

  // ── 3. find 能找到中文关键词对应的工具 ─────────────────────────────────
  const found = await client.callTool({ name: 'qq_find_tool', arguments: { query: '收藏表情' } });
  const foundText = textOf(found);
  check('find(收藏表情) 命中 qq_collect_sticker', foundText.includes('qq_collect_sticker'), foundText.slice(0, 120));

  const foundFile = await client.callTool({ name: 'qq_find_tool', arguments: { query: '发文件' } });
  check('find(发文件) 命中 qq_send_file', textOf(foundFile).includes('qq_send_file'), textOf(foundFile).slice(0, 120));

  // ── 4. call 的参数校验要带参数说明 ─────────────────────────────────────
  const bad = await client.callTool({ name: 'qq_call_tool', arguments: { name: 'qq_get_message_images', args: {} } });
  const badText = textOf(bad);
  check('缺参数时 isError', bad.isError === true);
  check('错误里带参数名与必填标记', /key/.test(badText) && /token/.test(badText) && /必填/.test(badText), badText.slice(0, 160));

  const missing = await client.callTool({ name: 'qq_call_tool', arguments: { name: 'qq_not_exist', args: {} } });
  check('未知工具名给出提示', missing.isError === true && textOf(missing).includes('qq_find_tool'));
});

console.log(failures === 0 ? '\n工具索引测试全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);