// 权限分级探针：用**真实 DSH 会话**验证三档 preset 的工具面。
//
// 为什么必须有这个探针（离线测试覆盖不到的那一半）
// ----------------------------------------------
// `test-permission-tiers.mjs` 只证明桥接**选了**哪个 preset 名；`test-preset-local-tools.mjs`
// 只证明 preset 源里**写了**哪些工具行。两者都不断言"注册出来的会话里到底有哪些工具"：
//   · 全局层（dsh-base）本来就挂了 tool-fs / tool-pwsh，而 qq-tool-restrict 会把继承来的
//     本地工具从 schema 隐藏 —— owner 挂的 scoped 副本会不会被一起误伤？这是**假设**，
//     注释里写着"restrict 只影响继承的全局层"，但只有活的 DSH 能证伪。
//   · 反过来，readonly 档把 write/edit 关在注册期（`tool-fs.config.write=false`），
//     是不是真的没注册，也只有活会话能证明。
//
// 判定口径：让模型**实际调用** read / write / pwsh 三件事，看 turn 事件里
// `tool/call` 与 `tool/result`（含 isError）。"工具不在 schema 里"表现为模型不产生调用
// （它会说没有这个工具）；"挂上了但被 guard 拒"表现为 tool/call 有、tool/result isError
// —— 后者才是真正要抓的事故（挂得上、调不动）。
//
// 用法：
//   $env:DSH_BASE_URL='http://127.0.0.1:51128'; node scripts/probe-permission-tiers.mjs
//   node scripts/probe-permission-tiers.mjs --preset=qq-chat-owner   # 只跑其中一档
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeCookie, probeRpc, probeMuxSocket, probeWorkspaceDir } from './probe-auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';
const cookie = probeCookie({ base: BASE });
const rpc = probeRpc(cookie, { base: BASE });

// 模型走桥接 config.json 的**同一份**配置：探针用别的模型等于换了被测环境。
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const PROVIDER = cfg.dsh?.provider;
const MODEL = cfg.dsh?.model;
const EFFORT = cfg.dsh?.reasoningEffort || '';

/** 三档的期望值。owner=全工具；readonly=只有读；v2=一个本地工具都没有。 */
const TIERS = [
  { preset: 'qq-chat-owner', label: 'Owner（管理员私聊）', read: 'ok', write: 'ok', pwsh: 'ok' },
  { preset: 'qq-chat-readonly', label: '白名单（只读）', read: 'ok', write: 'absent', pwsh: 'absent' },
  { preset: 'qq-chat-v2', label: '仅聊天（默认档）', read: 'absent', write: 'absent', pwsh: 'absent' },
];

const only = (process.argv.find((a) => a.startsWith('--preset=')) ?? '').slice('--preset='.length);
const targets = only ? TIERS.filter((t) => t.preset === only) : TIERS;
if (targets.length === 0) {
  console.error(`未知 preset：${only}（可选 ${TIERS.map((t) => t.preset).join(' / ')}）`);
  process.exit(2);
}

