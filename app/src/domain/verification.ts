import type { Contract, DecisionReport, Evidence, Predicate, PredicateKind } from './contract';
import { customerLabelFor } from '../shared/messages';

// Deterministic evidence verifier. No LLM score, no issue status of the PROMISE's own request is
// consulted: "issue Done" is not an input for fulfilment, so Done can never imply FULFILLED.
// Evidence issues are judged on facts the server reads as the acting user at decision time.

export type CriterionStatus =
  | 'satisfied'
  | 'missing'
  | 'stale'
  | 'conflicting'
  | 'unauthorized'
  | 'unmet';

/** Facts about an evidence issue, read by the server (never supplied by a client). */
export interface IssueFacts {
  id: string;
  key: string;
  statusCategory: string;
  resolutionSet: boolean;
  labels: string[];
  /** Ids and keys of issues linked to this one (any link type). */
  linkedIssueIds: string[];
  linkedIssueKeys: string[];
}

/** Result of the server re-reading a source AS THE ACTING USER at decision time. */
export interface SourceCheck {
  accessible: boolean;
  revision?: string;
  /** Absent means unknown, and unknown facts fail every predicate (fail closed). */
  facts?: IssueFacts;
}

export interface EvaluationContext {
  now: string;
  /** Keyed by evidence.sourceRef. An absent entry is treated as inaccessible (fail closed). */
  sourceChecks: Readonly<Record<string, SourceCheck>>;
}

export interface PredicateResult {
  kind: PredicateKind;
  ok: boolean;
}

export interface EvidenceDetail {
  id: string;
  status: CriterionStatus;
  predicates: PredicateResult[];
}

export interface CriterionResult {
  criterionId: string;
  status: CriterionStatus;
  evidenceIds: string[];
  evidence: EvidenceDetail[];
  /** For `unmet`: which predicate kinds failed on the reviewed, current evidence. */
  failedPredicates: PredicateKind[];
}

export interface FulfillmentDecision {
  canFulfill: boolean;
  criteria: CriterionResult[];
  /** Machine-readable reasons, e.g. NOT_CONFIRMED, CRITERION_unmet:c1, PREDICATE_FAILED:c1:HAS_LABEL. */
  blockers: string[];
}

// Reporting order when NO evidence item satisfies the criterion: `conflicting` always wins (an
// explicit INVALID blocks), then the item CLOSEST to success, because that is the actionable reason
// (`unmet` describes current, reviewed evidence; an old superseded `stale` item must not hide it).
// This ordering only affects which reason is shown. Satisfaction still needs an explicit
// `satisfied` item and no `conflicting` item.
const SEVERITY: CriterionStatus[] = ['conflicting', 'unmet', 'stale', 'unauthorized', 'missing'];
const MAX_DETAIL_EVIDENCE = 5;

/**
 * Jira label that binds evidence to a promise's customer: "customer-" + a normalized reference.
 * Returns undefined when the reference has no usable characters, so the predicate fails closed
 * instead of matching a generic label.
 */
export function customerLabel(customerReference: string): string | undefined {
  return customerLabelFor(customerReference);
}

function holds(p: Predicate, contract: Contract, f: IssueFacts): boolean {
  switch (p.kind) {
    case 'STATUS_CATEGORY_IS':
      return f.statusCategory === p.value;
    case 'RESOLUTION_SET':
      return f.resolutionSet;
    case 'HAS_LABEL':
      return f.labels.includes(p.value);
    case 'CUSTOMER_LABEL': {
      const label = customerLabel(contract.customerReference);
      return label !== undefined && f.labels.includes(label);
    }
    case 'LINKED_TO_SOURCE':
      return f.linkedIssueIds.includes(contract.source.issueId) || f.linkedIssueKeys.includes(contract.source.issueKey);
  }
}

/** Evaluates a criterion's predicates. Unknown facts => every predicate is false. */
export function evaluatePredicates(predicates: Predicate[], contract: Contract, facts: IssueFacts | undefined): PredicateResult[] {
  return predicates.map((p) => ({ kind: p.kind, ok: facts !== undefined && holds(p, contract, facts) }));
}

/** Classifies one evidence item against its contract; every doubt maps to a non-satisfied status. */
export function evidenceStatus(e: Evidence, contract: Contract, ctx: EvaluationContext): CriterionStatus {
  return evidenceDetail(e, contract, ctx).status;
}

export function evidenceDetail(e: Evidence, contract: Contract, ctx: EvaluationContext): EvidenceDetail {
  const criterion = contract.criteria.find((c) => c.id === e.criterionId);
  const check = ctx.sourceChecks[e.sourceRef];
  const predicates = evaluatePredicates(criterion?.predicates ?? [], contract, check?.facts);
  const done = (status: CriterionStatus): EvidenceDetail => ({ id: e.id, status, predicates });

  // 1. Subject binding: proof recorded for another customer is never usable.
  if (e.customerReference !== contract.customerReference) return done('conflicting');
  // 2. The acting user must be able to see the source right now.
  if (!check || !check.accessible) return done('unauthorized');
  // 3. Currency: expired, from older terms, or the source changed since observation.
  const now = Date.parse(ctx.now);
  if (e.expiresAt !== undefined && Date.parse(e.expiresAt) <= now) return done('stale');
  if (e.contractVersion !== contract.version) return done('stale');
  if (check.revision === undefined || check.revision !== e.sourceRevision) return done('stale');
  // 4. Review: only an explicit human VALID counts. PENDING (unknown) never does.
  if (e.reviewStatus === 'INVALID') return done('conflicting');
  if (e.reviewStatus === 'PENDING') return done('missing');
  // 5. Checkable facts: every predicate must hold now. A criterion with no predicates relies on
  //    human review alone (as before).
  if (predicates.some((p) => !p.ok)) return done('unmet');
  return done('satisfied');
}

