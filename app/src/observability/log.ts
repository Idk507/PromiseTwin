import { createHash, randomUUID } from 'node:crypto';

// Structured operational log (docs/07): one JSON line per invocation with a fixed, small shape.
// Whitelist only: an operation name, an outcome code, a duration, a short tenant hash and numeric
// counters. There is NO field for free text, accounts, issue keys, promise text, evidence or
// payloads, so none can be logged by mistake through this helper.

const NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,59}$/;
const COUNTER = /^[A-Za-z][A-Za-z0-9]{0,23}$/;
const MAX_COUNTERS = 10;

export interface OpLog {
  /** Operation name, e.g. `applyCommand` or `rovo.list_at_risk`. */
  op: string;
  /** `ok`, a refusal code, or `error:<ErrorClass>`. */
  result: string;
  startedAt: number;
  /** Tenant id; only a short hash of it is logged. */
  tenantId?: string | undefined;
  /** Numeric counters such as contracts scanned. Non-numeric values and odd keys are dropped. */
  counts?: Record<string, number> | undefined;
}

/** Short, non-reversible tenant label for correlating lines without logging the real id. */
export function tenantHash(tenantId: unknown): string {
  return typeof tenantId === 'string' && tenantId.length > 0 ? createHash('sha256').update(tenantId).digest('hex').slice(0, 8) : 'none';
}

/** Builds the log record (exported for tests). Never throws. */
export function buildOpLog(l: OpLog, now: number = Date.now(), correlationId: string = randomUUID()): Record<string, unknown> {
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(l.counts ?? {}).slice(0, MAX_COUNTERS)) {
    if (COUNTER.test(k) && typeof v === 'number' && Number.isFinite(v)) counts[k] = Math.max(0, Math.trunc(v));
  }
  return {
    correlationId,
    tenantHash: tenantHash(l.tenantId),
    eventType: NAME.test(l.op) ? l.op : 'invalid-op',
    result: NAME.test(l.result) ? l.result : 'invalid-result',
    durationMs: Math.max(0, Math.round(now - l.startedAt)),
    ...counts,
  };
}

/** Writes one structured line. Logging must never break the request, so failures are swallowed. */
export function logOp(l: OpLog): void {
  try {
    console.log(JSON.stringify(buildOpLog(l)));
  } catch {
    /* never let logging fail a request */
  }
}

/** Outcome code of a service-style result: `ok`, the refusal code, or `ok` for non-result values. */
export function resultCode(r: unknown): string {
  if (typeof r === 'object' && r !== null && (r as { ok?: unknown }).ok === false) {
    const c = (r as { code?: unknown }).code;
    return typeof c === 'string' && NAME.test(c) ? `refused:${c}` : 'refused';
  }
  return 'ok';
}

/** `error:<ClassName>` for a thrown value, never its message. */
export function errorCode(e: unknown): string {
  const n = e instanceof Error ? e.name.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) : '';
  return `error:${n || 'unknown'}`;
}
