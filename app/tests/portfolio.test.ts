import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContractService, PORTFOLIO_MAX_JIRA_READS, PORTFOLIO_PAGE_SIZE,
  type ContractView, type PortfolioContext, type RequestContext, type ServiceResult,
} from '../src/service/contract-service';
import { LinkedWorkSync } from '../src/service/linked-work-sync';
import { MemoryContractRepository } from '../src/service/memory-repository';
import { MemoryInbox, MemoryLinkIndex, MemoryRoleStore, MemorySweepState } from '../src/service/memory-stores';
import type { IssueMeta, JiraPermissions, JiraPort } from '../src/service/ports';
import type { IssueFacts } from '../src/domain/verification';

// Fake Jira world: per-account readers, so a viewer who cannot open an issue is modelled exactly.
interface Issue { id: string; key: string; updated: string; readers: Set<string>; facts: IssueFacts }
let issues: Record<string, Issue>;
let reads: string[];
class UserJira implements JiraPort {
  constructor(private account: string) {}
  async getIssueMeta(key: string): Promise<IssueMeta | undefined> {
    reads.push(key);
    const i = issues[key];
    return i && i.readers.has(this.account)
      ? { id: i.id, key, revision: i.updated, statusCategory: i.facts.statusCategory, statusName: 'x', facts: i.facts }
      : undefined;
  }
  async getPermissions(): Promise<JiraPermissions> { return { editIssues: true, administerProject: false }; }
}

let repo: MemoryContractRepository;
let roles: MemoryRoleStore;
let index: MemoryLinkIndex;
let tick = 0; let idSeq = 0; let rid = 0; let ev = 0;
const clock = { now: () => new Date(Date.UTC(2026, 10, 4, 12, 0, tick++)).toISOString() };
const makeSvc = (account: string) =>
  new ContractService({
    repo, jira: new UserJira(account), clock, ids: { uuid: () => `id-${++idSeq}` }, index, roles,
    sync: new LinkedWorkSync({ repo, index, inbox: new MemoryInbox(), jiraApp: { getIssueStates: async () => [] }, sweep: new MemorySweepState(), clock }),
  });
const T = 'cloud-1';
const ctx = (account: string, issueKey = 'ITS-1', tenantId = T): RequestContext => ({ tenantId, accountId: account, issueKey });
const pctx = (account: string, projectKey = 'ITS', tenantId = T): PortfolioContext => ({ tenantId, accountId: account, projectKey });
const ok = <X,>(r: ServiceResult<X>): X => { if (!r.ok) throw new Error(`refused ${r.code} ${r.detail?.join(',') ?? ''}`); return r.value; };
const eid = () => `evt-${String(++ev).padStart(8, '0')}`;
const cmd = (v: ContractView, body: Record<string, unknown>) => ({ contractId: v.contract.id, eventId: eid(), expectedRevision: v.contract.revision, ...body });
const PREDS = [{ kind: 'STATUS_CATEGORY_IS', value: 'done' }, { kind: 'RESOLUTION_SET' }, { kind: 'CUSTOMER_LABEL' }, { kind: 'LINKED_TO_SOURCE' }];
const input = (customer = 'ACME', text = 'Deploy the fix for ACME') => ({
  requestId: `req-${String(++rid).padStart(8, '0')}`, customerReference: customer, promiseText: text,
  criteria: [{ id: 'c1', type: 'LINKED_WORK', description: 'Deployed', required: true, predicates: PREDS }],
});
const everyone = ['owner', 'rev', 'cust', 'nobody'];
const mkIssue = (key: string, id: string, readers: string[] = everyone): Issue => ({
  id, key, updated: 'u1', readers: new Set(readers),
  facts: { id, key, statusCategory: 'indeterminate', resolutionSet: false, labels: [], linkedIssueIds: [], linkedIssueKeys: [] },
});

