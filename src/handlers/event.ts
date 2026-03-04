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
        logger?.warn(`session transition failed (may be expected): ${String(err)}`);
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
