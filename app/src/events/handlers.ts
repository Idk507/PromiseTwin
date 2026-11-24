import { errorCode, logOp } from '../observability/log';
import { buildSync } from '../wiring';
import { tenantFromInstallContext } from './tenant';

// Trigger entry points. They run as the app with no user, so they only ever call the sync service,
// which records Jira FACTS about linked work through a system-only domain command. Nothing here can
// advance a promise's lifecycle. Logs carry outcome codes and counts only.

interface IssueUpdatedEvent {
  issue?: { id?: unknown; fields?: { updated?: unknown } };
}

/** `avi:jira:updated:issue`. The payload is a hint; authoritative state is re-read in the service. */
export async function onIssueUpdated(event: unknown, context: unknown): Promise<void> {
  const startedAt = Date.now();
  const tenantId = tenantFromInstallContext((context as { installContext?: unknown } | undefined)?.installContext);
  const e = (event ?? {}) as IssueUpdatedEvent;
  try {
    const r = await buildSync().handleIssueUpdated(tenantId, { issueId: e.issue?.id, updated: e.issue?.fields?.updated });
    logOp({
      op: 'event.issueUpdated', result: r.skipped ?? 'processed', startedAt, tenantId,
      counts: { tenantParsed: tenantId !== undefined ? 1 : 0, contracts: r.contractsScanned, applied: r.applied, unchanged: r.unchanged, deferred: r.deferred, unreadable: r.unreadable },
    });
  } catch (err) {
    logOp({ op: 'event.issueUpdated', result: errorCode(err), startedAt, tenantId });
    throw err;
  }
}
/** Hourly scheduled trigger: bounded recovery sweep for missed or lost events. */
export async function reconcileSweep(_event: unknown, context: unknown): Promise<void> {
  const startedAt = Date.now();
  const tenantId = tenantFromInstallContext((context as { installContext?: unknown } | undefined)?.installContext);
  try {
    const r = await buildSync().reconcile(tenantId);
    logOp({
      op: 'schedule.reconcile', result: r.skipped ?? 'done', startedAt, tenantId,
      counts: { tenantParsed: tenantId !== undefined ? 1 : 0, contracts: r.contractsScanned, issues: r.issuesChecked, applied: r.applied, unchanged: r.unchanged, deferred: r.deferred, unreadable: r.unreadable },
    });
  } catch (err) {
    logOp({ op: 'schedule.reconcile', result: errorCode(err), startedAt, tenantId });
    throw err;
  }
}