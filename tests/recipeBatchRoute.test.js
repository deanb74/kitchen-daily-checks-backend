import test from "node:test";
import assert from "node:assert/strict";
import { createRecipeBatchRouteHandlers } from "../services/recipeBatchRoute.js";

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function dependencies() {
  const recipeVersion = {
    id: 4,
    status: "approved",
    ingredients: [{ name: "Pasta", allergens: ["GLU", "EGG"] }],
    allergens: ["GLU", "EGG", "MIL"],
    methodSteps: [{ ordinal: 1, instruction: "Cook using the approved method." }],
    storageInstructions: "Keep refrigerated.",
    recipe: { id: 1, siteId: 7, name: "Beef lasagne" },
  };
  const state = { createdBatch: null, movement: null };
  const prisma = {
    recipe: { async create({ data }) { return { id: 1, ...data, versions: [data.versions.create] }; } },
    recipeVersion: { async findFirst() { return recipeVersion; } },
    foodBatch: {
      async findFirst() { return state.createdBatch ? { ...state.createdBatch, recipeVersion, movements: [state.movement], labels: [] } : null; },
      async findUnique() { return state.createdBatch ? { ...state.createdBatch, recipeVersion } : null; },
    },
    async $transaction(callback) {
      return callback({
        foodBatch: { async create({ data }) { state.createdBatch = { id: 22, status: "active", ...data }; return state.createdBatch; } },
        foodBatchMovement: { async create({ data }) { state.movement = { id: 31, ...data }; return state.movement; } },
      });
    },
  };
  return { prisma, state, recipeVersion };
}

test("creates a batch linked to an approved recipe and emits only an opaque QR reference", async () => {
  const { prisma, state } = dependencies();
  const handlers = createRecipeBatchRouteHandlers({
    prisma,
    randomBytes: () => Buffer.from("123456789012345678"),
    publicQrBaseUrl: "https://talkget.app/b",
  });
  const req = {
    currentUser: { id: 9, siteId: 7 },
    body: { recipeVersionId: 4, batchCode: "LAS-01", storageLocation: "Fridge 1 · Shelf 4", madeAt: "2026-09-21T09:30:00.000Z", useByAt: "2026-09-23T09:30:00.000Z" },
  };
  const res = response();
  await handlers.createBatch(req, res);
  assert.equal(res.statusCode, 201);
  assert.equal(state.createdBatch.recipeVersionId, 4);
  assert.equal(state.movement.movementType, "created");
  assert.match(res.body.qrUrl, /^https:\/\/talkget\.app\/b\/[A-Za-z0-9_-]+$/);
  assert.equal(res.body.qrUrl.includes("LAS-01"), false);
});

test("staff resolution includes method custody while public resolution filters internal fields", async () => {
  const { prisma, state } = dependencies();
  state.createdBatch = { id: 22, siteId: 7, publicReference: "opaqueRef123", name: "Beef lasagne", useByAt: new Date("2026-09-23T09:30:00.000Z"), status: "active", storageLocation: "Fridge 1 · Shelf 4" };
  state.movement = { id: 31, movementType: "created" };
  const handlers = createRecipeBatchRouteHandlers({ prisma });
  const staffRes = response();
  await handlers.resolveStaffBatch({ currentUser: { siteId: 7 }, params: { publicReference: "opaqueRef123" } }, staffRes);
  assert.equal(staffRes.body.batch.recipeVersion.methodSteps.length, 1);
  assert.equal(staffRes.body.batch.storageLocation, "Fridge 1 · Shelf 4");

  const publicRes = response();
  await handlers.resolvePublicBatch({ params: { publicReference: "opaqueRef123" } }, publicRes);
  assert.equal(publicRes.body.batch.foodName, "Beef lasagne");
  assert.equal("storageLocation" in publicRes.body.batch, false);
  assert.equal("methodSteps" in publicRes.body.batch, false);
});

test("rejects an unapproved or cross-site recipe version", async () => {
  const { prisma } = dependencies();
  prisma.recipeVersion.findFirst = async () => null;
  const handlers = createRecipeBatchRouteHandlers({ prisma });
  const res = response();
  await handlers.createBatch({ currentUser: { id: 9, siteId: 7 }, body: { recipeVersionId: 99 } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "APPROVED_RECIPE_VERSION_NOT_FOUND");
});
