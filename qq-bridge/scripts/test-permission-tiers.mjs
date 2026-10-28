// 三档权限分级的回归（2026-10-26 新增）。
//
// 档位定义（用户确认过）：
//   Owner     private:<ownerQQ>                → qq-chat-owner     全工具（读写 + 执行）
//   白名单    allow.private / allow.groups      → qq-chat-readonly  只读
//   其他      陌生私聊 / 未收录群               → 配置的聊天 preset（默认 qq-chat-v2）仅聊天
//   黑名单    deny                             → 完全不响应（连消息都不入库，轮不到选 preset）
//
// 这里钉住四件事，它们每一条都对应一个真实的踩坑方向：
//   1. **owner 优先于白名单**（用户明确要求；config.json 的默认形态就是 ownerQQ 也在 allow 里）；
//   2. **分级只看显式白名单**，绝不能用 allowed() 的 allowAllWhenEmpty 兜底 —— 那会把
//      "允许陌生人来聊天"顺手升级成"陌生人可读本机文件"；
//   3. **新 preset 未安装时必须 fail-closed**：宁可 owner 会话建不出来，也不许回退到
//      qq-chat-v2 / DSH 默认 preset（回退方向一旦反了就是把本机交给群里的人）；
//   4. **档位变化要触发会话重建**（靠 sessionPolicy 自动完成，不需要额外的踢会话逻辑）。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
let tests = 0;
async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.message ?? error); }
}
/** harness 的 fixture：ownerQQ=123，allow.private=['123']，allow.groups=['456']，allowAllWhenEmpty=false。 */
async function withBridge(run, config = {}) {
  const h = await bridgeHarness({ config });
  try { await run(h); } finally { await h.close(); }
}

// ── 1. sessionTier：纯函数据档位 ──────────────────────────────────────────────
await test('sessionTier：owner 私聊按 owner 处理（同时也在白名单里时也一样）', async () => {
  await withBridge(async (h) => {
    assert.equal(h.sessionTier('private:123', 'reserved2', h.cfg), 'owner',
      'ownerQQ 与 allow.private 同时命中时必须按 Owner（用户明确要求）');
    assert.equal(h.sessionTier('private:123', 'chat', h.cfg), 'owner');
    assert.equal(h.wantedPresetName('private:123', 'reserved2', h.cfg), h.TIER_PRESETS.OWNER);
  });
});

await test('sessionTier：显式白名单 → readonly（私聊与群聊都算）', async () => {
  await withBridge(async (h) => {
    h.cfg.allow.private.push('777');
    assert.equal(h.sessionTier('private:777', 'reserved2', h.cfg), 'readonly');
    assert.equal(h.sessionTier('group:456', 'reserved2', h.cfg), 'readonly');
    assert.equal(h.wantedPresetName('group:456', 'reserved2', h.cfg), h.TIER_PRESETS.READONLY);
  });
});

await test('sessionTier：陌生会话 → 空档（仅聊天），且 allowAllWhenEmpty 不得提权', async () => {
  await withBridge(async (h) => {
    assert.equal(h.sessionTier('private:999', 'reserved2', h.cfg), '');
    assert.equal(h.sessionTier('group:999', 'reserved2', h.cfg), '');
    // 宽松放行陌生人聊天 ≠ 授权陌生人读本机文件：白名单为空 + allowAllWhenEmpty=true 时
    // allowed() 对陌生人也返回 true（"让他来聊"），但档位必须仍然是空档。
    h.cfg.allow.private = [];
    h.cfg.allow.groups = [];
    h.cfg.allowAllWhenEmpty = true;
    assert.equal(h.modeAllowed('private:999', 'private', 999, h.cfg, 'reserved2'), true, '前提：该配置放行陌生人聊天');
    assert.equal(h.sessionTier('private:999', 'reserved2', h.cfg), '', 'allowAllWhenEmpty 绝不能升级成只读档');
    assert.equal(h.sessionTier('group:999', 'reserved2', h.cfg), '', '群聊同理');
    assert.equal(h.wantedPresetName('private:999', 'reserved2', h.cfg), 'qq-chat-v2', '陌生会话用配置的聊天 preset');
  });
});

await test('sessionTier：deny 优先于 allow（把管理员踢出=自己失联，是已知取舍）', async () => {
  await withBridge(async (h) => {
    h.cfg.deny.private.push('123');
    assert.equal(h.sessionTier('private:123', 'reserved2', h.cfg), '',
      'deny 里的人在档位判定上也要 fail-safe（万一漏了准入检查，也不能发全工具）');
    assert.equal(h.modeAllowed('private:123', 'private', 123, h.cfg, 'reserved2'), false,
      'deny 也挡住 owner——UI 已禁止把管理员行踢出，这里钉住底层语义');
  });
});

