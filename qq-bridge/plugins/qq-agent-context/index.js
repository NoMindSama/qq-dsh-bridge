// QQ 会话上下文注入（Host 插件）。
//
// 解决的是这个具体现象：桥接每轮唤醒都会把「身份 / 会话令牌 / 可用表情 / 长期记忆」
// 拼进一条 user message 发给模型，于是模型的每一轮开场白都是系统指令，而不是人话；
// 这些内容还会随对话历史一起累积，压缩（compaction）之后可能被摘要掉，令牌一丢工具全废。
//
// 做法：在**每个 QQ 会话自己的 agent 作用域**里注册一个系统提示词段。
//   1. 只在 system prompt 里出现，不进对话历史 —— 模型看到的第一句人话就是「hello」；
//   2. 每轮重新装配，不会因为压缩而消失；
//   3. 内容按会话隔离，群聊与私聊各是各的。
//
// 注意：`text` 是同步函数（DSH 每步装配时同步求值），所以内容必须来自本地缓存，
// 不能在里面发请求。缓存由 agent/created 与定时刷新维护。

const DEFAULT_BRIDGE = 'http://127.0.0.1:3100';
// 控制台令牌文件：**不要写死绝对路径**（换台机器就再也读不到，而且开源会泄露作者目录）。
// 优先级：插件 config.tokenFile > 环境变量 QQ_BRIDGE_TOKEN_FILE > 空。
// 默认留空 = 不注入（降级运行），而不是猜一个大概率不对的路径、让用户以为配好了。
// 安装时请显式配置：见 README「安装 → 配置 tokenFile」。
const DEFAULT_TOKEN_FILE = process.env.QQ_BRIDGE_TOKEN_FILE || '';
const FETCH_TIMEOUT_MS = 1200;
const REFRESH_MS = 120000;
const TOKEN_TTL_MS = 60000;

export const name = 'qq-agent-context';
export const inject = ['systemPrompt', 'agents'];

export function apply(ctx, config) {
  const bridgeUrl = String(config?.bridgeUrl || DEFAULT_BRIDGE).replace(/\/+$/, '');
  const tokenFile = String(config?.tokenFile || DEFAULT_TOKEN_FILE);
  // sessionId → { text, key, at }
  const cache = new Map();
  // sessionId → fiber
  const fibers = new Map();
  let tokenCache = { value: '', at: 0 };

  const textOf = (agent) => cache.get(String(agent.id))?.text ?? '';

  // 控制台令牌：桥接的所有 HTTP 路由都要求它。读文件而不是写进配置，
  // 这样令牌轮换后插件自动跟上（缓存 60 秒，避免每轮都读盘）。
  async function consoleToken() {
    // 没配 tokenFile 就直接空手返回：不读盘、不报错，插件降级为「不注入上下文」。
    // 这比猜路径好 —— 猜错时表现是"插件装好了但模型什么都看不到"，很难排查。
    if (!tokenFile) return '';
    const now = Date.now();
    if (now - tokenCache.at < TOKEN_TTL_MS) return tokenCache.value;
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(tokenFile, 'utf8');
      tokenCache = { value: raw.trim(), at: now };
    } catch {
      tokenCache = { value: tokenCache.value, at: now };
    }
    return tokenCache.value;
  }

  async function fetchContext(sessionId) {
    const url = `${bridgeUrl}/api/socialV2/agent-context?sessionId=${encodeURIComponent(sessionId)}`;
    try {
      const token = await consoleToken();
      const res = await fetch(url, {
        headers: token ? { 'x-console-token': token } : {},
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!res.ok) return null;
      const data = await res.json();
      // 桥接用 ok:false 表示「这个 session 不是 QQ 会话」，不是错误。
      return data?.ok && typeof data.text === 'string' ? data : null;
    } catch {
      // 桥接没启动 / 超时：返回 null，调用方保留旧缓存（宁可旧，不要空）。
      return null;
    }
  }

  async function refresh(agent) {
    const sid = String(agent.id);
    const data = await fetchContext(sid);
    if (data) cache.set(sid, { text: data.text, key: data.key, at: Date.now() });
    return data;
  }

  function install(agent) {
    const sid = String(agent.id);
    if (fibers.has(sid)) return fibers.get(sid);
    // 注册在 agent 自己的作用域里：只对这个会话的系统提示词生效。
    const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.section({
        name: 'qq:session-context',
        // persona 之后（0）、工具说明之前（1000）：模型先建立"我是谁"，再读工具。
        order: 100,
        // 内容是纯文本，不做 {{变量}} 插值（令牌里可能有花括号之类）。
        interpolate: false,
        text: () => textOf(agent)
      });
    });
    fibers.set(sid, fiber);
    return fiber;
  }

  function uninstall(agent) {
    const sid = String(agent.id);
    const fiber = fibers.get(sid);
    fibers.delete(sid);
    cache.delete(sid);
    if (fiber) Promise.resolve(fiber.dispose()).catch(() => {});
  }

  ctx.on('agent/created', async ({ agent }) => {
    // 先取再装：否则第一轮装配可能是空的，模型会拿不到令牌。
    const data = await refresh(agent);
    if (data) install(agent);
  });

  ctx.on('agent/disposed', ({ agent }) => uninstall(agent));

  // 插件热重载/后加载时，已经在跑的会话也要补上。
  for (const agent of ctx.agents.list()) {
    if (cache.has(String(agent.id))) { install(agent); continue; }
    void refresh(agent).then((data) => { if (data) install(agent); });
  }

  // 定时刷新：令牌轮换、表情库变化、长期记忆每天整理，都靠它带进下一轮。
  const timer = setInterval(() => {
    for (const agent of ctx.agents.list()) {
      if (fibers.has(String(agent.id))) void refresh(agent);
    }
  }, REFRESH_MS);
  if (typeof timer.unref === 'function') timer.unref();

  ctx.effect(() => () => {
    clearInterval(timer);
    for (const agent of ctx.agents.list()) uninstall(agent);
  }, 'qq-agent-context: timers and per-agent sections');
}