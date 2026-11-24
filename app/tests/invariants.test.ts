import { describe, expect, it } from 'vitest';
import type { Contract } from '../src/domain/contract';
import { LIFECYCLE } from '../src/domain/contract';
import { ALLOWED_ROLES } from '../src/domain/lifecycle';
import type { IssueFacts } from '../src/domain/verification';
import { ContractService, type RequestContext } from '../src/service/contract-service';
import { LinkedWorkSync } from '../src/service/linked-work-sync';
import { MemoryContractRepository } from '../src/service/memory-repository';
import { MemoryInbox, MemoryLinkIndex, MemoryRoleStore, MemorySweepState } from '../src/service/memory-stores';
import type { IssueMeta, JiraPermissions, JiraPort } from '../src/service/ports';

// Whole-machine invariant test. Random sequences of user commands (right and wrong actors, stale
// revisions, replayed event ids, malformed commands), Jira fact changes and event/reconcile runs go
// through the REAL service and stores. After EVERY step the stored state is checked against the
// product invariants, read straight from storage (not through the service under test).
// Deterministic (seeded) so a failure reproduces. Counts are reported as measured, not as proof.

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T = 'cloud-1';
const T2 = 'cloud-2';
const ACCOUNTS = ['owner', 'rev', 'cust', 'contrib', 'admin', 'nobody'] as const;
const PREDS = [{ kind: 'STATUS_CATEGORY_IS', value: 'done' }, { kind: 'RESOLUTION_SET' }, { kind: 'CUSTOMER_LABEL' }, { kind: 'LINKED_TO_SOURCE' }];
const EDGES = new Map<string, string>(LIFECYCLE.slice(0, -1).map((s, i) => [s, LIFECYCLE[i + 1]!]));

interface Issue { id: string; key: string; updated: string; readers: Set<string>; facts: IssueFacts }

/** The roles each fuzz account holds (mirrors the role setup in run()). */
function actorRoles(actor: string, seed: number): Array<'AGENT' | 'REVIEWER' | 'ACKNOWLEDGER' | 'CONTRIBUTOR' | 'APPROVER'> {
  switch (actor) {
    case 'owner': return seed % 2 === 1 ? ['AGENT', 'REVIEWER', 'ACKNOWLEDGER'] : ['AGENT'];
    case 'rev': return ['REVIEWER'];
    case 'cust': return ['ACKNOWLEDGER'];
    case 'contrib': return ['CONTRIBUTOR'];
    case 'admin': return ['APPROVER'];
    default: return [];
  }
}

interface RunStats { ops: number; applied: number; refused: number; fulfilledSeen: number; replaysChecked: number; strangerChecked: number; violations: string[] }

