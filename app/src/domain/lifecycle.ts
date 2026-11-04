import {
  MAX_APPLIED_EVENT_IDS,
  MAX_EVIDENCE,
  MAX_LINKED_WORK,
  contractSchema,
  linkedWorkSchema,
  createContractInputSchema,
  evidenceInputSchema,
  criterionSchema,
  type AuditEvent,
  type Contract,
  type CreateContractInput,
  type DecisionReport,
  type Lifecycle,
  type Role,
} from './contract';
import { buildDecisionReport, evaluateFulfillment, evidenceBlockers, type EvaluationContext } from './verification';
import { parseTimestamp } from './time';
import { z } from 'zod';

/** What the server observed about a linked Jira issue (never client-supplied). */
const observationSchema = z.object({
  issueId: z.string().regex(/^\d{1,20}$/),
  statusCategory: z.string().min(1).max(32),
  statusName: z.string().min(1).max(100),
  updated: z.string().min(10).max(40),
});

/** Server-resolved facts for a link (read as the acting user); `linkedAt`/`linkedBy` are added here. */
const linkInputSchema = linkedWorkSchema.omit({ linkedAt: true, linkedBy: true });

// Pure state machine: (contract, command) -> new contract + audit event, or a typed refusal.
// The caller (resolver) is responsible for resolving `actor.roles` from verified server-side
// context and for persisting atomically with a revision check (see repository).

export interface Actor {
  accountId: string;
  roles: Role[];
}

interface Base {
  /** Idempotency key: replaying the same eventId is a no-op, never a second transition. */
  eventId: string;
  tenantId: string;
  /** Optimistic concurrency: must equal contract.revision. */
  expectedRevision: number;
  actor: Actor;
  at: string;
}

export type Command = Base &
  (
    | { type: 'CONFIRM' }
    | { type: 'START' }
    | { type: 'MARK_DELIVERED' }
    | { type: 'VERIFY' }
    | { type: 'ACKNOWLEDGE'; decision: 'GRANTED' | 'DENIED' }
    | { type: 'FULFILL' }
    | { type: 'REOPEN'; reason: string }
    | { type: 'AMEND_CRITERIA'; criteria: unknown; reason: string }
    | { type: 'ADD_EVIDENCE'; evidence: unknown }
    | { type: 'REVIEW_EVIDENCE'; evidenceId: string; status: 'VALID' | 'INVALID' }
    | { type: 'SET_AT_RISK'; atRisk: boolean }
    | { type: 'LINK_WORK'; link: unknown }
    | { type: 'UNLINK_WORK'; issueId: string }
    // System-only: records what Jira says about linked work. Never advances the lifecycle.
    | { type: 'OBSERVE_LINKED_WORK'; observation: unknown }
  );
export type CommandType = Command['type'];

export type RefusalCode =
  | 'TENANT_MISMATCH'
  | 'VERSION_CONFLICT'
  | 'UNAUTHORIZED_ACTOR'
  | 'ILLEGAL_TRANSITION'
  | 'PRECONDITION_FAILED'
  | 'INVALID_INPUT';

export type Result =
  | { ok: true; duplicate: false; contract: Contract; event: AuditEvent }
  | { ok: true; duplicate: true; contract: Contract }
  | { ok: false; code: RefusalCode; detail?: string[] };

const refuse = (code: RefusalCode, detail?: string[]): Result => ({ ok: false, code, detail });

/** Roles allowed to issue each command. */
export const ALLOWED_ROLES: Record<CommandType, Role[]> = {
  CONFIRM: ['AGENT'],
  START: ['AGENT'],
  MARK_DELIVERED: ['AGENT'],
  VERIFY: ['REVIEWER'],
  ACKNOWLEDGE: ['ACKNOWLEDGER'],
  FULFILL: ['AGENT', 'REVIEWER'],
  REOPEN: ['REVIEWER', 'APPROVER'],
  AMEND_CRITERIA: ['APPROVER'],
  // An engineering CONTRIBUTOR may attach evidence but cannot review, verify or acknowledge anything.
  ADD_EVIDENCE: ['AGENT', 'CONTRIBUTOR', 'REVIEWER'],
  REVIEW_EVIDENCE: ['REVIEWER'],
  SET_AT_RISK: ['AGENT', 'REVIEWER'],
  LINK_WORK: ['AGENT'],
  UNLINK_WORK: ['AGENT'],
  OBSERVE_LINKED_WORK: ['SYSTEM'],
};

