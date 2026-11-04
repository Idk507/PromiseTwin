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
  const tenantId = tenantFromInstallContext((context as { installContext?: unknown } | undefined)?.installContext);
  const e = (event ?? {}) as IssueUpdatedEvent;
  const r = await buildSync().handleIssueUpdated(tenantId, { issueId: e.issue?.id, updated: e.issue?.fields?.updated });
  console.log(
    `issueUpdated: ${r.skipped ?? 'processed'} tenantParsed=${tenantId !== undefined} contracts=${r.contractsScanned} applied=${r.applied} unchanged=${r.unchanged} deferred=${r.deferred} unreadable=${r.unreadable}`
  );
}

/** Hourly scheduled trigger: bounded recovery sweep for missed or lost events. */
export async function reconcileSweep(_event: unknown, context: unknown): Promise<void> {
  const tenantId = tenantFromInstallContext((context as { installContext?: unknown } | undefined)?.installContext);
  const r = await buildSync().reconcile(tenantId);
  console.log(
    `reconcile: ${r.skipped ?? 'done'} tenantParsed=${tenantId !== undefined} contracts=${r.contractsScanned} issues=${r.issuesChecked} applied=${r.applied} unchanged=${r.unchanged} deferred=${r.deferred} unreadable=${r.unreadable}`
  );
}
