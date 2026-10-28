// 发文件（qq_send_file）的回归：路径安全层 + 路由闸门。
//
// 为什么这个功能需要一整套测试
// ----------------------------
// 这是本仓库第一个"把本机文件主动送出去"的工具，它同时承受两类失败：
//   ① 被 prompt injection 当成任意文件外发器（群友/被读取的文本诱导 AI 发送凭据）；
//   ② 权限分级没兜住 —— 白名单档/群聊也能发文件，等于把本机交给群里的人。
// 所以这里既测**纯函数**（扩展名白名单、敏感路径黑名单、体积、普通文件、文件名净化），
// 也测**真实路由**（用 VM harness 跑真实 bridge.js）：只有 owner 档能发出去，
// 其余会话必须 403 且**一个字节都不发**（断言网关调用记录为空）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  checkSendFilePath, isSensitivePath, normalizeSendFileConfig, sanitizeFileName,
  FILE_ALLOW_EXTENSIONS, DEFAULT_SEND_FILE_CONFIG,
} from '../src/send-file-lib.js';
import { auditOutbound } from '../src/sensitive.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let tests = 0;
async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.message ?? error); }
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-send-file-'));
const docx = path.join(sandbox, '报告.docx');
fs.writeFileSync(docx, 'x'.repeat(2048));
const big = path.join(sandbox, '大文件.pdf');
fs.writeFileSync(big, 'y'.repeat(4096));
const secretDir = path.join(sandbox, '.ssh');
fs.mkdirSync(secretDir, { recursive: true });
const idRsa = path.join(secretDir, 'id_rsa');
fs.writeFileSync(idRsa, 'FAKE-KEY');
const keyFile = path.join(sandbox, 'server.pem');
fs.writeFileSync(keyFile, 'FAKE-PEM');
const script = path.join(sandbox, 'run.ps1');
fs.writeFileSync(script, 'echo hi');
// 真实存在的无扩展名文件：用来验证"无扩展名"这条拒绝理由（不存在的路径会先被 realpath 拦下）
const noExt = path.join(sandbox, 'README');
fs.writeFileSync(noExt, 'hi');
// 名字里含凭据**赋值形态**的普通文档：用来验证文件名审计（走 CREDENTIAL_RE）。
// 注意 `token-report.docx` 这种**不带赋值**的名字不该被拦（否则会误伤正常文件名，
// 见 sensitive.js 的注释：凭据关键词必须带赋值关系才判定）。
const tokenNamed = path.join(sandbox, 'api_key=sk-abcdef123.docx');
fs.writeFileSync(tokenNamed, 'ok');
const tokenWorded = path.join(sandbox, 'token-report.docx');
fs.writeFileSync(tokenWorded, 'ok');

const realFs = { realpath: (p) => fs.realpathSync(p), stat: (p) => fs.statSync(p), exists: (p) => fs.existsSync(p) };

// ── 1. 纯函数：路径安全层 ──────────────────────────────────────────────────
await test('放行：普通文档 / file:// 形式 / UNC 共享', () => {
  const cfg = normalizeSendFileConfig(null);
  const ok = checkSendFilePath(docx, { cfg, ...realFs });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.name, '报告.docx');
  assert.equal(ok.size, 2048);
  // file:// 形式要能归一化回本机路径
  const viaUrl = checkSendFilePath(`file:///${docx.replace(/\\/g, '/')}`, { cfg, ...realFs });
  assert.equal(viaUrl.ok, true, viaUrl.error);
});

await test('拒绝：敏感目录、密钥文件、非白名单扩展名、无扩展名、相对路径、data:、设备路径', () => {
  const cfg = normalizeSendFileConfig(null);
  const cases = [
    [idRsa, /敏感目录|凭据|密钥/],
    [keyFile, /密钥|不允许发送/],
    [script, /不允许发送 \.ps1/],
    [noExt, /无扩展名/],
    [path.join(sandbox, '不存在.docx'), /不存在|无法访问/],
    ['Desktop\\a.docx', /绝对路径/],
    ['data:application/pdf;base64,AAAA', /只能发本机文件/],
    ['https://example.invalid/a.pdf', /只能发本机文件/],
    ['\\\\.\\pipe\\x', /管道路径/],
    ['', /缺少文件路径/],
  ];
  for (const [input, re] of cases) {
    const r = checkSendFilePath(input, { cfg, ...realFs });
    assert.equal(r.ok, false, `本应拒绝：${input}`);
    assert.match(r.error, re, `${input} 的拒绝理由不符：${r.error}`);
  }
});

