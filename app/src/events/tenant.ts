// Trigger functions receive `context.installContext`, an ARI for the installation (Forge docs), NOT
// the `cloudId` that resolvers get. The tenant id is derived from the ARI's UUID and compared in
// lowercase. If it cannot be derived, the event is ignored (fail closed); it is never taken from
// the event payload.

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** Lowercase UUID tenant id from an install-context ARI, or undefined. */
export function tenantFromInstallContext(installContext: unknown): string | undefined {
  if (typeof installContext !== 'string' || installContext.length > 300) return undefined;
  if (!installContext.startsWith('ari:cloud:')) return undefined;
  const m = UUID.exec(installContext);
  return m ? m[1]!.toLowerCase() : undefined;
}
