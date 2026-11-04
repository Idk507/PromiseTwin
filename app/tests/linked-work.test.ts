import { describe, expect, it } from 'vitest';
import { ALLOWED_ROLES, applyCommand, availableCommands, createContract, type Actor, type Command, type CommandType } from '../src/domain/lifecycle';
import { MAX_LINKED_WORK, contractSchema, type Contract, type Lifecycle } from '../src/domain/contract';
import { evaluateFulfillment, type EvaluationContext } from '../src/domain/verification';
import { parseTimestamp } from '../src/domain/time';

// ---- fixtures (synthetic) ---------------------------------------------------------------------
const T = 'tenant-1';
const NOW = '2026-11-03T10:00:00Z';
const ctx: EvaluationContext = { now: NOW, sourceChecks: {} };
const agent: Actor = { accountId: 'agent-1', roles: ['AGENT'] };
const reviewer: Actor = { accountId: 'rev-1', roles: ['REVIEWER'] };
const approver: Actor = { accountId: 'appr-1', roles: ['APPROVER'] };
const acker: Actor = { accountId: 'cust-1', roles: ['ACKNOWLEDGER'] };
const system: Actor = { accountId: 'system:event', roles: ['SYSTEM'] };

const input = {
  customerReference: 'ACME',
  source: { product: 'JSM', site: 'one-atlas', issueId: '1001', issueKey: 'ITS-1' },
  promiseText: 'Fix it',
  criteria: [{ id: 'c1', type: 'LINKED_WORK', description: 'Fix released', required: true }],
};
const link = (over: Record<string, unknown> = {}) => ({
  issueId: '2001', issueKey: 'DEV-7', statusCategory: 'indeterminate', statusName: 'In Progress',
  observedUpdated: '2026-11-03T09:00:00.000-0500', ...over,
});
const obs = (over: Record<string, unknown> = {}) => ({
  issueId: '2001', statusCategory: 'done', statusName: 'Done', updated: '2026-11-03T10:30:00.000-0500', ...over,
});

let n = 0;
const cmd = (actor: Actor, c: Contract, body: Record<string, unknown>): Command =>
  ({ eventId: `ev-${++n}`, tenantId: T, expectedRevision: c.revision, actor, at: NOW, ...body }) as Command;

function fresh(): Contract {
  const r = createContract(input, { id: 'k1', tenantId: T, ownerAccountId: 'agent-1', actor: agent, at: NOW });
  if (!r.ok) throw new Error('setup');
  return r.contract;
}
function linked(over: Record<string, unknown> = {}): Contract {
  const c = fresh();
  const r = applyCommand(c, cmd(agent, c, { type: 'LINK_WORK', link: link(over) }), ctx);
  if (!r.ok || r.duplicate) throw new Error(`setup link ${JSON.stringify(r)}`);
  return r.contract;
}
const inState = (c: Contract, lifecycle: Lifecycle): Contract => ({
  ...c, lifecycle,
  confirmedVersion: lifecycle === 'DRAFT' ? undefined : 1,
  ...(lifecycle === 'FULFILLED' || lifecycle === 'ACKNOWLEDGED'
    ? { acknowledgement: { byAccountId: 'cust-1', atContractVersion: 1, decision: 'GRANTED' as const, decidedAt: NOW } }
    : {}),
  ...(lifecycle === 'FULFILLED' ? { fulfilledAt: NOW } : {}),
});

describe('parseTimestamp', () => {
  it.each([
    ['2026-11-02T11:47:33.542-0500'], ['2026-11-02T11:47:33.542-05:00'], ['2026-11-02T16:47:33Z'], ['2021-01-20T15:58:12.797+1100'], ['2026-03-09T12:07:06+05:30'],
  ])('accepts %s', (v) => expect(parseTimestamp(v)).toBeTypeOf('number'));
  it('orders no-colon and colon offsets identically', () => {
    expect(parseTimestamp('2026-11-02T11:47:33.000-0500')).toBe(parseTimestamp('2026-11-02T16:47:33Z'));
  });
  it.each([[''], ['soon'], ['2026'], ['x'.repeat(41)], ['not-a-date-at-all']])('rejects %j', (v) => {
    expect(parseTimestamp(v)).toBeUndefined();
  });
});

