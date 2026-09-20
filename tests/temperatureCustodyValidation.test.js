import test from "node:test";
import assert from "node:assert/strict";
import {
  FACT_FIELD_MAP,
  OPERATIONAL_FACT_DEFINITION_KEY,
  PARITY_FIXTURE_NAMES,
} from "../services/temperatureCustodyContracts.js";
import {
  areEquivalentValidatedFacts,
  classifyFactIdReuse,
  reconcileCanonicalRequest,
  validateOperationalFact,
} from "../services/temperatureCustodyValidation.js";

const SITE = "site-001";

function validFact(overrides = {}) {
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

function validRequest(fact = validFact(), legacy = { fridge: "Walk-in Fridge", value: "8", type: "fridge" }) {
  return { operationalFact: fact, legacy, authenticatedSiteReference: SITE };
}

function invalid(input) {
  const result = validateOperationalFact(input, SITE);
  assert.equal(result.valid, false);
  return result;
}

test("exports the closed registry field map and definition key", () => {
  assert.equal(OPERATIONAL_FACT_DEFINITION_KEY, "temperature.measurement@1");
  assert.deepEqual(FACT_FIELD_MAP.payload, ["measurementType", "value", "unit"]);
  assert.ok(PARITY_FIXTURE_NAMES.includes("dangerous-key"));
});

test("validates and freezes a complete canonical fact", () => {
  const result = validateOperationalFact(validFact(), SITE);
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.fact.factId, "event-001");
    assert.equal(Object.isFrozen(result.fact), true);
    assert.equal("recordedAt" in result.fact, false);
  }
});

test("freezes only a fresh trusted graph and isolates it from caller mutation", () => {
  const relationship = { kind: "supports", referencedEvidence: { evidenceId: "evidence-001" } };
  const input = validFact({ relationships: [relationship] });
  const result = validateOperationalFact(input, SITE);
  assert.equal(result.valid, true);
  if (!result.valid) return;

  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input.subject), false);
  assert.equal(Object.isFrozen(input.scope), false);
  assert.equal(Object.isFrozen(input.source), false);
  assert.equal(Object.isFrozen(input.provenance), false);
  assert.equal(Object.isFrozen(input.payload), false);
  assert.equal(Object.isFrozen(input.relationships), false);
  assert.equal(Object.isFrozen(relationship), false);
  assert.equal(Object.isFrozen(relationship.referencedEvidence), false);

  input.subject.subjectId = "changed-equipment";
  input.payload.value = 99;
  input.relationships[0].referencedEvidence.evidenceId = "changed-evidence";

  assert.equal(result.fact.subject.subjectId, "Walk-in Fridge");
  assert.equal(result.fact.payload.value, 8);
  assert.equal(result.fact.relationships[0].referencedEvidence.evidenceId, "evidence-001");
  assert.equal(Object.isFrozen(result.fact), true);
  assert.equal(Object.isFrozen(result.fact.subject), true);
  assert.equal(Object.isFrozen(result.fact.scope), true);
  assert.equal(Object.isFrozen(result.fact.source), true);
  assert.equal(Object.isFrozen(result.fact.provenance), true);
  assert.equal(Object.isFrozen(result.fact.payload), true);
  assert.equal(Object.isFrozen(result.fact.relationships), true);
  assert.equal(Object.isFrozen(result.fact.relationships[0]), true);
  assert.equal(Object.isFrozen(result.fact.relationships[0].referencedEvidence), true);
});

test("rejects null, arrays, primitives, and null-prototype records", () => {
  invalid(null);
  invalid([]);
  invalid("fact");
  invalid(Object.create(null));
});

test("rejects inherited required fields and inherited-only records", () => {
  const inherited = Object.create({ factId: "inherited" });
  Object.assign(inherited, validFact());
  delete inherited.factId;
  const result = invalid(inherited);
  assert.ok(result.issues.some((item) => item.path === "fact" && item.code === "invalid-record"));
  assert.equal(Object.prototype.hasOwnProperty.call(inherited, "factId"), false);
  assert.equal(result.fact, undefined);
});

