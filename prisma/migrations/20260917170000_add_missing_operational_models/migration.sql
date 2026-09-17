-- Forward-only migration generated from the verified live Railway catalog baseline.
-- Adds only the eleven Prisma models absent from production.

BEGIN;

CREATE TABLE "StockItem" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "unit" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StockItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StockMovement" (
    "id" SERIAL NOT NULL,
    "stockItemId" INTEGER,
    "foodBatchId" INTEGER,
    "fromSiteId" INTEGER,
    "toSiteId" INTEGER,
    "fromAreaId" INTEGER,
    "toAreaId" INTEGER,
    "fromEquipmentId" INTEGER,
    "toEquipmentId" INTEGER,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "movementType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "notes" TEXT,
    "requestedById" INTEGER,
    "approvedById" INTEGER,
    "completedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShelfLifeRule" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER,
    "name" TEXT NOT NULL,
    "foodType" TEXT,
    "freshShelfLifeHours" INTEGER,
    "frozenShelfLifeHours" INTEGER,
    "defrostShelfLifeHours" INTEGER,
    "storageType" TEXT,
    "defrostInstructions" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShelfLifeRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FoodBatch" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,
    "parentBatchId" INTEGER,
    "name" TEXT NOT NULL,
    "batchCode" TEXT,
    "batchType" TEXT NOT NULL DEFAULT 'fresh',
    "storageLocation" TEXT,
    "storageEquipmentId" INTEGER,
    "storageAreaId" INTEGER,
    "storageNotes" TEXT,
    "totalQuantity" DOUBLE PRECISION,
    "remainingQuantity" DOUBLE PRECISION,
    "unit" TEXT,
    "labelQuantity" INTEGER,
    "madeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "useByAt" TIMESTAMP(3),
    "originalShelfLifeHours" INTEGER,
    "remainingShelfLifeHours" INTEGER,
    "shelfLifeUsedBeforeFreezeHours" INTEGER,
    "frozenAt" TIMESTAMP(3),
    "frozenUseByAt" TIMESTAMP(3),
    "defrostStartedAt" TIMESTAMP(3),
    "defrostUseByAt" TIMESTAMP(3),
    "defrostShelfLifeHours" INTEGER,
    "defrostInstructions" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FoodBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FoodBatchMovement" (
    "id" SERIAL NOT NULL,
    "foodBatchId" INTEGER NOT NULL,
    "siteId" INTEGER NOT NULL,
    "fromStorageLocation" TEXT,
    "toStorageLocation" TEXT,
    "fromEquipmentId" INTEGER,
    "toEquipmentId" INTEGER,
    "fromAreaId" INTEGER,
    "toAreaId" INTEGER,
    "quantity" DOUBLE PRECISION,
    "unit" TEXT,
    "movementType" TEXT NOT NULL,
    "notes" TEXT,
    "movedById" INTEGER,
    "movedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FoodBatchMovement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LabelTemplate" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'food_label',
    "templateJson" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LabelTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PrintedLabel" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,
    "foodBatchId" INTEGER,
    "labelTemplateId" INTEGER,
    "title" TEXT NOT NULL,
    "printedText" TEXT,
    "quantityPrinted" INTEGER NOT NULL DEFAULT 1,
    "storageLocation" TEXT,
    "useByAt" TIMESTAMP(3),
    "printerName" TEXT,
    "printedById" INTEGER,
    "printedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PrintedLabel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WasteAlert" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,
    "foodBatchId" INTEGER NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'amber',
    "status" TEXT NOT NULL DEFAULT 'open',
    "message" TEXT NOT NULL,
    "suggestedAction" TEXT,
    "actionType" TEXT,
    "actionStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "WasteAlert_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OperationalFact" (
    "factId" VARCHAR(255) NOT NULL,
    "factType" VARCHAR(100) NOT NULL,
    "factVersion" VARCHAR(32) NOT NULL,
    "subjectType" VARCHAR(64) NOT NULL,
    "subjectId" VARCHAR(255) NOT NULL,
    "scopeType" VARCHAR(64) NOT NULL,
    "scopeId" VARCHAR(255) NOT NULL,
    "sourceKind" VARCHAR(32) NOT NULL,
    "actorReference" VARCHAR(255) NOT NULL,
    "provenanceReference" VARCHAR(512) NOT NULL,
    "observedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "relationships" JSONB NOT NULL,
    CONSTRAINT "OperationalFact_pkey" PRIMARY KEY ("factId")
);