describe('contract schema compatibility', () => {
  it('a P1-era stored contract without linkedWork still validates and defaults to []', () => {
    const { linkedWork: _drop, ...p1 } = fresh();
    const parsed = contractSchema.safeParse(p1);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.linkedWork).toEqual([]);
  });
});

describe('LINK_WORK / UNLINK_WORK', () => {
  it('links a work item and audits it (positive)', () => {
    const c = fresh();
    const r = applyCommand(c, cmd(agent, c, { type: 'LINK_WORK', link: link() }), ctx);
    expect(r.ok && !r.duplicate && r.contract.linkedWork).toHaveLength(1);
    if (r.ok && !r.duplicate) {
      expect(r.contract.linkedWork[0]).toMatchObject({ issueKey: 'DEV-7', linkedBy: 'agent-1', linkedAt: NOW });
      expect(r.event.type).toBe('LINK_WORK');
      expect(r.contract.revision).toBe(c.revision + 1);
    }
  });

  it.each([
    ['self link', link({ issueId: '1001', issueKey: 'ITS-1' }), 'SELF_LINK'],
    ['bad key', link({ issueKey: 'dev 7; DROP' }), 'issueKey'],
    ['non-numeric id', link({ issueId: '20x1' }), 'issueId'],
    ['missing status', link({ statusName: '' }), 'statusName'],
    ['unparseable time', link({ observedUpdated: 'yesterdayish!' }), 'observedUpdated'],
  ])('rejects %s', (_n, bad, detail) => {
    const c = fresh();
    const r = applyCommand(c, cmd(agent, c, { type: 'LINK_WORK', link: bad }), ctx);
    expect(r).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(JSON.stringify(r)).toContain(detail);
  });

  it('rejects a duplicate link and enforces the limit', () => {
    const c = linked();
    expect(applyCommand(c, cmd(agent, c, { type: 'LINK_WORK', link: link() }), ctx)).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    let cur = fresh();
    for (let i = 0; i < MAX_LINKED_WORK; i++) {
      const r = applyCommand(cur, cmd(agent, cur, { type: 'LINK_WORK', link: link({ issueId: String(3000 + i), issueKey: `DEV-${i + 1}` }) }), ctx);
      if (!r.ok || r.duplicate) throw new Error('setup');
      cur = r.contract;
    }
    expect(applyCommand(cur, cmd(agent, cur, { type: 'LINK_WORK', link: link({ issueId: '9999', issueKey: 'DEV-99' }) }), ctx))
      .toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' });
  });

  it.each(['VERIFIED', 'ACKNOWLEDGED', 'FULFILLED'] as Lifecycle[])('refuses linking in %s', (state) => {
    const c = inState(fresh(), state);
    expect(applyCommand(c, cmd(agent, c, { type: 'LINK_WORK', link: link() }), ctx)).toMatchObject({ ok: false, code: 'ILLEGAL_TRANSITION' });
  });

  it.each([['reviewer', reviewer], ['acknowledger', acker], ['approver', approver], ['system', system]] as Array<[string, Actor]>)(
    '%s cannot link or unlink', (_n, actor) => {
      const c = linked();
      expect(applyCommand(c, cmd(actor, c, { type: 'LINK_WORK', link: link({ issueId: '5', issueKey: 'DEV-5' }) }), ctx)).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
      expect(applyCommand(c, cmd(actor, c, { type: 'UNLINK_WORK', issueId: '2001' }), ctx)).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
    });

  it('unlinks (positive) and refuses an unknown issue (negative)', () => {
    const c = linked();
    const r = applyCommand(c, cmd(agent, c, { type: 'UNLINK_WORK', issueId: '2001' }), ctx);
    expect(r.ok && !r.duplicate && r.contract.linkedWork).toEqual([]);
    expect(applyCommand(c, cmd(agent, c, { type: 'UNLINK_WORK', issueId: '404' }), ctx)).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });
});