/** Per-criterion status for every REQUIRED criterion. */
export function evaluateCriteria(contract: Contract, ctx: EvaluationContext): CriterionResult[] {
  return contract.criteria
    .filter((c) => c.required)
    .map((c) => {
      const items = contract.evidence.filter((e) => e.criterionId === c.id);
      if (items.length === 0) return { criterionId: c.id, status: 'missing', evidenceIds: [], evidence: [], failedPredicates: [] };
      const details = items.map((e) => evidenceDetail(e, contract, ctx));
      const statuses = details.map((d) => d.status);
      const worst = SEVERITY.find((s) => statuses.includes(s));
      // Any contradictory item blocks, even when another item is satisfied.
      const status: CriterionStatus =
        statuses.includes('conflicting') ? 'conflicting'
        : statuses.includes('satisfied') ? 'satisfied'
        : (worst ?? 'missing');
      const failed = new Set<PredicateKind>();
      for (const d of details) {
        if (d.status === 'unmet') d.predicates.filter((p) => !p.ok).forEach((p) => failed.add(p.kind));
      }
      return {
        criterionId: c.id,
        status,
        evidenceIds: items.map((e) => e.id),
        evidence: details.slice(0, MAX_DETAIL_EVIDENCE),
        failedPredicates: status === 'unmet' ? [...failed] : [],
      };
    });
}

/** Evidence-side blockers only (used for VERIFY, before acknowledgement exists). */
export function evidenceBlockers(contract: Contract, ctx: EvaluationContext): string[] {
  const blockers: string[] = [];
  const results = evaluateCriteria(contract, ctx);
  if (results.length === 0) blockers.push('NO_REQUIRED_CRITERIA');
  for (const r of results) {
    if (r.status !== 'satisfied') blockers.push(`CRITERION_${r.status}:${r.criterionId}`);
    for (const k of r.failedPredicates) blockers.push(`PREDICATE_FAILED:${r.criterionId}:${k}`);
  }
  return blockers;
}

/**
 * canFulfill = confirmed && every required criterion satisfied &&
 *              acknowledgement granted for the CURRENT contract version.
 */
export function evaluateFulfillment(contract: Contract, ctx: EvaluationContext): FulfillmentDecision {
  const blockers: string[] = [];
  if (contract.lifecycle === 'DRAFT' || contract.confirmedVersion !== contract.version) {
    blockers.push('NOT_CONFIRMED');
  }
  blockers.push(...evidenceBlockers(contract, ctx));
  const ack = contract.acknowledgement;
  if (!ack) blockers.push('ACK_MISSING');
  else if (ack.decision !== 'GRANTED') blockers.push('ACK_DENIED');
  else if (ack.atContractVersion !== contract.version) blockers.push('ACK_STALE');
  return {
    canFulfill: blockers.length === 0,
    criteria: evaluateCriteria(contract, ctx),
    blockers,
  };
}

/**
 * A FULFILLED promise whose proof no longer holds needs a human to look at it. Pure and derived:
 * it never reopens or edits anything.
 */
export function reviewRequired(contract: Contract, ctx: EvaluationContext): { required: boolean; reasons: string[] } {
  if (contract.lifecycle !== 'FULFILLED') return { required: false, reasons: [] };
  const d = evaluateFulfillment(contract, ctx);
  return { required: !d.canFulfill, reasons: d.canFulfill ? [] : d.blockers };
}

/** Content-free record of WHY a decision was allowed or refused (keys, revisions, booleans only). */
export function buildDecisionReport(contract: Contract, ctx: EvaluationContext): DecisionReport {
  const d = evaluateFulfillment(contract, ctx);
  return {
    at: ctx.now,
    contractVersion: contract.version,
    canFulfill: d.canFulfill,
    blockers: d.blockers.slice(0, 30),
    criteria: d.criteria.map((c) => ({
      criterionId: c.criterionId,
      status: c.status,
      evidence: c.evidence.map((e) => {
        const ev = contract.evidence.find((x) => x.id === e.id);
        return {
          id: e.id,
          sourceRef: ev?.sourceRef ?? '',
          reviewStatus: ev?.reviewStatus ?? 'PENDING',
          status: e.status,
          observedRevision: ev ? ctx.sourceChecks[ev.sourceRef]?.revision : undefined,
          predicates: e.predicates.map((p) => ({ kind: p.kind, ok: p.ok })),
        };
      }),
    })),
  };
}
