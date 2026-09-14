import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";

/**
 * "Create account" with an emailed approval code, and per-client CV activity.
 * Runs against the real database; the mailer is replaced so the test can read
 * the code that would have been emailed.
 */
const sent: Array<{ to: string; subject: string; text: string }> = [];
vi.mock("@/lib/mailer", () => ({
  isMailConfigured: () => true,
  sendMail: async (m: { to: string; subject: string; text: string }) => {
    sent.push(m);
  },
}));

const { requestSignup, verifySignup, resendSignupCode, maskEmail } = await import("@/backend/signup");
const { getWorkspaceActivity, getWorkspaceDay } = await import("@/backend/activity");
const { authenticate } = await import("@/lib/auth");

let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}
const d = dbUp ? describe : describe.skip;

const TAG = `su${Date.now().toString(36)}`;
const email = `${TAG}@example.com`;
const codeFrom = (text: string) => text.match(/Verification code: (\d{6})/)![1];

d("create account", () => {
  const created: string[] = [];

  afterAll(async () => {
    await prisma.signupRequest.deleteMany({ where: { email: { startsWith: TAG } } });
    for (const id of created) await prisma.workspace.delete({ where: { id } }).catch(() => undefined);
  });

  it("sends the code to the approval address, not to the applicant", async () => {
    sent.length = 0;
    const res = await requestSignup({ name: "Sunita Rao", companyName: `Northwind ${TAG}`, email, password: "a-long-password" });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("caller.digital26@gmail.com");
    expect(sent[0].to).not.toBe(email);
    expect(sent[0].text).toContain(email);
    expect(res.sentTo).toBe(maskEmail("caller.digital26@gmail.com"));
    expect(res.sentTo).not.toContain("caller.digital");
  });

  it("creates nothing until the code is accepted", async () => {
    expect(await prisma.user.count({ where: { email } })).toBe(0);
    const req = await prisma.signupRequest.findFirstOrThrow({ where: { email } });
    // Only a hash is stored.
    expect(req.codeHash).not.toContain(codeFrom(sent[0].text));
    expect(req.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a wrong code and counts the attempt", async () => {
    const req = await prisma.signupRequest.findFirstOrThrow({ where: { email } });
    const wrong = codeFrom(sent[0].text) === "000000" ? "111111" : "000000";
    await expect(verifySignup({ requestId: req.id, code: wrong })).rejects.toThrow(/not correct. 4 tries left/);
    expect((await prisma.signupRequest.findUniqueOrThrow({ where: { id: req.id } })).attempts).toBe(1);
  });

  it("the right code creates a client with the applicant as administrator, who can then sign in", async () => {
    const req = await prisma.signupRequest.findFirstOrThrow({ where: { email } });
    const user = await verifySignup({ requestId: req.id, code: codeFrom(sent[0].text) });
    created.push(user.workspaceId!);
    expect(user.role).toBe("ADMIN");
    expect(user.workspaceName).toBe(`Northwind ${TAG}`);
    const signedIn = await authenticate(email, "a-long-password");
    expect(signedIn?.workspaceId).toBe(user.workspaceId);
  });

  it("a used code cannot be replayed", async () => {
    const req = await prisma.signupRequest.findFirstOrThrow({ where: { email } });
    await expect(verifySignup({ requestId: req.id, code: codeFrom(sent[0].text) })).rejects.toThrow(/expired/);
  });

  it("refuses an email that already has an account", async () => {
    await expect(requestSignup({ name: "X", companyName: "Y Co", email, password: "a-long-password" })).rejects.toThrow(/already exists/);
  });

  it("locks the request after five wrong codes", async () => {
    sent.length = 0;
    const e2 = `${TAG}-lock@example.com`;
    const { requestId } = await requestSignup({ name: "L", companyName: "Lock Co", email: e2, password: "a-long-password" });
    const right = codeFrom(sent[0].text);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await verifySignup({ requestId, code: wrong }).catch(() => undefined);
    // Even the right code no longer works.
    await expect(verifySignup({ requestId, code: right })).rejects.toThrow(/Too many/);
  });

  it("resend is throttled, and a resent code replaces the old one", async () => {
    sent.length = 0;
    const e3 = `${TAG}-resend@example.com`;
    const { requestId } = await requestSignup({ name: "R", companyName: "Resend Co", email: e3, password: "a-long-password" });
    const first = codeFrom(sent[0].text);
    await expect(resendSignupCode(requestId)).rejects.toThrow(/wait/);

    await prisma.signupRequest.update({ where: { id: requestId }, data: { sentAt: new Date(Date.now() - 120_000) } });
    await resendSignupCode(requestId);
    const second = codeFrom(sent[1].text);
    if (first !== second) {
      await expect(verifySignup({ requestId, code: first })).rejects.toThrow(/not correct/);
    }
    const user = await verifySignup({ requestId, code: second });
    created.push(user.workspaceId!);
  });
});

d("client activity by date", () => {
  let wsId = "";

  beforeAll(async () => {
    const ws = await prisma.workspace.create({ data: { name: `Activity ${TAG}`, slug: `act-${TAG}` } });
    wsId = ws.id;
    const cv = (createdAt: string, sourceType: "MANUAL" | "GOOGLE_DRIVE", n: number) =>
      prisma.cVFile.create({
        data: { workspaceId: wsId, sourceType, sourceFileId: sourceType === "GOOGLE_DRIVE" ? `${TAG}-${n}` : null, fileName: `${TAG}-${n}.pdf`, mimeType: "application/pdf", fileHash: `${TAG}${n}`, fileSize: 1, createdAt: new Date(createdAt) },
      });
    // 2026-03-01 18:45 UTC is 00:15 on 2 March in Kolkata: the boundary case.
    await cv("2026-03-01T18:45:00Z", "MANUAL", 1);
    await cv("2026-03-01T10:00:00Z", "MANUAL", 2);
    await cv("2026-03-01T12:30:00Z", "GOOGLE_DRIVE", 3);
    await cv("2026-03-02T05:00:00Z", "GOOGLE_DRIVE", 4);
  });

  afterAll(async () => {
    await prisma.workspace.delete({ where: { id: wsId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("groups CVs by the viewer's calendar day, not UTC's", async () => {
    const ist = await getWorkspaceActivity(wsId, { from: "2026-03-01", to: "2026-03-02", tz: "Asia/Kolkata" });
    expect(ist.days.map((x) => [x.day, x.total, x.manual, x.drive])).toEqual([
      ["2026-03-02", 2, 1, 1],
      ["2026-03-01", 2, 1, 1],
    ]);
    const utc = await getWorkspaceActivity(wsId, { from: "2026-03-01", to: "2026-03-02", tz: "UTC" });
    expect(utc.days.map((x) => [x.day, x.total])).toEqual([
      ["2026-03-02", 1],
      ["2026-03-01", 3],
    ]);
  });

  it("the date range is inclusive of both ends, in the viewer's zone", async () => {
    const only2nd = await getWorkspaceActivity(wsId, { from: "2026-03-02", to: "2026-03-02", tz: "Asia/Kolkata" });
    expect(only2nd.range.total).toBe(2);
  });

  it("a day's list holds exactly the CVs counted for that day, in time order", async () => {
    const day = await getWorkspaceDay(wsId, { date: "2026-03-02", tz: "Asia/Kolkata" });
    expect(day.files.map((f) => f.fileName)).toEqual([`${TAG}-1.pdf`, `${TAG}-4.pdf`]);
  });

  it("an unknown time zone falls back to UTC rather than erroring", async () => {
    const res = await getWorkspaceActivity(wsId, { from: "2026-03-01", to: "2026-03-02", tz: "Not/AZone" });
    expect(res.tz).toBe("UTC");
  });
});
