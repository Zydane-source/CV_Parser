import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret, sha256Hex, randomToken } from "@/lib/crypto";
import { createSessionToken, verifySessionToken } from "@/lib/auth";

describe("crypto", () => {
  it("round-trips secrets with AES-256-GCM and never stores plaintext", () => {
    const token = "ya29.a0AfH6SMB-google-refresh-token";
    const enc = encryptSecret(token);
    expect(enc).not.toContain(token);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(decryptSecret(enc)).toBe(token);
    expect(encryptSecret(token)).not.toBe(enc); // random IV
  });
  it("detects tampering", () => {
    const enc = encryptSecret("secret");
    const tampered = enc.slice(0, -2) + (enc.endsWith("A") ? "BB" : "AA");
    expect(() => decryptSecret(tampered)).toThrow();
  });
  it("hashes deterministically (duplicate detection)", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(Buffer.from("abc"))).toBe(sha256Hex("abc"));
    expect(sha256Hex("abd")).not.toBe(sha256Hex("abc"));
  });
  it("random tokens are url-safe and unique", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(randomToken());
  });
});

describe("session tokens", () => {
  it("signs and verifies a session", async () => {
    const user = { id: "u1", email: "a@b.c", name: "A", role: "ADMIN" as const };
    const token = await createSessionToken(user);
    expect(await verifySessionToken(token)).toEqual(user);
    expect(await verifySessionToken(token + "x")).toBeNull();
    expect(await verifySessionToken("garbage")).toBeNull();
  });
});
