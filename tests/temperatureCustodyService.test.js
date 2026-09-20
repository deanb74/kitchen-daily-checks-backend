import test from "node:test";
import assert from "node:assert/strict";
import { createTemperatureCustodyService } from "../services/temperatureCustodyService.js";
import { validateOperationalFact, reconcileCanonicalRequest } from "../services/temperatureCustodyValidation.js";

const SITE = "1001";

function fact(overrides = {}) {
  return {
    factId: "event-001",
    factType: "temperature.measurement",
    factVersion: "1",
    subject: { subjectType: "equipment", subjectId: "Walk-in Fridge" },
    scope: { scopeType: "venue", scopeId: SITE },
    source: { kind: "human", actorReference: "user-001" },
    provenance: { provenanceReference: "temperature:source-001" },
    relationships: [],
    observedAt: "2026-09-08T10:00:00.000Z",
    receivedAt: "2026-09-08T10:00:01.000Z",
    payload: { measurementType: "temperature", value: 8, unit: "celsius" },
    ...overrides,
  };
}

function legacy(overrides = {}) {
  return { fridge: "Walk-in Fridge", value: 8, type: "fridge", ...overrides };
}

function trustedInput(factValue = fact(), legacyValue = legacy(), site = SITE) {
  const validation = validateOperationalFact(factValue, site);
  const reconciliation = reconcileCanonicalRequest({ operationalFact: factValue, legacy: { ...legacyValue, value: String(legacyValue.value) }, authenticatedSiteReference: site });
  assert.equal(validation.valid, true);
  assert.equal(reconciliation.valid, true);
  return {
    validation,
    reconciliation,
    fact: validation.fact,
    legacy: legacyValue,
    authenticatedSiteId: site,
  };
}

function invalidSiteInput(scopeId) {
  return trustedInput(fact({ scope: { scopeType: "venue", scopeId } }), legacy(), scopeId);
}

function persistedFactFromCanonical(value) {
  return {
    factId: value.factId,
    factType: value.factType,
    factVersion: value.factVersion,
    subjectType: value.subject.subjectType,
    subjectId: value.subject.subjectId,
    scopeType: value.scope.scopeType,
    scopeId: value.scope.scopeId,
    sourceKind: value.source.kind,
    actorReference: value.source.actorReference,
    provenanceReference: value.provenance.provenanceReference,
    observedAt: value.observedAt === undefined ? null : new Date(value.observedAt),
    receivedAt: new Date(value.receivedAt),
    payload: value.payload,
    relationships: value.relationships,
  };
}

function makeDependencies(overrides = {}) {
  const calls = [];
  const ids = ["link-uuid", "receipt-uuid", "persistence-uuid"];
  const state = {
    aggregate: null,
    duplicates: [],
    nextLegacyId: 42,
    failAt: null,
    pauseBeforeCommit: false,
    ...overrides,
  };
  let releaseCommit;
  const transactionRunner = {
    calls,
    async runTransaction(callback) {
      calls.push("callback-start");
      const client = makeClient(state, calls);
      const result = await callback(client);
      calls.push("callback-complete");
      if (state.pauseBeforeCommit) await new Promise(resolve => { releaseCommit = resolve; });
      if (state.failAt === "commit") throw new Error("commit failed");
      calls.push("commit");
      return result;
    },
    releaseCommit() {
      releaseCommit?.();
    },
  };
  return {
    transactionRunner,
    randomUUID: () => ids.shift() ?? `uuid-${ids.length}`,
    now: () => new Date("2026-09-08T10:00:02.000Z"),
    isCanonicalFactIdUniqueConflict: error => error?.code === "P2002" && error?.meta?.target === "factId",
    state,
    calls,
  };
}

