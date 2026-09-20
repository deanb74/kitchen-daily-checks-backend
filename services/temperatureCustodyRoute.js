import { createTemperatureCustodyPrismaAdapter } from "./temperatureCustodyPrismaAdapter.js";
import { createTemperatureCustodyService } from "./temperatureCustodyService.js";
import { validateOperationalFact, reconcileCanonicalRequest } from "./temperatureCustodyValidation.js";

const POSTGRES_INT4_MAX = 2147483647;
const ALLOWED_TOP_LEVEL_CANONICAL_KEYS = ["fridge", "value", "type", "operationalFact"];
const DANGEROUS_TOP_LEVEL_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function resolveAuthenticatedDatabaseSiteId(rawSiteId) {
  if (typeof rawSiteId !== "number" || !Number.isInteger(rawSiteId)) return undefined;
  if (rawSiteId <= 0 || rawSiteId > POSTGRES_INT4_MAX) return undefined;
  return rawSiteId;
}

function isPlainRequestBody(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function ownDataValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return { present: false };
  if (!("value" in descriptor)) return { present: true, accessor: true };
  return { present: true, accessor: false, value: descriptor.value };
}

// Closed top-level canonical request-body contract: fridge, value, type, operationalFact only.
function validateTopLevelCanonicalRequestBody(body) {
  if (!isPlainRequestBody(body)) {
    return { valid: false, issues: [{ code: "invalid-request-body" }] };
  }
  const ownKeys = Reflect.ownKeys(body).filter((key) => typeof key === "string");
  if (ownKeys.some((key) => DANGEROUS_TOP_LEVEL_KEYS.has(key))) {
    return { valid: false, issues: [{ code: "dangerous-key" }] };
  }
  const unrecognized = ownKeys.filter((key) => !ALLOWED_TOP_LEVEL_CANONICAL_KEYS.includes(key));
  if (unrecognized.length > 0) {
    return { valid: false, issues: unrecognized.map((key) => ({ code: "unrecognized-field", path: key })) };
  }
  const fields = {};
  for (const key of ALLOWED_TOP_LEVEL_CANONICAL_KEYS) {
    const field = ownDataValue(body, key);
    if (!field.present) {
      return { valid: false, issues: [{ code: "missing-field", path: key }] };
    }
    if (field.accessor) {
      return { valid: false, issues: [{ code: "accessor-property", path: key }] };
    }
    if (field.value === undefined) {
      return { valid: false, issues: [{ code: "missing-field", path: key }] };
    }
    fields[key] = field.value;
  }
  if (!isPlainRequestBody(fields.operationalFact)) {
    return { valid: false, issues: [{ code: "invalid-request-body", path: "operationalFact" }] };
  }
  return { valid: true, ...fields };
}

function hasCanonicalExtension(body) {
  return typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.prototype.hasOwnProperty.call(body, "operationalFact");
}

function respondToCustodyResult(res, result) {
  switch (result.mode) {
    case "custodied":
      return res.status(201).json({ success: true, mode: "custodied", factId: result.factId, custodyReceipt: result.custodyReceipt });
    case "replayed":
      return res.status(200).json({ success: true, mode: "replayed", factId: result.factId, custodyReceipt: result.custodyReceipt });
    case "conflicting-fact-id":
      return res.status(409).json({ success: false, mode: "conflicting-fact-id", factId: result.factId });
    case "incomplete-persisted-aggregate":
      return res.status(409).json({ success: false, mode: "incomplete-persisted-aggregate", factId: result.factId });
    case "invalid-input":
      return res.status(400).json({ success: false, mode: "invalid-input", issues: result.issues ?? [] });
    case "transaction-failure":
      return result.factId === undefined
        ? res.status(500).json({ success: false, mode: "transaction-failure" })
        : res.status(500).json({ success: false, mode: "transaction-failure", factId: result.factId });
    default:
      return res.status(500).json({ success: false, mode: "internal-error" });
  }
}

