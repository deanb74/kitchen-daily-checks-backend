export async function auditLog(prisma, {
  siteId,
  userId,
  action,
  entityType,
  entityId,
  message,
  metadata,
}) {
  console.log("AUDIT", {
    siteId,
    userId,
    action,
    entityType,
    entityId,
    message,
    metadata,
  });

  // Later: save to AuditLog table
}