test("does not accept polluted Object.prototype values for required or optional fields", () => {
  const previousFactId = Object.getOwnPropertyDescriptor(Object.prototype, "factId");
  const previousObservedAt = Object.getOwnPropertyDescriptor(Object.prototype, "observedAt");
  try {
    Object.defineProperty(Object.prototype, "factId", { value: "polluted", configurable: true });
    const missingRequired = validFact();
    delete missingRequired.factId;
    assert.equal(validateOperationalFact(missingRequired, SITE).valid, false);

    Object.defineProperty(Object.prototype, "observedAt", { value: "polluted", configurable: true });
    const missingOptional = validFact();
    delete missingOptional.observedAt;
    const result = validateOperationalFact(missingOptional, SITE);
    assert.equal(result.valid, true);
    if (result.valid) assert.equal("observedAt" in result.fact, false);
  } finally {
    if (previousFactId) Object.defineProperty(Object.prototype, "factId", previousFactId);
    else delete Object.prototype.factId;
    if (previousObservedAt) Object.defineProperty(Object.prototype, "observedAt", previousObservedAt);
    else delete Object.prototype.observedAt;
  }
});

test("rejects accessors without executing getters and rejects polluted nested prototypes", () => {
  let getterExecuted = false;
  const accessorFact = validFact();
  Object.defineProperty(accessorFact, "factId", {
    enumerable: true,
    configurable: true,
    get() {
      getterExecuted = true;
      return "getter-value";
    },
  });
  assert.equal(validateOperationalFact(accessorFact, SITE).valid, false);
  assert.equal(getterExecuted, false);

  const pollutedSubject = Object.create({ subjectId: "inherited-subject" });
  pollutedSubject.subjectType = "equipment";
  assert.equal(validateOperationalFact(validFact({ subject: pollutedSubject }), SITE).valid, false);
});

test("rejects dangerous keys at nested boundaries", () => {
  for (const path of ["fact", "subject", "scope", "source", "provenance", "payload"]) {
    const value = JSON.parse(JSON.stringify(validFact()));
    const target = path === "fact" ? value : value[path];
    Object.defineProperty(target, "__proto__", { value: "danger", enumerable: true });
    const result = invalid(value);
    assert.equal(result.valid, false, path);
  }
  invalid(JSON.parse('{"factId":"x","factType":"temperature.measurement","factVersion":"1","subject":{"subjectType":"equipment","subjectId":"x","constructor":true},"scope":{"scopeType":"venue","scopeId":"site-001"},"source":{"kind":"human","actorReference":"u"},"provenance":{"provenanceReference":"p"},"relationships":[],"receivedAt":"2026-09-08T10:00:00Z","payload":{"measurementType":"temperature","value":1,"unit":"celsius"}}'));
});

test("rejects dangerous keys in relationship and relationship-owned records", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const relationship = { kind: "supports", referencedEvidence: { evidenceId: "e" } };
    Object.defineProperty(relationship, key, { value: true, enumerable: true });
    assert.equal(validateOperationalFact(validFact({ relationships: [relationship] }), SITE).valid, false, key);

    const referencedEvidence = { evidenceId: "e" };
    Object.defineProperty(referencedEvidence, key, { value: true, enumerable: true });
    const nestedRelationship = { kind: "supports", referencedEvidence };
    assert.equal(validateOperationalFact(validFact({ relationships: [nestedRelationship] }), SITE).valid, false, `nested ${key}`);
  }
});

test("rejects arrays at every record boundary and non-arrays for relationships", () => {
  for (const field of ["subject", "scope", "source", "provenance", "payload"]) {
    invalid(validFact({ [field]: [] }));
  }
  invalid(validFact({ relationships: {} }));
  invalid(validFact({ relationships: [[]] }));
});

test("distinguishes omitted and explicit undefined by rejecting both as incomplete", () => {
  const omitted = validFact();
  delete omitted.receivedAt;
  invalid(omitted);
  invalid(validFact({ receivedAt: undefined }));
});

test("rejects unsupported definitions and immutable-state fields", () => {
  invalid(validFact({ factType: "equipment.fault" }));
  invalid(validFact({ factVersion: "2" }));
  for (const field of ["lifecycle", "recordedAt", "custodyReceipt", "validationOutcome", "transactionOutcome", "responseMode", "connectivity", "authority", "execution", "persistence"]) {
    invalid({ ...validFact(), [field]: true });
  }
});

test("enforces source, subject, scope, provenance, and timestamp rules", () => {
  invalid(validFact({ source: { kind: "human" } }));
  invalid(validFact({ source: { kind: "human", actorReference: "u", deviceReference: "d" } }));
  invalid(validFact({ subject: { subjectType: "venue", subjectId: "x" } }));
  invalid(validFact({ scope: { scopeType: "venue", scopeId: "other-site" } }));
  invalid(validFact({ provenance: {} }));
  invalid(validFact({ observedAt: "2026-09-08T10:00:02Z" }));
  invalid(validFact({ receivedAt: "not-time" }));
});

