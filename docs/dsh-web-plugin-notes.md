# DSH Web 插件开发笔记 —— 如何在设置弹窗里加自己的 UI

> 思路向总结，不绑定任何具体插件项目。记录的是"从零做一个 DSH 客户端插件、
> 把配置界面塞进 DSH 设置弹窗"这件事的完整方法论和踩坑结论。

---

## 1. 插件是如何被加载的（静态 bundle 模式）

DSH 的 web 端支持一种"静态 bundle"插件：不经过包管理器动态安装，而是把
一个 JS 文件直接喂给页面上的全局加载器：

```js
window.__ModuleLoader__.load({
  id: 'your-plugin-id',
  factory: (require) => {
    // 你的全部代码都在这个工厂函数里
    return { apply, configure, activate, deactivate };
  },
});
```

要点：

- 整个插件是**单文件**，所有依赖要么内联、要么通过工厂参数 `require('react')`
  这类宿主已注册的模块解析；
- 让 DSH 认领这个文件需要两处声明：
  1. `package.json` 里加 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "inject": [] } }`；
  2. 一个 `cordis.patch.yml`，用 insert 语法把插件注册进宿主的配置树；
- 文件由开发服务器挂在 `/plugins/<pkg>/client.js?rev=xxx` 下。**URL 带 rev 参数，
  内容变了 rev 才变**——调试时如果改了代码但页面没生效，先确认 rev 变了没有。

## 2. 对象插件契约：`inject` 是一切的前提（最大的坑）

宿主按 cordis 的对象插件协议消费 factory 返回值：

```js
return {
  name: 'your-plugin',
  inject: ['slots'],        // ← 没有 它，下面的一切都不会发生
  apply(ctx, opts) { ... },
};
```

- `inject: ['slots']` 的语义是：**loader 会等 slots 服务就绪之后才调用 apply**。
- 不写它的话，apply 可能在服务提供之前抢跑，此时 `ctx.slots` 是 undefined，
  你的注册逻辑被静默跳过——**没有任何报错**，表现为"设置入口永远不出现"。
- 排查这种"静默不生效"的通用手段：在 apply 第一行往 `window` 上挂一个诊断
  对象（版本号、apply 是否执行、slots 是否存在），页面上直接看。

## 3. Slot 系统：两个现成的注入口

slot 是宿主声明的"UI 空位"，第三方插件可以往里塞渲染回调：

```js
// 声明等待式注入：slot 尚未声明时会挂起，父条目的 children 表一旦声明就重跑
const dispose = ctx.slots.inject('settings.plugins.tab', () => {
  /* 返回或注册你的组件 */
});

