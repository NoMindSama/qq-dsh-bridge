// 共享的敏感信息审计正则：桥接回复、MCP 发送、审批/提问文本等统一使用，避免两处维护不一致。
// 拦截本机路径/凭据特征；凭据关键词需带赋值关系才判定，避免误伤正常聊天。
// UNC 的主机/共享名之间只有一个反斜杠；JSON 键名可能带引号。
// 这是内容审计的启发式规则，不能代替会话权限控制或对已知令牌的精确拦截。
//
// 两道内容闸门是**有意互补**的，不是重复实现：
//   ① 这里（启发式）：抓"长得像路径 / 像凭据赋值"的文本，任何一条出站文本都能过；
//   ② KNOWN_AGENT_TOKENS 精确名单（bridge.js）：抓**已知的**会话令牌原文，
//      覆盖 onebotSend / redactKnownTokensOnly 这类刻意不跑 SENSITIVE_RE 的发送路径。
// 为什么第二条不可省：32 位十六进制的裸会话令牌**不匹配**下面的正则（它既不是路径，
// 也没有 token= 这种赋值形态），只有精确名单能拦住它。
// 反过来，**不要**为了让这条正则"顺带"覆盖裸 32-hex 而往里加 [0-9a-f]{32}：
// 表情 md5、图片 URL、消息里的十六进制串本身就是 32-hex，加进去会把正常的表情包与消息
// 整条拦掉/打码（误伤面远大于收益）。要收紧令牌泄漏，请走精确名单那条路。
export const SENSITIVE_RE = /((?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]+|\\\\[^\\\s"'<>|]+\\[^\s"'<>|]+|(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/etc\/|\/var\/|\/root\/)[^\s"'<>|]*|(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential)["']?(?:\s*(?:[:=：]|是|为)\s*["']?[^\s，。；、"']{3,}|\s+[A-Za-z0-9_\-./]{3,}))/i;

/**
 * 只抓「凭据赋值」的那一半（SENSITIVE_RE 的第 4 组），不含路径。
 *
 * 为什么要拆出来：三档权限分级的 **Owner 档**（`private:<ownerQQ>`，收件人就是这台机器的
 * 主人）需要放行本机路径 —— 他让 AI"读一下桌面那个文件"之后，AI 只要在回复里带上完整
 * 路径，整条回复就会被 SENSITIVE_RE 拦掉，用户看到的是"AI 没反应"。而凭据/令牌必须继续拦：
 * 那是**外发到 QQ**（会落到腾讯服务器与聊天记录里）的东西，与"路径对主人不是秘密"不同。
 *
 * 口径与 closed-agent 的既有设计一致：那里的 owner 私聊完全不审计；Owner 档更保守一点，
 * 只放行路径、仍然拦凭据与已知令牌。
 */
export const CREDENTIAL_RE = /(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential)["']?(?:\s*(?:[:=：]|是|为)\s*["']?[^\s，。；、"']{3,}|\s+[A-Za-z0-9_\-./]{3,})/i;

/**
 * 出站审计判定（**唯一实现**，所有发送路径共用）。
 *
 * @param {string} text 即将外发的完整文本
 * @param {object} options
 * @param {'none'|'secret'|'full'} [options.level] 审计级别：
 *   `none` 完全不拦（closed-agent 的 owner 私聊）；`secret` 只拦凭据与已知令牌（Owner 档）；
 *   `full` 路径 + 凭据 + 令牌全拦（默认：群聊 / 白名单 / 陌生会话）。
 * @param {Iterable<string>} [options.knownTokens] 已知会话令牌原文（精确名单）
 * @returns {{blocked:boolean, reason:string}}
 */
export function auditOutbound(text, { level = 'full', knownTokens = [] } = {}) {
  if (level === 'none') return { blocked: false, reason: '' };
  const s = String(text ?? '');
  for (const t of knownTokens) {
    if (t && s.includes(t)) return { blocked: true, reason: '会话令牌' };
  }
  if (CREDENTIAL_RE.test(s)) return { blocked: true, reason: '凭据特征' };
  if (level === 'full' && SENSITIVE_RE.test(s)) return { blocked: true, reason: '本机路径/凭据' };
  return { blocked: false, reason: '' };
}
