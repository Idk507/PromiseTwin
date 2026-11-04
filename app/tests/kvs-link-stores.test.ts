import { beforeEach, describe, expect, it, vi } from 'vitest';

// Pins how the Forge adapters call @forge/kvs. Only a deploy can show real behaviour (notably what
// error a refused FAIL_IF_EXISTS write raises); these tests guard the shapes and the fail-closed
// handling offline.
const store = new Map<string, unknown>();
const sets: Array<{ key: string; value: unknown; opts: unknown }> = [];
const deletes: string[] = [];
const wheres: unknown[] = [];
let queryRows: Array<{ key: string; value: unknown }> = [];
let queryPages: Array<{ results: Array<{ key: string; value: unknown }>; nextCursor?: string }> | undefined;
let failSet: Error | undefined;
let pageNo = 0;

vi.mock('@forge/kvs', () => {
  const mkQuery = () => {
    const q = {
      index: () => q,
      // plain KVS: where('key', cond); entity query: where(cond). Record the condition either way.
      where: (a: unknown, b?: unknown) => { wheres.push(b ?? a); return q; },
      // Mirror Forge: list queries above the per-request limit are rejected (seen live as LIST_QUERY_LIMIT_EXCEEDED).
      limit: (n: number) => { if (n > 100) throw new Error('LIST_QUERY_LIMIT_EXCEEDED'); return q; }, cursor: () => q,
      getMany: async () => {
        if (queryPages) return queryPages[Math.min(pageNo++, queryPages.length - 1)]!;
        return { results: queryRows, nextCursor: undefined };
      },
    };
    return q;
  };
  return {
    kvs: {
      set: async (key: string, value: unknown, opts?: unknown) => { if (failSet) throw failSet; sets.push({ key, value, opts }); store.set(key, value); },
      get: async (key: string) => store.get(key),
      delete: async (key: string) => { deletes.push(key); store.delete(key); },
      query: () => mkQuery(),
      entity: () => ({ query: () => mkQuery(), get: async () => undefined }),
      transact: () => { throw new Error('unused'); },
    },
    Filter: class {},
    FilterConditions: {},
    WhereConditions: { beginsWith: (v: string) => ({ beginsWith: v }), greaterThan: (v: string) => ({ greaterThan: v }) },
  };
});

const { KvsEventInbox, KvsLinkIndex, KvsSweepState } = await import('../src/adapters/kvs-link-stores');
const { KvsContractRepository } = await import('../src/adapters/kvs-contract-repository');

beforeEach(() => {
  store.clear(); sets.length = 0; deletes.length = 0; wheres.length = 0; queryRows = []; queryPages = undefined; failSet = undefined; pageNo = 0;
});

describe('KvsEventInbox', () => {
  it('claims with FAIL_IF_EXISTS and a TTL (first delivery wins)', async () => {
    expect(await new KvsEventInbox().claim('inbox#t#1#u')).toBe(true);
    expect(sets[0]).toMatchObject({ key: 'inbox#t#1#u', opts: { keyPolicy: 'FAIL_IF_EXISTS', ttl: { unit: 'DAYS', value: 7 } } });
  });

  it('a refused write on an existing key means DUPLICATE', async () => {
    store.set('inbox#t#1#u', 1);
    failSet = new Error('key exists');
    expect(await new KvsEventInbox().claim('inbox#t#1#u')).toBe(false);
  });

  it('a failure on a key that does NOT exist is a real error, rethrown (so Forge retries)', async () => {
    failSet = new Error('storage unavailable');
    await expect(new KvsEventInbox().claim('inbox#t#1#u')).rejects.toThrow('storage unavailable');
  });
});