beforeEach(() => {
  tick = 0; idSeq = 0; rid = 0; ev = 0; reads = [];
  repo = new MemoryContractRepository(); roles = new MemoryRoleStore(); index = new MemoryLinkIndex();
  roles.assign(T, 'ITS', 'owner', ['AGENT']);
  roles.assign(T, 'ITS', 'rev', ['REVIEWER']);
  roles.assign(T, 'ITS', 'cust', ['ACKNOWLEDGER']);
  issues = {
    'ITS-1': mkIssue('ITS-1', '1001'),
    'ITS-2': mkIssue('ITS-2', '1002', ['owner']), // only the owner can open it
    'OTH-1': mkIssue('OTH-1', '2001'),
    'DEV-1': mkIssue('DEV-1', '3001'),
  };
});

const create = async (issueKey: string, customer = 'ACME', text?: string) =>
  ok(await makeSvc('owner').create(ctx('owner', issueKey), input(customer, text)));

describe('portfolio: scoping and per-viewer hiding', () => {
  it('lists only this project\'s promises and does not count other projects as hidden', async () => {
    roles.assign(T, 'OTH', 'owner', ['AGENT']);
    await create('ITS-1'); await create('OTH-1', 'GLOBEX');
    const p = ok(await makeSvc('rev').portfolio(pctx('rev')));
    expect(p.rows.map((r) => r.issueKey)).toEqual(['ITS-1']);
    expect(p.hidden).toBe(0);
    expect(p.rows[0]).toMatchObject({ customerReference: 'ACME', lifecycle: 'DRAFT' });
  });

  it('a viewer who cannot read the source issue gets a count, never the promise', async () => {
    await create('ITS-1', 'ACME', 'visible promise'); await create('ITS-2', 'SECRETCO', 'confidential commitment text');
    const asOwner = ok(await makeSvc('owner').portfolio(pctx('owner')));
    expect(asOwner.rows).toHaveLength(2);
    const asNobody = ok(await makeSvc('nobody').portfolio(pctx('nobody')));
    expect(asNobody.rows.map((r) => r.issueKey)).toEqual(['ITS-1']);
    expect(asNobody.hidden).toBe(1);
    const wire = JSON.stringify(asNobody);
    expect(wire).not.toContain('SECRETCO');
    expect(wire).not.toContain('confidential');
    expect(wire).not.toContain('ITS-2');
  });

  it('never returns another tenant\'s promises, even for the same project key', async () => {
    roles.assign('cloud-2', 'ITS', 'owner', ['AGENT']);
    await create('ITS-1', 'ACME');
    ok(await makeSvc('owner').create(ctx('owner', 'ITS-1', 'cloud-2'), input('OTHERTENANT')));
    const p = ok(await makeSvc('rev').portfolio(pctx('rev', 'ITS', T)));
    expect(p.rows.map((r) => r.customerReference)).toEqual(['ACME']);
    const q = ok(await makeSvc('rev').portfolio(pctx('rev', 'ITS', 'cloud-2')));
    expect(q.rows.map((r) => r.customerReference)).toEqual(['OTHERTENANT']);
  });

  it('drops foreign-tenant rows even if the repository leaks them (defence in depth)', async () => {
    roles.assign('cloud-2', 'ITS', 'owner', ['AGENT']);
    await create('ITS-1', 'ACME');
    ok(await makeSvc('owner').create(ctx('owner', 'ITS-1', 'cloud-2'), input('OTHERTENANT')));
    const leaky = new Proxy(repo, {
      get: (t, p, r) => (p === 'listPage' ? async (_tenant: string, after: string | undefined, limit: number) => t.listPage(T, after, limit).then(async (own) => [...own, ...(await t.listPage('cloud-2', undefined, limit))]) : Reflect.get(t, p, r)),
    });
    const svc = new ContractService({
      repo: leaky, jira: new UserJira('rev'), clock, ids: { uuid: () => `id-${++idSeq}` }, index, roles,
      sync: new LinkedWorkSync({ repo, index, inbox: new MemoryInbox(), jiraApp: { getIssueStates: async () => [] }, sweep: new MemorySweepState(), clock }),
    });
    const p = ok(await svc.portfolio(pctx('rev')));
    expect(p.rows.map((r) => r.customerReference)).toEqual(['ACME']);
  });

  it('rows carry stored facts only: no evidence keys, no Jira content', async () => {
    const v = await create('ITS-1');
    const s = makeSvc('owner');
    let c = ok(await s.apply(ctx('owner'), cmd(v, { type: 'CONFIRM' })));
    c = ok(await s.apply(ctx('owner'), cmd(c, { type: 'START' })));
    ok(await s.apply(ctx('owner'), cmd(c, { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: 'DEV-1' })));
    const p = ok(await makeSvc('owner').portfolio(pctx('owner')));
    expect(p.rows[0]!.evidence).toEqual({ valid: 0, pending: 1, invalid: 0 });
    expect(JSON.stringify(p)).not.toContain('DEV-1');
  });
});