/** 跑一个 preset 的能力自检，返回事件证据。 */
async function probePreset({ preset }) {
  const dir = probeWorkspaceDir(`tiers-${preset}`);
  // 输入文件放在**会话自己的工作区**里：这样 read/write 都不碰仓库（state/ 的 ACL 收紧过），
  // 也不会被文件沙箱按"工作区之外"拒绝而污染结论。
  const inputFile = path.join(dir, 'probe-input.txt');
  fs.writeFileSync(inputFile, 'probe-read-ok\n', 'utf8');
  const outputFile = path.join(dir, `probe-write-${preset}.txt`);
  fs.rmSync(outputFile, { force: true });

  let wsId = '';
  let sessionId = '';
  const calls = [];
  const results = [];
  const callNames = new Map(); // callId → 工具名（tool/result 不带名字，必须回查）
  let text = '';
  const problems = [];
  try {
    const ws = await rpc('workspace/create', { request: { path: dir } });
    if (!ws.ok) throw new Error(`workspace/create: ${ws.error?.code}: ${ws.error?.message}`);
    wsId = ws.value.workspace.workspaceId;

    const sc = await rpc('session/create', { request: { workspaceId: wsId, agentPreset: preset } });
    if (!sc.ok) throw new Error(`session/create(preset=${preset}): ${sc.error?.code}: ${sc.error?.message}`);
    sessionId = sc.value.sessionId;

    const sm = await rpc('session/selectModel', {
      request: { sessionId, provider: PROVIDER, model: MODEL, ...(EFFORT ? { reasoningEffort: EFFORT } : {}) },
    });
    if (!sm.ok) throw new Error(`session/selectModel: ${sm.error?.code}: ${sm.error?.message}`);

    const socket = probeMuxSocket(cookie, { base: BASE });
    const streamId = randomUUID();
    const eventStreamId = randomUUID();
    const done = new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 180_000);
      const finish = (why) => { clearTimeout(timer); resolve(why); };
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } }));
        socket.send(JSON.stringify({ type: 'open', streamId: eventStreamId, endpoint: '$events', payload: { args: {} } }));
        setTimeout(() => {
          void rpc('session/prompt', {
            request: {
              sessionId, requestId: randomUUID(), mode: 'queue',
              content: [{
                type: 'text',
                text: [
                  '能力自检：请**实际调用工具**依次尝试下面三件事（不要凭记忆回答，也不要只说"我会尝试"），做完再汇报。',
                  `1. read：读取文件 ${inputFile} 的内容。`,
                  `2. write：把内容 probe-ok 写入文件 ${outputFile}。`,
                  `3. pwsh：执行命令 echo probe-ok。`,
                  '最后用一句话如实汇报：三件事里哪些做到了、哪些做不到（工具不存在就直接说"没有这个工具"）。不要用 Markdown 格式。',
                ].join('\n'),
              }],
            },
          });
        }, 700);
      });
      socket.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type !== 'item' || m.streamId === eventStreamId) return;
        const v = m.value;
        if (v?.type !== 'event') return;
        const e = v.event;
        if (e.type === 'assistant/message') {
          for (const b of e.data?.message?.content ?? []) if (b?.type === 'text') text += b.text;
        }
        // 事件结构照抄生产代码（src/bridge.js 的 tool/call / tool/result 分支）：
        // tool/result **不带工具名**，只能靠 message.source.callId 回查 call 事件，
        // 错误则在 message.isError 或 content[0].isError 上。
        if (e.type === 'tool/call') {
          const name = String(e.data?.name ?? '');
          const callId = e.data?.callId;
          if (callId != null) callNames.set(String(callId), name);
          calls.push({ name, callId: callId ?? null });
        }
        if (e.type === 'tool/result') {
          const callId = e.data?.message?.source?.callId;
          const name = callId != null ? (callNames.get(String(callId)) ?? '') : '';
          const block = e.data?.message?.content?.[0];
          const isError = e.data?.message?.isError === true || block?.isError === true;
          const detail = String(block?.text ?? block?.error ?? e.data?.message?.error ?? '').slice(0, 300);
          results.push({ name, isError, detail });
          if (callId != null) callNames.delete(String(callId));
        }
        if (e.type === 'turn/end') finish('done');
      });
      socket.addEventListener('close', () => finish('closed'));
      socket.addEventListener('error', () => finish('error'));
    });
    const why = await done;
    try { socket.close(); } catch {}
    if (why !== 'done') problems.push(`turn 未正常结束：${why}`);
  } catch (error) {
    problems.push(String(error?.message ?? error));
  } finally {
    if (sessionId) await rpc('workspace/archiveSession', { request: { sessionId } }).catch(() => {});
    if (wsId) await rpc('workspace/delete', { request: { workspaceId: wsId } }).catch(() => {});
  }

  // ── 判定 ──────────────────────────────────────────────────────────────────
  const calledNames = (n) => calls.filter((c) => c.name === n).length;
  const succeeded = (n) => results.some((r) => r.name === n && !r.isError);
  const deniedByGuard = (n) => results.some((r) => r.name === n && r.isError);
  const verdict = {
    read: succeeded('read') ? 'ok' : (calledNames('read') ? 'called-but-failed' : 'absent'),
    write: succeeded('write') ? 'ok' : (calledNames('write') ? 'called-but-failed' : 'absent'),
    pwsh: succeeded('pwsh') ? 'ok' : (calledNames('pwsh') ? 'called-but-failed' : 'absent'),
  };
  return {
    preset, dir, text: text.slice(0, 400), calls, results, verdict,
    writeFileExists: fs.existsSync(outputFile),
    readContentSeen: text.includes('probe-read-ok'),
    problems,
    // "挂得上、调不动"：schema 里有（产生了调用）却被执行期拒绝。
    guardDenials: ['read', 'write', 'pwsh'].filter(deniedByGuard),
  };
}

