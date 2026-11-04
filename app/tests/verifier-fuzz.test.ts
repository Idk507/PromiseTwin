import { describe, expect, it } from 'vitest';
import { applyCommand, type Actor, type Command } from '../src/domain/lifecycle';
import type { Contract, Evidence, Predicate } from '../src/domain/contract';
import { evaluateFulfillment, type EvaluationContext, type IssueFacts, type SourceCheck } from '../src/domain/verification';

// Differential test: an INDEPENDENT, deliberately naive oracle of the fulfilment rules is compared
// with the real verifier on many seeded random contracts. A disagreement means one of them is
// wrong. Most importantly, the verifier must NEVER say "fulfillable" when the oracle says no.

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
const NOW = '2026-11-04T10:00:00Z';
const NOW_MS = Date.parse(NOW);

// ---- the oracle: plain boolean logic, no shared code with the verifier ------------------------
function norm(ref: string): string {
  let s = ref.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  s = s.replace(/^-+/, '').replace(/-+$/, '').slice(0, 50).replace(/-+$/, '');
  return s;
}
function predOk(p: Predicate, ref: string, f: IssueFacts | undefined): boolean {
  if (!f) return false;
  if (p.kind === 'STATUS_CATEGORY_IS') return f.statusCategory === p.value;
  if (p.kind === 'RESOLUTION_SET') return f.resolutionSet === true;
  if (p.kind === 'HAS_LABEL') return f.labels.indexOf(p.value) >= 0;
  if (p.kind === 'CUSTOMER_LABEL') { const n = norm(ref); return n !== '' && f.labels.indexOf('customer-' + n) >= 0; }
  return f.linkedIssueIds.indexOf('1001') >= 0 || f.linkedIssueKeys.indexOf('ITS-1') >= 0; // LINKED_TO_SOURCE
}
function oracle(c: Contract, ctx: EvaluationContext): boolean {
  if (c.lifecycle === 'DRAFT' || c.confirmedVersion !== c.version) return false;
  const required = c.criteria.filter((x) => x.required);
  if (required.length === 0) return false;
  for (const crit of required) {
    let satisfied = false; let conflicting = false;
    for (const e of c.evidence.filter((x) => x.criterionId === crit.id)) {
      if (e.customerReference !== c.customerReference) { conflicting = true; continue; }
      const chk = ctx.sourceChecks[e.sourceRef];
      if (!chk || !chk.accessible) continue;
      const expired = e.expiresAt !== undefined && Date.parse(e.expiresAt) <= NOW_MS;
      const fresh = !expired && e.contractVersion === c.version && chk.revision !== undefined && chk.revision === e.sourceRevision;
      if (!fresh) continue;
      if (e.reviewStatus === 'INVALID') { conflicting = true; continue; }
      if (e.reviewStatus !== 'VALID') continue;
      if (crit.predicates.every((p) => predOk(p, c.customerReference, chk.facts))) satisfied = true;
    }
    if (!satisfied || conflicting) return false;
  }
  const a = c.acknowledgement;
  return !!a && a.decision === 'GRANTED' && a.atContractVersion === c.version;
}

