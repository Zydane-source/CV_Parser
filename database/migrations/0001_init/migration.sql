-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('MANUAL', 'GOOGLE_DRIVE');

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'NEEDS_REVIEW', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'RECRUITER');

-- CreateEnum
CREATE TYPE "ExtractionMethod" AS ENUM ('PDF_TEXT', 'DOCX', 'DOC', 'OCR_IMAGE', 'OCR_PDF', 'NONE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'RECRUITER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CVFile" (
    "id" TEXT NOT NULL,
    "sourceType" "SourceType" NOT NULL,
    "sourceFileId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "storagePath" TEXT,
    "driveUrl" TEXT,
    "driveCreatedTime" TIMESTAMP(3),
    "driveModifiedTime" TIMESTAMP(3),
    "driveConnectionId" TEXT,
    "status" "ProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "statusMessage" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CVFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL,
    "cvFileId" TEXT NOT NULL,
    "candidateName" TEXT NOT NULL DEFAULT 'Not Found',
    "phoneNumber" TEXT NOT NULL DEFAULT 'Not Found',
    "jobRoleAppliedFor" TEXT NOT NULL DEFAULT 'Not Found',
    "nameConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "phoneConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "roleConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "overallConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isManuallyCorrected" BOOLEAN NOT NULL DEFAULT false,
    "correctedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "extractionMethod" "ExtractionMethod" NOT NULL DEFAULT 'NONE',
    "llmModel" TEXT,
    "promptVersion" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingJob" (
    "id" TEXT NOT NULL,
    "cvFileId" TEXT NOT NULL,
    "batchId" TEXT,
    "queueJobId" TEXT,
    "status" "ProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "stage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "errorMessage" TEXT,
    "errorCode" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleDriveConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "googleAccountEmail" TEXT,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "tokenExpiry" TIMESTAMP(3),
    "scope" TEXT,
    "folderId" TEXT,
    "folderName" TEXT,
    "folderPath" TEXT,
    "startPageToken" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "lastSyncFileCount" INTEGER NOT NULL DEFAULT 0,
    "watchChannelId" TEXT,
    "watchResourceId" TEXT,
    "watchExpiry" TIMESTAMP(3),
    "watchToken" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleDriveConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SheetsExport" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "spreadsheetId" TEXT NOT NULL,
    "spreadsheetUrl" TEXT NOT NULL,
    "sheetTitle" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SheetsExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "CVFile_fileHash_idx" ON "CVFile"("fileHash");

-- CreateIndex
CREATE INDEX "CVFile_driveConnectionId_idx" ON "CVFile"("driveConnectionId");

-- CreateIndex
CREATE INDEX "CVFile_sourceType_idx" ON "CVFile"("sourceType");

-- CreateIndex
CREATE INDEX "CVFile_status_idx" ON "CVFile"("status");

-- CreateIndex
CREATE INDEX "CVFile_createdAt_idx" ON "CVFile"("createdAt");

-- CreateIndex
CREATE INDEX "CVFile_fileName_idx" ON "CVFile"("fileName");

-- CreateIndex
CREATE UNIQUE INDEX "CVFile_sourceType_sourceFileId_key" ON "CVFile"("sourceType", "sourceFileId");

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_cvFileId_key" ON "Candidate"("cvFileId");

-- CreateIndex
CREATE INDEX "Candidate_candidateName_idx" ON "Candidate"("candidateName");

-- CreateIndex
CREATE INDEX "Candidate_phoneNumber_idx" ON "Candidate"("phoneNumber");

-- CreateIndex
CREATE INDEX "Candidate_jobRoleAppliedFor_idx" ON "Candidate"("jobRoleAppliedFor");

-- CreateIndex
CREATE INDEX "Candidate_createdAt_idx" ON "Candidate"("createdAt");

-- CreateIndex
CREATE INDEX "Candidate_processedAt_idx" ON "Candidate"("processedAt");

-- CreateIndex
CREATE INDEX "ProcessingJob_cvFileId_idx" ON "ProcessingJob"("cvFileId");

-- CreateIndex
CREATE INDEX "ProcessingJob_status_idx" ON "ProcessingJob"("status");

-- CreateIndex
CREATE INDEX "ProcessingJob_batchId_idx" ON "ProcessingJob"("batchId");

-- CreateIndex
CREATE INDEX "ProcessingJob_createdAt_idx" ON "ProcessingJob"("createdAt");

-- CreateIndex
CREATE INDEX "GoogleDriveConnection_userId_idx" ON "GoogleDriveConnection"("userId");

-- CreateIndex
CREATE INDEX "GoogleDriveConnection_isActive_idx" ON "GoogleDriveConnection"("isActive");

-- CreateIndex
CREATE INDEX "SheetsExport_createdAt_idx" ON "SheetsExport"("createdAt");

-- AddForeignKey
ALTER TABLE "CVFile" ADD CONSTRAINT "CVFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CVFile" ADD CONSTRAINT "CVFile_driveConnectionId_fkey" FOREIGN KEY ("driveConnectionId") REFERENCES "GoogleDriveConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_cvFileId_fkey" FOREIGN KEY ("cvFileId") REFERENCES "CVFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_cvFileId_fkey" FOREIGN KEY ("cvFileId") REFERENCES "CVFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleDriveConnection" ADD CONSTRAINT "GoogleDriveConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SheetsExport" ADD CONSTRAINT "SheetsExport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

