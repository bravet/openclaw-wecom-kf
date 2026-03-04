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
