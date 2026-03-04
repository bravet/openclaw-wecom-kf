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
import { WecomKfClient, stripMarkdown } from "./client.js";
import { enrichMessage } from "./handlers/registry.js";

// ─── Progressive Send ────────────────────────────────────────
// Split text into paragraph-level segments and send each as a
// separate WeChat message with a human-paced delay in between,
// so the user sees the reply appear incrementally.

const PARAGRAPH_DELAY_MS = 800;

function splitIntoParagraphs(text: string): string[] {
  // Split on double newlines (paragraph boundaries)
  const raw = text.split(/\n{2,}/);
  const segments: string[] = [];
  let buf = "";
  for (const para of raw) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    const next = buf ? `${buf}\n\n${trimmed}` : trimmed;
    // Keep segments ≤ 800 chars so each WeChat message is short
    if (Buffer.byteLength(next, "utf8") > 800 && buf) {
      segments.push(buf);
      buf = trimmed;
    } else {
      buf = next;
    }
  }
  if (buf) segments.push(buf);
  return segments.length > 0 ? segments : [text.trim()];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  // ─── Deferred thinking text ────────────────────────────────
  // Only send the "thinking" acknowledgment if AI takes longer than
  // THINKING_DELAY_MS to produce the first reply chunk. Once the first
  // chunk arrives, the timer is cancelled so the user never sees a
  // redundant "thinking" message before the actual answer.
  const THINKING_DELAY_MS = 3000;
  const thinkingText = accountConfig.thinkingText ?? "收到，让我想想...";
  let thinkingSent = false;
  let firstChunkDelivered = false;
  let thinkingTimer: ReturnType<typeof setTimeout> | undefined;

  if (thinkingText && account.canSendActive && openKfId) {
    thinkingTimer = setTimeout(async () => {
      if (firstChunkDelivered) return; // AI already responded, skip
      try {
        await client.sendMessage({
          touser: senderId,
          open_kfid: openKfId,
          msgtype: "text",
          text: { content: thinkingText },
        });
        thinkingSent = true;
      } catch (err) {
        logger.warn(`thinking message failed: ${String(err)}`);
      }
    }, THINKING_DELAY_MS);
  }

  // ─── Dispatch reply via framework ──────────────────────────
  let chunksSent = 0;
  const startMs = Date.now();

  await channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: safeCfg,
    dispatcherOptions: {
      deliver: async (payload, info) => {
        const rawText = payload.text ?? "";
        logger.debug(
          `deliver called: kind=${(info as any)?.kind ?? "?"} textLen=${rawText.length} chunk#${chunksSent + 1}`
        );
        if (!rawText.trim()) return;
        if (!account.canSendActive || !openKfId) return;

        // Cancel deferred thinking on first real content
        if (!firstChunkDelivered) {
          firstChunkDelivered = true;
          if (thinkingTimer) {
            clearTimeout(thinkingTimer);
            thinkingTimer = undefined;
          }
        }

        // Progressive send: split into paragraphs and send each
        // as a separate message with a short delay in between.
        const plain = stripMarkdown(rawText);
        const segments = splitIntoParagraphs(plain);

        for (let i = 0; i < segments.length; i++) {
          if (i > 0) await sleep(PARAGRAPH_DELAY_MS);
          try {
            const result = await client.sendMessage({
              touser: senderId,
              open_kfid: openKfId,
              msgtype: "text",
              text: { content: segments[i]! },
            });
            if (result.errcode === 0) {
              chunksSent++;
            } else {
              logger.error(`reply chunk failed: errcode=${result.errcode} ${result.errmsg ?? ""}`);
              break;
            }
          } catch (err) {
            logger.error(`reply chunk failed: ${String(err)}`);
            break;
          }
        }
      },
      onError: (err, info) => {
        logger.error(`${info.kind} reply error: ${String(err)}`);
      },
    },
  });

  // Clean up thinking timer if still pending
  if (thinkingTimer) {
    clearTimeout(thinkingTimer);
    thinkingTimer = undefined;
  }

  const elapsedMs = Date.now() - startMs;
  logger.info(
    `reply to ${senderId}: ${chunksSent} chunks in ${elapsedMs}ms` +
    (thinkingSent ? " (thinking msg sent)" : "")
  );

  // ─── Fallback: no reply produced ──────────────────────────
  if (chunksSent === 0 && account.canSendActive && openKfId && !thinkingSent) {
    // AI produced no visible output; send a minimal acknowledgment
    // so the user doesn't stare at silence.
    try {
      await client.sendMessage({
        touser: senderId,
        open_kfid: openKfId,
        msgtype: "text",
        text: { content: "暂时无法回复，请稍后再试。" },
      });
    } catch (err) {
      logger.warn(`fallback message failed: ${String(err)}`);
    }
  }

  // Prune old media files (non-blocking)
  client.pruneInboundMedia().catch((err) => {
    logger.warn(`media prune failed: ${String(err)}`);
  });
}
