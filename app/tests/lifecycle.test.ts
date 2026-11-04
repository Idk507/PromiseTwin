import { describe, expect, it } from 'vitest';
import { applyCommand, createContract, type Actor, type Command, type Result } from '../src/domain/lifecycle';
import { LIFECYCLE, type Contract, type Lifecycle } from '../src/domain/contract';
import { evaluateFulfillment, type EvaluationContext } from '../src/domain/verification';

// ---- fixtures (synthetic data only) -------------------------------------------------------
const T = 'tenant-1';
const NOW = '2026-11-02T10:00:00Z';
const agent: Actor = { accountId: 'agent-1', roles: ['AGENT'] };
const reviewer: Actor = { accountId: 'rev-1', roles: ['REVIEWER'] };
const acker: Actor = { accountId: 'cust-1', roles: ['ACKNOWLEDGER'] };
const approver: Actor = { accountId: 'appr-1', roles: ['APPROVER'] };

const okCtx: EvaluationContext = {
  now: NOW,
  sourceChecks: { 'ITS-1': { accessible: true, revision: 'r1' } },
};

const input = {
  customerReference: 'ACME',
  source: { product: 'JSM', site: 'one-atlas', issueId: '1001', issueKey: 'ITS-1' },
  promiseText: 'Deliver the export fix to ACME by Friday',
  criteria: [
    { id: 'c1', type: 'LINKED_WORK', description: 'Fix released', required: true },
    { id: 'c2', type: 'MANUAL_REVIEW', description: 'Nice to have', required: false },
  ],
};
const evidence = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  criterionId: 'c1',
  sourceType: 'JIRA_ISSUE',
  sourceRef: 'ITS-1',
  customerReference: 'ACME',
  observedAt: '2026-11-01T10:00:00Z',
  sourceRevision: 'r1',
  ...over,
});

let n = 0;
const cmd = (actor: Actor, c: Contract, body: Record<string, unknown>, at = NOW): Command =>
  ({ eventId: `ev-${++n}`, tenantId: T, expectedRevision: c.revision, actor, at, ...body }) as Command;

function must(r: Result): Contract {
  if (!r.ok) throw new Error(`refused ${r.code} ${r.detail?.join(',')}`);
  return r.contract;
}
const step = (c: Contract, actor: Actor, body: Record<string, unknown>, ctx = okCtx) =>
  applyCommand(c, cmd(actor, c, body), ctx);

function fresh(): Contract {
  return must(createContract(input, { id: 'k1', tenantId: T, ownerAccountId: 'agent-1', actor: agent, at: NOW }));
}
/** Drives a contract to the requested lifecycle through legal commands only. */
function reach(target: Lifecycle): Contract {
  let c = fresh();
  const path: Array<[Actor, Record<string, unknown>]> = [
    [agent, { type: 'CONFIRM' }],
    [agent, { type: 'START' }],
    [agent, { type: 'ADD_EVIDENCE', evidence: evidence() }],
    [reviewer, { type: 'REVIEW_EVIDENCE', evidenceId: 'e1', status: 'VALID' }],
    [agent, { type: 'MARK_DELIVERED' }],
    [reviewer, { type: 'VERIFY' }],
    [acker, { type: 'ACKNOWLEDGE', decision: 'GRANTED' }],
    [agent, { type: 'FULFILL' }],
  ];
  for (const [a, b] of path) {
    if (c.lifecycle === target) break;
    c = must(step(c, a, b));
  }
  expect(c.lifecycle).toBe(target);
  return c;
}

// ---- happy path --------------------------------------------------------------------------
describe('full lifecycle', () => {
  it('reaches FULFILLED only through every gate, with an audit event per step', () => {
    let c = fresh();
    const events: string[] = [];
    const path: Array<[Actor, Record<string, unknown>]> = [
      [agent, { type: 'CONFIRM' }],
      [agent, { type: 'START' }],
      [agent, { type: 'ADD_EVIDENCE', evidence: evidence() }],
      [reviewer, { type: 'REVIEW_EVIDENCE', evidenceId: 'e1', status: 'VALID' }],
      [agent, { type: 'MARK_DELIVERED' }],
      [reviewer, { type: 'VERIFY' }],
      [acker, { type: 'ACKNOWLEDGE', decision: 'GRANTED' }],
      [agent, { type: 'FULFILL' }],
    ];
    for (const [a, b] of path) {
      const r = step(c, a, b);
      if (!r.ok || r.duplicate) throw new Error('unexpected');
      expect(r.event.actorAccountId).toBe(a.accountId);
      events.push(r.event.type);
      c = r.contract;
    }
    expect(c.lifecycle).toBe('FULFILLED');
    expect(events).toHaveLength(8);
    expect(c.revision).toBe(9); // 1 + 8 mutations
  });
});

