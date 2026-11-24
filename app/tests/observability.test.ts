import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({
  default: { asUser: () => ({ requestJira: async () => ({ ok: true, status: 200, json: async () => ({}) }) }), asApp: () => ({ requestJira: async () => ({ ok: true, status: 200, json: async () => ({}) }) }) },
  route: (s: TemplateStringsArray, ...v: unknown[]) => s.reduce((a, p, i) => a + p + (v[i] ?? ''), ''),
}));

const defined: Record<string, (req: unknown) => Promise<unknown>> = {};
vi.mock('@forge/resolver', () => ({
  default: class {
    define(name: string, fn: (req: unknown) => Promise<unknown>) { defined[name] = fn; }
    getDefinitions() { return () => undefined; }
  },
}));

// Stub service/sync whose results and errors carry sensitive-looking text that must never be logged.
const SECRET_ERR = 'token=abc123 PROMISE-TEXT-SECRET acct-SECRET';
let mode: 'ok' | 'refuse' | 'throw' = 'ok';
const result = () => {
  if (mode === 'throw') throw Object.assign(new Error(SECRET_ERR), { name: 'BoomError' });
  return mode === 'refuse' ? { ok: false, code: 'UNAUTHORIZED_ACTOR', detail: [SECRET_ERR] } : { ok: true, value: { promiseText: 'PROMISE-TEXT-SECRET' } };
};
vi.mock('../src/wiring', () => ({
  buildService: () => ({ list: async () => result(), create: async () => result(), apply: async () => result(), refresh: async () => result(), roleAdmin: async () => result(), setRoles: async () => result(), portfolio: async () => result() }),
  buildSync: () => ({ handleIssueUpdated: async () => { if (mode === 'throw') throw new Error(SECRET_ERR); return { skipped: undefined, contractsScanned: 2, applied: 1, unchanged: 1, deferred: 0, unreadable: 0 }; }, reconcile: async () => ({ skipped: undefined, contractsScanned: 3, issuesChecked: 2, applied: 0, unchanged: 2, deferred: 1, unreadable: 0 }) }),
}));

const { buildOpLog, tenantHash, resultCode, errorCode, logOp } = await import('../src/observability/log');
const { createRovoActions } = await import('../src/rovo/actions');
const handlers = await import('../src/events/handlers');

const ALLOWED_KEYS = new Set(['correlationId', 'tenantHash', 'eventType', 'result', 'durationMs', 'tenantParsed', 'contracts', 'applied', 'unchanged', 'deferred', 'unreadable', 'issues']);
const SECRETS = ['acct-SECRET', 'SECRETKEY-9', 'cloud-SECRET-TENANT-9999', 'PROMISE-TEXT-SECRET', 'abc123', 'token='];

let lines: string[];
beforeAll(async () => { await import('../src/resolvers/index'); });
beforeEach(() => { lines = []; mode = 'ok'; vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); }); });
afterEach(() => { vi.restoreAllMocks(); });

const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
const rctx = (extra: Record<string, unknown> = {}) => ({
  context: { cloudId: 'cloud-SECRET-TENANT-9999', accountId: 'acct-SECRET', extension: { issue: { key: 'SECRETKEY-9' }, project: { key: 'SECRETKEY' } } },
  payload: { input: { promiseText: 'PROMISE-TEXT-SECRET' }, command: { reason: 'PROMISE-TEXT-SECRET' }, ...extra },
});

describe('buildOpLog: a fixed shape with nothing free-form', () => {
  it('has only the whitelisted fields and a short tenant hash that is not the tenant id (positive)', () => {
    const rec = buildOpLog({ op: 'applyCommand', result: 'ok', startedAt: 1000, tenantId: 'cloud-SECRET-TENANT-9999', counts: { contracts: 3 } }, 1250, 'corr-1');
    expect(rec).toEqual({ correlationId: 'corr-1', tenantHash: tenantHash('cloud-SECRET-TENANT-9999'), eventType: 'applyCommand', result: 'ok', durationMs: 250, contracts: 3 });
    expect(JSON.stringify(rec)).not.toContain('SECRET');
    expect(tenantHash('cloud-SECRET-TENANT-9999')).toMatch(/^[0-9a-f]{8}$/);
    expect(tenantHash(undefined)).toBe('none');
    expect(tenantHash(42)).toBe('none');
  });
  it('rejects free text in op/result and odd or non-numeric counters (negative)', () => {
    const rec = buildOpLog({ op: 'x y\n{"a":1}', result: 'promise text with spaces', startedAt: 5, counts: { ok: 1, 'bad key': 2, nan: Number.NaN, str: 'x' as never, neg: -4, big: 1.9 } }, 3, 'c');
    expect(rec['eventType']).toBe('invalid-op');
    expect(rec['result']).toBe('invalid-result');
    expect(rec['durationMs']).toBe(0); // never negative
    expect(rec).toMatchObject({ ok: 1, neg: 0, big: 1 });
    expect(rec).not.toHaveProperty('bad key');
    expect(rec).not.toHaveProperty('nan');
    expect(rec).not.toHaveProperty('str');
  });
  it('resultCode and errorCode reduce values to codes only', () => {
    expect(resultCode({ ok: true })).toBe('ok');
    expect(resultCode({ ok: false, code: 'FORBIDDEN', detail: ['secret'] })).toBe('refused:FORBIDDEN');
    expect(resultCode({ ok: false, code: 'has spaces and secret' })).toBe('refused');
    expect(errorCode(Object.assign(new Error('token=abc'), { name: 'My Error!' }))).toBe('error:MyError');
    expect(errorCode('string thrown')).toBe('error:unknown');
  });
  it('logging never throws, even when the console fails', () => {
    vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('console broke'); });
    expect(() => logOp({ op: 'x', result: 'ok', startedAt: 0 })).not.toThrow();
  });
});

