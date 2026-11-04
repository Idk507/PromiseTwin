import { beforeEach, describe, expect, it, vi } from 'vitest';

// Guards how the role store talks to @forge/kvs and, above all, that stored data can never grant
// more than an assignable role (tampering/corruption fails closed).
const store = new Map<string, unknown>();
const sets: Array<{ key: string; value: unknown }> = [];
const deletes: string[] = [];
const wheres: unknown[] = [];
let queryRows: Array<{ key: string; value: unknown }> = [];
let queryPages: Array<{ results: Array<{ key: string; value: unknown }>; nextCursor?: string }> | undefined;
let pageNo = 0;
const limitsSeen: number[] = [];

vi.mock('@forge/kvs', () => {
  const q = {
    where: (_k: string, cond: unknown) => { wheres.push(cond); return q; },
    // Mirror Forge's REAL behaviour: a list query above the per-request limit is rejected
    // (LIST_QUERY_LIMIT_EXCEEDED was hit live with limit 200). Mocks must not be more lenient.
    limit: (n: number) => { limitsSeen.push(n); if (n > 100) throw new Error('LIST_QUERY_LIMIT_EXCEEDED'); return q; },
    cursor: () => q,
    getMany: async () => (queryPages ? queryPages[Math.min(pageNo++, queryPages.length - 1)]! : { results: queryRows, nextCursor: undefined }),
  };
  return {
    kvs: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => { sets.push({ key, value }); store.set(key, value); },
      delete: async (key: string) => { deletes.push(key); store.delete(key); },
      query: () => q,
    },
    WhereConditions: { beginsWith: (v: string) => ({ beginsWith: v }) },
  };
});

const { KvsRoleStore } = await import('../src/adapters/kvs-role-store');

beforeEach(() => { store.clear(); sets.length = 0; deletes.length = 0; wheres.length = 0; queryRows = []; queryPages = undefined; pageNo = 0; limitsSeen.length = 0; });