// 自己拥有并对外提供 slot（可选）
ctx.slots.register(ownerEntry, { id: 'xxx', order: 100 });
```

实测可用的两个注入口：

| slot key | 位置 | 关键字段 |
|----------|------|----------|
| `settings.section` | 设置弹窗左侧导航列表 | `id`、`order`（数字决定排位，选一个不和内置项冲突的值） |
| `settings.plugins.tab` | 「插件」section 内部的 tab 栏 | `id`、`order`（如 0 = 排在「可配置」前，100 = 最后） |

**思路**：导航级入口适合做主面板；tab 级入口适合寄生在「插件」页里和官方
插件并列。两者可以同时用，互相独立。

## 4. 把 React 组件挂进 slot 的稳妥姿势

宿主环境里 React 通过工厂参数拿：`const React = require('react')`。
只用到 `createElement` 的话不要引 jsx-runtime。

挂载模式推荐**命令式挂载 + callback ref 触发**（对齐官方市场的做法）：

```js
function MyPanel() {
  return React.createElement('div', {
    ref: (el) => { if (el) renderPanelInto(el); },
  });
}
```

- 不要用 `forwardRef` / `useRef` 这类需要完整 React 运行时特性的写法，
  宿主 bundle 里的 React 可能是精简版；
- inline callback ref 在每次渲染都会重调，所以 `renderPanelInto` 内部要
  记录"当前 host 元素"，同一个元素重复触发时跳过，避免无限重渲染；
- 卸载时清理自己插入的 `<style>`、事件监听和 MutationObserver。

## 5. 监听页面状态：只用稳定属性做 DOM 锚点

如果插件需要感知页面状态（比如"agent 正在运行/已完成"），要观察 DOM：

- **只锚定稳定属性**：`data-*`、`aria-label`、`type`。CSS-modules 编译后的
  class 名带哈希，任何样式改动都会让你失效；
- 注意 `aria-label` 往往来自 i18n 字典，值随界面语言变化。匹配时维护一组
  多语言 token（中英文都列上），用子串匹配而不是全等；
- 用 `MutationObserver` 监听目标元素（或其容器）的 `attributes` 变化，
  而不是轮询；
- 宿主升级随时可能改变 DOM 结构，锚点逻辑要写得"找不到就安静待命"，
  别抛错刷屏。

## 6. 浏览器通知的手势规则（容易白干的一块）

- `Notification.requestPermission()` **必须由用户手势触发**（按钮点击）。
  页面加载时自动请求会被浏览器静默忽略，而且会污染缓存的权限状态，
  导致后续真正的点击请求也不弹；
- 正确结构：设置面板里放一个「请求权限」按钮，它是唯一的授权入口；
  发送通知的地方每次**实时读取** `Notification.permission`，不要信任启动时
  缓存的值（用户可能中途在地址栏改了权限）；
- 权限被拒后的降级路径：页内 toast。同时把"去哪里重新允许"
  （地址栏锁形图标 → 通知）写在提示文案里。

## 7. 从网页调外部推送接口：先探 CORS 再写码

给插件加 webhook 类渠道（钉钉机器人、飞书机器人、企业微信、Telegram…）
之前，**必须先用真实接口探测**，不能想当然。探测矩阵三件事：

1. **POST 响应有没有 `Access-Control-Allow-Origin`**（请求头带上 `Origin`
   再测！很多服务只在有 Origin 时才回 CORS 头）；
2. **OPTIONS 预检放不放行**（自定义 Content-Type 如 application/json 会触发预检）；
3. **服务端对 Content-Type 的严格程度**（有的接口拒收 text/plain，报业务错误码）。

实测得到的现实分布很有代表性：

- **飞书**类：POST 响应自带完整 CORS 头 → 浏览器可直连，标准 fetch 即可；
- **钉钉**类：要求 application/json（text/plain 报 43004），但没有 CORS 头、
  预检也拒 → **浏览器物理上无法直连**，别浪费时间写客户端方案；
- 中间态：text/plain 简单请求能发出去，但响应不可读 → fetch 会 reject，
  你分不清"发出去了但读不到结果"还是"根本没发出"。除非走 `mode:'no-cors'`
  盲发且接受零反馈，否则不要采用。

结论落成产品原则：**只收录可直连的渠道**。做不到直连的，要么砍掉，
要么明说需要用户自建转发服务——并且把上游返回的业务错误码
（errcode/code）原样透出给用户，"发送失败"四个字没法排查问题。

签名类安全设置（加签/签名校验）：用 `crypto.subtle`（HMAC-SHA256 → base64）
在浏览器本地算，密钥不出机器。注意 localhost 和 127.0.0.1 都是 secure context，
这没问题；但要处理 `crypto.subtle` 不存在的环境并给出人话报错。

## 8. 配置持久化：localStorage 的几个必然要踩的点

- **key 带版本号**（如 `...:config:v1`），读取后做 partial merge 合入默认值，
  这样未来加字段不用迁移脚本；
- 写入也要 try/catch——无痕模式、禁站点数据时 setItem 直接抛；
- **origin 隔离**：`localhost:3080` 和 `127.0.0.1:3080` 是两个不同的源，
  配置互不相通。这是"我设置了怎么丢了"的高频原因，值得在 UI 上显示当前
  origin 帮用户自查；
- 多标签页同步：监听 `storage` 事件，key 匹配就重新 load + 重渲染面板；
- **绝不在读写 localStorage 的地方静默吞错**：至少把"storage 可用性"
  暴露到诊断对象和面板 footer。本项目曾因构建产物缺一个常量导致所有
  localStorage 操作抛 ReferenceError 被 try/catch 吞掉，持久化坏了三个版本
  都没人发现——错误信息能到用户眼前，一秒就能定位。

## 9. 构建脚本：ESM 包进工厂函数的转换规则

tsc 产出 ESM，工厂函数体是 CJS 风格，需要一个转换器，规则集大致是：

```
import * as X from 'react'      → var X = require('react')
import { a as b } from 'react'  → var { a: b } = require('react')
import './side-effect'          → 删除
export { a, b as c }            → exports.a = a; exports.c = b
export const/function X         → 去掉 export 关键字
```

三条血泪教训：

1. **`export {}` 列表的花括号里不能有注释**——正则逐行匹配会把注释原样
   拼进产物，产出语法错误的 JS；
2. **不要手工维护"types 里那几个常量"的内联拷贝**。源码加了新常量、拷贝没跟，
   就是运行时 ReferenceError（且大概率被第 8 条的 try/catch 吞掉）。正确做法：
   构建时直接读编译产物，把整个 types 模块包进 IIFE 命名空间，再按 client
   实际 import 的名字列表解构——以后源码加什么自动跟上；
3. 产物生成后跑一遍 `node --check`（语法校验），再跑行为 smoke，两道闸都要有。

## 10. 本地验证方法论：模拟真实页面加载

PowerShell 会吃掉内联 `node -e` 的参数，所以所有探针一律写成 `.cjs` 文件。
核心技巧是用 **JSDOM + vm** 造出完全隔离的"两次页面加载"：

```js
function makeSandbox(seedLocalStorage) {
  const dom = new JSDOM('<html></html>', { url: 'http://127.0.0.1:3080/' });
  if (seedLocalStorage) dom.window.localStorage.setItem(KEY, seedLocalStorage);
  // jsdom 缺的全局要用 defineProperty 强盖（普通赋值会被 window 自身属性遮蔽）：
  Object.defineProperty(dom.window, 'crypto',     { value: require('node:crypto').webcrypto });
  Object.defineProperty(dom.window, 'TextEncoder',{ value: require('node:util').TextEncoder });
  Object.defineProperty(dom.window, 'btoa',       { value: (s) => Buffer.from(s, 'binary').toString('base64') });
  const sandbox = vm.createContext(dom.window);
  sandbox.__ModuleLoader__ = { load: (m) => (sandbox.__REG__ = m) };
  sandbox.fetch = async (url, opts) => ({ ok: true, json: async () => ({}) }); // 按 URL mock
  vm.runInContext(bundleCode, sandbox);
  return sandbox.__REG__.factory(require);
}
```

能覆盖的场景：

- **跨刷新持久化**：沙箱 1 改配置 → 读出 localStorage 字符串 → 种进全新的
  沙箱 2 → 断言面板恢复。这一招直接定位过"刷新重置"的真因（构建缺常量）；
- **UI 交互链路**：radio change / input 事件用 `new dom.window.Event(...,
  { bubbles: true })` 派发；注意重渲染会换 DOM，断言前必须重新 querySelector；
- **mock 边界**：fetch 返回业务错误码时断言 toast/status 出现对应文案；
- **对真实外网接口的探测脚本**单独一类：不带 Origin 和带 Origin 各测一次，
  OPTIONS 预检测一次，不同 Content-Type 各测一次，输出成矩阵看。

## 11. 发版清单

1. 版本号 bump（package.json 与文档同步）；
2. `npm run build` → `node --check lib/client.js` → 行为 smoke 全绿；
3. git commit + tag（vX.Y.Z）+ push（含 tags）；
4. npm publish：token 写进临时 `.npmrc`，**发布完立刻删**；npm 缓存和日志
   指到项目内的临时目录，一并清掉；
5. 用 registry 查询确认 dist-tag 已更新（刚发布会有几秒 CDN 延迟）；
6. 用户侧升级后：开发服务器按 rev 强刷，若没生效先查 rev。

## 12. 踩坑速查表

| 症状 | 根因 | 一句话解法 |
|------|------|-----------|
| 设置入口永远不出现 | apply 抢跑于 slots 服务，ctx.slots undefined | 导出 `inject: ['slots']` |
| 改了代码页面没变 | 服务端 rev 未变 | 确认构建产物更新、rev 变化 |
| 通知权限请求无反应 | 非用户手势调用 requestPermission | 只在按钮点击里请求 |
| 刷新后配置丢失 | ① 构建缺常量致读写抛错被吞 ② localhost 与 127.0.0.1 不同源 | 自动提取常量 + 显示当前 origin |
| 外部渠道"发送失败" | 目标接口无 CORS 头，fetch reject | 先探测矩阵再定渠道名单 |
| 上游失败但看不出原因 | 业务错误码未透出 | 解析 errcode/code 并展示 |
| 产物语法错误 | export{} 花括号内有注释 | 注释移出花括号 |
| jsdom 测试里 crypto/btoa 缺失 | jsdom 不实现这些全局 | defineProperty 盖上 Node 实现 |
