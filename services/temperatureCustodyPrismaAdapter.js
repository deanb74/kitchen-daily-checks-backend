// Adapts the real Prisma client to the exact Increment 3 injected transaction-client interface.

function createTransactionClient(tx) {
  return {
    async findCompleteCustodyAggregateByFactId(factId) {
      const record = await tx.operationalFact.findUnique({
        where: { factId },
        include: {
          legacyLink: { include: { legacyTemperatureLog: true } },
          custodyReceipt: true,
        },
      });
      if (record === null) return null;
      const { legacyLink, custodyReceipt, ...fact } = record;
      return {
        fact,
        link: legacyLink ?? null,
        legacyTemperatureLog: legacyLink?.legacyTemperatureLog ?? null,
        custodyReceipt: custodyReceipt ?? null,
      };
    },
    async findLegacyTemperatureDuplicates({ siteId, fridge, type, windowStartInclusive, windowEnd }) {
      return tx.temperatureLog.findMany({
        where: {
          siteId,
          fridge,
          type,
          createdAt: { gte: windowStartInclusive, lte: windowEnd },
        },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: 1,
      });
    },
    async createLegacyTemperatureLog(data) {
      return tx.temperatureLog.create({ data });
    },
    async createOperationalFact(data) {
      return tx.operationalFact.create({ data });
    },
    async createFactLegacyTemperatureLogLink(data) {
      return tx.factLegacyTemperatureLogLink.create({ data });
    },
    async createFactCustodyReceipt(data) {
      return tx.factCustodyReceipt.create({ data });
    },
  };
}

// Only the two enumerated meta.target forms are accepted; the actual primary-key P2002
// runtime shape has not been empirically observed and staging verification remains required.
function isCanonicalFactIdUniqueConflict(error) {
  if (!error || error.code !== "P2002") return false;
  const meta = error.meta ?? {};
  const target = meta.target;
  if (typeof target === "string" && target === "OperationalFact_pkey") return true;
  if (Array.isArray(target) && target.length === 1 && target[0] === "factId" && meta.modelName === "OperationalFact") return true;
  return false;
}

export function createTemperatureCustodyPrismaAdapter(prisma) {
  return {
    transactionRunner: {
      async runTransaction(callback) {
        return prisma.$transaction((tx) => callback(createTransactionClient(tx)));
      },
    },
    isCanonicalFactIdUniqueConflict,
  };
}
