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

## 12 种通知渠道

| 渠道 | 适用人群 | 配置字段（按当前渠道只显示需要的） |
|------|----------|--------------------|
| **浏览器通知**（默认） | 任何浏览器 | 无（需授权通知权限） |
| **Server酱** | 微信推送 | SendKey |
| **钉钉机器人** | 钉钉群 | Webhook 地址 / 加签密钥（可选） |
| **飞书机器人** | 飞书群 | Webhook 地址 / 签名密钥（可选） |
| **企业微信机器人** | 企业微信群 | Webhook 地址 |
| **Bark (iOS)** | iPhone 用户 | Bark Key / Bark Server（可选） |
| **Pushover** | 跨平台推送服务 | App Token / User Key / Device（可选） |
| **Telegram** | Telegram 用户 | Bot Token / Chat ID |
| **Discord** | Discord 频道 | Webhook URL |
| **Slack** | Slack 工作区 | Webhook URL |
| **通用 Webhook** | 自建服务 | URL |
| **自定义** | 完全自定义 | 占位（`customSend(payload)`） |

> 国内三家（钉钉 / 飞书 / 企业微信）的群机器人在浏览器端通过
> `text/plain` 简单请求发送 JSON（绕开 CORS 预检），钉钉加签与飞书签名
> 校验用 Web Crypto 在本地计算，密钥不出本机。若机器人开了「自定义关键词」
> 过滤，请把关键词设为 `DSH`。

## 工作原理

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

- **v1.5.0** — 渠道扩充 + 修复"刷新后设置重置"：
  - 新增国内渠道：钉钉机器人（支持加签）、飞书机器人（支持签名校验）、
    企业微信群机器人；均用 text/plain 简单请求 + JSON 体规避 CORS 预检，
    签名用 Web Crypto 本地计算
  - 渠道名去掉所有 emoji 表情
  - **修复刷新重置**：构建脚本内联 types 的方式从手工拷贝改为自动提取
    lib/types.js 并按 client 实际 import 解构——手工拷贝曾漏掉 STORAGE_KEY，
    导致 localStorage 读写全部抛 ReferenceError 被吞、持久化从未生效
  - 渠道发送失败现在会以页内 toast 提示具体原因（不再静默）
  - 多标签页同源配置实时同步（storage 事件）；面板底部显示当前站点与
    存储可用性，便于自查 localhost 与 127.0.0.1 配置互不相通的问题
- **v1.4.0** — 手势安全的浏览器授权流程 + 单选组渠道选择器 + 去标题 emoji
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
