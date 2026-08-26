# DSH Completion Reminder

为 DeepSeek Harness (DSH) Web GUI 增加 **Agent 完成提醒** 功能的插件。
当 agent 停止生成（成功 / 主动停止 / 出错）时，弹一个通知给用户。

- 🌐 默认走 **浏览器原生通知**（`window.Notification`，首次使用需要用户授权）
- ⚙️ 直接在 DSH 自己的 **「设置 → 插件 → 🔔 完成提醒」** 里配置（与「可配置」同级 tab）
- 🔒 **凭证按渠道筛选**：选 Telegram 只显示 2 项，选 Bark 只显示 1–2 项，不会一下子蹦出 11 个无关字段
- 🎨 **暗色 / 亮色主题都正常**（`color-scheme: light dark` + 显式前景色，再无「白底白字」）
- 💾 配置保存在本浏览器 `localStorage`，不会上传任何服务器
- 🧪 配置面板自带 **「发送测试通知」** 按钮，方便验证渠道是否通
- 🪟 标签页可见时默认静默（不打断工作），可通过开关关闭
- ⏱ 内置 5 秒冷却，避免连续 agent 完成时刷屏

## 9 种通知渠道

| 渠道 | 适用人群 | 配置字段（按当前渠道只显示需要的） |
|------|----------|--------------------|
| 🌐 **browser**（默认） | 任何浏览器 | 无 |
| ✈️ **Telegram** | Telegram 重度用户 | Bot Token / Chat ID |
| 🍎 **Bark** | iPhone 用户 | Bark Key / Bark Server（可选） |
| 📲 **Pushover** | 跨平台推送服务 | App Token / User Key / Device（可选） |
| 🐦 **Server酱** | 国内微信推送 | SendKey |
| 🎮 **Discord** | Discord 玩家 / 团队 | Webhook URL |
| 💼 **Slack** | 团队工作区 | Webhook URL |
| 🔗 **Webhook** | 自建服务 | URL |
| 🛠 **Custom** | 完全自定义 | 占位（`customSend(payload)`） |

## 工作原理（v1.3）

### 1. 完成检测

DSH composer 卡片 `<div data-composer-card="true">` 内的主按钮 `aria-label` 会在
`"Stop generating"` / `"Send message"`（中文 UI 是 `"停止生成"` / `"发送消息"`）之间切换。
插件用 `MutationObserver` 监听这个属性变化：

- 检测到 `Stop generating` → 记录开始时间
- 检测到 `Send message` → 触发完成事件
- 根据 `data-phase`（`active` / `settling` / `hero`）和最后一条 `data-role="assistant"`
  消息的文本/类名，判断 `success` / `stopped` / `error`
- 派发到当前渠道，调用 `Notification` / `fetch` 发送

所有匹配都用 **稳定属性**（`data-*`、`aria-label`、`type`），不依赖 CSS-modules 哈希后的 class 名。

### 2. 设置面板

通过 DSH 的 `ctx.slots.inject('settings.plugins.tab', ...)` API，插件把自己注册成
DSH 「插件」section 里与「可配置」**同级**的一个 tab：

```
DSH 设置弹窗 → 插件
├─ 可配置        ← DSH 自带（编辑插件配置）
├─ 🔔 完成提醒   ← 本插件
```

`settings.section` 同样被注册作为兜底（旧版本或非标准 host 仍能找到入口）。

- 通知渠道下拉（切换渠道时，凭证区**实时刷新**）
- 当前渠道**只显示需要的字段**（不需要在 11 个无关字段里翻找）
- 行为开关（成功 / 停止 / 出错 / 焦点抑制 / 自动请求权限 / 冷却）
- 「发送测试通知」 / 「重置」 / 「请求权限」三个动作

**没多出任何悬浮按钮**，UI 与 DSH 原生设置完全一致。

### 3. 降级

如果加载时 DSH host 不支持 `ctx.slots`（极旧版本或非标准 host），
插件会退回到「DOM 检测 + 浏览器通知」基础模式，
并显示一条底部提示引导用户去设置面板。

## 快速开始

### 安装 / 升级

```bash
dsh plugin --profile web update dsh-completion-reminder
dsh web   # 重启
```

### 配置

1. 打开 DSH → 点击左上角「⚙ 设置」→ 进入「插件」section
2. 在 tab 栏里点击「🔔 完成提醒」
3. 选择通知渠道（如 `Telegram`）
4. 填入对应的 token / id（凭证区只显示当前渠道需要的字段）
5. 点击「发送测试通知」验证渠道通不通
6. 关闭弹窗 → 自动保存到 localStorage

### 程序化 API