// Exact, unchanged legacy behavior — preserved field-for-field, byte-for-byte.
async function handleLegacyPost(req, res, dependencies) {
  const { fridge, value, type } = req.body;

  if (!fridge || value === undefined || !type) {
    return res.status(400).json({ error: "fridge, value and type are required" });
  }

  const temp = Number(value);
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

  const existingRecentLog = await dependencies.prisma.temperatureLog.findFirst({
    where: {
      siteId: req.currentUser.siteId,
      fridge,
      type,
      value: temp,
      createdAt: {
        gte: fiveMinutesAgo,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (existingRecentLog) {
    return res.json({
      success: true,
      duplicate: true,
      entry: existingRecentLog,
    });
  }

  let status = "green";

  if (type === "fridge") {
    if (temp < 0 || temp > 8) status = "red";
    else if (temp < 2 || temp > 5) status = "amber";
  }

  if (type === "freezer") {
    if (temp > -18) status = "red";
    else if (temp < -21) status = "amber";
  }

  const entry = await dependencies.prisma.temperatureLog.create({
    data: {
      fridge,
      value: temp,
      type,
      status,
      siteId: req.currentUser.siteId,
    },
  });

  if (status === "red") {
    const managers = await dependencies.prisma.user.findMany({
      where: {
        role: "manager",
        siteId: req.currentUser.siteId,
        pushToken: { not: null },
      },
      select: {
        pushToken: true,
      },
    });

    const messages = managers
      .filter((m) => m.pushToken)
      .map((m) => ({
        to: m.pushToken,
        sound: "default",
        title: "Red temperature alert",
        body: `${fridge} (${type}) logged ${temp}°C`,
        data: {
          screen: "manager",
          fridge,
          type,
          value: temp,
          status,
        },
      }));

    if (messages.length > 0) {
      await dependencies.sendExpoPushNotifications(messages);
    }
  }

  res.json(entry);
}

export function createTemperatureCustodyRouteHandlers(dependencies) {
  async function getTemperatures(req, res) {
    const logs = await dependencies.prisma.temperatureLog.findMany({
      where: { siteId: req.currentUser.siteId },
      orderBy: { createdAt: "desc" },
    });
    res.json(logs);
  }

  async function postTemperatures(req, res) {
    const rawBody = req.body;

    if (!hasCanonicalExtension(rawBody)) {
      return handleLegacyPost(req, res, dependencies);
    }

    try {
      const bodyValidation = validateTopLevelCanonicalRequestBody(rawBody);
      if (!bodyValidation.valid) {
        return res.status(400).json({ success: false, mode: "invalid-input", issues: bodyValidation.issues });
      }

      const databaseSiteId = resolveAuthenticatedDatabaseSiteId(req.currentUser?.siteId);
      if (databaseSiteId === undefined) {
        return res.status(403).json({ success: false, mode: "invalid-site-context" });
      }
      const authenticatedSiteId = String(databaseSiteId);

      const validation = validateOperationalFact(bodyValidation.operationalFact, authenticatedSiteId);
      const reconciliation = reconcileCanonicalRequest({
        operationalFact: bodyValidation.operationalFact,
        legacy: {
          fridge: bodyValidation.fridge,
          type: bodyValidation.type,
          value: String(bodyValidation.value),
        },
        authenticatedSiteReference: authenticatedSiteId,
      });

      const input = {
        validation,
        reconciliation,
        fact: validation.valid ? validation.fact : undefined,
        legacy: {
          fridge: bodyValidation.fridge,
          type: bodyValidation.type,
          value: validation.valid ? validation.fact.payload.value : undefined,
        },
        authenticatedSiteId,
      };

      const result = await dependencies.custodyService.recordTemperatureCustody(input);
      return respondToCustodyResult(res, result);
    } catch {
      return res.status(500).json({ success: false, mode: "internal-error" });
    }
  }

  return { getTemperatures, postTemperatures };
}

export function registerTemperatureCustodyRoutes(app, dependencies) {
  const handlers = createTemperatureCustodyRouteHandlers(dependencies);
  app.get("/temperatures", dependencies.requireAuth, dependencies.attachCurrentUser, handlers.getTemperatures);
  app.post("/temperatures", dependencies.requireAuth, dependencies.attachCurrentUser, handlers.postTemperatures);
  return handlers;
}

export function createTemperatureCustodyRouteDependencies({ prisma, sendExpoPushNotifications, randomUUID, now }) {
  const { transactionRunner, isCanonicalFactIdUniqueConflict } = createTemperatureCustodyPrismaAdapter(prisma);
  const custodyService = createTemperatureCustodyService({
    transactionRunner,
    randomUUID,
    now,
    isCanonicalFactIdUniqueConflict,
  });
  return { prisma, sendExpoPushNotifications, custodyService };
}
