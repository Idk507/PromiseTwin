import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import {
  buildSnapshot,
  classifyJsmResponse,
  type JsmLookup,
} from '../domain/request-snapshot';

const resolver = new Resolver();

// The issue key comes from the Forge-supplied extension context, NOT from the
// client payload, so a caller cannot ask for an arbitrary issue by editing the request.
resolver.define('getRequestSnapshot', async (req) => {
  const context = req.context as { extension?: { issue?: { key?: string } } };
  const issueKey = context.extension?.issue?.key;
  if (!issueKey) throw new Error('No issue key in extension context');

  // .asUser(): Jira enforces the viewer's own permissions (tenant/user access).
  const issueRes = await api
    .asUser()
    .requestJira(
      route`/rest/api/3/issue/${issueKey}?fields=summary,status,issuetype,project`
    );
  if (!issueRes.ok) {
    // Log status only: never log response bodies (may contain customer data).
    console.error(`issue read failed: ${issueRes.status}`);
    throw new Error(`Issue read failed (${issueRes.status})`);
  }
  const issueRaw: unknown = await issueRes.json();

  const jsmRes = await api
    .asUser()
    .requestJira(route`/rest/servicedeskapi/request/${issueKey}`);
  const jsmBody: unknown = jsmRes.status === 200 ? await jsmRes.json() : null;
  const jsm: JsmLookup = classifyJsmResponse(jsmRes.status, jsmBody);
  console.log(`snapshot: issue=200 jsm=${jsmRes.status}`);

  return buildSnapshot(issueRaw, jsm);
});

export const handler = resolver.getDefinitions();
