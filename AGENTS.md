# AGENTS.md — openclaw-wecom-kf

## 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9

### 安装依赖

```bash
npm install --include=dev
```

### 构建

```bash
npm run build
```

构建工具为 tsup，输出 ESM 格式到 `dist/` 目录，包含：
- `dist/index.js` — 主入口（约 70 KB）
- `dist/index.d.ts` — 类型声明
- `dist/index.js.map` — Source map

### 运行测试

```bash
npm test
```

使用 vitest 运行全部测试（当前 5 个测试文件，46 个测试用例）。

监听模式：

```bash
npm run test:watch
```

### 开发模式（监听构建）

```bash
npm run dev
```

## 项目结构

```
src/
├── index.ts              # 插件入口，default export + 所有公共导出
├── types.ts              # 类型定义（配置、消息、API 响应等）
├── config.ts             # 多账户配置解析、DM 策略、环境变量 fallback
├── runtime.ts            # OpenClaw 运行时单例管理
├── crypto.ts             # 企微回调签名验证 + AES-256-CBC 加解密
├── client.ts             # WecomKfClient — 统一 API 客户端（token 缓存、自动重试）
├── webhook.ts            # HTTP 路由处理：GET 签名验证 + POST 回调事件
├── channel.ts            # ChannelPlugin 实现（meta, capabilities, outbound, gateway）
├── send.ts               # sendWecomKfDM 便捷发送封装
├── dispatch.ts           # 入站消息分发到 OpenClaw Agent 运行时
├── handlers/
│   ├── registry.ts       # Handler 注册表（registerHandler / getHandler / extractContent）
│   ├── text.ts           # 文本消息处理
│   ├── media.ts          # 图片/语音/视频/文件消息处理
│   ├── location.ts       # 地理位置消息处理
│   └── event.ts          # 事件处理（enter_session / msg_send_fail / recall_msg 等）
└── __tests__/
    ├── client.test.ts          # WecomKfClient + stripMarkdown + splitMessageByBytes
    ├── client-account.test.ts  # 客服账号管理 + 接待人员管理 API
    ├── handlers.test.ts        # Handler 注册表 + extractContent + 事件处理
    └── crypto.test.ts          # 签名验证 + AES 加解密往返测试
```

## 核心模块说明

### WecomKfClient (`src/client.ts`)

统一 API 客户端，覆盖以下企微客服接口：

- **Token 管理**: `getAccessToken()` — 自动缓存，errcode 40014/42001/42009 自动刷新重试
- **消息同步**: `syncMessages()` — cursor 分页拉取
- **消息发送**: `sendMessage()` / `sendText()` / `sendImage()` / `sendLink()` / `sendMsgMenu()` / `sendLocation()` 等
- **事件响应**: `sendOnEvent()` — welcome_code 响应
- **会话管理**: `getSessionState()` / `transferSession()`
- **客户信息**: `batchGetCustomer()`
- **媒体管理**: `uploadMedia()` / `downloadMedia()`
- **客服账号管理**: `addAccount()` / `deleteAccount()` / `updateAccount()` / `listAccounts()` / `getContactWay()`
- **接待人员管理**: `addServicer()` / `deleteServicer()` / `listServicer()`

### 插件注册 (`src/index.ts`)

通过 `default export` 暴露插件对象，`register(api)` 方法完成：
1. 设置运行时 (`setWecomKfRuntime`)
2. 注册渠道 (`api.registerChannel`)
3. 注册 HTTP 路由 (`api.registerHttpRoute` — 路径 `/wecom-kf`，无需认证，前缀匹配)

### Webhook (`src/webhook.ts`)

`handleWecomKfRoute(ctx: HttpRouteContext)` 直接使用 `ctx.path` / `ctx.query` / `ctx.req` / `ctx.res`：
- **GET** — URL 签名验证，返回 echostr
- **POST** — 解密回调 XML，触发 `sync_msg` 消息拉取

## 测试说明

测试框架为 vitest 4.x，所有测试使用 `vi.spyOn(globalThis, "fetch")` mock HTTP 请求，无需真实网络连接。

运行单个测试文件：

```bash
npx vitest run src/__tests__/client.test.ts
```

运行匹配特定名称的测试：

```bash
npx vitest run -t "stripMarkdown"
```

## 发布

```bash
npm run build
npm publish
```

`prepublishOnly` 脚本会在发布前自动执行构建。发布内容由 `package.json` 的 `files` 字段控制，仅包含 `dist/` 和 `openclaw.plugin.json`。
