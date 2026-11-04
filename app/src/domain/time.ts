// Jira reports timestamps like "2026-11-02T11:47:33.542-0500" (no colon in the offset) and event
// payloads can use the same shape. Normalize before comparing; anything unparseable is rejected
// (undefined) so callers fail closed instead of guessing an order.

/** Epoch milliseconds for an ISO-8601 timestamp (colon or no-colon offset), or undefined. */
export function parseTimestamp(value: string): number | undefined {
  if (typeof value !== 'string' || value.length < 10 || value.length > 40) return undefined;
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? undefined : ms;
}
