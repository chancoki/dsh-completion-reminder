# DSH 完成提醒插件 - 安装指南

## 前提条件

- DeepSeek Harness (DSH) 已安装
- 浏览器允许 `http://127.0.0.1:3080` 发送通知（首次使用时会弹权限请求）

## 安装 / 升级

```bash
dsh plugin --profile web update dsh-completion-reminder
```

> 如果报 `ERR_PNPM_ADDING_TO_ROOT`，说明 profile 目录是 pnpm workspace root，补一个 `-w`：
>
> ```bash
> dsh plugin --profile web add -w dsh-completion-reminder
> ```

然后重启：

```bash
dsh web
```

## 配置通知渠道

1. 打开 DSH → 点击左上角「⚙ 设置」→ 进入「**插件**」section
2. 在 tab 栏里点击「**🔔 完成提醒**」（与「可配置」同级）
3. 选择通知渠道（默认 `🌐 浏览器通知`）
4. 填入对应凭证（**凭证区只显示当前渠道需要的字段**）
5. 调整「行为」选项（成功 / 主动停止 / 出错 是否通知、是否在标签页可见时静默、冷却时长）
6. 点击「发送测试通知」验证渠道
7. 关闭弹窗 → 自动保存到 localStorage

如果使用浏览器原生通知，第一次会弹权限询问；如果拒绝，插件会自动改用页面内浮动 toast，**不会**完全失效。

## 切换渠道示例

### Telegram

1. 在 Telegram 中 `@BotFather` 创建 bot，拿到 `telegramBotToken`
2. 给自己发一条消息，访问 `https://api.telegram.org/bot<TOKEN>/getUpdates` 拿到 `chat.id`
3. 设置面板选 `Telegram`，凭证区出现 2 个字段，填入

### Bark (iPhone)

1. App Store 装 Bark
2. 打开 Bark，记下你的设备 Key
3. 面板里选 `Bark`，凭证区出现 2 个字段（Key + 可选 Server），填入 Key

### Server酱 (微信)

1. 微信扫码登录 [sct.ftqq.com](https://sct.ftqq.com)
2. 拿到 SendKey（以 `SCT` 开头）
3. 面板里选 `Server酱`，凭证区出现 1 个字段

## 故障排除

| 问题 | 原因 | 解决方法 |
|------|------|----------|
| 安装报 `ERR_PNPM_ADDING_TO_ROOT` | profile 是 pnpm workspace root | 加 `-w` 标志重新执行 |
| 找不到「完成提醒」tab | 装的是 < v1.3.1 | `dsh plugin --profile web update dsh-completion-reminder && dsh web` |
| 「插件」section 里只有「可配置」 | DSH 主机 < v1.2 | 升级 DSH 主机 |
| 凭证区看不到字段 | 切到对应渠道才会出现 | 在单选组里选 Telegram / Bark / 其他 |
| 浏览器通知不弹 | ① 权限未授予 ② 权限被拒 ③ 系统勿扰/应用通知关闭 | 面板选「浏览器通知」→ 点「请求权限」；若已拒绝，地址栏左侧锁形图标 → 通知 → 允许；再查系统设置 |
| 开着 DSH 页面就收不到浏览器通知 | 「前台静默」开着（可见且聚焦时不通知） | 关掉该选项，或切到别的标签页/窗口等通知 |
| Telegram 报 401/400 | `telegramBotToken` / `telegramChatId` 配错 | 用 `@BotFather` 重新获取 token；用 `getUpdates` 找 chat id |
| 测试按钮提示「Telegram provider requires…」 | 凭证未填 | 凭证区填入对应字段 |
| 通知频率太高 | 多个 agent 接连完成 | 调大「冷却（ms）」，默认 5000 |
| 切回浏览器通知 | 想撤销 Telegram 配置 | 单选组里点回「浏览器通知」 |
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
