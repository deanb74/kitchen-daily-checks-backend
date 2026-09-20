import {
  DANGEROUS_KEYS,
  FACT_FIELD_MAP,
  FACT_TYPE,
  FACT_VERSION,
  LEGACY_DECIMAL_GRAMMAR,
  LEGACY_TYPES,
  OPERATIONAL_FACT_DEFINITION_KEY,
} from "./temperatureCustodyContracts.js";

const dangerousKeySet = new Set(DANGEROUS_KEYS);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isWireRecord(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasDangerousKey(value) {
  return Reflect.ownKeys(value).some((key) => typeof key === "string" && dangerousKeySet.has(key));
}

function ownValue(value, key) {
  if (!hasOwn(value, key)) return { present: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    return { present: true, accessor: true, value: undefined };
  }
  return { present: true, accessor: false, value: descriptor.value };
}

function hasAccessorProperty(value) {
  return Reflect.ownKeys(value).some((key) => typeof key === "string" && ownValue(value, key).accessor === true);
}

function exactKeys(value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && !dangerousKeySet.has(key) && allowed.has(key));
}

function requiredOwn(value, key) {
  return hasOwn(value, key) && value[key] !== undefined;
}

function text(value) {
  return typeof value === "string" && value.length > 0;
}

function timestamp(value) {
  return text(value) && !Number.isNaN(Date.parse(value));
}

function issue(path, code, message) {
  return { path, code, message };
}

function recordIssues(value, path, allowedKeys) {
  if (!isWireRecord(value)) {
    return [issue(path, "invalid-record", "Expected an ordinary JSON object record.")];
  }
  if (hasDangerousKey(value)) {
    return [issue(path, "dangerous-key", "Dangerous prototype-sensitive keys are forbidden.")];
  }
  if (hasAccessorProperty(value)) {
    return [issue(path, "accessor-property", "Accessor properties are forbidden.")];
  }
  if (!exactKeys(value, allowedKeys)) {
    return [issue(path, "unknown-field", "The record contains an undeclared field.")];
  }
  return [];
}

function validateSubject(value) {
  const issues = recordIssues(value, "subject", FACT_FIELD_MAP.subject);
  if (issues.length > 0) return issues;
  const subjectType = ownValue(value, "subjectType").value;
  const subjectId = ownValue(value, "subjectId").value;
  if (subjectType !== "equipment" || !text(subjectId)) {
    return [issue("subject", "invalid-subject", "An equipment subject with a non-empty subjectId is required.")];
  }
  return [];
}

function validateScope(value, authenticatedSiteReference) {
  const issues = recordIssues(value, "scope", FACT_FIELD_MAP.scope);
  if (issues.length > 0) return issues;
  const scopeType = ownValue(value, "scopeType").value;
  const scopeId = ownValue(value, "scopeId").value;
  if (scopeType !== "venue" || !text(scopeId)) {
    return [issue("scope", "invalid-scope", "A venue scope with a non-empty scopeId is required.")];
  }
  if (authenticatedSiteReference !== undefined && scopeId !== authenticatedSiteReference) {
    return [issue("scope.scopeId", "authenticated-site-mismatch", "The scope must equal the authenticated site reference.")];
  }
  return [];
}

function validateSource(value) {
  const issues = recordIssues(value, "source", FACT_FIELD_MAP.source);
  if (issues.length > 0) return issues;
  const kind = ownValue(value, "kind").value;
  const actorReference = ownValue(value, "actorReference").value;
  if (kind !== "human" || !text(actorReference)) {
    return [issue("source", "invalid-source", "A human source with an actorReference is required.")];
  }
  return [];
}

function validateProvenance(value) {
  const issues = recordIssues(value, "provenance", FACT_FIELD_MAP.provenance);
  if (issues.length > 0) return issues;
  if (!text(ownValue(value, "provenanceReference").value)) {
    return [issue("provenance.provenanceReference", "missing-provenance", "A provenance reference is required.")];
  }
  return [];
}

function validateFactIdentity(value, path) {
  const issues = recordIssues(value, path, FACT_FIELD_MAP.factIdentity);
  if (issues.length > 0) return issues;
  if (!text(ownValue(value, "factId").value) || !text(ownValue(value, "factType").value) || !text(ownValue(value, "factVersion").value)) {
    return [issue(path, "invalid-fact-identity", "A complete fact identity is required.")];
  }
  return [];
}

