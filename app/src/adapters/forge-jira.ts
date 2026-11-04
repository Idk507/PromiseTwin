import api, { route } from '@forge/api';
import type { IssueMeta, IssueState, JiraAppPort, JiraPermissions, JiraPort } from '../service/ports';
import { z } from 'zod';

// Jira access ALWAYS as the acting user (asUser), so Jira enforces their own permissions.

// One side of an issue link: only ids/keys are used, never summaries or other content.
const linkedEnd = z.object({ id: z.string().regex(/^\d{1,20}$/), key: z.string().min(1) });
const issueSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  fields: z.object({
    updated: z.string().min(1),
    status: z.object({ name: z.string().min(1), statusCategory: z.object({ key: z.string().min(1) }) }),
    // Absent/odd shapes degrade to "no labels / no links / no resolution" so predicates FAIL, never pass.
    labels: z.array(z.string()).max(200).catch([]),
    resolution: z.unknown().optional(),
    issuelinks: z
      .array(z.object({ inwardIssue: linkedEnd.optional(), outwardIssue: linkedEnd.optional() }))
      .max(200)
      .catch([]),
  }),
});

const MAX_LINKS = 100;

const permissionsSchema = z.object({
  permissions: z.record(z.string(), z.object({ havePermission: z.boolean() })),
});

export class ForgeJira implements JiraPort {
  async getIssueMeta(issueKey: string): Promise<IssueMeta | undefined> {
    const res = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}?fields=updated,status,labels,issuelinks,resolution`);
    if (res.status === 403 || res.status === 404) return undefined;
    if (!res.ok) throw new Error(`issue read failed (${res.status})`); // status only, never the body
    const issue = issueSchema.parse(await res.json());
    return {
      id: issue.id,
      key: issue.key,
      revision: issue.fields.updated,
      statusCategory: issue.fields.status.statusCategory.key,
      statusName: issue.fields.status.name,
      facts: {
        id: issue.id,
        key: issue.key,
        statusCategory: issue.fields.status.statusCategory.key,
        resolutionSet: issue.fields.resolution !== null && issue.fields.resolution !== undefined,
        labels: issue.fields.labels,
        linkedIssueIds: issue.fields.issuelinks.flatMap((l) => [l.inwardIssue?.id, l.outwardIssue?.id]).filter((x): x is string => !!x).slice(0, MAX_LINKS),
        linkedIssueKeys: issue.fields.issuelinks.flatMap((l) => [l.inwardIssue?.key, l.outwardIssue?.key]).filter((x): x is string => !!x).slice(0, MAX_LINKS),
      },
    };
  }

  async getPermissions(issueKey: string): Promise<JiraPermissions> {
    const res = await api
      .asUser()
      .requestJira(route`/rest/api/3/mypermissions?issueKey=${issueKey}&permissions=EDIT_ISSUES,ADMINISTER_PROJECTS`);
    if (!res.ok) throw new Error(`permission read failed (${res.status})`);
    const body = permissionsSchema.parse(await res.json());
    return {
      editIssues: body.permissions['EDIT_ISSUES']?.havePermission === true,
      administerProject: body.permissions['ADMINISTER_PROJECTS']?.havePermission === true,
    };
  }
}

const searchSchema = z.object({
  issues: z.array(z.unknown()),
});
const searchIssueSchema = z.object({
  id: z.string().regex(/^\d{1,20}$/),
  key: z.string().min(1),
  fields: z.object({
    updated: z.string().min(1),
    status: z.object({ name: z.string().min(1), statusCategory: z.object({ key: z.string().min(1) }) }),
  }),
});
const BATCH = 50;

/**
 * Reads issue state AS THE APP for events and reconciliation (there is no user). It is only ever
 * asked about issues a user linked (and could read at link time), and what it returns is stored
 * minimally and redacted per viewer before display. Ids are re-validated as digits before they are
 * placed in JQL, so no caller-supplied text reaches the query.
 */
export class ForgeJiraApp implements JiraAppPort {
  async getIssueStates(issueIds: string[]): Promise<IssueState[]> {
    const ids = [...new Set(issueIds)].filter((i) => /^\d{1,20}$/.test(i));
    const out: IssueState[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const jql = `id in (${chunk.join(',')})`;
      const res = await api
        .asApp()
        .requestJira(route`/rest/api/3/search/jql?jql=${jql}&fields=status,updated&maxResults=${BATCH}`);
      if (!res.ok) throw new Error(`issue batch read failed (${res.status})`); // status only
      const body = searchSchema.parse(await res.json());
      for (const raw of body.issues) {
        const parsed = searchIssueSchema.safeParse(raw);
        if (!parsed.success) continue; // malformed item: treat as unknown, never guess
        const f = parsed.data;
        out.push({ id: f.id, key: f.key, statusCategory: f.fields.status.statusCategory.key, statusName: f.fields.status.name, updated: f.fields.updated });
      }
    }
    return out;
  }
}
