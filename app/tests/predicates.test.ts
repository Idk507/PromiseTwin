import { describe, expect, it } from 'vitest';
import { applyCommand, createContract, type Actor, type Command } from '../src/domain/lifecycle';
import { criterionSchema, type Contract, type Predicate } from '../src/domain/contract';
import {
  buildDecisionReport, customerLabel, evaluateCriteria, evaluateFulfillment, evaluatePredicates, evidenceBlockers,
  reviewRequired, type EvaluationContext, type IssueFacts,
} from '../src/domain/verification';

// ---- fixtures (synthetic) ---------------------------------------------------------------------
const T = 'tenant-1';
const NOW = '2026-11-04T10:00:00Z';
const agent: Actor = { accountId: 'agent-1', roles: ['AGENT'] };
const reviewer: Actor = { accountId: 'rev-1', roles: ['REVIEWER'] };
const acker: Actor = { accountId: 'cust-1', roles: ['ACKNOWLEDGER'] };

const facts = (over: Partial<IssueFacts> = {}): IssueFacts => ({
  id: '3001', key: 'DEV-1', statusCategory: 'done', resolutionSet: true, labels: ['customer-acme'],
  linkedIssueIds: ['1001'], linkedIssueKeys: ['ITS-1'], ...over,
});
const ctxWith = (f: IssueFacts | undefined, over: Partial<{ accessible: boolean; revision: string }> = {}): EvaluationContext => ({
  now: NOW, sourceChecks: { 'DEV-1': { accessible: over.accessible ?? true, revision: over.revision ?? 'r1', facts: f } },
});

const ALL: Predicate[] = [
  { kind: 'STATUS_CATEGORY_IS', value: 'done' }, { kind: 'RESOLUTION_SET' }, { kind: 'CUSTOMER_LABEL' }, { kind: 'LINKED_TO_SOURCE' },
];

function contractWith(predicates: Predicate[], over: Partial<Contract> = {}): Contract {
  const r = createContract(
    { customerReference: 'ACME', source: { product: 'JSM', site: 's', issueId: '1001', issueKey: 'ITS-1' }, promiseText: 'Ship it',
      criteria: [{ id: 'c1', type: 'LINKED_WORK', description: 'Deployed for ACME', required: true, predicates }] },
    { id: 'k1', tenantId: T, ownerAccountId: 'agent-1', actor: agent, at: NOW });
  if (!r.ok || r.duplicate) throw new Error('setup');
  return {
    ...r.contract, lifecycle: 'DELIVERED', confirmedVersion: 1,
    evidence: [{ id: 'e1', criterionId: 'c1', sourceType: 'JIRA_ISSUE', sourceRef: 'DEV-1', customerReference: 'ACME', observedAt: NOW,
      sourceRevision: 'r1', contractVersion: 1, addedBy: 'agent-1', reviewStatus: 'VALID', reviewedBy: 'rev-1' }],
    ...over,
  };
}
const ackd = (c: Contract): Contract => ({ ...c, lifecycle: 'ACKNOWLEDGED', acknowledgement: { byAccountId: 'cust-1', atContractVersion: 1, decision: 'GRANTED', decidedAt: NOW } });
let n = 0;
const cmd = (actor: Actor, c: Contract, body: Record<string, unknown>): Command => ({ eventId: `ev-${++n}`, tenantId: T, expectedRevision: c.revision, actor, at: NOW, ...body }) as Command;

describe('customerLabel', () => {
  it.each([
    ['ACME', 'customer-acme'], ['ACME Corp.', 'customer-acme-corp'], ['  Foo__Bar ', 'customer-foo-bar'], ['Zoë & Co', 'customer-zo-co'],
  ])('normalizes %j -> %s', (ref, want) => expect(customerLabel(ref)).toBe(want));
  it.each([['???'], ['   '], ['---'], ['é']])('returns undefined for %j so the predicate fails closed', (ref) => expect(customerLabel(ref)).toBeUndefined());
  it('truncates long references without a trailing dash', () => {
    const l = customerLabel('a'.repeat(49) + ' b')!;
    expect(l.startsWith('customer-')).toBe(true);
    expect(l.endsWith('-')).toBe(false);
    expect(l.length).toBeLessThanOrEqual('customer-'.length + 50);
  });
});

