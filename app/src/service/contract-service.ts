import { z } from 'zod';
import {
  ASSIGNABLE_ROLES,
  missingMinimumProof,
  criterionSchema,
  createContractInputSchema,
  type AuditEvent,
  type Contract,
  type Role,
} from '../domain/contract';
import {
  ALLOWED_ROLES,
  applyCommand,
  availableCommands,
  createContract,
  type Command,
  type CommandType,
  type RefusalCode,
} from '../domain/lifecycle';
import {
  customerLabel,
  evaluateFulfillment,
  reviewRequired,
  type EvaluationContext,
  type FulfillmentDecision,
  type SourceCheck,
} from '../domain/verification';
import type { Clock, ContractRepository, IdGen, JiraPort, LinkIndex, RoleChange, RoleStore } from './ports';
import type { LinkedWorkSync } from './linked-work-sync';
import { resolveRoles } from './roles';

// Orchestrates one request: resolve identity -> authorize -> load -> decide (pure domain) -> persist.
// Everything the client sends is untrusted; tenant, account and issue come from Forge context.

/** Identity facts supplied by Forge itself (req.context), never by the client payload. */
export interface RequestContext {
  tenantId: string; // cloudId
  accountId: string;
  issueKey: string;
}

export type ServiceRefusal =
  | RefusalCode
  | 'ISSUE_NOT_ACCESSIBLE'
  | 'SOURCE_NOT_ACCESSIBLE'
  | 'NOT_FOUND'
  | 'FORBIDDEN';

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; code: ServiceRefusal; detail?: string[] };

export interface ContractView {
  /** FULFILLED promises whose proof no longer holds, with reasons (derived; changes nothing). */
  reviewRequired: { required: boolean; reasons: string[] };
  /** The Jira label an evidence issue must carry for CUSTOMER_LABEL predicates (shown to users). */
  requiredCustomerLabel: string | undefined;
  /** Linked work the VIEWING user cannot read is removed from this copy (see `hiddenLinks`). */
  contract: Contract;
  hiddenLinks: number;
  decision: FulfillmentDecision;
  available: CommandType[];
  audit: AuditEvent[];
}

/** Portfolio request identity: all three values come from Forge context, never from the payload. */
export interface PortfolioContext {
  tenantId: string;
  accountId: string;
  projectKey: string;
}

export interface PortfolioRow {
  id: string;
  issueKey: string;
  customerReference: string;
  promiseText: string;
  lifecycle: Contract['lifecycle'];
  atRisk: boolean;
  updatedAt: string;
  evidence: { valid: number; pending: number; invalid: number };
  /** 'unchecked' when the per-request Jira read budget ran out before this FULFILLED promise could be checked. */
  reviewRequired: 'yes' | 'no' | 'unchecked';
  /** Commands the viewer's assigned roles allow in the current state (guidance; the server re-checks every command). */
  available: CommandType[];
  needsMyAction: boolean;
}

export interface Portfolio {
  projectKey: string;
  myRoles: Role[];
  rows: PortfolioRow[];
  /** Promises in this project whose source issue the viewer cannot read (count only). */
  hidden: number;
  scanned: number;
  /** Present when more contracts may follow; pass it back to continue. */
  nextCursor: string | undefined;
}

export const PORTFOLIO_PAGE_SIZE = 25;
export const PORTFOLIO_SCAN_LIMIT = 100;
export const PORTFOLIO_MAX_JIRA_READS = 50;
const PORTFOLIO_FETCH = 25;
const PORTFOLIO_PROGRESS = new Set<CommandType>(['CONFIRM', 'START', 'MARK_DELIVERED', 'VERIFY', 'ACKNOWLEDGE', 'FULFILL']);
const OVER_BUDGET = Symbol('over-budget');
const projectKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,30}$/);
const cursorSchema = z.string().regex(/^[A-Za-z0-9_#:-]{1,300}$/);

const MAX_SOURCE_CHECKS = 20;
/** Bounds fan-out: each contract view can trigger up to MAX_SOURCE_CHECKS Jira reads. */
export const MAX_CONTRACTS_PER_ISSUE = 20;
const issueKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,30}-\d{1,9}$/);
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

const common = {
  contractId: idSchema,
  eventId: idSchema,
  expectedRevision: z.number().int().positive(),
};