function makeClient(state, calls) {
  return {
    async findCompleteCustodyAggregateByFactId(factId) {
      calls.push(["find-aggregate", factId]);
      if (state.failAt === "find-aggregate") throw new Error("find failed");
      return state.aggregate;
    },
    async findLegacyTemperatureDuplicates(input) {
      calls.push(["find-duplicates", input]);
      if (state.failAt === "find-duplicates") throw new Error("duplicates failed");
      return state.duplicates
        .filter(row => row.createdAt.getTime() >= input.windowStartInclusive.getTime() && row.createdAt.getTime() <= input.windowEnd.getTime())
        .slice()
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || left.id - right.id);
    },
    async createLegacyTemperatureLog(data) {
      calls.push(["create-legacy", data]);
      if (state.failAt === "create-legacy") throw new Error("legacy failed");
      return { id: state.nextLegacyId, ...data, createdAt: new Date("2026-09-08T10:00:01.000Z") };
    },
    async createOperationalFact(data) {
      calls.push(["create-fact", data]);
      if (state.failAt === "create-fact") throw new Error("fact failed");
      return data;
    },
    async createFactLegacyTemperatureLogLink(data) {
      calls.push(["create-link", data]);
      if (state.failAt === "create-link") throw new Error("link failed");
      return { ...data, linkedAt: new Date("2026-09-08T10:00:02.000Z") };
    },
    async createFactCustodyReceipt(data) {
      calls.push(["create-receipt", data]);
      if (state.failAt === "create-receipt") throw new Error("receipt failed");
      return data;
    },
  };
}

test("records atomic custody and exposes the receipt only after commit", async () => {
  const dependencies = makeDependencies({ pauseBeforeCommit: true });
  const service = createTemperatureCustodyService(dependencies);
  const pending = service.recordTemperatureCustody(trustedInput());
  let settled = false;
  pending.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  dependencies.transactionRunner.releaseCommit();
  const result = await pending;
  assert.equal(result.mode, "custodied");
  assert.equal(result.linkId, "link-uuid");
  assert.equal(result.custodyReceipt.receiptId, "receipt-uuid");
  assert.equal(result.custodyReceipt.persistenceId, "persistence-uuid");
  assert.deepEqual(dependencies.calls.map(item => Array.isArray(item) ? item[0] : item), [
    "callback-start",
    "find-aggregate",
    "find-duplicates",
    "create-legacy",
    "create-fact",
    "create-link",
    "create-receipt",
    "callback-complete",
    "commit",
  ]);
  const duplicatesCall = dependencies.calls.find(item => Array.isArray(item) && item[0] === "find-duplicates");
  const legacyCall = dependencies.calls.find(item => Array.isArray(item) && item[0] === "create-legacy");
  assert.equal(duplicatesCall[1].siteId, Number(SITE));
  assert.equal(legacyCall[1].siteId, Number(SITE));
  assert.equal(duplicatesCall[1].siteId, legacyCall[1].siteId);
});

for (const failure of ["find-aggregate", "find-duplicates", "create-legacy", "create-fact", "create-link", "create-receipt", "commit"]) {
  test(`returns transaction failure without receipt on ${failure}`, async () => {
    const service = createTemperatureCustodyService(makeDependencies({ failAt: failure }));
    const result = await service.recordTemperatureCustody(trustedInput());
    assert.equal(result.mode, "transaction-failure");
    assert.equal(result.custodyReceipt, undefined);
  });
}

test("returns exact committed replay for a complete equal aggregate", async () => {
  const input = trustedInput();
  const aggregate = {
    fact: persistedFactFromCanonical(input.fact),
    legacyTemperatureLog: { id: 7 },
    link: { linkId: "link-existing", factId: input.fact.factId, legacyTemperatureLogId: 7 },
    custodyReceipt: { receiptId: "receipt-existing", factId: input.fact.factId },
  };
  const service = createTemperatureCustodyService(makeDependencies({ aggregate }));
  const result = await service.recordTemperatureCustody(input);
  assert.equal(result.mode, "replayed");
  assert.equal(result.custodyReceipt.receiptId, "receipt-existing");
});

test("rejects conflicting fact identity and incomplete aggregate", async () => {
  const input = trustedInput();
  const conflicting = {
    fact: { ...persistedFactFromCanonical(input.fact), payload: { measurementType: "temperature", value: 9, unit: "celsius" } },
    legacyTemperatureLog: { id: 7 },
    link: { linkId: "link-existing", factId: input.fact.factId, legacyTemperatureLogId: 7 },
    custodyReceipt: { receiptId: "receipt-existing", factId: input.fact.factId },
  };
  let result = await createTemperatureCustodyService(makeDependencies({ aggregate: conflicting })).recordTemperatureCustody(input);
  assert.equal(result.mode, "conflicting-fact-id");
  const incomplete = { ...conflicting, custodyReceipt: undefined };
  result = await createTemperatureCustodyService(makeDependencies({ aggregate: incomplete })).recordTemperatureCustody(input);
  assert.equal(result.mode, "incomplete-persisted-aggregate");
});

