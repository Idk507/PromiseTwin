import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { buildSnapshot, classifyJsmResponse, type JsmLookup } from '../domain/request-snapshot';
import type { RequestContext } from '../service/contract-service';
import { errorCode, logOp, resultCode } from '../observability/log';
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

// Every resolver is wrapped so each invocation writes one structured line (operation, outcome code,
// duration, short tenant hash). Payloads, accounts, issue keys and promise text are never logged.
function define(name: string, fn: (req: { context: unknown; payload?: unknown }) => Promise<unknown>) {
  resolver.define(name, async (req) => {
    const startedAt = Date.now();
    const tenantId = (req.context as ForgeResolverContext | undefined)?.cloudId;
    try {
      const r = await fn(req);
      logOp({ op: name, result: resultCode(r), startedAt, tenantId });
      return r;
    } catch (e) {
      logOp({ op: name, result: errorCode(e), startedAt, tenantId });
      throw e;
    }
  });
}
// ---- P0 spike (kept): read-only snapshot of the current issue ---------------------------------
define('getRequestSnapshot', async (req) => {
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
define('listContracts', async (req) => {
  const who = identity(req);
  if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
  const r = await service().list(who);
  return r;
});

define('createContract', async (req) => {
  const who = identity(req);
  if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
  const r = await service().create(who, (req.payload as { input?: unknown } | undefined)?.input);
  return r;
});

define('applyCommand', async (req) => {
  const who = identity(req);
  if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
  const r = await service().apply(who, (req.payload as { command?: unknown } | undefined)?.command);
  return r;
});

define('refreshLinkedWork', async (req) => {
  const who = identity(req);
  if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
  const r = await service().refresh(who, (req.payload as { contractId?: unknown } | undefined)?.contractId);
  return r;
});

define('getRoles', async (req) => {
  const who = identity(req);
  if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
  const r = await service().roleAdmin(who);
  return r;
});

define('setRoles', async (req) => {
  const who = identity(req);
  if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
  const r = await service().setRoles(who, (req.payload as { assignment?: unknown } | undefined)?.assignment);
  return r;
});

// ---- P4: project portfolio -----------------------------------------------------------------------
define('getPortfolio', async (req) => {
  const who = projectIdentity(req);
  if (!who) return { ok: false, code: 'ISSUE_NOT_ACCESSIBLE' };
  const r = await service().portfolio(who, (req.payload as { cursor?: unknown } | undefined)?.cursor);
  return r;
});

export const handler = resolver.getDefinitions();
