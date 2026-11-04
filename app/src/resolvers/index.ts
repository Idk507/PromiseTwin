import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { buildSnapshot, classifyJsmResponse, type JsmLookup } from '../domain/request-snapshot';
import type { RequestContext } from '../service/contract-service';
import { buildService } from '../wiring';

const resolver = new Resolver();

interface ForgeResolverContext {
  cloudId?: string;
  accountId?: string;
  extension?: { issue?: { key?: string } };
}

/** Builds the request identity from Forge-supplied context only; the client payload is never consulted. */
function identity(req: { context: unknown }): RequestContext | undefined {
  const c = req.context as ForgeResolverContext;
  const tenantId = c.cloudId;
  const accountId = c.accountId;
  const issueKey = c.extension?.issue?.key;
  if (!tenantId || !accountId || !issueKey) return undefined;
  return { tenantId, accountId, issueKey };
}

/**
 * Identity for the project page. Tenant, account AND project come from Forge-supplied context;
 * the client payload (other than an opaque paging cursor) is never consulted. Fails closed when
 * the project is absent from the context.
 */
function projectIdentity(req: { context: unknown }): { tenantId: string; accountId: string; projectKey: string } | undefined {
  const c = req.context as ForgeResolverContext & { extension?: { project?: { key?: string } } };
  const tenantId = c.cloudId;
  const accountId = c.accountId;
  const projectKey = c.extension?.project?.key;
  if (!tenantId || !accountId || !projectKey) return undefined;
  return { tenantId, accountId, projectKey };
}

const service = buildService;

// Log outcome codes only. Never log payloads, summaries, or customer references.
function logOutcome(op: string, r: { ok: boolean; code?: string }) {
  console.log(`${op}: ${r.ok ? 'ok' : `refused ${r.code}`}`);
}

// ---- P0 spike (kept): read-only snapshot of the current issue ---------------------------------
resolver.define('getRequestSnapshot', async (req) => {
  const who = identity(req);
  if (!who) throw new Error('No issue context');
  const issueKey = who.issueKey;
  const issueRes = await api
    .asUser()
    .requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary,status,issuetype,project`);
  if (!issueRes.ok) {
    console.error(`issue read failed: ${issueRes.status}`);
    throw new Error(`Issue read failed (${issueRes.status})`);
  }
  const issueRaw: unknown = await issueRes.json();
  const jsmRes = await api.asUser().requestJira(route`/rest/servicedeskapi/request/${issueKey}`);
  const jsmBody: unknown = jsmRes.status === 200 ? await jsmRes.json() : null;
  const jsm: JsmLookup = classifyJsmResponse(jsmRes.status, jsmBody);
  console.log(`snapshot: issue=200 jsm=${jsmRes.status}`);
  return buildSnapshot(issueRaw, jsm);
});

// ---- P1: promise contracts ----------------------------------------------------------------------
resolver.define('listContracts', async (req) => {
  const who = identity(req);
  if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
  const r = await service().list(who);
  logOutcome('listContracts', r.ok ? { ok: true } : r);
  return r;
});

resolver.define('createContract', async (req) => {
  const who = identity(req);
  if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
  const r = await service().create(who, (req.payload as { input?: unknown } | undefined)?.input);
  logOutcome('createContract', r.ok ? { ok: true } : r);
  return r;
});

resolver.define('applyCommand', async (req) => {
  const who = identity(req);
  if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
  const r = await service().apply(who, (req.payload as { command?: unknown } | undefined)?.command);
  logOutcome('applyCommand', r.ok ? { ok: true } : r);
  return r;
});

resolver.define('refreshLinkedWork', async (req) => {
  const who = identity(req);
  if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
  const r = await service().refresh(who, (req.payload as { contractId?: unknown } | undefined)?.contractId);
  logOutcome('refreshLinkedWork', r.ok ? { ok: true } : r);
  return r;
});

resolver.define('getRoles', async (req) => {
  const who = identity(req);
  if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
  const r = await service().roleAdmin(who);
  logOutcome('getRoles', r.ok ? { ok: true } : r);
  return r;
});

resolver.define('setRoles', async (req) => {
  const who = identity(req);
  if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
  const r = await service().setRoles(who, (req.payload as { assignment?: unknown } | undefined)?.assignment);
  logOutcome('setRoles', r.ok ? { ok: true } : r); // outcome only: never log account ids or roles
  return r;
});

// ---- P4: project portfolio -----------------------------------------------------------------------
resolver.define('getPortfolio', async (req) => {
  const who = projectIdentity(req);
  if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
  const r = await service().portfolio(who, (req.payload as { cursor?: unknown } | undefined)?.cursor);
  logOutcome('getPortfolio', r.ok ? { ok: true } : r);
  return r;
});

export const handler = resolver.getDefinitions();
