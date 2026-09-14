-- Client workspaces: isolate each client's candidates, uploads and Drive folder.
--
-- Existing data predates the concept, so it is adopted into one workspace rather
-- than being orphaned or deleted. Everything that exists today keeps working and
-- keeps belonging to the same people; the boundary is added around it.

-- 1. The platform operator role, above a client's own administrator.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'OWNER';

-- 2. The tenant.
CREATE TABLE "Workspace" (
    "id"        TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "slug"      TEXT NOT NULL,
    "isActive"  BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");
CREATE INDEX "Workspace_isActive_idx" ON "Workspace"("isActive");

-- 3. Adopt everything that already exists.
INSERT INTO "Workspace" ("id", "name", "slug", "isActive", "createdAt", "updatedAt")
VALUES ('ws_default00000000000000000', 'Default', 'default', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- 4. Columns go on nullable, get backfilled, then become required. Adding them
--    NOT NULL in one step would fail against any existing row.
ALTER TABLE "User" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "User" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CVFile" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "GoogleDriveConnection" ADD COLUMN "workspaceId" TEXT;

UPDATE "User" SET "workspaceId" = 'ws_default00000000000000000';
UPDATE "CVFile" SET "workspaceId" = 'ws_default00000000000000000';
UPDATE "GoogleDriveConnection" SET "workspaceId" = 'ws_default00000000000000000';

-- CVFile and the Drive connection must always belong to a client. User stays
-- nullable because an OWNER belongs to the platform, not to any one client.
ALTER TABLE "CVFile" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "GoogleDriveConnection" ALTER COLUMN "workspaceId" SET NOT NULL;

-- 5. Keys and indexes.
ALTER TABLE "User" ADD CONSTRAINT "User_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CVFile" ADD CONSTRAINT "CVFile_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GoogleDriveConnection" ADD CONSTRAINT "GoogleDriveConnection_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "User_workspaceId_idx" ON "User"("workspaceId");
CREATE INDEX "CVFile_workspaceId_idx" ON "CVFile"("workspaceId");
CREATE INDEX "GoogleDriveConnection_workspaceId_idx" ON "GoogleDriveConnection"("workspaceId");

-- 6. Drive file ids are unique per client, not globally: two clients may hold
--    the same file, and one importing it must not block the other.
DROP INDEX IF EXISTS "CVFile_sourceType_sourceFileId_key";
CREATE UNIQUE INDEX "CVFile_workspaceId_sourceType_sourceFileId_key"
    ON "CVFile"("workspaceId", "sourceType", "sourceFileId");