```javascript
DSHCompletionReminder.configure({
  provider: 'telegram',
  providers: { telegramBotToken: '...', telegramChatId: '...' },
  suppressWhenFocused: false,
  cooldownMs: 3000,
  onNotify: (payload, provider) => console.log('delivered via', provider, payload),
  onError:  (err, provider)      => console.warn('failed via', provider, err),
});
DSHCompletionReminder.activate();
DSHCompletionReminder.deactivate();
DSHCompletionReminder.requestBrowserPermission();
```

## 公开 API

| 方法 / 属性 | 说明 |
|------|------|
| `DSHCompletionReminder.configure(opts)` | 合并配置（与 localStorage 持久值叠加） |
| `DSHCompletionReminder.activate()` | 启动 DOM 观察 + 注册设置入口 |
| `DSHCompletionReminder.deactivate()` | 停止一切，清理 UI |
| `DSHCompletionReminder.requestBrowserPermission()` | 手动触发浏览器通知权限请求 |
| `DSHCompletionReminder.apply(ctx, opts)` | DSH Cordis Loader 入口 |
| `DSHCompletionReminder.renderPanelInto(hostEl)` | 把配置面板渲染到任意 DOM 容器（主要用于测试） |
| `DSHCompletionReminder.DEFAULTS` | 默认配置（只读） |

## 项目结构

```
dsh-completion-reminder/
├── package.json              # npm 包配置，含 dsh.bundle.patch 与 dsh.client 声明
├── cordis.patch.yml          # 包自带的 loader 注册 patch
├── tsconfig.json             # TypeScript 配置
├── src/
│   ├── index.ts              # 服务端入口（桩）
│   ├── client.ts             # 客户端插件（DOM 检测 + 9 渠道 + 设置面板）
│   ├── react.d.ts            # 极简 React 类型（运行时通过 DSH module 系统 require('react')）
│   └── types.ts              # 类型定义 & 默认值
├── lib/
│   ├── index.js              # 服务端入口
│   └── client.js             # DSH __ModuleLoader__ 格式的客户端插件
├── dist/
│   └── dsh-completion-reminder.js  # 独立脚本（可直接 <script> 加载）
├── scripts/
│   ├── build-plugin.js       # 构建脚本（tsc + import 转换为 require + ModuleLoader 包装）
│   └── clean.js              # 清理 lib/ 和 dist/
└── probes/                   # 离线 smoke test（jsdom）
```

## 发布流程

```bash
npm version patch        # 或 minor / major
git push origin main --tags
```

CI 自动完成构建、npm 发布、GitHub Release。

## 版本历史

- **v1.4.0** — 三项修复：
  - **浏览器通知**：不再在页面加载时无手势请求权限（浏览器会静默拒绝并污染
    缓存状态）；`deliverBrowser` 每次读取实时 `Notification.permission`；
    未授权时页内 toast 会给出具体指引；权限行只在选「浏览器通知」时显示，
    「请求权限」按钮是唯一授权入口（用户手势，必定弹出系统询问）
  - **渠道选择器改为单选组**：原生 `<select>` 的展开列表由 UA 渲染，暗色主题下
    会出现白底白字；radio 完全由 CSS 变量着色，无弹层问题
  - **设置入口标题去掉 🔔**（两处 slot 的 label 改为「完成提醒」）；
    「前台静默」选项文案改为更明确的说明
- **v1.3.1** — 修复设置入口从未出现的根因：插件现在导出 `inject = ['slots']`，
  cordis Loader 会等 slots 服务就绪才调用 `apply`（对齐 dshmarket 的做法）。
  之前 apply 跑在服务提供之前，`ctx.slots` 为 undefined，注册被静默跳过。
  另：槽位组件改为 dshmarket 同款「普通函数组件 + callback ref」，去掉
  forwardRef/useRef 依赖；新增 `window.__DSH_COMPLETION_REMINDER_DEBUG`
  诊断对象；`settings.section` order 调整为 45（紧随「插件」「插件市场」）。
- **v1.3.0** — 设置面板进入「DSH 设置 → 插件」section 的 tab 栏（与「可配置」同级）
- **v1.2.0** — 凭证按渠道筛选 + 暗色主题修复
- **v1.1.0** — 真实 DSH DOM 锚点
- **v1.0.0** — 初始版本（class 名匹配，实际 DSH 上不可用）

### 自查

若升级后仍看不到入口，在浏览器控制台（F12）执行：

```js
window.__DSH_COMPLETION_REMINDER_DEBUG
```

正常应显示 `{ hasSlots: true, pluginsTab: 'ok', section: 'ok', … }`。

## 许可

MIT
