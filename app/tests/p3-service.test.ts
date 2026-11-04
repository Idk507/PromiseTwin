import { beforeEach, describe, expect, it } from 'vitest';
import { ContractService, type ContractView, type RequestContext, type ServiceResult } from '../src/service/contract-service';
import { LinkedWorkSync } from '../src/service/linked-work-sync';
import { MemoryContractRepository } from '../src/service/memory-repository';
import { MemoryInbox, MemoryLinkIndex, MemoryRoleStore, MemorySweepState } from '../src/service/memory-stores';
import type { IssueMeta, JiraPermissions, JiraPort } from '../src/service/ports';
import { resolveRoles } from '../src/service/roles';
import type { IssueFacts } from '../src/domain/verification';

// ---- fake Jira world with MUTABLE facts so scenarios can change what the evidence issue looks like
interface Issue { id: string; key: string; updated: string; readers: Set<string>; facts: IssueFacts }
let issues: Record<string, Issue>;
const perms: Record<string, JiraPermissions> = {
  admin: { editIssues: true, administerProject: true },
};
class UserJira implements JiraPort {
  constructor(private account: string) {}
  async getIssueMeta(key: string): Promise<IssueMeta | undefined> {
    const i = issues[key];
    return i && i.readers.has(this.account)
      ? { id: i.id, key, revision: i.updated, statusCategory: i.facts.statusCategory, statusName: 'x', facts: i.facts }
      : undefined;
  }
  async getPermissions() { return perms[this.account] ?? { editIssues: true, administerProject: false }; }
}

let repo: MemoryContractRepository;
let roles: MemoryRoleStore;
let index: MemoryLinkIndex;
let tick = 0;
let idSeq = 0; // unique ids per evidence item, like crypto.randomUUID in production
const clock = { now: () => new Date(Date.UTC(2026, 10, 4, 12, 0, tick++)).toISOString() };
const makeSvc = (account: string) =>
  new ContractService({
    repo, jira: new UserJira(account), clock, ids: { uuid: () => `id-${++idSeq}` }, index, roles,
    sync: new LinkedWorkSync({ repo, index, inbox: new MemoryInbox(), jiraApp: { getIssueStates: async () => [] }, sweep: new MemorySweepState(), clock }),
  });
const T = 'cloud-1';
const ctx = (account: string, issueKey = 'ITS-1', tenantId = T): RequestContext => ({ tenantId, accountId: account, issueKey });
const ok = <X,>(r: ServiceResult<X>): X => { if (!r.ok) throw new Error(`refused ${r.code} ${r.detail?.join(',') ?? ''}`); return r.value; };
let ev = 0; let rid = 0;
const eid = () => `evt-${String(++ev).padStart(8, '0')}`;
const cmd = (v: ContractView, body: Record<string, unknown>) => ({ contractId: v.contract.id, eventId: eid(), expectedRevision: v.contract.revision, ...body });

const PREDS = [{ kind: 'STATUS_CATEGORY_IS', value: 'done' }, { kind: 'RESOLUTION_SET' }, { kind: 'CUSTOMER_LABEL' }, { kind: 'LINKED_TO_SOURCE' }];
const input = (predicates: unknown[] = PREDS) => ({
  requestId: `req-${String(++rid).padStart(8, '0')}`, customerReference: 'ACME', promiseText: 'Deploy the fix for ACME',
  criteria: [{ id: 'c1', type: 'LINKED_WORK', description: 'Deployed for ACME', required: true, predicates }],
});
const goodFacts = (): IssueFacts => ({ id: '3001', key: 'DEV-1', statusCategory: 'done', resolutionSet: true, labels: ['customer-acme'], linkedIssueIds: ['1001'], linkedIssueKeys: ['ITS-1'] });

