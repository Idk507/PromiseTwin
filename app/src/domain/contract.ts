import { z } from 'zod';

// Canonical commitment contract (docs/03-DATA-CONTRACTS.md). Pure types only:
// no Forge imports, so everything here is unit-testable offline.

export const LIFECYCLE = [
  'DRAFT',
  'CONFIRMED',
  'IN_PROGRESS',
  'DELIVERED',
  'VERIFIED',
  'ACKNOWLEDGED',
  'FULFILLED',
] as const;
export type Lifecycle = (typeof LIFECYCLE)[number];

export const MAX_CRITERIA = 20;
export const MAX_EVIDENCE = 100;
export const MAX_APPLIED_EVENT_IDS = 50;
export const MAX_LINKED_WORK = 10;

const isoTime = z.iso.datetime({ offset: true });
const shortText = z.string().min(1).max(500);

/** Roles are resolved by the server from verified context; never from the client. */
// SYSTEM is NEVER resolvable from a user: it exists only for server-side event/reconcile code and
// may run exactly one command (OBSERVE_LINKED_WORK).
// CONTRIBUTOR (engineering contributor): may attach delivery evidence and nothing else.
// APPROVER is derived from Jira project administration, never assigned in the app.
export const roleSchema = z.enum(['AGENT', 'CONTRIBUTOR', 'REVIEWER', 'ACKNOWLEDGER', 'APPROVER', 'SYSTEM']);
export type Role = z.infer<typeof roleSchema>;
/** Roles a project administrator may assign to a user. Default is no role = read-only. */
export const ASSIGNABLE_ROLES = ['AGENT', 'CONTRIBUTOR', 'REVIEWER', 'ACKNOWLEDGER'] as const satisfies readonly Role[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const MAX_PREDICATES = 5;
// Jira labels cannot contain spaces; this closed pattern also keeps values safe to compare/log.
const LABEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/**
 * Machine-checkable conditions on an EVIDENCE issue, evaluated by the server against facts it reads
 * as the acting user at decision time. A closed set: no free-form expressions, no scripting.
 */
export const predicateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('STATUS_CATEGORY_IS'), value: z.enum(['new', 'indeterminate', 'done']) }),
  z.object({ kind: z.literal('RESOLUTION_SET') }),
  z.object({ kind: z.literal('HAS_LABEL'), value: z.string().regex(LABEL_VALUE) }),
  // Binds the evidence to THIS promise's customer: label is derived from the contract, not typed.
  z.object({ kind: z.literal('CUSTOMER_LABEL') }),
  // The evidence issue must be linked (any link type) to this promise's source request.
  z.object({ kind: z.literal('LINKED_TO_SOURCE') }),
]);
export type Predicate = z.infer<typeof predicateSchema>;
export type PredicateKind = Predicate['kind'];

export const criterionSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(['LINKED_WORK', 'ARTIFACT', 'CUSTOMER_CONFIRMATION', 'MANUAL_REVIEW']),
  description: shortText,
  required: z.boolean(),
  // Defaults to [] so contracts stored before P3 still validate (their criteria are unchanged).
  predicates: z.array(predicateSchema).max(MAX_PREDICATES).default([]),
});
export type Criterion = z.infer<typeof criterionSchema>;

/**
 * POLICY (P3 review): every REQUIRED criterion of a NEW or AMENDED promise must bind its evidence to
 * the customer and to the promised request. This stops a promise creator from choosing "no checks".
 * Enforced where clients create or amend (service boundary). Criteria already stored from P1/P2 stay
 * valid and are still evaluated as written. Optional criteria never gate fulfilment, so are exempt.
 */
export const MINIMUM_PROOF: readonly PredicateKind[] = ['CUSTOMER_LABEL', 'LINKED_TO_SOURCE'];
export function missingMinimumProof(criteria: ReadonlyArray<Pick<Criterion, 'id' | 'required' | 'predicates'>>): string[] {
  return criteria
    .filter((c) => c.required)
    .flatMap((c) => MINIMUM_PROOF.filter((k) => !c.predicates.some((p) => p.kind === k)).map((k) => `${c.id}:${k}`));
}

/** What a caller may supply when adding evidence. Review fields are server-controlled. */
export const evidenceInputSchema = z.object({
  id: z.string().min(1).max(64),
  criterionId: z.string().min(1).max(64),
  sourceType: z.enum(['JIRA_ISSUE', 'JSM_REQUEST', 'CONFLUENCE_PAGE', 'EXTERNAL_LINK']),
  sourceRef: shortText,
  customerReference: shortText,
  observedAt: isoTime,
  expiresAt: isoTime.optional(),
  sourceRevision: z.string().min(1).max(128),
});
export type EvidenceInput = z.infer<typeof evidenceInputSchema>;