test("enforces temperature payload and finite number rules", () => {
  invalid(validFact({ payload: { measurementType: "temperature", value: NaN, unit: "celsius" } }));
  invalid(validFact({ payload: { measurementType: "temperature", value: Infinity, unit: "celsius" } }));
  invalid(validFact({ payload: { measurementType: "temperature", value: -0, unit: "celsius" } }));
  invalid(validFact({ payload: { measurementType: "temperature", value: 1, unit: "fahrenheit" } }));
  invalid(validFact({ payload: { measurementType: "humidity", value: 1, unit: "celsius" } }));
});

test("accepts derivedFrom and supports relationships in declared order", () => {
  const fact = validFact({
    relationships: [
      { kind: "derivedFrom", referencedFact: { factId: "f", factType: "temperature.measurement", factVersion: "1" } },
      { kind: "supports", referencedEvidence: { evidenceId: "e" } },
    ],
  });
  const result = validateOperationalFact(fact, SITE);
  assert.equal(result.valid, true);
});

test("reconciles canonical and legacy fields exactly", () => {
  const result = reconcileCanonicalRequest(validRequest(), SITE);
  assert.equal(result.valid, true);
  for (const value of [" 8", "8 ", "8e0", "08", "-0", "NaN", "Infinity"]) {
    assert.equal(reconcileCanonicalRequest(validRequest(validFact({ payload: { measurementType: "temperature", value: 8, unit: "celsius" } }), { fridge: "Walk-in Fridge", value, type: "fridge" }), SITE).valid, false, value);
  }
  assert.equal(reconcileCanonicalRequest(validRequest(validFact(), { fridge: "Other", value: "8", type: "fridge" }), SITE).valid, false);
  assert.equal(reconcileCanonicalRequest(validRequest(validFact(), { fridge: "Walk-in Fridge", value: "8.0", type: "fridge" }), SITE).valid, true);
  assert.equal(reconcileCanonicalRequest(validRequest(validFact(), { fridge: "Walk-in Fridge", value: "8", type: "oven" }), SITE).valid, false);
  assert.equal(reconcileCanonicalRequest(validRequest(validFact({ scope: { scopeType: "venue", scopeId: "other" } }), undefined), SITE).valid, false);
});

test("does not insert legacy equipment type into the canonical fact", () => {
  const result = validateOperationalFact(validFact(), SITE);
  assert.equal(result.valid, true);
  if (result.valid) assert.equal("equipmentType" in result.fact, false);
});

test("compares complete facts independent of property order but preserves array order", () => {
  const first = validateOperationalFact(validFact(), SITE);
  const second = validateOperationalFact({
    payload: { unit: "celsius", value: 8, measurementType: "temperature" },
    receivedAt: "2026-09-08T10:00:01.000Z",
    observedAt: "2026-09-08T10:00:00.000Z",
    relationships: [],
    provenance: { provenanceReference: "temperature:source-001" },
    source: { actorReference: "user-001", kind: "human" },
    scope: { scopeId: SITE, scopeType: "venue" },
    subject: { subjectId: "Walk-in Fridge", subjectType: "equipment" },
    factVersion: "1",
    factType: "temperature.measurement",
    factId: "event-001",
  }, SITE);
  assert.equal(first.valid && second.valid && areEquivalentValidatedFacts(first.fact, second.fact), true);
  const changed = validateOperationalFact(validFact({ relationships: [{ kind: "supports", referencedEvidence: { evidenceId: "e" } }] }), SITE);
  assert.equal(first.valid && changed.valid && areEquivalentValidatedFacts(first.fact, changed.fact), false);
});

test("classifies exact replay and conflicting fact-id reuse without persistence access", () => {
  const first = validateOperationalFact(validFact(), SITE);
  const same = validateOperationalFact(validFact(), SITE);
  const different = validateOperationalFact(validFact({ payload: { measurementType: "temperature", value: 7, unit: "celsius" } }), SITE);
  assert.equal(first.valid && same.valid && classifyFactIdReuse(first.fact, same.fact), "idempotent-replay");
  assert.equal(first.valid && different.valid && classifyFactIdReuse(first.fact, different.fact), "identity-conflict");
});

test("keeps legacy-only requests outside canonical validation", () => {
  const legacy = { fridge: "Walk-in Fridge", value: "8", type: "fridge" };
  assert.equal(reconcileCanonicalRequest({ operationalFact: undefined, legacy, authenticatedSiteReference: SITE }).valid, false);
});