beforeEach(() => {
  tick = 0; ev = 0; rid = 0;
  repo = new MemoryContractRepository(); roles = new MemoryRoleStore(); index = new MemoryLinkIndex();
  roles.assign(T, 'ITS', 'owner', ['AGENT']);
  roles.assign(T, 'ITS', 'rev', ['REVIEWER']);
  roles.assign(T, 'ITS', 'cust', ['ACKNOWLEDGER']);
  roles.assign(T, 'ITS', 'contrib', ['CONTRIBUTOR']);
  const all = new Set(['owner', 'rev', 'cust', 'contrib', 'admin', 'nobody']);
  idSeq = 0;
  issues = {
    'ITS-1': { id: '1001', key: 'ITS-1', updated: 'u1', readers: new Set(all), facts: { id: '1001', key: 'ITS-1', statusCategory: 'indeterminate', resolutionSet: false, labels: [], linkedIssueIds: [], linkedIssueKeys: [] } },
    'DEV-1': { id: '3001', key: 'DEV-1', updated: '2026-11-04T09:00:00.000-0500', readers: new Set(all), facts: { ...goodFacts(), statusCategory: 'indeterminate', resolutionSet: false, labels: [], linkedIssueIds: [], linkedIssueKeys: [] } },
    'DEV-2': { id: '3002', key: 'DEV-2', updated: 'v1', readers: new Set(['owner']), facts: { ...goodFacts(), id: '3002', key: 'DEV-2' } },
  };
});

/** Drives a contract to the point where evidence exists and is reviewed VALID. */
async function reviewedContract(predicates?: unknown[]) {
  let v = ok(await makeSvc('owner').create(ctx('owner'), input(predicates)));
  v = ok(await makeSvc('owner').apply(ctx('owner'), cmd(v, { type: 'CONFIRM' })));
  v = ok(await makeSvc('owner').apply(ctx('owner'), cmd(v, { type: 'START' })));
  v = ok(await makeSvc('owner').apply(ctx('owner'), cmd(v, { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: 'DEV-1' })));
  v = ok(await makeSvc('rev').apply(ctx('rev'), cmd(v, { type: 'REVIEW_EVIDENCE', evidenceId: v.contract.evidence[0]!.id, status: 'VALID' })));
  return v;
}
const status = async (acct = 'rev') => ok(await makeSvc(acct).list(ctx(acct)))[0]!;