CREATE TABLE "FactLegacyTemperatureLogLink" (
    "linkId" UUID NOT NULL,
    "factId" VARCHAR(255) NOT NULL,
    "legacyTemperatureLogId" INTEGER NOT NULL,
    "linkMode" VARCHAR(64) NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FactLegacyTemperatureLogLink_pkey" PRIMARY KEY ("linkId")
);

CREATE TABLE "FactCustodyReceipt" (
    "receiptId" UUID NOT NULL,
    "factId" VARCHAR(255) NOT NULL,
    "custodianReference" VARCHAR(255) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "persistenceId" UUID NOT NULL,
    "persistenceReference" VARCHAR(255) NOT NULL,
    "schemaVersion" VARCHAR(32) NOT NULL,
    CONSTRAINT "FactCustodyReceipt_pkey" PRIMARY KEY ("receiptId")
);

CREATE INDEX "OperationalFact_factType_factVersion_idx" ON "OperationalFact"("factType", "factVersion");
CREATE INDEX "OperationalFact_scopeType_scopeId_receivedAt_idx" ON "OperationalFact"("scopeType", "scopeId", "receivedAt");
CREATE INDEX "OperationalFact_subjectType_subjectId_observedAt_idx" ON "OperationalFact"("subjectType", "subjectId", "observedAt");
CREATE UNIQUE INDEX "FactLegacyTemperatureLogLink_factId_key" ON "FactLegacyTemperatureLogLink"("factId");
CREATE INDEX "FactLegacyTemperatureLogLink_legacyTemperatureLogId_idx" ON "FactLegacyTemperatureLogLink"("legacyTemperatureLogId");
CREATE UNIQUE INDEX "FactCustodyReceipt_factId_key" ON "FactCustodyReceipt"("factId");
CREATE UNIQUE INDEX "FactCustodyReceipt_persistenceId_key" ON "FactCustodyReceipt"("persistenceId");
CREATE UNIQUE INDEX "FactCustodyReceipt_persistenceReference_key" ON "FactCustodyReceipt"("persistenceReference");
CREATE INDEX "FactCustodyReceipt_custodianReference_recordedAt_idx" ON "FactCustodyReceipt"("custodianReference", "recordedAt");

ALTER TABLE "FoodBatchMovement" ADD CONSTRAINT "FoodBatchMovement_foodBatchId_fkey" FOREIGN KEY ("foodBatchId") REFERENCES "FoodBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PrintedLabel" ADD CONSTRAINT "PrintedLabel_foodBatchId_fkey" FOREIGN KEY ("foodBatchId") REFERENCES "FoodBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PrintedLabel" ADD CONSTRAINT "PrintedLabel_labelTemplateId_fkey" FOREIGN KEY ("labelTemplateId") REFERENCES "LabelTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WasteAlert" ADD CONSTRAINT "WasteAlert_foodBatchId_fkey" FOREIGN KEY ("foodBatchId") REFERENCES "FoodBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FactLegacyTemperatureLogLink" ADD CONSTRAINT "FactLegacyTemperatureLogLink_factId_fkey" FOREIGN KEY ("factId") REFERENCES "OperationalFact"("factId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "FactLegacyTemperatureLogLink" ADD CONSTRAINT "FactLegacyTemperatureLogLink_legacyTemperatureLogId_fkey" FOREIGN KEY ("legacyTemperatureLogId") REFERENCES "TemperatureLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "FactCustodyReceipt" ADD CONSTRAINT "FactCustodyReceipt_factId_fkey" FOREIGN KEY ("factId") REFERENCES "OperationalFact"("factId") ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
