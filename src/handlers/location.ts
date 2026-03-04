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
