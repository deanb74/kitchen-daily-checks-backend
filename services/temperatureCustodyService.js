import { randomUUID as nodeRandomUUID } from "node:crypto";
import { areEquivalentValidatedFacts } from "./temperatureCustodyValidation.js";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const POSTGRES_INT4_MAX = 2147483647;
const CANONICAL_POSITIVE_INTEGER_STRING = /^[1-9][0-9]*$/;

function invalidInput(issues) {
  return { mode: "invalid-input", issues };
}

// Only the exact canonical positive base-10 integer-string form maps to a Prisma Int siteId.
function toDatabaseSiteId(scopeId) {
  if (typeof scopeId !== "string" || !CANONICAL_POSITIVE_INTEGER_STRING.test(scopeId)) return undefined;
  const numeric = Number(scopeId);
  if (!Number.isSafeInteger(numeric) || numeric <= 0 || numeric > POSTGRES_INT4_MAX) return undefined;
  return numeric;
}

function assertRequiredDependencyShape(dependencies) {
  if (!dependencies || typeof dependencies !== "object") {
    throw new TypeError("createTemperatureCustodyService requires a dependencies object.");
  }
  if (typeof dependencies.transactionRunner?.runTransaction !== "function") {
    throw new TypeError("createTemperatureCustodyService requires dependencies.transactionRunner.runTransaction to be a function.");
  }
  if (typeof dependencies.isCanonicalFactIdUniqueConflict !== "function") {
    throw new TypeError("createTemperatureCustodyService requires dependencies.isCanonicalFactIdUniqueConflict to be a function.");
  }
}