describe('evaluatePredicates', () => {
  const c = contractWith(ALL);
  it('all hold on good facts', () => expect(evaluatePredicates(ALL, c, facts()).every((p) => p.ok)).toBe(true));
  it.each([
    ['not done', facts({ statusCategory: 'indeterminate' }), 'STATUS_CATEGORY_IS'],
    ['no resolution', facts({ resolutionSet: false }), 'RESOLUTION_SET'],
    ['no customer label', facts({ labels: ['VIP'] }), 'CUSTOMER_LABEL'],
    ['label for another customer', facts({ labels: ['customer-globex'] }), 'CUSTOMER_LABEL'],
    ['label differs only by case (labels are case-sensitive)', facts({ labels: ['Customer-ACME'] }), 'CUSTOMER_LABEL'],
    ['unrelated issue (no link)', facts({ linkedIssueIds: [], linkedIssueKeys: [] }), 'LINKED_TO_SOURCE'],
    ['linked to a different request', facts({ linkedIssueIds: ['9'], linkedIssueKeys: ['ITS-9'] }), 'LINKED_TO_SOURCE'],
  ])('fails exactly the right predicate: %s', (_n, f, kind) => {
    const failed = evaluatePredicates(ALL, c, f).filter((p) => !p.ok).map((p) => p.kind);
    expect(failed).toEqual([kind]);
  });
  it('accepts a link by id OR by key', () => {
    expect(evaluatePredicates([{ kind: 'LINKED_TO_SOURCE' }], c, facts({ linkedIssueIds: ['1001'], linkedIssueKeys: [] }))[0]!.ok).toBe(true);
    expect(evaluatePredicates([{ kind: 'LINKED_TO_SOURCE' }], c, facts({ linkedIssueIds: [], linkedIssueKeys: ['ITS-1'] }))[0]!.ok).toBe(true);
  });
  it('unknown facts fail EVERY predicate (fail closed)', () => {
    expect(evaluatePredicates(ALL, c, undefined).every((p) => !p.ok)).toBe(true);
  });
  it('a customer reference with no usable characters can never satisfy CUSTOMER_LABEL', () => {
    const odd = contractWith(ALL, { customerReference: '???' });
    expect(evaluatePredicates([{ kind: 'CUSTOMER_LABEL' }], odd, facts({ labels: ['customer-', 'customer-unknown', 'customer'] }))[0]!.ok).toBe(false);
  });
  it('HAS_LABEL matches exactly', () => {
    const p: Predicate[] = [{ kind: 'HAS_LABEL', value: 'regression-passed' }];
    expect(evaluatePredicates(p, c, facts({ labels: ['regression-passed'] }))[0]!.ok).toBe(true);
    expect(evaluatePredicates(p, c, facts({ labels: ['regression-passed-not'] }))[0]!.ok).toBe(false);
  });
  it('no predicates => nothing to evaluate', () => expect(evaluatePredicates([], c, facts())).toEqual([]));
});

describe('criterion status with predicates', () => {
  it('satisfied only when reviewed VALID, current AND every predicate holds', () => {
    const c = contractWith(ALL);
    expect(evaluateCriteria(c, ctxWith(facts()))[0]).toMatchObject({ status: 'satisfied', failedPredicates: [] });
  });

  it('a failed predicate gives `unmet` with explicit reasons (J5)', () => {
    const c = contractWith(ALL);
    const r = evaluateCriteria(c, ctxWith(facts({ labels: [], statusCategory: 'indeterminate' })))[0]!;
    expect(r.status).toBe('unmet');
    expect(r.failedPredicates.sort()).toEqual(['CUSTOMER_LABEL', 'STATUS_CATEGORY_IS']);
    const b = evidenceBlockers(c, ctxWith(facts({ labels: [] })));
    expect(b).toContain('CRITERION_unmet:c1');
    expect(b).toContain('PREDICATE_FAILED:c1:CUSTOMER_LABEL');
  });

  it('unreadable/unknown facts => unmet, never satisfied', () => {
    expect(evaluateCriteria(contractWith(ALL), ctxWith(undefined))[0]!.status).toBe('unmet');
  });

  it('back-compat: a criterion WITHOUT predicates still relies on review alone, even with no facts', () => {
    expect(evaluateCriteria(contractWith([]), ctxWith(undefined))[0]!.status).toBe('satisfied');
  });

  it.each([
    ['PENDING review beats predicate failure (missing, not unmet)', { reviewStatus: 'PENDING' as const }, facts({ labels: [] }), {}, 'missing'],
    ['INVALID review is conflicting', { reviewStatus: 'INVALID' as const }, facts(), {}, 'conflicting'],
    ['wrong self-declared customer is conflicting', { customerReference: 'GLOBEX' }, facts(), {}, 'conflicting'],
    ['stale beats unmet', {}, facts({ labels: [] }), { revision: 'r2' }, 'stale'],
    ['unauthorized beats unmet', {}, facts({ labels: [] }), { accessible: false }, 'unauthorized'],
  ])('precedence: %s', (_n, evOver, f, chk, want) => {
    const c = contractWith(ALL);
    const withOver = { ...c, evidence: c.evidence.map((e) => ({ ...e, ...evOver })) };
    expect(evaluateCriteria(withOver, ctxWith(f, chk))[0]!.status).toBe(want);
  });

  it('one satisfying evidence item is enough even if another is unmet; with none satisfying, the actionable `unmet` is reported over an old `stale` item', () => {
    const c = contractWith(ALL);
    const second = { ...c.evidence[0]!, id: 'e2', sourceRef: 'DEV-2' };
    const both = { ...c, evidence: [...c.evidence, second] };
    const ctx: EvaluationContext = { now: NOW, sourceChecks: { 'DEV-1': { accessible: true, revision: 'r1', facts: facts() }, 'DEV-2': { accessible: true, revision: 'r1', facts: facts({ labels: [] }) } } };
    expect(evaluateCriteria(both, ctx)[0]!.status).toBe('satisfied');
    const ctx2: EvaluationContext = { now: NOW, sourceChecks: { 'DEV-1': { accessible: true, revision: 'r1', facts: facts({ labels: [] }) }, 'DEV-2': { accessible: true, revision: 'CHANGED', facts: facts() } } };
    const r2 = evaluateCriteria(both, ctx2)[0]!;
    expect(r2.status).toBe('unmet');
    expect(r2.failedPredicates).toContain('CUSTOMER_LABEL');
    expect(r2.status).not.toBe('satisfied'); // reporting order never makes a failing criterion pass
  });
});