async function run(seed: number, steps: number): Promise<RunStats> {
  const r = rng(seed);
  const pick = <X,>(xs: readonly X[]): X => xs[Math.floor(r() * xs.length)]!;
  const stats: RunStats = { ops: 0, applied: 0, refused: 0, fulfilledSeen: 0, replaysChecked: 0, strangerChecked: 0, violations: [] };
  const all = new Set<string>(ACCOUNTS);
  const mkFacts = (id: string, key: string): IssueFacts => ({ id, key, statusCategory: 'indeterminate', resolutionSet: false, labels: [], linkedIssueIds: [], linkedIssueKeys: [] });
  const issues: Record<string, Issue> = {
    'ITS-1': { id: '1001', key: 'ITS-1', updated: 'u1', readers: new Set(all), facts: mkFacts('1001', 'ITS-1') },
    'DEV-1': { id: '3001', key: 'DEV-1', updated: 'u1', readers: new Set(all), facts: mkFacts('3001', 'DEV-1') },
    'DEV-2': { id: '3002', key: 'DEV-2', updated: 'u1', readers: new Set(['owner', 'rev']), facts: mkFacts('3002', 'DEV-2') },
    'DEV-3': { id: '3003', key: 'DEV-3', updated: 'u1', readers: new Set(all), facts: mkFacts('3003', 'DEV-3') },
  };
  const perms: Record<string, JiraPermissions> = { admin: { editIssues: true, administerProject: true } };
  class UserJira implements JiraPort {
    constructor(private account: string) {}
    async getIssueMeta(key: string): Promise<IssueMeta | undefined> {
      const i = issues[key];
      return i && i.readers.has(this.account) ? { id: i.id, key, revision: i.updated, statusCategory: i.facts.statusCategory, statusName: 'x', facts: i.facts } : undefined;
    }
    async getPermissions() { return perms[this.account] ?? { editIssues: true, administerProject: false }; }
  }
  let tick = 0; let idSeq = 0;
  const clock = { now: () => new Date(Date.UTC(2026, 10, 4, 12, 0, 0) + 1000 * tick++).toISOString() };
  const repo = new MemoryContractRepository();
  const roles = new MemoryRoleStore();
  const index = new MemoryLinkIndex();
  const inbox = new MemoryInbox();
  const sweep = new MemorySweepState();
  const jiraApp = {
    getIssueStates: async (ids: string[]) =>
      Object.values(issues).filter((i) => ids.includes(i.id)).map((i) => ({ id: i.id, key: i.key, statusCategory: i.facts.statusCategory, statusName: 'x', updated: i.updated })),
  };
  const sync = new LinkedWorkSync({ repo, index, inbox, jiraApp, sweep, clock });
  const svc = (account: string) => new ContractService({ repo, jira: new UserJira(account), clock, ids: { uuid: () => `id-${++idSeq}` }, index, roles, sync });
  const ctx = (account: string, tenantId = T): RequestContext => ({ tenantId, accountId: account, issueKey: 'ITS-1' });
  // Odd seeds give the owner every user role, so separation-of-duties rules (no self review, no self
  // acknowledgement) are exercised by a user who actually holds the roles.
  roles.assign(T, 'ITS', 'owner', seed % 2 === 1 ? ['AGENT', 'REVIEWER', 'ACKNOWLEDGER'] : ['AGENT']);
  roles.assign(T, 'ITS', 'rev', ['REVIEWER']);
  roles.assign(T, 'ITS', 'cust', ['ACKNOWLEDGER']);
  roles.assign(T, 'ITS', 'contrib', ['CONTRIBUTOR']);
  roles.assign(T2, 'ITS', 'owner', ['AGENT']);

  // A control contract in another tenant: nothing done in tenant T may ever change it.
  const control = await svc('owner').create(ctx('owner', T2), {
    requestId: 'req-control-1', customerReference: 'CONTROL', promiseText: 'control',
    criteria: [{ id: 'c1', type: 'LINKED_WORK', description: 'control', required: true, predicates: PREDS }],
  });
  if (!control.ok) throw new Error('control create failed');
  const controlSnapshot = JSON.stringify(await repo.listByIssue(T2, '1001'));

  const customers = ['ACME', 'GLOBEX', 'INITECH'];
  const created: string[] = [];
  const usedEvents: string[] = [];
  const tracked = new Map<string, { lifecycle: string; revision: number }>();
  let evSeq = 0;
  const freshEvent = () => { const e = `evt-${seed}-${String(++evSeq).padStart(8, '0')}`; usedEvents.push(e); return e; };

  const contractsNow = async (): Promise<Contract[]> => (await repo.listByIssue(T, '1001')) as Contract[];

  const setGoodFacts = (i: Issue) => { i.facts.statusCategory = 'done'; i.facts.resolutionSet = true; i.facts.labels = ['customer-acme', 'customer-globex', 'customer-initech']; i.facts.linkedIssueIds = ['1001']; i.facts.linkedIssueKeys = ['ITS-1']; };
  const mutateJira = () => {
    const i = issues[pick(['DEV-1', 'DEV-1', 'DEV-2', 'DEV-3', 'ITS-1'])]!;
    const op = Math.floor(r() * 8);
    if (op === 0) setGoodFacts(i);
    else if (op === 1) i.facts.statusCategory = pick(['new', 'indeterminate', 'done']);
    else if (op === 2) i.facts.resolutionSet = !i.facts.resolutionSet;
    else if (op === 3) i.facts.labels = r() < 0.5 ? [] : [pick(['customer-acme', 'customer-globex', 'other'])];
    else if (op === 4) { i.facts.linkedIssueIds = r() < 0.5 ? [] : ['1001']; i.facts.linkedIssueKeys = i.facts.linkedIssueIds.length ? ['ITS-1'] : []; }
    else if (op === 5) i.readers = r() < 0.5 ? new Set(all) : new Set(['owner']);
    i.updated = `u${tick}-${Math.floor(r() * 1000)}`;
  };

  const logicalCommand = (c: Contract): { actor: string; body: Record<string, unknown> } | undefined => {
    const pending = c.evidence.find((e) => e.reviewStatus === 'PENDING');
    switch (c.lifecycle) {
      case 'DRAFT': return { actor: 'owner', body: { type: 'CONFIRM' } };
      case 'CONFIRMED': return { actor: 'owner', body: { type: 'START' } };
      case 'IN_PROGRESS':
        if (pending) return { actor: 'rev', body: { type: 'REVIEW_EVIDENCE', evidenceId: pending.id, status: r() < 0.85 ? 'VALID' : 'INVALID' } };
        if (!c.evidence.some((e) => e.reviewStatus === 'VALID') || r() < 0.2) return { actor: pick(['owner', 'contrib']), body: { type: 'ADD_EVIDENCE', criterionId: 'c1', sourceRef: pick(['DEV-1', 'DEV-1', 'DEV-2', 'DEV-3']) } };
        return { actor: 'owner', body: { type: 'MARK_DELIVERED' } };
      case 'DELIVERED': return { actor: 'rev', body: { type: 'VERIFY' } };
      case 'VERIFIED': return { actor: 'cust', body: { type: 'ACKNOWLEDGE', decision: r() < 0.9 ? 'GRANTED' : 'DENIED' } };
      case 'ACKNOWLEDGED': return { actor: 'rev', body: { type: 'FULFILL' } };
      case 'FULFILLED': return r() < 0.3 ? { actor: 'owner', body: { type: 'REOPEN', reason: 'fuzz' } } : undefined;
      default: return undefined;
    }
  };

  const garbageCommand = (c: Contract): Record<string, unknown> => {
    const type = pick(['CONFIRM', 'START', 'MARK_DELIVERED', 'VERIFY', 'FULFILL', 'ACKNOWLEDGE', 'REOPEN', 'SET_AT_RISK', 'ADD_EVIDENCE', 'REVIEW_EVIDENCE', 'LINK_WORK', 'UNLINK_WORK', 'AMEND_CRITERIA', 'NOPE']);
    const body: Record<string, unknown> = { type, contractId: c.id, eventId: freshEvent(), expectedRevision: c.revision };
    if (type === 'ACKNOWLEDGE') body['decision'] = pick(['GRANTED', 'DENIED', 'MAYBE']);
    if (type === 'REOPEN') body['reason'] = 'r';
    if (type === 'SET_AT_RISK') body['atRisk'] = r() < 0.5;
    if (type === 'ADD_EVIDENCE') { body['criterionId'] = pick(['c1', 'zzz']); body['sourceRef'] = pick(['DEV-1', 'DEV-2', 'ITS-1', 'bad key']); }
    if (type === 'REVIEW_EVIDENCE') { body['evidenceId'] = c.evidence[0]?.id ?? 'none'; body['status'] = pick(['VALID', 'INVALID']); }
    if (type === 'LINK_WORK' || type === 'UNLINK_WORK') body['issueKey'] = pick(['DEV-1', 'DEV-3', 'DEV-9']);
    if (type === 'AMEND_CRITERIA') { body['reason'] = 'a'; body['criteria'] = [{ id: 'c1', type: 'LINKED_WORK', description: 'amended', required: true, predicates: r() < 0.7 ? PREDS : [] }]; }
    return body;
  };

  const check = async (step: number, why: string) => {
    for (const c of await contractsNow()) {
      const tag = `seed=${seed} step=${step} (${why}) contract=${c.id}`;
      const prev = tracked.get(c.id);
      if (prev) {
        if (c.revision < prev.revision) stats.violations.push(`${tag}: revision went backwards`);
        const from = LIFECYCLE.indexOf(prev.lifecycle as never); const to = LIFECYCLE.indexOf(c.lifecycle);
        if (to > from && EDGES.get(prev.lifecycle) !== c.lifecycle) stats.violations.push(`${tag}: skipped a stage ${prev.lifecycle} -> ${c.lifecycle}`);
      }
      tracked.set(c.id, { lifecycle: c.lifecycle, revision: c.revision });
      if (c.tenantId !== T) stats.violations.push(`${tag}: foreign tenant in tenant list`);
      for (const e of c.evidence) {
        if (e.reviewStatus === 'VALID' && e.reviewedBy === e.addedBy) stats.violations.push(`${tag}: evidence ${e.id} reviewed by its adder`);
        if (e.reviewStatus === 'VALID' && !e.reviewedBy) stats.violations.push(`${tag}: VALID evidence without a reviewer`);
      }
      if (c.lifecycle === 'ACKNOWLEDGED' || c.lifecycle === 'FULFILLED') {
        if (c.acknowledgement?.decision !== 'GRANTED') stats.violations.push(`${tag}: ${c.lifecycle} without a GRANTED acknowledgement`);
        if (c.acknowledgement?.byAccountId === c.ownerAccountId) stats.violations.push(`${tag}: owner acknowledged own promise`);
      }
      if (c.lifecycle === 'FULFILLED') {
        stats.fulfilledSeen++;
        const audit = await repo.listAudit(T, c.id, 200);
        const fulfils = audit.filter((a) => a.type === 'FULFILL');
        const last = fulfils[fulfils.length - 1] ?? fulfils[0];
        if (!last) stats.violations.push(`${tag}: FULFILLED with no FULFILL audit event`);
        else if (!(last.report && last.report.canFulfill === true)) stats.violations.push(`${tag}: FULFILL event without a passing decision report`);
        if (!c.fulfilledAt) stats.violations.push(`${tag}: FULFILLED without fulfilledAt`);
      }
    }
    if (JSON.stringify(await repo.listByIssue(T2, '1001')) !== controlSnapshot) stats.violations.push(`seed=${seed} step=${step} (${why}): another tenant's contract changed`);
  };

  for (let step = 0; step < steps; step++) {
    const roll = r();
    if (roll < 0.12) { mutateJira(); await check(step, 'jira change'); continue; }
    if (roll < 0.18) {
      if (r() < 0.5) await sync.reconcile(T); else await sync.handleIssueUpdated(T, { issueId: pick(['3001', '3002', '3003']), updated: `u${tick}` });
      await check(step, 'sync'); continue;
    }
    if (roll < 0.22 && created.length < 3) {
      const res = await svc('owner').create(ctx('owner'), { requestId: `req-${seed}-${created.length}-xxxx`, customerReference: customers[created.length]!, promiseText: 'fuzz', criteria: [{ id: 'c1', type: 'LINKED_WORK', description: 'fuzz', required: true, predicates: PREDS }] });
      if (res.ok) created.push(res.value.contract.id);
      await check(step, 'create'); continue;
    }
    if (r() < 0.25) setGoodFacts(issues['DEV-1']!);
    const list = await contractsNow();
    if (list.length === 0) continue;
    const c = pick(list);
    stats.ops++;
    let actor: string; let body: Record<string, unknown>;
    if (r() < 0.65) {
      const lc = logicalCommand(c);
      if (!lc) continue;
      actor = r() < 0.7 ? lc.actor : pick(ACCOUNTS); body = lc.body;
      body = { ...body, contractId: c.id, eventId: freshEvent(), expectedRevision: r() < 0.9 ? c.revision : Math.max(1, c.revision - 1) };
    } else {
      actor = pick(ACCOUNTS); body = garbageCommand(c);
    }
    const before = JSON.stringify(c);
    const res = await svc(actor).apply(ctx(actor), body);
    if (res.ok) stats.applied++; else stats.refused++;
    if (!res.ok || actor === 'nobody') {
      if (actor === 'nobody') {
        stats.strangerChecked++;
        if (res.ok) stats.violations.push(`seed=${seed} step=${step}: a user with no role changed state (${String(body['type'])})`);
      }
      if (!res.ok && JSON.stringify((await contractsNow()).find((x) => x.id === c.id)) !== before) stats.violations.push(`seed=${seed} step=${step}: a refused command still changed the contract (${String(body['type'])} -> ${res.code})`);
    }
    if (res.ok) {
      // Every applied command: the actor held a role the command allows, and exactly one revision was consumed.
      const type = String(body['type']) as keyof typeof ALLOWED_ROLES;
      const held = actorRoles(actor, seed);
      if (!held.some((role) => ALLOWED_ROLES[type]?.includes(role))) stats.violations.push(`seed=${seed} step=${step}: ${actor} ran ${type} without an allowed role`);
      const stored = (await contractsNow()).find((x) => x.id === c.id)!;
      if (stored.revision !== c.revision + 1) stats.violations.push(`seed=${seed} step=${step}: ${type} applied but revision moved ${c.revision} -> ${stored.revision}`);
    }    if (res.ok && r() < 0.3) {
      // replay the same event id: must be a no-op (no second transition)
      const mid = (await contractsNow()).find((x) => x.id === c.id)!;
      const again = await svc(actor).apply(ctx(actor), body);
      stats.replaysChecked++;
      const after = (await contractsNow()).find((x) => x.id === c.id)!;
      if (after.revision !== mid.revision || after.lifecycle !== mid.lifecycle) stats.violations.push(`seed=${seed} step=${step}: replaying event ${String(body['eventId'])} changed state (ok=${again.ok})`);
    }
    await check(step, `${actor} ${String(body['type'])}`);
  }
  return stats;
}