describe('PRD J3/J5: positive and negative evidence scenarios through the real service', () => {
  it('J3: customer-specific evidence that satisfies every predicate reaches FULFILLED, with a decision report', async () => {
    let v = await reviewedContract();
    expect(v.decision.criteria[0]!.status).toBe('unmet'); // issue is not done / not labelled / not linked yet
    Object.assign(issues['DEV-1']!.facts, goodFacts()); issues['DEV-1']!.updated = '2026-11-04T10:00:00.000-0500';
    // the source changed since review -> stale until it is added again and re-reviewed
    expect((await status()).decision.criteria[0]!.status).toBe('stale');
    v = ok(await makeSvc('owner').apply(ctx('owner'), cmd(await status('owner'), { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: 'DEV-1' })));
    const fresh = v.contract.evidence.find((e) => e.reviewStatus === 'PENDING')!;
    v = ok(await makeSvc('rev').apply(ctx('rev'), cmd(v, { type: 'REVIEW_EVIDENCE', evidenceId: fresh.id, status: 'VALID' })));
    expect(v.decision.criteria[0]!.status).toBe('satisfied');
    v = ok(await makeSvc('owner').apply(ctx('owner'), cmd(v, { type: 'MARK_DELIVERED' })));
    v = ok(await makeSvc('rev').apply(ctx('rev'), cmd(v, { type: 'VERIFY' })));
    v = ok(await makeSvc('cust').apply(ctx('cust'), cmd(v, { type: 'ACKNOWLEDGE', decision: 'GRANTED' })));
    v = ok(await makeSvc('rev').apply(ctx('rev'), cmd(v, { type: 'FULFILL' })));
    expect(v.contract.lifecycle).toBe('FULFILLED');
    const decision = v.audit.find((a) => a.type === 'FULFILL')!;
    expect(decision.report).toMatchObject({ canFulfill: true, criteria: [{ criterionId: 'c1', status: 'satisfied' }] });
    expect(decision.report!.criteria[0]!.evidence.some((e) => e.predicates.length === 4 && e.predicates.every((p) => p.ok))).toBe(true);
    expect(v.audit.find((a) => a.type === 'VERIFY')!.report).toBeDefined();
  });

  it.each([
    ['evidence issue is not Done', (f: IssueFacts) => { f.statusCategory = 'indeterminate'; }, 'STATUS_CATEGORY_IS'],
    ['wrong customer label', (f: IssueFacts) => { f.labels = ['customer-globex']; }, 'CUSTOMER_LABEL'],
    ['no customer label at all', (f: IssueFacts) => { f.labels = []; }, 'CUSTOMER_LABEL'],
    ['unrelated issue (not linked to the request)', (f: IssueFacts) => { f.linkedIssueIds = []; f.linkedIssueKeys = []; }, 'LINKED_TO_SOURCE'],
    ['no resolution', (f: IssueFacts) => { f.resolutionSet = false; }, 'RESOLUTION_SET'],
  ])('J5: %s => VERIFY refused with the exact reason', async (_n, mutate, kind) => {
    let v = await reviewedContract();
    Object.assign(issues['DEV-1']!.facts, goodFacts()); mutate(issues['DEV-1']!.facts); issues['DEV-1']!.updated = '2026-11-04T10:00:00.000-0500';
    // re-add + re-review against the current revision so staleness is not what blocks it
    v = ok(await makeSvc('owner').apply(ctx('owner'), cmd(await status('owner'), { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: 'DEV-1' })));
    v = ok(await makeSvc('rev').apply(ctx('rev'), cmd(v, { type: 'REVIEW_EVIDENCE', evidenceId: v.contract.evidence.find((e) => e.reviewStatus === 'PENDING')!.id, status: 'VALID' })));
    v = ok(await makeSvc('owner').apply(ctx('owner'), cmd(v, { type: 'MARK_DELIVERED' })));
    const r = await makeSvc('rev').apply(ctx('rev'), cmd(v, { type: 'VERIFY' }));
    expect(r).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' });
    expect(JSON.stringify(r)).toContain(`PREDICATE_FAILED:c1:${kind}`);
    expect(v.contract.lifecycle).toBe('DELIVERED'); // nothing advanced
  });

  it('J5: an evidence source the reviewer cannot read is unauthorized, not usable', async () => {
    const v = await reviewedContract();
    issues['DEV-1']!.readers.delete('rev');
    expect((await status('rev')).decision.criteria[0]!.status).toBe('unauthorized');
    expect(v.contract.lifecycle).toBe('IN_PROGRESS');
  });

  it('the client cannot declare the customer: evidence is bound to the contract\'s customer server-side', async () => {
    let v = ok(await makeSvc('owner').create(ctx('owner'), input()));
    v = ok(await makeSvc('owner').apply(ctx('owner'), cmd(v, { type: 'CONFIRM' })));
    v = ok(await makeSvc('owner').apply(ctx('owner'), cmd(v, { type: 'START' })));
    v = ok(await makeSvc('owner').apply(ctx('owner'), { ...cmd(v, { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: 'DEV-1' }), customerReference: 'GLOBEX' }));
    expect(v.contract.evidence[0]!.customerReference).toBe('ACME');
  });

  it('J6: a FULFILLED promise whose proof stops holding is flagged review-required, with reasons, and is not changed', async () => {
    let v = await reviewedContract();
    Object.assign(issues['DEV-1']!.facts, goodFacts()); issues['DEV-1']!.updated = '2026-11-04T10:00:00.000-0500';
    v = ok(await makeSvc('owner').apply(ctx('owner'), cmd(await status('owner'), { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: 'DEV-1' })));
    v = ok(await makeSvc('rev').apply(ctx('rev'), cmd(v, { type: 'REVIEW_EVIDENCE', evidenceId: v.contract.evidence.find((e) => e.reviewStatus === 'PENDING')!.id, status: 'VALID' })));
    v = ok(await makeSvc('owner').apply(ctx('owner'), cmd(v, { type: 'MARK_DELIVERED' })));
    v = ok(await makeSvc('rev').apply(ctx('rev'), cmd(v, { type: 'VERIFY' })));
    v = ok(await makeSvc('cust').apply(ctx('cust'), cmd(v, { type: 'ACKNOWLEDGE', decision: 'GRANTED' })));
    v = ok(await makeSvc('rev').apply(ctx('rev'), cmd(v, { type: 'FULFILL' })));
    expect(v.reviewRequired).toEqual({ required: false, reasons: [] });
    issues['DEV-1']!.facts.labels = []; // the customer label is removed afterwards (revision unchanged on purpose)
    const after = await status('rev');
    expect(after.contract.lifecycle).toBe('FULFILLED'); // history is never rewritten
    expect(after.reviewRequired.required).toBe(true);
    expect(after.reviewRequired.reasons).toContain('PREDICATE_FAILED:c1:CUSTOMER_LABEL');
    expect(after.requiredCustomerLabel).toBe('customer-acme');
  });

  it('decision reports are redacted per viewer: no facts about evidence issues the viewer cannot read', async () => {
    let v = await reviewedContract();
    Object.assign(issues['DEV-1']!.facts, goodFacts()); issues['DEV-1']!.updated = '2026-11-04T10:00:00.000-0500';
    v = ok(await makeSvc('owner').apply(ctx('owner'), cmd(await status('owner'), { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: 'DEV-1' })));
    v = ok(await makeSvc('rev').apply(ctx('rev'), cmd(v, { type: 'REVIEW_EVIDENCE', evidenceId: v.contract.evidence.find((e) => e.reviewStatus === 'PENDING')!.id, status: 'VALID' })));
    v = ok(await makeSvc('owner').apply(ctx('owner'), cmd(v, { type: 'MARK_DELIVERED' })));
    v = ok(await makeSvc('rev').apply(ctx('rev'), cmd(v, { type: 'VERIFY' })));
    const asRev = (await status('rev')).audit.find((a) => a.type === 'VERIFY')!;
    expect(asRev.report!.criteria[0]!.evidence.length).toBeGreaterThan(0); // readers see the details
    issues['DEV-1']!.readers.delete('cust'); // cust can still read the promise (ITS-1) but not the evidence issue
    const asCust = (await status('cust')).audit.find((a) => a.type === 'VERIFY')!;
    expect(asCust.report!.criteria[0]!.evidence).toEqual([]);
    expect(JSON.stringify(asCust)).not.toContain('DEV-1');
    expect(asCust.report!.canFulfill).toBeDefined(); // the verdict itself is not hidden
  });

  it('legacy: a criterion stored before the policy (no predicates) still evaluates and progresses as written', async () => {
    const { createContract } = await import('../src/domain/lifecycle');
    const r = createContract(
      { customerReference: 'ACME', source: { product: 'JSM', site: 's', issueId: '1001', issueKey: 'ITS-1' }, promiseText: 'old promise',
        criteria: [{ id: 'c1', type: 'MANUAL_REVIEW', description: 'legacy', required: true, predicates: [] }] },
      { id: 'legacy-0001', tenantId: T, ownerAccountId: 'owner', actor: { accountId: 'owner', roles: ['AGENT'] }, at: '2026-11-01T00:00:00Z' });
    if (!r.ok || r.duplicate) throw new Error('setup');
    await repo.create(r.contract, r.event);
    const v = ok(await makeSvc('owner').apply(ctx('owner'), { contractId: 'legacy-0001', eventId: eid(), expectedRevision: 1, type: 'CONFIRM' }));
    expect(v.contract.lifecycle).toBe('CONFIRMED');
  });
});

