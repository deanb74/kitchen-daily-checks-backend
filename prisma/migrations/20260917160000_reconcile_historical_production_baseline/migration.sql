-- Additive, idempotent reconciliation of structures present in Railway but absent
-- from the committed 20250101000000_init migration history.

BEGIN;

ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS "venueType" TEXT;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "firstName" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastName" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "displayName" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "jobTitle" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "department" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "regionId" INTEGER;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "areaId" INTEGER;

ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "templateId" INTEGER;
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "taskDate" TEXT;
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "areaId" INTEGER;
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "equipmentId" INTEGER;
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "department" TEXT NOT NULL DEFAULT 'kitchen';
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "frequency" TEXT NOT NULL DEFAULT 'daily';
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "dueAt" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "escalationLevel" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "lastEscalatedAt" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "completedById" INTEGER;
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "completedByEmail" TEXT;

CREATE TABLE IF NOT EXISTS "TaskTemplate" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "department" TEXT NOT NULL DEFAULT 'kitchen',
    "frequency" TEXT NOT NULL DEFAULT 'daily',
    "areaId" INTEGER,
    "equipmentId" INTEGER,
    "venueType" TEXT,
    "autoCreate" BOOLEAN NOT NULL DEFAULT false,
    "schedule" TEXT,
    "dueHour" INTEGER,
    "dueMinute" INTEGER,
    "safeMethodId" INTEGER,
    "verificationRequired" BOOLEAN NOT NULL DEFAULT false,
    "managerSignoffRequired" BOOLEAN NOT NULL DEFAULT false,
    "correctiveActionPrompt" TEXT,
    "instructions" TEXT,
    "ppeRequired" TEXT,
    CONSTRAINT "TaskTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Shift" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "siteId" INTEGER,
    "department" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "handoverNotes" TEXT,
    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SafeMethod" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SafeMethod_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ComplianceRecord" (
    "id" SERIAL NOT NULL,
    "taskId" INTEGER,
    "userId" INTEGER NOT NULL,
    "siteId" INTEGER,
    "type" TEXT NOT NULL,
    "value" TEXT,
    "notes" TEXT,
    "correctiveAction" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedById" INTEGER,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ComplianceRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CompliancePhoto" (
    "id" SERIAL NOT NULL,
    "complianceRecordId" INTEGER NOT NULL,
    "siteId" INTEGER,
    "userId" INTEGER,
    "fileUrl" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "stage" TEXT,
    "caption" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompliancePhoto_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Area" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Area_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Equipment" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,
    "areaId" INTEGER,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "faultReported" BOOLEAN NOT NULL DEFAULT false,
    "faultNotes" TEXT,
    "outOfService" BOOLEAN NOT NULL DEFAULT false,
    "lastMaintenanceAt" TIMESTAMP(3),
    "lastCleanedAt" TIMESTAMP(3),
    "cleaningIntervalDays" INTEGER,
    "maintenanceIntervalDays" INTEGER,
    "nextCleaningDueAt" TIMESTAMP(3),
    "nextMaintenanceDueAt" TIMESTAMP(3),
    CONSTRAINT "Equipment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SiteDocument" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT,
    "language" TEXT,
    "fileUrl" TEXT,
    "thumbnailUrl" TEXT,
    "originalFileName" TEXT,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "fileExtension" TEXT,
    "pageCount" INTEGER,
    "imageWidth" INTEGER,
    "imageHeight" INTEGER,
    "checksum" TEXT,
    "source" TEXT,
    "status" TEXT,
    "extractedText" TEXT,
    "parsedJson" JSONB,
    "confidence" DOUBLE PRECISION,
    "importSummary" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SiteDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DocumentProcessingJob" (
    "id" SERIAL NOT NULL,
    "siteDocumentId" INTEGER NOT NULL,
    "siteId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "jobType" TEXT NOT NULL DEFAULT 'parse',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentProcessingJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SupplierContact" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "role" TEXT,
    "category" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "warranty" BOOLEAN NOT NULL DEFAULT false,
    "equipmentType" TEXT,
    "areaName" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupplierContact_pkey" PRIMARY KEY ("id")
);

DO $migration$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TaskTemplate_safeMethodId_fkey' AND conrelid = 'public."TaskTemplate"'::regclass) THEN
        ALTER TABLE "TaskTemplate" ADD CONSTRAINT "TaskTemplate_safeMethodId_fkey" FOREIGN KEY ("safeMethodId") REFERENCES "SafeMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ComplianceRecord_taskId_fkey' AND conrelid = 'public."ComplianceRecord"'::regclass) THEN
        ALTER TABLE "ComplianceRecord" ADD CONSTRAINT "ComplianceRecord_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CompliancePhoto_complianceRecordId_fkey' AND conrelid = 'public."CompliancePhoto"'::regclass) THEN
        ALTER TABLE "CompliancePhoto" ADD CONSTRAINT "CompliancePhoto_complianceRecordId_fkey" FOREIGN KEY ("complianceRecordId") REFERENCES "ComplianceRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Area_siteId_fkey' AND conrelid = 'public."Area"'::regclass) THEN
        ALTER TABLE "Area" ADD CONSTRAINT "Area_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Equipment_siteId_fkey' AND conrelid = 'public."Equipment"'::regclass) THEN
        ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Equipment_areaId_fkey' AND conrelid = 'public."Equipment"'::regclass) THEN
        ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteDocument_siteId_fkey' AND conrelid = 'public."SiteDocument"'::regclass) THEN
        ALTER TABLE "SiteDocument" ADD CONSTRAINT "SiteDocument_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DocumentProcessingJob_siteDocumentId_fkey' AND conrelid = 'public."DocumentProcessingJob"'::regclass) THEN
        ALTER TABLE "DocumentProcessingJob" ADD CONSTRAINT "DocumentProcessingJob_siteDocumentId_fkey" FOREIGN KEY ("siteDocumentId") REFERENCES "SiteDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$migration$;

COMMIT;
