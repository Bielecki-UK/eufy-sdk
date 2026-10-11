import { createCipheriv } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { deriveBodyKey, decryptReply } from "../et3.js";

/**
 * Seal a plaintext the way the Tuya server does for an et=3 reply: AES-128-GCM with a random 12-byte
 * nonce, `nonce ‖ ciphertext ‖ tag`, base64. `gzip` wraps the plaintext in a gzip frame first. Test
 * helper only — the SDK never encrypts an et=3 body (requests are plaintext).
 */
function seal(key: Buffer, plaintext: string, opts: { gzip?: boolean } = {}): string {
  const body = opts.gzip ? gzipSync(Buffer.from(plaintext, "utf-8")) : Buffer.from(plaintext, "utf-8");
  const nonce = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64");
}

describe("et3 deriveBodyKey", () => {
  it("returns 16 bytes that are all ASCII lowercase-hex characters", () => {
    const key = deriveBodyKey("req-abc", null);
    expect(key).toHaveLength(16);
    expect(key.toString("latin1")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for the same (requestId, ecode)", () => {
    expect(deriveBodyKey("req-1", "ec-1")).toEqual(deriveBodyKey("req-1", "ec-1"));
  });

  it("separates the pre-session (null) variant from an ecode-keyed one, and distinct ecodes", () => {
    expect(deriveBodyKey("req-1", null)).not.toEqual(deriveBodyKey("req-1", "ec-1"));
    expect(deriveBodyKey("req-1", "ec-1")).not.toEqual(deriveBodyKey("req-1", "ec-2"));
    expect(deriveBodyKey("req-1", "ec-1")).not.toEqual(deriveBodyKey("req-2", "ec-1"));
  });
});

describe("et3 decryptReply", () => {
  it("round-trips a sealed JSON body (null variant)", () => {
    const key = deriveBodyKey("req-r", null);
    const json = JSON.stringify({ success: true, t: 1, result: { sid: "s", uid: "u" } });
    expect(decryptReply(key, seal(key, json))).toBe(json);
  });

  it("gunzips a gzip-framed plaintext", () => {
    const key = deriveBodyKey("req-g", "ec-g");
    const json = JSON.stringify({ result: { dps: { "8": "100" } } });
    expect(decryptReply(key, seal(key, json, { gzip: true }))).toBe(json);
  });

  it("throws on a tag/key mismatch", () => {
    const sealed = seal(deriveBodyKey("req-a", null), "{}");
    expect(() => decryptReply(deriveBodyKey("req-b", null), sealed)).toThrow();
  });

  it("throws when the blob is too short to hold a nonce + tag", () => {
    expect(() => decryptReply(deriveBodyKey("r", null), Buffer.alloc(8).toString("base64"))).toThrow(/too short/);
  });
});
