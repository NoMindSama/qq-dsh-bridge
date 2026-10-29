# QQ DSH Bridge · 让 DSH 住进 QQ

> 把一个真正能干活、有记忆、还会慢慢长成"只属于你"的 AI Agent，搬进你的 QQ。

不是"QQ 机器人框架"，而是**把 DSH（DeepSeek Harness）桌面端 agent 接进 QQ 的适配层**。它不模拟一个假人，它就是你在桌面端用的那个 agent —— 只是换了个入口说话。

```
QQ 私聊 / 群聊  ⇄  SnowLuma(OneBot v11)  ⇄  qq-bridge  ⇄  DSH Web API  ⇄  agent loop  ⇄  MCP 工具
```

---

## 目录

- [它是什么 / 不是什么](#它是什么--不是什么)
- [能做什么](#能做什么)
- [架构](#架构)
- [三个核心设计](#三个核心设计)
  - [人格：三层结构，而且会成长](#1-人格三层结构而且会成长)
  - [上下文：只在闲置边界压缩](#2-上下文只在闲置边界压缩)
  - [记忆：四层 + 一层关于自己](#3-记忆四层--一层关于自己)
- [安装](#安装)
  - [前置条件](#前置条件)
  - [方式 A：手动安装](#方式-a手动安装推荐)
  - [方式 B：让 Agent 帮你装](#方式-b让-agent-帮你装)
  - [配置 config.json](#配置-configjson)
  - [怎么确认装好了](#怎么确认装好了)
- [日常使用](#日常使用)
- [目录结构](#目录结构)
- [常见问题](#常见问题)
- [二次开发](#二次开发)

---

## 它是什么 / 不是什么

**是**：

- 一个把 DSH agent 当作"人"接进 QQ 的桥接层
- 一个能让 AI 主动干活的地方：读写文件、执行命令、发文件、发表情、搜索、发说说
- 一个会记住你、并且会记住"自己变成了什么样"的 AI
- 一套把 token 成本压到最低的上下文管理机制

**不是**：

- 不是"接了个大模型 API 的聊天机器人"——它背后是完整的 agent 循环，能多步调用工具
- 不是开箱即用的 SaaS——需要你自己准备 DSH、SnowLuma、一个 QQ 号
- 不是"无感知部署"——出于雪鸮（SnowLuma）的 EULA 限制，**桥接只探测、不代启 SnowLuma**，每次开机需要你手动启动它

---

## 能做什么

| 能力 | 说明 |
|---|---|
| **私聊对话** | owner 私聊走"助手档"：完整本地工具（读写文件、pwsh），能远程操作电脑 |
| **群聊参与** | 群聊走"群友档"：能聊天、发表情、看图、搜索，但**没有本地工具和管理权限**（防越权） |
| **远程控制** | 私聊里让它"把桌面那份报告发给我"、"看看这个文件"、"跑个命令" |
| **发文件** | 仅 owner；47 种扩展名白名单、敏感路径黑名单、30MB 上限 |
| **表情包** | 收藏、识别（看图理解）、发送、斗图；动图会抽帧拼网格 |
| **看图** | 收到的图片/表情直接进模型上下文 |
| **合并转发** | 能读嵌套转发内容 |
| **QQ 空间** | 发说说 / 列表 / 删除（仅 owner，每日限额） |
| **联网搜索** | 搜索 + 抓取正文，带 SSRF 防护 |
| **长期记忆** | 四层记忆 + 检索 + 自我认知（见下文） |
| **多档权限** | owner / 只读白名单 / 仅聊天，三档 preset 物理隔离 |
| **可视化控制台** | 状态、节奏、人格、Token 花费、表情、访问控制、诊断 |

---

## 架构

### 五层链路

```
① QQ 世界（腾讯私有协议）
      │  SnowLuma —— 原生组件注入 QQ 进程，转成 OneBot v11
      ▼
② OneBot v11（WS 3001 / HTTP 3000）
      │  qq-bridge —— 协议翻译、会话管理、安全闸门、控制台
      ▼
③ DSH Web API（Cookie 鉴权 + slash RPC + remote.mux 事件流）
      │  DSH agent loop（模型 + 工具 + 压缩）
      ▼
④ MCP 工具 ×3（snowluma / host / web-search）
      │  桥接把 agent 的动作翻译回 OneBot
      ▼
⑤ 回到 QQ
```

**每层都不可省**：

- **SnowLuma**：把 QQ 私有协议标准化成 OneBot（本项目不包含它，需自行获取）
- **qq-bridge**：把标准协议翻译成 DSH API 调用，再把 agent 动作翻译回去
- **MCP**：给模型装上"手和嘴"
- **DSH**：agent loop、历史、压缩、会话存储

### 一条消息的来回

**入站**：

1. QQ → SnowLuma → OneBot WS → 桥接收事件
2. 判白名单 / 黑名单 / 运行模式，不通过直接丢弃
3. 写未读队列 + 落盘；同时往记忆库追加原文
4. 判唤醒条件：@我 / 叫名字 / 关键词 / 提问 / 拍一拍 / 概率 / 任意消息
5. 命中且会话空闲 → **防抖合批窗口**（默认 2 秒）→ 组包投给 DSH
6. 会话忙 → 进待唤醒队列，本轮结束后补发

**出站**：

7. agent 产出文本（**不自动发送**）+ 工具调用
8. 工具打到桥接 HTTP API，再过一遍：白名单 + 档位 + 工具开关 + 限流 + 敏感词
9. 通过 → SnowLuma → QQ
10. 发完挂"回复窗口"：对方回你 → 立刻叫醒；没人回 → 不叫
11. agent 收尾（标已读 / 设下次唤醒）→ 回合结束

---

## 三个核心设计

这三件事是这个项目最不值得替换掉的部分，也是踩了很多坑换来的。

### 1. 人格：三层结构，而且会成长

**人格分四层，各管各的**：

```
① preset persona      ← 出场设定（它是谁、底线、说话方式）  进 system prompt，可缓存
② agent-context 注入   ← 身份 / 会话令牌 / 表情库 / 长期事实  进 system prompt，每会话独立
③ 角色卡（可选）       ← roles/*.md，临时"扮演"某个人格         走 qq_get_prompt 按需查
④ 唤醒包              ← 本轮"谁说了什么"                     进 user message
```

**关键设计：persona 是出场设定，不是终身剧本。**

- 它会**被相处改变**：对方的节奏、在意什么、你们形成的默契，会长进它的脾气里
- 但变化**是它选的**：值得学的学，觉得不对的可以不学、也可以直说
- **不同的人用，最后会得到不一样的个体**——这是设计如此，不是 bug

支撑这件事的是第 4 层记忆里的 **selfNote**（见下文）。

> 修改人格：编辑 `qq-bridge/dsh/agent-presets/qq-chat-owner/agent.cordis.yml` 里的 `id: persona` 段，然后 `node scripts/setup-dsh.mjs desktop` + 重启 DSH。

### 2. 上下文：只在闲置边界压缩

**这是本项目在延迟上最重要的一次修正。**

踩过的坑：DSH 内置的 `compaction-basic` 是**在 agent loop 里每步检查阈值**的。阈值一低，上下文就长期骑在压缩线上，每隔两三步压一次。

而压缩会**改写对话历史的前缀**，provider 的 KV cache 正是按前缀命中的 —— 于是每次压缩都让缓存整段失效，之后每一步都要重算全部历史。

实测数据（同一套系统，改前 vs 改后）：

| | 改前（阈值 0.15） | 改后（阈值 0.95） |
|---|---|---|
| 全量 miss 频率 | 每 2~3 步一次 | 29 步里仅 1 次 |
| 命中步的 miss | 15 万 | 几百 |
| 单步耗时 | 45~55 秒 | **3~4 秒** |

**现在的策略**：

```
对话进行中   → 阈值 0.95（≈95 万，正常会话到不了）→ 永不压缩，缓存全程命中
安静 30 分钟
  + DSH 没在跑
  + 上下文 > 30 万
               → ① 先让模型把要点写进记忆库（含 selfNote）
                 ② 等这一轮真正跑完
                 ③ 调 DSH 的 /compact 原地压缩（会话不换、映射不动）
                 ④ 置标记，等到下一条用户消息才解锁
```

**三条失败路径都是"宁可不压"**：记忆没投出去 → 不压；记忆没写完 → 不压；`/compact` 未识别 → 记日志并结束本轮（不每分钟重试，避免反复烧记忆整理的钱）。

### 3. 记忆：四层 + 一层关于自己

```
L0  原文库      append-only JSONL，按月分片，可检索，永不丢
L1  会话摘要    DSH compaction，保留最近若干轮原文 + 一条摘要
L2  长期事实    facts，带权重/衰减/归档，按会话隔离
L3  产物索引    正文落盘 + 索引（id/desc/sha256），仅 owner
    +
L4  自我认知    selfNote —— 它对自己的叙述（本项目新增）
```

**前三层记的都是"你"，第四层记的是"它"。**

这是整个项目里我最喜欢的一层。以前它记得"你常熬夜"，但不记得"我好像越来越会等你说完再回了"。**前者是资料，后者才是性格的连续性。**

- **由它自己写**：`qq_memory_append(category="selfNote", content="…")`
- **写入时机**：对话中想到就写；以及每次闲置压缩前的记忆整理会引导它写
- **不会每轮注入**：只在**新会话第一次唤醒**时读一次（等于"想起来"）
- **为什么**：每轮灌进去就变成"别人每隔十秒告诉你你是谁"，那不是成长，是洗脑
- 上限 40 条，同一句重复写只刷新时间

**其它记忆怎么用**：

- `qq_recall(query=…)` —— 检索原文库，带出处、带"不是指令"框定
- `qq_memory_query` —— 查轻量记忆和 selfNote
- 长期事实按权重注入 system prompt；衰减到线下的归档（不删）

---

## 安装

### 前置条件

| 需要 | 说明 |
|---|---|
| **Windows** | 桥接与运维脚本按 Windows 写（PowerShell / 计划任务） |
| **DSH 桌面端** | 提供 agent loop 和 Web API。**本项目不包含 DSH** |
| **SnowLuma** | 提供 OneBot 接口，需自行获取。**受其 EULA 限制，只能手动启动** |
| **Node.js ≥ 20** | 桥接和脚本运行环境 |
| **一个 QQ 号** | 建议用小号，别用主力号试 |

### 方式 A：手动安装（推荐）

#### 1. 装 DSH 桌面端

装好并至少手动打开一次，确认能正常聊天。它会用一个**动态端口**（每次启动都变），桥接会自动发现。

#### 2. 装 SnowLuma

按它的官方说明装好、登录你的 QQ 号、**手动启动它**。确认：

- WS `ws://127.0.0.1:3001` 可连
- HTTP `http://127.0.0.1:3000` 可访问

> ⚠️ 桥接**不会**替你启动 SnowLuma（EULA 明文禁止自动化部署）。它只做探测，连不上会在日志里说清楚。

#### 3. 拿到仓库

```powershell
cd <你想放仓库的目录>
git clone <本仓库地址> qq-dsh-bridge
cd qq-dsh-bridge\qq-bridge
npm install
```

#### 4. 生成配置

```powershell
# 从示例复制一份自己的配置（config.json 不要提交进 git）
Copy-Item config.example.json config.json
```

#### 5. 改三个必填项

打开 `config.json`，**这三项不改一定跑不起来**：

```jsonc
{
  "ownerQQ": 123456789,          // ① 你的 QQ 号（管理员，能用全部工具）
  "allow": {
    "private": [123456789],      // ② 允许私聊的 QQ 号（和上面一致）
    "groups": []                 // ③ 想接入的群号，不填就是只服务私聊
  },
  "snowluma": {
    "accessToken": "……",         // ④ 从 SnowLuma 的配置里抄过来
    "homeDir": "E:/SnowLuma"     // ⑤ SnowLuma 安装目录（用于自动发现 token）
  }
}
```

> `allow.groups` 留空 = **不响应任何群消息**。很多人第一次装完以为坏了，其实是这里没填。

#### 6. 装 preset 和插件进 DSH

```powershell
node scripts/setup-dsh.mjs desktop
```

看到 `Done. Restart DSH` 就成了。它会做四件事：

- 生成三个 agent preset（owner / 只读 / 仅聊天）
- 把 MCP 三件套挂进 DSH profile
- 链接控制台插件
- 写 `cordis.patch.yml`

> 如果它报 `dsh plugin ... 退出码 1`，通常是正常的：desktop profile 由 Electron 独占管理，CLI 改不动，但 links 和 patch 已经就位。

#### 7. 配 agent-context 插件的 token 路径

这一步**最容易漏**。`plugins/qq-agent-context` 需要读桥接的控制台令牌，才能把身份/令牌/事实注入 system prompt。

在 DSH 的 profile 配置里给它配上（`tokenFile` 指到你仓库里的那个文件）：

```yaml
- id: qq-agent-context
  config:
    bridgeUrl: 'http://127.0.0.1:3100'
    tokenFile: '<你的仓库路径>\qq-bridge\state\console-token'
```

> 没配也能跑，只是**不会注入**（模型看不到会话令牌，工具调用会全部被拒）。所以配完一定要验证。

#### 8. 启动

```powershell
# 回到仓库根目录
cd ..
powershell -ExecutionPolicy Bypass -File tools\qq-bot.ps1 status   # 先看环境
powershell -ExecutionPolicy Bypass -File tools\qq-bot.ps1 start
```

**然后重启 DSH 桌面端**（preset 改动需要重启才生效）。

### 方式 B：让 Agent 帮你装

这个项目本身就是给 agent 准备的，所以**可以让 agent 替你装**。

把仓库丢给你的 agent（DSH / Claude Code / Cursor 都行），说一句：

```
按 README 的「方式 A」帮我装这个 QQ 桥接。
需要我提供的信息你先问我：我的 QQ 号、SnowLuma 的路径和 token、想接的群号。
装完把每一步的结果告诉我，最后帮我验证能不能正常收发消息。
```

**agent 应该做的事**（你可以拿这个 checklist 盯它）：

1. `npm install`
2. 从 `config.example.json` 复制 → 改 `ownerQQ` / `allow` / `snowluma.accessToken`
3. `node scripts/setup-dsh.mjs desktop`
4. 配 `qq-agent-context` 的 `tokenFile`
5. 启桥接、重启 DSH
6. 用 `tools/qq-bot.ps1 status` 验证各层连通

**唯一它做不了的是启动 SnowLuma**（EULA），这一步必须你自己来。

### 配置 config.json

只列最容易踩的，完整项见文件注释。

| 键 | 作用 | 备注 |
|---|---|---|
| `ownerQQ` | 管理员 QQ | 决定谁是"全权限档" |
| `allow.private` | 私聊白名单 | 数组，多个逗号分隔 |
| `allow.groups` | 群白名单 | **留空 = 不接群** |
| `deny` | 黑名单 | 优先于白名单 |
| `dsh.provider` / `dsh.model` | 用哪个模型 | **留空 = 跟随 DSH**（推荐）。填了会改掉 DSH 全局默认 |
| `socialV2.wake.batchWindowMs` | 连发消息合并窗口 | 默认 8000；调小更灵敏，调大更省 |
| `socialV2.send.maxSendPerMinute` | 发送限流 | **别调太高，会被 QQ 风控** |
| `socialV2.compaction.thresholdTokens` | 闲置压缩阈值 | 默认 300000 |
| `socialV2.compaction.idleMs` | 闲置多久算边界 | 默认 30 分钟 |
| `socialV2.proactive.enabled` | 会不会主动找你 | `false` 则纯被动 |
| `role.maxInjectChars` | 角色卡注入上限 | 默认 6000 |

> ### 模型怎么配？留空就行
>
> `dsh.provider` 和 `dsh.model` **留空时，桥接完全不干预**：DSH 当前会话用什么模型，QQ 这边就用什么。
> 你在 DSH 桌面端切模型，QQ 这条线会跟着变（百炼、官方 DeepSeek 都验证过）。
>
> **为什么默认这样**：桥接不知道你的 DSH 接的是官方 DeepSeek、百炼、Kimi 还是本地 Ollama。
> 强行指定只会带来两个副作用——
> ① 配错了每轮报错（虽然能跑，但日志刷屏）；
> ② 配对了会**写穿 DSH 全局默认**（`~/.dsh/settings.yaml` 的 `agent-default-model`），
> 把你桌面端新建对话的默认模型一起改掉。
>
> **只有确实想让 QQ 这条线锁死某个模型时才填**，并且要知道上面那个副作用。
> 留空还有个代价：`reasoningEffort`（思考强度）也不再生效——"完全跟随"和"独立控制"只能选一个。

### 怎么确认装好了

```powershell
cd qq-dsh-bridge
powershell -ExecutionPolicy Bypass -File tools\qq-bot.ps1 status
```

**全部打勾才算通**：

```
✓ SnowLuma 运行中（端口 3000 / 3001）
✓ 发现 DSH 实例（desktop，端口 xxxxx）
✓ 桥接运行中（PID xxx）
  DSH 就绪: ✓   模式: reserved2
  SnowLuma: 连接=True  账号在线=True
  控制台 http://127.0.0.1:3100
```

**然后做一次真实往返**：

1. 用你的 QQ 给机器人号发一句"在吗"
2. 它应该秒回（或几秒内）
3. 打开控制台 `http://127.0.0.1:3100`，看「状态」页有没有这一轮的记录

**没反应？** 按这个顺序查：

| 现象 | 先查 |
|---|---|
| 完全没反应 | `allow.private` 里有没有你的 QQ 号 |
| 有反应但工具全报"令牌无效" | `qq-agent-context` 的 `tokenFile` 没配 |
| 一直"会话繁忙" | DSH 里有卡住的回合，重启 DSH |
| 发不出消息 | `send.maxSendPerMinute` 是不是被调太高、触发了风控 |
| 群聊不响应 | `allow.groups` 是空的 |

---

## 日常使用

**在 QQ 里**（不需要任何前缀）：

- 「在吗」「帮我把桌面的周报发我」—— 它会用工具去做
- `/reset` —— 重置会话（清上下文，记忆保留）
- `/status` —— 查当前状态
- `/role 傲娇助手` —— 切角色卡（也可以 `/role off` 关掉）

**在控制台**（`http://127.0.0.1:3100`，令牌在 `qq-bridge/state/console-token`）：

- 运行总览 / 会话与审批 / 人格与角色 / 二代仿真 / 令牌与花费 / 访问与安全 / 调试运维

**运维脚本**：

```powershell
tools\qq-bot.ps1 status | start | stop | restart | logs 50
tools\qq-bot.ps1 backends          # 发现 DSH 实例与端口
tools\qq-bot.ps1 use desktop       # 切换桥接到桌面端
tools\bridge-guard.ps1             # 看门狗（建议注册成计划任务）
tools\memory-backup.ps1            # 记忆库每日备份
```

---

## 目录结构

```
qq-dsh-bridge/
├── qq-bridge/                     # 桥接主进程
│   ├── src/
│   │   ├── bridge.js              # 主进程：会话/路由/唤醒/发送/控制台 API
│   │   ├── dsh-client.js          # DSH 协议适配（Cookie / slash RPC / mux）
│   │   ├── snowluma-conn.js       # OneBot 连接与重连
│   │   ├── mcp-snowluma-safe.js   # QQ 工具集 + 工具索引 + 错误翻译
│   │   ├── memory-store.js        # L0 原文库
│   │   ├── memory-facts.js        # L2 长期事实（权重/衰减）
│   │   ├── memory-search.js       # L3 检索（中文 bigram 倒排）
│   │   ├── artifact-store.js      # 产物索引
│   │   ├── media-normalize.js     # 图片/动图归一化
│   │   ├── voice-core.js          # 语音探测/转码
│   │   └── sensitive.js           # 敏感词/凭据脱敏
│   ├── dsh/agent-presets/         # 三个 agent preset（人格 + 工具面 + 压缩策略）
│   ├── plugins/                   # DSH 侧插件（agent-context / mode-console）
│   ├── scripts/                   # 安装、记忆、审计、测试脚本
│   ├── public/console.html        # 独立控制台
│   ├── roles/                     # 角色卡（示例）
│   └── config.example.json        # 配置模板
├── tools/                         # 发行层运维脚本
└── dsh-plugins/dsh-thinking-zh/   # DSH 内的设置面板（人格/节奏/Token/表情）
```

---

## 常见问题

**Q：SnowLuma 为什么必须手动启动？**
A：它的 EULA §5.4 禁止自动化部署。桥接只探测、不代启，这是**故意**的。

**Q：为什么它不自动发我打的字，还要调工具？**
A：二代模式的设计是「文本=思考，工具=发言」。这样它可以在心里打草稿、推翻、试错，只把成品发出去——这是它说话不像机器人的前提。

**Q：能换模型吗？**
A：能，改 `config.json` 的 `dsh.provider` / `dsh.model`，和你在 DSH 里选的保持一致。不同 provider 的缓存命中率差别很大，**如果觉得慢，先怀疑缓存命中，别先怀疑上下文太大**。

**Q：上下文会不会越聊越大？**
A：会在一次对话内增长（这是缓存命中的前提），但在**闲置 30 分钟且超过 30 万 token** 时会做一次边界压缩。日常不用担心。

**Q：会不会自己找我说话？**
A：会。`socialV2.proactive` 控制：默认空闲 15 分钟后，每 30~90 分钟掷一次骰子，还有四层降权（刚说过话、半夜、一小时内说太多）。想彻底关掉就设 `enabled: false`。

**Q：我的聊天记录会上传到哪吗？**
A：不会。所有数据都在 `qq-bridge/state/` 本地。但**注意**：模型的推理是在你配置的 provider 上跑的（比如官方 API），这部分和其他 AI 产品一样。

---

## 二次开发

**建议先读这三处**，它们承载了最核心的取舍：

| 位置 | 内容 |
|---|---|
| `dsh/agent-presets/qq-chat-owner/agent.cordis.yml` → `id: persona` | 人格全文 |
| `src/bridge.js` → `idleCompactV2` | 上下文边界压缩 |
| `src/bridge.js` → `appendMemoryV2` | 记忆写入（含 selfNote） |

**改完一定要跑**：

```powershell
node scripts/test-audit.mjs        # 全量审计（38 个脚本）
node scripts/test-token-economy.mjs
node scripts/test-qq-preset-contract.mjs
```

**几条别踩的线**：

- **别把 `bridge.js` 拆成多个文件**：上游 90+ 测试绑着当前结构，拆了升级会变成噩梦
- **别把压缩阈值调回 0.15**：那会让上下文骑在压缩线上，把缓存打死（有测试守着这条）
- **别砍掉防"永眠"的两个安全网**（`maxWakeConfigReminders` / `noActionLimit`）：砍了会静默失联

---

## License

见 [LICENSE](qq-bridge/LICENSE)。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai) —— agent 运行时
- SnowLuma —— OneBot 接入（需自行获取，受其 EULA 约束）