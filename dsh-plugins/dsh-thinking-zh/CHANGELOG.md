# Changelog

## 0.4.0 — 2026-10-21

- **修复「重启后看不到浮游球」**：根因是桌面端主窗口加载 `dsh://app/`，不经过 HTTP，`webServer.tapIndex` 注入的脚本永远到不了 Electron 窗口（前两版失效的真正原因）。
- 客户端改为**官方客户端插件**：`package.json` 增加 `exports["./client"]` 与 `dsh.client = { platform: "web" }`，`lib/client.js` 改为 `window.__ModuleLoader__.load({ id, factory })` 自注册。
- 移除 host 端的 `/dsh-floatdock/client.js` 路由与 `tapIndex` 注入，避免与模块加载器重复注册同一 id。
- 已验证 boot 图里出现 `{"id":"dsh-thinking-zh","url":"plugins/??dsh-thinking-zh/client.js&rev=..."}`，模块资源可取回。
- 冒烟测试改为断言 `dsh.client` 声明、loader 注册格式、`exports.apply`，并断言不再注册任何 index tap。

## 0.3.0 — 2026-10-21

- **重做为浮游球（floating dock）**：页面角落一个可拖动的小圆球，点开是「小工具箱」面板，功能以「一行 + 右侧开关」的形式列在里面。
- 彻底移除对官方 DOM 的依赖：不再查找 `[data-composer-card]` / `[class*="_tools"]` / `data-composer-seat`，只挂 `body` + `position: fixed`。
- 加入拖动（5px 阈值区分点击与拖拽）、位置持久化（`localStorage: dsh-floatdock:pos:v1`）、窗口缩放自动收敛到视口内、双击复位。
- 面板方向自适应：球在右半屏时左对齐，空间不足自动翻转，并始终夹在视口内。
- **重构为 feature 注册表**：`lib/features/<id>.js` 承担 host 端（提示词段 + 状态路由），`lib/client.js` 的 `FEATURES` 数组提供同 id 的描述；面板自动渲染，新增功能不改面板代码。
- 拆卸链路改为逐 feature disposer，统一由 `ctx.effect` 回收。
- 客户端资源路径改为 `/dsh-floatdock/client.js`；状态路由保持 `/dsh-thinking-zh/state`。
- 冒烟测试改为断言「无 composer 依赖」、feature 注册表、拖动与位置持久化、拆卸链路。

## 0.2.0 — 2026-10-21

- 开关从「输入框上方的悬浮胶囊」改为输入框工具栏内的 28px 按钮，复用宿主按钮 class。
- 挂载策略改为 `[data-composer-card]` → `[class*="_tools"]`，并用 `MutationObserver` 在 React 重渲染后自动重挂。
- 修正主题变量名：`--dsw-alias-text` → `--dsw-alias-label-primary`，`--dsw-alias-border` → `--dsw-alias-border-l1/l2`。
- 状态路由加固：非 GET/POST/PUT 返回 405；非 `application/json` 返回 415。
- 状态写入改为「临时文件 + rename」；`normalizeState` 严格校验 `enabled` 必须是布尔。
- 新增 LICENSE、.gitignore、CHANGELOG；清理遗留的 `.test-web.log`。

## 0.1.0 — 2026-10-21

- 首个可用版本：系统提示词注入、三档模式、输入框上方悬浮开关、状态持久化。
