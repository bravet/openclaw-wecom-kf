# openclaw-wecom-kf 全面重构实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 全面重构 openclaw-wecom-kf 插件，统一 API 客户端、消息处理器模式、迁移新版 OpenClaw API、补全会话管理等能力。**稳定性第一，不能有黑盒假死，所有 API 调用必须有超时和反馈，支持调试模式方便定位问题。**

**Architecture:** 保留现有数据流（webhook → sync_msg → dispatch → reply → send_msg），但重组模块边界：引入 WecomKfClient 类封装所有企微 API 调用（含自动 token 刷新重试 + 超时 + 详细错误反馈），用 handler 注册表替代 switch/重复代码，迁移到 registerHttpRoute 新 API。所有 API 调用带超时，所有异常路径有日志输出，支持 debug 模式打印请求/响应详情。

**Tech Stack:** TypeScript 5.7+, tsup (ESM bundle), Node 18+, vitest (新增测试框架)

**核心原则:**
- **无黑盒假死:** 所有 API 调用有 15s 超时（可配置），超时后抛出明确的 `WecomKfApiError`
- **所有调用有反馈:** 消息发送始终返回详细结果（成功/失败/超时/网络不可用），不吞异常
- **可观测性:** 自定义 `WecomKfApiError` 错误类，包含 code/apiPath/errcode/errmsg，方便定位
- **调试模式:** 配置 `debug: true` 后打印所有 API 请求 URL、请求体、响应体、耗时
- **不吞异常:** 消除所有 `catch { /* ignore */ }`，至少记录 debug 级别日志
- **健康心跳:** 定期记录 token 有效期、最近消息时间、cursor 位置

---

## Task 0: 安装测试框架

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

**Step 1: 安装 vitest**

```bash
cd /Users/yong/work/_mcp_workspace/github/openclaw-wecom-kf
npm install -D vitest
```

**Step 2: 创建 vitest 配置**

创建 `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
  },
});
```

**Step 3: 在 package.json 中添加 test 脚本**

在 `scripts` 中添加:

```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 4: 验证**

```bash
npx vitest run
```

Expected: "No test files found" (0 tests, 无错误)

**Step 5: Commit**

```bash
git add -A && git commit -m "chore: add vitest test framework"
```

---

## Task 1: 增强 types.ts — 类型安全基础

**Files:**
- Modify: `src/types.ts`
- Create: `src/__tests__/types.test.ts`

**Step 1: 写测试 — 类型辅助函数**

创建 `src/__tests__/types.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { getMediaId, isMediaMessage, isEventMessage } from "../types.js";
import type { SyncMsgItem, SyncMsgText, SyncMsgImage, SyncMsgEvent } from "../types.js";

describe("getMediaId", () => {
  it("extracts media_id from image message", () => {
    const msg: SyncMsgImage = {
      msgid: "1", open_kfid: "wk1", external_userid: "u1",
      send_time: 1000, origin: 3, msgtype: "image",
      image: { media_id: "mid_123" },
    };
    expect(getMediaId(msg)).toBe("mid_123");
  });

  it("returns undefined for text message", () => {
    const msg: SyncMsgText = {
      msgid: "2", open_kfid: "wk1", external_userid: "u1",
      send_time: 1000, origin: 3, msgtype: "text",
      text: { content: "hello" },
    };
    expect(getMediaId(msg)).toBeUndefined();
  });
});

describe("isMediaMessage", () => {
  it("returns true for image", () => {
    expect(isMediaMessage("image")).toBe(true);
  });
  it("returns false for text", () => {
    expect(isMediaMessage("text")).toBe(false);
  });
});

describe("isEventMessage", () => {
  it("returns true for event", () => {
    expect(isEventMessage("event")).toBe(true);
  });
  it("returns false for text", () => {
    expect(isEventMessage("text")).toBe(false);
  });
});
```

**Step 2: 运行测试确认失败**

```bash
npx vitest run src/__tests__/types.test.ts
```

Expected: FAIL — `getMediaId` 等函数不存在

**Step 3: 在 types.ts 中添加类型安全辅助函数**

在 `src/types.ts` 末尾追加:

```typescript
// ─── Type Guards & Helpers ──────────────────────────────────

const MEDIA_MSG_TYPES = new Set(["image", "voice", "video", "file"]);

export function isMediaMessage(msgtype: string): boolean {
  return MEDIA_MSG_TYPES.has(msgtype);
}

export function isEventMessage(msgtype: string): boolean {
  return msgtype === "event";
}

export function getMediaId(msg: SyncMsgItem): string | undefined {
  switch (msg.msgtype) {
    case "image": return msg.image.media_id;
    case "voice": return msg.voice.media_id;
    case "video": return msg.video.media_id;
    case "file":  return msg.file.media_id;
    default: return undefined;
  }
}

// ─── New API Types ──────────────────────────────────────────

export type SessionState = {
  service_state: number; // 0=未处理 1=机器人 2=排队 3=人工 4=已结束
  servicer_userid?: string;
};

export type CustomerInfo = {
  external_userid: string;
  nickname?: string;
  avatar?: string;
  gender?: number;
  unionid?: string;
};

