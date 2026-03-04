/**
 * 微信客服消息分发到 OpenClaw 运行时
 *
 * 构建 inbound context → resolveAgentRoute → dispatchReplyWithBufferedBlockDispatcher
 * 响应通过 WecomKfClient.sendText 发送回客户。
 */

import type {
  PluginConfig,
  PluginRuntime,
  ResolvedWecomKfAccount,
  SyncMsgItem,
} from "./types.js";
import { resolveDmPolicy, resolveAllowFrom, checkDmPolicy } from "./config.js";
import { WecomKfClient } from "./client.js";
import { enrichMessage } from "./handlers/registry.js";

// Import all handlers to trigger registration
import "./handlers/text.js";
import "./handlers/media.js";
import "./handlers/location.js";
import "./handlers/event.js";

// ─── Local Logger ───────────────────────────────────────────

function createLocalLogger(prefix: string, fns: { log?: (m: string) => void; error?: (m: string) => void }) {
  const logFn = fns.log ?? console.log;
  const errFn = fns.error ?? console.error;
  return {
    debug: (m: string) => logFn(`[${prefix}] [DEBUG] ${m}`),
    info: (m: string) => logFn(`[${prefix}] ${m}`),
    warn: (m: string) => logFn(`[${prefix}] [WARN] ${m}`),
    error: (m: string) => errFn(`[${prefix}] [ERROR] ${m}`),
  };
}

