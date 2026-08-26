# DSH Completion Reminder

为 DeepSeek Harness (DSH) Web GUI 增加 **Agent 完成提醒** 功能的插件。
当 agent 停止生成（成功 / 主动停止 / 出错）时，弹一个通知给用户。

- 🌐 默认走 **浏览器原生通知**（`window.Notification`，首次使用需要用户授权）
- ⚙️ 右下角悬浮一个 **🔔 按钮**，点开是带 9 种通知渠道的图形化配置面板
- 💾 配置保存在本浏览器 `localStorage`，不会上传任何服务器
- 🧪 配置面板自带 **「发送测试通知」** 按钮，方便验证渠道是否通
- 🪟 标签页可见时默认静默（不打断工作），可通过开关关闭
- ⏱ 内置 5 秒冷却，避免连续 agent 完成时刷屏
- 🎨 标题/正文可定制，匹配 `success` / `stopped` / `error` 三种状态

## 9 种通知渠道

| 渠道 | 适用人群 | 配置字段 |
|------|----------|----------|
| 🌐 **browser**（默认） | 任何浏览器 | — |
| ✈️ **Telegram** | Telegram 重度用户 | `telegramBotToken` / `telegramChatId` |
| 🍎 **Bark** | iPhone 用户 | `barkKey`（可选 `barkServer`） |
| 📲 **Pushover** | 跨平台推送服务 | `pushoverToken` / `pushoverUserKey` |
| 🐦 **Server酱** | 国内微信推送 | `serverchanSendKey` |
| 🎮 **Discord** | Discord 玩家 / 团队 | `discordWebhookUrl` |
| 💼 **Slack** | 团队工作区 | `slackWebhookUrl` |
| 🔗 **Webhook** | 自建服务 | `webhookUrl` |
| 🛠 **Custom** | 完全自定义 | `customSend(payload)` |

## 工作原理（v1.1）

DSH 的 composer 卡片 `<div data-composer-card="true">` 内的主按钮 `aria-label` 会在
`"Stop generating"` / `"Send message"`（中文 UI 下是 `"停止生成"` / `"发送消息"`）之间切换。
插件用一个轻量 `MutationObserver` 监听这个属性变化：

- 检测到 `Stop generating` → 记录开始时间
- 检测到 `Send message` → 触发完成事件
- 根据 `data-phase` (`active` / `settling` / `hero`) 和最后一条 `data-role="assistant"`
  消息的文本/类名，判断 `success` / `stopped` / `error`
- 派发到当前渠道，调用 `Notification` / `fetch` 发送

所有匹配都用 **稳定属性**（`data-*`、`aria-label`、`type`），不依赖会被 CSS-modules
哈希改变的 class 名（`uV2eYG_primary` 这类），跨 DSH 版本更稳。

## 快速开始

### npm 安装（推荐）

```bash
dsh plugin --profile web add dsh-completion-reminder
```

插件包内自带 `cordis.patch.yml`（insert 注册项）并在 `package.json` 声明 `dsh.bundle.patch`。
`dsh plugin add` 完成依赖安装后，DSH 会自动把插件加入 profile 的 bundles 层堆栈，重启后即生效。

如果遇到 `ERR_PNPM_ADDING_TO_ROOT`（profile 目录是 pnpm workspace root），补一个 `-w`：

```bash
dsh plugin --profile web add -w dsh-completion-reminder
```

然后重启：

```bash
dsh web
```

打开任一会话，右下角应该出现一个 **🔔** 浮动按钮。点击它打开设置面板：

1. 选择通知渠道（如 `Telegram`）
2. 填入对应的 token / id（一次即可，存到 `localStorage`）
3. 点击 **「发送测试通知」** 验证渠道通不通
4. 等一次 agent 完成，会自动收到通知 🎉

## 程序化 API

```javascript
DSHCompletionReminder.configure({
  provider: 'telegram',
  providers: {
    telegramBotToken: '123456:ABC...',
    telegramChatId:   '987654321',
  },
  suppressWhenFocused: false,
  cooldownMs: 3000,
  onNotify: (payload, provider) => console.log('delivered via', provider, payload),
  onError:  (err, provider)      => console.warn('failed via', provider, err),
});

DSHCompletionReminder.activate();
DSHCompletionReminder.deactivate();
DSHCompletionReminder.requestBrowserPermission();
```

`apply(ctx, opts)` 是 DSH Cordis Loader 调用的入口，等价于 `configure(opts); activate()`。

## 公开 API

| 方法 / 属性 | 说明 |
|------|------|
| `DSHCompletionReminder.configure(opts)` | 合并配置（与 localStorage 持久值叠加） |
| `DSHCompletionReminder.activate()` | 启动 DOM 观察 + 注入浮动按钮 |
| `DSHCompletionReminder.deactivate()` | 停止一切，移除 UI |
| `DSHCompletionReminder.requestBrowserPermission()` | 手动触发浏览器通知权限请求 |
| `DSHCompletionReminder.apply(ctx, opts)` | DSH Cordis Loader 入口 |
| `DSHCompletionReminder.DEFAULTS` | 默认配置（只读） |

## 项目结构

```
dsh-completion-reminder/
├── package.json              # npm 包配置，含 dsh.bundle.patch 与 dsh.client 声明
├── cordis.patch.yml          # 包自带的 loader 注册 patch（insert 本插件）
├── tsconfig.json             # TypeScript 配置
├── src/
│   ├── index.ts              # 服务端入口（桩）
│   ├── client.ts             # 客户端插件 TypeScript 源码（DOM 检测 + 9 渠道 + 设置面板）
│   └── types.ts              # 类型定义 & 默认值
├── lib/
│   ├── index.js              # 编译后的服务端入口（纯载体）
│   └── client.js             # DSH __ModuleLoader__ 格式的客户端插件
├── dist/
│   └── dsh-completion-reminder.js  # 独立脚本（可直接 <script> 加载）
├── scripts/
│   ├── build-plugin.js       # 构建脚本（tsc 产物 → ModuleLoader 包装）
│   └── clean.js              # 清理 lib/ 和 dist/
├── probes/                   # 离线 smoke test（jsdom，模拟 DSH DOM）
└── .github/workflows/
    └── publish.yml           # tag 推送 → 构建 → npm 发布 → GitHub Release
```

## 发布流程

```bash
npm version patch        # 或 minor / major
git push origin main --tags
```

推送 `v*` tag 后 CI 自动完成构建、npm 发布和 GitHub Release。
`NPM_TOKEN` 与 `GITHUB_TOKEN` 在仓库 Settings → Secrets 中配置。

## 版本历史

- **v1.1.0** — 真正的 v1：
  - 改用真实 DSH DOM 锚点（`data-composer-card` + `aria-label`），不再依赖会被哈希的 class 名
  - 新增右下角浮动 **🔔** 按钮 + 完整设置面板（9 渠道、11 凭证字段、4 个行为开关、测试按钮）
  - 配置持久化到 `localStorage`
  - jsdom 离线 smoke test 验证 3 种状态（success / stopped / error）+ 9 渠道派发
- **v1.0.0** — 初始版本（class 名匹配，实际 DSH 上不可用）

## 许可

MIT
