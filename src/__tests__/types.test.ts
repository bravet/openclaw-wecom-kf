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