export type MediaType = "image" | "voice" | "video" | "file";

export type DownloadResult = {
  ok: boolean;
  path?: string;
  error?: string;
};

// ─── OpenClaw Plugin API (latest) ───────────────────────────

export interface OpenClawPluginApi {
  registerChannel: (opts: { plugin: unknown }) => void;
  registerHttpRoute?: (opts: {
    path: string;
    auth?: string;
    match?: string;
    handler: (ctx: HttpRouteContext) => Promise<void> | void;
  }) => void;
  /** @deprecated use registerHttpRoute */
  registerHttpHandler?: (
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean
  ) => void;
  runtime?: unknown;
  config?: PluginConfig;
  [key: string]: unknown;
}

export type HttpRouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  query: URLSearchParams;
};

import type { IncomingMessage, ServerResponse } from "http";
```

**Step 4: 运行测试确认通过**

```bash
npx vitest run src/__tests__/types.test.ts
```

Expected: PASS

**Step 5: 构建验证无类型错误**

```bash
npm run build
```

Expected: 构建成功

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: enhance types with type guards and new API types"
```

---

## Task 2: 创建 WecomKfClient 类

**Files:**
- Create: `src/client.ts`
- Create: `src/__tests__/client.test.ts`

**Step 1: 写测试 — token 缓存与刷新逻辑**

创建 `src/__tests__/client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WecomKfClient } from "../client.js";
import type { ResolvedWecomKfAccount } from "../types.js";

function makeAccount(overrides?: Partial<ResolvedWecomKfAccount>): ResolvedWecomKfAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    corpId: "ww_test",
    corpSecret: "secret_test",
    openKfId: "wk_test",
    canSendActive: true,
    config: {},
    ...overrides,
  };
}

describe("WecomKfClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws if corpId missing", () => {
    const account = makeAccount({ corpId: undefined });
    const client = new WecomKfClient(account);
    expect(client.getAccessToken()).rejects.toThrow("corpId");
  });

  it("caches token within TTL", async () => {
    const account = makeAccount();
    const client = new WecomKfClient(account);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ errcode: 0, access_token: "tok_1", expires_in: 7200 }))
    );
    const tok1 = await client.getAccessToken();
    const tok2 = await client.getAccessToken();
    expect(tok1).toBe("tok_1");
    expect(tok2).toBe("tok_1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries on expired token error", async () => {
    const account = makeAccount();
    const client = new WecomKfClient(account);
    // First call: return a valid token
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, access_token: "tok_old" })))
      // sync_msg with old token: 42001 expired
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 42001, errmsg: "access_token expired" })))
      // refresh token
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, access_token: "tok_new" })))
      // retry sync_msg: success
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, next_cursor: "c1", has_more: 0, msg_list: [] })));

    const result = await client.syncMessages({ limit: 10 });
    expect(result.errcode).toBe(0);
  });
});
```

**Step 2: 运行测试确认失败**

```bash
npx vitest run src/__tests__/client.test.ts
```

Expected: FAIL — WecomKfClient 不存在

**Step 3: 实现 WecomKfClient**

创建 `src/client.ts`:

