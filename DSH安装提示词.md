# 安装提示词：qq-dsh-bridge（给 DSH / 任意 coding agent 用）

> 整段复制给 DSH，让它照着做完。文中 `<仓库>` 换成实际解压路径（**不要含空格**）。
> 目标：**装完就是「已经调试好的状态」**，用户不需要再自己研究配置。

---

## 一、你的任务

把 `qq-dsh-bridge` 装到本机，交付时必须同时满足：

1. QQ 私聊能正常收发，单条消息从收到到发出 **≤ 5 秒**
2. DSH 重启后桥接 1 分钟内自愈，并自动对齐新端口
3. 唤醒包（发给模型的上下文）里**不含** `【你的身份】` / `【会话令牌】`
4. 悬浮球（dsh-thinking-zh）已装、能看到
5. 看门狗已注册计划任务
6. SnowLuma 已由你启动，OneBot 已开，**token 已写进桥接配置并告知用户**
7. 唤醒与速率参数已按本文档设置好

## 二、先决条件（不合格先报告，不要硬装）

- Windows 10/11
- DSH 桌面端已安装、能正常聊天（记录 `dsh --version`）
- 一个 QQ 号（建议小号）
- 磁盘 ≥ 2 GB

## 三、五条硬约束（违反必出问题）

1. **依赖只能用 `npm ci`**，禁止 `pnpm install` / `npm install`。
   `package-lock.json` 锁的是精确版本；用 pnpm 会解析到更高版本（实测 `@snowluma/sdk` 1.14.22 而非 1.14.20），MCP 工具 schema 随之漂移，模型报 `tool input is invalid JSON`，表现为回复异常、变慢。
2. **常驻进程必须脱离 DSH 的 Job Object**。
   从 DSH 会话里 `Start-Process` 起的进程，会在 DSH 重启时被一起杀掉（实测 DSH 一重启，3100/3000/3001/5099 同时消失、控制台面板 `fetch failed`）。必须用 WMI `Win32_Process.Create` 或计划任务启动。
3. **不碰仓库源码**。
   唯一允许改动：给所有 `.ps1` 补 UTF-8 BOM（PowerShell 5.1 按 GBK 读无 BOM 的 UTF-8，中文乱码会让 `qq-bot.ps1` 直接语法报错）。
4. **SnowLuma 只「下载 + 启动」，不做分发**。
   你可以：下载官方包、校验哈希、解压、启动、把凭据和 token 交给用户。
   你不可以：重新打包、塞进 Docker 镜像、做无人值守批量部署。
   **同意 EULA/隐私政策、扫码登录必须用户本人完成。**
5. **所有路径不要含空格**（`dsh plugin` 会把参数拼成命令行）。

---

## 四、步骤

### 1. 取仓库

解压到不含空格的路径。注意本机工作区若含中文目录名是允许的（我们实测通过），但**不能有空格**。

### 2. 安装依赖

```powershell
cd <仓库>\qq-bridge
npm ci --registry=https://registry.npmmirror.com
```

**验收**：`node_modules/@snowluma/sdk/package.json` 的 version 必须 == `1.14.20`；postinstall 输出 `[patch-snowluma] @snowluma/sdk: 修补了 13 个文件`。

机器没 npm 时：用任意完整 Node 发行版（官方 zip）自带的 `npm.cmd`，别改用 `npm install`。

### 3. 修 PowerShell 编码（唯一允许的源码改动）

```powershell
Get-ChildItem <仓库> -Recurse -Filter *.ps1 -File | ForEach-Object {
  $b = [IO.File]::ReadAllBytes($_.FullName)
  if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { return }
  [IO.File]::WriteAllBytes($_.FullName, ([byte[]](0xEF,0xBB,0xBF)) + $b)
}
```

### 4. 生成 config.json（含调优，照抄）

复制 `config.example.json`，然后**逐项落实**：

```jsonc
{
  "ownerQQ": <用户QQ>,
  "allow": { "private": [<用户QQ>], "groups": [] },

  "socialV2": {
    "injectViaSystemPrompt": true,          // 必须 true（配合步骤 6）
    "wake": {
      "batchWindowMs": 2000,
      "batchWindowMsPrivate": 2000,         // example 里没有，必须补
      "maxWakePerMinute": 6,                // 默认 1 会排队，见「速率」
      "maxWakePerHour": 60,

      "recommendedAtMention": true,
      "recommendedNameMention": true,
      "recommendedQuestion": true,
      "recommendedPoke": true,
      "recommendedKeywords": [              // 精简版，默认那一长串容易误触发
        "小鲸鱼", "DeepSeek", "deepseek",
        "大肥鱼", "鲸鱼", "D老师", "d老师"
      ]
    }
  },

  "snowluma": { "homeDir": "<SnowLuma 安装目录>", "accessToken": "<步骤 9 拿到的 token>" }
}
```