/** Shape of client commands. Server-controlled fields (actor, time, evidence ids/revisions) are absent. */
export const clientCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('CONFIRM') }),
  z.object({ ...common, type: z.literal('START') }),
  z.object({ ...common, type: z.literal('MARK_DELIVERED') }),
  z.object({ ...common, type: z.literal('VERIFY') }),
  z.object({ ...common, type: z.literal('FULFILL') }),
  z.object({ ...common, type: z.literal('ACKNOWLEDGE'), decision: z.enum(['GRANTED', 'DENIED']) }),
  z.object({ ...common, type: z.literal('REOPEN'), reason: z.string().min(1).max(500) }),
  z.object({ ...common, type: z.literal('SET_AT_RISK'), atRisk: z.boolean() }),
  z.object({
    ...common,
    type: z.literal('AMEND_CRITERIA'),
    criteria: z.array(criterionSchema).min(1).max(20),
    reason: z.string().min(1).max(500),
  }).superRefine((v, ctx) => {
    // Amendments cannot weaken proof below the minimum either.
    for (const m of missingMinimumProof(v.criteria)) {
      ctx.addIssue({ code: 'custom', path: ['criteria', 'MINIMUM_PROOF_REQUIRED', m], message: 'minimum proof required' });
    }
  }),
  z.object({
    ...common,
    type: z.literal('ADD_EVIDENCE'),
    criterionId: z.string().min(1).max(64),
    sourceRef: issueKeySchema,
  }),
  z.object({ ...common, type: z.literal('LINK_WORK'), issueKey: issueKeySchema }),
  z.object({ ...common, type: z.literal('UNLINK_WORK'), issueKey: issueKeySchema }),
  z.object({
    ...common,
    type: z.literal('REVIEW_EVIDENCE'),
    evidenceId: z.string().min(1).max(64),
    status: z.enum(['VALID', 'INVALID']),
  }),
]);

/**
 * Client payload for creating a contract. `source` is derived server-side from the issue.
 * `requestId` is an idempotency key and becomes the contract id: a retried or double-clicked
 * create returns the same contract instead of making a duplicate.
 */
export const clientCreateSchema = createContractInputSchema
  .omit({ source: true })
  .extend({ requestId: idSchema })
  .superRefine((v, ctx) => {
    // Policy: no promise may be created with evidence that is not bound to the customer and request.
    for (const m of missingMinimumProof(v.criteria)) {
      ctx.addIssue({ code: 'custom', path: ['criteria', 'MINIMUM_PROOF_REQUIRED', m], message: 'minimum proof required' });
    }
  });

export interface Deps {
  repo: ContractRepository;
  jira: JiraPort;
  clock: Clock;
  ids: IdGen;
  index: LinkIndex;
  sync: LinkedWorkSync;
  roles: RoleStore;
}

/** What the roles panel shows. Assignments and history are only returned to project admins. */
export interface RoleAdminView {
  projectKey: string;
  canAdminister: boolean;
  myRoles: Role[];
  assignments?: Array<{ accountId: string; roles: Role[] }>;
  history?: RoleChange[];
}

const MAX_ROLE_ASSIGNMENTS = 200;
const setRolesSchema = z.object({
  accountId: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/),
  roles: z.array(z.enum(ASSIGNABLE_ROLES)).max(ASSIGNABLE_ROLES.length),
});

export class ContractService {
  /** Per-instance (= per request) memo so each source issue is read from Jira at most once. */
  private readonly metaCache = new Map<string, ReturnType<JiraPort['getIssueMeta']>>();

  constructor(private readonly d: Deps) {}

  private issueMeta(key: string) {
    let p = this.metaCache.get(key);
    if (!p) {
      p = this.d.jira.getIssueMeta(key);
      this.metaCache.set(key, p);
    }
    return p;
  }

  /** Resolves the acting user's roles and the issue. Refuses if the issue is not readable by them. */
  private async identify(ctx: RequestContext) {
    const parsedKey = issueKeySchema.safeParse(ctx.issueKey);
    if (!parsedKey.success) return undefined;
    const issue = await this.issueMeta(ctx.issueKey);
    if (!issue) return undefined;
    const perms = await this.d.jira.getPermissions(ctx.issueKey);
    const projectKey = ctx.issueKey.split('-')[0]!;
    const assigned = await this.d.roles.get(ctx.tenantId, projectKey, ctx.accountId);
    const roles = resolveRoles(perms, assigned);
    return { issue, roles, perms, projectKey };
  }