// ---- random generation ---------------------------------------------------------------------
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
function genCase(r: () => number): { c: Contract; ctx: EvaluationContext } {
  const refs = ['ACME', 'Acme Corp', '???', 'Globex', 'a'.repeat(60)] as const;
  const customerReference = pick(r, refs);
  const version = 1 + Math.floor(r() * 2);
  const allPreds: Predicate[] = [{ kind: 'STATUS_CATEGORY_IS', value: 'done' }, { kind: 'STATUS_CATEGORY_IS', value: 'new' }, { kind: 'RESOLUTION_SET' }, { kind: 'HAS_LABEL', value: 'regression-passed' }, { kind: 'CUSTOMER_LABEL' }, { kind: 'LINKED_TO_SOURCE' }];
  const nCrit = 1 + Math.floor(r() * 3);
  const criteria = Array.from({ length: nCrit }, (_, i) => ({
    id: `c${i + 1}`, type: 'LINKED_WORK' as const, description: 'd', required: r() < 0.85,
    predicates: allPreds.filter(() => r() < 0.4).slice(0, 5),
  }));
  const sources = ['DEV-1', 'DEV-2', 'DEV-3'];
  const labelPool = ['customer-acme', 'customer-acme-corp', 'customer-globex', 'VIP', 'regression-passed', 'customer-' + norm('a'.repeat(60)), 'customer-'];
  const sourceChecks: Record<string, SourceCheck> = {};
  for (const s of sources) {
    if (r() < 0.1) continue; // no check at all => must fail closed
    sourceChecks[s] = {
      accessible: r() < 0.9,
      revision: r() < 0.9 ? 'r1' : undefined,
      facts: r() < 0.9 ? {
        id: '3001', key: s, statusCategory: pick(r, ['new', 'indeterminate', 'done'] as const), resolutionSet: r() < 0.6,
        labels: labelPool.filter(() => r() < 0.4), linkedIssueIds: r() < 0.6 ? ['1001'] : [], linkedIssueKeys: r() < 0.3 ? ['ITS-1'] : [],
      } : undefined,
    };
  }
  const evidence: Evidence[] = [];
  for (const crit of criteria) {
    const n = Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      evidence.push({
        id: `e${evidence.length + 1}`, criterionId: crit.id, sourceType: 'JIRA_ISSUE', sourceRef: pick(r, sources),
        customerReference: r() < 0.9 ? customerReference : 'OTHER', observedAt: NOW,
        ...(r() < 0.15 ? { expiresAt: pick(r, ['2026-11-04T09:00:00Z', '2026-12-01T00:00:00Z']) } : {}),
        sourceRevision: r() < 0.9 ? 'r1' : 'r0', contractVersion: r() < 0.9 ? version : version + 1, addedBy: 'a',
        reviewStatus: pick(r, ['VALID', 'VALID', 'VALID', 'PENDING', 'INVALID'] as const),
      });
    }
  }
  const ackKind = pick(r, ['none', 'granted', 'granted', 'denied', 'old'] as const);
  const c = {
    id: 'k1', tenantId: 't', customerReference, source: { product: 'JSM', site: 's', issueId: '1001', issueKey: 'ITS-1' },
    ownerAccountId: 'o', promiseText: 'p', criteria, evidence, linkedWork: [], atRisk: false, version, revision: 1,
    lifecycle: pick(r, ['DRAFT', 'CONFIRMED', 'DELIVERED', 'VERIFIED', 'ACKNOWLEDGED'] as const),
    confirmedVersion: r() < 0.9 ? version : undefined, fulfillmentHistory: [], appliedEventIds: [], createdAt: NOW, updatedAt: NOW,
    ...(ackKind === 'none' ? {} : { acknowledgement: { byAccountId: 'u', atContractVersion: ackKind === 'old' ? version + 1 : version, decision: ackKind === 'denied' ? 'DENIED' : 'GRANTED', decidedAt: NOW } }),
  } as unknown as Contract;
  return { c, ctx: { now: NOW, sourceChecks } };
}

describe('differential fuzz: verifier vs independent oracle', () => {
  const N = 30000;
  it(`agrees on ${N} seeded random contracts, and never fulfils when the oracle says no`, () => {
    const r = rng(20261104);
    let yes = 0; let no = 0;
    const disagreements: string[] = [];
    for (let i = 0; i < N; i++) {
      const { c, ctx } = genCase(r);
      const real = evaluateFulfillment(c, ctx).canFulfill;
      const want = oracle(c, ctx);
      if (real) yes++; else no++;
      if (real !== want) disagreements.push(`#${i} real=${real} oracle=${want}`);
      if (real && !want) throw new Error(`UNSAFE: verifier fulfilled a case the oracle rejects (#${i})`);
    }
    expect(disagreements).toEqual([]);
    // the generator must exercise BOTH outcomes meaningfully, or the test proves nothing
    expect(yes).toBeGreaterThan(50);
    expect(no).toBeGreaterThan(N / 2);
  });

  it('applyCommand FULFILL succeeds only when the oracle approves (lifecycle gate + evidence gate)', () => {
    const r = rng(777);
    const actor: Actor = { accountId: 'x', roles: ['AGENT', 'REVIEWER'] };
    let fulfilled = 0;
    for (let i = 0; i < 20000; i++) {
      const { c, ctx } = genCase(r);
      const cc = { ...c, lifecycle: 'ACKNOWLEDGED' as const };
      const res = applyCommand(cc, { type: 'FULFILL', eventId: `e${i}`, tenantId: 't', expectedRevision: 1, actor, at: NOW } as Command, ctx);
      const done = res.ok && !res.duplicate && res.contract.lifecycle === 'FULFILLED';
      if (done) fulfilled++;
      expect(done).toBe(oracle(cc, ctx));
    }
    expect(fulfilled).toBeGreaterThan(20);
  });
});