describe('portfolio: input validation (negative)', () => {
  it.each(['', 'its', 'IT S', 'ITS-1', 'A', '../x', 'ITS;DROP', 'X'.repeat(40)])('refuses project key %j', async (k) => {
    const r = await makeSvc('rev').portfolio(pctx('rev', k));
    expect(r.ok).toBe(false);
    expect(reads).toHaveLength(0);
  });

  it.each([42, {}, [], 'cloud-2#x', 'cloud-1#a b', 'cloud-1#' + 'x'.repeat(400), '../../etc'])('refuses cursor %j', async (c) => {
    const r = await makeSvc('rev').portfolio(pctx('rev'), c);
    expect(r).toMatchObject({ ok: false, code: 'INVALID_INPUT', detail: ['cursor'] });
  });

  it('treats an empty or missing cursor as the first page', async () => {
    await create('ITS-1');
    for (const c of [undefined, null, '']) expect(ok(await makeSvc('rev').portfolio(pctx('rev'), c)).rows).toHaveLength(1);
  });
});

describe('portfolio: "needs my action" follows assigned roles, never grants anything', () => {
  it('owner sees confirm/start work, reviewer and acknowledger see nothing on a draft, no-role viewer sees nothing', async () => {
    await create('ITS-1');
    expect(ok(await makeSvc('owner').portfolio(pctx('owner'))).rows[0]!.needsMyAction).toBe(true);
    expect(ok(await makeSvc('rev').portfolio(pctx('rev'))).rows[0]!.needsMyAction).toBe(false);
    expect(ok(await makeSvc('cust').portfolio(pctx('cust'))).rows[0]!.needsMyAction).toBe(false);
    const none = ok(await makeSvc('nobody').portfolio(pctx('nobody')));
    expect(none.rows[0]!.needsMyAction).toBe(false);
    expect(none.rows[0]!.available).toEqual([]);
    expect(none.myRoles).toEqual([]);
  });

  it('a reviewer is asked to act only once evidence awaits review; an acknowledger only when verified', async () => {
    const s = makeSvc('owner');
    let v = await create('ITS-1');
    v = ok(await s.apply(ctx('owner'), cmd(v, { type: 'CONFIRM' })));
    v = ok(await s.apply(ctx('owner'), cmd(v, { type: 'START' })));
    v = ok(await s.apply(ctx('owner'), cmd(v, { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: 'DEV-1' })));
    v = ok(await s.apply(ctx('owner'), cmd(v, { type: 'MARK_DELIVERED' })));
    expect(ok(await makeSvc('rev').portfolio(pctx('rev'))).rows[0]!.needsMyAction).toBe(true); // pending evidence
    expect(ok(await makeSvc('cust').portfolio(pctx('cust'))).rows[0]!.needsMyAction).toBe(false);
    v = ok(await makeSvc('rev').apply(ctx('rev'), cmd(v, { type: 'REVIEW_EVIDENCE', evidenceId: v.contract.evidence[0]!.id, status: 'VALID' })));
    // Reviewed, but verify is also the reviewer's step in DELIVERED, so the reviewer is still asked.
    expect(ok(await makeSvc('rev').portfolio(pctx('rev'))).rows[0]!.available).toContain('VERIFY');
  });
});

