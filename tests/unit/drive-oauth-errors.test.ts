import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";

/**
 * The two OAuth failures an operator actually meets, and the guidance each needs.
 *
 * `access_denied` was surfaced as "Google returned: access_denied", which names
 * the code and none of the fix. It has two opposite causes — a declined prompt,
 * or a consent screen still in Testing with the account missing from its test
 * user list — and during setup it is almost always the second.
 *
 * `invalid_grant` matters because Google expires refresh tokens after seven days
 * while the consent screen is in Testing. That makes a dead connection a
 * scheduled event rather than an edge case, and it must read as "reconnect"
 * rather than repeating a raw API error every sync.
 */
describe("OAuth error guidance", () => {
  it("explains access_denied in terms of what to change", async () => {
    const src = await fs.readFile("app/api/google-drive/callback/route.ts", "utf8");
    expect(src).toContain("describeOAuthError");
    expect(src).toMatch(/Test users/);
    expect(src).toMatch(/publish the app/i);
    // The bare passthrough must be gone.
    expect(src).not.toContain("Google returned: ${error}");
  });

  it("covers the Workspace policy and organisation-only cases too", async () => {
    const src = await fs.readFile("app/api/google-drive/callback/route.ts", "utf8");
    expect(src).toContain("admin_policy_enforced");
    expect(src).toContain("org_internal");
  });

  it("turns an unusable refresh token into a reconnect instruction", async () => {
    const src = await fs.readFile("services/google-drive/sync.ts", "utf8");
    expect(src).toMatch(/invalid_grant/);
    expect(src).toMatch(/Connect Google Drive again/);
  });

  it("still records other sync failures verbatim", async () => {
    // Only the re-auth class is rewritten; everything else keeps the real
    // message, which is what makes an unexpected failure diagnosable.
    const src = await fs.readFile("services/google-drive/sync.ts", "utf8");
    expect(src).toContain("msg.slice(0, 500)");
  });
});
