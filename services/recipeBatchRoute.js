import { randomBytes as nodeRandomBytes } from "node:crypto";

const PUBLIC_REFERENCE = /^[A-Za-z0-9_-]{8,64}$/;

function boundedString(value, field, maximum = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
    throw new Error(`INVALID_${field}`);
  }
  return value.trim();
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`INVALID_${field}`);
  return value;
}

function timestamp(value, field) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`INVALID_${field}`);
  return date;
}

function opaqueReference(randomBytes) {
  return randomBytes(18).toString("base64url");
}

function qrUrl(reference, baseUrl) {
  if (!PUBLIC_REFERENCE.test(reference)) throw new Error("INVALID_PUBLIC_REFERENCE");
  const base = new URL(baseUrl);
  if (base.protocol !== "https:") throw new Error("INSECURE_QR_BASE_URL");
  return new URL(encodeURIComponent(reference), `${base.toString().replace(/\/$/, "")}/`).toString();
}

function publicBatch(record) {
  return {
    foodName: record.recipeVersion.recipe.name,
    ingredients: record.recipeVersion.ingredients,
    allergens: record.recipeVersion.allergens,
    storageInstructions: record.recipeVersion.storageInstructions,
    useByAt: record.useByAt,
    status: record.status === "quarantined" ? "recalled" : "available",
  };
}