function validateRelationship(value, path) {
  if (!isWireRecord(value) || hasDangerousKey(value)) {
    return [issue(path, "invalid-relationship", "Each relationship must be a safe object record.")];
  }
  const kind = ownValue(value, "kind").value;
  if (kind === "derivedFrom") {
    const issues = recordIssues(value, path, FACT_FIELD_MAP.relationshipKinds.derivedFrom);
    return issues.concat(validateFactIdentity(ownValue(value, "referencedFact").value, `${path}.referencedFact`));
  }
  if (kind === "supports") {
    const issues = recordIssues(value, path, FACT_FIELD_MAP.relationshipKinds.supports);
    const evidence = ownValue(value, "referencedEvidence").value;
    if (issues.length > 0) return issues;
    const evidenceIssues = recordIssues(evidence, `${path}.referencedEvidence`, FACT_FIELD_MAP.referencedEvidence);
    if (evidenceIssues.length > 0) return evidenceIssues;
    return text(ownValue(evidence, "evidenceId").value)
      ? []
      : [issue(`${path}.referencedEvidence.evidenceId`, "invalid-relationship", "evidenceId is required.")];
  }
  return [issue(`${path}.kind`, "invalid-relationship", "The relationship kind is not registered.")];
}

function validatePayload(value) {
  const issues = recordIssues(value, "payload", FACT_FIELD_MAP.payload);
  if (issues.length > 0) return issues;
  const measurementType = ownValue(value, "measurementType").value;
  const numericValue = ownValue(value, "value").value;
  const unit = ownValue(value, "unit").value;
  if (measurementType !== "temperature") {
    issues.push(issue("payload.measurementType", "invalid-payload", "measurementType must be temperature."));
  }
  if (typeof numericValue !== "number" || !Number.isFinite(numericValue) || Object.is(numericValue, -0)) {
    issues.push(issue("payload.value", "invalid-payload", "value must be a finite non-negative-zero number."));
  }
  if (unit !== "celsius") {
    issues.push(issue("payload.unit", "invalid-payload", "unit must be celsius."));
  }
  return issues;
}

export function validateOperationalFact(input, authenticatedSiteReference) {
  const issues = recordIssues(input, "fact", FACT_FIELD_MAP.fact);
  if (issues.length > 0) return { valid: false, issues };

  const factType = ownValue(input, "factType").value;
  const factVersion = ownValue(input, "factVersion").value;
  if (factType !== FACT_TYPE || factVersion !== FACT_VERSION) {
    issues.push(issue("factType/factVersion", "unregistered-definition", "Only temperature.measurement@1 is accepted."));
  }
  const factId = ownValue(input, "factId").value;
  const subject = ownValue(input, "subject").value;
  const scope = ownValue(input, "scope").value;
  const source = ownValue(input, "source").value;
  const provenance = ownValue(input, "provenance").value;
  const relationships = ownValue(input, "relationships").value;
  const receivedAt = ownValue(input, "receivedAt");
  const observedAt = ownValue(input, "observedAt");
  const payload = ownValue(input, "payload").value;
  if (!text(factId)) issues.push(issue("factId", "missing-fact-id", "factId is required."));
  issues.push(...validateSubject(subject));
  issues.push(...validateScope(scope, authenticatedSiteReference));
  issues.push(...validateSource(source));
  issues.push(...validateProvenance(provenance));

  if (!Array.isArray(relationships)) {
    issues.push(issue("relationships", "invalid-relationship", "relationships must be an array."));
  } else {
    relationships.forEach((relationship, index) => {
      issues.push(...validateRelationship(relationship, `relationships[${index}]`));
    });
  }

  if (!receivedAt.present || receivedAt.accessor || !timestamp(receivedAt.value)) {
    issues.push(issue("receivedAt", "invalid-timestamp", "receivedAt must be a valid timestamp."));
  }
  if (observedAt.present && (observedAt.accessor || (observedAt.value !== undefined && !timestamp(observedAt.value)))) {
    issues.push(issue("observedAt", "invalid-timestamp", "observedAt must be a valid timestamp when supplied."));
  }
  if (timestamp(receivedAt.value) && observedAt.present && !observedAt.accessor && observedAt.value !== undefined && timestamp(observedAt.value) && Date.parse(observedAt.value) > Date.parse(receivedAt.value)) {
    issues.push(issue("observedAt", "invalid-timestamp-order", "observedAt must not be later than receivedAt."));
  }
  issues.push(...validatePayload(payload));

  if (issues.length > 0) return { valid: false, issues };
  return {
    valid: true,
    fact: freezeFact(input),
    issues: [],
  };
}

