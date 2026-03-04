import { describe, it, expect, vi, beforeEach } from "vitest";
import { WecomKfClient, stripMarkdown, splitMessageByBytes } from "../client.js";
import type { ResolvedWecomKfAccount } from "../types.js";

function makeAccount(overrides?: Partial<ResolvedWecomKfAccount>): ResolvedWecomKfAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    corpId: "ww_test",
    corpSecret: "secret_test",
    openKfId: "wk_test",
    canSendActive: true,
    config: {},
    ...overrides,
  };
}

describe("WecomKfClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    WecomKfClient.clearAllTokenCache();
  });

  it("throws if corpId missing", async () => {
    const account = makeAccount({ corpId: undefined });
    const client = new WecomKfClient(account);
    await expect(client.getAccessToken()).rejects.toThrow("corpId");
  });

  it("caches token within TTL", async () => {
    const account = makeAccount();
    const client = new WecomKfClient(account);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ errcode: 0, access_token: "tok_1", expires_in: 7200 }))
    );
    const tok1 = await client.getAccessToken();
    const tok2 = await client.getAccessToken();
    expect(tok1).toBe("tok_1");
    expect(tok2).toBe("tok_1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries on expired token error", async () => {
    const account = makeAccount();
    const client = new WecomKfClient(account);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, access_token: "tok_old" })))
      // sync_msg with old token: 42001 expired
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 42001, errmsg: "access_token expired" })))
      // refresh token
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, access_token: "tok_new" })))
      // retry sync_msg: success
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, next_cursor: "c1", has_more: 0, msg_list: [] })));

    const result = await client.syncMessages({ limit: 10 });
    expect(result.errcode).toBe(0);
  });
});

describe("WecomKfClient typed send helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    WecomKfClient.clearAllTokenCache();
  });

  it("sendImage calls sendMessage with correct params", async () => {
    const client = new WecomKfClient(makeAccount());
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, access_token: "tok" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, msgid: "m1" })));

    const result = await client.sendImage("user1", "media_abc", "wk1");
    expect(result.errcode).toBe(0);
    expect(result.msgid).toBe("m1");
  });

  it("sendLink calls sendMessage with link payload", async () => {
    const client = new WecomKfClient(makeAccount());
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, access_token: "tok" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, msgid: "m2" })));

    const result = await client.sendLink(
      "user1",
      { title: "Test", url: "https://example.com" },
      "wk1"
    );
    expect(result.errcode).toBe(0);
  });

  it("sendMsgMenu calls sendMessage with menu payload", async () => {
    const client = new WecomKfClient(makeAccount());
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, access_token: "tok" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, msgid: "m3" })));

    const result = await client.sendMsgMenu(
      "user1",
      {
        head_content: "Please choose:",
        list: [{ type: "click", click: { id: "1", content: "Option A" } }],
      },
      "wk1"
    );
    expect(result.errcode).toBe(0);
  });
});

describe("stripMarkdown", () => {
  it("strips bold markers", () => {
    expect(stripMarkdown("**bold**")).toBe("bold");
  });
  it("strips italic markers", () => {
    expect(stripMarkdown("*italic*")).toBe("italic");
  });
  it("converts headings to brackets", () => {
    expect(stripMarkdown("## Title")).toBe("\u3010Title\u3011");
  });
  it("converts links to text with URL", () => {
    expect(stripMarkdown("[Click](https://example.com)")).toBe("Click (https://example.com)");
  });
  it("strips code fences", () => {
    const input = "```js\nconsole.log(1);\n```";
    const result = stripMarkdown(input);
    expect(result).toContain("console.log(1);");
    expect(result).not.toContain("```");
  });
  it("strips inline code", () => {
    expect(stripMarkdown("`code`")).toBe("code");
  });
});

describe("splitMessageByBytes", () => {
  it("returns single chunk for short message", () => {
    const chunks = splitMessageByBytes("hello", 2048);
    expect(chunks).toEqual(["hello"]);
  });
  it("splits long message into chunks", () => {
    const longText = "a".repeat(3000);
    const chunks = splitMessageByBytes(longText, 2048);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toHaveLength(2048);
    expect(chunks[1]).toHaveLength(952);
  });
  it("handles CJK characters correctly (3 bytes each)", () => {
    // Each CJK char is 3 bytes in UTF-8
    const text = "中".repeat(700); // 2100 bytes
    const chunks = splitMessageByBytes(text, 2048);
    expect(chunks.length).toBe(2);
    // First chunk should fit 682 chars (682*3=2046, 683*3=2049 would exceed)
    expect(Buffer.byteLength(chunks[0], "utf8")).toBeLessThanOrEqual(2048);
  });
});
