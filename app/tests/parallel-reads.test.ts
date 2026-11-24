import { beforeEach, describe, expect, it } from 'vitest';
import { ContractService, MAX_PARALLEL_JIRA_READS, type RequestContext, type ServiceResult } from '../src/service/contract-service';
import { LinkedWorkSync } from '../src/service/linked-work-sync';
import { MemoryContractRepository } from '../src/service/memory-repository';
import { MemoryInbox, MemoryLinkIndex, MemoryRoleStore, MemorySweepState } from '../src/service/memory-stores';
import type { IssueMeta, JiraPermissions, JiraPort } from '../src/service/ports';

// P6 speed-up: the service reads independent Jira issues together (under a small per-request cap)
// instead of one after another. These tests pin that the answer is unchanged (same redaction, same
// order, same refusals and errors) while reads really overlap and never exceed the cap.

const T = 'cloud-1';
let inFlight = 0; let maxInFlight = 0; let metaCalls = 0; let delayMs = 0;
let unreadable: Set<string>;
let permsMode: 'ok' | 'throw'; let rolesThrow: boolean;
const facts = (key: string, id: string) => ({ id, key, statusCategory: 'done', resolutionSet: true, labels: ['customer-acme'], linkedIssueIds: ['1001'], linkedIssueKeys: ['ITS-1'] });
const ids: Record<string, string> = { 'ITS-1': '1001' };
for (let i = 1; i <= 12; i++) ids[`DEV-${i}`] = String(3000 + i);

class Jira implements JiraPort {
  constructor(private account: string) {}
  async getIssueMeta(key: string): Promise<IssueMeta | undefined> {
    metaCalls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (!ids[key] || (this.account === 'viewer' && unreadable.has(key))) return undefined;
      return { id: ids[key]!, key, revision: '2026-11-04T09:00:00.000-0500', statusCategory: 'done', statusName: 'x', facts: facts(key, ids[key]!) };
    } finally { inFlight--; }
  }
  async getPermissions(key: string): Promise<JiraPermissions> {
    if (permsMode === 'throw' || (this.account === 'viewer' && unreadable.has(key))) throw new Error('permission read failed (404)');
    return { editIssues: true, administerProject: false };
  }
}

let repo: MemoryContractRepository; let roles: MemoryRoleStore; let index: MemoryLinkIndex;
let tick = 0; let idSeq = 0; let ev = 0;
const clock = { now: () => new Date(Date.UTC(2026, 10, 4, 12, 0, tick++)).toISOString() };
const base = (account: string) => ({
  repo, jira: new Jira(account), clock, ids: { uuid: () => `id-${++idSeq}` }, index,
  roles: rolesThrow && account === 'viewer' ? ({ ...roles, get: async () => { throw new Error('storage down'); } } as unknown as MemoryRoleStore) : roles,
  sync: new LinkedWorkSync({ repo, index, inbox: new MemoryInbox(), jiraApp: { getIssueStates: async () => [] }, sweep: new MemorySweepState(), clock }),
});
const svc = (account: string) => new ContractService(base(account));
const ctx = (account: string, issueKey = 'ITS-1'): RequestContext => ({ tenantId: T, accountId: account, issueKey });
const ok = <X,>(r: ServiceResult<X>): X => { if (!r.ok) throw new Error(`refused ${r.code} ${(r as {detail?: string[]}).detail?.join(",") ?? ""}`); return r.value; };
const eid = () => `evt-${String(++ev).padStart(8, '0')}`;
const PREDS = [{ kind: 'STATUS_CATEGORY_IS', value: 'done' }, { kind: 'CUSTOMER_LABEL' }, { kind: 'LINKED_TO_SOURCE' }];

async function seed(verified = false) {
  let v = ok(await svc('owner').create(ctx('owner'), { requestId: 'req-parallel-1', customerReference: 'ACME', promiseText: 'p', criteria: [{ id: 'c1', type: 'LINKED_WORK', description: 'd', required: true, predicates: PREDS }] }));
  const run = async (body: Record<string, unknown>) => { v = ok(await svc('owner').apply(ctx('owner'), { contractId: v.contract.id, eventId: eid(), expectedRevision: v.contract.revision, ...body })); };
  await run({ type: 'CONFIRM' }); await run({ type: 'START' });
  for (let i = 1; i <= 8; i++) await run({ type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: `DEV-${i}` });
  for (const k of ['DEV-9', 'DEV-10', 'DEV-11']) await run({ type: 'LINK_WORK', issueKey: k });
  if (verified) {
    // reviewer marks the DEV-1 evidence valid, owner delivers, reviewer verifies: the audit trail now holds a decision report
    const first = v.contract.evidence.find((e) => e.sourceRef === 'DEV-1')!;
    v = ok(await svc('rev').apply(ctx('rev'), { contractId: v.contract.id, eventId: eid(), expectedRevision: v.contract.revision, type: 'REVIEW_EVIDENCE', evidenceId: first.id, status: 'VALID' }));
    await run({ type: 'MARK_DELIVERED' });
    v = ok(await svc('rev').apply(ctx('rev'), { contractId: v.contract.id, eventId: eid(), expectedRevision: v.contract.revision, type: 'VERIFY' }));
  }
  return v;
}

