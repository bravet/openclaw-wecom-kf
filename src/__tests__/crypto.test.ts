import { describe, it, expect } from "vitest";
import {
  computeWecomMsgSignature,
  verifyWecomSignature,
  decryptWecomEncrypted,
  encryptWecomPlaintext,
} from "../crypto.js";

// A valid 43-character base64 key that decodes to 32 bytes
const TEST_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

describe("crypto: signature", () => {
  it("computeWecomMsgSignature is deterministic", () => {
    const params = { token: "tok", timestamp: "123", nonce: "abc", encrypt: "enc" };
    const sig1 = computeWecomMsgSignature(params);
    const sig2 = computeWecomMsgSignature(params);
    expect(sig1).toBe(sig2);
    expect(sig1).toHaveLength(40); // SHA1 hex
  });

  it("verifyWecomSignature returns true for correct signature", () => {
    const params = { token: "tok", timestamp: "123", nonce: "abc", encrypt: "enc" };
    const sig = computeWecomMsgSignature(params);
    expect(verifyWecomSignature({ ...params, signature: sig })).toBe(true);
  });

  it("verifyWecomSignature returns false for wrong signature", () => {
    const params = { token: "tok", timestamp: "123", nonce: "abc", encrypt: "enc" };
    expect(verifyWecomSignature({ ...params, signature: "wrong" })).toBe(false);
  });
});

describe("crypto: encrypt/decrypt roundtrip", () => {
  it("encrypts and decrypts back to original plaintext", () => {
    const plaintext = "Hello, 微信客服!";
    const receiveId = "ww_corp_test";

    const encrypted = encryptWecomPlaintext({
      encodingAESKey: TEST_KEY,
      receiveId,
      plaintext,
    });

    expect(typeof encrypted).toBe("string");
    expect(encrypted.length).toBeGreaterThan(0);

    const decrypted = decryptWecomEncrypted({
      encodingAESKey: TEST_KEY,
      receiveId,
      encrypt: encrypted,
    });

    expect(decrypted).toBe(plaintext);
  });

  it("decrypt fails with wrong receiveId", () => {
    const encrypted = encryptWecomPlaintext({
      encodingAESKey: TEST_KEY,
      receiveId: "corp_a",
      plaintext: "test",
    });

    expect(() =>
      decryptWecomEncrypted({
        encodingAESKey: TEST_KEY,
        receiveId: "corp_b",
        encrypt: encrypted,
      })
    ).toThrow("receiveId mismatch");
  });

  it("decrypt works without receiveId check", () => {
    const encrypted = encryptWecomPlaintext({
      encodingAESKey: TEST_KEY,
      receiveId: "corp_a",
      plaintext: "no check",
    });

    const decrypted = decryptWecomEncrypted({
      encodingAESKey: TEST_KEY,
      encrypt: encrypted,
    });

    expect(decrypted).toBe("no check");
  });

  it("handles empty plaintext", () => {
    const encrypted = encryptWecomPlaintext({
      encodingAESKey: TEST_KEY,
      plaintext: "",
    });

    const decrypted = decryptWecomEncrypted({
      encodingAESKey: TEST_KEY,
      encrypt: encrypted,
    });

    expect(decrypted).toBe("");
  });

  it("handles long plaintext with CJK characters", () => {
    const plaintext = "测试消息".repeat(200);
    const encrypted = encryptWecomPlaintext({
      encodingAESKey: TEST_KEY,
      receiveId: "ww123",
      plaintext,
    });

    const decrypted = decryptWecomEncrypted({
      encodingAESKey: TEST_KEY,
      receiveId: "ww123",
      encrypt: encrypted,
    });

    expect(decrypted).toBe(plaintext);
  });
});
