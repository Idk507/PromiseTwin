import { z } from 'zod';

// Pure domain logic: no Forge imports, so it is unit-testable offline.
// Shapes below are the minimal subset of the Jira issue / JSM request responses
// this spike reads. Unknown fields are ignored (zod strips them by default).

const issueSchema = z.object({
  key: z.string().min(1),
  fields: z.object({
    summary: z.string(),
    status: z.object({
      name: z.string(),
      statusCategory: z.object({ key: z.string() }),
    }),
    issuetype: z.object({ name: z.string() }),
    project: z.object({ key: z.string(), projectTypeKey: z.string().optional() }),
  }),
});

const jsmRequestSchema = z.object({
  issueKey: z.string().min(1),
  requestTypeId: z.string().optional(),
  currentStatus: z.object({ status: z.string() }).optional(),
});

export type JsmLookup =
  | { kind: 'available'; requestTypeId: string | null; portalStatus: string | null }
  | { kind: 'not-a-jsm-request'; httpStatus: number }
  | { kind: 'unreadable' };

export interface RequestSnapshot {
  issueKey: string;
  summary: string;
  issueStatus: string;
  // True when Jira's status category is "done". This is ENGINEERING state only.
  engineeringDone: boolean;
  // Invariant (CLAUDE.md): issue DONE never implies promise FULFILLED.
  // P0 has no promise/evidence model, so fulfillment is always UNKNOWN and
  // unknown evidence must never count as valid.
  fulfillment: 'UNKNOWN';
  projectKey: string;
  projectType: string | null;
  jsm: JsmLookup;
}

/** Validates a raw Jira issue response; throws ZodError if malformed. */
export function parseIssue(raw: unknown) {
  return issueSchema.parse(raw);
}

/** Validates a raw JSM request body; malformed input yields 'unreadable', never 'available'. */
export function parseJsmRequest(raw: unknown): JsmLookup {
  const parsed = jsmRequestSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'unreadable' };
  return {
    kind: 'available',
    requestTypeId: parsed.data.requestTypeId ?? null,
    portalStatus: parsed.data.currentStatus?.status ?? null,
  };
}

// Maps an HTTP status from the JSM request endpoint to a lookup result.
// 404 = key is not a customer request; 403 = caller lacks permission.
// Anything else (including 5xx) is "unreadable", never silently "not JSM".
export function classifyJsmResponse(httpStatus: number, body: unknown): JsmLookup {
  if (httpStatus === 200) return parseJsmRequest(body);
  if (httpStatus === 404 || httpStatus === 403) {
    return { kind: 'not-a-jsm-request', httpStatus };
  }
  return { kind: 'unreadable' };
}

/** Builds the read-only snapshot. Fulfillment is always UNKNOWN in P0 (done != fulfilled). */
export function buildSnapshot(issueRaw: unknown, jsm: JsmLookup): RequestSnapshot {
  const issue = parseIssue(issueRaw);
  return {
    issueKey: issue.key,
    summary: issue.fields.summary,
    issueStatus: issue.fields.status.name,
    engineeringDone: issue.fields.status.statusCategory.key === 'done',
    fulfillment: 'UNKNOWN',
    projectKey: issue.fields.project.key,
    projectType: issue.fields.project.projectTypeKey ?? null,
    jsm,
  };
}
