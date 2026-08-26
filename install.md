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

启动后，DSH 右下角会出现一个 **🔔** 浮动按钮。点击它打开设置面板。

## 配置通知渠道

打开设置面板：

1. **选择通知渠道**（默认 `🌐 浏览器通知`）
2. **填入对应凭证**（如 Telegram Bot Token / Chat ID）
3. 调整 **行为选项**（成功 / 停止 / 出错 是否通知、是否在标签页可见时静默、冷却时长）
4. 点击 **「发送测试通知」** 验证渠道
5. 关闭面板 → 自动保存到 localStorage

如果使用浏览器原生通知，第一次会弹权限询问；如果拒绝，插件会自动改用页面内浮动 toast，**不会**完全失效。

## 切换渠道示例

### Telegram

1. 在 Telegram 中 `@BotFather` 创建 bot，拿到 `telegramBotToken`
2. 给自己发一条消息，访问 `https://api.telegram.org/bot<TOKEN>/getUpdates` 拿到 `chat.id`
3. 在设置面板选 `Telegram` 并填入两项凭证

### Bark (iPhone)

1. App Store 装 Bark（[apps.apple.com/cn/app/bark](https://apps.apple.com/cn/app/bark-customed-notifications/id1403753865)）
2. 打开 Bark，记下你的设备 Key
3. 面板里选 `Bark`，填入 `barkKey`

### Server酱 (微信)

1. 微信扫码登录 [sct.ftqq.com](https://sct.ftqq.com)
2. 拿到 SendKey（以 `SCT` 开头）
3. 面板里选 `Server酱`，填入

## 故障排除

| 问题 | 原因 | 解决方法 |
|------|------|----------|
| 安装报 `ERR_PNPM_ADDING_TO_ROOT` | profile 是 pnpm workspace root | 加 `-w` 标志重新执行 |
| 装了但右下角没有 🔔 按钮 | 未重启 `dsh web` | 重启后强刷页面 |
| 浏览器没弹权限询问 | 之前已「阻止」该网站 | 浏览器地址栏左侧锁形图标 → 通知 → 允许 |
| Telegram 报 401/400 | `telegramBotToken` / `telegramChatId` 配错 | 用 `@BotFather` 重新获取 token；用 `getUpdates` 找 chat id |
| 测试按钮提示「Telegram provider requires…」 | 凭证未填 | 滚动到「渠道凭证」区填入对应字段 |
| 通知频率太高 | 多个 agent 接连完成 | 调大「冷却（ms）」，默认 5000 |
| 切回浏览器通知 | 想撤销 Telegram 配置 | 面板顶部下拉切回 `浏览器通知` |
| 完全停用 | — | `DSHCompletionReminder.deactivate()` |
| 重置所有配置 | — | 设置面板里点「重置」按钮 |

## 卸载

```bash
dsh plugin --profile web remove dsh-completion-reminder
```

然后重启：

```bash
dsh web
```