console.log(`DSH ${BASE} · 模型 ${PROVIDER}/${MODEL}${EFFORT ? ` (effort=${EFFORT})` : ''}`);
console.log(`探测 ${targets.length} 档：${targets.map((t) => t.preset).join(', ')}\n`);

let failed = 0;
const report = [];
for (const tier of targets) {
  console.log(`── ${tier.label}：${tier.preset} ──`);
  const out = await probePreset(tier);
  report.push({ ...tier, ...out });
  console.log(`  模型原文: ${JSON.stringify(out.text)}`);
  console.log(`  tool/call : ${JSON.stringify(out.calls.map((c) => c.name))}`);
  console.log(`  tool/结果 : ${JSON.stringify(out.results.map((r) => `${r.name}${r.isError ? '(error)' : ''}`))}`);
  console.log(`  写出的文件存在: ${out.writeFileExists}`);
  console.log(`  实测档位: ${JSON.stringify(out.verdict)}   期望: ${JSON.stringify({ read: tier.read, write: tier.write, pwsh: tier.pwsh })}`);
  if (out.problems.length) console.log(`  ⚠️ 过程问题: ${out.problems.join(' | ')}`);
  if (out.guardDenials.length) console.log(`  ⚠️ 被守卫执行期拒绝（挂得上、调不动）: ${out.guardDenials.join(', ')}`);
  const mismatched = ['read', 'write', 'pwsh'].filter((k) => out.verdict[k] !== tier[k]);
  if (mismatched.length) {
    failed += 1;
    console.log(`  ❌ 不符期望：${mismatched.map((k) => `${k}=${out.verdict[k]}(期望 ${tier[k]})`).join(', ')}`);
  } else if (out.problems.length || out.guardDenials.length) {
    failed += 1;
    console.log('  ❌ 结论不符（档位对但过程有异常）');
  } else {
    console.log('  ✅ 符合期望');
  }
  console.log('');
}

const outFile = path.join(ROOT, 'state', 'probe-permission-tiers.json');
try {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify({
    at: new Date().toISOString(), base: BASE, provider: PROVIDER, model: MODEL,
    tiers: report.map((r) => ({
      preset: r.preset,
      expected: { read: r.read, write: r.write, pwsh: r.pwsh },
      verdict: r.verdict,
      calls: r.calls.map((c) => c.name),
      results: r.results.map((x) => ({ name: x.name, isError: x.isError, detail: x.detail })),
      writeFileExists: r.writeFileExists,
      guardDenials: r.guardDenials,
      problems: r.problems,
      text: r.text,
    })),
  }, null, 2)}\n`, 'utf8');
  console.log(`[报告] ${outFile}`);
} catch (error) {
  console.log(`[报告] 落盘失败（不影响结论）：${error?.message ?? error}`);
}

console.log(failed === 0 ? '\n✅ 三档权限分级的真实工具面全部符合期望' : `\n❌ ${failed} 档不符合期望`);
process.exit(failed === 0 ? 0 : 1);