test("recovers exact canonical factId unique conflict once without writes", async () => {
  const input = trustedInput();
  const aggregate = {
    fact: persistedFactFromCanonical(input.fact),
    legacyTemperatureLog: { id: 8 },
    link: { linkId: "link-existing", factId: input.fact.factId, legacyTemperatureLogId: 8 },
    custodyReceipt: { receiptId: "receipt-existing", factId: input.fact.factId },
  };
  const dependencies = makeDependencies({ aggregate, failAt: "create-fact" });
  let invocationCount = 0;
  dependencies.transactionRunner.runTransaction = async cb => {
    invocationCount += 1;
    if (invocationCount === 1) {
      throw { code: "P2002", meta: { target: "factId" } };
    }
    if (invocationCount === 2) {
      dependencies.calls.push("callback-start");
      const result = await cb(makeClient(dependencies.state, dependencies.calls));
      dependencies.calls.push("callback-complete");
      dependencies.calls.push("commit");
      return result;
    }
    throw new Error(`unexpected transaction invocation ${invocationCount}`);
  };
  const result = await createTemperatureCustodyService(dependencies).recordTemperatureCustody(input);
  assert.equal(result.mode, "replayed");
  assert.equal(result.custodyReceipt.receiptId, "receipt-existing");
  assert.equal(invocationCount, 2);
  assert.equal(
    dependencies.calls.some(item => Array.isArray(item) && item[0] === "find-aggregate"),
    true,
  );
  assert.equal(dependencies.calls.some(item => Array.isArray(item) && item[0].startsWith("create-")), false);
  assert.equal(dependencies.calls.filter(item => item === "commit").length, 1);
});

test("does not classify unrelated unique errors as replay", async () => {
  const dependencies = makeDependencies({ failAt: "create-fact" });
  dependencies.transactionRunner.runTransaction = async () => {
    throw { code: "P2002", meta: { target: "legacyTemperatureLogId" } };
  };
  const result = await createTemperatureCustodyService(dependencies).recordTemperatureCustody(trustedInput());
  assert.equal(result.mode, "transaction-failure");
});

test("selects newest duplicate at inclusive lower boundary with ID tie-break despite unordered fake input", async () => {
  const boundary = new Date("2026-09-08T09:55:01.000Z");
  const dependencies = makeDependencies({
    duplicates: [
      { id: 10, createdAt: boundary },
      { id: 2, createdAt: boundary },
    ],
  });
  const result = await createTemperatureCustodyService(dependencies).recordTemperatureCustody(trustedInput());
  const query = dependencies.calls.find(item => Array.isArray(item) && item[0] === "find-duplicates")[1];
  assert.equal(query.windowStartInclusive.toISOString(), boundary.toISOString());
  assert.deepEqual(query.orderBy, [{ createdAt: "desc" }, { id: "asc" }]);
  assert.equal(result.legacyTemperatureLogId, 2);
  assert.equal(dependencies.calls.some(item => Array.isArray(item) && item[0] === "create-legacy"), false);
});

test("excludes a duplicate outside the five-minute window and creates a new legacy row", async () => {
  const outsideWindow = new Date("2026-09-08T09:55:00.999Z");
  const dependencies = makeDependencies({
    duplicates: [{ id: 99, createdAt: outsideWindow }],
  });
  const result = await createTemperatureCustodyService(dependencies).recordTemperatureCustody(trustedInput());
  assert.equal(dependencies.calls.some(item => Array.isArray(item) && item[0] === "create-legacy"), true);
  assert.equal(result.legacyTemperatureLogId, dependencies.state.nextLegacyId);
});

test("rejects invalid input, caller-owned custody fields and site mismatch without transaction", async () => {
  const service = createTemperatureCustodyService(makeDependencies());
  assert.equal((await service.recordTemperatureCustody({})).mode, "invalid-input");
  assert.equal((await service.recordTemperatureCustody({ ...trustedInput(), receiptId: "caller" })).mode, "invalid-input");
  assert.equal((await service.recordTemperatureCustody({ ...trustedInput(), authenticatedSiteId: "other" })).mode, "invalid-input");
});

for (const invalidSite of [
  "site-001",
  " 1001",
  "1001 ",
  "+1001",
  "-1001",
  "10.01",
  "1e3",
  "01001",
  "0",
  "9007199254740993",
  "2147483648",
]) {
  test(`rejects invalid database site id "${invalidSite}" before opening a transaction`, async () => {
    const dependencies = makeDependencies();
    const service = createTemperatureCustodyService(dependencies);
    const result = await service.recordTemperatureCustody(invalidSiteInput(invalidSite));
    assert.equal(result.mode, "invalid-input");
    assert.deepEqual(dependencies.calls, []);
  });
}

