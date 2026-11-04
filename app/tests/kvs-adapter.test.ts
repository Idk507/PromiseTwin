import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent, Contract } from '../src/domain/contract';

// The adapter is only verifiable live after a deploy; these tests pin the transaction SHAPE and the
// conflict mapping against a mocked @forge/kvs so regressions are caught offline.
const store = new Map<string, unknown>();
const txOps: Array<{ key: string; value: unknown; opts: { entityName: string; conditions?: unknown } }> = [];
let failExecute: Error | undefined;
const queryResults: Array<{ key: string; value: unknown }> = [];

vi.mock('@forge/kvs', () => {
  class Filter {
    conds: Array<[string, unknown]> = [];
    and(f: string, c: unknown) { this.conds.push([f, c]); return this; }
  }
  const builder = {
    set(key: string, value: unknown, opts: { entityName: string; conditions?: unknown }) {
      txOps.push({ key, value, opts });
      return builder;
    },
    async execute() {
      if (failExecute) throw failExecute;
      for (const o of txOps) store.set(`${o.opts.entityName}/${o.key}`, o.value);
    },
  };
  const entity = (name: string) => ({
    get: async (key: string) => store.get(`${name}/${key}`),
    query: () => {
      const q = {
        index: () => q, where: () => q, limit: () => q, cursor: () => q,
        getMany: async () => ({ results: queryResults, nextCursor: undefined }),
      };
      return q;
    },
  });
  return {
    kvs: { entity, transact: () => { txOps.length = 0; return builder; } },
    Filter,
    FilterConditions: { equalTo: (v: unknown) => ({ equalTo: v }) },
    WhereConditions: { beginsWith: (v: string) => ({ beginsWith: v }) },
  };
});

const { KvsContractRepository } = await import('../src/adapters/kvs-contract-repository');

const contract = (over: Partial<Contract> = {}): Contract => ({
  id: 'c-0000001', tenantId: 'cloud-1', customerReference: 'ACME',
  source: { product: 'JIRA', site: 'cloud-1', issueId: '1001', issueKey: 'ITS-1' },
  ownerAccountId: 'o', promiseText: 'p', criteria: [{ id: 'c1', type: 'MANUAL_REVIEW', description: 'd', required: true, predicates: [] }],
  evidence: [], linkedWork: [], lifecycle: 'DRAFT', atRisk: false, version: 1, revision: 1, fulfillmentHistory: [],
  appliedEventIds: [], createdAt: '2026-11-02T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z', ...over,
});
const event = (c: Contract): AuditEvent => ({
  id: 'e-0000001', tenantId: c.tenantId, contractId: c.id, type: 'CONFIRM', actorAccountId: 'o', actorRoles: ['AGENT'],
  authorization: 'ALLOWED', fromLifecycle: 'DRAFT', toLifecycle: 'CONFIRMED', atRevision: c.revision, at: '2026-11-02T10:00:01Z',
});

beforeEach(() => { store.clear(); txOps.length = 0; failExecute = undefined; queryResults.length = 0; });