describe('portfolio: paging and Jira-read cap', () => {
  it('pages without gaps or duplicates and stops with no cursor at the end', async () => {
    // Spread over 30 issues: one issue may hold at most 20 promises (CONTRACT_LIMIT).
    for (let i = 0; i < 30; i++) {
      const key = `ITS-${200 + i}`;
      issues[key] = mkIssue(key, String(7000 + i));
      await create(key, `C${i}`);
    }
    const first = ok(await makeSvc('rev').portfolio(pctx('rev')));
    expect(first.rows).toHaveLength(PORTFOLIO_PAGE_SIZE);
    expect(first.nextCursor).toBeTruthy();
    const second = ok(await makeSvc('rev').portfolio(pctx('rev'), first.nextCursor));
    expect(second.rows).toHaveLength(5);
    expect(second.nextCursor).toBeUndefined();
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(30);
  });

  it('a single request never makes more Jira reads than the cap, and resumes where it stopped', async () => {
    // 70 promises on 70 distinct issues the viewer cannot read: every row costs one read.
    for (let n = 0; n < 70; n++) {
      const key = `ITS-${100 + n}`;
      issues[key] = mkIssue(key, String(5000 + n), ['owner']);
      await create(key, `C${n}`);
    }
    reads = [];
    const first = ok(await makeSvc('nobody').portfolio(pctx('nobody')));
    expect(reads.length).toBeLessThanOrEqual(PORTFOLIO_MAX_JIRA_READS);
    expect(first.rows).toHaveLength(0);
    expect(first.hidden).toBe(PORTFOLIO_MAX_JIRA_READS);
    expect(first.nextCursor).toBeTruthy(); // not silently dropped: the viewer can continue
    reads = [];
    const second = ok(await makeSvc('nobody').portfolio(pctx('nobody'), first.nextCursor));
    expect(second.hidden).toBe(20); // 70 - 50
    expect(second.nextCursor).toBeUndefined();
    expect(first.hidden + second.hidden).toBe(70);
  });

  it('memoizes reads: many promises on one issue cost one read', async () => {
    for (let i = 0; i < 10; i++) await create('ITS-1', `C${i}`); // within the 20-per-issue cap
    reads = [];
    ok(await makeSvc('rev').portfolio(pctx('rev')));
    expect(reads.filter((k) => k === 'ITS-1')).toHaveLength(1);
  });
});

