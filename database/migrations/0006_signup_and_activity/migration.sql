-- Self-service account creation, gated by an emailed verification code.
CREATE TABLE "SignupRequest" (
    "id"           TEXT NOT NULL,
    "name"         TEXT NOT NULL,
    "email"        TEXT NOT NULL,
    "companyName"  TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "codeHash"     TEXT NOT NULL,
    "attempts"     INTEGER NOT NULL DEFAULT 0,
    "expiresAt"    TIMESTAMP(3) NOT NULL,
    "sentAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt"   TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignupRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SignupRequest_email_idx" ON "SignupRequest"("email");
CREATE INDEX "SignupRequest_expiresAt_idx" ON "SignupRequest"("expiresAt");

-- Per-client activity ("CVs fetched by date") filters one workspace and a date
-- range together; the two single-column indexes cannot serve that on their own.
CREATE INDEX "CVFile_workspaceId_createdAt_idx" ON "CVFile"("workspaceId", "createdAt");