export function createRecipeBatchRouteHandlers({
  prisma,
  randomBytes = nodeRandomBytes,
  now = () => new Date(),
  publicQrBaseUrl = "https://talkget.app/b",
}) {
  async function createApprovedRecipe(req, res) {
    try {
      const siteId = positiveInteger(req.currentUser?.siteId, "SITE_ID");
      const body = req.body ?? {};
      const name = boundedString(body.name, "RECIPE_NAME", 160);
      const version = positiveInteger(body.version, "RECIPE_VERSION");
      if (!Array.isArray(body.ingredients) || body.ingredients.length < 1 || body.ingredients.length > 100) throw new Error("INVALID_INGREDIENTS");
      if (!Array.isArray(body.allergens) || body.allergens.length > 14) throw new Error("INVALID_ALLERGENS");
      if (!Array.isArray(body.methodSteps) || body.methodSteps.length < 1 || body.methodSteps.length > 100) throw new Error("INVALID_METHOD_STEPS");
      if (!Array.isArray(body.criticalControls) || body.criticalControls.length > 50) throw new Error("INVALID_CRITICAL_CONTROLS");
      const approvedAt = now();

      const recipe = await prisma.recipe.create({
        data: {
          siteId,
          name,
          versions: {
            create: {
              version,
              status: "approved",
              ingredients: body.ingredients,
              allergens: body.allergens,
              methodSteps: body.methodSteps,
              criticalControls: body.criticalControls,
              cookingInstructions: body.cookingInstructions ? boundedString(body.cookingInstructions, "COOKING_INSTRUCTIONS", 5000) : null,
              coolingInstructions: body.coolingInstructions ? boundedString(body.coolingInstructions, "COOLING_INSTRUCTIONS", 5000) : null,
              storageInstructions: body.storageInstructions ? boundedString(body.storageInstructions, "STORAGE_INSTRUCTIONS", 2000) : null,
              defrostInstructions: body.defrostInstructions ? boundedString(body.defrostInstructions, "DEFROST_INSTRUCTIONS", 2000) : null,
              reheatingInstructions: body.reheatingInstructions ? boundedString(body.reheatingInstructions, "REHEATING_INSTRUCTIONS", 2000) : null,
              shelfLifeRuleId: body.shelfLifeRuleId === undefined ? null : positiveInteger(body.shelfLifeRuleId, "SHELF_LIFE_RULE_ID"),
              approvedById: req.currentUser.id,
              approvedAt,
              effectiveAt: approvedAt,
            },
          },
        },
        include: { versions: true },
      });
      return res.status(201).json({ success: true, recipe });
    } catch (error) {
      if (typeof error?.message === "string" && error.message.startsWith("INVALID_")) {
        return res.status(400).json({ success: false, error: error.message });
      }
      return res.status(500).json({ success: false, error: "RECIPE_CREATE_FAILED" });
    }
  }

  async function createBatch(req, res) {
    try {
      const siteId = positiveInteger(req.currentUser?.siteId, "SITE_ID");
      const body = req.body ?? {};
      const recipeVersionId = positiveInteger(body.recipeVersionId, "RECIPE_VERSION_ID");
      const recipeVersion = await prisma.recipeVersion.findFirst({
        where: { id: recipeVersionId, status: "approved", recipe: { siteId } },
        include: { recipe: true },
      });
      if (!recipeVersion) return res.status(409).json({ success: false, error: "APPROVED_RECIPE_VERSION_NOT_FOUND" });
      const madeAt = timestamp(body.madeAt, "MADE_AT");
      const useByAt = timestamp(body.useByAt, "USE_BY_AT");
      if (useByAt.getTime() <= madeAt.getTime()) throw new Error("INVALID_BATCH_SHELF_LIFE");
      const publicReference = opaqueReference(randomBytes);
      const storageLocation = boundedString(body.storageLocation, "STORAGE_LOCATION", 250);
      const batch = await prisma.$transaction(async (tx) => {
        const created = await tx.foodBatch.create({
          data: {
            siteId,
            recipeVersionId,
            publicReference,
            name: boundedString(body.name ?? recipeVersion.recipe.name, "BATCH_NAME", 160),
            batchCode: body.batchCode ? boundedString(body.batchCode, "BATCH_CODE", 128) : null,
            storageLocation,
            totalQuantity: body.totalQuantity ?? null,
            remainingQuantity: body.totalQuantity ?? null,
            unit: body.unit ? boundedString(body.unit, "UNIT", 40) : null,
            madeAt,
            useByAt,
            createdById: req.currentUser.id,
          },
        });
        await tx.foodBatchMovement.create({
          data: { foodBatchId: created.id, siteId, toStorageLocation: storageLocation, movementType: "created", movedById: req.currentUser.id, movedAt: madeAt },
        });
        return created;
      });
      return res.status(201).json({ success: true, batch, qrUrl: qrUrl(publicReference, publicQrBaseUrl) });
    } catch (error) {
      if (typeof error?.message === "string" && error.message.startsWith("INVALID_")) {
        return res.status(400).json({ success: false, error: error.message });
      }
      return res.status(500).json({ success: false, error: "BATCH_CREATE_FAILED" });
    }
  }

  async function resolveStaffBatch(req, res) {
    const reference = req.params.publicReference;
    if (!PUBLIC_REFERENCE.test(reference)) return res.status(400).json({ success: false, error: "INVALID_PUBLIC_REFERENCE" });
    const record = await prisma.foodBatch.findFirst({
      where: { publicReference: reference, siteId: req.currentUser.siteId },
      include: { recipeVersion: { include: { recipe: true } }, movements: { orderBy: { movedAt: "asc" } }, labels: { orderBy: { printedAt: "asc" } } },
    });
    if (!record?.recipeVersion) return res.status(404).json({ success: false, error: "BATCH_NOT_FOUND" });
    return res.json({ success: true, batch: record });
  }

  async function resolvePublicBatch(req, res) {
    const reference = req.params.publicReference;
    if (!PUBLIC_REFERENCE.test(reference)) return res.status(400).json({ success: false, error: "INVALID_PUBLIC_REFERENCE" });
    const record = await prisma.foodBatch.findUnique({
      where: { publicReference: reference },
      include: { recipeVersion: { include: { recipe: true } } },
    });
    if (!record?.recipeVersion || record.recipeVersion.status !== "approved") return res.status(404).json({ success: false, error: "BATCH_NOT_FOUND" });
    return res.json({ success: true, batch: publicBatch(record) });
  }

  return { createApprovedRecipe, createBatch, resolveStaffBatch, resolvePublicBatch };
}

export function registerRecipeBatchRoutes(app, dependencies) {
  const handlers = createRecipeBatchRouteHandlers(dependencies);
  app.post("/manager/recipes", dependencies.requireAuth, dependencies.requireManager, handlers.createApprovedRecipe);
  app.post("/food-batches", dependencies.requireAuth, dependencies.attachCurrentUser, handlers.createBatch);
  app.get("/food-batches/scan/:publicReference", dependencies.requireAuth, dependencies.attachCurrentUser, handlers.resolveStaffBatch);
  app.get("/public/food-batches/:publicReference", handlers.resolvePublicBatch);
  return handlers;
}