function freezeFact(input) {
  const relationships = input.relationships.map((relationship) => {
    const kind = ownValue(relationship, "kind").value;
    if (kind === "derivedFrom") {
      const referencedFact = ownValue(relationship, "referencedFact").value;
      return {
        kind,
        referencedFact: {
          factId: ownValue(referencedFact, "factId").value,
          factType: ownValue(referencedFact, "factType").value,
          factVersion: ownValue(referencedFact, "factVersion").value,
        },
      };
    }
    const referencedEvidence = ownValue(relationship, "referencedEvidence").value;
    return {
      kind,
      referencedEvidence: {
        evidenceId: ownValue(referencedEvidence, "evidenceId").value,
      },
    };
  });
  const fact = {
    factId: ownValue(input, "factId").value,
    factType: ownValue(input, "factType").value,
    factVersion: ownValue(input, "factVersion").value,
    subject: { subjectType: ownValue(ownValue(input, "subject").value, "subjectType").value, subjectId: ownValue(ownValue(input, "subject").value, "subjectId").value },
    scope: { scopeType: ownValue(ownValue(input, "scope").value, "scopeType").value, scopeId: ownValue(ownValue(input, "scope").value, "scopeId").value },
    source: { kind: ownValue(ownValue(input, "source").value, "kind").value, actorReference: ownValue(ownValue(input, "source").value, "actorReference").value },
    provenance: { provenanceReference: ownValue(ownValue(input, "provenance").value, "provenanceReference").value },
    relationships,
    ...(ownValue(input, "observedAt").value === undefined ? {} : { observedAt: ownValue(input, "observedAt").value }),
    receivedAt: ownValue(input, "receivedAt").value,
    payload: {
      measurementType: ownValue(ownValue(input, "payload").value, "measurementType").value,
      value: ownValue(ownValue(input, "payload").value, "value").value,
      unit: ownValue(ownValue(input, "payload").value, "unit").value,
    },
  };
  return deepFreeze(fact);
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    if (!Array.isArray(value)) Object.setPrototypeOf(value, null);
    Object.freeze(value);
  }
  return value;
}

function semanticValueEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => semanticValueEqual(item, right[index]));
  }
  if (typeof left === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && semanticValueEqual(left[key], right[key]));
  }
  return false;
}

export function areEquivalentValidatedFacts(left, right) {
  return semanticValueEqual(left, right);
}

export function classifyFactIdReuse(existingFact, candidateFact) {
  if (existingFact.factId !== candidateFact.factId) {
    return "different-fact-id";
  }
  return areEquivalentValidatedFacts(existingFact, candidateFact)
    ? "idempotent-replay"
    : "identity-conflict";
}

export function reconcileCanonicalRequest({ operationalFact, legacy, authenticatedSiteReference }) {
  const factResult = validateOperationalFact(operationalFact, authenticatedSiteReference);
  const issues = [...factResult.issues];
  if (!isWireRecord(legacy)) {
    issues.push(issue("legacy", "invalid-legacy-request", "Legacy fields must be an object record."));
  } else {
    const legacyType = ownValue(legacy, "type").value;
    const legacyFridge = ownValue(legacy, "fridge").value;
    const legacyValue = ownValue(legacy, "value").value;
    const canonicalSubjectId = factResult.valid ? ownValue(factResult.fact.subject, "subjectId").value : undefined;
    const canonicalValue = factResult.valid ? ownValue(factResult.fact.payload, "value").value : undefined;
    if (!exactLegacyType(legacyType)) issues.push(issue("legacy.type", "invalid-legacy-type", "type must be fridge or freezer."));
    if (typeof legacyFridge !== "string" || legacyFridge !== canonicalSubjectId) issues.push(issue("legacy.fridge", "legacy-canonical-mismatch", "fridge must exactly equal subject.subjectId."));
    const parsed = parseLegacyDecimal(legacyValue);
    if (!parsed.valid) issues.push(issue("legacy.value", "invalid-legacy-value", parsed.reason));
    else if (!Object.is(parsed.number, canonicalValue)) issues.push(issue("legacy.value", "legacy-canonical-mismatch", "value must equal payload.value."));
  }
  return issues.length > 0 ? { valid: false, issues } : { valid: true, fact: factResult.fact, issues: [] };
}

function exactLegacyType(value) {
  return value === "fridge" || value === "freezer";
}

function parseLegacyDecimal(value) {
  if (typeof value !== "string") return { valid: false, reason: "value must be a string." };
  if (!LEGACY_DECIMAL_GRAMMAR.test(value)) return { valid: false, reason: "value must match the finite decimal grammar." };
  const number = Number(value);
  if (!Number.isFinite(number) || Object.is(number, -0)) return { valid: false, reason: "value must be finite and not negative zero." };
  return { valid: true, number };
}