function transactionFailure(factId) {
  return factId === undefined
    ? { mode: "transaction-failure" }
    : { mode: "transaction-failure", factId };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function toPersistedFact(fact) {
  return {
    factId: fact.factId,
    factType: fact.factType,
    factVersion: fact.factVersion,
    subjectType: fact.subject.subjectType,
    subjectId: fact.subject.subjectId,
    scopeType: fact.scope.scopeType,
    scopeId: fact.scope.scopeId,
    sourceKind: fact.source.kind,
    actorReference: fact.source.actorReference,
    provenanceReference: fact.provenance.provenanceReference,
    observedAt: fact.observedAt === undefined ? null : new Date(fact.observedAt),
    receivedAt: new Date(fact.receivedAt),
    payload: fact.payload,
    relationships: fact.relationships,
  };
}

function persistedFactToCanonical(fact) {
  return {
    factId: fact.factId,
    factType: fact.factType,
    factVersion: fact.factVersion,
    subject: { subjectType: fact.subjectType, subjectId: fact.subjectId },
    scope: { scopeType: fact.scopeType, scopeId: fact.scopeId },
    source: { kind: fact.sourceKind, actorReference: fact.actorReference },
    provenance: { provenanceReference: fact.provenanceReference },
    relationships: fact.relationships,
    ...(fact.observedAt === null || fact.observedAt === undefined
      ? {}
      : { observedAt: new Date(fact.observedAt).toISOString() }),
    receivedAt: new Date(fact.receivedAt).toISOString(),
    payload: fact.payload,
  };
}

function validateAggregate(aggregate, candidateFact) {
  if (!aggregate || !aggregate.fact || !aggregate.link || !aggregate.legacyTemperatureLog || !aggregate.custodyReceipt) {
    return { kind: "incomplete" };
  }
  if (aggregate.link.factId !== aggregate.fact.factId ||
      aggregate.custodyReceipt.factId !== aggregate.fact.factId ||
      aggregate.link.legacyTemperatureLogId !== aggregate.legacyTemperatureLog.id) {
    return { kind: "incomplete" };
  }
  if (!areEquivalentValidatedFacts(persistedFactToCanonical(aggregate.fact), candidateFact)) {
    return { kind: "conflict" };
  }
  return { kind: "replay", aggregate };
}

function replayResult(aggregate) {
  return {
    mode: "replayed",
    factId: aggregate.fact.factId,
    legacyTemperatureLogId: aggregate.legacyTemperatureLog.id,
    linkId: aggregate.link.linkId,
    custodyReceipt: aggregate.custodyReceipt,
  };
}

function committedResult(aggregate) {
  return {
    mode: "custodied",
    factId: aggregate.fact.factId,
    legacyTemperatureLogId: aggregate.legacyTemperatureLog.id,
    linkId: aggregate.link.linkId,
    custodyReceipt: aggregate.custodyReceipt,
  };
}

async function readAggregate(transactionClient, factId) {
  return transactionClient.findCompleteCustodyAggregateByFactId(factId);
}

async function transactionBody({ transactionClient, fact, legacy, randomUUID, now, databaseSiteId }) {
  const existing = await readAggregate(transactionClient, fact.factId);
  if (existing !== null && existing !== undefined) {
    const verified = validateAggregate(existing, fact);
    if (verified.kind === "incomplete") return { kind: "incomplete", factId: fact.factId };
    if (verified.kind === "conflict") return { kind: "conflict", factId: fact.factId };
    return { kind: "replay", aggregate: verified.aggregate };
  }

  const receivedAt = new Date(fact.receivedAt);
  const duplicateRows = await transactionClient.findLegacyTemperatureDuplicates({
    siteId: databaseSiteId,
    fridge: legacy.fridge,
    type: legacy.type,
    windowStartInclusive: new Date(receivedAt.getTime() - FIVE_MINUTES_MS),
    windowEnd: receivedAt,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
  const selectedLegacy = duplicateRows[0];
  const legacyTemperatureLog = selectedLegacy ?? await transactionClient.createLegacyTemperatureLog({
    siteId: databaseSiteId,
    fridge: legacy.fridge,
    value: legacy.value,
    type: legacy.type,
  });
  const linkMode = selectedLegacy ? "LEGACY_FIVE_MINUTE_DUPLICATE_REUSE" : "NEW_LEGACY_RECORD";

  const persistedFact = await transactionClient.createOperationalFact(toPersistedFact(fact));
  const link = await transactionClient.createFactLegacyTemperatureLogLink({
    linkId: randomUUID(),
    factId: persistedFact.factId,
    legacyTemperatureLogId: legacyTemperatureLog.id,
    linkMode,
  });
  const recordedAt = now();
  const custodyReceipt = await transactionClient.createFactCustodyReceipt({
    receiptId: randomUUID(),
    factId: persistedFact.factId,
    custodianReference: "postgresql-operational-fact-custody",
    recordedAt,
    persistenceId: randomUUID(),
    persistenceReference: `postgresql://operational-facts/${persistedFact.factId}`,
    schemaVersion: "1",
  });

  return {
    kind: "created",
    aggregate: {
      fact: persistedFact,
      link,
      legacyTemperatureLog,
      custodyReceipt,
    },
  };
}

export function createTemperatureCustodyService(dependencies) {
  assertRequiredDependencyShape(dependencies);
  const {
    transactionRunner,
    randomUUID = nodeRandomUUID,
    now = () => new Date(),
    isCanonicalFactIdUniqueConflict,
  } = dependencies;

  async function recoverCommittedReplay(input) {
    const recovered = await transactionRunner.runTransaction(async (transactionClient) => {
      const aggregate = await readAggregate(transactionClient, input.fact.factId);
      const verified = validateAggregate(aggregate, input.fact);
      if (verified.kind === "incomplete") return { kind: "incomplete" };
      if (verified.kind === "conflict") return { kind: "conflict" };
      return { kind: "replay", aggregate: verified.aggregate };
    });

    if (recovered.kind === "incomplete") return { mode: "incomplete-persisted-aggregate", factId: input.fact.factId };
    if (recovered.kind === "conflict") return { mode: "conflicting-fact-id", factId: input.fact.factId };
    return replayResult(recovered.aggregate);
  }

  async function recordTemperatureCustody(input) {
    if (!input || input.validation?.valid !== true || input.reconciliation?.valid !== true || !input.fact) {
      return invalidInput(input?.validation?.issues ?? input?.reconciliation?.issues ?? [{ code: "invalid-input" }]);
    }
    const fact = input.fact;
    const legacy = input.legacy;
    if (!legacy || hasOwn(legacy, "receiptId") || hasOwn(legacy, "persistenceId") || hasOwn(legacy, "recordedAt") || hasOwn(input, "receiptId") || hasOwn(input, "persistenceId") || hasOwn(input, "recordedAt")) {
      return invalidInput([{ code: "caller-owned-custody-field" }]);
    }
    if (input.authenticatedSiteId !== fact.scope.scopeId) {
      return invalidInput([{ code: "authenticated-site-mismatch", path: "scope.scopeId" }]);
    }
    const databaseSiteId = toDatabaseSiteId(fact.scope.scopeId);
    if (databaseSiteId === undefined) {
      return invalidInput([{ code: "invalid-database-site-id", path: "scope.scopeId" }]);
    }

    let primary;
    try {
      primary = await transactionRunner.runTransaction((transactionClient) => transactionBody({
        transactionClient,
        fact,
        legacy,
        randomUUID,
        now,
        databaseSiteId,
      }));
    } catch (error) {
      if (!isCanonicalFactIdUniqueConflict(error)) {
        return transactionFailure(fact.factId);
      }
      try {
        return await recoverCommittedReplay({ fact });
      } catch {
        return transactionFailure(fact.factId);
      }
    }

    if (primary.kind === "incomplete") return { mode: "incomplete-persisted-aggregate", factId: fact.factId };
    if (primary.kind === "conflict") return { mode: "conflicting-fact-id", factId: fact.factId };
    if (primary.kind === "replay") return replayResult(primary.aggregate);
    return committedResult(primary.aggregate);
  }

  return Object.freeze({ recordTemperatureCustody });
}