describe('KvsContractRepository', () => {
  it('create writes contract and audit event in ONE transaction', async () => {
    const c = contract();
    await new KvsContractRepository().create(c, event(c));
    expect(txOps.map((o) => o.opts.entityName)).toEqual(['contract', 'audit-event']);
    expect(txOps[0]!.key).toBe('cloud-1#1001#c-0000001');
  });

  it('save is conditional on the expected revision and also writes the audit event', async () => {
    const c = contract();
    await new KvsContractRepository().create(c, event(c));
    const next = contract({ revision: 2, lifecycle: 'CONFIRMED' });
    const res = await new KvsContractRepository().save(next, { ...event(next), id: 'e-0000002' }, 1, '1001');
    expect(res).toBe('OK');
    expect(txOps).toHaveLength(2);
    const cond = txOps[0]!.opts.conditions as { conds: Array<[string, unknown]> };
    expect(cond.conds).toEqual([['revision', { equalTo: 1 }]]);
    expect(txOps[1]!.opts.conditions).toBeUndefined();
  });

  it('maps a failed transaction to CONFLICT when the stored revision moved', async () => {
    const c = contract({ revision: 3 });
    store.set('contract/cloud-1#1001#c-0000001', { tenantId: 'cloud-1', revision: 3, lifecycle: 'DRAFT', doc: c });
    failExecute = new Error('condition failed');
    expect(await new KvsContractRepository().save(contract({ revision: 2 }), event(c), 1, '1001')).toBe('CONFLICT');
  });

  it('rethrows when the transaction failed but the revision did NOT move (real storage error)', async () => {
    const c = contract({ revision: 1 });
    store.set('contract/cloud-1#1001#c-0000001', { tenantId: 'cloud-1', revision: 1, lifecycle: 'DRAFT', doc: c });
    failExecute = new Error('storage unavailable');
    await expect(new KvsContractRepository().save(contract({ revision: 2 }), event(c), 1, '1001')).rejects.toThrow('storage unavailable');
  });

  it('maps a missing record on save to CONFLICT (never creates by accident)', async () => {
    failExecute = new Error('condition failed');
    expect(await new KvsContractRepository().save(contract({ revision: 2 }), event(contract()), 1, '1001')).toBe('CONFLICT');
  });

  it('refuses to create over an existing id', async () => {
    const c = contract();
    store.set('contract/cloud-1#1001#c-0000001', { tenantId: 'cloud-1', revision: 1, lifecycle: 'DRAFT', doc: c });
    await expect(new KvsContractRepository().create(c, event(c))).rejects.toThrow('already exists');
  });

  it('get returns undefined for a record whose stored tenant differs (defence in depth)', async () => {
    const other = contract({ tenantId: 'cloud-2' });
    store.set('contract/cloud-1#1001#c-0000001', { tenantId: 'cloud-2', revision: 1, lifecycle: 'DRAFT', doc: other });
    expect(await new KvsContractRepository().get('cloud-1', '1001', 'c-0000001')).toBeUndefined();
  });

  it('get returns undefined for corrupted stored data instead of trusting it', async () => {
    store.set('contract/cloud-1#1001#c-0000001', { tenantId: 'cloud-1', revision: 1, lifecycle: 'DRAFT', doc: { id: 'x' } });
    expect(await new KvsContractRepository().get('cloud-1', '1001', 'c-0000001')).toBeUndefined();
  });

  it('listByIssue drops rows from another tenant or with invalid shape', async () => {
    queryResults.push(
      { key: 'a', value: { tenantId: 'cloud-1', revision: 1, lifecycle: 'DRAFT', doc: contract() } },
      { key: 'b', value: { tenantId: 'cloud-2', revision: 1, lifecycle: 'DRAFT', doc: contract({ tenantId: 'cloud-2' }) } },
      { key: 'c', value: { tenantId: 'cloud-1', revision: 1, lifecycle: 'DRAFT', doc: { bad: true } } },
    );
    const list = await new KvsContractRepository().listByIssue('cloud-1', '1001');
    expect(list.map((c) => c.id)).toEqual(['c-0000001']);
  });

  it.each(['a#b', 'a b', '', '../x', 'a/b', 'x'.repeat(101)])('rejects key segment %j (prefix-escape / injection)', async (bad) => {
    await expect(new KvsContractRepository().get('cloud-1', '1001', bad)).rejects.toThrow('invalid key segment');
    await expect(new KvsContractRepository().get(bad, '1001', 'c-0000001')).rejects.toThrow('invalid key segment');
    await expect(new KvsContractRepository().listByIssue('cloud-1', bad)).rejects.toThrow('invalid key segment');
  });

  it('listAudit filters out events of other contracts/tenants', async () => {
    const c = contract();
    const mine = event(c);
    queryResults.push(
      { key: '1', value: { tenantId: 'cloud-1', contractId: c.id, at: mine.at, doc: mine } },
      { key: '2', value: { tenantId: 'cloud-2', contractId: c.id, at: mine.at, doc: { ...mine, id: 'e-other' } } },
    );
    const audit = await new KvsContractRepository().listAudit('cloud-1', c.id, 20);
    expect(audit.map((a) => a.id)).toEqual(['e-0000001']);
  });
});