describe('lifecycle gating on predicates', () => {
  it('VERIFY is refused while a predicate fails, and allowed once it holds', () => {
    const c = contractWith(ALL);
    const bad = applyCommand(c, cmd(reviewer, c, { type: 'VERIFY' }), ctxWith(facts({ linkedIssueIds: [], linkedIssueKeys: [] })));
    expect(bad).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' });
    expect(JSON.stringify(bad)).toContain('PREDICATE_FAILED:c1:LINKED_TO_SOURCE');
    expect(applyCommand(c, cmd(reviewer, c, { type: 'VERIFY' }), ctxWith(facts()))).toMatchObject({ ok: true, duplicate: false });
  });

  it('FULFIL is refused if a predicate stopped holding after acknowledgement', () => {
    const c = ackd(contractWith(ALL));
    expect(applyCommand(c, cmd(agent, c, { type: 'FULFILL' }), ctxWith(facts()))).toMatchObject({ ok: true });
    const regressed = applyCommand(c, cmd(agent, c, { type: 'FULFILL' }), ctxWith(facts({ statusCategory: 'indeterminate' })));
    expect(regressed).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' });
    expect(JSON.stringify(regressed)).toContain('PREDICATE_FAILED:c1:STATUS_CATEGORY_IS');
  });

  it('ACKNOWLEDGE is refused while the evidence does not satisfy its predicates', () => {
    const c = { ...contractWith(ALL), lifecycle: 'VERIFIED' as const };
    expect(applyCommand(c, cmd(acker, c, { type: 'ACKNOWLEDGE', decision: 'GRANTED' }), ctxWith(facts({ labels: [] })))).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' });
  });
});

describe('decision report on the audit trail', () => {
  it('VERIFY, ACKNOWLEDGE and FULFILL carry a content-free report; other commands do not', () => {
    const c = contractWith(ALL);
    const v = applyCommand(c, cmd(reviewer, c, { type: 'VERIFY' }), ctxWith(facts()));
    if (!v.ok || v.duplicate) throw new Error('expected applied');
    expect(v.event.report).toBeDefined();
    const a = ackd(contractWith(ALL));
    const f = applyCommand(a, cmd(agent, a, { type: 'FULFILL' }), ctxWith(facts()));
    if (!f.ok || f.duplicate) throw new Error('expected applied');
    expect(f.event.report).toMatchObject({ canFulfill: true, contractVersion: 1, criteria: [{ criterionId: 'c1', status: 'satisfied' }] });
    const ev = f.event.report!.criteria[0]!.evidence[0]!;
    expect(ev).toMatchObject({ id: 'e1', sourceRef: 'DEV-1', reviewStatus: 'VALID', observedRevision: 'r1' });
    expect(ev.predicates.map((p) => p.kind).sort()).toEqual(['CUSTOMER_LABEL', 'LINKED_TO_SOURCE', 'RESOLUTION_SET', 'STATUS_CATEGORY_IS']);
    const risk = applyCommand(c, cmd(agent, c, { type: 'SET_AT_RISK', atRisk: true }), ctxWith(facts()));
    expect(risk.ok && !risk.duplicate && risk.event.report).toBeUndefined();
  });

  it('records the failing predicates when the decision is not allowed (report built directly)', () => {
    const r = buildDecisionReport(contractWith(ALL), ctxWith(facts({ labels: [] })));
    expect(r.canFulfill).toBe(false);
    expect(r.criteria[0]!.evidence[0]!.predicates.find((p) => p.kind === 'CUSTOMER_LABEL')).toEqual({ kind: 'CUSTOMER_LABEL', ok: false });
    expect(r.blockers).toContain('PREDICATE_FAILED:c1:CUSTOMER_LABEL');
  });

  it('is bounded and contains no source content: only the whitelisted fields', () => {
    const c = contractWith(ALL);
    const many = { ...c, evidence: Array.from({ length: 30 }, (_, i) => ({ ...c.evidence[0]!, id: `e${i}`, sourceRef: 'DEV-1' })) };
    const r = buildDecisionReport(many, ctxWith(facts()));
    expect(r.criteria[0]!.evidence.length).toBeLessThanOrEqual(5);
    const keys = new Set(Object.keys(r.criteria[0]!.evidence[0]!));
    expect([...keys].sort()).toEqual(['id', 'observedRevision', 'predicates', 'reviewStatus', 'sourceRef', 'status']);
    expect(JSON.stringify(r)).not.toMatch(/summary|description|promiseText|ACME/);
  });
});

