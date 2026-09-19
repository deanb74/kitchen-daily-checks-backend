import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTemperatureCustodyPrismaAdapter } from "../services/temperatureCustodyPrismaAdapter.js";
import { createTemperatureCustodyRouteHandlers } from "../services/temperatureCustodyRoute.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SITE = 1001;
const CANONICAL_SITE_ID = "1001";

function operationalFactPayload(overrides = {}) {
  return {
    factId: "event-001",
    factType: "temperature.measurement",
    factVersion: "1",
    subject: { subjectType: "equipment", subjectId: "Walk-in Fridge" },
    scope: { scopeType: "venue", scopeId: CANONICAL_SITE_ID },
    source: { kind: "human", actorReference: "user-001" },
    provenance: { provenanceReference: "temperature:source-001" },
    relationships: [],
    observedAt: "2026-09-08T10:00:00.000Z",
    receivedAt: "2026-09-08T10:00:01.000Z",
    payload: { measurementType: "temperature", value: 8, unit: "celsius" },
    ...overrides,
  };
}

function validCanonicalBody(overrides = {}) {
  return {
    fridge: "Walk-in Fridge",
    value: 8,
    type: "fridge",
    operationalFact: operationalFactPayload(),
    ...overrides,
  };
}

function makeReq(body, currentUser = { siteId: SITE }) {
  return { body, currentUser };
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function makeRouteDependencies(overrides = {}) {
  const calls = [];
  const prisma = {
    temperatureLog: {
      async findFirst(args) {
        calls.push(["prisma.temperatureLog.findFirst", args]);
        return overrides.existingRecentLog ?? null;
      },
      async create(args) {
        calls.push(["prisma.temperatureLog.create", args]);
        return { id: 1, ...args.data, createdAt: new Date("2026-09-08T10:00:01.000Z") };
      },
      async findMany(args) {
        calls.push(["prisma.temperatureLog.findMany", args]);
        return overrides.getLogs ?? [];
      },
    },
    user: {
      async findMany(args) {
        calls.push(["prisma.user.findMany", args]);
        return overrides.managers ?? [];
      },
    },
  };
  const sendExpoPushNotificationsCalls = [];
  async function sendExpoPushNotifications(messages) {
    sendExpoPushNotificationsCalls.push(messages);
  }
  const custodyServiceCalls = [];
  const custodyService = {
    async recordTemperatureCustody(input) {
      custodyServiceCalls.push(input);
      if (overrides.custodyResult) {
        return typeof overrides.custodyResult === "function" ? overrides.custodyResult(input) : overrides.custodyResult;
      }
      return {
        mode: "custodied",
        factId: input.fact?.factId,
        legacyTemperatureLogId: 1,
        linkId: "link-id",
        custodyReceipt: { receiptId: "receipt-id" },
      };
    },
  };
  return { prisma, sendExpoPushNotifications, custodyService, calls, sendExpoPushNotificationsCalls, custodyServiceCalls };
}

// ---------------------------------------------------------------------------
// Adapter tests (real temperatureCustodyPrismaAdapter.js, fake Prisma client)
// ---------------------------------------------------------------------------

function makeFakePrisma(overrides = {}) {
  const calls = [];
  const state = { aggregateRecord: null, duplicateRows: [], nextLegacyId: 42, ...overrides };
  const tx = {
    operationalFact: {
      async findUnique(args) {
        calls.push(["operationalFact.findUnique", args]);
        return state.aggregateRecord;
      },
      async create(args) {
        calls.push(["operationalFact.create", args]);
        return { ...args.data };
      },
    },
    temperatureLog: {
      async findMany(args) {
        calls.push(["temperatureLog.findMany", args]);
        return state.duplicateRows;
      },
      async create(args) {
        calls.push(["temperatureLog.create", args]);
        return { id: state.nextLegacyId, ...args.data, createdAt: new Date("2026-09-08T10:00:01.000Z") };
      },
    },
    factLegacyTemperatureLogLink: {
      async create(args) {
        calls.push(["factLegacyTemperatureLogLink.create", args]);
        return { ...args.data };
      },
    },
    factCustodyReceipt: {
      async create(args) {
        calls.push(["factCustodyReceipt.create", args]);
        return { ...args.data };
      },
    },
  };
  return {
    calls,
    async $transaction(callback) {
      calls.push("$transaction-start");
      const result = await callback(tx);
      calls.push("$transaction-commit");
      return result;
    },
  };
}

test("adapter: runTransaction delegates to prisma.$transaction exactly once and resolves after commit", async () => {
  const fakePrisma = makeFakePrisma();
  const adapter = createTemperatureCustodyPrismaAdapter(fakePrisma);
  const result = await adapter.transactionRunner.runTransaction(async () => "callback-result");
  assert.equal(result, "callback-result");
  assert.deepEqual(fakePrisma.calls, ["$transaction-start", "$transaction-commit"]);
});

test("adapter: findCompleteCustodyAggregateByFactId issues the exact findUnique shape and reshapes zero/complete/incomplete results", async () => {
  const fakePrisma = makeFakePrisma({ aggregateRecord: null });
  const adapter = createTemperatureCustodyPrismaAdapter(fakePrisma);

  await adapter.transactionRunner.runTransaction(async (client) => {
    const zero = await client.findCompleteCustodyAggregateByFactId("event-001");
    assert.equal(zero, null);
  });
  const findUniqueCall = fakePrisma.calls.find((call) => Array.isArray(call) && call[0] === "operationalFact.findUnique");
  assert.deepEqual(findUniqueCall[1], {
    where: { factId: "event-001" },
    include: { legacyLink: { include: { legacyTemperatureLog: true } }, custodyReceipt: true },
  });

  const completeFake = makeFakePrisma({
    aggregateRecord: {
      factId: "event-001",
      factType: "temperature.measurement",
      legacyLink: { linkId: "link-1", factId: "event-001", legacyTemperatureLogId: 7, legacyTemperatureLog: { id: 7 } },
      custodyReceipt: { receiptId: "receipt-1", factId: "event-001" },
    },
  });
  const completeAdapter = createTemperatureCustodyPrismaAdapter(completeFake);
  await completeAdapter.transactionRunner.runTransaction(async (client) => {
    const aggregate = await client.findCompleteCustodyAggregateByFactId("event-001");
    assert.deepEqual(aggregate.fact, { factId: "event-001", factType: "temperature.measurement" });
    assert.deepEqual(aggregate.link, { linkId: "link-1", factId: "event-001", legacyTemperatureLogId: 7, legacyTemperatureLog: { id: 7 } });
    assert.deepEqual(aggregate.legacyTemperatureLog, { id: 7 });
    assert.deepEqual(aggregate.custodyReceipt, { receiptId: "receipt-1", factId: "event-001" });
  });

  for (const missingField of ["legacyLink", "custodyReceipt"]) {
    const incompleteFake = makeFakePrisma({
      aggregateRecord: {
        factId: "event-001",
        legacyLink: { linkId: "link-1", factId: "event-001", legacyTemperatureLogId: 7, legacyTemperatureLog: { id: 7 } },
        custodyReceipt: { receiptId: "receipt-1", factId: "event-001" },
        [missingField]: null,
      },
    });
    const incompleteAdapter = createTemperatureCustodyPrismaAdapter(incompleteFake);
    await incompleteAdapter.transactionRunner.runTransaction(async (client) => {
      const aggregate = await client.findCompleteCustodyAggregateByFactId("event-001");
      if (missingField === "legacyLink") {
        assert.equal(aggregate.link, null);
        assert.equal(aggregate.legacyTemperatureLog, null);
      } else {
        assert.equal(aggregate.custodyReceipt, null);
      }
    });
  }
});

test("adapter: findLegacyTemperatureDuplicates issues the exact where/orderBy/take shape", async () => {
  const fakePrisma = makeFakePrisma({ duplicateRows: [] });
  const adapter = createTemperatureCustodyPrismaAdapter(fakePrisma);
  const windowStartInclusive = new Date("2026-09-08T09:55:01.000Z");
  const windowEnd = new Date("2026-09-08T10:00:01.000Z");
  await adapter.transactionRunner.runTransaction(async (client) => {
    await client.findLegacyTemperatureDuplicates({ siteId: SITE, fridge: "Walk-in Fridge", type: "fridge", windowStartInclusive, windowEnd });
  });
  const call = fakePrisma.calls.find((item) => Array.isArray(item) && item[0] === "temperatureLog.findMany");
  assert.deepEqual(call[1], {
    where: { siteId: SITE, fridge: "Walk-in Fridge", type: "fridge", createdAt: { gte: windowStartInclusive, lte: windowEnd } },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 1,
  });
});

test("adapter: each create mapping calls exactly the named Prisma model with the exact supplied data", async () => {
  const fakePrisma = makeFakePrisma();
  const adapter = createTemperatureCustodyPrismaAdapter(fakePrisma);
  await adapter.transactionRunner.runTransaction(async (client) => {
    await client.createLegacyTemperatureLog({ siteId: SITE, fridge: "Walk-in Fridge", value: 8, type: "fridge" });
    await client.createOperationalFact({ factId: "event-001" });
    await client.createFactLegacyTemperatureLogLink({ linkId: "link-1", factId: "event-001", legacyTemperatureLogId: 42, linkMode: "NEW_LEGACY_RECORD" });
    await client.createFactCustodyReceipt({ receiptId: "receipt-1", factId: "event-001" });
  });
  const named = fakePrisma.calls.filter((item) => Array.isArray(item));
  assert.deepEqual(named.map((item) => item[0]), [
    "temperatureLog.create",
    "operationalFact.create",
    "factLegacyTemperatureLogLink.create",
    "factCustodyReceipt.create",
  ]);
  assert.deepEqual(named[0][1], { data: { siteId: SITE, fridge: "Walk-in Fridge", value: 8, type: "fridge" } });
  assert.deepEqual(named[1][1], { data: { factId: "event-001" } });
  assert.deepEqual(named[2][1], { data: { linkId: "link-1", factId: "event-001", legacyTemperatureLogId: 42, linkMode: "NEW_LEGACY_RECORD" } });
  assert.deepEqual(named[3][1], { data: { receiptId: "receipt-1", factId: "event-001" } });
});

test("adapter: isCanonicalFactIdUniqueConflict accepts only the two enumerated P2002 forms and rejects everything else", () => {
  const adapter = createTemperatureCustodyPrismaAdapter(makeFakePrisma());
  assert.equal(adapter.isCanonicalFactIdUniqueConflict({ code: "P2002", meta: { target: "OperationalFact_pkey" } }), true);
  assert.equal(adapter.isCanonicalFactIdUniqueConflict({ code: "P2002", meta: { target: ["factId"], modelName: "OperationalFact" } }), true);

  assert.equal(adapter.isCanonicalFactIdUniqueConflict(undefined), false);
  assert.equal(adapter.isCanonicalFactIdUniqueConflict({ code: "P2025" }), false);
  assert.equal(adapter.isCanonicalFactIdUniqueConflict({ code: "P2002" }), false);
  assert.equal(adapter.isCanonicalFactIdUniqueConflict({ code: "P2002", meta: { target: "FactLegacyTemperatureLogLink_factId_key" } }), false);
  assert.equal(adapter.isCanonicalFactIdUniqueConflict({ code: "P2002", meta: { target: ["factId"] } }), false);
  assert.equal(adapter.isCanonicalFactIdUniqueConflict({ code: "P2002", meta: { target: ["factId"], modelName: "FactLegacyTemperatureLogLink" } }), false);
  assert.equal(adapter.isCanonicalFactIdUniqueConflict({ code: "P2002", meta: { target: ["factId", "scopeId"], modelName: "OperationalFact" } }), false);
});

test("adapter: no real Prisma client import and no network use", () => {
  const source = fs.readFileSync(path.join(repoRoot, "services", "temperatureCustodyPrismaAdapter.js"), "utf8");
  assert.equal(source.includes("@prisma/client"), false);
  assert.equal(source.includes("fetch("), false);
  assert.equal(process.env.DATABASE_URL, undefined);
});

// ---------------------------------------------------------------------------
// Route tests (real temperatureCustodyRoute.js, fake prisma/custodyService)
// ---------------------------------------------------------------------------

test("route: a legacy request never invokes the custody service and uses only the legacy path", async () => {
  const dependencies = makeRouteDependencies();
  const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
  const req = makeReq({ fridge: "Walk-in Fridge", value: 8, type: "fridge" });
  const res = makeRes();
  await postTemperatures(req, res);
  assert.equal(dependencies.custodyServiceCalls.length, 0);
  assert.equal(dependencies.calls.some((call) => call[0] === "prisma.temperatureLog.findFirst"), true);
  assert.equal(dependencies.calls.some((call) => call[0] === "prisma.temperatureLog.create"), true);
  assert.deepEqual(res.body, { id: 1, fridge: "Walk-in Fridge", value: 8, type: "fridge", status: "amber", siteId: SITE, createdAt: res.body.createdAt });
});

test("route: own operationalFact: null selects the canonical path and is rejected as invalid-input without reaching legacy persistence or the custody service", async () => {
  const dependencies = makeRouteDependencies();
  const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
  const req = makeReq({ fridge: "Walk-in Fridge", value: 8, type: "fridge", operationalFact: null });
  const res = makeRes();
  await postTemperatures(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.mode, "invalid-input");
  assert.deepEqual(res.body.issues, [{ code: "invalid-request-body", path: "operationalFact" }]);
  assert.equal(dependencies.calls.some((call) => call[0] === "prisma.temperatureLog.findFirst"), false);
  assert.equal(dependencies.custodyServiceCalls.length, 0);
});

test("route: own operationalFact: undefined selects the canonical path and is rejected as invalid-input without reaching legacy persistence or the custody service", async () => {
  const dependencies = makeRouteDependencies();
  const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
  const req = makeReq({ fridge: "Walk-in Fridge", value: 8, type: "fridge", operationalFact: undefined });
  const res = makeRes();
  await postTemperatures(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body.issues, [{ code: "missing-field", path: "operationalFact" }]);
  assert.equal(dependencies.calls.some((call) => call[0] === "prisma.temperatureLog.findFirst"), false);
  assert.equal(dependencies.custodyServiceCalls.length, 0);
});

test("route: an operationalFact accessor is never invoked and is rejected through the canonical path", async () => {
  const dependencies = makeRouteDependencies();
  const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
  let getterCalls = 0;
  const body = { fridge: "Walk-in Fridge", value: 8, type: "fridge" };
  Object.defineProperty(body, "operationalFact", {
    get() {
      getterCalls += 1;
      return operationalFactPayload();
    },
    enumerable: true,
    configurable: true,
  });
  const req = makeReq(body);
  const res = makeRes();
  await postTemperatures(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body.issues, [{ code: "accessor-property", path: "operationalFact" }]);
  assert.equal(getterCalls, 0);
  assert.equal(dependencies.calls.some((call) => call[0] === "prisma.temperatureLog.findFirst"), false);
  assert.equal(dependencies.custodyServiceCalls.length, 0);
});

test("route: a valid canonical body reaches the custody service exactly once with the exact Increment 3 input shape", async () => {
  const dependencies = makeRouteDependencies();
  const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
  const req = makeReq(validCanonicalBody());
  const res = makeRes();
  await postTemperatures(req, res);
  assert.equal(dependencies.custodyServiceCalls.length, 1);
  const input = dependencies.custodyServiceCalls[0];
  assert.deepEqual(Object.keys(input).sort(), ["authenticatedSiteId", "fact", "legacy", "reconciliation", "validation"].sort());
  assert.equal(input.validation.valid, true);
  assert.equal(input.reconciliation.valid, true);
  assert.equal(input.authenticatedSiteId, CANONICAL_SITE_ID);
  assert.equal(input.fact.factId, "event-001");
  assert.deepEqual(input.legacy, { fridge: "Walk-in Fridge", type: "fridge", value: 8 });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { success: true, mode: "custodied", factId: "event-001", custodyReceipt: { receiptId: "receipt-id" } });
});