describe('KvsLinkIndex', () => {
  it('writes and deletes tenant-scoped keys', async () => {
    const ix = new KvsLinkIndex();
    await ix.add('cloud-1', '2001', '1001', 'c-1');
    await ix.remove('cloud-1', '2001', '1001', 'c-1');
    expect(sets[0]!.key).toBe('link#cloud-1#2001#1001#c-1');
    expect(deletes).toEqual(['link#cloud-1#2001#1001#c-1']);
  });

  it('contractsFor queries the exact prefix and parses only well-formed rows of this tenant+issue', async () => {
    queryRows = [
      { key: 'link#cloud-1#2001#1001#c-1', value: 1 },
      { key: 'link#cloud-1#2001#1002#c-2', value: 1 },
      { key: 'link#cloud-2#2001#1001#c-3', value: 1 }, // other tenant
      { key: 'link#cloud-1#2002#1001#c-4', value: 1 }, // other linked issue
      { key: 'link#cloud-1#2001#1001', value: 1 }, // malformed
      { key: 'link#cloud-1#2001#1001#c-5#x', value: 1 }, // too many parts
    ];
    const rows = await new KvsLinkIndex().contractsFor('cloud-1', '2001');
    expect(wheres[0]).toEqual({ beginsWith: 'link#cloud-1#2001#' });
    expect(rows).toEqual([{ contractIssueId: '1001', contractId: 'c-1' }, { contractIssueId: '1002', contractId: 'c-2' }]);
  });

  it('follows pagination but stops after a bounded number of pages', async () => {
    queryPages = [
      { results: [{ key: 'link#t#9#1#a', value: 1 }], nextCursor: 'n1' },
      { results: [{ key: 'link#t#9#1#b', value: 1 }], nextCursor: 'n2' },
      { results: [{ key: 'link#t#9#1#c', value: 1 }], nextCursor: 'n3' },
      { results: [{ key: 'link#t#9#1#d', value: 1 }], nextCursor: 'n4' },
    ];
    const rows = await new KvsLinkIndex().contractsFor('t', '9');
    expect(rows.map((r) => r.contractId)).toEqual(['a', 'b', 'c']); // MAX_PAGES = 3
  });

  it.each(['a#b', 'a b', '', '../x', 'x'.repeat(101)])('rejects key segment %j (prefix escape)', async (bad) => {
    const ix = new KvsLinkIndex();
    await expect(ix.add('cloud-1', bad, '1', 'c')).rejects.toThrow('invalid key segment');
    await expect(ix.contractsFor(bad, '2001')).rejects.toThrow('invalid key segment');
    await expect(ix.remove('cloud-1', '2001', bad, 'c')).rejects.toThrow('invalid key segment');
  });
});

describe('KvsSweepState', () => {
  it('stores a resume key, reads it back, and deletes it when undefined', async () => {
    const s = new KvsSweepState();
    expect(await s.get('cloud-1')).toBeUndefined();
    await s.set('cloud-1', 'cloud-1#1001#c-9');
    expect(await s.get('cloud-1')).toBe('cloud-1#1001#c-9');
    await s.set('cloud-1', undefined);
    expect(deletes).toEqual(['sweep#cloud-1']);
    expect(await s.get('cloud-1')).toBeUndefined();
  });

  it('ignores a non-string value (corrupted state) instead of trusting it', async () => {
    store.set('sweep#cloud-1', { evil: true });
    expect(await new KvsSweepState().get('cloud-1')).toBeUndefined();
  });
});

describe('KvsContractRepository.listPage', () => {
  const row = (tenant: string, key: string) => ({
    key,
    value: {
      tenantId: tenant, revision: 1,
      doc: {
        id: key.split('#')[2], tenantId: tenant, customerReference: 'ACME',
        source: { product: 'JIRA', site: tenant, issueId: key.split('#')[1], issueKey: 'ITS-1' },
        ownerAccountId: 'o', promiseText: 'p', criteria: [{ id: 'c1', type: 'MANUAL_REVIEW', description: 'd', required: true }],
        evidence: [], lifecycle: 'DRAFT', atRisk: false, version: 1, revision: 1, fulfillmentHistory: [], appliedEventIds: [],
        createdAt: '2026-11-03T10:00:00Z', updatedAt: '2026-11-03T10:00:00Z',
      },
    },
  });

  it('first page uses beginsWith(tenant#); later pages resume with greaterThan(lastKey)', async () => {
    queryRows = [row('cloud-1', 'cloud-1#1001#c-1')];
    await new KvsContractRepository().listPage('cloud-1', undefined, 50);
    await new KvsContractRepository().listPage('cloud-1', 'cloud-1#1001#c-1', 50);
    expect(wheres).toEqual([{ beginsWith: 'cloud-1#' }, { greaterThan: 'cloud-1#1001#c-1' }]);
  });

  it('drops rows past the tenant key range, other tenants, and corrupted documents', async () => {
    queryRows = [
      row('cloud-1', 'cloud-1#1001#c-1'),
      row('cloud-2', 'cloud-2#1001#c-2'), // other tenant (also fails the stored-tenant check)
      // Valid document that claims tenant cloud-1 but sits under another tenant's key range: only
      // the key-prefix guard can exclude it (greaterThan can run past the tenant's range).
      row('cloud-1', 'cloud-2#1001#c-9'),
      { key: 'cloud-1#1001#c-3', value: { tenantId: 'cloud-1', revision: 1, doc: { bad: true } } }, // corrupted
      row('cloud-2', 'cloud-1#1001#c-4'), // stored tenant mismatch
    ];
    const page = await new KvsContractRepository().listPage('cloud-1', 'cloud-1#0', 50);
    expect(page.map((p) => p.key)).toEqual(['cloud-1#1001#c-1']);
    expect(page[0]!.contract.linkedWork).toEqual([]); // P1-era document defaults the new field
  });

  it('rejects a tenant id that could escape the prefix', async () => {
    await expect(new KvsContractRepository().listPage('a#b', undefined, 10)).rejects.toThrow('invalid key segment');
  });
});
