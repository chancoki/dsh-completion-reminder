# DSH 完成提醒插件 - 安装指南

## 前提条件

- DeepSeek Harness (DSH) 已安装
- 浏览器允许 `http://127.0.0.1:3080` 发送通知（首次使用时会弹权限请求）

## 安装（npm，推荐）

```bash
dsh plugin --profile web add dsh-completion-reminder
```

> 如果报 `ERR_PNPM_ADDING_TO_ROOT`，说明 profile 目录是 pnpm workspace root，补一个 `-w`：
>
> ```bash
> dsh plugin --profile web add -w dsh-completion-reminder
> ```

插件包内自带 `cordis.patch.yml` 并声明 `dsh.bundle.patch`，
`dsh plugin add` 时 DSH 会**自动**把插件加入 profile 的 bundles 层——无需手动编辑任何配置文件。

然后重启：

```bash
dsh web
```

启动后，浏览器地址栏左侧应该会出现「🔔 想显示通知吗？」的权限询问。
点击「允许」即可启用浏览器原生通知。

### 升级

```bash
dsh plugin --profile web update dsh-completion-reminder
dsh web   # 重启生效
```

## 验证安装

1. 打开或强制刷新 DSH Web GUI（http://127.0.0.1:3080，Ctrl+Shift+R）
2. 给 agent 发任意一条消息
3. 等任务结束 → 系统右下角（或顶部）出现通知：「✅ DSH Agent 已完成 · 用时 Xs」

如果浏览器拒绝了通知权限，插件会自动改用页面内浮动 toast，**不会**完全失效。

## 切换到第三方通知

在 DSH 页面打开 DevTools 控制台，运行：

```javascript
DSHCompletionReminder.configure({
  provider: 'telegram',
  providers: {
    telegramBotToken: '123456:ABC...',
    telegramChatId:   '987654321',
  },
});
```

随后任意一次 agent 完成都会通过 Telegram 推送到你的手机。

可用的 provider：

- `browser` — 浏览器原生通知（默认）
- `telegram` — Telegram Bot
- `bark` — iPhone Bark
- `pushover` — Pushover
- `serverchan` — Server酱 (sct.ftqq.com)
- `discord` — Discord Webhook
- `slack` — Slack Webhook
- `webhook` — 通用 JSON POST Webhook
- `custom` — 自定义 `customSend(payload)` 函数

## 故障排除

| 问题 | 原因 | 解决方法 |
|------|------|----------|
| 安装报 `ERR_PNPM_ADDING_TO_ROOT` | profile 是 pnpm workspace root | 加 `-w` 标志重新执行 |
| 装了但没有通知 | 未重启 `dsh web` | 重启后强刷页面 |
| 浏览器没弹权限询问 | 之前已「阻止」该网站 | 浏览器地址栏左侧锁形图标 → 通知 → 允许 |
| Telegram 报 401/400 | `telegramBotToken` / `telegramChatId` 配错 | 用 `@BotFather` 重新获取 token；用 `getUpdates` 找 chat id |
| 通知频率太高 | 多个 agent 接连完成 | 调大 `cooldownMs`（默认 5000） |
| 切回浏览器通知 | 想撤销 Telegram 配置 | `DSHCompletionReminder.configure({ provider: 'browser' })` |
| 完全停用 | — | `DSHCompletionReminder.deactivate()` |

## 卸载

```bash
dsh plugin --profile web remove dsh-completion-reminder
```

然后重启：

```bash
dsh web
```