for (const [label, overrides] of [
  ["an unrecognized sibling field", { extra: "not-allowed" }],
  ["a caller-supplied authenticatedSiteId", { authenticatedSiteId: "9999" }],
  ["a caller-supplied databaseSiteId", { databaseSiteId: 9999 }],
  ["a caller-supplied receiptId", { receiptId: "caller-receipt" }],
  ["a caller-supplied persistenceId", { persistenceId: "caller-persistence" }],
  ["a caller-supplied custody timestamp", { recordedAt: "2026-09-08T10:00:02.000Z" }],
]) {
  test(`route: rejects ${label} as unrecognized-field before any Increment 1/custody-service call`, async () => {
    const dependencies = makeRouteDependencies();
    const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
    const req = makeReq(validCanonicalBody(overrides));
    const res = makeRes();
    await postTemperatures(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.mode, "invalid-input");
    assert.equal(res.body.issues.some((issue) => issue.code === "unrecognized-field"), true);
    assert.equal(dependencies.custodyServiceCalls.length, 0);
  });
}

test("route: an explicit undefined value for a required canonical key is rejected as missing-field", async () => {
  const dependencies = makeRouteDependencies();
  const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
  const body = validCanonicalBody({ operationalFact: undefined });
  const req = makeReq(body);
  const res = makeRes();
  await postTemperatures(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body.issues, [{ code: "missing-field", path: "operationalFact" }]);
  assert.equal(dependencies.custodyServiceCalls.length, 0);
});