describe('whole-machine invariants (seeded random sequences through the real service and stores)', () => {
  it('no sequence reaches FULFILLED without a passing verifier decision, and no invariant breaks', async () => {
    const SEEDS = 120; const STEPS = 220;
    const total = { ops: 0, applied: 0, refused: 0, fulfilledSeen: 0, replays: 0, strangers: 0 };
    const violations: string[] = [];
    for (let s = 1; s <= SEEDS; s++) {
      const st = await run(s, STEPS);
      total.ops += st.ops; total.applied += st.applied; total.refused += st.refused; total.fulfilledSeen += st.fulfilledSeen; total.replays += st.replaysChecked; total.strangers += st.strangerChecked;
      violations.push(...st.violations);
    }
    console.log(`invariants: runs=${SEEDS} steps/run=${STEPS} commands=${total.ops} applied=${total.applied} refused=${total.refused} fulfilled-state-observations=${total.fulfilledSeen} replays=${total.replays} no-role-attempts=${total.strangers} violations=${violations.length}`);
    expect(violations.slice(0, 10)).toEqual([]);
    // The run must actually reach the deep states, otherwise "no violations" proves nothing.
    expect(total.fulfilledSeen).toBeGreaterThan(50);
    expect(total.applied).toBeGreaterThan(1000);
    expect(total.refused).toBeGreaterThan(1000);
    expect(total.replays).toBeGreaterThan(100);
  }, 120_000);
});