### 5. 装 DSH 端

```powershell
node scripts/setup-dsh.mjs desktop
```

**验收**：末尾出现 `dsh plugin --profile desktop install: OK` 和 `Done. Restart DSH`。

> 报 `dsh plugin ... 退出码 1` 通常可忽略（desktop profile 由 Electron 独占），但要看 links 和 patch 是否已就位。

### 6. 挂 qq-agent-context（setup-dsh 不含它，必做）

```powershell
$repo = '<仓库>\qq-bridge\plugins\qq-agent-context'
$l1 = "$env:USERPROFILE\.dsh\plugins\qq-agent-context"
$l2 = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\qq-agent-context"
New-Item -ItemType Directory -Force -Path (Split-Path $l2) | Out-Null
New-Item -ItemType Junction -Path $l1 -Target $repo | Out-Null
New-Item -ItemType Junction -Path $l2 -Target $l1 | Out-Null
```

在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: qq-agent-context
      name: '@local/qq-agent-context'
      config:
        bridgeUrl: 'http://127.0.0.1:3100'
        tokenFile: '<仓库>\qq-bridge\state\console-token'
```

> 这一步 + `injectViaSystemPrompt: true` 是配套的：身份/令牌改由插件写进系统提示词，唤醒包才干净。**只开开关不装插件 = 模型拿不到令牌，工具全被拒。**

### 7. 装悬浮球 dsh-thinking-zh（**必装**）

```powershell
dsh plugin --profile desktop add "link:<仓库>\dsh-plugins\dsh-thinking-zh"
```

**验收**：`cd <仓库>\dsh-plugins\dsh-thinking-zh; node scripts/smoke.mjs` 输出 `SMOKE OK`。
界面验收：DSH 窗口角落出现可拖动的小圆球（没出现就重启 DSH 或 Ctrl+R）。

### 8. 下载并解压 SnowLuma（你来做）

- 版本必须匹配 `@snowluma/sdk ^1.14.20` → 用 **v1.14.x**，不要 v2.x
- `lite` 包不含 Node，要求 Node ≥ **24.22.1**；不确定就用完整版
- GitHub Release 的 `objects.githubusercontent.com` 在国内常被 TLS 重置，直连和多数镜像都会失败。可靠做法：**多线程分段下载 + SHA256 校验**（用 GitHub API 的 `assets[].digest`）
- 解压到**英文路径**（如 `D:\SnowLuma`）。中文路径下双击 `.cmd` 会被 cmd 代码页拆坏（实测 `'wLuma' 不是内部命令`），给用户建一个 `.lnk` 指向 `node.exe`，工作目录设为安装目录

### 9. 启动 SnowLuma 并拿到 OneBot token（你来做，用户扫码）

用 WMI 启动（保证不被 DSH 重启带走）：

```powershell
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = '"<SnowLuma>\node\node.exe" "<SnowLuma>\app\index.mjs"'
  CurrentDirectory = '<SnowLuma>\app'
}
```

然后：

1. 读启动日志里的 `initial credentials: user=admin password=xxxx`，把**账号密码、WebUI 地址 <http://127.0.0.1:5099>** 告诉用户
2. 请用户：登录 → 同意 EULA/隐私政策 → 改密码
3. 请用户：在 QQ 窗口扫码登录机器人号（QQ 客户端需要先启动，路径可用 `Get-ItemProperty` 从卸载表里查）
4. 请用户在 WebUI 里开 **OneBot v11**：HTTP `3000`、WebSocket `3001`，设置 accessToken
5. 你读取 SnowLuma 的 `config/onebot_<QQ号>.json` 拿到 token，写进桥接 `config.json` 的 `snowluma.accessToken`
6. **把 token 明文和它的位置一并告诉用户**（首次配置就是这样交底的，不要隐藏）

**验收**：`curl http://127.0.0.1:3000/get_login_info` 返回 `status=ok`（带 token）。

### 10. 启动桥接（必须脱离 DSH）

```powershell
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = '"<node.exe>" "<仓库>\qq-bridge\src\bridge.js"'
  CurrentDirectory = '<仓库>\qq-bridge'
}
```

不要从 DSH 会话里 `Start-Process` 启动。

### 11. 注册看门狗（**必装**）