beforeEach(() => {
  inFlight = 0; maxInFlight = 0; metaCalls = 0; delayMs = 0; tick = 0; idSeq = 0; ev = 0;
  unreadable = new Set(); permsMode = 'ok'; rolesThrow = false;
  repo = new MemoryContractRepository(); roles = new MemoryRoleStore(); index = new MemoryLinkIndex();
  roles.assign(T, 'ITS', 'owner', ['AGENT']);
  roles.assign(T, 'ITS', 'rev', ['REVIEWER']);
});

describe('independent Jira reads overlap, under a cap, with an unchanged answer', () => {
  it('reads many evidence and link issues together but never more than the cap (positive)', async () => {
    await seed();
    delayMs = 15; maxInFlight = 0; metaCalls = 0;
    const list = ok(await svc('owner').list(ctx('owner')));
    expect(list).toHaveLength(1);
    // Peak overlap is a deterministic measure (wall-clock budgets proved flaky on a cold clean-room machine).
    expect(maxInFlight).toBeGreaterThanOrEqual(5); // 8 evidence + 3 link reads, capped at 6
    expect(maxInFlight).toBeLessThanOrEqual(MAX_PARALLEL_JIRA_READS);
    expect(metaCalls).toBe(1 + 8 + 3); // source issue + 8 evidence issues + 3 linked issues, each read once (memoised)
  });

  it('gives the same redaction and the same order as before for a viewer who cannot read some issues (negative)', async () => {
    await seed();
    unreadable = new Set(['DEV-3', 'DEV-10']);
    const sequentialShape = ok(await svc('viewer').list(ctx('viewer')))[0]!;
    expect(sequentialShape.hiddenLinks).toBe(1);
    expect(sequentialShape.contract.linkedWork.map((l) => l.issueKey)).toEqual(['DEV-9', 'DEV-11']); // order preserved
    const crit = sequentialShape.decision.criteria[0]!;
    const byId = new Map(crit.evidence.map((e) => [e.id, e.status]));
    const hidden = sequentialShape.contract.evidence.find((e) => e.sourceRef === 'DEV-3')!;
    expect(byId.get(hidden.id)).toBe('unauthorized');
  });

  it('decision reports in the audit trail are redacted per viewer: no facts about an evidence issue the viewer cannot read (negative)', async () => {
    await seed(true);
    const asOwner = ok(await svc('owner').list(ctx('owner')))[0]!;
    const ownerRefs = asOwner.audit.flatMap((a) => a.report?.criteria.flatMap((c) => c.evidence.map((e) => e.sourceRef)) ?? []);
    expect(ownerRefs).toContain('DEV-3'); // the owner can read it, so the report shows it (the check below is not vacuous)
    unreadable = new Set(['DEV-3']);
    const asViewer = ok(await svc('viewer').list(ctx('viewer')))[0]!;
    const viewerRefs = asViewer.audit.flatMap((a) => a.report?.criteria.flatMap((c) => c.evidence.map((e) => e.sourceRef)) ?? []);
    expect(viewerRefs.length).toBeGreaterThan(0);
    expect(viewerRefs).not.toContain('DEV-3');
  });

  it('the cap is a small policy number', () => { expect(MAX_PARALLEL_JIRA_READS).toBeGreaterThan(1); expect(MAX_PARALLEL_JIRA_READS).toBeLessThanOrEqual(8); });

  it('the cap itself: more readers than slots wait their turn and all finish', async () => {
    await seed();
    delayMs = 5; maxInFlight = 0;
    const s = svc('owner');
    const out = await Promise.all(Array.from({ length: 30 }, (_, i) => (s as unknown as { issueMeta(k: string): Promise<unknown> }).issueMeta(`DEV-${(i % 12) + 1}`)));
    expect(out.every(Boolean)).toBe(true);
    expect(maxInFlight).toBeLessThanOrEqual(MAX_PARALLEL_JIRA_READS);
  });
});

describe('identity checks keep their old behaviour although the reads now start together', () => {
  it('an unreadable issue is refused as before even though its permission read throws (no error, no unhandled rejection)', async () => {
    await seed();
    unreadable = new Set(['ITS-1']);
    const r = await svc('viewer').list(ctx('viewer'));
    expect(r).toMatchObject({ ok: false, code: 'ISSUE_NOT_ACCESSIBLE' });
  });

  it('a readable issue whose permission read fails still fails loudly (not silently allowed) (negative)', async () => {
    await seed();
    permsMode = 'throw';
    await expect(svc('owner').list(ctx('owner'))).rejects.toThrow(/permission read failed/);
  });

  it('a failing role read on an unreadable issue is still just a refusal; on a readable issue it still throws (negative)', async () => {
    await seed();
    rolesThrow = true;
    unreadable = new Set(['ITS-1']);
    expect(await svc('viewer').list(ctx('viewer'))).toMatchObject({ ok: false, code: 'ISSUE_NOT_ACCESSIBLE' });
    unreadable = new Set();
    await expect(svc('viewer').list(ctx('viewer'))).rejects.toThrow(/storage down/);
  });

  it('a user with no assigned role is still read-only and still sees the promise', async () => {
    await seed();
    const v = ok(await svc('viewer').list(ctx('viewer')))[0]!;
    expect(v.available).toEqual([]);
  });
});
