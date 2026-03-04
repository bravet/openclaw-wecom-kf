import { describe, it, expect, vi } from "vitest";
import { getHandler, extractContent } from "../handlers/registry.js";
import type { SyncMsgText, SyncMsgImage, SyncMsgLocation, SyncMsgEvent } from "../types.js";

// Import all handlers to trigger registration
import "../handlers/text.js";
import "../handlers/media.js";
import "../handlers/location.js";
import "../handlers/event.js";

const BASE = { msgid: "1", open_kfid: "wk1", external_userid: "u1", send_time: 1000, origin: 3 };

describe("handler registry", () => {
  it("has text handler", () => {
    expect(getHandler("text")).toBeDefined();
  });
  it("has media handlers", () => {
    expect(getHandler("image")).toBeDefined();
    expect(getHandler("voice")).toBeDefined();
    expect(getHandler("video")).toBeDefined();
    expect(getHandler("file")).toBeDefined();
  });
  it("has location handler", () => {
    expect(getHandler("location")).toBeDefined();
  });
  it("has event handler", () => {
    expect(getHandler("event")).toBeDefined();
  });
});

describe("extractContent", () => {
  it("extracts text content", () => {
    const msg: SyncMsgText = { ...BASE, msgtype: "text", text: { content: "hello" } };
    expect(extractContent(msg)).toBe("hello");
  });
  it("extracts image placeholder", () => {
    const msg: SyncMsgImage = { ...BASE, msgtype: "image", image: { media_id: "mid1" } };
    expect(extractContent(msg)).toBe("[image]");
  });
  it("extracts location with coords", () => {
    const msg: SyncMsgLocation = {
      ...BASE, msgtype: "location",
      location: { latitude: 31.23, longitude: 121.47, name: "Shanghai" },
    };
    expect(extractContent(msg)).toContain("31.23");
    expect(extractContent(msg)).toContain("Shanghai");
  });
  it("returns [msgtype] for unknown types", () => {
    const msg = { ...BASE, msgtype: "unknown_type" } as any;
    expect(extractContent(msg)).toBe("[unknown_type]");
  });
});

describe("event handler", () => {
  const handler = getHandler("event")!;

  it("extracts event type from event message", () => {
    const msg: SyncMsgEvent = {
      ...BASE,
      msgtype: "event",
      event: { event_type: "enter_session", welcome_code: "wc1" },
    };
    expect(handler.extract(msg)).toBe("[event] enter_session");
  });

  it("handles enter_session with welcome text", async () => {
    const mockClient = {
      sendOnEvent: vi.fn().mockResolvedValue({ errcode: 0 }),
      transferSession: vi.fn().mockResolvedValue(undefined),
    };
    const mockAccount = { config: { welcomeText: "Welcome!" } } as any;
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const msg: SyncMsgEvent = {
      ...BASE,
      msgtype: "event",
      event: { event_type: "enter_session", welcome_code: "wc123" },
    };

    await handler.handle!(msg, mockClient as any, mockAccount, mockLogger);

    expect(mockClient.sendOnEvent).toHaveBeenCalledWith("wc123", "text", {
      text: { content: "Welcome!" },
    });
    expect(mockClient.transferSession).toHaveBeenCalledWith("wk1", "u1", 1);
  });

  it("handles msg_send_fail event", async () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const msg: SyncMsgEvent = {
      ...BASE,
      msgtype: "event",
      event: { event_type: "msg_send_fail", fail_msgid: "mid1", fail_type: 1 },
    };

    await handler.handle!(msg, {} as any, {} as any, mockLogger);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("msg_send_fail")
    );
  });

  it("handles recall_msg event", async () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const msg: SyncMsgEvent = {
      ...BASE,
      msgtype: "event",
      event: { event_type: "recall_msg", recall_msgid: "mid_recalled" },
    };

    await handler.handle!(msg, {} as any, {} as any, mockLogger);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("recall_msg")
    );
  });
});