// ---- Done != Fulfilled and fail-closed proof ---------------------------------------------
describe('evaluateFulfillment fails closed', () => {
  const base = () => reach('ACKNOWLEDGED');

  it('is satisfied only when everything holds (positive)', () => {
    expect(evaluateFulfillment(base(), okCtx).canFulfill).toBe(true);
  });

  it('a contract with no evidence can never fulfil, whatever the issue status (Done != Fulfilled)', () => {
    const c: Contract = { ...fresh(), lifecycle: 'ACKNOWLEDGED', confirmedVersion: 1,
      acknowledgement: { byAccountId: 'cust-1', atContractVersion: 1, decision: 'GRANTED', decidedAt: NOW } };
    const d = evaluateFulfillment(c, okCtx);
    expect(d.canFulfill).toBe(false);
    expect(d.blockers).toContain('CRITERION_missing:c1');
  });

  const cases: Array<[string, (c: Contract) => Contract, EvaluationContext, string]> = [
    ['unknown (PENDING) evidence', (c) => ({ ...c, evidence: c.evidence.map((e) => ({ ...e, reviewStatus: 'PENDING' as const })) }), okCtx, 'CRITERION_missing:c1'],
    ['INVALID evidence', (c) => ({ ...c, evidence: c.evidence.map((e) => ({ ...e, reviewStatus: 'INVALID' as const })) }), okCtx, 'CRITERION_conflicting:c1'],
    ['wrong customer', (c) => ({ ...c, evidence: c.evidence.map((e) => ({ ...e, customerReference: 'OTHER' })) }), okCtx, 'CRITERION_conflicting:c1'],
    ['expired proof', (c) => ({ ...c, evidence: c.evidence.map((e) => ({ ...e, expiresAt: '2026-11-02T09:00:00Z' })) }), okCtx, 'CRITERION_stale:c1'],
    ['source changed since observed', (c) => c, { now: NOW, sourceChecks: { 'ITS-1': { accessible: true, revision: 'r2' } } }, 'CRITERION_stale:c1'],
    ['source revision unknown', (c) => c, { now: NOW, sourceChecks: { 'ITS-1': { accessible: true } } }, 'CRITERION_stale:c1'],
    ['source not accessible to the user', (c) => c, { now: NOW, sourceChecks: { 'ITS-1': { accessible: false, revision: 'r1' } } }, 'CRITERION_unauthorized:c1'],
    ['source check absent', (c) => c, { now: NOW, sourceChecks: {} }, 'CRITERION_unauthorized:c1'],
    ['proof from older contract version', (c) => ({ ...c, evidence: c.evidence.map((e) => ({ ...e, contractVersion: 0 + 99 })) }), okCtx, 'CRITERION_stale:c1'],
    ['acknowledgement denied', (c) => ({ ...c, acknowledgement: { ...c.acknowledgement!, decision: 'DENIED' as const } }), okCtx, 'ACK_DENIED'],
    ['acknowledgement for old version', (c) => ({ ...c, acknowledgement: { ...c.acknowledgement!, atContractVersion: 0 + 7 } }), okCtx, 'ACK_STALE'],
    ['no acknowledgement', (c) => ({ ...c, acknowledgement: undefined }), okCtx, 'ACK_MISSING'],
    ['not confirmed', (c) => ({ ...c, confirmedVersion: undefined }), okCtx, 'NOT_CONFIRMED'],
  ];
  it.each(cases)('blocks on %s', (_name, mutate, ctx, blocker) => {
    const d = evaluateFulfillment(mutate(base()), ctx);
    expect(d.canFulfill).toBe(false);
    expect(d.blockers).toContain(blocker);
  });

  it('one INVALID item blocks even when another item is VALID', () => {
    const c = base();
    const extra = { ...c.evidence[0]!, id: 'e2', reviewStatus: 'INVALID' as const };
    expect(evaluateFulfillment({ ...c, evidence: [...c.evidence, extra] }, okCtx).blockers).toContain('CRITERION_conflicting:c1');
  });

  it('a contract with no required criteria cannot fulfil', () => {
    const c = { ...base(), criteria: base().criteria.map((x) => ({ ...x, required: false })) };
    expect(evaluateFulfillment(c, okCtx).blockers).toContain('NO_REQUIRED_CRITERIA');
  });
});

