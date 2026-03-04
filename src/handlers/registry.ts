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
