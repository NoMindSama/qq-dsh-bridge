// 临时探测：用一个新建的空会话验证 /compact 是否被 DSH 的命令表识别。
// 空会话压缩会返回 "No compactable history yet." —— 能拿到这句话就证明命令通了。
// 结束后归档会话，不留痕。
import { NodeApiClient, unwrap } from '../src/dsh-client.js';
import path from 'node:path';

const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:50806';
const api = new NodeApiClient(BASE, 30000, {
  token: '', tokenExplicit: false, header: 'authorization', prefix: 'Bearer', allowRemote: false,
});

const cwd = path.resolve('state', 'agents');

let wsId = null;
let sid = null;
try {
  const ws = unwrap(await api.workspace.create({ path: cwd }), 'workspace.create');
  wsId = ws.workspace.workspaceId;
  console.log('workspace:', wsId);

  const s = unwrap(await api.sessions.create({ workspaceId: wsId }), 'session.create');
  sid = s.sessionId;
  console.log('session:', sid);

  // 空会话直接压：如果命令被识别，command-compact 会走 compactNow 并返回
  // "No compactable history yet."；没被识别则 execute 返回 undefined。
  const res = await api.callUnary('commands/execute', {
    agentId: sid, line: '/compact', submittedAttachments: [],
  });
  console.log('\n/compact 返回：');
  console.log(JSON.stringify(res?.result ?? res, null, 2));
} catch (error) {
  console.log('ERROR:', error?.message ?? error);
} finally {
  if (sid) {
    try { await api.workspace.archiveSession({ sessionId: sid }); console.log('\n已归档临时会话'); }
    catch (e) { console.log('归档失败（忽略）:', e?.message ?? e); }
  }
}