// ---- transitions --------------------------------------------------------------------------
describe('illegal skips are rejected', () => {
  const skips: Array<[Lifecycle, Record<string, unknown>, Actor]> = [
    ['DRAFT', { type: 'START' }, agent],
    ['DRAFT', { type: 'MARK_DELIVERED' }, agent],
    ['DRAFT', { type: 'VERIFY' }, reviewer],
    ['DRAFT', { type: 'FULFILL' }, agent],
    ['CONFIRMED', { type: 'MARK_DELIVERED' }, agent],
    ['IN_PROGRESS', { type: 'VERIFY' }, reviewer],
    ['DELIVERED', { type: 'ACKNOWLEDGE', decision: 'GRANTED' }, acker],
    ['VERIFIED', { type: 'FULFILL' }, agent],
    ['FULFILLED', { type: 'START' }, agent],
    ['IN_PROGRESS', { type: 'CONFIRM' }, agent],
  ];
  it.each(skips)('%s refuses %j', (state, body, actor) => {
    const c = state === 'DRAFT' ? fresh() : reach(state);
    const r = step(c, actor, body);
    expect(r).toMatchObject({ ok: false, code: 'ILLEGAL_TRANSITION' });
  });

  it('CONFIRM without any required criterion is refused', () => {
    const c = { ...fresh(), criteria: fresh().criteria.map((x) => ({ ...x, required: false })) };
    expect(step(c, agent, { type: 'CONFIRM' })).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' });
  });

  it('VERIFY without valid proof fails closed', () => {
    const c = reach('DELIVERED'); // evidence e1 is VALID here
    const stale: EvaluationContext = { now: NOW, sourceChecks: { 'ITS-1': { accessible: true, revision: 'zzz' } } };
    expect(step(c, reviewer, { type: 'VERIFY' }, stale)).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' });
  });

  it('FULFILL is refused if proof went stale after acknowledgement', () => {
    const c = reach('ACKNOWLEDGED');
    const stale: EvaluationContext = { now: NOW, sourceChecks: { 'ITS-1': { accessible: true, revision: 'changed' } } };
    const r = step(c, agent, { type: 'FULFILL' }, stale);
    expect(r).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' });
  });
});

describe('authorization', () => {
  it.each([
    ['agent cannot VERIFY', agent, { type: 'VERIFY' }, 'DELIVERED'],
    ['agent cannot ACKNOWLEDGE', agent, { type: 'ACKNOWLEDGE', decision: 'GRANTED' }, 'VERIFIED'],
    ['reviewer cannot ACKNOWLEDGE', reviewer, { type: 'ACKNOWLEDGE', decision: 'GRANTED' }, 'VERIFIED'],
    ['acknowledger cannot FULFILL', acker, { type: 'FULFILL' }, 'ACKNOWLEDGED'],
    ['agent cannot AMEND_CRITERIA', agent, { type: 'AMEND_CRITERIA', criteria: input.criteria, reason: 'x' }, 'IN_PROGRESS'],
    ['agent cannot REOPEN', agent, { type: 'REOPEN', reason: 'x' }, 'FULFILLED'],
    ['actor with no roles is refused', { accountId: 'x', roles: [] }, { type: 'START' }, 'CONFIRMED'],
  ] as Array<[string, Actor, Record<string, unknown>, Lifecycle]>)('%s', (_n, actor, body, state) => {
    expect(step(reach(state), actor, body)).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
  });

  it('unauthorized acknowledgement leaves state untouched', () => {
    const c = reach('VERIFIED');
    step(c, agent, { type: 'ACKNOWLEDGE', decision: 'GRANTED' });
    expect(c.lifecycle).toBe('VERIFIED');
    expect(c.acknowledgement).toBeUndefined();
  });

  it('a reviewer cannot validate their own evidence (separation of duties)', () => {
    let c = reach('IN_PROGRESS');
    c = must(step(c, reviewer, { type: 'ADD_EVIDENCE', evidence: evidence({ id: 'e9' }) }));
    expect(step(c, reviewer, { type: 'REVIEW_EVIDENCE', evidenceId: 'e9', status: 'VALID' })).toMatchObject({
      ok: false, code: 'UNAUTHORIZED_ACTOR', detail: ['SELF_REVIEW'],
    });
  });

  it('new evidence cannot be self-declared VALID', () => {
    const c = must(step(reach('IN_PROGRESS'), agent, { type: 'ADD_EVIDENCE', evidence: evidence({ id: 'e5', reviewStatus: 'VALID' }) }));
    expect(c.evidence.find((e) => e.id === 'e5')!.reviewStatus).toBe('PENDING');
  });

  it('refuses commands from another tenant', () => {
    const c = fresh();
    const r = applyCommand(c, { ...cmd(agent, c, { type: 'CONFIRM' }), tenantId: 'tenant-2' } as Command, okCtx);
    expect(r).toMatchObject({ ok: false, code: 'TENANT_MISMATCH' });
  });

  it('the promise owner cannot acknowledge their own fulfilment', () => {
    const c = reach('VERIFIED'); // ownerAccountId is 'agent-1'
    const ownerAsAcker: Actor = { accountId: 'agent-1', roles: ['ACKNOWLEDGER'] };
    expect(step(c, ownerAsAcker, { type: 'ACKNOWLEDGE', decision: 'GRANTED' })).toMatchObject({
      ok: false, code: 'UNAUTHORIZED_ACTOR', detail: ['SELF_ACKNOWLEDGE'],
    });
  });

  it('a denied acknowledgement is recorded and does not advance', () => {
    const c = must(step(reach('VERIFIED'), acker, { type: 'ACKNOWLEDGE', decision: 'DENIED' }));
    expect(c.lifecycle).toBe('VERIFIED');
    expect(c.acknowledgement?.decision).toBe('DENIED');
  });
});

