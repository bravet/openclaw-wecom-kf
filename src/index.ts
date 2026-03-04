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

import type { OpenClawPluginApi, PluginConfig } from "./types.js";
import type { IncomingMessage, ServerResponse } from "http";
import { wecomKfPlugin } from "./channel.js";
import { setWecomKfRuntime } from "./runtime.js";
import { handleWecomKfRoute } from "./webhook.js";

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
export { handleWecomKfRoute, registerWebhookTarget } from "./webhook.js";

// ─── Types ───────────────────────────────────────────────────
export type {
  WecomKfConfig,
  WecomKfAccountConfig,
  ResolvedWecomKfAccount,
  PluginConfig,
  OpenClawPluginApi,
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
  KfAccountInfo,
  ServicerInfo,
  ServicerResult,
  OutboundLink,
  OutboundMiniprogram,
  OutboundMsgMenu,
  OutboundLocation,
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

    // Register HTTP routes for webhook
    if (api.registerHttpRoute) {
      // Adapter: framework calls handler(req, res), we construct HttpRouteContext
      const routeHandler = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
        const url = new URL(req.url ?? "/", "http://localhost");
        await handleWecomKfRoute({
          req,
          res,
          path: url.pathname,
          query: url.searchParams,
        });
        // Return true if response was sent (headers sent or stream ended)
        return res.writableEnded || res.headersSent;
      };

      // Collect all webhook paths from config
      const paths = new Set<string>();
      paths.add("/wecom-kf"); // default fallback
      const cfg = api.config as PluginConfig | undefined;
      const kfCfg = cfg?.channels?.["wecom-kf"];
      if (kfCfg?.webhookPath) paths.add(kfCfg.webhookPath);
      if (kfCfg?.accounts) {
        for (const acc of Object.values(kfCfg.accounts)) {
          if (acc?.webhookPath) paths.add(acc.webhookPath);
        }
      }

      // Register each path as an exact-match route with plugin-level auth
      for (const p of paths) {
        api.registerHttpRoute({
          path: p,
          auth: "plugin",
          match: "exact",
          handler: routeHandler,
        });
      }
    }
  },
};

export default plugin;