describe('policy: minimum proof on new and amended promises', () => {
  const mk = (criteria: unknown[]) => ({ requestId: `req-${String(++rid).padStart(8, '0')}`, customerReference: 'ACME', promiseText: 'p', criteria });
  const crit = (over: Record<string, unknown> = {}) => ({ id: 'c1', type: 'LINKED_WORK', description: 'd', required: true, predicates: [], ...over });
  const BOTH = [{ kind: 'CUSTOMER_LABEL' }, { kind: 'LINKED_TO_SOURCE' }];

  it('refuses a promise with no checks and names exactly what is missing; nothing is stored', async () => {
    const r = await makeSvc('owner').create(ctx('owner'), mk([crit()]));
    expect(r).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(JSON.stringify(r)).toContain('MINIMUM_PROOF_REQUIRED.c1:CUSTOMER_LABEL');
    expect(JSON.stringify(r)).toContain('MINIMUM_PROOF_REQUIRED.c1:LINKED_TO_SOURCE');
    expect((await repo.listByIssue(T, '1001')).length).toBe(0);
  });

  it.each([
    ['only the customer label', [{ kind: 'CUSTOMER_LABEL' }], 'LINKED_TO_SOURCE'],
    ['only the request link', [{ kind: 'LINKED_TO_SOURCE' }], 'CUSTOMER_LABEL'],
    ['other checks but not the minimum', [{ kind: 'STATUS_CATEGORY_IS', value: 'done' }, { kind: 'RESOLUTION_SET' }], 'CUSTOMER_LABEL'],
  ])('refuses %s', async (_n, predicates, missing) => {
    const r = await makeSvc('owner').create(ctx('owner'), mk([crit({ predicates })]));
    expect(r).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(JSON.stringify(r)).toContain(`c1:${missing}`);
  });

  it.each(['MANUAL_REVIEW', 'ARTIFACT', 'CUSTOMER_CONFIRMATION', 'LINKED_WORK'])('the criterion type %s cannot be used to dodge the policy', async (type) => {
    expect(await makeSvc('owner').create(ctx('owner'), mk([crit({ type })]))).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('accepts the minimum, and extra checks on top of it', async () => {
    expect(await makeSvc('owner').create(ctx('owner'), mk([crit({ predicates: BOTH })]))).toMatchObject({ ok: true });
    expect(await makeSvc('owner').create(ctx('owner'), mk([crit({ predicates: [...BOTH, { kind: 'STATUS_CATEGORY_IS', value: 'done' }, { kind: 'RESOLUTION_SET' }] })]))).toMatchObject({ ok: true });
  });

  it('every REQUIRED criterion must comply; an OPTIONAL one is exempt because it never gates fulfilment', async () => {
    expect(await makeSvc('owner').create(ctx('owner'), mk([crit({ id: 'c1', predicates: BOTH }), crit({ id: 'c2', predicates: [] })]))).toMatchObject({ ok: false });
    expect(await makeSvc('owner').create(ctx('owner'), mk([crit({ id: 'c1', predicates: BOTH }), crit({ id: 'c2', required: false, predicates: [] })]))).toMatchObject({ ok: true });
  });

  it('a promise cannot hide behind "no required criteria": that is refused too', async () => {
    const v = ok(await makeSvc('owner').create(ctx('owner'), mk([crit({ id: 'c1', required: false, predicates: [] })])));
    expect(await makeSvc('owner').apply(ctx('owner'), cmd(v, { type: 'CONFIRM' }))).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' });
  });

  it('amendments cannot weaken proof below the minimum; compliant amendments work', async () => {
    const v = ok(await makeSvc('owner').create(ctx('owner'), mk([crit({ predicates: BOTH })])));
    const weaken = await makeSvc('admin').apply(ctx('admin'), cmd(v, { type: 'AMEND_CRITERIA', criteria: [crit({ predicates: [{ kind: 'RESOLUTION_SET' }] })], reason: 'relax' }));
    expect(weaken).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(JSON.stringify(weaken)).toContain('MINIMUM_PROOF_REQUIRED');
    const stronger = await makeSvc('admin').apply(ctx('admin'), cmd(v, { type: 'AMEND_CRITERIA', criteria: [crit({ predicates: [...BOTH, { kind: 'RESOLUTION_SET' }] })], reason: 'tighten' }));
    expect(stronger).toMatchObject({ ok: true });
  });
});

describe('app-level roles: default deny', () => {
  it('a user with no assignment is read-only: can list, cannot create or mutate', async () => {
    expect(await makeSvc('nobody').create(ctx('nobody'), input())).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
    const v = ok(await makeSvc('owner').create(ctx('owner'), input()));
    expect(await makeSvc('nobody').apply(ctx('nobody'), cmd(v, { type: 'CONFIRM' }))).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
    const listed = ok(await makeSvc('nobody').list(ctx('nobody')));
    expect(listed).toHaveLength(1);
    expect(listed[0]!.available).toEqual([]);
  });

  it('a Jira project admin gets APPROVER only: not AGENT, REVIEWER or ACKNOWLEDGER', async () => {
    expect(await makeSvc('admin').create(ctx('admin'), input())).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
    const v = ok(await makeSvc('owner').create(ctx('owner'), input()));
    const mine = (await makeSvc('admin').roleAdmin(ctx('admin')));
    expect(ok(mine).myRoles).toEqual(['APPROVER']);
    expect(await makeSvc('admin').apply(ctx('admin'), cmd(v, { type: 'CONFIRM' }))).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
    const amended = await makeSvc('admin').apply(ctx('admin'), cmd(v, { type: 'AMEND_CRITERIA', criteria: input().criteria, reason: 'scope' }));
    expect(amended).toMatchObject({ ok: true });
  });

  it('roles are per project and per tenant: ITS roles do nothing on another project or tenant', async () => {
    issues['DEV-9'] = { id: '4009', key: 'DEV-9', updated: 'u', readers: new Set(['owner']), facts: goodFacts() };
    expect(await makeSvc('owner').create(ctx('owner', 'DEV-9'), input())).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
    expect(await makeSvc('owner').create(ctx('owner', 'ITS-1', 'cloud-2'), input())).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
  });

  it('the CONTRIBUTOR role can only attach evidence', async () => {
    let v = ok(await makeSvc('owner').create(ctx('owner'), input()));
    v = ok(await makeSvc('owner').apply(ctx('owner'), cmd(v, { type: 'CONFIRM' })));
    v = ok(await makeSvc('owner').apply(ctx('owner'), cmd(v, { type: 'START' })));
    const added = ok(await makeSvc('contrib').apply(ctx('contrib'), cmd(v, { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: 'DEV-1' })));
    expect(added.contract.evidence).toHaveLength(1);
    // Review is attempted on evidence added by SOMEONE ELSE, so only the role (not the
    // self-review rule) can be what refuses the contributor.
    const others = ok(await makeSvc('owner').apply(ctx('owner'), cmd(added, { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: 'DEV-1' })));
    const id = others.contract.evidence.find((e) => e.addedBy === 'owner')!.id;
    v = others;
    for (const body of [{ type: 'REVIEW_EVIDENCE', evidenceId: id, status: 'VALID' }, { type: 'VERIFY' }, { type: 'MARK_DELIVERED' }, { type: 'FULFILL' }, { type: 'ACKNOWLEDGE', decision: 'GRANTED' }, { type: 'LINK_WORK', issueKey: 'DEV-1' }, { type: 'SET_AT_RISK', atRisk: true }]) {
      expect(await makeSvc('contrib').apply(ctx('contrib'), cmd(v, body))).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
    }
    expect(await makeSvc('contrib').create(ctx('contrib'), input())).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
  });

  it('resolveRoles ignores anything that is not assignable, so corrupted storage cannot grant APPROVER or SYSTEM', () => {
    const p = { editIssues: true, administerProject: false };
    expect(resolveRoles(p, ['APPROVER', 'SYSTEM', 'AGENT'] as never)).toEqual(['AGENT']);
    expect(resolveRoles(p, [])).toEqual([]);
    expect(resolveRoles({ editIssues: false, administerProject: true }, [])).toEqual(['APPROVER']);
    expect(resolveRoles({ editIssues: true, administerProject: true }, ['REVIEWER', 'REVIEWER'])).toEqual(['REVIEWER', 'APPROVER']);
  });
});

describe('app-level roles: administration', () => {
  it('only project admins can assign roles; assignments take effect immediately and are recorded', async () => {
    expect(await makeSvc('owner').setRoles(ctx('owner'), { accountId: 'nobody', roles: ['REVIEWER'] })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await makeSvc('rev').setRoles(ctx('rev'), { accountId: 'rev', roles: ['REVIEWER', 'AGENT'] })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await makeSvc('nobody').create(ctx('nobody'), input())).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });

    const out = ok(await makeSvc('admin').setRoles(ctx('admin'), { accountId: 'nobody', roles: ['AGENT'] }));
    expect(out.assignments).toContainEqual({ accountId: 'nobody', roles: ['AGENT'] });
    expect(out.history!.at(-1)).toMatchObject({ accountId: 'nobody', roles: ['AGENT'], changedBy: 'admin' });
    expect(ok(await makeSvc('nobody').create(ctx('nobody'), input())).contract.ownerAccountId).toBe('nobody');

    ok(await makeSvc('admin').setRoles(ctx('admin'), { accountId: 'nobody', roles: [] })); // clear = remove
    expect(await makeSvc('nobody').create(ctx('nobody'), input())).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
    expect((await roles.history(T, 'ITS', 10)).map((h) => h.roles.length)).toEqual([1, 0]);
  });

  it.each([
    ['APPROVER cannot be assigned', { accountId: 'nobody', roles: ['APPROVER'] }],
    ['SYSTEM cannot be assigned', { accountId: 'nobody', roles: ['SYSTEM'] }],
    ['unknown role', { accountId: 'nobody', roles: ['SUPERUSER'] }],
    ['injection-style account id', { accountId: 'x#y', roles: ['AGENT'] }],
    ['account id too long', { accountId: 'a'.repeat(129), roles: ['AGENT'] }],
    ['empty account id', { accountId: '', roles: ['AGENT'] }],
    ['roles not an array', { accountId: 'nobody', roles: 'AGENT' }],
    ['null', null],
  ])('rejects %s', async (_n, bad) => {
    expect(await makeSvc('admin').setRoles(ctx('admin'), bad)).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(roles.log).toEqual([]);
  });

  it('non-admins see only their own roles, never the assignments or the change history', async () => {
    ok(await makeSvc('admin').setRoles(ctx('admin'), { accountId: 'nobody', roles: ['AGENT'] }));
    const asRev = ok(await makeSvc('rev').roleAdmin(ctx('rev')));
    expect(asRev).toEqual({ projectKey: 'ITS', canAdminister: false, myRoles: ['REVIEWER'] });
    expect(JSON.stringify(asRev)).not.toContain('nobody');
    const asAdmin = ok(await makeSvc('admin').roleAdmin(ctx('admin')));
    expect(asAdmin.canAdminister).toBe(true);
    expect(asAdmin.assignments!.length).toBeGreaterThan(1);
  });

  it('role administration also requires access to the issue', async () => {
    issues['ITS-1']!.readers.delete('admin');
    expect(await makeSvc('admin').setRoles(ctx('admin'), { accountId: 'nobody', roles: ['AGENT'] })).toMatchObject({ ok: false, code: 'ISSUE_NOT_ACCESSIBLE' });
  });

  it('caps the number of assignments per project', async () => {
    for (let i = 0; i < 200; i++) roles.assign(T, 'ITS', `u${i}`, ['AGENT']);
    expect(await makeSvc('admin').setRoles(ctx('admin'), { accountId: 'brand-new', roles: ['AGENT'] })).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' });
    // changing an EXISTING assignment is still allowed at the cap
    expect(await makeSvc('admin').setRoles(ctx('admin'), { accountId: 'u1', roles: ['REVIEWER'] })).toMatchObject({ ok: true });
  });
});
