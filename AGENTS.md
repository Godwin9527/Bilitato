# Repository Instructions

## Git Commits

When creating commits in this repository, always use Conventional Commits:

```text
<type>[optional scope]: <short description>
```

Allowed types:

- `feat`: add a feature
- `fix`: fix a bug
- `docs`: documentation changes
- `style`: formatting-only changes
- `refactor`: code restructuring without behavior changes
- `perf`: performance improvements
- `test`: tests
- `build`: build or dependency changes
- `ci`: CI configuration
- `chore`: maintenance

Keep the description concise and start it with a verb. Do not add a body or footer unless the user asks for one.

Examples:

```text
feat: add extension e2e smoke test
fix: handle missing subtitle timeline
test: cover provider adapter error cases
chore: update release build script
```

## 架构现状（1.6.4.2 起）

Bilitato 是 MV3 扩展，页面侧与侧边栏侧曾各有一套 UI。自 1.6.4.2 起**页面不再注入任何可见 UI**，功能入口统一收口到浏览器侧边栏。

| 文件 | 职责 |
| --- | --- |
| `manifest.json` | MV3 清单。`side_panel.default_path` 指向 `sidepanel.html`，`action` 不设 popup，点击图标由 `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})` 打开侧边栏 |
| `background.js` | service worker。业务中枢：任务调度、LLM/ASR 调用、缓存读写、`GET_BOOTSTRAP` 等消息接口、设置规范化（`DEFAULT_SETTINGS`） |
| `sidepanel.js` / `sidepanel.html` / `sidepanel.css` | 唯一的 UI 层。页面：CC（字幕）/summary/chat/real/settings/copy/export，以及 announcements（公告）、setup（引导）两个覆盖页 |
| `content.js` | 页面侧静默数据层。注入 `inject.js`、抓字幕与媒体流、缓存同步、响应侧边栏 `SIDE_PANEL_CONTENT_ACTION`。**不再渲染面板** |
| `inject.js` | 主世界桥，hook `window.fetch` 与 `XMLHttpRequest.prototype` 抓 playinfo/字幕。必要性最高，不可移除 |
| `content.css` | 供侧边栏与（已停用的）页面面板共用；**不再注入网页** |
| `page-overlay.css` | 页面内辅助元素样式（进度条章节标记/分段浮窗），仅在开启「页面内辅助显示」时动态插入 |

### 页面 UI 的熔断机制

- `content.js` 顶部 `const PAGE_EMBEDDED_PANEL_DISABLED = true` + `isPagePanelEnabled()`。
- `waitPanelMount()` / `renderApp()` / `renderNav()` / `renderContent()` 首行守卫，面板相关 100+ 处调用点自动空转，渲染代码保留以便回退。
- 页面内辅助显示由设置项 `pageOverlayEnabled`（默认 `false`）控制，经 `syncPageOverlayBySettings()` 与 `chrome.storage.onChanged` 联动。
- 页面 toast 由 `content/contentUi.js` 的 `setToastEnabled()` 关闭，反馈统一走侧边栏。

### 坑

- `content.css` 曾通过 `content_scripts.css` 注入网页，其中 `body{scrollbar-width:none}` 会隐藏 B 站滚动条、`input[type="range"]` 会污染全站滑块样式。若重新引入页面 CSS，必须剥离全局选择器。
- 该仓库文件为 LF，Windows 上 `core.autocrlf=true`；用工具批量改写文件后务必确认行尾未被整体改成 CRLF，否则 git diff 会变成整文件重写、测试里的多行断言也会失败。
- 侧边栏长任务（流式总结、ASR 转录、聊天）依赖常驻上下文，`popup` 形态会因失焦销毁而中断，入口应始终是 side panel。

## 命令

```bash
npm install          # 首次；国内网络可加 --registry=https://registry.npmmirror.com
npm test             # vitest run，45 个文件 / 363 个用例
npm run build:release
npm run build:firefox
```

## 已完成

- 1.6.4.2：移除页面注入 UI，功能全部收口到侧边栏（详见上表与熔断机制）；公告中心、使用引导迁入侧边栏；新增「页面内辅助显示」开关；移除 `switch-to-embedded` 交互。

## 当前状态

- 分支 `main`，工作树干净后同步推送远程。