  /** The caller's effective roles; project admins also see the assignments and change history. */
  async roleAdmin(ctx: RequestContext): Promise<ServiceResult<RoleAdminView>> {
    const who = await this.identify(ctx);
    if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
    const view: RoleAdminView = { projectKey: who.projectKey, canAdminister: who.perms.administerProject, myRoles: who.roles };
    if (who.perms.administerProject) {
      view.assignments = await this.d.roles.list(ctx.tenantId, who.projectKey);
      view.history = await this.d.roles.history(ctx.tenantId, who.projectKey, 20);
    }
    return { ok: true, value: view };
  }

  /**
   * Assigns (or clears) a user's roles for this project. ONLY Jira project administrators, checked
   * server-side as the acting user. Roles are limited to the assignable set; APPROVER and SYSTEM can
   * never be assigned. Every change is recorded in an append-only log.
   */
  async setRoles(ctx: RequestContext, raw: unknown): Promise<ServiceResult<RoleAdminView>> {
    const who = await this.identify(ctx);
    if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
    if (!who.perms.administerProject) return { ok: false, code: 'FORBIDDEN' };
    const parsed = setRolesSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: 'INVALID_INPUT', detail: parsed.error.issues.map((i) => i.path.join('.')) };
    const { accountId, roles } = parsed.data;
    if (roles.length > 0) {
      const existing = await this.d.roles.list(ctx.tenantId, who.projectKey);
      const isNew = !existing.some((e) => e.accountId === accountId);
      if (isNew && existing.length >= MAX_ROLE_ASSIGNMENTS) return { ok: false, code: 'PRECONDITION_FAILED', detail: ['ROLE_ASSIGNMENT_LIMIT'] };
    }
    await this.d.roles.set(ctx.tenantId, who.projectKey, accountId, [...new Set(roles)], ctx.accountId, this.d.clock.now());
    return this.roleAdmin(ctx);
  }

  /** Re-reads each evidence source AS THE ACTING USER; bounded; absent entry means fail closed. */
  private async sourceChecks(contract: Contract): Promise<Record<string, SourceCheck>> {
    const checks: Record<string, SourceCheck> = {};
    const refs = [...new Set(contract.evidence.map((e) => e.sourceRef))].slice(0, MAX_SOURCE_CHECKS);
    for (const ref of refs) {
      const e = contract.evidence.find((x) => x.sourceRef === ref)!;
      // P1 can only re-verify Jira issues; any other source type gets no check => unauthorized.
      if (e.sourceType !== 'JIRA_ISSUE' && e.sourceType !== 'JSM_REQUEST') continue;
      if (!issueKeySchema.safeParse(ref).success) continue;
      const meta = await this.issueMeta(ref);
      checks[ref] = meta ? { accessible: true, revision: meta.revision, facts: meta.facts } : { accessible: false };
    }
    return checks;
  }

  /** Drops linked work the viewing user cannot read themselves (data minimization). */
  private async visibleLinks(contract: Contract): Promise<{ contract: Contract; hidden: number }> {
    const kept: Contract['linkedWork'] = [];
    for (const l of contract.linkedWork) {
      const meta = await this.issueMeta(l.issueKey);
      if (meta) kept.push(l);
    }
    return { contract: { ...contract, linkedWork: kept }, hidden: contract.linkedWork.length - kept.length };
  }

  /**
   * Decision reports list evidence issue keys, revisions and per-check results. Entries for
   * evidence issues the VIEWING user cannot read are removed from that viewer's copy, so a report
   * can never reveal facts (e.g. "is Done", "has customer label") about a hidden issue.
   */
  private async redactReports(audit: AuditEvent[]): Promise<AuditEvent[]> {
    const refs = [...new Set(audit.flatMap((a) => a.report?.criteria.flatMap((c) => c.evidence.map((e) => e.sourceRef)) ?? []))].slice(0, MAX_SOURCE_CHECKS);
    const readable = new Set<string>();
    for (const ref of refs) {
      if (issueKeySchema.safeParse(ref).success && (await this.issueMeta(ref))) readable.add(ref);
    }
    return audit.map((a) =>
      a.report
        ? { ...a, report: { ...a.report, criteria: a.report.criteria.map((c) => ({ ...c, evidence: c.evidence.filter((e) => readable.has(e.sourceRef)) })) } }
        : a
    );
  }

  private async view(contract: Contract, roles: Role[]): Promise<ContractView> {
    const ctx: EvaluationContext = { now: this.d.clock.now(), sourceChecks: await this.sourceChecks(contract) };
    const shown = await this.visibleLinks(contract);
    return {
      contract: shown.contract,
      hiddenLinks: shown.hidden,
      reviewRequired: reviewRequired(contract, ctx),
      requiredCustomerLabel: customerLabel(contract.customerReference),
      decision: evaluateFulfillment(contract, ctx),
      available: availableCommands(contract, roles),
      audit: await this.redactReports(await this.d.repo.listAudit(contract.tenantId, contract.id, 20)),
    };
  }

  async list(ctx: RequestContext): Promise<ServiceResult<ContractView[]>> {
    const who = await this.identify(ctx);
    if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
    const contracts = (await this.d.repo.listByIssue(ctx.tenantId, who.issue.id)).slice(0, MAX_CONTRACTS_PER_ISSUE);
    return { ok: true, value: await Promise.all(contracts.map((c) => this.view(c, who.roles))) };
  }

  /**
   * Project portfolio: one row per promise the VIEWER may see in this project, newest storage key
   * first-come, bounded on every axis (rows per page, contracts scanned, Jira reads). A promise is
   * listed only if the viewing user can read its source issue (checked as that user), so the list
   * can never reveal a promise on an issue the viewer cannot open; unreadable ones are counted,
   * never described. `ctx.projectKey` must come from Forge context, never from the client.
   * Rows carry stored facts only (no evidence keys, no Jira content); the detail view stays the
   * place for live proof status.
   */
  async portfolio(ctx: PortfolioContext, rawCursor?: unknown): Promise<ServiceResult<Portfolio>> {
    if (!projectKeySchema.safeParse(ctx.projectKey).success) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
    const cursor = rawCursor === undefined || rawCursor === null || rawCursor === '' ? undefined : rawCursor;
    if (cursor !== undefined && (typeof cursor !== 'string' || !cursorSchema.safeParse(cursor).success || !cursor.startsWith(`${ctx.tenantId}#`))) {
      return { ok: false, code: 'INVALID_INPUT', detail: ['cursor'] };
    }
    // Roles used for "needs my action": roles assigned in this project. APPROVER (derived from Jira
    // admin) is not looked up here because it needs a per-issue permission call and grants no
    // progress step; the detail view still uses the full set.
    const assigned = await this.d.roles.get(ctx.tenantId, ctx.projectKey, ctx.accountId);
    const budget = { left: PORTFOLIO_MAX_JIRA_READS };
    const rows: PortfolioRow[] = [];
    let hidden = 0;
    let scanned = 0;
    let after = cursor as string | undefined;
    let more = false;

    scan: for (;;) {
      if (scanned >= PORTFOLIO_SCAN_LIMIT) { more = true; break; }
      const page = await this.d.repo.listPage(ctx.tenantId, after, PORTFOLIO_FETCH);
      if (page.length === 0) break;
      for (const item of page) {
        if (rows.length >= PORTFOLIO_PAGE_SIZE || scanned >= PORTFOLIO_SCAN_LIMIT) { more = true; break scan; }
        const c = item.contract;
        if (c.tenantId !== ctx.tenantId || !c.source.issueKey.startsWith(`${ctx.projectKey}-`)) {
          scanned++; after = item.key; continue; // other project: not ours, not counted as hidden
        }
        const meta = await this.readBudgeted(c.source.issueKey, budget);
        if (meta === OVER_BUDGET) { more = true; break scan; } // resume at this contract next time
        scanned++; after = item.key;
        if (!meta) { hidden++; continue; }
        rows.push(await this.portfolioRow(c, assigned, budget));
      }
      if (page.length < PORTFOLIO_FETCH) break;
    }
    return { ok: true, value: { projectKey: ctx.projectKey, myRoles: assigned, rows, hidden, scanned, nextCursor: more ? after : undefined } };
  }

  /** One Jira read as the viewer, at most `budget.left` of them per request; memoized reads are free. */
  private async readBudgeted(key: string, budget: { left: number }): Promise<Awaited<ReturnType<JiraPort['getIssueMeta']>> | typeof OVER_BUDGET> {
    const cached = this.metaCache.get(key);
    if (cached) return cached;
    if (budget.left <= 0) return OVER_BUDGET;
    budget.left--;
    return this.issueMeta(key);
  }

  private async portfolioRow(c: Contract, roles: Role[], budget: { left: number }): Promise<PortfolioRow> {
    const available = availableCommands(c, roles);
    const count = (s: string) => c.evidence.filter((e) => e.reviewStatus === s).length;
    const evidence = { valid: count('VALID'), pending: count('PENDING'), invalid: count('INVALID') };
    // Review-required only concerns FULFILLED promises, and needs the evidence sources re-read
    // as the viewer; skip (and say so) when the read budget is spent instead of guessing.
    let review: PortfolioRow['reviewRequired'] = 'no';
    if (c.lifecycle === 'FULFILLED') {
      const checks: Record<string, SourceCheck> = {};
      let complete = true;
      for (const ref of [...new Set(c.evidence.map((e) => e.sourceRef))].slice(0, MAX_SOURCE_CHECKS)) {
        const e = c.evidence.find((x) => x.sourceRef === ref)!;
        if ((e.sourceType !== 'JIRA_ISSUE' && e.sourceType !== 'JSM_REQUEST') || !issueKeySchema.safeParse(ref).success) continue;
        const meta = await this.readBudgeted(ref, budget);
        if (meta === OVER_BUDGET) { complete = false; break; }
        checks[ref] = meta ? { accessible: true, revision: meta.revision, facts: meta.facts } : { accessible: false };
      }
      review = complete ? (reviewRequired(c, { now: this.d.clock.now(), sourceChecks: checks }).required ? 'yes' : 'no') : 'unchecked';
    }
    const needsMyAction =
      available.some((t) => PORTFOLIO_PROGRESS.has(t)) ||
      (available.includes('REVIEW_EVIDENCE') && evidence.pending > 0) ||
      (review === 'yes' && available.includes('REOPEN'));
    return {
      id: c.id, issueKey: c.source.issueKey, customerReference: c.customerReference, promiseText: c.promiseText,
      lifecycle: c.lifecycle, atRisk: c.atRisk, updatedAt: c.updatedAt, evidence, reviewRequired: review, available, needsMyAction,
    };
  }

  async create(ctx: RequestContext, rawInput: unknown): Promise<ServiceResult<ContractView>> {
    const who = await this.identify(ctx);
    if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
    const input = clientCreateSchema.safeParse(rawInput);
    if (!input.success) return { ok: false, code: 'INVALID_INPUT', detail: input.error.issues.map((i) => i.path.join('.')) };
    // Idempotent create: `get` is strongly consistent. Same requester + same id = replay.
    const replay = await this.d.repo.get(ctx.tenantId, who.issue.id, input.data.requestId);
    if (replay) {
      if (replay.ownerAccountId !== ctx.accountId) return { ok: false, code: 'VERSION_CONFLICT' };
      return { ok: true, value: await this.view(replay, who.roles) };
    }
    // Cap per issue. Storage listing is eventually consistent, so the cap is approximate by design.
    const existing = await this.d.repo.listByIssue(ctx.tenantId, who.issue.id);
    if (existing.length >= MAX_CONTRACTS_PER_ISSUE) {
      return { ok: false, code: 'PRECONDITION_FAILED', detail: ['CONTRACT_LIMIT'] };
    }
    const now = this.d.clock.now();
    const created = createContract(
      { ...input.data, source: { product: 'JIRA', site: ctx.tenantId, issueId: who.issue.id, issueKey: who.issue.key } },
      { id: input.data.requestId, tenantId: ctx.tenantId, ownerAccountId: ctx.accountId, actor: { accountId: ctx.accountId, roles: who.roles }, at: now }
    );
    if (!created.ok) return { ok: false, code: created.code, detail: created.detail };
    if (created.duplicate) return { ok: false, code: 'INVALID_INPUT' };
    await this.d.repo.create(created.contract, created.event);
    return { ok: true, value: await this.view(created.contract, who.roles) };
  }

  async apply(ctx: RequestContext, rawCommand: unknown): Promise<ServiceResult<ContractView>> {
    const who = await this.identify(ctx);
    if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
    const parsed = clientCommandSchema.safeParse(rawCommand);
    if (!parsed.success) return { ok: false, code: 'INVALID_INPUT', detail: parsed.error.issues.map((i) => i.path.join('.')) };
    const p = parsed.data;

    // Refuse by role BEFORE any Jira reads: an unauthorized user must not trigger source lookups
    // (wasted calls, and a way to probe which issues exist). The domain re-checks regardless.
    if (!who.roles.some((r) => ALLOWED_ROLES[p.type].includes(r))) return { ok: false, code: 'UNAUTHORIZED_ACTOR' };

    // Scoped by tenant AND the panel's own issue: a contractId from elsewhere is "not found".
    const contract = await this.d.repo.get(ctx.tenantId, who.issue.id, p.contractId);
    if (!contract) return { ok: false, code: 'NOT_FOUND' };

    const now = this.d.clock.now();
    const base = {
      eventId: p.eventId,
      tenantId: ctx.tenantId,
      expectedRevision: p.expectedRevision,
      actor: { accountId: ctx.accountId, roles: who.roles },
      at: now,
    };

    let command: Command;
    if (p.type === 'ADD_EVIDENCE') {
      // Bind the proof to what the user can see RIGHT NOW: revision and time are server-observed.
      const meta = await this.issueMeta(p.sourceRef);
      if (!meta) return { ok: false, code: 'SOURCE_NOT_ACCESSIBLE' };
      command = {
        ...base,
        type: 'ADD_EVIDENCE',
        evidence: {
          id: this.d.ids.uuid(),
          criterionId: p.criterionId,
          sourceType: 'JIRA_ISSUE',
          sourceRef: meta.key,
          customerReference: contract.customerReference, // derived server-side, never client-declared
          observedAt: now,
          sourceRevision: meta.revision,
        },
      };
    } else if (p.type === 'LINK_WORK') {
      // The linking user must be able to read the work item NOW; the snapshot is server-observed.
      const meta = await this.issueMeta(p.issueKey);
      if (!meta) return { ok: false, code: 'SOURCE_NOT_ACCESSIBLE' };
      command = {
        ...base,
        type: 'LINK_WORK',
        link: { issueId: meta.id, issueKey: meta.key, statusCategory: meta.statusCategory, statusName: meta.statusName, observedUpdated: meta.revision },
      };
    } else if (p.type === 'UNLINK_WORK') {
      const existing = contract.linkedWork.find((l) => l.issueKey === p.issueKey);
      if (!existing) return { ok: false, code: 'INVALID_INPUT', detail: ['issueKey'] };
      command = { ...base, type: 'UNLINK_WORK', issueId: existing.issueId };
    } else {
      const { contractId: _c, eventId: _e, expectedRevision: _r, ...rest } = p;
      command = { ...base, ...rest } as Command;
    }

    const evalCtx: EvaluationContext = { now, sourceChecks: await this.sourceChecks(contract) };
    const result = applyCommand(contract, command, evalCtx);
    if (!result.ok) return { ok: false, code: result.code, detail: result.detail };
    if (result.duplicate) return { ok: true, value: await this.view(result.contract, who.roles) };

    const saved = await this.d.repo.save(result.contract, result.event, p.expectedRevision, who.issue.id);
    if (saved === 'CONFLICT') return { ok: false, code: 'VERSION_CONFLICT' };
    await this.maintainIndex(command, contract, who.issue.id);
    return { ok: true, value: await this.view(result.contract, who.roles) };
  }

  /**
   * The index is an optimization for event handling; the contract is the source of truth. A failed
   * index write must not fail the user's command: the reconciliation sweep re-adds missing rows.
   */
  private async maintainIndex(command: Command, contract: Contract, contractIssueId: string): Promise<void> {
    try {
      if (command.type === 'LINK_WORK') {
        const l = command.link as { issueId: string };
        await this.d.index.add(contract.tenantId, l.issueId, contractIssueId, contract.id);
      } else if (command.type === 'UNLINK_WORK') {
        await this.d.index.remove(contract.tenantId, command.issueId, contractIssueId, contract.id);
      }
    } catch {
      console.error('link index update failed; reconcile will repair');
    }
  }

  /** User-requested refresh of linked work for one promise; same code path as the hourly sweep. */
  async refresh(ctx: RequestContext, contractId: unknown): Promise<ServiceResult<ContractView>> {
    const who = await this.identify(ctx);
    if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
    if (who.roles.length === 0) return { ok: false, code: 'UNAUTHORIZED_ACTOR' };
    const id = idSchema.safeParse(contractId);
    if (!id.success) return { ok: false, code: 'INVALID_INPUT', detail: ['contractId'] };
    const existing = await this.d.repo.get(ctx.tenantId, who.issue.id, id.data);
    if (!existing) return { ok: false, code: 'NOT_FOUND' };
    await this.d.sync.refreshContract(ctx.tenantId, who.issue.id, id.data);
    const fresh = await this.d.repo.get(ctx.tenantId, who.issue.id, id.data);
    if (!fresh) return { ok: false, code: 'NOT_FOUND' };
    return { ok: true, value: await this.view(fresh, who.roles) };
  }
}
