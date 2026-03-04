import { describe, it, expect, vi, beforeEach } from "vitest";
import { WecomKfClient } from "../client.js";
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

  it("throws if corpId missing", () => {
    const account = makeAccount({ corpId: undefined });
    const client = new WecomKfClient(account);
    expect(client.getAccessToken()).rejects.toThrow("corpId");
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
