import type { Contract } from '../domain/contract';
import { applyCommand, type Actor, type Command } from '../domain/lifecycle';
import type { EvaluationContext } from '../domain/verification';
import type { Clock, ContractRepository, EventInbox, IssueState, JiraAppPort, LinkIndex, SweepState } from './ports';

// Keeps linked-work snapshots in step with Jira WITHOUT ever changing a promise's lifecycle or
// evidence. Runs as the app (no user): every write goes through the same pure domain command
// (OBSERVE_LINKED_WORK) and the same revision-checked repository as user commands.

export const SWEEP_CONTRACT_LIMIT = 50;
export const SWEEP_ISSUE_LIMIT = 50;
const ISSUE_ID = /^\d{1,20}$/;
const NO_PROOF_CHECKS: EvaluationContext = { now: '', sourceChecks: {} }; // OBSERVE never consults evidence

const systemActor = (source: 'event' | 'reconcile' | 'refresh'): Actor => ({
  accountId: `system:${source}`,
  roles: ['SYSTEM'],
});

/** Event ids must be stable per (issue, updated) so replays collapse; keep them key-safe. */
const stamp = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
const observationEventId = (state: IssueState) => `obs-${state.id}-${stamp(state.updated)}`;

export interface SyncCounts {
  contractsScanned: number;
  issuesChecked: number;
  applied: number;
  unchanged: number;
  deferred: number;
  unreadable: number;
}
const zero = (): SyncCounts => ({ contractsScanned: 0, issuesChecked: 0, applied: 0, unchanged: 0, deferred: 0, unreadable: 0 });

export interface SyncDeps {
  repo: ContractRepository;
  index: LinkIndex;
  inbox: EventInbox;
  jiraApp: JiraAppPort;
  sweep: SweepState;
  clock: Clock;
}

export type SyncSource = 'event' | 'reconcile' | 'refresh';

export class LinkedWorkSync {
  constructor(private readonly d: SyncDeps) {}

  /**
   * Applies already-fetched Jira states to ONE contract. Per observation: load, decide (pure),
   * save with compare-and-swap; on a conflict reload once, then defer to the next sweep.
   */
  private async applyToContract(
    tenantId: string,
    contractIssueId: string,
    contractId: string,
    states: IssueState[],
    source: SyncSource,
    counts: SyncCounts
  ): Promise<void> {
    for (const state of states) {
      let settled = false;
      for (let attempt = 0; attempt < 2 && !settled; attempt++) {
        const contract = await this.d.repo.get(tenantId, contractIssueId, contractId);
        if (!contract) return; // contract gone or not ours: nothing to do
        const command: Command = {
          type: 'OBSERVE_LINKED_WORK',
          eventId: observationEventId(state),
          tenantId,
          expectedRevision: contract.revision,
          actor: systemActor(source),
          at: this.d.clock.now(),
          observation: { issueId: state.id, statusCategory: state.statusCategory, statusName: state.statusName, updated: state.updated },
        };
        const result = applyCommand(contract, command, NO_PROOF_CHECKS);
        if (!result.ok) {
          // NOT_LINKED (link removed meanwhile) and similar refusals are expected races: skip quietly.
          counts.unchanged++;
          settled = true;
        } else if (result.duplicate) {
          counts.unchanged++;
          settled = true;
        } else {
          const saved = await this.d.repo.save(result.contract, result.event, contract.revision, contractIssueId);
          if (saved === 'OK') {
            counts.applied++;
            settled = true;
          }
          // CONFLICT: loop once more with fresh state.
        }
      }
      if (!settled) counts.deferred++; // left for the next sweep; never retried in a tight loop
    }
  }

