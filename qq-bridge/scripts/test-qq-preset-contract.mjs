// reserved2 提示词与插件边界的静态契约；不调用模型，不向 QQ 发送消息。
// 这些检查只能防止关键协议/能力被误删，不能证明聊天质量无损。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';

const preset = yaml.load(fs.readFileSync(
  new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8',
));
const persona = preset.find((row) => row.id === 'persona');
const prefix = persona?.config?.prefix ?? '';

test('reserved2 YAML resolves to the expected persona and template variables', () => {
  assert.equal(persona?.name, '@deepseek-ai/dsh-persona');
  assert.match(prefix, /\{\{model\}\}/);
  // DSH 0.2.1 起 agent loop 只注册 provider / model 两个提示词变量（0.2.0 还有 cwd），
  // 未知变量会让 system prompt 装配直接抛错 ⇒ 每回合 error、模型一次都不跑。
  // 这里钉住「只用已注册变量」，而不只是「有 {{model}}」。
  const used = [...JSON.stringify(persona.config).matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].filter((v) => !['provider', 'model'].includes(v)), []);
  assert.equal(Object.hasOwn(persona.config, 'text'), false);
});

test('local/admin tool restrictions and existing compaction budgets stay intact', () => {
  assert.deepEqual(preset.map((row) => row.id), [
    'persona', 'tool-web', 'qq-tool-restrict', 'compaction',
  ]);
  // 2026-10-28：群聊里 ask_user_question 没有可回答的交互面，todo_write 也只是白占 schema，
  // 两个工具合计约 1,500 字符/轮，已从 v2 preset 移除。这里钉住「不要再被加回来」。
  assert.equal(preset.some((row) => row.id === 'tool-ask-user' || row.id === 'tool-todo'), false);
  assert.deepEqual(preset.find((row) => row.id === 'tool-web').config, { search: false, fetch: false });
  assert.equal(preset.find((row) => row.id === 'qq-tool-restrict').name, './qq-tool-restrict.mjs');
  const compaction = preset.find((row) => row.id === 'compaction');
  assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true });
  assert.deepEqual(compaction.config.find((row) => row.id === 'tool-result-pruner').config, {
    thresholdChars: 50000, headChars: 45000, tailChars: 2000,
  });
  // 压缩边界（2026-10-28 重定）：**对话进行中绝不压缩**。
  // 旧值 0.15（≈15 万触发）会让上下文长期骑在阈值上方，每隔两三步就压一次；
  // 压缩改写历史前缀 → provider 的 KV cache 整段失效 → 之后每步重算全部历史
  // （实测 45~55 秒/步）。所以阈值抬到 0.95（≈95 万，正常会话到不了）只当
  // 安全阀，真正的压缩由桥接在「闲置边界」主动触发（bridge.js idleCompactV2）。
  const compactionBasic = compaction.config.find((row) => row.id === 'compaction-basic').config;
  assert.deepEqual(compactionBasic, {
    thresholdRatio: 0.95, retainTokens: 80000, maxTokens: 8000,
  });
  // 护栏：任何把阈值调回「对话中会触发」的改动都必须先过这里。
  assert.ok(
    Number(compactionBasic.thresholdRatio) >= 0.9,
    `thresholdRatio 必须 >= 0.9（对话中不压缩）；当前 ${compactionBasic.thresholdRatio} 会让上下文骑在阈值上反复压缩、把 KV cache 打死`,
  );
  for (const text of ['你没有本地工具', '群友没有管理权限', 'API 令牌', '角色由桥接注入']) {
    assert.ok(prefix.includes(text), `missing safety rule: ${text}`);
  }
});

// 三档 preset 共用同一套「压缩边界」策略。任何一档漏改，那条会话就会继续在
// 对话中压缩 —— 症状是"只有某个会话特别慢"，比全局变慢更难排查。
test('三档 preset 的压缩边界一致：对话进行中都不允许触发压缩', () => {
  for (const name of ['qq-chat-owner', 'qq-chat-readonly', 'qq-chat-v2']) {
    const doc = yaml.load(fs.readFileSync(
      new URL(`../dsh/agent-presets/${name}/agent.cordis.yml`, import.meta.url), 'utf8',
    ));
    const group = doc.find((row) => row.id === 'compaction');
    const basic = group?.config?.find((row) => row.id === 'compaction-basic')?.config;
    assert.ok(basic, `${name} 缺少 compaction-basic`);
    assert.ok(
      Number(basic.thresholdRatio) >= 0.9,
      `${name} 的 thresholdRatio=${basic.thresholdRatio}：对话中途会触发压缩，必须 >= 0.9`,
    );
  }
});

