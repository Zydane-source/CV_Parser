-- 1. Record how each client joined, so the owner can tell self-service sign-ups
--    from clients they added by hand.
ALTER TABLE "Workspace" ADD COLUMN "createdVia" TEXT NOT NULL DEFAULT 'OWNER';
UPDATE "Workspace" SET "createdVia" = 'SYSTEM' WHERE "id" = 'ws_default00000000000000000';

-- 2. The account that ran this deployment before clients existed becomes the
--    platform owner, so client tracking is available from the login already in
--    use. It keeps its workspace, so its own dashboard, candidates and uploads are
--    unchanged. Only the earliest administrator of the default workspace is
--    promoted, and only if no owner exists yet — re-running changes nothing.
UPDATE "User" SET "role" = 'OWNER'
 WHERE NOT EXISTS (SELECT 1 FROM "User" WHERE "role" = 'OWNER')
   AND "id" = (
     SELECT "id" FROM "User"
      WHERE "role" = 'ADMIN' AND "workspaceId" = 'ws_default00000000000000000'
      ORDER BY "createdAt" ASC
      LIMIT 1
   );