describe('OBSERVE_LINKED_WORK authorization (SYSTEM only)', () => {
  it.each([['agent', agent], ['reviewer', reviewer], ['acknowledger', acker], ['approver', approver],
    ['all user roles at once', { accountId: 'x', roles: ['AGENT', 'REVIEWER', 'ACKNOWLEDGER', 'APPROVER'] } as Actor]] as Array<[string, Actor]>)(
    'a %s cannot record observations', (_n, actor) => {
      const c = linked();
      expect(applyCommand(c, cmd(actor, c, { type: 'OBSERVE_LINKED_WORK', observation: obs() }), ctx)).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
    });

  it('SYSTEM may run only OBSERVE_LINKED_WORK: no other command lists SYSTEM', () => {
    const allowedForSystem = (Object.keys(ALLOWED_ROLES) as CommandType[]).filter((t) => ALLOWED_ROLES[t].includes('SYSTEM'));
    expect(allowedForSystem).toEqual(['OBSERVE_LINKED_WORK']);
  });

  it.each([
    { type: 'CONFIRM' }, { type: 'START' }, { type: 'MARK_DELIVERED' }, { type: 'VERIFY' }, { type: 'FULFILL' },
    { type: 'ACKNOWLEDGE', decision: 'GRANTED' }, { type: 'SET_AT_RISK', atRisk: false }, { type: 'REOPEN', reason: 'x' },
  ])('SYSTEM cannot run %j', (body) => {
    const c = linked();
    expect(applyCommand(c, cmd(system, c, body), ctx)).toMatchObject({ ok: false, code: 'UNAUTHORIZED_ACTOR' });
  });

  it('availableCommands never offers OBSERVE_LINKED_WORK to user roles', () => {
    const c = linked();
    expect(availableCommands(c, ['AGENT', 'REVIEWER', 'ACKNOWLEDGER', 'APPROVER'])).not.toContain('OBSERVE_LINKED_WORK');
  });
});