await test('sessionTier：群聊里 id 等于 ownerQQ 不升 Owner；非法 key 一律空档', async () => {
  await withBridge(async (h) => {
    assert.equal(h.sessionTier('group:123', 'reserved2', h.cfg), '', '只有 private 才可能是 owner');
    for (const bad of ['', 'private:', 'private:0', 'private:-1', 'private:abc', 'private:0123x', null, undefined]) {
      assert.equal(h.sessionTier(bad, 'reserved2', h.cfg), '', `${JSON.stringify(bad)} 必须是空档`);
    }
    assert.equal(h.sessionTier('private:0123', 'reserved2', h.cfg), 'owner', '前导零是同一账号的别名');
    assert.equal(h.sessionTier('private:123 ', 'reserved2', h.cfg), 'owner', '两端空白会被 canonicalV2Key trim');
  });
});

await test('sessionTier：ownerQQ 未配置 / closed-agent 模式都不参与分级', async () => {
  await withBridge(async (h) => {
    h.cfg.ownerQQ = null;
    assert.equal(h.sessionTier('private:123', 'reserved2', h.cfg), 'readonly', '没有 ownerQQ 时退回白名单档');
    h.cfg.ownerQQ = 123;
    assert.equal(h.sessionTier('private:123', 'closed-agent', h.cfg), '',
      'closed-agent 走 closedAgentPreset / DSH 默认 preset 的既有路径，不套三档');
  });
});

// ── 2. ensureSession：真的把 preset 挂上去 ───────────────────────────────────
await test('owner 私聊建会话时真的挂 qq-chat-owner', async () => {
  await withBridge(async (h) => {
    h.setMode('reserved2');
    await h.ensureSession('private:123');
    assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat-owner');
  });
});

await test('白名单会话建会话时真的挂 qq-chat-readonly', async () => {
  await withBridge(async (h) => {
    h.setMode('reserved2');
    await h.ensureSession('group:456');
    assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat-readonly');
  });
});

await test('allowAllWhenEmpty 放行的陌生会话仍是仅聊天 preset', async () => {
  await withBridge(async (h) => {
    h.setMode('reserved2');
    await h.ensureSession('private:999');
    assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat-v2');
  }, { allowAllWhenEmpty: true, allow: { private: [], groups: [] } });
});

// ── 3. fail-closed：新 preset 没装进 DSH 时绝不降级 ──────────────────────────
await test('分级 preset 未安装时 owner 会话 fail-closed（不降级到 qq-chat-v2 / standard）', async () => {
  await withBridge(async (h) => {
    h.setMode('reserved2');
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']); // 模拟还没跑 setup-dsh / 还没重启 DSH
    await assert.rejects(h.ensureSession('private:123'), (error) => {
      assert.match(error.message, /qq-chat-owner/, '报错必须点名缺的是哪个 preset');
      assert.match(error.message, /权限档位 owner/, '报错要说明是哪个档位');
      return true;
    });
    assert.equal(h.calls.created.length, 0, '绝不能降级建出会话（那会把本地工具发给群聊或让 owner 静默降权）');
  });
});

await test('分级 preset 未安装时白名单会话同样 fail-closed', async () => {
  await withBridge(async (h) => {
    h.setMode('reserved2');
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
    await assert.rejects(h.ensureSession('group:456'), /qq-chat-readonly/);
    assert.equal(h.calls.created.length, 0);
  });
});

await test('preset 清单为空（DSH 未连上）时仍然 fail-closed', async () => {
  await withBridge(async (h) => {
    h.setMode('reserved2');
    h.setPresets([]);
    await assert.rejects(h.ensureSession('private:123'));
    assert.equal(h.calls.created.length, 0);
  });
});

// ── 4. 档位变化 → 会话重建（sessionPolicy 的签名里带着 preset） ──────────────
await test('管理员换人后同一会话按新档位重建（不需要额外的踢会话逻辑）', async () => {
  await withBridge(async (h) => {
    h.setMode('reserved2');
    const first = await h.ensureSession('private:123');
    assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat-owner');
    // 123 被移出 ownerQQ ⇒ 它退回白名单档；同一个 key 必须重建会话，而不是复用 owner 会话。
    h.cfg.ownerQQ = 999;
    const second = await h.ensureSession('private:123');
    assert.notEqual(second, first, '档位变了就必须是新会话');
    assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat-readonly');
    assert.ok(h.calls.cancelled.includes(first), '旧会话要被停掉（stopSessionWork）');
  });
});

await test('把会话加进白名单后按只读档重建（陌生人 → 白名单）', async () => {
  await withBridge(async (h) => {
    h.setMode('reserved2');
    const first = await h.ensureSession('group:789');
    assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat-v2');
    h.cfg.allow.groups.push('789');
    const second = await h.ensureSession('group:789');
    assert.notEqual(second, first);
    assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat-readonly');
  }, { allowAllWhenEmpty: true, allow: { private: [], groups: [] } });
});

await test('同一档位下会话照旧复用（不因分级多建会话）', async () => {
  await withBridge(async (h) => {
    h.setMode('reserved2');
    const first = await h.ensureSession('group:456');
    assert.equal(await h.ensureSession('group:456'), first);
    assert.equal(h.calls.created.length, 1);
  });
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);