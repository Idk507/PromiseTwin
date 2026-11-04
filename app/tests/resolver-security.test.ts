import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Forge API so we can assert HOW the resolver calls Jira (asUser vs asApp,
// which URLs) without a live site. Shapes mirror @forge/api's fluent interface.
const requestJira = vi.fn();
const asUser = vi.fn(() => ({ requestJira }));
const asApp = vi.fn(() => ({ requestJira }));

vi.mock('@forge/api', () => ({
  default: { asUser, asApp },
  // Minimal stand-in for the route`` tag: joins strings and values.
  route: (s: TemplateStringsArray, ...v: unknown[]) =>
    s.reduce((acc, part, i) => acc + part + (v[i] ?? ''), ''),
}));

// Capture the resolver function registered under 'getRequestSnapshot'.
const defined: Record<string, (req: unknown) => Promise<unknown>> = {};
vi.mock('@forge/resolver', () => ({
  default: class {
    define(name: string, fn: (req: unknown) => Promise<unknown>) {
      defined[name] = fn;
    }
    getDefinitions() {
      return () => undefined;
    }
  },
}));

const okIssue = {
  key: 'SD-1',
  fields: {
    summary: 's',
    status: { name: 'Done', statusCategory: { key: 'done' } },
    issuetype: { name: 'Service Request' },
    project: { key: 'SD', projectTypeKey: 'service_desk' },
  },
};
const res = (status: number, body: unknown = null) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(async () => {
  requestJira.mockReset();
  asUser.mockClear();
  asApp.mockClear();
  await import('../src/resolvers/index');
});

const call = (req: unknown) => defined['getRequestSnapshot'](req);
// Forge-supplied identity: cloudId + accountId + issue. The resolver needs all three.
const ctx = (key?: string) => ({
  context: { cloudId: 'cloud-1', accountId: 'acct-1', extension: { issue: key ? { key } : undefined } },
});

describe('getRequestSnapshot security', () => {
  it('uses asUser only, never asApp (positive)', async () => {
    requestJira.mockResolvedValueOnce(res(200, okIssue)).mockResolvedValueOnce(res(404));
    await call(ctx('SD-1'));
    expect(asUser).toHaveBeenCalled();
    expect(asApp).not.toHaveBeenCalled();
  });

  it('ignores a client-supplied issue key in the payload (IDOR)', async () => {
    requestJira.mockResolvedValueOnce(res(200, okIssue)).mockResolvedValueOnce(res(404));
    await call({ ...ctx('SD-1'), payload: { issueKey: 'SECRET-9' }, issueKey: 'SECRET-9' });
    const urls = requestJira.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => u.includes('SD-1') && !u.includes('SECRET-9'))).toBe(true);
  });

  it('rejects when no issue key is in the verified context (negative)', async () => {
    await expect(call(ctx())).rejects.toThrow();
    expect(requestJira).not.toHaveBeenCalled();
  });

  it('fails closed on 403 from Jira and never reads JSM data (forbidden viewer)', async () => {
    requestJira.mockResolvedValueOnce(res(403));
    await expect(call(ctx('SD-1'))).rejects.toThrow(/403/);
    expect(requestJira).toHaveBeenCalledTimes(1);
  });

  it('does not leak the response body in the thrown error', async () => {
    requestJira.mockResolvedValueOnce(res(500, { secret: 'customer-pii' }));
    await expect(call(ctx('SD-1'))).rejects.not.toThrow(/customer-pii/);
  });

  it('rejects a malformed issue payload instead of passing it through', async () => {
    requestJira.mockResolvedValueOnce(res(200, { key: 'SD-1' })).mockResolvedValueOnce(res(404));
    await expect(call(ctx('SD-1'))).rejects.toThrow();
  });
});
