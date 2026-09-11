-- Fallback storage for uploaded CVs when no object store is configured.
-- Additive: no existing table or column is touched.
CREATE TABLE "StoredFile" (
    "key" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "StoredFile_createdAt_idx" ON "StoredFile"("createdAt");
