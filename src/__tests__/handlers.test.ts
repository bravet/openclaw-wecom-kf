import { describe, it, expect } from "vitest";
import { getHandler, extractContent } from "../handlers/registry.js";
import type { SyncMsgText, SyncMsgImage, SyncMsgLocation } from "../types.js";

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