describe('portfolio: review-required is derived per viewer from live facts', () => {
  async function fulfilled() {
    issues['DEV-1']!.facts = { id: '3001', key: 'DEV-1', statusCategory: 'done', resolutionSet: true, labels: ['customer-acme'], linkedIssueIds: ['1001'], linkedIssueKeys: ['ITS-1'] };
    const s = makeSvc('owner');
    let v = await create('ITS-1');
    v = ok(await s.apply(ctx('owner'), cmd(v, { type: 'CONFIRM' })));
    v = ok(await s.apply(ctx('owner'), cmd(v, { type: 'START' })));
    v = ok(await s.apply(ctx('owner'), cmd(v, { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: 'DEV-1' })));
    v = ok(await s.apply(ctx('owner'), cmd(v, { type: 'MARK_DELIVERED' })));
    v = ok(await makeSvc('rev').apply(ctx('rev'), cmd(v, { type: 'REVIEW_EVIDENCE', evidenceId: v.contract.evidence[0]!.id, status: 'VALID' })));
    v = ok(await makeSvc('rev').apply(ctx('rev'), cmd(v, { type: 'VERIFY' })));
    v = ok(await makeSvc('cust').apply(ctx('cust'), cmd(v, { type: 'ACKNOWLEDGE', decision: 'GRANTED' })));
    v = ok(await s.apply(ctx('owner'), cmd(v, { type: 'FULFILL' })));
    expect(v.contract.lifecycle).toBe('FULFILLED');
  }

  it('is "no" while the proof holds, "yes" after the evidence issue changes, and the reviewer is asked to reopen', async () => {
    await fulfilled();
    expect(ok(await makeSvc('rev').portfolio(pctx('rev'))).rows[0]).toMatchObject({ lifecycle: 'FULFILLED', reviewRequired: 'no', needsMyAction: false });
    issues['DEV-1']!.facts = { ...issues['DEV-1']!.facts, labels: [] };
    issues['DEV-1']!.updated = 'u2';
    const row = ok(await makeSvc('rev').portfolio(pctx('rev'))).rows[0]!;
    expect(row).toMatchObject({ lifecycle: 'FULFILLED', reviewRequired: 'yes', needsMyAction: true });
    expect(row.available).toContain('REOPEN');
  });

  it('a viewer who cannot read the evidence issue sees review required, not the evidence', async () => {
    await fulfilled();
    issues['DEV-1']!.readers = new Set(['owner', 'rev', 'cust']); // nobody loses access
    const row = ok(await makeSvc('nobody').portfolio(pctx('nobody'))).rows[0]!;
    expect(row.reviewRequired).toBe('yes');
    expect(JSON.stringify(row)).not.toContain('DEV-1');
  });

  it('non-fulfilled promises are never marked review-required and cost no evidence reads, even with evidence attached', async () => {
    const s = makeSvc('owner');
    let v = await create('ITS-1');
    v = ok(await s.apply(ctx('owner'), cmd(v, { type: 'CONFIRM' })));
    v = ok(await s.apply(ctx('owner'), cmd(v, { type: 'START' })));
    ok(await s.apply(ctx('owner'), cmd(v, { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: 'DEV-1' })));
    reads = [];
    const row = ok(await makeSvc('rev').portfolio(pctx('rev'))).rows[0]!;
    expect(row.reviewRequired).toBe('no');
    expect(reads).toEqual(['ITS-1']); // the evidence issue is not read for a promise that is not fulfilled
  });
});

describe('getPortfolio resolver: identity comes from Forge context only', () => {
  const calls: Array<{ who: unknown; cursor: unknown }> = [];
  const defined: Record<string, (req: unknown) => Promise<unknown>> = {};

  beforeEach(async () => {
    calls.length = 0;
    vi.resetModules();
    vi.doMock('@forge/resolver', () => ({ default: class { define(n: string, f: (r: unknown) => Promise<unknown>) { defined[n] = f; } getDefinitions() { return () => undefined; } } }));
    vi.doMock('@forge/api', () => ({ default: { asUser: vi.fn(), asApp: vi.fn() }, route: (s: TemplateStringsArray) => s.join('') }));
    vi.doMock('../src/wiring', () => ({ buildService: () => ({ portfolio: async (who: unknown, cursor: unknown) => { calls.push({ who, cursor }); return { ok: true, value: {} }; } }) }));
    await import('../src/resolvers/index');
  });

  it('uses the project, tenant and account from context and ignores the payload\'s project', async () => {
    await defined['getPortfolio']!({
      context: { cloudId: 'cloud-1', accountId: 'a1', extension: { project: { key: 'ITS' } } },
      payload: { projectKey: 'SECRET', tenantId: 'cloud-2', accountId: 'admin', cursor: 'cloud-1#x' },
    });
    expect(calls).toEqual([{ who: { tenantId: 'cloud-1', accountId: 'a1', projectKey: 'ITS' }, cursor: 'cloud-1#x' }]);
  });

  it.each([
    ['no project', { cloudId: 'c', accountId: 'a', extension: {} }],
    ['no account', { cloudId: 'c', extension: { project: { key: 'ITS' } } }],
    ['no tenant', { accountId: 'a', extension: { project: { key: 'ITS' } } }],
    ['no extension', { cloudId: 'c', accountId: 'a' }],
  ])('fails closed with %s and never reaches the service', async (_n, context) => {
    const r = await defined['getPortfolio']!({ context, payload: { projectKey: 'ITS' } });
    expect(r).toEqual({ ok: false, code: 'ISSUE_NOT_ACCESSIBLE' });
    expect(calls).toHaveLength(0);
  });
});