```typescript
/**
 * 微信客服统一 API 客户端
 *
 * 核心设计原则：
 * - 无黑盒假死：所有 API 调用有超时（默认 15s），超时后抛明确错误
 * - 所有调用有反馈：不吞异常，所有错误路径记录日志
 * - 自动 token 刷新重试：40014/42001/42009 错误时清缓存重试一次
 * - 调试模式：debug=true 时打印请求/响应详情
 */

import crypto from "crypto";
import { tmpdir } from "os";
import { join, extname, basename } from "path";
import { mkdir, writeFile, readdir, stat, unlink, rename } from "fs/promises";
import type {
  ResolvedWecomKfAccount,
  SyncMsgResponse,
  KfSendMsgParams,
  KfSendMsgResult,
  SessionState,
  CustomerInfo,
  MediaType,
  DownloadResult,
  AccessTokenCacheEntry,
} from "./types.js";
import {
  resolveApiBaseUrl,
  resolveInboundMediaDir,
  resolveInboundMediaKeepDays,
  resolveInboundMediaMaxBytes,
} from "./config.js";

// ─── Custom Error Class ─────────────────────────────────────

export class WecomKfApiError extends Error {
  constructor(
    message: string,
    public code: "TIMEOUT" | "NETWORK" | "API_ERROR" | "TOKEN_ERROR" | "CONFIG_ERROR",
    public apiPath: string,
    public errcode?: number,
    public errmsg?: string,
    public elapsedMs?: number,
  ) {
    super(message);
    this.name = "WecomKfApiError";
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      apiPath: this.apiPath,
      errcode: this.errcode,
      errmsg: this.errmsg,
      elapsedMs: this.elapsedMs,
      message: this.message,
    };
  }
}

// ─── Token error codes that trigger refresh ─────────────────
const TOKEN_EXPIRED_CODES = new Set([40014, 42001, 42009]);
const ACCESS_TOKEN_TTL_MS = 7200 * 1000 - 5 * 60 * 1000; // ~115 min
const DEFAULT_TIMEOUT_MS = 15_000; // 15 seconds

// ─── MIME → Extension Map ───────────────────────────────────
const MIME_EXT_MAP: Record<string, string> = {
  "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
  "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp",
  "application/pdf": ".pdf", "text/plain": ".txt",
};

function pickExtFromMime(mimeType?: string): string {
  const t = (mimeType ?? "").split(";")[0]?.trim().toLowerCase();
  return (t && MIME_EXT_MAP[t]) || "";
}

function parseContentDispositionFilename(headerValue?: string | null): string | undefined {
  const v = String(headerValue ?? "");
  if (!v) return undefined;
  const m1 = v.match(/filename\*=UTF-8''([^;]+)/i);
  if (m1?.[1]) {
    try { return decodeURIComponent(m1[1].trim().replace(/^"|"$/g, "")); }
    catch { return m1[1].trim().replace(/^"|"$/g, ""); }
  }
  const m2 = v.match(/filename=([^;]+)/i);
  if (m2?.[1]) return m2[1].trim().replace(/^"|"$/g, "");
  return undefined;
}

export class WecomKfClient {
  private static tokenCache = new Map<string, AccessTokenCacheEntry>();
  private apiBaseUrl: string;
  private debug: boolean;
  private logger: { debug: (m: string) => void; info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  private timeoutMs: number;

  constructor(
    private account: ResolvedWecomKfAccount,
    opts?: {
      log?: (msg: string) => void;
      error?: (msg: string) => void;
      timeoutMs?: number;
    }
  ) {
    this.apiBaseUrl = resolveApiBaseUrl(account.config);
    this.debug = (account.config as any).debug === true;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const logFn = opts?.log ?? console.log;
    const errFn = opts?.error ?? console.error;
    this.logger = {
      debug: (m) => { if (this.debug) logFn(`[wecom-kf] [DEBUG] ${m}`); },
      info: (m) => logFn(`[wecom-kf] ${m}`),
      warn: (m) => logFn(`[wecom-kf] [WARN] ${m}`),
      error: (m) => errFn(`[wecom-kf] [ERROR] ${m}`),
    };
  }

  // ─── Token Management ───────────────────────────────────────

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!this.account.corpId || !this.account.corpSecret) {
      throw new Error("corpId or corpSecret not configured");
    }
    const cacheKey = `${this.account.corpId}:kf`;
    if (!forceRefresh) {
      const cached = WecomKfClient.tokenCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        return cached.token;
      }
    }
    const url = `${this.apiBaseUrl}/cgi-bin/gettoken?corpid=${encodeURIComponent(this.account.corpId)}&corpsecret=${encodeURIComponent(this.account.corpSecret)}`;
    const resp = await fetch(url);
    const data = (await resp.json()) as { errcode?: number; errmsg?: string; access_token?: string };
    if (data.errcode && data.errcode !== 0) {
      throw new Error(`gettoken failed: ${data.errmsg ?? "unknown"} (errcode=${data.errcode})`);
    }
    if (!data.access_token) {
      throw new Error("gettoken returned empty access_token");
    }
    WecomKfClient.tokenCache.set(cacheKey, {
      token: data.access_token,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    });
    return data.access_token;
  }

  clearTokenCache(): void {
    const key = `${this.account.corpId}:kf`;
    WecomKfClient.tokenCache.delete(key);
  }

  static clearAllTokenCache(): void {
    WecomKfClient.tokenCache.clear();
  }

  // ─── Unified Request with Auto-Retry + Timeout + Debug ─────

  private async request<T extends { errcode?: number; errmsg?: string }>(
    path: string,
    body?: unknown,
    opts?: { method?: string; retried?: boolean; timeoutMs?: number }
  ): Promise<T> {
    const startMs = Date.now();
    const timeout = opts?.timeoutMs ?? this.timeoutMs;
    const accessToken = await this.getAccessToken();
    const separator = path.includes("?") ? "&" : "?";
    const url = `${this.apiBaseUrl}${path}${separator}access_token=${encodeURIComponent(accessToken)}`;
    const method = opts?.method ?? (body ? "POST" : "GET");

    // Debug: log request
    this.logger.debug(`→ ${method} ${path} ${body ? JSON.stringify(body).slice(0, 500) : "(no body)"}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const resp = await fetch(url, {
        method,
        signal: controller.signal,
        ...(body ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        } : {}),
      });
      const data = (await resp.json()) as T;
      const elapsedMs = Date.now() - startMs;

      // Debug: log response
      this.logger.debug(`← ${path} ${elapsedMs}ms errcode=${data.errcode ?? 0} ${JSON.stringify(data).slice(0, 500)}`);

      // Auto-retry on token expired
      if (data.errcode && TOKEN_EXPIRED_CODES.has(data.errcode) && !opts?.retried) {
        this.logger.warn(`token expired (errcode=${data.errcode}), refreshing and retrying ${path}`);
        this.clearTokenCache();
        return this.request<T>(path, body, { ...opts, retried: true });
      }

      if (data.errcode && data.errcode !== 0) {
        throw new WecomKfApiError(
          `API ${path} failed: ${data.errmsg ?? "unknown"} (errcode=${data.errcode})`,
          "API_ERROR", path, data.errcode, data.errmsg, elapsedMs
        );
      }
      return data;
    } catch (err) {
      const elapsedMs = Date.now() - startMs;
      if (err instanceof WecomKfApiError) throw err;
      if (err instanceof DOMException && err.name === "AbortError") {
        const error = new WecomKfApiError(
          `API ${path} timeout after ${timeout}ms`, "TIMEOUT", path, undefined, undefined, elapsedMs
        );
        this.logger.error(`${error.message}`);
        throw error;
      }
      const error = new WecomKfApiError(
        `API ${path} network error: ${err instanceof Error ? err.message : String(err)}`,
        "NETWORK", path, undefined, undefined, elapsedMs
      );
      this.logger.error(`${error.message}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Sync Messages ─────────────────────────────────────────

  async syncMessages(params: {
    cursor?: string;
    token?: string;
    open_kfid?: string;
    limit?: number;
    voice_format?: number;
  }): Promise<SyncMsgResponse> {
    const body: Record<string, unknown> = {};
    if (params.cursor) body.cursor = params.cursor;
    if (params.token) body.token = params.token;
    if (params.open_kfid) body.open_kfid = params.open_kfid;
    if (params.limit) body.limit = params.limit;
    if (params.voice_format !== undefined) body.voice_format = params.voice_format;
    return this.request<SyncMsgResponse>("/cgi-bin/kf/sync_msg", body);
  }

  // ─── Send Message ──────────────────────────────────────────

  async sendMessage(params: KfSendMsgParams): Promise<KfSendMsgResult> {
    return this.request<KfSendMsgResult>("/cgi-bin/kf/send_msg", params);
  }

  async sendText(toUser: string, text: string, openKfId: string): Promise<KfSendMsgResult & { chunks: number; sentChunks: number; elapsedMs: number }> {
    const startMs = Date.now();
    const plainText = stripMarkdown(text);
    const chunks = splitMessageByBytes(plainText, 2048);
    let sentChunks = 0;
    let lastResult: KfSendMsgResult = { errcode: 0, errmsg: "ok" };
    for (const chunk of chunks) {
      try {
        lastResult = await this.sendMessage({
          touser: toUser,
          open_kfid: openKfId,
          msgtype: "text",
          text: { content: chunk },
        });
        if (lastResult.errcode === 0) sentChunks++;
        else break;
      } catch (err) {
        this.logger.error(`sendText chunk ${sentChunks + 1}/${chunks.length} failed: ${String(err)}`);
        lastResult = { errcode: -1, errmsg: err instanceof Error ? err.message : String(err) };
        break;
      }
    }
    const elapsedMs = Date.now() - startMs;
    this.logger.info(`sendText to=${toUser}: ${sentChunks}/${chunks.length} chunks sent in ${elapsedMs}ms`);
    return { ...lastResult, chunks: chunks.length, sentChunks, elapsedMs };
  }

  async sendOnEvent(code: string, msgtype: string, content: Record<string, unknown>): Promise<KfSendMsgResult> {
    return this.request<KfSendMsgResult>("/cgi-bin/kf/send_msg_on_event", {
      code,
      msgtype,
      ...content,
    });
  }

  // ─── Session State ─────────────────────────────────────────

  async getSessionState(openKfId: string, externalUserId: string): Promise<SessionState> {
    const data = await this.request<{
      errcode?: number; errmsg?: string;
      service_state: number; servicer_userid?: string;
    }>("/cgi-bin/kf/service_state/get", {
      open_kfid: openKfId,
      external_userid: externalUserId,
    });
    return { service_state: data.service_state, servicer_userid: data.servicer_userid };
  }

  async transferSession(
    openKfId: string,
    externalUserId: string,
    serviceState: number,
    servicerUserId?: string
  ): Promise<void> {
    const body: Record<string, unknown> = {
      open_kfid: openKfId,
      external_userid: externalUserId,
      service_state: serviceState,
    };
    if (servicerUserId) body.servicer_userid = servicerUserId;
    await this.request("/cgi-bin/kf/service_state/trans", body);
  }

  // ─── Customer Info ─────────────────────────────────────────

  async batchGetCustomer(externalUserIds: string[]): Promise<CustomerInfo[]> {
    const data = await this.request<{
      errcode?: number; errmsg?: string;
      customer_list?: CustomerInfo[];
    }>("/cgi-bin/kf/customer/batchget", {
      external_userid_list: externalUserIds,
    });
    return data.customer_list ?? [];
  }

  // ─── Media Upload ──────────────────────────────────────────

  async uploadMedia(
    buffer: Buffer,
    filename: string,
    contentType?: string,
    type: MediaType = "file"
  ): Promise<string> {
    const accessToken = await this.getAccessToken();
    const url = `${this.apiBaseUrl}/cgi-bin/media/upload?access_token=${encodeURIComponent(accessToken)}&type=${type}`;
    const boundary = `----WebKitFormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
    const mime = contentType || "application/octet-stream";
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, buffer, footer]);
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const data = (await resp.json()) as { errcode?: number; errmsg?: string; media_id?: string };
    if (data.errcode && data.errcode !== 0) {
      throw new Error(`media upload failed: ${data.errmsg ?? "unknown"} (errcode=${data.errcode})`);
    }
    if (!data.media_id) throw new Error("media upload returned empty media_id");
    return data.media_id;
  }

  // ─── Media Download ────────────────────────────────────────

  async downloadMedia(mediaId: string, opts?: { maxBytes?: number; prefix?: string }): Promise<DownloadResult> {
    try {
      const accessToken = await this.getAccessToken();
      let url: string;
      if (mediaId.startsWith("http://") || mediaId.startsWith("https://")) {
        url = mediaId;
      } else {
        url = `${this.apiBaseUrl}/cgi-bin/media/get?access_token=${encodeURIComponent(accessToken)}&media_id=${encodeURIComponent(mediaId)}`;
      }
      const resp = await fetch(url);
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      const arrayBuffer = await resp.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const maxBytes = opts?.maxBytes ?? 10 * 1024 * 1024;
      if (buffer.length > maxBytes) return { ok: false, error: `file too large (${buffer.length} > ${maxBytes})` };
      const prefix = opts?.prefix ?? "media";
      const contentDisp = resp.headers.get("content-disposition");
      const cdFilename = parseContentDispositionFilename(contentDisp);
      const contentType = resp.headers.get("content-type") ?? undefined;
      let ext = cdFilename ? extname(cdFilename) : pickExtFromMime(contentType);
      if (!ext) ext = ".bin";
      const dir = join(tmpdir(), "wecom-kf-media");
      await mkdir(dir, { recursive: true });
      const filename = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const filePath = join(dir, filename);
      await writeFile(filePath, buffer);
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─── Inbound Media Finalize ────────────────────────────────

  async finalizeInboundMedia(filePath: string): Promise<string> {
    const p = String(filePath ?? "").trim();
    if (!p) return p;
    const tmpBase = join(tmpdir(), "wecom-kf-media");
    const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
    if (!norm(p).includes(norm(tmpBase))) return p;
    const baseDir = resolveInboundMediaDir(this.account.config);
    const now = new Date();
    const dateDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const datedDir = join(baseDir, dateDir);
    await mkdir(datedDir, { recursive: true });
    const name = basename(p);
    const dest = join(datedDir, name);
    try {
      await rename(p, dest);
      return dest;
    } catch {
      try { await unlink(p); } catch { /* ignore */ }
      return p;
    }
  }

  async pruneInboundMedia(): Promise<void> {
    const baseDir = resolveInboundMediaDir(this.account.config);
    const keepDays = resolveInboundMediaKeepDays(this.account.config);
    if (keepDays < 0) return;
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    let entries: string[];
    try { entries = await readdir(baseDir); } catch { return; }
    for (const entry of entries) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
      const dirPath = join(baseDir, entry);
      let st;
      try { st = await stat(dirPath); } catch { continue; }
      if (!st.isDirectory()) continue;
      if ((st.mtimeMs || st.ctimeMs || 0) >= cutoff) continue;
      let files: string[] = [];
      try { files = await readdir(dirPath); } catch { continue; }
      for (const f of files) {
        const fp = join(dirPath, f);
        try {
          const fst = await stat(fp);
          if (fst.isFile() && (fst.mtimeMs || fst.ctimeMs || 0) < cutoff) await unlink(fp);
        } catch { /* ignore */ }
      }
    }
  }
}