test('snapshots are optional, partial snapshots require reading, and watermarks are not message IDs', () => {
  // 2026-10-28：快照从 JSON 改成纯文本【本轮消息】，标题和续读提示都换了文案。
  // 这里钉住的仍然是同一件事：模型必须知道「从哪继续读」和「水位不是 messageId」。
  assert.match(prefix, /唤醒末尾会附【本轮消息】/);
  assert.match(prefix, /读到 #N[^。]*readThroughSeq/);
  assert.match(prefix, /还有消息没显示[^。]*续读/);
  assert.match(prefix, /readThroughSeq 是桥接本地的 seq，不是 QQ messageId/);
  assert.match(prefix, /没有水位[^。]*省略 throughSeq/);
  assert.match(prefix, /首次进入会话、角色变化[^。]*qq_get_prompt/);
});

test('one closing action acknowledges the read watermark without an observation wait', () => {
  assert.match(prefix, /qq_mark_read\(throughSeq=/);
  assert.match(prefix, /qq_set_wake_config\(throughSeq=…, config=…\)/);
  assert.match(prefix, /发完就收尾/);
  assert.match(prefix, /桥接会在后台盯着/);
  assert.match(prefix, /私聊回完直接收尾/);
});

test('pre-reply quiet checks, auto-wake on reply, and closing are distinct', () => {
  assert.match(prefix, /先用它，不必重复 qq_get_unread_messages/);
  assert.match(prefix, /【首答前】[^\n]*qq_wait_for_messages\(purpose="reply", quietMs=10000\)/);
  assert.match(prefix, /读取和思考花掉的时间也算，已安静足够就立即返回/);
  assert.match(prefix, /预算到但 quiet=false 不等于对方说完/);
  assert.match(prefix, /【等下文】[^\n]*purpose="reply", quietMs=4000~8000/);
  assert.match(prefix, /【回复后】[^\n]*发完就收尾/);
  assert.match(prefix, /群里引用\/@ 你[^。]*立刻把你叫醒/);
});

test('social autonomy and visual, forwarding, sticker and web capabilities remain described', () => {
  for (const text of [
    '【反 AI 味：别当有求必应】', '【保持主体性】', '【学习群友策略】',
    '【别当群管家/主持人】', '默认 1 条，最多 2 条', '不要在一条里用空格断句',
    '不会自动发送到 QQ', 'qq_get_message_images', 'qq_get_forward_msg', 'nestedForwardIds',
    'qq_send_poke', 'qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker',
    'qq_collect_sticker', 'qq_sticker_note', 'qq_get_self_image',
    'qq_set_sticker_remark', '只有管理端明确开启后才能用',
    'qq_list_voices', 'qq_send_voice', 'verified=true 才代表这条语音确实落地',
    '语音**默认是关闭的**', '不要假装发了语音',
    'mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch',
  ]) assert.ok(prefix.includes(text), `missing capability or voice rule: ${text}`);
});

test('autonomy limits and the observation escape hatch stay described', () => {
  // These rules were previously unguarded: deleting any of them left every test green.
  for (const text of [
    // 收尾的逃生口：明确结束语可以直接收尾，不必等任何观察窗口。
    '对方明确说“不聊了/晚安/下了/拜拜/明天见”时，直接收尾',
    // [SILENT] 是桥接的退出标记，误用会静默吞掉回复。
    '不要用 [SILENT]',
    // 记忆面
    '【记忆卫生】', 'qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear',
    // 黑话面
    'qq_slang_query', 'qq_slang_submit', '不重复提交',
    // 频率上限
    '普通闲聊约 3~5 轮一张', '别刷屏', '每条只能一张，不能附带文字', '不要频繁拍',
    // 会话令牌是硬前置，漏传会被拒绝。
    '作为 token 参数传入',
    // 指定成员唤醒
    'triggers.speakerIds', '不凭记忆乱填',
  ]) assert.ok(prefix.includes(text), `missing rule: ${text}`);
});

console.log(`reserved2 persona prefix: ${prefix.length} characters (not a model-token estimate)`);