```powershell
# 前提：node 必须在用户 PATH 里（计划任务读不到当前会话 PATH）
schtasks /create /tn "QQBridgeGuard" /tr "wscript.exe <仓库>\tools\bridge-guard.vbs" /sc minute /mo 1 /f
```

**验收**：`schtasks /query /tn QQBridgeGuard /fo LIST /v` 的 `Last Result` 为 `0`；杀掉桥接后 ≤60 秒自动恢复。

---

## 五、速率与唤醒（装完必须讲给用户听）

### 消息延迟由什么决定

| 参数 | 默认 | 建议 | 说明 |
|---|---|---|---|
| `batchWindowMsPrivate` | 无（走会话级 8000） | **2000** | 私聊合批窗口。**改全局 `batchWindowMs` 对私聊无效** |
| `maxWakePerMinute` | 1 | **6** | 每分钟唤醒上限。默认 1 时连发消息会「唤醒频率超限，18s 后重试」 |
| `maxWakePerHour` | 12 | **60** | 每小时上限 |
| `wakeConfig.batchWindowMs`（会话级） | 8000 | 不用手动改 | AI 自己会写；`batchWindowMsPrivate` 优先级更高 |

装完告诉用户：**默认那套是「像真人」的慢节奏（8s 合批 + 8s 计划唤醒），不是故障；上面这组值能把它压到 5 秒内。**

### 唤醒设置（精简版，开关全开）

在 `config.json → socialV2.wake` 里：

- `recommendedAtMention: true`（@ 就醒）
- `recommendedNameMention: true`（叫名字就醒）
- `recommendedQuestion: true`（被提问就醒）
- `recommendedPoke: true`（被拍就醒）
- `recommendedKeywords`：用精简列表（见步骤 4），默认那一长串 DeepSeek 术语容易误触发
- 概率唤醒建议保持 `0.05`，别调高，否则群里会乱插话

> 这些是「推荐值」，AI 会通过 `qq_set_wake_config` 写进会话。装完提醒用户：可在 QQ 里发 `/status` 看当前唤醒状态，或在控制台「会话」页改。

---

## 六、验收清单

| 检查 | 命令 / 现象 |
|---|---|
| 依赖版本 | `@snowluma/sdk` == 1.14.20 |
| 各层连通 | `.\tools\qq-bot.ps1 status` 三块全绿 |
| 真实收发 | QQ 发一条，机器人回复 |
| 私聊延迟 | 日志 `计划唤醒 … 2s 后发送`，整轮 ≤5s |
| 唤醒包干净 | 上下文不再含 `【你的身份】` / `【会话令牌】` |
| 悬浮球 | DSH 窗口角落有小圆球 |
| 看门狗 | 杀桥接 ≤60s 自愈；`Last Result = 0` |
| DSH 重启 | 重启 DSH 后 1 分钟内桥接自动对齐新端口 |
| OneBot token | 已写入 config 并告知用户 |

## 七、已知坑速查

| 症状 | 原因 | 处理 |
|---|---|---|
| `tool input is invalid JSON` | 依赖版本漂移 | 重装 `npm ci` |
| 所有命令报 ACL 错误 | 工作区缺 WRITE_OWNER | 让用户切完全权限，或修目录权限 |
| `.ps1` 语法错、中文乱码 | 无 BOM 的 UTF-8 被按 GBK 读 | 补 UTF-8 BOM |
| 双击 `.cmd` 报 `'xx' 不是内部命令` | cmd 处理中文路径 | 改用 `.lnk` 指向 node.exe |
| DSH 重启后全挂 | 子进程在 DSH Job Object 里 | WMI / 计划任务启动 |
| 面板 `fetch failed` | 桥接没跑（3100） | 等看门狗或手动拉起 |
| 改了延迟设置没效果 | 改的是群聊项 | 改 `batchWindowMsPrivate` |
| 回复卡 18/37 秒 | `maxWakePerMinute` 限流 | 调到 6 |
| 唤醒包被当消息发出去 | 回合被中断 + 兜底自动转发 | 偶发；DSH 重启瞬间别发消息 |
| 悬浮球看不到 | 客户端模块未重载 | Ctrl+R，仍无则重启 DSH |

## 八、交付话术（照这个说）

1. 依赖版本、各层连通状态、延迟实测值
2. SnowLuma 的 WebUI 地址 + 初始账号密码，**以及 OneBot token 明文和位置**
3. 让用户手动做的只剩：在 QQ 窗口扫码登录（如果要换号）
4. 日常启动方式：双击 `<SnowLuma>\启动SnowLuma.lnk`；桥接由看门狗托管，不用管
5. 速率设置在哪改、改了会怎样