// ─── Text Helpers (exported for backward compat) ────────────

export function stripMarkdown(text: string): string {
  let result = text;
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const trimmedCode = (code as string).trim();
    if (!trimmedCode) return "";
    const langLabel = lang ? `[${lang}]\n` : "";
    const indentedCode = trimmedCode.split("\n").map((line: string) => `    ${line}`).join("\n");
    return `\n${langLabel}${indentedCode}\n`;
  });
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "【$1】");
  result = result.replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1")
    .replace(/__(.*?)__/g, "$1").replace(/(?<![\w/])_(.+?)_(?![\w/])/g, "$1");
  result = result.replace(/^[-*]\s+/gm, "· ");
  result = result.replace(/^(\d+)\.\s+/gm, "$1. ");
  result = result.replace(/`([^`]+)`/g, "$1");
  result = result.replace(/~~(.*?)~~/g, "$1");
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, "[图片: $1]");
  result = result.replace(
    /\|(.+)\|\n\|[-:| ]+\|\n((?:\|.+\|\n?)*)/g,
    (_match, header, body) => {
      const headerCells = (header as string).split("|").map((c) => c.trim()).filter(Boolean);
      const rows = (body as string).trim().split("\n").map((row) =>
        row.split("|").map((c) => c.trim()).filter(Boolean)
      );
      const colWidths = headerCells.map((h, i) => {
        const maxRowWidth = Math.max(...rows.map((r) => (r[i] || "").length));
        return Math.max(h.length, maxRowWidth);
      });
      const formattedHeader = headerCells.map((h, i) => h.padEnd(colWidths[i]!)).join("  ");
      const formattedRows = rows.map((row) =>
        headerCells.map((_, i) => (row[i] || "").padEnd(colWidths[i]!)).join("  ")
      ).join("\n");
      return `${formattedHeader}\n${formattedRows}\n`;
    }
  );
  result = result.replace(/^>\s?/gm, "");
  result = result.replace(/^[-*_]{3,}$/gm, "────────────");
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

export function splitMessageByBytes(text: string, maxBytes = 2048): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const char of text) {
    const next = current + char;
    if (Buffer.byteLength(next, "utf8") > maxBytes) {
      if (current) chunks.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
```

