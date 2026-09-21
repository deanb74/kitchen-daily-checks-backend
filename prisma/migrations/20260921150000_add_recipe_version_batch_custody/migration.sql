CREATE TABLE "Recipe" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecipeVersion" (
    "id" SERIAL NOT NULL,
    "recipeId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "ingredients" JSONB NOT NULL,
    "allergens" JSONB NOT NULL,
    "methodSteps" JSONB NOT NULL,
    "criticalControls" JSONB NOT NULL,
    "cookingInstructions" TEXT,
    "coolingInstructions" TEXT,
    "storageInstructions" TEXT,
    "defrostInstructions" TEXT,
    "reheatingInstructions" TEXT,
    "shelfLifeRuleId" INTEGER,
    "approvedById" INTEGER,
    "approvedAt" TIMESTAMP(3),
    "effectiveAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecipeVersion_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "FoodBatch"
ADD COLUMN "recipeVersionId" INTEGER,
ADD COLUMN "publicReference" TEXT;

CREATE UNIQUE INDEX "Recipe_siteId_name_key" ON "Recipe"("siteId", "name");
CREATE UNIQUE INDEX "RecipeVersion_recipeId_version_key" ON "RecipeVersion"("recipeId", "version");
CREATE UNIQUE INDEX "FoodBatch_publicReference_key" ON "FoodBatch"("publicReference");

ALTER TABLE "RecipeVersion"
ADD CONSTRAINT "RecipeVersion_recipeId_fkey"
FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FoodBatch"
ADD CONSTRAINT "FoodBatch_recipeVersionId_fkey"
FOREIGN KEY ("recipeVersionId") REFERENCES "RecipeVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
