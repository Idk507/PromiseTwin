import { beforeEach, describe, expect, it } from 'vitest';
import { ContractService, MAX_CONTRACTS_PER_ISSUE, type ContractView, type RequestContext, type ServiceResult } from '../src/service/contract-service';
import { LinkedWorkSync, SWEEP_CONTRACT_LIMIT, SWEEP_ISSUE_LIMIT } from '../src/service/linked-work-sync';
import { MemoryContractRepository } from '../src/service/memory-repository';
import { MemoryInbox, MemoryLinkIndex, MemoryRoleStore, MemorySweepState } from '../src/service/memory-stores';
import type { ContractRepository, IssueMeta, IssueState, JiraAppPort, JiraPermissions, JiraPort } from '../src/service/ports';
import { createContract } from '../src/domain/lifecycle';
import { tenantFromInstallContext } from '../src/events/tenant';

// ---- fake Jira world -------------------------------------------------------------------------
interface Issue { id: string; key: string; category: string; status: string; updated: string; readers: Set<string>; appReadable: boolean }
let issues: Record<string, Issue>;
const perms: Record<string, JiraPermissions> = {
  owner: { editIssues: true, administerProject: false },
  other: { editIssues: true, administerProject: false },
  viewer: { editIssues: false, administerProject: false },
};
class UserJira implements JiraPort {
  constructor(private account: string) {}
  async getIssueMeta(key: string): Promise<IssueMeta | undefined> {
    const i = Object.values(issues).find((x) => x.key === key);
    return i && i.readers.has(this.account) ? { id: i.id, key: i.key, revision: i.updated, statusCategory: i.category, statusName: i.status, facts: { id: i.id, key: i.key, statusCategory: i.category, resolutionSet: false, labels: [], linkedIssueIds: [], linkedIssueKeys: [] } } : undefined;
  }
  async getPermissions() { return perms[this.account] ?? { editIssues: false, administerProject: false }; }
}
let appCalls: string[][];
const app: JiraAppPort = {
  async getIssueStates(ids) {
    appCalls.push([...ids]);
    return ids.map((id) => issues[id]).filter((i): i is Issue => !!i && i.appReadable)
      .map((i): IssueState => ({ id: i.id, key: i.key, statusCategory: i.category, statusName: i.status, updated: i.updated }));
  },
};

let repo: MemoryContractRepository;
let index: MemoryLinkIndex;
let inbox: MemoryInbox;
let sweep: MemorySweepState;
let tick = 0;
const clock = { now: () => new Date(Date.UTC(2026, 10, 3, 12, 0, tick++)).toISOString() };
const makeSync = (r: ContractRepository = repo) => new LinkedWorkSync({ repo: r, index, inbox, jiraApp: app, sweep, clock });
let roleStore: MemoryRoleStore;
const makeSvc = (account: string, r: ContractRepository = repo) =>
  new ContractService({ repo: r, jira: new UserJira(account), clock, ids: { uuid: () => 'unused-id' }, index, sync: makeSync(r), roles: roleStore });
const ctx = (account: string, issueKey = 'ITS-1', tenantId = 'cloud-1'): RequestContext => ({ tenantId, accountId: account, issueKey });

let rid = 0;
const newInput = () => ({
  requestId: `req-${String(++rid).padStart(8, '0')}`, customerReference: 'ACME', promiseText: 'Fix it',
  criteria: [{ id: 'c1', type: 'LINKED_WORK', description: 'Fix released', required: true, predicates: [{ kind: 'CUSTOMER_LABEL' }, { kind: 'LINKED_TO_SOURCE' }] }],
});
let ev = 0;
const eid = () => `evt-${String(++ev).padStart(8, '0')}`;
const ok = <T,>(r: ServiceResult<T>): T => { if (!r.ok) throw new Error(`refused ${r.code} ${r.detail?.join(',') ?? ''}`); return r.value; };
const cmd = (v: ContractView, body: Record<string, unknown>) => ({ contractId: v.contract.id, eventId: eid(), expectedRevision: v.contract.revision, ...body });