test("route: an inherited (non-own) required property is treated as missing, never silently read", async () => {
  Object.prototype.fridge = "polluted-should-never-be-read";
  try {
    const dependencies = makeRouteDependencies();
    const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
    const body = { value: 8, type: "fridge", operationalFact: operationalFactPayload() };
    const req = makeReq(body);
    const res = makeRes();
    await postTemperatures(req, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body.issues, [{ code: "missing-field", path: "fridge" }]);
    assert.equal(dependencies.custodyServiceCalls.length, 0);
  } finally {
    delete Object.prototype.fridge;
  }
});

test("route: a body with an unsafe (non-Object.prototype) prototype is rejected as invalid-request-body", async () => {
  const dependencies = makeRouteDependencies();
  const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
  const body = Object.assign(Object.create({}), validCanonicalBody());
  const req = makeReq(body);
  const res = makeRes();
  await postTemperatures(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body.issues, [{ code: "invalid-request-body" }]);
  assert.equal(dependencies.custodyServiceCalls.length, 0);
});

test("route: an accessor property for a required key is rejected without ever invoking the getter", async () => {
  const dependencies = makeRouteDependencies();
  const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
  let getterCalls = 0;
  const body = { value: 8, type: "fridge", operationalFact: operationalFactPayload() };
  Object.defineProperty(body, "fridge", {
    get() {
      getterCalls += 1;
      return "Walk-in Fridge";
    },
    enumerable: true,
    configurable: true,
  });
  const req = makeReq(body);
  const res = makeRes();
  await postTemperatures(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body.issues, [{ code: "accessor-property", path: "fridge" }]);
  assert.equal(getterCalls, 0);
  assert.equal(dependencies.custodyServiceCalls.length, 0);
});