  /**
   * Handles one `avi:jira:updated:issue` delivery. The payload is only a HINT: tenant comes from
   * Forge context, and the authoritative status/updated are re-read from Jira.
   * Cheap path first: an unlinked issue costs one index read and nothing else.
   */
  async handleIssueUpdated(tenantId: string | undefined, payload: { issueId?: unknown; updated?: unknown }): Promise<SyncCounts & { skipped?: string }> {
    const counts = zero();
    if (!tenantId) return { ...counts, skipped: 'NO_TENANT' };
    const issueId = typeof payload.issueId === 'string' ? payload.issueId : undefined;
    if (!issueId || !ISSUE_ID.test(issueId)) return { ...counts, skipped: 'BAD_ISSUE_ID' };

    const targets = await this.d.index.contractsFor(tenantId, issueId);
    if (targets.length === 0) return { ...counts, skipped: 'NOT_LINKED' };

    // Atomic dedupe on (tenant, issue, updated-from-payload). A missing `updated` skips the dedupe
    // (domain monotonicity still protects), it never skips processing.
    const updatedHint = typeof payload.updated === 'string' ? payload.updated : undefined;
    if (updatedHint) {
      const first = await this.d.inbox.claim(`inbox#${tenantId}#${issueId}#${stamp(updatedHint)}`);
      if (!first) return { ...counts, skipped: 'DUPLICATE' };
    }

    const states = await this.d.jiraApp.getIssueStates([issueId]);
    counts.issuesChecked = 1;
    if (states.length === 0) {
      counts.unreadable = 1; // unknown, NOT deleted/done: leave the snapshot as it is
      return counts;
    }
    for (const t of targets) {
      counts.contractsScanned++;
      await this.applyToContract(tenantId, t.contractIssueId, t.contractId, states, 'event', counts);
    }
    return counts;
  }

  /**
   * Authoritative, bounded recovery sweep over CONTRACTS (not the index), so it also repairs any
   * lost event and any lost index write. Resumes from a stored key; wraps around at the end.
   */
  async reconcile(tenantId: string | undefined): Promise<SyncCounts & { skipped?: string }> {
    const counts = zero();
    if (!tenantId) return { ...counts, skipped: 'NO_TENANT' };
    const after = await this.d.sweep.get(tenantId);
    const page = await this.d.repo.listPage(tenantId, after, SWEEP_CONTRACT_LIMIT);

    // Take contracts only while their linked issues fit the per-run issue budget, and advance the
    // cursor only past contracts actually taken, so a heavy page can never starve later contracts.
    const budget = new Set<string>();
    const taken: typeof page = [];
    for (const p of page) {
      const ids = p.contract.linkedWork.map((l) => l.issueId);
      const next = new Set([...budget, ...ids]);
      if (next.size > SWEEP_ISSUE_LIMIT && taken.length > 0) break;
      ids.forEach((i) => budget.add(i));
      taken.push(p);
    }
    const finished = taken.length === page.length && page.length < SWEEP_CONTRACT_LIMIT;
    await this.d.sweep.set(tenantId, finished ? undefined : taken[taken.length - 1]?.key ?? after);

    counts.contractsScanned = taken.length;
    await this.syncContracts(tenantId, taken.map((p) => p.contract).filter((c) => c.linkedWork.length > 0), 'reconcile', counts);
    return counts;
  }

  /** User-requested refresh of ONE contract. Same code path as the sweep. */
  async refreshContract(tenantId: string, contractIssueId: string, contractId: string): Promise<SyncCounts> {
    const counts = zero();
    const contract = await this.d.repo.get(tenantId, contractIssueId, contractId);
    if (!contract) return counts;
    counts.contractsScanned = 1;
    await this.syncContracts(tenantId, [contract], 'refresh', counts);
    return counts;
  }

  private async syncContracts(tenantId: string, contracts: Contract[], source: SyncSource, counts: SyncCounts) {
    const ids = [...new Set(contracts.flatMap((c) => c.linkedWork.map((l) => l.issueId)))].filter((i) => ISSUE_ID.test(i)).slice(0, SWEEP_ISSUE_LIMIT);
    if (ids.length === 0) return;
    const states = await this.d.jiraApp.getIssueStates(ids);
    counts.issuesChecked += ids.length;
    const byId = new Map(states.map((s) => [s.id, s]));
    const indexRows = new Map<string, Array<{ contractIssueId: string; contractId: string }>>();
    counts.unreadable += ids.filter((i) => !byId.has(i)).length;
    for (const c of contracts) {
      const relevant = c.linkedWork.map((l) => byId.get(l.issueId)).filter((s): s is IssueState => s !== undefined);
      if (relevant.length === 0) continue;
      await this.applyToContract(tenantId, c.source.issueId, c.id, relevant, source, counts);
      // Self-heal the index, but read first and write only what is MISSING: a healthy index costs
      // one read per linked issue per sweep instead of a write per link.
      for (const l of c.linkedWork) {
        let rows = indexRows.get(l.issueId);
        if (!rows) {
          rows = await this.d.index.contractsFor(tenantId, l.issueId);
          indexRows.set(l.issueId, rows);
        }
        const present = rows.some((r) => r.contractIssueId === c.source.issueId && r.contractId === c.id);
        if (!present) await this.d.index.add(tenantId, l.issueId, c.source.issueId, c.id);
      }
    }
  }
}
