import { beforeEach, describe, expect, it } from 'vitest';
import { ContractService, MAX_CONTRACTS_PER_ISSUE, type ContractView, type RequestContext, type ServiceResult } from '../src/service/contract-service';
import { MemoryContractRepository } from '../src/service/memory-repository';
import type { IssueMeta, JiraPermissions, JiraPort } from '../src/service/ports';
import { LinkedWorkSync } from '../src/service/linked-work-sync';
import { MemoryInbox, MemoryLinkIndex, MemoryRoleStore, MemorySweepState } from '../src/service/memory-stores';

// ---- fake Jira world: issues, who can read them, per-user permissions ------------------------
interface World {
  issues: Record<string, { id: string; revision: string; readers: Set<string> }>;
  perms: Record<string, JiraPermissions>;
}
class FakeJira implements JiraPort {
  constructor(private w: World, private account: string) {}
  async getIssueMeta(key: string): Promise<IssueMeta | undefined> {
    const i = this.w.issues[key];
    return i && i.readers.has(this.account) ? { id: i.id, key, revision: i.revision, statusCategory: 'indeterminate', statusName: 'In Progress', facts: { id: i.id, key, statusCategory: 'indeterminate', resolutionSet: false, labels: ['customer-acme'], linkedIssueIds: ['1001'], linkedIssueKeys: ['ITS-1'] } } : undefined;
  }
  async getPermissions() {
    return this.w.perms[this.account] ?? { editIssues: false, administerProject: false };
  }
}

let world: World;
let repo: MemoryContractRepository;
let tick = 0;
let uuid = 0;
const nowFn = () => new Date(Date.UTC(2026, 10, 2, 10, 0, tick++)).toISOString();
/** Shared deps for tests that build a ContractService by hand. */
let roleStore: MemoryRoleStore;
/** Preload the assignments these tests implicitly relied on under the old Jira-permission mapping. */
const seedRoles = () => {
  roleStore = new MemoryRoleStore();
  for (const tenant of ['cloud-1', 'cloud-2']) {
    for (const acct of ['owner', 'rev', 'cust', 'other', 'admin']) roleStore.assign(tenant, 'ITS', acct, ['AGENT', 'REVIEWER', 'ACKNOWLEDGER']);
  }
};
const extraDeps = () => {
  const index = new MemoryLinkIndex();
  return {
    roles: roleStore,
    index,
    sync: new LinkedWorkSync({ repo, index, inbox: new MemoryInbox(), jiraApp: { getIssueStates: async () => [] }, sweep: new MemorySweepState(), clock: { now: nowFn } }),
  };
};
const svc = (account: string) =>
  new ContractService({
    repo,
    jira: new FakeJira(world, account),
    clock: { now: nowFn },
    ids: { uuid: () => `id-${String(++uuid).padStart(8, '0')}` },
    ...extraDeps(),
  });
const ctx = (account: string, issueKey = 'ITS-1', tenantId = 'cloud-1'): RequestContext => ({ tenantId, accountId: account, issueKey });

const createInput = {
  customerReference: 'ACME',
  promiseText: 'Ship the export fix to ACME',
  // Policy: required criteria must bind evidence to the customer and the promised request.
  criteria: [{ id: 'c1', type: 'LINKED_WORK', description: 'Fix released', required: true, predicates: [{ kind: 'CUSTOMER_LABEL' }, { kind: 'LINKED_TO_SOURCE' }] }],
};
let ev = 0;
let rid = 0;
/** Fresh create payload with its own idempotency key. */
const newInput = (over: Record<string, unknown> = {}) => ({ ...createInput, requestId: `req-${String(++rid).padStart(8, '0')}`, ...over });
const eid = () => `evt-${String(++ev).padStart(8, '0')}`;

function ok<T>(r: ServiceResult<T>): T {
  if (!r.ok) throw new Error(`refused ${r.code} ${r.detail?.join(',') ?? ''}`);
  return r.value;
}
const cmd = (v: ContractView, body: Record<string, unknown>) => ({
  contractId: v.contract.id, eventId: eid(), expectedRevision: v.contract.revision, ...body,
});

