-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN     "extractionEngine" TEXT,
ADD COLUMN     "extractionMs" INTEGER,
ADD COLUMN     "extractionVersion" TEXT,
ADD COLUMN     "fieldMethods" JSONB,
ADD COLUMN     "ocrUsed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Candidate_extractionEngine_idx" ON "Candidate"("extractionEngine");

-- CreateIndex
CREATE INDEX "Candidate_reviewRequired_idx" ON "Candidate"("reviewRequired");

