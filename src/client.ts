/**
 * 微信客服统一 API 客户端
 *
 * 核心设计原则：
 * - 无黑盒假死：所有 API 调用有超时（默认 15s），超时后抛明确错误
 * - 所有调用有反馈：不吞异常，所有错误路径记录日志
 * - 自动 token 刷新重试：40014/42001/42009 错误时清缓存重试一次
 * - 调试模式：debug=true 时打印请求/响应详情
 */

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
      throw new WecomKfApiError(
        "corpId or corpSecret not configured",
        "CONFIG_ERROR", "gettoken"
      );
    }
    const cacheKey = `${this.account.corpId}:kf`;
    if (!forceRefresh) {
      const cached = WecomKfClient.tokenCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        return cached.token;
      }
    }
    const url = `${this.apiBaseUrl}/cgi-bin/gettoken?corpid=${encodeURIComponent(this.account.corpId)}&corpsecret=${encodeURIComponent(this.account.corpSecret)}`;
    const startMs = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      const data = (await resp.json()) as { errcode?: number; errmsg?: string; access_token?: string };
      const elapsedMs = Date.now() - startMs;
      this.logger.debug(`← gettoken ${elapsedMs}ms errcode=${data.errcode ?? 0}`);
      if (data.errcode && data.errcode !== 0) {
        throw new WecomKfApiError(
          `gettoken failed: ${data.errmsg ?? "unknown"} (errcode=${data.errcode})`,
          "TOKEN_ERROR", "gettoken", data.errcode, data.errmsg, elapsedMs
        );
      }
      if (!data.access_token) {
        throw new WecomKfApiError(
          "gettoken returned empty access_token",
          "TOKEN_ERROR", "gettoken", undefined, undefined, elapsedMs
        );
      }
      WecomKfClient.tokenCache.set(cacheKey, {
        token: data.access_token,
        expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
      });
      return data.access_token;
    } catch (err) {
      if (err instanceof WecomKfApiError) throw err;
      const elapsedMs = Date.now() - startMs;
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new WecomKfApiError(
          `gettoken timeout after ${this.timeoutMs}ms`, "TIMEOUT", "gettoken", undefined, undefined, elapsedMs
        );
      }
      throw new WecomKfApiError(
        `gettoken network error: ${err instanceof Error ? err.message : String(err)}`,
        "NETWORK", "gettoken", undefined, undefined, elapsedMs
      );
    } finally {
      clearTimeout(timer);
    }
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
    const startMs = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body,
        signal: controller.signal,
      });
      const data = (await resp.json()) as { errcode?: number; errmsg?: string; media_id?: string };
      const elapsedMs = Date.now() - startMs;
      if (data.errcode && data.errcode !== 0) {
        throw new WecomKfApiError(
          `media upload failed: ${data.errmsg ?? "unknown"} (errcode=${data.errcode})`,
          "API_ERROR", "/cgi-bin/media/upload", data.errcode, data.errmsg, elapsedMs
        );
      }
      if (!data.media_id) {
        throw new WecomKfApiError(
          "media upload returned empty media_id",
          "API_ERROR", "/cgi-bin/media/upload", undefined, undefined, elapsedMs
        );
      }
      return data.media_id;
    } catch (err) {
      if (err instanceof WecomKfApiError) throw err;
      const elapsedMs = Date.now() - startMs;
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new WecomKfApiError(
          `media upload timeout after ${this.timeoutMs}ms`, "TIMEOUT", "/cgi-bin/media/upload", undefined, undefined, elapsedMs
        );
      }
      throw new WecomKfApiError(
        `media upload network error: ${err instanceof Error ? err.message : String(err)}`,
        "NETWORK", "/cgi-bin/media/upload", undefined, undefined, elapsedMs
      );
    } finally {
      clearTimeout(timer);
    }
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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const resp = await fetch(url, { signal: controller.signal });
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
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.logger.error(`downloadMedia failed: ${err instanceof Error ? err.message : String(err)}`);
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
    } catch (err) {
      this.logger.error(`finalizeInboundMedia rename failed: ${String(err)}`);
      try { await unlink(p); } catch { /* ignore cleanup failure */ }
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
        } catch (err) {
          this.logger.error(`pruneInboundMedia failed to unlink ${fp}: ${String(err)}`);
        }
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
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "\u3010$1\u3011");
  result = result.replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1")
    .replace(/__(.*?)__/g, "$1").replace(/(?<![\w/])_(.+?)_(?![\w/])/g, "$1");
  result = result.replace(/^[-*]\s+/gm, "\u00b7 ");
  result = result.replace(/^(\d+)\.\s+/gm, "$1. ");
  result = result.replace(/`([^`]+)`/g, "$1");
  result = result.replace(/~~(.*?)~~/g, "$1");
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, "[\u56fe\u7247: $1]");
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
  result = result.replace(/^[-*_]{3,}$/gm, "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
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
