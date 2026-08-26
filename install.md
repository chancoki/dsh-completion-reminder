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

### 钉钉机器人

1. 钉钉群 → 群设置 → 智能群助手 → 添加「自定义」机器人
2. 安全设置建议选「加签」，记下 `SEC` 开头的密钥（或改用「自定义关键词」并填 `DSH`）
3. 复制 Webhook 地址（含 `access_token`），面板里选「钉钉机器人」填入；开了加签就再填密钥
4. **启动本地转发**（钉钉接口不允许浏览器直连，v1.6.0 起）：

   ```bash
   # 插件 npm 安装目录下的 relay/relay.mjs，例如全局 npm 目录：
   node "C:\Users\you\AppData\Roaming\npm\node_modules\dsh-completion-reminder\relay\relay.mjs"
   ```

   保持该窗口开着；面板里把「本地转发地址」填为 `http://127.0.0.1:8765`
5. 点「发送测试通知」验证——失败会显示具体 errcode（如 310000 = 关键词不匹配）

### 飞书机器人（直连可用，无需转发）

1. 飞书群 → 设置 → 群机器人 → 添加「自定义机器人」
2. 若开启「签名校验」记下密钥
3. 复制 Webhook 地址，面板里选「飞书机器人」填入即可

### 企业微信机器人

1. 企业微信群右键 → 添加群机器人 → 记录 Webhook 地址（含 `key=` 参数）
2. **启动本地转发**（同钉钉第 4 步），面板里把「本地转发地址」填为 `http://127.0.0.1:8765`

### Server酱 (微信)

1. 微信扫码登录 [sct.ftqq.com](https://sct.ftqq.com)
2. 拿到 SendKey（以 `SCT` 开头）
3. 面板里选「Server酱」，凭证区出现 1 个字段

### Telegram

1. 在 Telegram 中 `@BotFather` 创建 bot，拿到 `telegramBotToken`
2. 给自己发一条消息，访问 `https://api.telegram.org/bot<TOKEN>/getUpdates` 拿到 `chat.id`
3. 设置面板选 `Telegram`，凭证区出现 2 个字段，填入

### Bark (iPhone)

1. App Store 装 Bark
2. 打开 Bark，记下你的设备 Key
3. 面板里选 `Bark`，凭证区出现 2 个字段（Key + 可选 Server），填入 Key

## 故障排除

| 问题 | 原因 | 解决方法 |
|------|------|----------|
| 安装报 `ERR_PNPM_ADDING_TO_ROOT` | profile 是 pnpm workspace root | 加 `-w` 标志重新执行 |
| **刷新网页后设置重置** | ① 插件 < v1.5.0（STORAGE_KEY 缺失 bug）② 地址在 localhost 和 127.0.0.1 之间切换（不同源不共享存储） | 升级到 ≥ v1.5.0；固定用同一个地址打开 DSH（面板底部会显示当前站点） |
| 找不到「完成提醒」tab | 装的是 < v1.3.1 | `dsh plugin --profile web update dsh-completion-reminder && dsh web` |
| 「插件」section 里只有「可配置」 | DSH 主机 < v1.2 | 升级 DSH 主机 |
| 凭证区看不到字段 | 切到对应渠道才会出现 | 在单选组里选对应渠道 |
| 浏览器通知不弹 | ① 权限未授予 ② 权限被拒 ③ 系统勿扰/应用通知关闭 | 面板选「浏览器通知」→ 点「请求权限」；若已拒绝，地址栏左侧锁形图标 → 通知 → 允许；再查系统设置 |
| 开着 DSH 页面就收不到浏览器通知 | 「前台静默」开着（可见且聚焦时不通知） | 关掉该选项，或切到别的标签页/窗口等通知 |
| 钉钉/企微提示「不允许浏览器直连」 | 两家接口不支持 CORS，v1.6.0 起需本地转发 | 启动 `relay.mjs`（见上方渠道示例），面板填 `http://127.0.0.1:8765` |
| 钉钉发不出（errcode 310000） | 机器人安全设置不匹配 | 关键词过滤就把关键词设为 `DSH`；加签模式务必填密钥 |
| 钉钉/飞书/企微提示网络失败 | Webhook 地址错或公司网络拦截 | 核对地址；企业内网可能需要代理出网 |
| 「无法连接本地转发服务」 | relay.mjs 没启动或端口不对 | 先启动转发服务；确认面板里的地址与启动端口一致 |
| 飞书报 19001 | Webhook token 错误 | 重新复制机器人 Webhook 地址 |
| Telegram 报 401/400 | token / chat id 配错 | 用 `@BotFather` 重新获取；用 `getUpdates` 找 chat id |
| 通知频率太高 | 多个 agent 接连完成 | 调大「冷却（ms）」，默认 5000 |
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