describe('KvsRoleStore', () => {
  it('stores assignable roles under a tenant+project+account key and logs the change', async () => {
    await new KvsRoleStore().set('cloud-1', 'ITS', '712020:abc-1', ['REVIEWER', 'AGENT'], 'admin-1', '2026-11-04T10:00:00Z');
    expect(sets[0]).toEqual({ key: 'roles#cloud-1#ITS#712020:abc-1', value: { roles: ['REVIEWER', 'AGENT'] } });
    expect(sets[1]!.key.startsWith('rolelog#cloud-1#ITS#')).toBe(true);
    expect(sets[1]!.value).toMatchObject({ accountId: '712020:abc-1', roles: ['REVIEWER', 'AGENT'], changedBy: 'admin-1' });
  });

  it('never persists APPROVER or SYSTEM even if a caller passes them', async () => {
    await new KvsRoleStore().set('cloud-1', 'ITS', 'a1', ['APPROVER', 'SYSTEM', 'AGENT'] as never, 'admin-1', '2026-11-04T10:00:00Z');
    expect(sets[0]!.value).toEqual({ roles: ['AGENT'] });
  });

  it('an empty role list deletes the assignment (and still logs the change)', async () => {
    await new KvsRoleStore().set('cloud-1', 'ITS', 'a1', [], 'admin-1', '2026-11-04T10:00:00Z');
    expect(deletes).toEqual(['roles#cloud-1#ITS#a1']);
    expect(sets.some((s) => s.key.startsWith('rolelog#'))).toBe(true);
  });

  it('get drops anything that is not an assignable role (tampered storage cannot grant APPROVER/SYSTEM)', async () => {
    store.set('roles#cloud-1#ITS#a1', { roles: ['APPROVER', 'SYSTEM', 'ROOT', 42, null, 'REVIEWER', 'REVIEWER'] });
    expect(await new KvsRoleStore().get('cloud-1', 'ITS', 'a1')).toEqual(['REVIEWER']);
  });

  it.each([[undefined], [null], ['REVIEWER'], [{ roles: 'AGENT' }], [{}]])('get of malformed value %j yields no roles (default deny)', async (v) => {
    if (v !== undefined) store.set('roles#cloud-1#ITS#a1', v);
    expect(await new KvsRoleStore().get('cloud-1', 'ITS', 'a1')).toEqual([]);
  });

  it('list queries the exact project prefix, cleans roles, and drops empty or malformed rows', async () => {
    queryRows = [
      { key: 'roles#cloud-1#ITS#a1', value: { roles: ['AGENT'] } },
      { key: 'roles#cloud-1#ITS#a2', value: { roles: ['SYSTEM'] } }, // only non-assignable => no roles => dropped
      { key: 'roles#cloud-1#ITS#bad id', value: { roles: ['AGENT'] } }, // malformed account id
      { key: 'roles#cloud-1#ITS#a3', value: { roles: ['REVIEWER', 'ACKNOWLEDGER'] } },
    ];
    const rows = await new KvsRoleStore().list('cloud-1', 'ITS');
    expect(wheres[0]).toEqual({ beginsWith: 'roles#cloud-1#ITS#' });
    expect(rows).toEqual([{ accountId: 'a1', roles: ['AGENT'] }, { accountId: 'a3', roles: ['REVIEWER', 'ACKNOWLEDGER'] }]);
  });

  it('list and history never ask Forge for more than its per-request limit (regression: LIST_QUERY_LIMIT_EXCEEDED seen live)', async () => {
    await new KvsRoleStore().list('cloud-1', 'ITS');
    await new KvsRoleStore().history('cloud-1', 'ITS', 10);
    expect(limitsSeen.length).toBeGreaterThan(0);
    expect(Math.max(...limitsSeen)).toBeLessThanOrEqual(100);
  });

  it('list pages through results up to the 200-assignment cap and stops', async () => {
    const page = (start: number, n: number, next?: string) => ({
      results: Array.from({ length: n }, (_, i) => ({ key: `roles#cloud-1#ITS#u${start + i}`, value: { roles: ['AGENT'] } })),
      nextCursor: next,
    });
    queryPages = [page(0, 100, 'c1'), page(100, 100, 'c2'), page(200, 100, 'c3')];
    const rows = await new KvsRoleStore().list('cloud-1', 'ITS');
    expect(rows).toHaveLength(200); // cap, even though a third page exists
    expect(pageNo).toBe(2);         // and no third request was made
  });

  it('history returns only well-formed entries, newest last, with cleaned roles', async () => {
    queryRows = [
      { key: 'rolelog#c#ITS#1', value: { accountId: 'a1', roles: ['AGENT', 'APPROVER'], changedBy: 'adm', at: '2026-11-04T10:00:00Z' } },
      { key: 'rolelog#c#ITS#2', value: { accountId: 'a2' } }, // malformed
      { key: 'rolelog#c#ITS#3', value: { accountId: 'a3', roles: [], changedBy: 'adm', at: '2026-11-04T11:00:00Z' } },
    ];
    const h = await new KvsRoleStore().history('c', 'ITS', 10);
    expect(h).toEqual([
      { accountId: 'a1', roles: ['AGENT'], changedBy: 'adm', at: '2026-11-04T10:00:00Z' },
      { accountId: 'a3', roles: [], changedBy: 'adm', at: '2026-11-04T11:00:00Z' },
    ]);
    expect(await new KvsRoleStore().history('c', 'ITS', 1)).toHaveLength(1);
  });

  it.each(['a#b', 'a b', '', '../x', 'x'.repeat(101)])('rejects key segment %j (prefix escape)', async (bad) => {
    const s = new KvsRoleStore();
    await expect(s.get(bad, 'ITS', 'a')).rejects.toThrow('invalid key segment');
    await expect(s.get('c', bad, 'a')).rejects.toThrow('invalid key segment');
    await expect(s.get('c', 'ITS', bad)).rejects.toThrow('invalid key segment');
    await expect(s.list(bad, 'ITS')).rejects.toThrow('invalid key segment');
    await expect(s.set('c', 'ITS', bad, ['AGENT'], 'adm', '2026-11-04T10:00:00Z')).rejects.toThrow('invalid key segment');
  });
});