**Step 4: 运行测试**

```bash
npx vitest run src/__tests__/client.test.ts
```

Expected: PASS

**Step 5: 构建验证**

```bash
npm run build
```

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: add WecomKfClient unified API client with auto-retry"
```

---

## Task 3: 创建消息处理器注册表

**Files:**
- Create: `src/handlers/registry.ts`
- Create: `src/handlers/text.ts`
- Create: `src/handlers/media.ts`
- Create: `src/handlers/location.ts`
- Create: `src/handlers/event.ts`
- Create: `src/__tests__/handlers.test.ts`

**Step 1: 写测试**

创建 `src/__tests__/handlers.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { getHandler, extractContent } from "../handlers/registry.js";
import type { SyncMsgText, SyncMsgImage, SyncMsgLocation, SyncMsgLink } from "../types.js";

// Import all handlers to trigger registration
import "../handlers/text.js";
import "../handlers/media.js";
import "../handlers/location.js";
import "../handlers/event.js";

const BASE = { msgid: "1", open_kfid: "wk1", external_userid: "u1", send_time: 1000, origin: 3 };

describe("handler registry", () => {
  it("has text handler", () => {
    expect(getHandler("text")).toBeDefined();
  });
  it("has media handlers", () => {
    expect(getHandler("image")).toBeDefined();
    expect(getHandler("voice")).toBeDefined();
    expect(getHandler("video")).toBeDefined();
    expect(getHandler("file")).toBeDefined();
  });
  it("has location handler", () => {
    expect(getHandler("location")).toBeDefined();
  });
  it("has event handler", () => {
    expect(getHandler("event")).toBeDefined();
  });
});

