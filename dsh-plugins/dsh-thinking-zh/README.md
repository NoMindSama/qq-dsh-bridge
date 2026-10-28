# dsh-thinking-zh

一个 **DSH Desktop 浮游球**（floating dock）：页面角落有个可以拖动的小圆球，点开是一个小工具箱，里面每个条目就是一个功能开关。当前装了第一个功能——**思考链中文**。

> 包名沿用了初版 `dsh-thinking-zh`，但它的定位已经是一个可扩展的浮游球容器，不再只做汉化。

## 为什么不用输入框内嵌按钮

第一版把按钮插进输入框工具栏，靠的是 `[class*="_tools"]`、`uV2eYG_add` 这类 **构建期哈希的 CSS module 类名**。官方一改前端结构就失效，实测也确实没渲染出来。

浮游球只依赖 `body` + `position: fixed`，是浏览器最稳定的接口。换主题、官方升级、布局改版都不影响它。

## 交互

| 操作 | 效果 |
|---|---|
| 单击球 | 展开 / 收起小工具箱 |
| 拖动球 | 自由移动位置，松手记忆到 `localStorage` |
| 双击球 | 复位到默认位置（拖丢了用这个救） |
| `Esc` / 点面板外 | 关闭面板 |
| 球获得焦点时 `Enter` / `Space` | 展开 / 收起 |

面板里每一行：图标 + 名称 + 说明 + 右侧开关。思考链中文开启时，下面会出现三档模式。

## 三档模式

| 模式 | 效果 |
|---|---|
| 中文优先（默认） | 思考链全程中文，代码、命令、报错、API 名、路径、专有名词保留英文 |
| 中英混用 | 复杂数学/代码推理可以用英文，思考链主干和结论仍是中文 |
| 跟随用户 | 用户中文则中文，用户英文则英文 |

关掉开关即不注入任何语言策略，恢复模型默认行为。

## 安装

### 给自己的机器（开发态）

```powershell
& "E:\dsh桌面端\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "link:<你的仓库路径>\dsh-plugins\dsh-thinking-zh"
```

安装后重启 DSH Desktop。

> 路径不要带空格。`dsh plugin` 会把参数拼成一条命令串交给 `cmd.exe`，带空格的路径会被拆成多个参数。

### 给朋友（分发包）

用现成的双击安装包：`<你的仓库路径>\日常小事情\dsh-thinking-zh-installer.zip`

朋友那边只需要：解压 → 双击「双击安装.cmd」。脚本会自己找 DSH 安装位置、复制到
`%LOCALAPPDATA%\dsh-plugins\dsh-thinking-zh`、注册到 desktop profile，然后提示重启。

分发包的组成：

```
dsh-thinking-zh-installer/
├─ 双击安装.cmd      ← powershell -ExecutionPolicy Bypass -File install.ps1
├─ 双击卸载.cmd
├─ 使用说明.txt      ← 给小白看的完整说明 + FAQ
├─ install.ps1       ← 注册表定位 DSH、版本检查、易位复制、pnpm add link:
├─ uninstall.ps1
└─ payload/dsh-thinking-zh/   ← 插件文件副本（lib/ package.json …）
```

**改了插件之后要同步 payload**：把 `lib/`、`package.json` 等重新复制进
`payload/dsh-thinking-zh/`，再重新压缩成 zip，否则朋友装到的是旧版本。
`安装说明.txt` 里的版本号也记得改。

## 卸载

```powershell
& "E:\dsh桌面端\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-thinking-zh
```

## 架构

```
lib/index.js                  插件入口（host）：装配 features
lib/features/thinking-zh.js   「思考链中文」feature 的 host 端：提示词段 + 状态 API
lib/client.js                 客户端插件：浮游球 + 面板 + feature 行渲染
```

### 客户端是怎么加载的（关键）

桌面端主窗口加载的是 `dsh://app/`，**不是** `http://127.0.0.1:<port>`。所以 `webServer.tapIndex` 注入的 `<script>` 只会出现在浏览器访问的页面里，**永远到不了 Electron 窗口**——这也是最初两版"看不到按钮"的真正原因。