beforeEach(() => {
  tick = 0; uuid = 0; ev = 0; rid = 0;
  repo = new MemoryContractRepository();
  seedRoles();
  world = {
    issues: {
      'ITS-1': { id: '1001', revision: 'r1', readers: new Set(['owner', 'rev', 'cust', 'viewer']) },
      'ITS-2': { id: '1002', revision: 'r1', readers: new Set(['owner']) },
      'ITS-9': { id: '1009', revision: 'r1', readers: new Set(['owner', 'rev', 'cust']) }, // evidence source
    },
    perms: {
      owner: { editIssues: true, administerProject: false },
      rev: { editIssues: true, administerProject: false },
      cust: { editIssues: true, administerProject: false },
      admin: { editIssues: true, administerProject: true },
      viewer: { editIssues: false, administerProject: false }, // read-only
    },
  };
});

/** Drives a contract to FULFILLED across three distinct people. */
async function fulfil() {
  let v = ok(await svc('owner').create(ctx('owner'), newInput()));
  v = ok(await svc('owner').apply(ctx('owner'), cmd(v, { type: 'CONFIRM' })));
  v = ok(await svc('owner').apply(ctx('owner'), cmd(v, { type: 'START' })));
  v = ok(await svc('owner').apply(ctx('owner'), cmd(v, { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: 'ITS-9', customerReference: 'ACME' })));
  const evId = v.contract.evidence[0]!.id;
  v = ok(await svc('rev').apply(ctx('rev'), cmd(v, { type: 'REVIEW_EVIDENCE', evidenceId: evId, status: 'VALID' })));
  v = ok(await svc('owner').apply(ctx('owner'), cmd(v, { type: 'MARK_DELIVERED' })));
  v = ok(await svc('rev').apply(ctx('rev'), cmd(v, { type: 'VERIFY' })));
  v = ok(await svc('cust').apply(ctx('cust'), cmd(v, { type: 'ACKNOWLEDGE', decision: 'GRANTED' })));
  v = ok(await svc('rev').apply(ctx('rev'), cmd(v, { type: 'FULFILL' })));
  return v;
}

describe('end to end through the service', () => {
  it('reaches FULFILLED with three distinct people and an audit trail', async () => {
    const v = await fulfil();
    expect(v.contract.lifecycle).toBe('FULFILLED');
    expect(v.decision.canFulfill).toBe(true);
    expect(v.audit.map((a) => a.type)).toEqual(
      ['CREATED', 'CONFIRM', 'START', 'ADD_EVIDENCE', 'REVIEW_EVIDENCE', 'MARK_DELIVERED', 'VERIFY', 'ACKNOWLEDGE', 'FULFILL']);
  });

  it('proof goes stale when the source issue changes, and the contract can no longer be fulfilled', async () => {
    let v = await fulfil();
    world.issues['ITS-9']!.revision = 'r2'; // source edited after review
    v = ok(await svc('rev').list(ctx('rev'))).at(0)!;
    expect(v.decision.canFulfill).toBe(false);
    expect(v.decision.blockers).toContain('CRITERION_stale:c1');
  });

  it('proof becomes unauthorized when the acting user loses access to the source', async () => {
    await fulfil();
    world.issues['ITS-9']!.readers.delete('rev');
    const v = ok(await svc('rev').list(ctx('rev'))).at(0)!;
    expect(v.decision.blockers).toContain('CRITERION_unauthorized:c1');
  });
});

