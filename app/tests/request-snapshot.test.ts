import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  classifyJsmResponse,
  parseIssue,
} from '../src/domain/request-snapshot';

// Synthetic fixture shaped like GET /rest/api/3/issue/{key}?fields=... (subset).
const issue = (categoryKey: string) => ({
  key: 'SD-1',
  fields: {
    summary: 'Synthetic request',
    status: { name: 'Done', statusCategory: { key: categoryKey } },
    issuetype: { name: 'Service Request' },
    project: { key: 'SD', projectTypeKey: 'service_desk' },
  },
});

describe('buildSnapshot', () => {
  it('never reports fulfillment from a done issue (invariant)', () => {
    const snap = buildSnapshot(issue('done'), { kind: 'unreadable' });
    expect(snap.engineeringDone).toBe(true);
    expect(snap.fulfillment).toBe('UNKNOWN');
  });

  it('marks open issues as not engineering-done', () => {
    expect(buildSnapshot(issue('indeterminate'), { kind: 'unreadable' }).engineeringDone).toBe(false);
  });

  it('rejects malformed issue payloads', () => {
    expect(() => parseIssue({ key: 'SD-1' })).toThrow();
    expect(() => parseIssue(null)).toThrow();
  });
});

describe('classifyJsmResponse', () => {
  it('parses a 200 body', () => {
    expect(
      classifyJsmResponse(200, { issueKey: 'SD-1', requestTypeId: '10', currentStatus: { status: 'Waiting' } })
    ).toEqual({ kind: 'available', requestTypeId: '10', portalStatus: 'Waiting' });
  });

  it('treats a 200 with a bad body as unreadable, not available', () => {
    expect(classifyJsmResponse(200, { nope: true })).toEqual({ kind: 'unreadable' });
  });

  it('maps 404/403 to not-a-jsm-request', () => {
    expect(classifyJsmResponse(404, null)).toEqual({ kind: 'not-a-jsm-request', httpStatus: 404 });
    expect(classifyJsmResponse(403, null)).toEqual({ kind: 'not-a-jsm-request', httpStatus: 403 });
  });

  it('never maps server errors to not-a-jsm-request', () => {
    expect(classifyJsmResponse(500, null)).toEqual({ kind: 'unreadable' });
  });
});
