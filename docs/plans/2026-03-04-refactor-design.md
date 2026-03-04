# openclaw-wecom-kf 全面重构设计

## 背景

v0.2.2 插件功能基本完整，但存在以下核心问题：

1. bot.ts 4 种媒体类型各 ~20 行重复代码
2. access_token 无自动刷新重试，API 调用无重试机制
3. cursor 持久化用 setTimeout 延迟写入，进程崩溃丢 cursor
4. 类型安全差，`(msg as any)` 遍布 bot.ts
5. 使用已弃用的 `registerHttpHandler`
6. configSchema 在 3 个位置重复定义
7. 缺失：会话状态管理、客户信息查询、stable_token 支持
8. 缺失：视频号商品/订单等新消息类型

## 决策

- 方案 B：模块重组 + 能力补全（非完全重写）
- 仅支持最新版 OpenClaw 插件 API（不兼容旧版）
- 目标场景：个人/小团队使用
- **稳定性第一：无黑盒假死，所有调用有反馈，支持调试模式**

## 核心原则

1. **无黑盒假死:** 所有 API 调用有 15s 超时（可配置 `timeoutMs`），超时后抛出 `WecomKfApiError(code="TIMEOUT")`
2. **所有调用有反馈:** 消息发送始终返回详细结果（`{ ok, chunks, sentChunks, elapsedMs, errcode, errmsg }`），不吞异常
3. **可观测性:** 自定义 `WecomKfApiError` 错误类，含 `code`/`apiPath`/`errcode`/`errmsg`/`elapsedMs`，带 `toJSON()` 方便序列化
4. **调试模式:** 配置 `debug: true` 后打印：请求方向（→/←）、API 路径、请求体(截断 500 字符)、响应 errcode、耗时
5. **不吞异常:** 消除所有 `catch { /* ignore */ }`，改为至少 `logger.debug()` 记录
6. **健康心跳:** gateway 启动后每 5 分钟记录一次状态（token 剩余有效期、最近消息时间、cursor 位置）

## 新文件结构

```
src/
├── index.ts              # 插件入口 (register → registerHttpRoute)
├── types.ts              # 所有类型定义 (增强 discriminated union)
├── config.ts             # 配置解析 (基本不变)
├── crypto.ts             # 加解密 (不变)
├── client.ts             # WecomKfClient 类 — 统一 API 客户端
├── handlers/             # 消息处理器目录
│   ├── registry.ts       #   处理器注册表
│   ├── text.ts           #   文本消息处理器
│   ├── media.ts          #   图片/语音/视频/文件 (合并去重)
│   ├── location.ts       #   位置/链接/名片/小程序
│   └── event.ts          #   事件处理 (enter_session, 转接等)
├── webhook.ts            # HTTP 处理 (迁移到 registerHttpRoute)
├── dispatch.ts           # 消息分发到 OpenClaw 运行时
├── channel.ts            # ChannelPlugin 定义
├── send.ts               # 便捷发送封装
└── runtime.ts            # 运行时单例 (不变)
```

## 设计详情

### 1. WecomKfClient — 统一 API 客户端

将分散在 api.ts 中的函数封装为类，提供：

- **token 管理**：支持 stable_token 接口 + 自动刷新重试（40014/42001 错误时清缓存重试）
- **统一 request()**：所有 API 调用走统一方法，内置 errcode 检查 + 单次自动重试
- **新增 API**：
  - `getSessionState()` — 获取会话状态
  - `transferSession()` — 变更会话状态（机器人↔人工）
  - `batchGetCustomer()` — 批量获取客户信息
- **保留 API**：syncMessages, sendText, sendOnEvent, uploadMedia, downloadMedia

### 2. 消息处理器模式

用 `Map<msgtype, InboundHandler>` 替代 switch + 重复代码：

```typescript
type InboundHandler = {
  extract: (msg: SyncMsgItem) => string;
  enrich?: (msg: SyncMsgItem, client: WecomKfClient, account: ResolvedWecomKfAccount) => Promise<EnrichedResult>;
  handle?: (msg: SyncMsgItem, client: WecomKfClient, account: ResolvedWecomKfAccount) => Promise<void>;
};
```

- media.ts：一个循环注册 image/voice/video/file 四种类型
- event.ts：enter_session 事件发欢迎语 + 设置机器人接待状态
- 新增消息类型只需 `registerHandler("channels_shop_order", {...})`

### 3. Webhook 迁移

从 `registerHttpHandler` 迁移到 `registerHttpRoute`：
- 显式声明路径 + prefix 匹配
- auth: "none"（企微自己做签名验证）

### 4. Cursor 持久化

从 setTimeout 延迟写入改为同步写入：
- 每次 cursor 更新后立即 await 写入文件
- 小团队场景下 IO 开销可忽略（~0.5ms vs 网络 ~100ms）

### 5. 会话状态管理

新增：
- enter_session 事件自动变更为机器人接待状态
- 支持 session_status_change 事件响应
- 可配置是否自动接管会话

### 6. configSchema 单一来源

从 openclaw.plugin.json 中读取或代码生成，不再在 3 个位置手动维护。

### 7. 类型安全

- 利用 TypeScript discriminated union 正确推导消息字段
- 消除所有 `(msg as any)` 用法
- 新增 `getMediaId()` 等类型安全的辅助函数