const EVIDENCE_STATES: Lifecycle[] = ['CONFIRMED', 'IN_PROGRESS', 'DELIVERED', 'VERIFIED'];
const REOPEN_STATES: Lifecycle[] = ['DELIVERED', 'VERIFIED', 'ACKNOWLEDGED', 'FULFILLED'];
const LINK_STATES: Lifecycle[] = ['DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'DELIVERED'];

/** Lifecycle states in which each command is legal (used for UI hints; applyCommand still enforces). */
const LEGAL_STATES: Record<CommandType, Lifecycle[]> = {
  CONFIRM: ['DRAFT'],
  START: ['CONFIRMED'],
  MARK_DELIVERED: ['IN_PROGRESS'],
  VERIFY: ['DELIVERED'],
  ACKNOWLEDGE: ['VERIFIED'],
  FULFILL: ['ACKNOWLEDGED'],
  REOPEN: REOPEN_STATES,
  AMEND_CRITERIA: ['DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'DELIVERED', 'VERIFIED', 'ACKNOWLEDGED', 'FULFILLED'],
  ADD_EVIDENCE: EVIDENCE_STATES,
  REVIEW_EVIDENCE: EVIDENCE_STATES,
  SET_AT_RISK: ['DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'DELIVERED', 'VERIFIED', 'ACKNOWLEDGED'],
  LINK_WORK: ['DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'DELIVERED'],
  UNLINK_WORK: ['DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'DELIVERED'],
  OBSERVE_LINKED_WORK: ['DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'DELIVERED', 'VERIFIED', 'ACKNOWLEDGED', 'FULFILLED'],
};

/** Commands this actor's roles may attempt in the contract's current state. Hint only, never authorization. */
export function availableCommands(contract: Contract, roles: Role[]): CommandType[] {
  return (Object.keys(LEGAL_STATES) as CommandType[]).filter(
    (t) => LEGAL_STATES[t].includes(contract.lifecycle) && roles.some((r) => ALLOWED_ROLES[t].includes(r))
  );
}
const REOPEN_FROM: Lifecycle[] = ['DELIVERED', 'VERIFIED', 'ACKNOWLEDGED', 'FULFILLED'];

/** Creates a DRAFT contract. Validates input at the boundary. */
export function createContract(
  input: unknown,
  meta: { id: string; tenantId: string; ownerAccountId: string; actor: Actor; at: string }
): Result {
  if (!meta.actor.roles.includes('AGENT')) return refuse('UNAUTHORIZED_ACTOR');
  const parsed = createContractInputSchema.safeParse(input);
  if (!parsed.success) return refuse('INVALID_INPUT', parsed.error.issues.map((i) => i.path.join('.')));
  const data: CreateContractInput = parsed.data;
  const contract: Contract = {
    id: meta.id,
    tenantId: meta.tenantId,
    customerReference: data.customerReference,
    source: data.source,
    ownerAccountId: meta.ownerAccountId,
    promiseText: data.promiseText,
    dueAt: data.dueAt,
    criteria: data.criteria,
    evidence: [],
    linkedWork: [],
    lifecycle: 'DRAFT',
    atRisk: false,
    version: 1,
    revision: 1,
    fulfillmentHistory: [],
    appliedEventIds: [],
    createdAt: meta.at,
    updatedAt: meta.at,
  };
  return {
    ok: true,
    duplicate: false,
    contract,
    event: audit(contract, 'CREATED', meta.actor, 'DRAFT', 'DRAFT', meta.at, `${meta.id}:created`),
  };
}

function audit(
  c: Contract,
  type: string,
  actor: Actor,
  from: Lifecycle,
  to: Lifecycle,
  at: string,
  id: string,
  reason?: string,
  report?: DecisionReport
): AuditEvent {
  return {
    id,
    tenantId: c.tenantId,
    contractId: c.id,
    type,
    actorAccountId: actor.accountId,
    actorRoles: [...actor.roles],
    authorization: 'ALLOWED',
    fromLifecycle: from,
    toLifecycle: to,
    atRevision: c.revision,
    at,
    reason,
    ...(report ? { report } : {}),
  };
}

/** Commands whose audit event records the full verification decision (J7: "why"). */
const REPORTED: CommandType[] = ['VERIFY', 'ACKNOWLEDGE', 'FULFILL'];

/** Applies one command. Never mutates its input. */
export function applyCommand(
  contract: Contract,
  cmd: Command,
  ctx: EvaluationContext
): Result {
  if (cmd.tenantId !== contract.tenantId) return refuse('TENANT_MISMATCH');
  // Idempotency first: a replayed event must not hit version/state checks and double-apply.
  if (contract.appliedEventIds.includes(cmd.eventId)) {
    return { ok: true, duplicate: true, contract };
  }
  if (cmd.expectedRevision !== contract.revision) return refuse('VERSION_CONFLICT');
  if (!cmd.actor.roles.some((r) => ALLOWED_ROLES[cmd.type].includes(r))) {
    return refuse('UNAUTHORIZED_ACTOR');
  }

  const from = contract.lifecycle;
  const next: Contract = {
    ...contract,
    revision: contract.revision + 1,
    updatedAt: cmd.at,
    appliedEventIds: [...contract.appliedEventIds, cmd.eventId].slice(-MAX_APPLIED_EVENT_IDS),
  };
  let reason: string | undefined;

  const wrongState = (allowed: Lifecycle[]) =>
    allowed.includes(from) ? undefined : refuse('ILLEGAL_TRANSITION', [`${cmd.type} from ${from}`]);

  switch (cmd.type) {
    case 'CONFIRM': {
      const bad = wrongState(['DRAFT']);
      if (bad) return bad;
      if (!contract.criteria.some((c) => c.required)) {
        return refuse('PRECONDITION_FAILED', ['NO_REQUIRED_CRITERIA']);
      }
      next.lifecycle = 'CONFIRMED';
      next.confirmedVersion = contract.version;
      next.acceptedAt = cmd.at;
      break;
    }
    case 'START': {
      const bad = wrongState(['CONFIRMED']);
      if (bad) return bad;
      next.lifecycle = 'IN_PROGRESS';
      break;
    }
    case 'MARK_DELIVERED': {
      const bad = wrongState(['IN_PROGRESS']);
      if (bad) return bad;
      next.lifecycle = 'DELIVERED';
      break;
    }
    case 'VERIFY': {
      const bad = wrongState(['DELIVERED']);
      if (bad) return bad;
      const blockers = evidenceBlockers(contract, ctx);
      if (blockers.length > 0) return refuse('PRECONDITION_FAILED', blockers);
      next.lifecycle = 'VERIFIED';
      break;
    }
    case 'ACKNOWLEDGE': {
      const bad = wrongState(['VERIFIED']);
      if (bad) return bad;
      // Separation of duties: whoever owns the promise cannot acknowledge its fulfilment.
      if (cmd.actor.accountId === contract.ownerAccountId) {
        return refuse('UNAUTHORIZED_ACTOR', ['SELF_ACKNOWLEDGE']);
      }
      // Evidence must still hold at acknowledgement time (it may have gone stale since VERIFY).
      const blockers = evidenceBlockers(contract, ctx);
      if (blockers.length > 0) return refuse('PRECONDITION_FAILED', blockers);
      next.acknowledgement = {
        byAccountId: cmd.actor.accountId,
        atContractVersion: contract.version,
        decision: cmd.decision,
        decidedAt: cmd.at,
      };
      // A denial is recorded but does not advance the lifecycle.
      if (cmd.decision === 'GRANTED') next.lifecycle = 'ACKNOWLEDGED';
      break;
    }
    case 'FULFILL': {
      const bad = wrongState(['ACKNOWLEDGED']);
      if (bad) return bad;
      const decision = evaluateFulfillment(contract, ctx);
      if (!decision.canFulfill) return refuse('PRECONDITION_FAILED', decision.blockers);
      next.lifecycle = 'FULFILLED';
      next.fulfilledAt = cmd.at;
      break;
    }
    case 'REOPEN': {
      const bad = wrongState(REOPEN_FROM);
      if (bad) return bad;
      const why = z.string().min(1).max(500).safeParse(cmd.reason);
      if (!why.success) return refuse('INVALID_INPUT', ['reason']);
      reason = why.data;
      // FULFILLED is history, never deleted: record the ended fulfilment, then reopen.
      if (contract.fulfilledAt) {
        next.fulfillmentHistory = [
          ...contract.fulfillmentHistory,
          { fulfilledAt: contract.fulfilledAt, endedAt: cmd.at, reason: why.data },
        ].slice(-20);
      }
      next.fulfilledAt = undefined;
      next.acknowledgement = undefined;
      next.lifecycle = 'IN_PROGRESS';
      break;
    }
    case 'AMEND_CRITERIA': {
      const crit = z.array(criterionSchema).min(1).safeParse(cmd.criteria);
      const why = z.string().min(1).max(500).safeParse(cmd.reason);
      if (!crit.success || !why.success) return refuse('INVALID_INPUT', ['criteria/reason']);
      if (!crit.data.some((c) => c.required)) {
        return refuse('PRECONDITION_FAILED', ['NO_REQUIRED_CRITERIA']);
      }
      reason = why.data;
      if (contract.fulfilledAt) {
        next.fulfillmentHistory = [
          ...contract.fulfillmentHistory,
          { fulfilledAt: contract.fulfilledAt, endedAt: cmd.at, reason: why.data },
        ].slice(-20);
      }
      // New terms: old proof goes stale via contractVersion, acknowledgement is voided,
      // and the terms must be re-confirmed.
      next.criteria = crit.data;
      next.version = contract.version + 1;
      next.confirmedVersion = undefined;
      next.acknowledgement = undefined;
      next.fulfilledAt = undefined;
      next.lifecycle = 'DRAFT';
      break;
    }
    case 'ADD_EVIDENCE': {
      const bad = wrongState(EVIDENCE_STATES);
      if (bad) return bad;
      const parsed = evidenceInputSchema.safeParse(cmd.evidence);
      if (!parsed.success) return refuse('INVALID_INPUT', parsed.error.issues.map((i) => i.path.join('.')));
      const e = parsed.data;
      if (!contract.criteria.some((c) => c.id === e.criterionId)) {
        return refuse('INVALID_INPUT', ['criterionId']);
      }
      if (contract.evidence.some((x) => x.id === e.id)) return refuse('INVALID_INPUT', ['id']);
      if (contract.evidence.length >= MAX_EVIDENCE) return refuse('PRECONDITION_FAILED', ['EVIDENCE_LIMIT']);
      // Callers cannot self-validate: new evidence is always PENDING.
      next.evidence = [
        ...contract.evidence,
        { ...e, contractVersion: contract.version, addedBy: cmd.actor.accountId, reviewStatus: 'PENDING' },
      ];
      break;
    }
    case 'REVIEW_EVIDENCE': {
      const bad = wrongState(EVIDENCE_STATES);
      if (bad) return bad;
      const target = contract.evidence.find((x) => x.id === cmd.evidenceId);
      if (!target) return refuse('INVALID_INPUT', ['evidenceId']);
      // Separation of duties: nobody validates their own submission.
      if (target.addedBy === cmd.actor.accountId) return refuse('UNAUTHORIZED_ACTOR', ['SELF_REVIEW']);
      next.evidence = contract.evidence.map((x) =>
        x.id === target.id ? { ...x, reviewStatus: cmd.status, reviewedBy: cmd.actor.accountId } : x
      );
      break;
    }
    case 'SET_AT_RISK': {
      next.atRisk = cmd.atRisk;
      break;
    }
    case 'LINK_WORK': {
      const bad = wrongState(LINK_STATES);
      if (bad) return bad;
      const parsed = linkInputSchema.safeParse(cmd.link);
      if (!parsed.success) return refuse('INVALID_INPUT', parsed.error.issues.map((i) => i.path.join('.')));
      const l = parsed.data;
      // Linking a promise to its own request would make "linked work" meaningless.
      if (l.issueId === contract.source.issueId) return refuse('INVALID_INPUT', ['SELF_LINK']);
      if (contract.linkedWork.some((x) => x.issueId === l.issueId)) return refuse('INVALID_INPUT', ['ALREADY_LINKED']);
      if (contract.linkedWork.length >= MAX_LINKED_WORK) return refuse('PRECONDITION_FAILED', ['LINK_LIMIT']);
      if (parseTimestamp(l.observedUpdated) === undefined) return refuse('INVALID_INPUT', ['observedUpdated']);
      next.linkedWork = [...contract.linkedWork, { ...l, linkedAt: cmd.at, linkedBy: cmd.actor.accountId }];
      break;
    }
    case 'UNLINK_WORK': {
      const bad = wrongState(LINK_STATES);
      if (bad) return bad;
      if (!contract.linkedWork.some((x) => x.issueId === cmd.issueId)) return refuse('INVALID_INPUT', ['issueId']);
      next.linkedWork = contract.linkedWork.filter((x) => x.issueId !== cmd.issueId);
      break;
    }
    case 'OBSERVE_LINKED_WORK': {
      const parsed = observationSchema.safeParse(cmd.observation);
      if (!parsed.success) return refuse('INVALID_INPUT', parsed.error.issues.map((i) => i.path.join('.')));
      const o = parsed.data;
      const current = contract.linkedWork.find((x) => x.issueId === o.issueId);
      if (!current) return refuse('PRECONDITION_FAILED', ['NOT_LINKED']);
      const newTime = parseTimestamp(o.updated);
      const oldTime = parseTimestamp(current.observedUpdated);
      // Unparseable time = cannot order = refuse (fail closed).
      if (newTime === undefined || oldTime === undefined) return refuse('INVALID_INPUT', ['updated']);
      // Out-of-order or repeated delivery: nothing changes, nothing is persisted.
      if (newTime <= oldTime) return { ok: true, duplicate: true, contract };
      next.linkedWork = contract.linkedWork.map((x) =>
        x.issueId === o.issueId
          ? { ...x, statusCategory: o.statusCategory, statusName: o.statusName, observedUpdated: o.updated }
          : x
      );
      // Regression of linked work flags risk. It never touches lifecycle, evidence or acknowledgement.
      if (current.statusCategory === 'done' && o.statusCategory !== 'done') next.atRisk = true;
      reason = `linked ${current.issueKey}: ${o.statusName}`;
      break;
    }
  }

  // Defence in depth: never emit a record that violates the schema.
  const checked = contractSchema.safeParse(next);
  if (!checked.success) return refuse('INVALID_INPUT', ['POST_STATE_INVALID']);

  return {
    ok: true,
    duplicate: false,
    contract: checked.data,
    event: audit(
      checked.data, cmd.type, cmd.actor, from, checked.data.lifecycle, cmd.at, cmd.eventId, reason,
      // Built from the state the decision was made ON (before this command), as seen by the actor now.
      REPORTED.includes(cmd.type) ? buildDecisionReport(contract, ctx) : undefined
    ),
  };
}