describe("extractContent", () => {
  it("extracts text content", () => {
    const msg: SyncMsgText = { ...BASE, msgtype: "text", text: { content: "hello" } };
    expect(extractContent(msg)).toBe("hello");
  });
  it("extracts image placeholder", () => {
    const msg: SyncMsgImage = { ...BASE, msgtype: "image", image: { media_id: "mid1" } };
    expect(extractContent(msg)).toBe("[image]");
  });
  it("extracts location with coords", () => {
    const msg: SyncMsgLocation = {
      ...BASE, msgtype: "location",
      location: { latitude: 31.23, longitude: 121.47, name: "Shanghai" },
    };
    expect(extractContent(msg)).toContain("31.23");
    expect(extractContent(msg)).toContain("Shanghai");
  });
  it("returns [msgtype] for unknown types", () => {
    const msg = { ...BASE, msgtype: "unknown_type" } as any;
    expect(extractContent(msg)).toBe("[unknown_type]");
  });
});
```

**Step 2: 运行测试确认失败**

**Step 3: 实现所有 handler 文件**

创建 `src/handlers/registry.ts`:

```typescript
import type { SyncMsgItem, ResolvedWecomKfAccount } from "../types.js";
import type { WecomKfClient } from "../client.js";

export type EnrichedResult = {
  text: string;
  mediaPaths: string[];
};

export type InboundHandler = {
  extract: (msg: SyncMsgItem) => string;
  enrich?: (msg: SyncMsgItem, client: WecomKfClient, account: ResolvedWecomKfAccount) => Promise<EnrichedResult>;
  handle?: (msg: SyncMsgItem, client: WecomKfClient, account: ResolvedWecomKfAccount, logger?: { info: (m: string) => void; error: (m: string) => void; warn: (m: string) => void }) => Promise<void>;
};

const handlers = new Map<string, InboundHandler>();

export function registerHandler(msgtype: string, handler: InboundHandler): void {
  handlers.set(msgtype, handler);
}

export function getHandler(msgtype: string): InboundHandler | undefined {
  return handlers.get(msgtype);
}

export function extractContent(msg: SyncMsgItem): string {
  const handler = handlers.get(msg.msgtype);
  if (handler) return handler.extract(msg);
  return msg.msgtype ? `[${msg.msgtype}]` : "";
}

export async function enrichMessage(
  msg: SyncMsgItem,
  client: WecomKfClient,
  account: ResolvedWecomKfAccount
): Promise<EnrichedResult> {
  const handler = handlers.get(msg.msgtype);
  if (handler?.enrich) return handler.enrich(msg, client, account);
  return { text: extractContent(msg), mediaPaths: [] };
}
```

创建 `src/handlers/text.ts`:

```typescript
import { registerHandler } from "./registry.js";

registerHandler("text", {
  extract: (msg) => {
    if (msg.msgtype !== "text") return "";
    return msg.text?.content ?? "";
  },
});