describe('concurrency and idempotency', () => {
  it('replaying an eventId is a no-op, not a second transition', () => {
    const c = fresh();
    const command = cmd(agent, c, { type: 'CONFIRM' });
    const first = applyCommand(c, command, okCtx);
    if (!first.ok || first.duplicate) throw new Error('unexpected');
    const replay = applyCommand(first.contract, command, okCtx);
    expect(replay).toMatchObject({ ok: true, duplicate: true });
    if (replay.ok) expect(replay.contract.revision).toBe(first.contract.revision);
  });

  it('a stale expectedRevision is a VERSION_CONFLICT', () => {
    const c = reach('IN_PROGRESS');
    const r = applyCommand(c, { ...cmd(agent, c, { type: 'SET_AT_RISK', atRisk: true }), expectedRevision: c.revision - 1 } as Command, okCtx);
    expect(r).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' });
  });

  it('two writers on the same revision: second is refused after first applies', () => {
    const c = reach('IN_PROGRESS');
    const a = cmd(agent, c, { type: 'SET_AT_RISK', atRisk: true });
    const b = cmd(reviewer, c, { type: 'SET_AT_RISK', atRisk: false });
    const first = applyCommand(c, a, okCtx);
    if (!first.ok) throw new Error('unexpected');
    expect(applyCommand(first.contract, b, okCtx)).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' });
  });

  it('inputs are never mutated', () => {
    const c = reach('IN_PROGRESS');
    const snapshot = JSON.stringify(c);
    step(c, agent, { type: 'SET_AT_RISK', atRisk: true });
    expect(JSON.stringify(c)).toBe(snapshot);
  });
});

describe('amendment and reopen preserve history', () => {
  it('amending criteria voids the acknowledgement, stales old proof and requires re-confirmation', () => {
    const c = must(step(reach('FULFILLED'), approver, { type: 'AMEND_CRITERIA', criteria: input.criteria, reason: 'scope change' }));
    expect(c.version).toBe(2);
    expect(c.lifecycle).toBe('DRAFT');
    expect(c.acknowledgement).toBeUndefined();
    expect(c.fulfillmentHistory).toHaveLength(1);
    // old proof (contractVersion 1) no longer counts
    expect(evaluateFulfillment({ ...c, lifecycle: 'ACKNOWLEDGED', confirmedVersion: 2 }, okCtx).blockers).toContain('CRITERION_stale:c1');
  });

  it('reopening a FULFILLED contract keeps the fulfilment as history', () => {
    const c = must(step(reach('FULFILLED'), reviewer, { type: 'REOPEN', reason: 'customer reported regression' }));
    expect(c.lifecycle).toBe('IN_PROGRESS');
    expect(c.fulfilledAt).toBeUndefined();
    expect(c.fulfillmentHistory[0]).toMatchObject({ reason: 'customer reported regression' });
  });

  it('REOPEN requires a reason', () => {
    expect(step(reach('FULFILLED'), reviewer, { type: 'REOPEN', reason: '' })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });
});

describe('input validation at the boundary', () => {
  const meta = { id: 'k', tenantId: T, ownerAccountId: 'a', actor: agent, at: NOW };
  it.each([
    ['empty promise', { ...input, promiseText: '' }],
    ['no criteria', { ...input, criteria: [] }],
    ['bad due date', { ...input, dueAt: 'tomorrow' }],
    ['missing customer', { ...input, customerReference: undefined }],
    ['null', null],
  ])('rejects %s', (_n, bad) => {
    expect(createContract(bad, meta)).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('only AGENT may create', () => {
    expect(createContract(input, { ...meta, actor: reviewer })).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
  });

  it('rejects evidence for an unknown criterion and duplicate evidence ids', () => {
    const c = reach('IN_PROGRESS');
    expect(step(c, agent, { type: 'ADD_EVIDENCE', evidence: evidence({ id: 'z', criterionId: 'nope' }) })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    const withE = must(step(c, agent, { type: 'ADD_EVIDENCE', evidence: evidence({ id: 'dup' }) }));
    expect(step(withE, agent, { type: 'ADD_EVIDENCE', evidence: evidence({ id: 'dup' }) })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('lifecycle order is the documented one', () => {
    expect([...LIFECYCLE]).toEqual(['DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'DELIVERED', 'VERIFIED', 'ACKNOWLEDGED', 'FULFILLED']);
  });
});