const T = 'cloud-1';
async function newLinked(): Promise<ContractView> {
  let v = ok(await makeSvc('owner').create(ctx('owner'), newInput()));
  v = ok(await makeSvc('owner').apply(ctx('owner'), cmd(v, { type: 'LINK_WORK', issueKey: 'DEV-7' })));
  return v;
}
const stored = async (v: ContractView) => (await repo.get(T, '1001', v.contract.id))!;

beforeEach(() => {
  tick = 0; rid = 0; ev = 0; appCalls = [];
  repo = new MemoryContractRepository(); index = new MemoryLinkIndex(); inbox = new MemoryInbox(); sweep = new MemorySweepState();
  roleStore = new MemoryRoleStore();
  for (const tenant of ['cloud-1', 'cloud-2']) for (const acct of ['owner', 'other']) roleStore.assign(tenant, 'ITS', acct, ['AGENT', 'REVIEWER', 'ACKNOWLEDGER']);
  const mk = (id: string, key: string, over: Partial<Issue> = {}): Issue => ({ id, key, category: 'indeterminate', status: 'In Progress', updated: '2026-11-03T09:00:00.000-0500', readers: new Set(['owner', 'other']), appReadable: true, ...over });
  issues = {
    '1001': mk('1001', 'ITS-1', { readers: new Set(['owner', 'other', 'viewer']) }),
    '2001': mk('2001', 'DEV-7'),
    '2002': mk('2002', 'DEV-8', { readers: new Set(['owner']) }), // 'other' cannot read it
  };
});

describe('tenant from install context', () => {
  it.each([
    ['ari:cloud:jira::site/0A1B2C3D-1111-2222-3333-444455556666', '0a1b2c3d-1111-2222-3333-444455556666'],
    ['ari:cloud:jira::site/0a1b2c3d-1111-2222-3333-444455556666/activation/x', '0a1b2c3d-1111-2222-3333-444455556666'],
  ])('derives %s', (ari, want) => expect(tenantFromInstallContext(ari)).toBe(want));
  it.each([[undefined], [null], [42], [''], ['not an ari'], ['ari:cloud:jira::site/no-uuid-here'], ['ari:cloud:' + 'x'.repeat(400)], ['https://evil/0a1b2c3d-1111-2222-3333-444455556666']])('rejects %j', (v) => {
    expect(tenantFromInstallContext(v)).toBeUndefined();
  });
});