await test('拒绝：目录、超体积、空文件', () => {
  const cfg = normalizeSendFileConfig(null);
  assert.match(checkSendFilePath(sandbox, { cfg, ...realFs }).error, /普通文件/);
  const small = normalizeSendFileConfig({ maxBytes: 1024 });
  assert.match(checkSendFilePath(big, { cfg: small, ...realFs }).error, /过大/);
  const empty = path.join(sandbox, 'empty.txt');
  fs.writeFileSync(empty, '');
  assert.match(checkSendFilePath(empty, { cfg, ...realFs }).error, /空的/);
});

await test('符号链接逃逸：realpath 指向敏感目录时按解析后的路径判定', () => {
  const cfg = normalizeSendFileConfig(null);
  // 用注入的 realpath 直接模拟"链接指向 .ssh/id_rsa"，避免依赖 Windows 建链接的权限。
  const r = checkSendFilePath(path.join(sandbox, 'innocent.docx'), {
    cfg,
    realpath: () => idRsa,
    stat: () => ({ isFile: () => true, size: 10 }),
    exists: () => true,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /敏感目录|凭据|密钥/);
});

await test('配置归一化：空白的扩展名清单 = 全禁（fail-closed），越界值收敛，内置黑名单不可移除', () => {
  assert.deepEqual(normalizeSendFileConfig({ allowExtensions: [] }).allowExtensions, []);
  const tiny = normalizeSendFileConfig({ maxBytes: 1, maxPerMinute: -5, maxPerHour: 1e9 });
  assert.equal(tiny.maxBytes, 1024);
  assert.equal(tiny.maxPerMinute, 0);          // 0 = 不限制（用户显式关掉该项）
  assert.equal(tiny.maxPerHour, 10000);
  // denySegments 是**并集**：配置里写一个自定义目录，不会把内置的 .ssh 顶掉
  const withExtra = normalizeSendFileConfig({ denySegments: ['mypriv'] });
  assert.equal(isSensitivePath(idRsa, withExtra).hit, true, '内置黑名单必须仍在');
  assert.equal(isSensitivePath('C:\\mypriv\\a.docx', withExtra).hit, true, '自定义段应生效');
  // 大小写与路径段边界：state-报告 不是 state 目录
  assert.equal(isSensitivePath('C:\\Users\\x\\Desktop\\state-报告.docx', withExtra).hit, false);
  // 真实世界里最该挡住的三类（都是"扩展名白名单挡不住"的：用户完全可能把 yaml/json 加进白名单）
  assert.equal(isSensitivePath('C:\\Users\\YourName\\.dsh\\.credentials.yaml', withExtra).hit, true, 'DSH 凭据目录');
  assert.equal(isSensitivePath('E:\\SnowLuma\\config\\onebot_123456789.json', withExtra).hit, true, 'SnowLuma 网关 token 文件');
  assert.equal(isSensitivePath('<你的仓库路径>\\qq-bridge\\config.json', withExtra).hit, true, '桥接自身 config.json');
  // 但别的项目里的 config.json 不该被封（那很常见，也常常确实要发）
  assert.equal(isSensitivePath('D:\\projects\\demo\\config.json', withExtra).hit, false);
  // 空白名单下任何文件都发不出去
  const none = normalizeSendFileConfig({ allowExtensions: [] });
  assert.equal(checkSendFilePath(docx, { cfg: none, ...realFs }).ok, false);
});

await test('文件名净化：去分隔符、去 ..、去隐藏前缀、按上限截断且保留扩展名', () => {
  const cleaned = sanitizeFileName('..\\..\\秘密/报告.docx');
  assert.equal(cleaned, '____秘密_报告.docx');
  assert.ok(!/[\\/]/.test(cleaned), '不允许残留路径分隔符');
  assert.ok(!cleaned.includes('..'), '不允许残留 ..');
  assert.equal(sanitizeFileName('.hidden'), '_hidden');
  const long = sanitizeFileName(`${'a'.repeat(300)}.pdf`, 40);
  assert.ok(long.length <= 40, `实得 ${long.length}`);
  assert.match(long, /\.pdf$/);
  assert.equal(sanitizeFileName(''), 'file');
});

await test('出站审计级别：owner 档（secret）放行本机路径、仍拦凭据；群聊（full）两者都拦', () => {
  const withPath = '文件在你桌面上：C:\\Users\\YourName\\Desktop\\报告.docx';
  const withSecret = 'api_key = sk-abcdef123456';
  assert.equal(auditOutbound(withPath, { level: 'full' }).blocked, true, 'full 档必须拦本机路径');
  assert.equal(auditOutbound(withPath, { level: 'secret' }).blocked, false, 'owner 档要能汇报路径');
  assert.equal(auditOutbound(withSecret, { level: 'secret' }).blocked, true, 'owner 档仍拦凭据');
  assert.equal(auditOutbound(withSecret, { level: 'full' }).blocked, true);
  assert.equal(auditOutbound(withSecret, { level: 'none' }).blocked, false, 'closed-agent owner 私聊保持不拦');
  assert.equal(auditOutbound('普通聊天', { level: 'full' }).blocked, false);
  assert.equal(auditOutbound('token=abcdef', { level: 'secret', knownTokens: ['abcdef'] }).reason, '会话令牌');
});

await test('config.example.json 的扩展名白名单与代码内置清单一致（防文档漂移）', () => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  const configured = normalizeSendFileConfig(example.socialV2?.files).allowExtensions;
  assert.deepEqual([...configured].sort(), [...FILE_ALLOW_EXTENSIONS].sort(),
    'config.example.json 的 allowExtensions 必须与 src/send-file-lib.js 的 FILE_ALLOW_EXTENSIONS 一致');
});

