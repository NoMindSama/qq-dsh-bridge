# 本分支相对上游的改动

> 上游：https://github.com/NoMindSama/qq-dsh-bridge
> 本分支在原版基础上做了三类改动：**长期记忆（L2）落地**、**面板增强**、**若干修复**。

---

## 一、长期记忆（L2）真正落地

原版的 `memory-facts.js` 实现了完整的数据层（权重、艾宾浩斯衰减、归档、注入选择），
但**写入通道从未接进模型工具链** —— `addFact()` 唯一调用方是人工 CLI 脚本，
所以 `facts/` 目录永远是空的，L2 整层空转。

### 1. 新增 MCP 工具 `qq_fact_add`

**文件**：`qq-bridge/src/mcp-snowluma-safe.js`

- 参数：`key` / `token` / `text` / `tag`
- 工具描述里写清了 6 个 `tag` 的语义（`TAG_WEIGHTS` 是决定权重的唯一依据，
  模型不知道差别就会乱填）
- 明确区分长期事实（跨会话成立）与轻量记忆（会过期）

### 2. 新增 HTTP 端点

**文件**：`qq-bridge/src/bridge.js`

| 端点 | 方法 | 作用 |
|---|---|---|
| `/api/socialV2/fact-add` | POST | 写入长期事实，内部调 `addFact()` |
| `/api/socialV2/facts` | GET | 查询，按权重降序；不传 key 返回全部会话 |
| `/api/socialV2/fact-update` | POST | 按 id 改 text / tag（追加修订记录，不原地改） |
| `/api/socialV2/fact-remove` | POST | 按 id 归档（保留记录，只标记 `archived`） |

### 3. 压缩前整理改用 `qq_fact_add`

**文件**：`qq-bridge/src/bridge.js` → `summarizeForIdleV2`

原提示词写着「长期事实写用 `qq_memory_append`」—— 但那个工具只写 `social-v2.json`
的轻量记忆，**从不碰 `facts/`**。模型照着做，写的全是会过期的话题。

改后：

- 长期事实走 `qq_fact_add`，自我认知仍走 `qq_memory_append(category=selfNote)`
- **把已有 facts 和 selfNote 一起喂进提示词**，让它自己判断哪些已经记过
- 加了正反例，减少流水账

### 4. 每轮唤醒附带加权提示

**文件**：`qq-bridge/src/bridge.js` → `buildWakePromptV2`

只在 `factsLine` 非空时追加：

```
【长期记忆·加权】如果这轮对话里有人提到了上面【长期记忆】中的某件事，
用 qq_fact_add 把那条事实原样再写一遍 —— 重复写入只会给它加权，不会多存一条。
```

**零额外成本**：拼进本来就要跑的那一轮唤醒包里，不新开会话、不额外调模型。

---

## 二、控制台面板增强

**文件**：`dsh-plugins/dsh-thinking-zh/`

### 新增「长期记忆」页签

- 每条约一张卡，按权重从高到低
- 左侧类别色条（身份蓝 / 约定紫 / 情绪粉 / 偏好绿 / 梗橙 / 其他灰）
- 权重数值分档上色（≥2.8 绿 / ≥1.5 黄 / <1.5 灰）
- **内联编辑**：正文 textarea + 类别下拉，改 tag 会重算 baseWeight
- 两段式删除（点一次变「确认删除」，5 秒无操作自动退回）

### 新增「群友印象」页签

- 每人一张卡，两列网格
- 名字用品牌色，和「长期记忆」的正文白区分
- 每条 trait 左侧竖线，多条时读作列表
- 同样支持内联编辑 + 改名 + 两段式删除

### 对应后端路由

`qq-bigfish.js` 新增 `handleFacts` / `handleImpressions`，转发到桥接的四个端点。

---

## 三、修复

### 1. `tools/fix-session-preset.mjs` 解压 bug

原版用 `zlib.zstdDecompressSync(raw)` 一次性解压，但 DSH 的会话日志是
**每事件一个 zstd 帧**的格式（实测单会话 10316 帧），单流解压只解出第 1 个
header 事件，于是永远找不到系统提示片段，脚本报「没找到」。

重写为：逐帧解压 → 文本层替换 → 每行一帧重新压缩 → **解压自检逐行比对**，
不一致就拒绝写盘。

### 2. 端口发现取最低端口

**文件**：`tools/qq-bot.ps1`、`dsh-plugins/.../qq-bigfish.js`

DSH 桌面端每次都监听**三个连续端口**，只有**最低**那个是 Web UI 且接受 Cookie 鉴权；
+1 / +2 只接受 Bearer token。原版取任意一个，会 401。

### 3. 移除 `qq_get_self_image` 工具

该工具返回固定的鲸鱼娘图片，与自定义人格冲突。已从工具注册、默认值、
`toolFlags`、控制台名称映射、`console.html` 勾选框、`config.example.json`
以及 `/api/socialV2/self-image` 端点全部移除。

---

## 四、改动文件清单

```
dsh-plugins/dsh-thinking-zh/lib/client.js                        +485
dsh-plugins/dsh-thinking-zh/lib/features/qq-bigfish.js            +84
qq-bridge/src/bridge.js                                          +287
qq-bridge/src/mcp-snowluma-safe.js                                +61
tools/qq-bot.ps1                                                  +13
tools/fix-session-preset.mjs                                     新增
qq-bridge/roles/若叶睦.md                                         新增
qq-bridge/config.example.json                                      -1
qq-bridge/public/console.html                                      -1
qq-bridge/scripts/console-ui-contracts.json                      ±8
qq-bridge/scripts/test-qq-preset-contract.mjs                     ±2
qq-bridge/dsh/agent-presets/*/agent.cordis.yml                 格式重排
qq-bridge/plugins/qq-agent-presets/presets/*.patch.yml         重新生成
qq-bridge/roles/傲娇助手.md                                       删除
```

---

## 五、需要注意

1. **`config.json` 与 `state/` 不进版本库**（`.gitignore` 已排除），
   使用时需要自己从 `config.example.json` 复制并填写。
2. **preset 改动只对新建会话生效**。已有会话的系统提示词是冻结在会话日志里的，
   要么用 `tools/fix-session-preset.mjs` 改写，要么等会话重建。
3. **`qq_fact_add` 的 tag 决定权重**，工具描述里已写明 6 个语义，换文案时别删。