describe('linking through the service', () => {
  it('stores a SERVER-observed snapshot and maintains the index (positive)', async () => {
    const v = await newLinked();
    expect(v.contract.linkedWork[0]).toMatchObject({ issueId: '2001', issueKey: 'DEV-7', statusCategory: 'indeterminate', statusName: 'In Progress', linkedBy: 'owner' });
    expect(index.rows.has(`${T}#2001#1001#${v.contract.id}`)).toBe(true);
    expect(v.audit.map((a) => a.type)).toContain('LINK_WORK');
  });

  it('ignores client-supplied status/ids: the snapshot always comes from Jira', async () => {
    let v = ok(await makeSvc('owner').create(ctx('owner'), newInput()));
    v = ok(await makeSvc('owner').apply(ctx('owner'), { ...cmd(v, { type: 'LINK_WORK', issueKey: 'DEV-7' }), statusCategory: 'done', statusName: 'Done', issueId: '9999', link: { issueId: '9999' } }));
    expect(v.contract.linkedWork[0]).toMatchObject({ issueId: '2001', statusCategory: 'indeterminate' });
  });

  it('refuses a work item the user cannot read, and a read-only user', async () => {
    const v = ok(await makeSvc('owner').create(ctx('owner'), newInput()));
    expect(await makeSvc('other').apply(ctx('other'), cmd(v, { type: 'LINK_WORK', issueKey: 'DEV-8' }))).toMatchObject({ ok: false, code: 'SOURCE_NOT_ACCESSIBLE' });
    expect(await makeSvc('viewer').apply(ctx('viewer'), cmd(v, { type: 'LINK_WORK', issueKey: 'DEV-7' }))).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
    expect((await stored(v)).linkedWork).toEqual([]);
    expect(index.rows.size).toBe(0);
  });

  it.each([['lowercase', 'dev-7'], ['injection', 'DEV-7 OR 1=1'], ['empty', '']])('rejects a malformed issue key (%s)', async (_n, key) => {
    const v = ok(await makeSvc('owner').create(ctx('owner'), newInput()));
    expect(await makeSvc('owner').apply(ctx('owner'), cmd(v, { type: 'LINK_WORK', issueKey: key }))).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('unlinks and cleans the index; unknown key refused', async () => {
    const v = await newLinked();
    expect(await makeSvc('owner').apply(ctx('owner'), cmd(v, { type: 'UNLINK_WORK', issueKey: 'DEV-99' }))).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    const after = ok(await makeSvc('owner').apply(ctx('owner'), cmd(v, { type: 'UNLINK_WORK', issueKey: 'DEV-7' })));
    expect(after.contract.linkedWork).toEqual([]);
    expect(index.rows.size).toBe(0);
  });

  it('a failed index write does not fail the user command (reconcile repairs)', async () => {
    const v = ok(await makeSvc('owner').create(ctx('owner'), newInput()));
    const broken: typeof index = Object.assign(new MemoryLinkIndex(), { add: async () => { throw new Error('index down'); } });
    const s = new ContractService({ repo, jira: new UserJira('owner'), clock, ids: { uuid: () => 'u' }, index: broken, sync: makeSync(), roles: roleStore });
    const out = ok(await s.apply(ctx('owner'), cmd(v, { type: 'LINK_WORK', issueKey: 'DEV-7' })));
    expect(out.contract.linkedWork).toHaveLength(1);
  });
});

describe('redaction of linked work per viewer', () => {
  it('a user who cannot read the linked issue does not see its status or key', async () => {
    let v = ok(await makeSvc('owner').create(ctx('owner'), newInput()));
    v = ok(await makeSvc('owner').apply(ctx('owner'), cmd(v, { type: 'LINK_WORK', issueKey: 'DEV-8' }))); // only owner can read DEV-8
    const asOwner = ok(await makeSvc('owner').list(ctx('owner')))[0]!;
    expect(asOwner.contract.linkedWork.map((l) => l.issueKey)).toEqual(['DEV-8']);
    expect(asOwner.hiddenLinks).toBe(0);
    const asOther = ok(await makeSvc('other').list(ctx('other')))[0]!;
    expect(asOther.contract.linkedWork).toEqual([]);
    expect(asOther.hiddenLinks).toBe(1);
    expect(JSON.stringify(asOther)).not.toContain('DEV-8');
  });
});

describe('event handling', () => {
  it('records the new status without changing lifecycle or proof (Done != Fulfilled)', async () => {
    const v = await newLinked();
    issues['2001']!.category = 'done'; issues['2001']!.status = 'Done'; issues['2001']!.updated = '2026-11-03T10:00:00.000-0500';
    const r = await makeSync().handleIssueUpdated(T, { issueId: '2001', updated: issues['2001']!.updated });
    expect(r).toMatchObject({ applied: 1, contractsScanned: 1 });
    const c = await stored(v);
    expect(c.linkedWork[0]).toMatchObject({ statusCategory: 'done', statusName: 'Done' });
    expect(c.lifecycle).toBe('DRAFT');
    expect(c.evidence).toEqual([]);
    const view = ok(await makeSvc('owner').list(ctx('owner')))[0]!;
    expect(view.decision.canFulfill).toBe(false);
    expect(view.audit.at(-1)).toMatchObject({ type: 'OBSERVE_LINKED_WORK', actorAccountId: 'system:event', actorRoles: ['SYSTEM'] });
  });

  it('a duplicate delivery is processed once', async () => {
    const v = await newLinked();
    const rev0 = (await stored(v)).revision;
    issues['2001']!.category = 'done'; issues['2001']!.updated = '2026-11-03T10:00:00.000-0500';
    const sync = makeSync();
    expect(await sync.handleIssueUpdated(T, { issueId: '2001', updated: issues['2001']!.updated })).toMatchObject({ applied: 1 });
    expect(await sync.handleIssueUpdated(T, { issueId: '2001', updated: issues['2001']!.updated })).toMatchObject({ skipped: 'DUPLICATE', applied: 0 });
    expect((await stored(v)).revision).toBe(rev0 + 1);
  });

  it('an unlinked issue costs one index read: no inbox write, no Jira call', async () => {
    await newLinked();
    const r = await makeSync().handleIssueUpdated(T, { issueId: '1001', updated: '2026-11-03T10:00:00.000-0500' });
    expect(r).toMatchObject({ skipped: 'NOT_LINKED' });
    expect(inbox.claims).toBe(0);
    expect(appCalls).toEqual([]);
  });

  it.each([
    ['missing tenant', undefined, { issueId: '2001', updated: 'x' }, 'NO_TENANT'],
    ['non-numeric issue id', T, { issueId: '2001 OR 1=1', updated: 'x' }, 'BAD_ISSUE_ID'],
    ['no issue id', T, {}, 'BAD_ISSUE_ID'],
    ['issue id of wrong type', T, { issueId: 2001 }, 'BAD_ISSUE_ID'],
  ])('ignores %s with no reads', async (_n, tenant, payload, why) => {
    await newLinked();
    const r = await makeSync().handleIssueUpdated(tenant, payload);
    expect(r.skipped).toBe(why);
    expect(appCalls).toEqual([]);
    expect(inbox.claims).toBe(0);
  });

  it('never touches another tenant\'s contracts', async () => {
    const v = await newLinked(); // tenant cloud-1
    issues['2001']!.category = 'done'; issues['2001']!.updated = '2026-11-03T10:00:00.000-0500';
    const r = await makeSync().handleIssueUpdated('cloud-2', { issueId: '2001', updated: issues['2001']!.updated });
    expect(r.skipped).toBe('NOT_LINKED');
    expect((await stored(v)).linkedWork[0]!.statusCategory).toBe('indeterminate');
  });

  it('out-of-order delivery: an older state never overwrites a newer one', async () => {
    const v = await newLinked();
    const sync = makeSync();
    issues['2001']!.category = 'done'; issues['2001']!.status = 'Done'; issues['2001']!.updated = '2026-11-03T11:00:00.000-0500';
    await sync.handleIssueUpdated(T, { issueId: '2001', updated: '2026-11-03T11:00:00.000-0500' });
    // a delayed older delivery whose re-read (stale cache) returns the older state
    issues['2001']!.category = 'indeterminate'; issues['2001']!.status = 'In Progress'; issues['2001']!.updated = '2026-11-03T10:00:00.000-0500';
    const r = await sync.handleIssueUpdated(T, { issueId: '2001', updated: '2026-11-03T10:00:00.000-0500' });
    expect(r.unchanged).toBe(1);
    expect((await stored(v)).linkedWork[0]).toMatchObject({ statusCategory: 'done', observedUpdated: '2026-11-03T11:00:00.000-0500' });
  });

  it('an unreadable issue is "unknown": the snapshot is left alone (never deleted/done)', async () => {
    const v = await newLinked();
    issues['2001']!.appReadable = false;
    const r = await makeSync().handleIssueUpdated(T, { issueId: '2001', updated: '2026-11-03T10:00:00.000-0500' });
    expect(r.unreadable).toBe(1);
    expect((await stored(v)).linkedWork[0]!.statusCategory).toBe('indeterminate');
  });

  it('retries once on a revision conflict, then defers (no tight loop)', async () => {
    const v = await newLinked();
    issues['2001']!.category = 'done'; issues['2001']!.updated = '2026-11-03T10:00:00.000-0500';
    let saves = 0;
    const flaky: ContractRepository = Object.create(repo, { save: { value: async (...a: Parameters<ContractRepository['save']>) => (++saves === 1 ? 'CONFLICT' : repo.save(...a)) } });
    const r1 = await makeSync(flaky).handleIssueUpdated(T, { issueId: '2001', updated: issues['2001']!.updated });
    expect(r1).toMatchObject({ applied: 1, deferred: 0 });
    expect(saves).toBe(2);
    // permanent conflict -> defers after exactly two attempts
    issues['2001']!.category = 'indeterminate'; issues['2001']!.updated = '2026-11-03T11:00:00.000-0500';
    let attempts = 0;
    const stuck: ContractRepository = Object.create(repo, { save: { value: async () => { attempts++; return 'CONFLICT'; } } });
    const r2 = await makeSync(stuck).handleIssueUpdated(T, { issueId: '2001', updated: issues['2001']!.updated });
    expect(r2).toMatchObject({ applied: 0, deferred: 1 });
    expect(attempts).toBe(2);
    expect((await stored(v)).linkedWork[0]!.statusCategory).toBe('done'); // unchanged by the stuck writer
  });
});

describe('reconciliation recovers missed events', () => {
  it('applies a change whose event never arrived', async () => {
    const v = await newLinked();
    issues['2001']!.category = 'done'; issues['2001']!.status = 'Done'; issues['2001']!.updated = '2026-11-03T10:00:00.000-0500';
    const r = await makeSync().reconcile(T);
    expect(r).toMatchObject({ applied: 1 });
    expect((await stored(v)).linkedWork[0]!.statusCategory).toBe('done');
    expect((await stored(v)).lifecycle).toBe('DRAFT');
  });

  it('repairs a lost index row, which events alone could never find', async () => {
    const v = await newLinked();
    index.rows.clear(); // simulate a lost/missed index write
    issues['2001']!.category = 'done'; issues['2001']!.updated = '2026-11-03T10:00:00.000-0500';
    expect(await makeSync().handleIssueUpdated(T, { issueId: '2001', updated: issues['2001']!.updated })).toMatchObject({ skipped: 'NOT_LINKED' });
    expect((await stored(v)).linkedWork[0]!.statusCategory).toBe('indeterminate'); // event path missed it
    await makeSync().reconcile(T);
    expect((await stored(v)).linkedWork[0]!.statusCategory).toBe('done'); // sweep recovered it
    expect(index.rows.has(`${T}#2001#1001#${v.contract.id}`)).toBe(true); // and healed the index
  });

  it('does not rewrite a healthy index (read-first, write only what is missing)', async () => {
    await newLinked();
    const writesAfterLink = index.adds;
    await makeSync().reconcile(T);
    await makeSync().reconcile(T);
    expect(index.adds).toBe(writesAfterLink);
  });

  it('is idempotent: a second sweep with no changes applies nothing', async () => {
    await newLinked();
    issues['2001']!.category = 'done'; issues['2001']!.updated = '2026-11-03T10:00:00.000-0500';
    const sync = makeSync();
    await sync.reconcile(T);
    expect(await sync.reconcile(T)).toMatchObject({ applied: 0 });
  });

  it('skips contracts without links and tolerates unreadable issues', async () => {
    ok(await makeSvc('owner').create(ctx('owner'), newInput())); // no links
    await newLinked();
    issues['2001']!.appReadable = false;
    const r = await makeSync().reconcile(T);
    expect(r.applied).toBe(0);
    expect(r.unreadable).toBe(1);
  });

  it('is bounded and cannot starve: many heavy contracts are all reached over several sweeps', async () => {
    // 12 contracts, each linking 10 DISTINCT issues = 120 issue ids, more than one run may read.
    const make = async (n: number) => {
      const r = createContract({ ...newInput(), source: { product: 'JIRA', site: T, issueId: '1001', issueKey: 'ITS-1' } }, { id: `c-${String(n).padStart(8, '0')}`, tenantId: T, ownerAccountId: 'owner', actor: { accountId: 'owner', roles: ['AGENT'] }, at: '2026-11-03T08:00:00Z' });
      if (!r.ok || r.duplicate) throw new Error('setup');
      const links = Array.from({ length: 10 }, (_, i) => {
        const id = String(10000 + n * 10 + i);
        issues[id] = { id, key: `BULK-${n * 10 + i + 1}`, category: 'indeterminate', status: 'In Progress', updated: '2026-11-03T09:00:00.000-0500', readers: new Set(['owner']), appReadable: true };
        return { issueId: id, issueKey: `BULK-${n * 10 + i + 1}`, statusCategory: 'indeterminate', statusName: 'In Progress', observedUpdated: '2026-11-03T09:00:00.000-0500', linkedAt: '2026-11-03T08:00:00Z', linkedBy: 'owner' };
      });
      const c = { ...r.contract, source: { ...r.contract.source, issueId: '1001' }, linkedWork: links };
      await repo.create(c, { ...r.event });
      return c;
    };
    const all = [];
    for (let n = 0; n < 12; n++) all.push(await make(n));
    Object.values(issues).filter((i) => i.key.startsWith('BULK-')).forEach((i) => { i.category = 'done'; i.updated = '2026-11-03T11:00:00.000-0500'; });
    const sync = makeSync();
    let runs = 0;
    for (; runs < 20; runs++) {
      const before = appCalls.length;
      const r = await sync.reconcile(T);
      const read = appCalls.slice(before).reduce((n, c) => n + c.length, 0);
      expect(read).toBeLessThanOrEqual(SWEEP_ISSUE_LIMIT);
      expect(r.contractsScanned).toBeLessThanOrEqual(SWEEP_CONTRACT_LIMIT);
      if (r.contractsScanned === 0 || (await sweep.get(T)) === undefined) { runs++; break; }
    }
    expect(runs).toBeGreaterThan(1); // needed more than one sweep
    for (const c of all) expect((await repo.get(T, '1001', c.id))!.linkedWork.every((l) => l.statusCategory === 'done')).toBe(true);
  });
});

describe('user-triggered refresh', () => {
  it('pulls the new status through the same path; lifecycle untouched', async () => {
    const v = await newLinked();
    issues['2001']!.category = 'done'; issues['2001']!.status = 'Done'; issues['2001']!.updated = '2026-11-03T10:00:00.000-0500';
    const out = ok(await makeSvc('owner').refresh(ctx('owner'), v.contract.id));
    expect(out.contract.linkedWork[0]).toMatchObject({ statusCategory: 'done' });
    expect(out.contract.lifecycle).toBe('DRAFT');
    expect(out.audit.at(-1)).toMatchObject({ actorAccountId: 'system:refresh' });
  });

  it('refuses read-only users, other issues\' contracts, and malformed ids', async () => {
    const v = await newLinked();
    expect(await makeSvc('viewer').refresh(ctx('viewer'), v.contract.id)).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
    issues['3001'] = { id: '3001', key: 'ITS-3', category: 'new', status: 'Open', updated: '2026-11-03T09:00:00.000-0500', readers: new Set(['owner']), appReadable: true };
    expect(await makeSvc('owner').refresh(ctx('owner', 'ITS-3'), v.contract.id)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await makeSvc('owner').refresh(ctx('owner'), 'x#y')).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(await makeSvc('owner').refresh(ctx('owner'), { evil: true })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });
});

describe('limits', () => {
  it('per-issue contract cap still applies', () => { expect(MAX_CONTRACTS_PER_ISSUE).toBe(20); });
});