test("route: a dangerous top-level key is rejected without opening a transaction", async () => {
  const dependencies = makeRouteDependencies();
  const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
  const body = JSON.parse(`{"fridge":"Walk-in Fridge","value":8,"type":"fridge","operationalFact":{},"__proto__":{"polluted":true}}`);
  const req = makeReq(body);
  const res = makeRes();
  await postTemperatures(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(dependencies.custodyServiceCalls.length, 0);
});

for (const [label, siteId] of [
  ["missing siteId", undefined],
  ["null siteId", null],
  ["a string siteId", "1001"],
  ["a non-integer siteId", 10.5],
  ["a zero siteId", 0],
  ["a negative siteId", -1],
  ["an Int32-overflow siteId", 2147483648],
]) {
  test(`route: rejects ${label} as invalid-site-context before any Increment 1/custody-service call`, async () => {
    const dependencies = makeRouteDependencies();
    const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
    const req = makeReq(validCanonicalBody(), { siteId });
    const res = makeRes();
    await postTemperatures(req, res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { success: false, mode: "invalid-site-context" });
    assert.equal(dependencies.custodyServiceCalls.length, 0);
  });
}

test("route: a valid integer siteId is converted to the exact canonical string and passed identically to Increment 1 and Increment 3", async () => {
  const dependencies = makeRouteDependencies();
  const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
  const req = makeReq(validCanonicalBody(), { siteId: SITE });
  const res = makeRes();
  await postTemperatures(req, res);
  const input = dependencies.custodyServiceCalls[0];
  assert.equal(input.authenticatedSiteId, "1001");
  assert.equal(input.validation.valid, true);
});

test("route: a client-supplied site value inside the canonical envelope cannot override the authenticated site binding", async () => {
  const dependencies = makeRouteDependencies();
  const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
  const req = makeReq(validCanonicalBody({ operationalFact: operationalFactPayload({ scope: { scopeType: "venue", scopeId: "9999" } }) }));
  const res = makeRes();
  await postTemperatures(req, res);
  assert.equal(dependencies.custodyServiceCalls.length, 1);
  const input = dependencies.custodyServiceCalls[0];
  assert.equal(input.validation.valid, false);
  assert.equal(input.validation.issues.some((issue) => issue.code === "authenticated-site-mismatch"), true);
});

for (const [mode, status, resultOverride] of [
  ["custodied", 201, { mode: "custodied", factId: "event-001", custodyReceipt: { receiptId: "receipt-id" } }],
  ["replayed", 200, { mode: "replayed", factId: "event-001", custodyReceipt: { receiptId: "receipt-id" } }],
  ["conflicting-fact-id", 409, { mode: "conflicting-fact-id", factId: "event-001" }],
  ["incomplete-persisted-aggregate", 409, { mode: "incomplete-persisted-aggregate", factId: "event-001" }],
  ["transaction-failure", 500, { mode: "transaction-failure", factId: "event-001" }],
]) {
  test(`route: canonical result mode ${mode} produces the exact status/envelope and zero legacy fallback`, async () => {
    const dependencies = makeRouteDependencies({ custodyResult: resultOverride });
    const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
    const req = makeReq(validCanonicalBody());
    const res = makeRes();
    await postTemperatures(req, res);
    assert.equal(res.statusCode, status);
    assert.equal(res.body.mode, mode);
    assert.equal(dependencies.calls.some((call) => call[0] === "prisma.temperatureLog.create"), false);
    if (mode !== "custodied" && mode !== "replayed") {
      assert.equal(res.body.custodyReceipt, undefined);
    }
  });
}

test("route: a transaction-failure with no factId omits factId from the response", async () => {
  const dependencies = makeRouteDependencies({ custodyResult: { mode: "transaction-failure" } });
  const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
  const req = makeReq(validCanonicalBody());
  const res = makeRes();
  await postTemperatures(req, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { success: false, mode: "transaction-failure" });
});

test("route: canonical response bodies expose only the closed field set, with no internal data leakage", async () => {
  const dependencies = makeRouteDependencies({ custodyResult: { mode: "invalid-input", issues: [{ code: "invalid-fact-identity" }] } });
  const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
  const req = makeReq(validCanonicalBody());
  const res = makeRes();
  await postTemperatures(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(Object.keys(res.body).sort(), ["issues", "mode", "success"]);
});

test("route: an unrecognized custody-service result mode is treated as an internal error, not a success", async () => {
  const dependencies = makeRouteDependencies({ custodyResult: { mode: "unrecognized-future-mode" } });
  const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
  const req = makeReq(validCanonicalBody());
  const res = makeRes();
  await postTemperatures(req, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { success: false, mode: "internal-error" });
});

test("route: a throwing custody service produces the closed internal-error envelope, never a leaked message", async () => {
  const dependencies = makeRouteDependencies({
    custodyResult: () => {
      throw new Error("dependency defect: should never leak");
    },
  });
  const { postTemperatures } = createTemperatureCustodyRouteHandlers(dependencies);
  const req = makeReq(validCanonicalBody());
  const res = makeRes();
  await postTemperatures(req, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { success: false, mode: "internal-error" });
});

// ---------------------------------------------------------------------------
// Composition-root test (static source-contract inspection of index.js)
// ---------------------------------------------------------------------------

test("composition root: index.js imports and registers the Increment 4 route module exactly once, with the old inline handler removed and GET/startup unchanged", () => {
  const source = fs.readFileSync(path.join(repoRoot, "index.js"), "utf8");

  assert.match(source, /from "\.\/services\/temperatureCustodyRoute\.js"/);
  assert.match(source, /createTemperatureCustodyRouteDependencies/);
  assert.match(source, /registerTemperatureCustodyRoutes/);

  const registrationOccurrences = source.match(/registerTemperatureCustodyRoutes\(app,/g) ?? [];
  assert.equal(registrationOccurrences.length, 1);

  // The old inline POST handler body (five-minute duplicate lookup) must be fully removed from index.js.
  assert.equal(source.includes("existingRecentLog"), false);

  // Exactly one real Prisma client is constructed; no second instance is introduced.
  const prismaConstructions = source.match(/new PrismaClient\(\)/g) ?? [];
  assert.equal(prismaConstructions.length, 1);

  // Startup/listen behavior and an unrelated existing route remain present and unchanged.
  assert.match(source, /app\.listen\(PORT, HOST,/);
  assert.match(source, /app\.get\("\/staff\/dashboard"/);
});

test("no real database, Railway service, or network listener is used anywhere in this test file", () => {
  assert.equal(process.env.DATABASE_URL, undefined);
  const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const importLines = source.split("\n").filter((line) => /^\s*import\s/.test(line));
  assert.equal(importLines.some((line) => line.includes("@prisma/client")), false);
  assert.equal(importLines.some((line) => /express/i.test(line)), false);
});
