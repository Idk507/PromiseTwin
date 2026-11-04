import type { AuditEvent, Contract, Role } from '../domain/contract';
import type { IssueFacts } from '../domain/verification';

// Ports isolate Forge/Jira so the service is testable offline with fakes.

/** Jira facts about the CURRENT USER, read via asUser (never asApp). */
export interface JiraPermissions {
  editIssues: boolean;
  administerProject: boolean;
}

export interface IssueMeta {
  id: string;
  key: string;
  /** Normalized revision of the source: Jira's `updated` timestamp for the issue. */
  revision: string;
  /** Jira status category key (e.g. "new", "indeterminate", "done") and status name. */
  statusCategory: string;
  statusName: string;
  /** Facts for evidence predicates, from the SAME read (no extra Jira call). */
  facts: IssueFacts;
}

/** Jira facts read AS THE APP (events and reconciliation have no user). Never returned to users raw. */
export interface IssueState {
  id: string;
  key: string;
  statusCategory: string;
  statusName: string;
  updated: string;
}

export interface JiraAppPort {
  /**
   * Batch read by numeric issue id. Ids that are missing or unreadable are simply absent from the
   * result: callers must treat absence as "unknown", never as "deleted" or "done".
   */
  getIssueStates(issueIds: string[]): Promise<IssueState[]>;
}

/** Maps a linked issue to the contracts that link it (an optimization; reconcile is authoritative). */
export interface LinkIndex {
  add(tenantId: string, linkedIssueId: string, contractIssueId: string, contractId: string): Promise<void>;
  remove(tenantId: string, linkedIssueId: string, contractIssueId: string, contractId: string): Promise<void>;
  /** Eventually consistent: may miss a very recent add. */
  contractsFor(tenantId: string, linkedIssueId: string): Promise<Array<{ contractIssueId: string; contractId: string }>>;
}

/** One recorded change to a user's assigned roles (append-only). */
export interface RoleChange {
  accountId: string;
  roles: Role[];
  changedBy: string;
  at: string;
}

/** Per-project role assignments managed by project administrators. */
export interface RoleStore {
  get(tenantId: string, projectKey: string, accountId: string): Promise<Role[]>;
  list(tenantId: string, projectKey: string): Promise<Array<{ accountId: string; roles: Role[] }>>;
  /** Empty `roles` removes the assignment. Records an append-only change entry. */
  set(tenantId: string, projectKey: string, accountId: string, roles: Role[], changedBy: string, at: string): Promise<void>;
  history(tenantId: string, projectKey: string, limit: number): Promise<RoleChange[]>;
}

/** Idempotency inbox. `claim` is atomic: exactly one caller ever gets `true` for a key. */
export interface EventInbox {
  claim(key: string): Promise<boolean>;
}

/** Small durable cursor for the bounded reconciliation sweep. */
export interface SweepState {
  get(tenantId: string): Promise<string | undefined>;
  set(tenantId: string, afterKey: string | undefined): Promise<void>;
}

export interface JiraPort {
  /** Permissions of the acting user on the issue. Throws on transport failure (fail closed). */
  getPermissions(issueKey: string): Promise<JiraPermissions>;
  /** undefined when the user cannot read the issue (403/404). */
  getIssueMeta(issueKey: string): Promise<IssueMeta | undefined>;
}

export type SaveResult = 'OK' | 'CONFLICT';

export interface ContractRepository {
  get(tenantId: string, issueId: string, contractId: string): Promise<Contract | undefined>;
  listByIssue(tenantId: string, issueId: string): Promise<Contract[]>;
  /** Fails if the contract id already exists. Writes the audit event in the same transaction. */
  create(contract: Contract, event: AuditEvent): Promise<void>;
  /** Compare-and-swap on revision; contract and audit event are written atomically. */
  save(next: Contract, event: AuditEvent, expectedRevision: number, issueId: string): Promise<SaveResult>;
  listAudit(tenantId: string, contractId: string, limit: number): Promise<AuditEvent[]>;
  /**
   * Enumerate contracts of a tenant in stable key order, strictly after `afterKey`. Used only by
   * the reconciliation sweep. Returns each contract with its storage key for resuming.
   */
  listPage(tenantId: string, afterKey: string | undefined, limit: number): Promise<Array<{ key: string; contract: Contract }>>;
}

export interface Clock {
  now(): string;
}
export interface IdGen {
  uuid(): string;
}
