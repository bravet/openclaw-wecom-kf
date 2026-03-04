/**
 * openclaw-wecom-kf
 * 微信客服渠道插件入口
 *
 * 导出:
 * - wecomKfPlugin: ChannelPlugin 实现
 * - WecomKfClient: 统一 API 客户端
 * - DEFAULT_ACCOUNT_ID: 默认账户 ID
 * - setWecomKfRuntime / getWecomKfRuntime: 运行时管理
 * - sendWecomKfDM: 发送私聊消息
 * - stripMarkdown: Markdown 转纯文本
 */

import type { OpenClawPluginApi } from "./types.js";
import { wecomKfPlugin } from "./channel.js";
import { setWecomKfRuntime } from "./runtime.js";
import { handleWecomKfWebhookRequest, handleWecomKfRoute } from "./webhook.js";

// ─── Config & Runtime ────────────────────────────────────────
export { DEFAULT_ACCOUNT_ID, resolveAccount, listAccountIds } from "./config.js";
export { setWecomKfRuntime, getWecomKfRuntime, tryGetWecomKfRuntime } from "./runtime.js";

// ─── Channel & Send ──────────────────────────────────────────
export { wecomKfPlugin } from "./channel.js";
export { sendWecomKfDM } from "./send.js";

// ─── Client (new unified API) ────────────────────────────────
export { WecomKfClient, WecomKfApiError, stripMarkdown, splitMessageByBytes } from "./client.js";

// ─── Handler Registry ────────────────────────────────────────
export { registerHandler, getHandler, extractContent, enrichMessage } from "./handlers/registry.js";

// ─── Webhook ─────────────────────────────────────────────────
export { handleWecomKfWebhookRequest, handleWecomKfRoute, registerWebhookTarget } from "./webhook.js";

// ─── Legacy API (deprecated — use WecomKfClient instead) ─────
export {
  getAccessToken,
  clearAccessTokenCache,
  clearAllAccessTokenCache,
  sendKfMessage,
  sendKfTextMessage,
  sendKfWelcomeMessage,
  syncMessages,
} from "./api.js";

// ─── Types ───────────────────────────────────────────────────
export type {
  WecomKfConfig,
  WecomKfAccountConfig,
  ResolvedWecomKfAccount,
  PluginConfig,
  OpenClawPluginApi,
  MoltbotPluginApi,
  SyncMsgItem,
  SyncMsgResponse,
  KfSendMsgParams,
  KfSendMsgResult,
  WecomKfDmPolicy,
  HttpRouteContext,
  SessionState,
  CustomerInfo,
  MediaType,
  DownloadResult,
} from "./types.js";

// ─── Plugin Entry ───────────────────────────────────────────

const plugin = {
  id: "openclaw-wecom-kf",
  name: "WeCom KF",
  description: "微信客服渠道插件，支持外部微信用户通过客服系统与 AI 交互",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  register(api: OpenClawPluginApi) {
    if (api.runtime) {
      setWecomKfRuntime(api.runtime as any);
    }
    api.registerChannel({ plugin: wecomKfPlugin });

    // Prefer new registerHttpRoute API, fallback to legacy
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
  },
};

export default plugin;
