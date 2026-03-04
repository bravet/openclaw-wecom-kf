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

describe("WecomKfClient account management", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    WecomKfClient.clearAllTokenCache();
  });

  it("addAccount sends correct request", async () => {
    const account = makeAccount();
    const client = new WecomKfClient(account);
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, access_token: "tok" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, open_kfid: "wkABCD" })));

    const result = await client.addAccount("Test KF");
    expect(result.open_kfid).toBe("wkABCD");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("listAccounts returns account list", async () => {
    const account = makeAccount();
    const client = new WecomKfClient(account);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, access_token: "tok" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errcode: 0,
        account_list: [{ open_kfid: "wk1", name: "KF1" }],
      })));

    const result = await client.listAccounts();
    expect(result.account_list).toHaveLength(1);
    expect(result.account_list[0].name).toBe("KF1");
  });

  it("getContactWay returns url", async () => {
    const account = makeAccount();
    const client = new WecomKfClient(account);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, access_token: "tok" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, url: "https://work.weixin.qq.com/kf/xxx" })));

    const result = await client.getContactWay("wk1");
    expect(result.url).toContain("work.weixin.qq.com");
  });
});

describe("WecomKfClient servicer management", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    WecomKfClient.clearAllTokenCache();
  });

  it("addServicer sends correct request", async () => {
    const account = makeAccount();
    const client = new WecomKfClient(account);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, access_token: "tok" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errcode: 0,
        result_list: [{ userid: "user1", errcode: 0, errmsg: "ok" }],
      })));

    const results = await client.addServicer("wk1", ["user1"]);
    expect(results).toHaveLength(1);
    expect(results[0].userid).toBe("user1");
  });

  it("listServicer returns list", async () => {
    const account = makeAccount();
    const client = new WecomKfClient(account);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, access_token: "tok" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errcode: 0,
        servicer_list: [{ userid: "user1", status: 0 }],
      })));

    const list = await client.listServicer("wk1");
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe(0);
  });
});