registerHandler("msgmenu", {
  extract: (msg) => {
    if (msg.msgtype !== "msgmenu") return "[msgmenu]";
    const menu = (msg as any).msgmenu;
    const head = menu?.head_content ?? "";
    const items = (menu?.list ?? [])
      .map((item: any) => {
        if (item.type === "click") return item.click?.content ?? "";
        if (item.type === "view") return item.view?.content ?? "";
        if (item.type === "miniprogram") return item.miniprogram?.content ?? "";
        return "";
      })
      .filter(Boolean);
    return head ? `${head}\n${items.join("\n")}`.trim() : items.join("\n") || "[msgmenu]";
  },
});
```

创建 `src/handlers/media.ts`:

```typescript
import { registerHandler } from "./registry.js";
import { getMediaId } from "../types.js";
import { resolveInboundMediaEnabled, resolveInboundMediaMaxBytes } from "../config.js";

const MEDIA_TYPES = ["image", "voice", "video", "file"] as const;

for (const type of MEDIA_TYPES) {
  registerHandler(type, {
    extract: () => `[${type}]`,
    enrich: async (msg, client, account) => {
      const enabled = resolveInboundMediaEnabled(account.config);
      if (!enabled) return { text: `[${type}]`, mediaPaths: [] };
      const mediaId = getMediaId(msg);
      if (!mediaId) return { text: `[${type}]`, mediaPaths: [] };
      const maxBytes = resolveInboundMediaMaxBytes(account.config);
      try {
        const result = await client.downloadMedia(mediaId, { maxBytes, prefix: type });
        if (result.ok && result.path) {
          const finalPath = await client.finalizeInboundMedia(result.path);
          return { text: `[${type}] saved:${finalPath}`, mediaPaths: [finalPath] };
        }
        return { text: `[${type}] (save failed: ${result.error ?? ""})`.trim(), mediaPaths: [] };
      } catch (err) {
        return { text: `[${type}] (error: ${err instanceof Error ? err.message : String(err)})`, mediaPaths: [] };
      }
    },
  });
}
```

创建 `src/handlers/location.ts`:

```typescript
import { registerHandler } from "./registry.js";
import type { SyncMsgLocation, SyncMsgLink, SyncMsgBusinessCard, SyncMsgMiniprogram } from "../types.js";

registerHandler("location", {
  extract: (msg) => {
    if (msg.msgtype !== "location") return "[location]";
    const loc = (msg as SyncMsgLocation).location;
    const parts: string[] = [];
    if (loc?.latitude !== undefined && loc?.longitude !== undefined) parts.push(`${loc.latitude},${loc.longitude}`);
    if (loc?.name) parts.push(loc.name);
    if (loc?.address) parts.push(loc.address);
    return parts.length ? `[location] ${parts.join(" ")}` : "[location]";
  },
});

registerHandler("link", {
  extract: (msg) => {
    if (msg.msgtype !== "link") return "[link]";
    const link = (msg as SyncMsgLink).link;
    const title = link?.title ?? "";
    const url = link?.url ?? "";
    return url ? `[link] ${title} ${url}`.trim() : `[link] ${title}`.trim();
  },
});

registerHandler("business_card", {
  extract: (msg) => {
    if (msg.msgtype !== "business_card") return "[business_card]";
    return `[business_card] userid:${(msg as SyncMsgBusinessCard).business_card?.userid ?? ""}`;
  },
});

registerHandler("miniprogram", {
  extract: (msg) => {
    if (msg.msgtype !== "miniprogram") return "[miniprogram]";
    return `[miniprogram] ${(msg as SyncMsgMiniprogram).miniprogram?.title ?? ""}`.trim();
  },
});
```

创建 `src/handlers/event.ts`:

```typescript
import { registerHandler } from "./registry.js";
import type { SyncMsgEvent } from "../types.js";

registerHandler("event", {
  extract: (msg) => {
    if (msg.msgtype !== "event") return "[event]";
    const evt = (msg as SyncMsgEvent).event;
    return evt?.event_type ? `[event] ${evt.event_type}` : "[event]";
  },
  handle: async (msg, client, account, logger) => {
    if (msg.msgtype !== "event") return;
    const evt = (msg as SyncMsgEvent).event;
    const eventType = evt?.event_type ?? "";

    if (eventType === "enter_session") {
      const welcomeCode = evt?.welcome_code;
      const welcomeText = account.config.welcomeText?.trim();
      if (welcomeCode && welcomeText) {
        try {
          await client.sendOnEvent(welcomeCode, "text", { text: { content: welcomeText } });
          logger?.info(`welcome sent to ${msg.external_userid} via welcome_code`);
        } catch (err) {
          logger?.error(`failed to send welcome: ${String(err)}`);
        }
      }
      // Auto-transition to bot session (service_state=1)
      try {
        await client.transferSession(msg.open_kfid, msg.external_userid, 1);
        logger?.info(`session transitioned to bot for ${msg.external_userid}`);
      } catch (err) {
        // May fail if already in correct state — acceptable
        logger?.warn?.(`session transition failed (may be expected): ${String(err)}`);
      }
      return;
    }

    if (eventType === "msg_send_fail") {
      logger?.warn(`msg_send_fail: msgid=${evt?.fail_msgid}, fail_type=${evt?.fail_type}`);
      return;
    }

    if (eventType === "servicer_status_change" || eventType === "session_status_change") {
      logger?.info(`event: ${eventType} for ${msg.external_userid ?? "?"}`);
      return;
    }

    logger?.info(`unhandled KF event: ${eventType}`);
  },
});
```

**Step 4: 运行测试**

```bash
npx vitest run src/__tests__/handlers.test.ts
```

Expected: PASS

**Step 5: 构建验证**

```bash
npm run build
```

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: add message handler registry pattern"
```