export const evidenceSchema = evidenceInputSchema.extend({
  contractVersion: z.number().int().positive(),
  addedBy: z.string().min(1),
  // Unknown evidence is PENDING and can never count as valid.
  reviewStatus: z.enum(['PENDING', 'VALID', 'INVALID']),
  reviewedBy: z.string().min(1).optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

/**
 * App-owned link from a promise to a Jira work item. Minimal data only: no summary/description.
 * A snapshot of linked work is OBSERVATION, never evidence: it cannot satisfy a criterion.
 */
export const linkedWorkSchema = z.object({
  issueId: z.string().regex(/^\d{1,20}$/),
  issueKey: z.string().regex(/^[A-Z][A-Z0-9_]{1,30}-\d{1,9}$/),
  statusCategory: z.string().min(1).max(32),
  statusName: z.string().min(1).max(100),
  /** Jira `updated` of the linked issue when last observed (ordering token for observations). */
  observedUpdated: z.string().min(10).max(40),
  linkedAt: isoTime,
  linkedBy: z.string().min(1),
});
export type LinkedWork = z.infer<typeof linkedWorkSchema>;

export const acknowledgementSchema = z.object({
  byAccountId: z.string().min(1),
  atContractVersion: z.number().int().positive(),
  decision: z.enum(['GRANTED', 'DENIED']),
  decidedAt: isoTime,
});
export type Acknowledgement = z.infer<typeof acknowledgementSchema>;

export const contractSchema = z.object({
  id: z.string().min(1).max(64),
  tenantId: z.string().min(1),
  customerReference: shortText,
  source: z.object({
    product: z.enum(['JSM', 'JIRA']),
    site: z.string().min(1),
    issueId: z.string().min(1),
    issueKey: z.string().min(1),
  }),
  ownerAccountId: z.string().min(1),
  promiseText: z.string().min(1).max(2000),
  acceptedAt: isoTime.optional(),
  dueAt: isoTime.optional(),
  criteria: z.array(criterionSchema).max(MAX_CRITERIA),
  evidence: z.array(evidenceSchema).max(MAX_EVIDENCE),
  // Defaults to [] so contracts stored before P2 still validate.
  linkedWork: z.array(linkedWorkSchema).max(MAX_LINKED_WORK).default([]),
  acknowledgement: acknowledgementSchema.optional(),
  lifecycle: z.enum(LIFECYCLE),
  atRisk: z.boolean(),
  // `version` = version of the accepted TERMS (bumps on criteria amendment).
  // `revision` = optimistic-concurrency counter (bumps on EVERY mutation).
  version: z.number().int().positive(),
  revision: z.number().int().positive(),
  confirmedVersion: z.number().int().positive().optional(),
  fulfilledAt: isoTime.optional(),
  fulfillmentHistory: z
    .array(z.object({ fulfilledAt: isoTime, endedAt: isoTime, reason: shortText }))
    .max(20),
  appliedEventIds: z.array(z.string().min(1)).max(MAX_APPLIED_EVENT_IDS),
  createdAt: isoTime,
  updatedAt: isoTime,
});
export type Contract = z.infer<typeof contractSchema>;

export const createContractInputSchema = z.object({
  customerReference: shortText,
  source: contractSchema.shape.source,
  promiseText: contractSchema.shape.promiseText,
  dueAt: isoTime.optional(),
  criteria: z.array(criterionSchema).min(1).max(MAX_CRITERIA),
});
export type CreateContractInput = z.infer<typeof createContractInputSchema>;

/** Bounded, content-free explanation of a verification decision: keys, revisions, booleans only. */
export interface DecisionReport {
  at: string;
  contractVersion: number;
  canFulfill: boolean;
  blockers: string[];
  criteria: Array<{
    criterionId: string;
    status: string;
    evidence: Array<{
      id: string;
      sourceRef: string;
      reviewStatus: string;
      status: string;
      /** Revision of the source as observed NOW by the acting user (undefined if unreadable). */
      observedRevision?: string;
      predicates: Array<{ kind: string; ok: boolean }>;
    }>;
  }>;
}

/** Immutable, append-only audit record emitted by every applied mutation. */
export interface AuditEvent {
  id: string;
  tenantId: string;
  contractId: string;
  type: string;
  actorAccountId: string;
  actorRoles: Role[];
  authorization: 'ALLOWED';
  fromLifecycle: Lifecycle;
  toLifecycle: Lifecycle;
  atRevision: number;
  at: string;
  reason?: string;
  /** Present on VERIFY / ACKNOWLEDGE / FULFILL: why the decision was allowed or refused. */
  report?: DecisionReport;
}