await test('接线完整性：toolFlags / toolMap / MCP 工具 / 出厂配置四处都在', () => {
  // 漏一处不是"少个开关"那么轻：控制台会显示已关闭、而模型每次请求仍收到完整工具描述
  // （本项目在 qq_set_sticker_remark 上踩过同型问题，见 mcp-snowluma-safe.js 的注释）。
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  assert.match(bridge, /'sendFile'[,\]]/, 'config API 的 toolFlags 必须登记 sendFile');
  assert.match(bridge, /sendFile: 'qq_send_file/, 'qq_get_prompt 的 toolMap 必须登记 sendFile');
  assert.match(bridge, /pathname === '\/api\/socialV2\/send-file'/, '桥接路由必须存在');
  assert.match(mcp, /'qq_send_file'/, 'MCP 必须注册 qq_send_file');
  assert.match(mcp, /qq_send_file: 'sendFile'/, 'MCP 的工具开关映射必须登记 sendFile');
  assert.equal(example.socialV2?.tools?.sendFile, true, '出厂配置给管理员留开这个工具');
  assert.equal(example.socialV2?.files?.enabled, true, 'files 段必须随出厂配置发布');
});

// ── 2. 真实路由：只有 Owner 档能发出去 ─────────────────────────────────────
async function withBridge(run, { config = {}, key = 'private:123' } = {}) {
  const h = await bridgeHarness({ config });
  h.setMode('reserved2');
  const st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const post = (body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    // 与真实调用一致（mcp-snowluma-safe.js 的 agentApi）：
    //   · `x-console-token` —— 控制台统一鉴权（MCP 工具进程同时持有控制台令牌与会话令牌）；
    //   · `x-agent-call: 1` —— 声明"这是智能体调用"，避免漏传令牌时退化成管理端全权；
    //   · `x-agent-token`   —— 会话令牌，只放行它自己那个会话。
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'x-console-token': 'fixture-console-token',
      'x-agent-call': '1',
    };
    if (body.token) headers['x-agent-token'] = String(body.token);
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/socialV2/send-file', method: 'POST', headers,
    }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, data }); } });
    });
    req.on('error', reject); req.end(payload);
  });
  try { await run({ h, st, post, key }); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

await test('owner 私聊：合法文件真的走网关发出去（upload_private_file + 正确参数）', async () => {
  await withBridge(async ({ h, st, post }) => {
    const out = await post({ key: 'private:123', token: st.agentToken, path: docx });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal(out.data.ok, true);
    assert.equal(out.data.file, '报告.docx');
    assert.equal(out.data.bytes, 2048);
    const calls = h.calls.http.filter((c) => String(c.url).endsWith('/upload_private_file'));
    assert.equal(calls.length, 1, '必须恰好调用一次 upload_private_file');
    assert.equal(calls[0].body.user_id, 123);
    assert.equal(calls[0].body.name, '报告.docx');
    assert.match(String(calls[0].body.file), /报告\.docx$/);
  });
});

await test('白名单私聊 / 白名单群 / 陌生私聊：一律 403 且不碰网关', async () => {
  // 白名单里的普通好友（只读档）
  await withBridge(async ({ h, st, post }) => {
    const out = await post({ key: 'private:777', token: st.agentToken, path: docx });
    assert.equal(out.status, 403, JSON.stringify(out.data));
    assert.match(out.data.error, /Owner/);
    assert.equal(h.calls.http.length, 0, '被拒时不允许有任何出站调用');
  }, { config: { allow: { private: ['123', '777'], groups: ['456'] } }, key: 'private:777' });

  // 白名单群
  await withBridge(async ({ h, st, post }) => {
    const out = await post({ key: 'group:456', token: st.agentToken, path: docx });
    assert.equal(out.status, 403, JSON.stringify(out.data));
    assert.match(out.data.error, /Owner/);
    assert.equal(h.calls.http.length, 0);
  }, { key: 'group:456' });

  // 陌生私聊（靠 allowAllWhenEmpty 放行聊天，仍不能发文件）
  await withBridge(async ({ h, st, post }) => {
    const out = await post({ key: 'private:999', token: st.agentToken, path: docx });
    assert.equal(out.status, 403, JSON.stringify(out.data));
    assert.equal(h.calls.http.length, 0);
  }, { config: { allowAllWhenEmpty: true, allow: { private: [], groups: [] } }, key: 'private:999' });
});

await test('ownerQQ 未配置时没人能发（fail-closed）', async () => {
  await withBridge(async ({ h, st, post }) => {
    const out = await post({ key: 'private:123', token: st.agentToken, path: docx });
    assert.equal(out.status, 403, JSON.stringify(out.data));
    assert.equal(h.calls.http.length, 0);
  }, { config: { ownerQQ: null } });
});

await test('令牌 / 开关 / 功能开关：缺一不可', async () => {
  // 无令牌：先在统一鉴权处被拒（401），绝不放行到"没凭据也能发文件"
  await withBridge(async ({ h, post }) => {
    const out = await post({ key: 'private:123', path: docx });
    assert.ok([401, 403].includes(out.status), `无凭据必须拒绝，实际 ${out.status}`);
    assert.equal(h.calls.http.length, 0);
  });
  // 错令牌
  await withBridge(async ({ h, post }) => {
    const out = await post({ key: 'private:123', token: 'deadbeef', path: docx });
    assert.equal(out.status, 403);
    assert.equal(h.calls.http.length, 0);
  });
  // 工具开关关闭
  await withBridge(async ({ h, st, post }) => {
    const out = await post({ key: 'private:123', token: st.agentToken, path: docx });
    assert.equal(out.status, 403);
    assert.match(out.data.error, /qq_send_file/);
    assert.equal(h.calls.http.length, 0);
  }, { config: { socialV2: { tools: { sendFile: false } } } });
  // 功能总开关关闭
  await withBridge(async ({ h, st, post }) => {
    const out = await post({ key: 'private:123', token: st.agentToken, path: docx });
    assert.equal(out.status, 403);
    assert.match(out.data.error, /关闭/);
    assert.equal(h.calls.http.length, 0);
  }, { config: { socialV2: { files: { enabled: false } } } });
});

await test('敏感路径 / 非白名单类型 / 超体积：400 且不碰网关', async () => {
  await withBridge(async ({ h, st, post }) => {
    const cases = [
      [idRsa, /敏感目录|凭据|密钥/],
      [script, /不允许发送/],
      [path.join(sandbox, '不存在.docx'), /不存在|无法访问/],
    ];
    for (const [p, re] of cases) {
      const out = await post({ key: 'private:123', token: st.agentToken, path: p });
      assert.equal(out.status, 400, `${p}: ${JSON.stringify(out.data)}`);
      assert.match(String(out.data.error), re);
    }
    assert.equal(h.calls.http.length, 0, '校验失败时不允许有任何出站调用');
  });
  // 体积上限（配置收敛到 1KB，big 是 4KB）
  await withBridge(async ({ h, st, post }) => {
    const out = await post({ key: 'private:123', token: st.agentToken, path: big });
    assert.equal(out.status, 400);
    assert.match(String(out.data.error), /过大/);
    assert.equal(h.calls.http.length, 0);
  }, { config: { socialV2: { files: { maxBytes: 1024 } } } });
});

await test('文件名含凭据赋值时被出站审计拦下（连文件都不发）；普通含 token 字样的名字不误伤', async () => {
  await withBridge(async ({ h, st, post }) => {
    const blocked = await post({ key: 'private:123', token: st.agentToken, path: tokenNamed });
    assert.equal(blocked.status, 400, JSON.stringify(blocked.data));
    assert.match(String(blocked.data.error), /凭据|敏感/);
    assert.equal(h.calls.http.length, 0, '被审计拦下时不允许发出任何东西');
    // 反向：`token-report.docx` 只是名字里有 token 字样，不该被误伤（否则正常文件会被拦）
    const allowed = await post({ key: 'private:123', token: st.agentToken, path: tokenWorded });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
  });
});

await test('限流：同一会话每分钟上限生效，失败不吃额度', async () => {
  await withBridge(async ({ h, st, post }) => {
    const first = await post({ key: 'private:123', token: st.agentToken, path: docx });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const second = await post({ key: 'private:123', token: st.agentToken, path: docx });
    assert.equal(second.status, 400, JSON.stringify(second.data));
    assert.match(String(second.data.error), /频率超限/);
    // 只有成功的第一次真的发出了
    assert.equal(h.calls.http.filter((c) => String(c.url).endsWith('/upload_private_file')).length, 1);
  }, { config: { socialV2: { files: { maxPerMinute: 1, maxPerHour: 5 } } } });
});

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);