describe('OBSERVE_LINKED_WORK behaviour', () => {
  it('updates the snapshot when the observation is newer (offset formats compared correctly)', () => {
    const c = linked(); // observed 09:00 -0500
    const r = applyCommand(c, cmd(system, c, { type: 'OBSERVE_LINKED_WORK', observation: obs() }), ctx);
    if (!r.ok || r.duplicate) throw new Error('expected applied');
    expect(r.contract.linkedWork[0]).toMatchObject({ statusCategory: 'done', statusName: 'Done', observedUpdated: '2026-11-03T10:30:00.000-0500' });
    expect(r.contract.revision).toBe(c.revision + 1);
    expect(r.event).toMatchObject({ type: 'OBSERVE_LINKED_WORK', actorAccountId: 'system:event', actorRoles: ['SYSTEM'] });
  });

  it.each(['DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'DELIVERED', 'VERIFIED', 'ACKNOWLEDGED', 'FULFILLED'] as Lifecycle[])(
    'never changes lifecycle, evidence or acknowledgement (state %s)', (state) => {
      const c = inState(linked(), state);
      const r = applyCommand(c, cmd(system, c, { type: 'OBSERVE_LINKED_WORK', observation: obs() }), ctx);
      if (!r.ok || r.duplicate) throw new Error('expected applied');
      expect(r.contract.lifecycle).toBe(state);
      expect(r.contract.evidence).toEqual(c.evidence);
      expect(r.contract.acknowledgement).toEqual(c.acknowledgement);
      expect(r.contract.fulfilledAt).toBe(c.fulfilledAt);
      expect(r.contract.criteria).toEqual(c.criteria);
    });

  it('linked work reaching Done does NOT make a promise fulfillable (Done != Fulfilled)', () => {
    let c = inState(linked(), 'IN_PROGRESS');
    const r = applyCommand(c, cmd(system, c, { type: 'OBSERVE_LINKED_WORK', observation: obs() }), ctx);
    if (!r.ok || r.duplicate) throw new Error('expected applied');
    c = r.contract;
    expect(c.linkedWork[0]!.statusCategory).toBe('done');
    const d = evaluateFulfillment(c, ctx);
    expect(d.canFulfill).toBe(false);
    expect(d.blockers).toContain('CRITERION_missing:c1');
    expect(applyCommand(c, cmd(agent, c, { type: 'FULFILL' }), ctx)).toMatchObject({ ok: false, code: 'ILLEGAL_TRANSITION' });
  });

  it.each([
    ['equal timestamp (duplicate delivery)', '2026-11-03T09:00:00.000-0500'],
    ['older timestamp (out of order)', '2026-11-03T08:00:00.000-0500'],
    ['same instant written with a colon offset', '2026-11-03T14:00:00.000+00:00'],
  ])('%s is a no-op: nothing changes, nothing to persist', (_n, updated) => {
    const c = linked();
    const r = applyCommand(c, cmd(system, c, { type: 'OBSERVE_LINKED_WORK', observation: obs({ updated }) }), ctx);
    expect(r).toMatchObject({ ok: true, duplicate: true });
    if (r.ok) expect(r.contract).toEqual(c);
  });

  it('flags risk when linked work regresses from done, and not otherwise', () => {
    const done = linked({ statusCategory: 'done', statusName: 'Done' });
    const back = applyCommand(done, cmd(system, done, { type: 'OBSERVE_LINKED_WORK', observation: obs({ statusCategory: 'indeterminate', statusName: 'Reopened' }) }), ctx);
    expect(back.ok && !back.duplicate && back.contract.atRisk).toBe(true);
    const fwd = linked();
    const ahead = applyCommand(fwd, cmd(system, fwd, { type: 'OBSERVE_LINKED_WORK', observation: obs({ statusCategory: 'indeterminate', statusName: 'In Review' }) }), ctx);
    expect(ahead.ok && !ahead.duplicate && ahead.contract.atRisk).toBe(false);
    const stays = applyCommand(done, cmd(system, done, { type: 'OBSERVE_LINKED_WORK', observation: obs({ statusCategory: 'done', statusName: 'Closed' }) }), ctx);
    expect(stays.ok && !stays.duplicate && stays.contract.atRisk).toBe(false);
  });

  it('ignores observations for issues that are not linked (NOT_LINKED)', () => {
    const c = linked();
    expect(applyCommand(c, cmd(system, c, { type: 'OBSERVE_LINKED_WORK', observation: obs({ issueId: '777' }) }), ctx))
      .toMatchObject({ ok: false, code: 'PRECONDITION_FAILED', detail: ['NOT_LINKED'] });
  });

  it.each([
    ['null', null], ['empty', {}], ['bad id', obs({ issueId: 'abc' })], ['bad time', obs({ updated: 'later' })], ['no status', obs({ statusName: '' })],
  ])('rejects malformed observation: %s', (_n, bad) => {
    const c = linked();
    expect(applyCommand(c, cmd(system, c, { type: 'OBSERVE_LINKED_WORK', observation: bad }), ctx)).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('refuses other tenants and stale revisions; replayed eventId is a no-op', () => {
    const c = linked();
    const base = cmd(system, c, { type: 'OBSERVE_LINKED_WORK', observation: obs() });
    expect(applyCommand(c, { ...base, tenantId: 'tenant-2' } as Command, ctx)).toMatchObject({ ok: false, code: 'TENANT_MISMATCH' });
    expect(applyCommand(c, { ...base, expectedRevision: c.revision - 1 } as Command, ctx)).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' });
    const first = applyCommand(c, base, ctx);
    if (!first.ok || first.duplicate) throw new Error('expected applied');
    expect(applyCommand(first.contract, base, ctx)).toMatchObject({ ok: true, duplicate: true });
  });

  it('inputs are never mutated', () => {
    const c = linked();
    const snapshot = JSON.stringify(c);
    applyCommand(c, cmd(system, c, { type: 'OBSERVE_LINKED_WORK', observation: obs() }), ctx);
    expect(JSON.stringify(c)).toBe(snapshot);
  });
});
