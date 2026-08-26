# DSH Completion Reminder

为 DeepSeek Harness (DSH) Web GUI 增加 **Agent 完成提醒** 功能的插件。
当 agent 停止生成（成功 / 主动停止 / 出错）时，弹一个通知给用户。

默认走 **浏览器原生通知**（`window.Notification`，首次使用需要用户授权），
并内置 **七种热门的第三方通知渠道** 供切换：

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

## 功能

- 🛰 **完成即通知**：检测 DSH 输入工具栏的 send ↔ stop 按钮切换，并结合最后一条消息判断成功 / 主动停止 / 出错
- 🔔 **浏览器原生通知**：`Notification` API，首次自动请求权限；未授权时回退为页面内 toast
- 🌍 **七种第三方渠道**：Telegram、Bark、Pushover、Server酱、Discord、Slack、通用 Webhook，外加 Custom 钩子
- 🪟 **智能抑制**：标签页可见且获得焦点时默认不响（避免打断），可通过 `suppressWhenFocused: false` 关闭
- ⏱ **防刷屏**：连续完成之间默认 5 秒冷却，可调
- 🎨 **标题/正文可定制**：`titleTemplate` / `bodyTemplate` 接收上下文返回字符串
- 🪪 **可观测性**：`onNotify` / `onError` 钩子方便调试与对接
- ⚡ **装了即用**：声明 `dsh.bundle.patch`，`dsh plugin add` 时由 DSH 自动加入 profile 层并激活
- 📦 **npm 分发**：CI 自动构建、发布、创建 GitHub Release

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

打开任一会话并触发一次 agent 回复，应该会看到「请求通知权限」的浏览器弹窗。
授权后，等任务结束即可看到通知。

## 配置

```javascript
DSHCompletionReminder.configure({
  provider: 'telegram',                  // 'browser' (default) | 'telegram' | 'bark' | 'pushover'
                                         //   | 'serverchan' | 'discord' | 'slack'
                                         //   | 'webhook' | 'custom'
  autoRequestPermission: true,           // 浏览器模式下自动请求 Notification 权限
  notifyOnSuccess: true,                 // 成功完成时通知
  notifyOnStopped: true,                 // 用户主动停止时通知
  notifyOnError:   true,                 // agent 出错时通知
  suppressWhenFocused: true,             // 标签页可见且有焦点时不响
  cooldownMs: 5000,                      // 连续通知之间的最小间隔
  titleTemplate: ({ status }) => 'DSH 已结束', // 自定义标题
  bodyTemplate:  ({ model, durationMs }) => `${model} · 用时 ${durationMs}ms`,
  iconUrl: '/favicon.ico',
  clickUrl: location.href,

  providers: {
    telegramBotToken: '123456:ABC...',
    telegramChatId:   '987654321',

    // barkKey / pushover* / serverchanSendKey / discordWebhookUrl /
    // slackWebhookUrl / webhookUrl 只需按当前 provider 填写。
  },

  onNotify: (payload, provider) => console.log('delivered via', provider, payload),
  onError:  (err, provider)      => console.warn('failed via', provider, err),
});

DSHCompletionReminder.activate();
DSHCompletionReminder.deactivate();
```

### 只走「页面内 toast」？

把 `provider` 设为 `'browser'` 即可。如果用户拒绝浏览器通知权限，插件会自动
回退为页面内的浮动提示，不需要任何额外配置。

### 切换到 Telegram？

1. 在 Telegram 中 `@BotFather` 创建 bot，拿到 `telegramBotToken`
2. 给自己发一条消息，访问 `https://api.telegram.org/bot<TOKEN>/getUpdates` 拿到 `chat.id`
3. 配置：

```javascript
DSHCompletionReminder.configure({
  provider: 'telegram',
  providers: {
    telegramBotToken: '<TOKEN>',
    telegramChatId:   '<CHAT_ID>',
  },
});
```

## 公开 API

```javascript
DSHCompletionReminder.DEFAULTS                    // 默认配置
DSHCompletionReminder.configure(opts)              // 合并配置（多次调用累加）
DSHCompletionReminder.activate()                   // 启动 DOM 观察与通知
DSHCompletionReminder.deactivate()                 // 停止一切
DSHCompletionReminder.requestBrowserPermission()   // 手动触发 Notification 权限请求
```

`apply(ctx, opts)` 是 DSH Cordis Loader 调用的入口，等价于 `configure(opts); activate()`。

## 工作原理

- `src/index.ts` 是宿主侧（node）入口，导出空 `apply`，让 Loader 能挂载本包
- `src/client.ts` 是浏览器侧真正的逻辑，被打包成 `window.__ModuleLoader__.load({ factory })` 格式
- 一个 `MutationObserver` 监听 `document.body`：
  - 关注工具栏按钮的 `aria-label` / `class` / `textContent` 变化
  - 检测到「running」（如 `停止` / `Stop`）→ 记录开始时间
  - 检测到「idle」→ 触发 `completeRun(status, durationMs)`
  - 读最后一条 `data-role="assistant"` 消息粗略判断 success / stopped / error
- 根据 `provider` 派发到不同的通知渠道，全部走 `fetch` / `Notification`

## 项目结构

```
dsh-completion-reminder/
├── package.json              # npm 包配置，含 dsh.bundle.patch 与 dsh.client 声明
├── cordis.patch.yml          # 包自带的 loader 注册 patch（insert 本插件）
├── tsconfig.json             # TypeScript 配置
├── src/
│   ├── index.ts              # 服务端入口（桩）
│   ├── client.ts             # 客户端插件 TypeScript 源码
│   └── types.ts              # 类型定义 & 默认值
├── lib/
│   ├── index.js              # 编译后的服务端入口（纯载体）
│   └── client.js             # DSH __ModuleLoader__ 格式的客户端插件
├── dist/
│   └── dsh-completion-reminder.js  # 独立脚本（可直接 <script> 加载）
├── scripts/
│   ├── build-plugin.js       # 构建脚本（tsc 产物 → ModuleLoader 包装）
│   └── clean.js              # 清理 lib/ 和 dist/
├── .github/workflows/
│   └── publish.yml           # tag 推送 → 构建 → npm 发布 → GitHub Release
└── test.html                 # 测试页面（模拟 send ↔ stop 切换）
```

## 发布流程

```bash
npm version patch        # 或 minor / major
git push origin main --tags
```

推送 `v*` tag 后 CI 自动完成构建、npm 发布和 GitHub Release。
`NPM_TOKEN` 与 `GITHUB_TOKEN` 在仓库 Settings → Secrets 中配置。

## 许可

MIT