---

## Task 4: 重写 webhook.ts — cursor 持久化 + 使用新模块

**Files:**
- Modify: `src/webhook.ts`

**目标:** 重写 webhook.ts 使用 WecomKfClient 和 handler 注册表，改进 cursor 持久化为同步写入。

**Step 1: 重写 webhook.ts**

保留核心 HTTP 处理逻辑（GET 验证 + POST 回调），但：
- 使用 `WecomKfClient` 替代裸 API 调用
- 使用 handler 注册表处理事件
- cursor 更新后立即 `await` 写入文件
- 导出 `handleWecomKfRoute` 新函数（用于 registerHttpRoute）
- 保留 `handleWecomKfWebhookRequest` 作为兼容层

**Step 2: 构建验证**

```bash
npm run build
```

**Step 3: Commit**

```bash
git add -A && git commit -m "refactor: rewrite webhook with WecomKfClient and sync cursor persistence"
```

---

## Task 5: 重写 dispatch.ts — 使用新模块

**Files:**
- Modify: `src/dispatch.ts`

**目标:** 使用 WecomKfClient 和 handler enrichMessage 替代原有逻辑。

**Step 1: 重写 dispatch.ts**

- 使用 `enrichMessage()` 替代 `enrichInboundWithMedia()`
- 使用 `client.sendText()` 替代 `sendKfTextMessage()`
- 使用 `client.pruneInboundMedia()` 替代手动 cleanup

**Step 2: 构建验证**

```bash
npm run build
```

**Step 3: Commit**

```bash
git add -A && git commit -m "refactor: dispatch uses WecomKfClient and handler registry"
```

---

## Task 6: 更新 channel.ts 和 send.ts — 使用 WecomKfClient

**Files:**
- Modify: `src/channel.ts`
- Modify: `src/send.ts`

**目标:** outbound 发送统一走 WecomKfClient。消除 channel.ts 中的 configSchema 重复。

**Step 1: 更新 channel.ts**

- outbound.sendText/sendMedia 使用 `WecomKfClient`
- 移除内联的 `WecomKfConfigJsonSchema`，改为从 `openclaw.plugin.json` 运行时读取或引用 types 中的定义

**Step 2: 更新 send.ts**

- `sendWecomKfDM` 使用 `WecomKfClient`

**Step 3: 构建验证**

```bash
npm run build
```

**Step 4: Commit**

```bash
git add -A && git commit -m "refactor: channel and send use WecomKfClient"
```

---

## Task 7: 更新 index.ts — 迁移到 registerHttpRoute

**Files:**
- Modify: `src/index.ts`

**Step 1: 更新插件注册**

```typescript
register(api: OpenClawPluginApi) {
  if (api.runtime) setWecomKfRuntime(api.runtime as any);
  api.registerChannel({ plugin: wecomKfPlugin });

  // Prefer new API, fallback to legacy
  if (api.registerHttpRoute) {
    api.registerHttpRoute({
      path: "/wecom-kf",
      auth: "none",
      match: "prefix",
      handler: handleWecomKfRoute,
    });
  } else if (api.registerHttpHandler) {
    api.registerHttpHandler(handleWecomKfWebhookRequest);
  }
}
```

**Step 2: 更新 re-exports — 移除旧模块导出，添加新模块**

**Step 3: 删除旧的 api.ts 和 bot.ts（功能已迁移到 client.ts 和 handlers/）**

**Step 4: 构建验证**

```bash
npm run build
```

**Step 5: 全部测试通过**

```bash
npx vitest run
```

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: migrate to registerHttpRoute, remove legacy modules"
```

---

## Task 8: 更新 package.json 和 openclaw.plugin.json

**Files:**
- Modify: `package.json`
- Modify: `openclaw.plugin.json`

**Step 1: 版本号升至 0.3.0**

**Step 2: peerDependencies 从 moltbot 改为 openclaw**

```json
"peerDependencies": {
  "openclaw": ">=2026.1.0"
}
```

**Step 3: 移除 package.json 中的 `moltbot` 字段（保留 `openclaw` 字段）**

**Step 4: 更新 README.md 安装说明**

**Step 5: Commit**

```bash
git add -A && git commit -m "chore: bump to 0.3.0, update to openclaw peer dependency"
```

---

## Task 9: 最终验证

**Step 1: 全量构建**

```bash
npm run build
```

**Step 2: 全量测试**

```bash
npx vitest run
```

**Step 3: 检查 dist 产物**

```bash
ls -la dist/
```

确认 `dist/index.js` 存在且包含所有新模块。

**Step 4: 最终 Commit**

```bash
git add -A && git commit -m "chore: final verification after refactor"
```