正确路径是声明成 **DSH 客户端插件**：

```json
"exports": { ".": "./lib/index.js", "./client": "./lib/client.js" },
"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } }
```

`client-modules` 扫描 `dsh.client` 后，把一行 `{id, url, rev}` 写进页面里的 `window.__DSH_BOOT__`；`lib/client.js` 则用模块协议自注册：

```js
window.__ModuleLoader__.load({
  id: 'dsh-thinking-zh',
  factory: (require) => { /* exports.apply / exports.inject */ },
})
```

这条路 HTTP 和 Electron 共用，所以两个界面行为一致。

### 一条功能是怎么定义出来的

**Host 端**（`lib/features/<id>.js`）导出：

```js
export const id = 'thinking-zh'
export const routePath = '/dsh-thinking-zh/state'
export function mount(ctx) { /* 注册 prompt section、路由，返回 disposer */ }
```

**浏览器端**（`lib/client.js` 的 `FEATURES` 数组）加一条描述：

```js
{
  id: 'thinking-zh',
  title: '思考链中文',
  hint: '模型从源头用中文推理，术语保留英文',
  icon: ICON_ZH,
  api: '/dsh-thinking-zh/state',
  state: { enabled: true, mode: 'zh' },
  modes: [ { id: 'zh', label: '中文优先' }, /* ... */ ],   // 可选：子选项
}
```

`renderPanel()` 会把 `FEATURES` 原样铺成行，**不需要改面板代码**。没有 `modes` 的功能就只显示开关。

### 加一个新功能要动的地方

1. 新建 `lib/features/<id>.js`，写 `mount(ctx)`。
2. 在 `lib/index.js` 的 `FEATURES` 里 import 并加进去。
3. 在 `lib/client.js` 的 `FEATURES` 里加一条描述 + 图标。
4. `node scripts/smoke.mjs`。

就这些。面板、开关、拖动、持久化、外部点击关闭都是共用逻辑。

## 原理（思考链中文）

插件只做两件事：

1. `ctx.systemPrompt.section({ name, order: 10250, text: () => ... })`
   每轮组装系统提示词时实时求值；`10250` 排在 `DEPLOYMENT_PERSONA_SUFFIX`(10200) 之后，是模型读到的最后一节。
2. `POST /dsh-thinking-zh/state` 读写开关状态，落盘到 `~/.dsh/.dsh-thinking-zh.json`。

不做事后翻译，所以不增加额外模型调用、不破坏流式输出。

## 边界

- 提示词层面的强约束，不是硬编码。模型通常遵守，但无法保证 100%。
- 个别 provider 的隐藏 reasoning 不受系统提示词影响，此时只能影响最终回复语言。
- 历史对话里已经生成的英文思考链不会自动变中文。
- 切换开关会让系统提示词前缀变化一次，KV cache 会失效一次，下一轮恢复。
- `systemPrompt.section` 没有加 scope，所以子 agent、后台任务也会继承这条语言策略。
- 浮游球位置存在浏览器 `localStorage`（`dsh-floatdock:pos:v1`），换浏览器 profile 会回到默认位置。

## 安全

`POST /dsh-thinking-zh/state` 只接受 `application/json`。普通 HTML 表单发不出这个类型，跨源 fetch 又会触发本服务从不放行的 CORS 预检，因此不会被任意网页改写开关。状态写入用「临时文件 + rename」，崩溃不会留下半截文件。

## 开发

- `lib/index.js`：host 入口，装配 features。
- `lib/client.js`：客户端插件（浮游球和面板），改动后**刷新页面**即可生效。
- `scripts/smoke.mjs`：无 DSH 依赖的冒烟测试，`node scripts/smoke.mjs`。
- 状态文件：`~/.dsh/.dsh-thinking-zh.json`

修改 host 端或 `package.json`（`dsh.client`/`exports`）后需要重启 DSH Desktop；只改 `lib/client.js` 刷新页面即可。

## 变更记录

见 [CHANGELOG.md](./CHANGELOG.md)。
