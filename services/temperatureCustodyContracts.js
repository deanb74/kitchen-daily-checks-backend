const freeze = Object.freeze;

export const OPERATIONAL_FACT_DEFINITION_KEY = "temperature.measurement@1";
export const FACT_TYPE = "temperature.measurement";
export const FACT_VERSION = "1";
export const LEGACY_TYPES = freeze(["fridge", "freezer"]);
export const DANGEROUS_KEYS = freeze(["__proto__", "constructor", "prototype"]);

export const FACT_FIELD_MAP = freeze({
  fact: freeze([
    "factId",
    "factType",
    "factVersion",
    "subject",
    "scope",
    "source",
    "provenance",
    "relationships",
    "observedAt",
    "receivedAt",
    "payload",
  ]),
  subject: freeze(["subjectType", "subjectId"]),
  scope: freeze(["scopeType", "scopeId"]),
  source: freeze(["kind", "actorReference"]),
  provenance: freeze(["provenanceReference"]),
  relationshipKinds: freeze({
    derivedFrom: freeze(["kind", "referencedFact"]),
    supports: freeze(["kind", "referencedEvidence"]),
  }),
  factIdentity: freeze(["factId", "factType", "factVersion"]),
  referencedEvidence: freeze(["evidenceId"]),
  payload: freeze(["measurementType", "value", "unit"]),
  request: freeze(["fridge", "value", "type", "operationalFact"]),
});

export const CANONICAL_RESPONSE_FIELDS = freeze([
  "success",
  "temperature",
  "operationalFact",
  "custodyReceipt",
]);

export const FAILURE_CATEGORIES = freeze([
  "invalid-operational-fact",
  "identity-conflict",
  "persistence-failure",
]);

export const PARITY_FIXTURE_NAMES = freeze([
  "valid-canonical-request",
  "valid-canonical-request-with-relationship",
  "unknown-top-level-field",
  "unknown-nested-field",
  "dangerous-key",
  "array-record-boundary",
  "missing-source-identity",
  "conflicting-source-identity",
  "invalid-subject-or-scope",
  "missing-provenance",
  "invalid-timestamp-order",
  "invalid-payload",
  "legacy-canonical-mismatch",
  "invalid-legacy-decimal",
  "legacy-whitespace",
  "legacy-exponent",
  "legacy-negative-zero",
  "legacy-unsupported-type",
  "authenticated-site-mismatch",
  "equivalent-replay",
  "conflicting-fact-id-reuse",
]);

export const LEGACY_DECIMAL_GRAMMAR = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

export const VALIDATION_POLICY = freeze({
  acceptsOrdinaryObjectPrototypeOnly: true,
  rejectsNullPrototypeObjects: true,
  rejectsArraysAtRecordBoundaries: true,
  rejectsDangerousKeys: true,
  rejectsWhitespaceAroundLegacyValue: true,
  rejectsExponentNotation: true,
  rejectsNegativeZero: true,
  comparesNumbersWithObjectIs: true,
  comparesRelationshipsInDeclaredOrder: true,
});

export const canonicalResponseModes = freeze({
  RECORDED_AND_CUSTODIED: "recorded-and-custodied",
  LEGACY_DUPLICATE_AND_CUSTODIED: "legacy-duplicate-and-custodied",
  IDEMPOTENT_REPLAY: "idempotent-replay",
});