describe('review required after fulfilment (J6)', () => {
  const fulfilled = (): Contract => ({ ...ackd(contractWith(ALL)), lifecycle: 'FULFILLED', fulfilledAt: NOW });
  it('is false while proof still holds and for non-fulfilled promises', () => {
    expect(reviewRequired(fulfilled(), ctxWith(facts()))).toEqual({ required: false, reasons: [] });
    expect(reviewRequired(contractWith(ALL), ctxWith(facts({ labels: [] }))).required).toBe(false);
  });
  it.each([
    ['evidence issue no longer done', facts({ statusCategory: 'indeterminate' }), {}, 'PREDICATE_FAILED:c1:STATUS_CATEGORY_IS'],
    ['customer label removed', facts({ labels: [] }), {}, 'PREDICATE_FAILED:c1:CUSTOMER_LABEL'],
    ['evidence source edited', facts(), { revision: 'r2' }, 'CRITERION_stale:c1'],
    ['evidence source no longer readable', facts(), { accessible: false }, 'CRITERION_unauthorized:c1'],
  ])('is required when %s, with reasons, and does not alter the contract', (_n, f, chk, reason) => {
    const c = fulfilled();
    const before = JSON.stringify(c);
    const r = reviewRequired(c, ctxWith(f, chk));
    expect(r.required).toBe(true);
    expect(r.reasons).toContain(reason);
    expect(JSON.stringify(c)).toBe(before);
    expect(c.lifecycle).toBe('FULFILLED');
  });
});

describe('predicate schema', () => {
  it('defaults to [] so P1/P2 criteria still validate', () => {
    const p = criterionSchema.safeParse({ id: 'c', type: 'MANUAL_REVIEW', description: 'd', required: true });
    expect(p.success && p.data.predicates).toEqual([]);
  });
  it.each([
    ['unknown kind', [{ kind: 'EVAL', value: 'x' }]],
    ['label with a space', [{ kind: 'HAS_LABEL', value: 'two words' }]],
    ['label with injection chars', [{ kind: 'HAS_LABEL', value: 'x" OR 1=1' }]],
    ['empty label', [{ kind: 'HAS_LABEL', value: '' }]],
    ['bad category', [{ kind: 'STATUS_CATEGORY_IS', value: 'finished' }]],
    ['too many', Array.from({ length: 6 }, () => ({ kind: 'RESOLUTION_SET' }))],
    ['not an array', { kind: 'RESOLUTION_SET' }],
  ])('rejects %s', (_n, predicates) => {
    expect(criterionSchema.safeParse({ id: 'c', type: 'MANUAL_REVIEW', description: 'd', required: true, predicates }).success).toBe(false);
  });
  it('a contract can be created with predicates and they survive', () => {
    expect(contractWith(ALL).criteria[0]!.predicates).toEqual(ALL);
  });
});

describe('overall decision still requires every mandatory condition', () => {
  it('canFulfill needs confirmed + all criteria satisfied (incl. predicates) + current acknowledgement', () => {
    const good = ackd(contractWith(ALL));
    expect(evaluateFulfillment(good, ctxWith(facts())).canFulfill).toBe(true);
    expect(evaluateFulfillment({ ...good, acknowledgement: undefined }, ctxWith(facts())).blockers).toContain('ACK_MISSING');
    expect(evaluateFulfillment({ ...good, confirmedVersion: undefined }, ctxWith(facts())).blockers).toContain('NOT_CONFIRMED');
    expect(evaluateFulfillment(good, ctxWith(facts({ resolutionSet: false }))).canFulfill).toBe(false);
  });
});