describe('every entry point logs one structured line and nothing sensitive', () => {
  const assertClean = () => {
    for (const l of lines) for (const s of SECRETS) expect(l, `log line leaked ${s}`).not.toContain(s);
    for (const rec of parsed()) {
      for (const k of Object.keys(rec)) expect(ALLOWED_KEYS.has(k), `unexpected log field ${k}`).toBe(true);
      expect(typeof rec['correlationId']).toBe('string');
      expect(rec['tenantHash']).toMatch(/^([0-9a-f]{8}|none)$/);
      expect(typeof rec['durationMs']).toBe('number');
    }
  };

  it('resolvers: ok, refused (with sensitive detail) and thrown (with a sensitive message)', async () => {
    for (const m of ['ok', 'refuse', 'throw'] as const) {
      mode = m;
      for (const name of ['listContracts', 'createContract', 'applyCommand', 'refreshLinkedWork', 'getRoles', 'setRoles', 'getPortfolio']) {
        try { await defined[name]!(rctx()); } catch { /* expected in throw mode */ }
      }
    }
    const recs = parsed();
    expect(recs.length).toBe(21);
    expect(recs.filter((r) => r['result'] === 'ok').length).toBe(7);
    expect(recs.filter((r) => r['result'] === 'refused:UNAUTHORIZED_ACTOR').length).toBe(7);
    expect(recs.filter((r) => r['result'] === 'error:BoomError').length).toBe(7);
    assertClean();
  });

  it('missing context still logs a safe line', async () => {
    await defined['listContracts']!({ context: {} });
    expect(parsed()[0]).toMatchObject({ eventType: 'listContracts', result: 'refused:ISSUE_NOT_ACCESSIBLE', tenantHash: 'none' });
    assertClean();
  });

  it('trigger and scheduled handlers log counts, a tenant hash and no ids', async () => {
    const install = { installContext: 'ari:cloud:jira::site/0a1b2c3d-0000-4000-8000-000000000001' };
    await handlers.onIssueUpdated({ issue: { id: '1001', fields: { updated: 'SECRETKEY-9' } } }, install);
    await handlers.reconcileSweep({}, install);
    mode = 'throw';
    await expect(handlers.onIssueUpdated({}, install)).rejects.toThrow();
    const recs = parsed();
    expect(recs[0]).toMatchObject({ eventType: 'event.issueUpdated', result: 'processed', contracts: 2, applied: 1, tenantParsed: 1 });
    expect(recs[1]).toMatchObject({ eventType: 'schedule.reconcile', result: 'done', issues: 2, deferred: 1 });
    expect(recs[2]).toMatchObject({ eventType: 'event.issueUpdated', result: 'error:Error' });
    assertClean();
  });

  it('Rovo actions log outcome codes only, including when the service throws', async () => {
    const payload = { context: { accountId: 'acct-SECRET', cloudId: 'cloud-SECRET-TENANT-9999', jira: { issueKey: 'SECRETKEY-9', projectKey: 'SECRETKEY' } } };
    const context = { principal: { accountId: 'acct-SECRET' }, installContext: 'ari:cloud:jira::site/cloud-SECRET-TENANT-9999' };
    for (const m of ['ok', 'refuse', 'throw'] as const) {
      mode = m;
      const svcStub = { list: async () => result(), portfolio: async () => result() };
      const a = createRovoActions(svcStub as never);
      await a.getCommitment(payload, context); await a.explainMissingEvidence(payload, context); await a.listAtRisk(payload, context);
    }
    const recs = parsed();
    expect(recs.length).toBe(9);
    expect(recs.map((r) => r['eventType'])).toEqual(expect.arrayContaining(['rovo.get_commitment', 'rovo.explain_missing_evidence', 'rovo.list_at_risk']));
    expect(recs.filter((r) => r['result'] === 'error:BoomError').length).toBe(3);
    assertClean();
  });
});