export async function dispatchKfMessage(params: {
  cfg: PluginConfig;
  account: ResolvedWecomKfAccount;
  msg: SyncMsgItem;
  core: PluginRuntime;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}): Promise<void> {
  const { cfg, account, msg, core } = params;
  const safeCfg = cfg ?? {};
  const logger = createLocalLogger("wecom-kf", {
    log: params.log,
    error: params.error,
  });

  const senderId = msg.external_userid ?? "unknown";
  const msgOpenKfId = msg.open_kfid;
  const accountConfig = account.config;
  const dmPolicy = resolveDmPolicy(accountConfig);
  const allowFrom = resolveAllowFrom(accountConfig);
  const policyResult = checkDmPolicy({ dmPolicy, senderId, allowFrom });

  if (!policyResult.allowed) {
    logger.debug(`policy rejected: ${policyResult.reason}`);
    return;
  }

  const channel = core.channel;
  if (
    !channel?.routing?.resolveAgentRoute ||
    !channel.reply?.dispatchReplyWithBufferedBlockDispatcher
  ) {
    logger.debug(
      "core routing or buffered dispatcher missing, skipping dispatch"
    );
    return;
  }

  const route = channel.routing.resolveAgentRoute({
    cfg: safeCfg,
    channel: "wecom-kf",
    accountId: account.accountId,
    peer: { kind: "dm", id: senderId },
  });

  // Create client for API operations
  const client = new WecomKfClient(account, {
    log: params.log,
    error: params.error,
  });

  // Enrich message content with media (using handler registry)
  const enriched = await enrichMessage(msg, client, account);
  const rawBody = enriched.text;

  const fromLabel = `user:${senderId}`;

  // Session handling
  const storePath = channel.session?.resolveStorePath?.(
    (safeCfg as any).session?.store,
    { agentId: route.agentId }
  );
  const previousTimestamp = channel.session?.readSessionUpdatedAt
    ? (channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
      }) ?? undefined)
    : undefined;

  // Format agent envelope
  const envelopeOptions = channel.reply?.resolveEnvelopeFormatOptions
    ? channel.reply.resolveEnvelopeFormatOptions(safeCfg)
    : undefined;
  const body = channel.reply?.formatAgentEnvelope
    ? channel.reply.formatAgentEnvelope({
        channel: "WeCom KF",
        from: fromLabel,
        previousTimestamp,
        envelope: envelopeOptions,
        body: rawBody,
      })
    : rawBody;

  const from = `wecom-kf:user:${senderId}`;
  const to = `user:${senderId}`;
  const msgid = msg.msgid;

  // Build inbound context
  const ctxPayload: Record<string, unknown> = channel.reply?.finalizeInboundContext
    ? (channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: from,
        To: to,
        SessionKey: route.sessionKey,
        AccountId: route.accountId ?? account.accountId,
        ChatType: "direct",
        ConversationLabel: fromLabel,
        SenderName: senderId,
        SenderId: senderId,
        Provider: "wecom-kf",
        Surface: "wecom-kf",
        MessageSid: msgid,
        OriginatingChannel: "wecom-kf",
        OriginatingTo: to,
      }) as Record<string, unknown>)
    : {
        Body: body,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: from,
        To: to,
        SessionKey: route.sessionKey,
        AccountId: route.accountId ?? account.accountId,
        ChatType: "direct",
        ConversationLabel: fromLabel,
        SenderName: senderId,
        SenderId: senderId,
        Provider: "wecom-kf",
        Surface: "wecom-kf",
        MessageSid: msgid,
        OriginatingChannel: "wecom-kf",
        OriginatingTo: to,
      };

  // Stabilize To field
  const ctxTo =
    typeof ctxPayload.To === "string" && (ctxPayload.To as string).trim()
      ? (ctxPayload.To as string).trim()
      : undefined;
  const ctxOriginatingTo =
    typeof ctxPayload.OriginatingTo === "string" &&
    (ctxPayload.OriginatingTo as string).trim()
      ? (ctxPayload.OriginatingTo as string).trim()
      : undefined;
  const stableTo = ctxOriginatingTo ?? ctxTo ?? to;
  ctxPayload.To = stableTo;
  ctxPayload.OriginatingTo = stableTo;
  ctxPayload.SenderId = senderId;
  ctxPayload.SenderName = senderId;
  ctxPayload.ConversationLabel = fromLabel;
  ctxPayload.CommandAuthorized = true;

  // Record session
  if (channel.session?.recordInboundSession && storePath) {
    const mainSessionKey =
      typeof (route as any).mainSessionKey === "string" &&
      (route as any).mainSessionKey.trim()
        ? (route as any).mainSessionKey
        : undefined;
    const updateLastRoute = {
      sessionKey: mainSessionKey ?? route.sessionKey,
      channel: "wecom-kf",
      to: stableTo,
      accountId: route.accountId ?? account.accountId,
    };
    const recordSessionKey =
      typeof ctxPayload.SessionKey === "string" &&
      (ctxPayload.SessionKey as string).trim()
        ? (ctxPayload.SessionKey as string)
        : route.sessionKey;
    await channel.session.recordInboundSession({
      storePath,
      sessionKey: recordSessionKey,
      ctx: ctxPayload,
      updateLastRoute,
      onRecordError: (err) => {
        logger.error(
          `wecom-kf: failed updating session meta: ${String(err)}`
        );
      },
    });
  }

  // Resolve openKfId for reply
  const openKfId = msgOpenKfId ?? account.openKfId;

  // ─── Immediate acknowledgment ──────────────────────────────
  const thinkingText = accountConfig.thinkingText ?? "收到，让我想想...";
  if (thinkingText && account.canSendActive && openKfId) {
    try {
      await client.sendMessage({
        touser: senderId,
        open_kfid: openKfId,
        msgtype: "text",
        text: { content: thinkingText },
      });
    } catch (err) {
      logger.warn(`ack message failed: ${String(err)}`);
    }
  }

  // ─── Stream reply chunks ───────────────────────────────────
  let chunksSent = 0;
  const startMs = Date.now();

  await channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: safeCfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        const rawText = payload.text ?? "";
        if (!rawText.trim()) return;
        if (!account.canSendActive || !openKfId) return;
        try {
          const result = await client.sendText(senderId, rawText, openKfId);
          if (result.errcode === 0) {
            chunksSent += result.sentChunks;
          } else {
            logger.error(`stream chunk failed: errcode=${result.errcode} ${result.errmsg ?? ""}`);
          }
        } catch (err) {
          logger.error(`stream chunk failed: ${String(err)}`);
        }
      },
      onError: (err, info) => {
        logger.error(`${info.kind} reply failed: ${String(err)}`);
      },
    },
  });

  const elapsedMs = Date.now() - startMs;
  if (chunksSent > 0) {
    logger.info(`streaming reply to ${senderId}: ${chunksSent} chunks in ${elapsedMs}ms`);
  }

  // Prune old media files (non-blocking)
  client.pruneInboundMedia().catch((err) => {
    logger.warn(`media prune failed: ${String(err)}`);
  });
}