describe('access control', () => {
  it('refuses everything when the issue is not readable by the user', async () => {
    expect(await svc('rev').list(ctx('rev', 'ITS-2'))).toMatchObject({ ok: false, code: 'ISSUE_NOT_ACCESSIBLE' });
    expect(await svc('rev').create(ctx('rev', 'ITS-2'), newInput())).toMatchObject({ ok: false, code: 'ISSUE_NOT_ACCESSIBLE' });
  });

  it('a read-only user (no roles) cannot create or mutate', async () => {
    expect(await svc('viewer').create(ctx('viewer'), newInput())).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
    const v = ok(await svc('owner').create(ctx('owner'), newInput()));
    const r = await svc('viewer').apply(ctx('viewer'), cmd(v, { type: 'CONFIRM' }));
    expect(r).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
    expect(v.available).toContain('CONFIRM');
    expect(ok(await svc('viewer').list(ctx('viewer')))[0]!.available).toEqual([]);
  });

  it('a contractId from another issue is NOT FOUND (no IDOR across issues)', async () => {
    const v = ok(await svc('owner').create(ctx('owner', 'ITS-1'), newInput()));
    world.issues['ITS-3'] = { id: '1003', revision: 'r1', readers: new Set(['owner']) };
    const r = await svc('owner').apply(ctx('owner', 'ITS-3'), cmd(v, { type: 'CONFIRM' }));
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('a contractId from another tenant is NOT FOUND (no cross-tenant access)', async () => {
    const v = ok(await svc('owner').create(ctx('owner', 'ITS-1', 'cloud-1'), newInput()));
    const r = await svc('owner').apply(ctx('owner', 'ITS-1', 'cloud-2'), cmd(v, { type: 'CONFIRM' }));
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(ok(await svc('owner').list(ctx('owner', 'ITS-1', 'cloud-2')))).toEqual([]);
  });

  it('evidence from a source the user cannot read is refused', async () => {
    let v = ok(await svc('owner').create(ctx('owner'), newInput()));
    v = ok(await svc('owner').apply(ctx('owner'), cmd(v, { type: 'CONFIRM' })));
    // 'rev' has the AGENT role and can read ITS-1, but cannot read ITS-2 (only 'owner' can).
    const denied = await svc('rev').apply(ctx('rev'), cmd(v, { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: 'ITS-2', customerReference: 'ACME' }));
    expect(denied).toMatchObject({ ok: false, code: 'SOURCE_NOT_ACCESSIBLE' });
    // Positive control: the owner CAN read ITS-2, so the same command succeeds for them.
    const allowed = await svc('owner').apply(ctx('owner'), cmd(v, { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: 'ITS-2', customerReference: 'ACME' }));
    expect(allowed).toMatchObject({ ok: true });
  });

  it('the owner cannot acknowledge their own contract', async () => {
    let v = ok(await svc('owner').create(ctx('owner'), newInput()));
    v = ok(await svc('owner').apply(ctx('owner'), cmd(v, { type: 'CONFIRM' })));
    v = ok(await svc('owner').apply(ctx('owner'), cmd(v, { type: 'START' })));
    v = ok(await svc('owner').apply(ctx('owner'), cmd(v, { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: 'ITS-9', customerReference: 'ACME' })));
    v = ok(await svc('rev').apply(ctx('rev'), cmd(v, { type: 'REVIEW_EVIDENCE', evidenceId: v.contract.evidence[0]!.id, status: 'VALID' })));
    v = ok(await svc('owner').apply(ctx('owner'), cmd(v, { type: 'MARK_DELIVERED' })));
    v = ok(await svc('rev').apply(ctx('rev'), cmd(v, { type: 'VERIFY' })));
    expect(await svc('owner').apply(ctx('owner'), cmd(v, { type: 'ACKNOWLEDGE', decision: 'GRANTED' }))).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
  });
});

describe('idempotent create', () => {
  it('replaying the same requestId returns the same contract and stores one record', async () => {
    const input = newInput();
    const a = ok(await svc('owner').create(ctx('owner'), input));
    const b = ok(await svc('owner').create(ctx('owner'), input));
    expect(b.contract.id).toBe(a.contract.id);
    expect((await repo.listByIssue('cloud-1', '1001')).length).toBe(1);
    expect(repo.audit.filter((e) => e.type === 'CREATED')).toHaveLength(1);
  });

  it('another user cannot hijack an existing requestId', async () => {
    const input = newInput();
    ok(await svc('owner').create(ctx('owner'), input));
    expect(await svc('rev').create(ctx('rev'), input)).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' });
  });

  it.each([['missing', undefined], ['too short', 'abc'], ['unsafe chars', 'req#../x1234']])('rejects %s requestId', async (_n, id) => {
    expect(await svc('owner').create(ctx('owner'), { ...createInput, requestId: id })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });
});

describe('abuse limits', () => {
  it('caps contracts per issue', async () => {
    for (let i = 0; i < MAX_CONTRACTS_PER_ISSUE; i++) ok(await svc('owner').create(ctx('owner'), newInput()));
    expect(await svc('owner').create(ctx('owner'), newInput())).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED', detail: ['CONTRACT_LIMIT'] });
  });

  it('reads each source issue from Jira at most once per request', async () => {
    const reads: string[] = [];
    const counting = new FakeJira(world, 'owner');
    const orig = counting.getIssueMeta.bind(counting);
    counting.getIssueMeta = async (k: string) => { reads.push(k); return orig(k); };
    // two contracts on ITS-1, each citing the same evidence issue ITS-9
    for (let i = 0; i < 2; i++) {
      let v = ok(await svc('owner').create(ctx('owner'), newInput()));
      v = ok(await svc('owner').apply(ctx('owner'), cmd(v, { type: 'CONFIRM' })));
      ok(await svc('owner').apply(ctx('owner'), cmd(v, { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: 'ITS-9', customerReference: 'ACME' })));
    }
    const s = new ContractService({ repo, jira: counting, clock: { now: () => '2026-11-02T10:00:00.000Z' }, ids: { uuid: () => 'x' }, ...extraDeps() });
    ok(await s.list(ctx('owner')));
    expect(reads.filter((k) => k === 'ITS-9')).toHaveLength(1);
    expect(reads.filter((k) => k === 'ITS-1')).toHaveLength(1);
  });
});

describe('untrusted client payloads', () => {
  it('ignores client-supplied actor, roles, tenant and source', async () => {
    const forged = { ...newInput(), source: { product: 'JSM', site: 'evil', issueId: '9999', issueKey: 'EVIL-1' }, ownerAccountId: 'admin', roles: ['APPROVER'], tenantId: 'cloud-2' };
    const v = ok(await svc('owner').create(ctx('owner'), forged));
    expect(v.contract.source).toMatchObject({ issueId: '1001', issueKey: 'ITS-1', site: 'cloud-1' });
    expect(v.contract.ownerAccountId).toBe('owner');
    expect(v.contract.tenantId).toBe('cloud-1');
  });

  it('a forged roles field on a command does not grant authority', async () => {
    const v = ok(await svc('owner').create(ctx('owner'), newInput()));
    const r = await svc('viewer').apply(ctx('viewer'), { ...cmd(v, { type: 'CONFIRM' }), roles: ['AGENT'], actor: { accountId: 'owner', roles: ['AGENT'] } });
    expect(r).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
  });

  it.each([
    ['unknown command type', { type: 'DELETE_ALL' }],
    ['missing eventId', { type: 'CONFIRM', eventId: undefined }],
    ['bad evidence ref (JQL-ish)', { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: 'ITS-1 OR project = X', customerReference: 'ACME' }],
    ['non-integer revision', { type: 'CONFIRM', expectedRevision: 1.5 }],
    ['empty reason on REOPEN', { type: 'REOPEN', reason: '' }],
  ])('rejects %s', async (_n, bad) => {
    const v = ok(await svc('owner').create(ctx('owner'), newInput()));
    const r = await svc('owner').apply(ctx('owner'), { ...cmd(v, { type: 'CONFIRM' }), ...bad });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('rejects non-object payloads', async () => {
    expect(await svc('owner').apply(ctx('owner'), null)).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(await svc('owner').create(ctx('owner'), 'x')).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('rejects a malformed issue key from context', async () => {
    expect(await svc('owner').list(ctx('owner', 'not a key'))).toMatchObject({ ok: false, code: 'ISSUE_NOT_ACCESSIBLE' });
  });
});

describe('concurrency and idempotency through the repository', () => {
  it('a stale expectedRevision from a second tab is a VERSION_CONFLICT', async () => {
    const v = ok(await svc('owner').create(ctx('owner'), newInput()));
    ok(await svc('owner').apply(ctx('owner'), cmd(v, { type: 'CONFIRM' })));
    const r = await svc('owner').apply(ctx('owner'), cmd(v, { type: 'SET_AT_RISK', atRisk: true })); // still holds old revision
    expect(r).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' });
  });

  it('replaying the same eventId does not write twice', async () => {
    const v = ok(await svc('owner').create(ctx('owner'), newInput()));
    const c = cmd(v, { type: 'CONFIRM' });
    ok(await svc('owner').apply(ctx('owner'), c));
    const auditBefore = repo.audit.length;
    const again = ok(await svc('owner').apply(ctx('owner'), c));
    expect(repo.audit.length).toBe(auditBefore);
    expect(again.contract.lifecycle).toBe('CONFIRMED');
  });

  it('the repository itself rejects a save whose expected revision is stale', async () => {
    const v = ok(await svc('owner').create(ctx('owner'), newInput()));
    const stored = (await repo.get('cloud-1', '1001', v.contract.id))!;
    const evt = repo.audit[0]!;
    expect(await repo.save({ ...stored, revision: 5 }, evt, 99, '1001')).toBe('CONFLICT');
    expect(await repo.save({ ...stored, revision: 2 }, evt, stored.revision, '1001')).toBe('OK');
  });
});