test("exposes no receipt before recovery transaction commit and returns it only after commit", async () => {
  const input = trustedInput();
  const aggregate = {
    fact: persistedFactFromCanonical(input.fact),
    legacyTemperatureLog: { id: 8 },
    link: { linkId: "link-existing", factId: input.fact.factId, legacyTemperatureLogId: 8 },
    custodyReceipt: { receiptId: "receipt-existing", factId: input.fact.factId },
  };
  const dependencies = makeDependencies({ aggregate, failAt: "create-fact" });
  let invocationCount = 0;
  let releaseRecoveryCommit;
  dependencies.transactionRunner.runTransaction = async cb => {
    invocationCount += 1;
    if (invocationCount === 1) {
      throw { code: "P2002", meta: { target: "factId" } };
    }
    if (invocationCount === 2) {
      dependencies.calls.push("callback-start");
      const result = await cb(makeClient(dependencies.state, dependencies.calls));
      dependencies.calls.push("callback-complete");
      await new Promise(resolve => { releaseRecoveryCommit = resolve; });
      dependencies.calls.push("commit");
      return result;
    }
    throw new Error(`unexpected transaction invocation ${invocationCount}`);
  };
  const service = createTemperatureCustodyService(dependencies);
  const pending = service.recordTemperatureCustody(input);
  let settled = false;
  pending.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  releaseRecoveryCommit();
  const result = await pending;
  assert.equal(settled, true);
  assert.equal(result.mode, "replayed");
  assert.equal(result.custodyReceipt.receiptId, "receipt-existing");
});

test("returns transaction failure without receipt when recovery transaction commit fails", async () => {
  const input = trustedInput();
  const aggregate = {
    fact: persistedFactFromCanonical(input.fact),
    legacyTemperatureLog: { id: 8 },
    link: { linkId: "link-existing", factId: input.fact.factId, legacyTemperatureLogId: 8 },
    custodyReceipt: { receiptId: "receipt-existing", factId: input.fact.factId },
  };
  const dependencies = makeDependencies({ aggregate, failAt: "create-fact" });
  let invocationCount = 0;
  dependencies.transactionRunner.runTransaction = async cb => {
    invocationCount += 1;
    if (invocationCount === 1) {
      throw { code: "P2002", meta: { target: "factId" } };
    }
    if (invocationCount === 2) {
      await cb(makeClient(dependencies.state, dependencies.calls));
      throw new Error("recovery commit failed");
    }
    throw new Error(`unexpected transaction invocation ${invocationCount}`);
  };
  const result = await createTemperatureCustodyService(dependencies).recordTemperatureCustody(input);
  assert.equal(result.mode, "transaction-failure");
  assert.equal(result.custodyReceipt, undefined);
  assert.equal(invocationCount, 2);
});

test("rejects a missing or malformed transactionRunner at construction", () => {
  const dependencies = makeDependencies();
  assert.throws(() => createTemperatureCustodyService({ ...dependencies, transactionRunner: undefined }), TypeError);
  assert.throws(() => createTemperatureCustodyService({ ...dependencies, transactionRunner: {} }), TypeError);
  assert.throws(() => createTemperatureCustodyService({ ...dependencies, transactionRunner: { runTransaction: "not-a-function" } }), TypeError);
});

test("rejects a missing or malformed uniqueness classifier at construction", () => {
  const dependencies = makeDependencies();
  assert.throws(() => createTemperatureCustodyService({ ...dependencies, isCanonicalFactIdUniqueConflict: undefined }), TypeError);
  assert.throws(() => createTemperatureCustodyService({ ...dependencies, isCanonicalFactIdUniqueConflict: "not-a-function" }), TypeError);
});

test("propagates a throwing uniqueness classifier as a dependency failure instead of replay or success", async () => {
  const dependencies = makeDependencies({ failAt: "create-fact" });
  dependencies.isCanonicalFactIdUniqueConflict = () => { throw new Error("classifier defect"); };
  dependencies.transactionRunner.runTransaction = async () => {
    throw { code: "P2002", meta: { target: "factId" } };
  };
  await assert.rejects(
    () => createTemperatureCustodyService(dependencies).recordTemperatureCustody(trustedInput()),
    /classifier defect/,
  );
});

test("module and tests use only injected fakes", () => {
  assert.equal(typeof createTemperatureCustodyService, "function");
  assert.equal(process.env.DATABASE_URL, undefined);
});
