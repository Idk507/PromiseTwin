import type { Role } from '../domain/contract';
import type { EventInbox, LinkIndex, RoleChange, RoleStore, SweepState } from './ports';

/** In-memory role store with the same contract as the Forge adapter. Used by tests. */
export class MemoryRoleStore implements RoleStore {
  readonly rows = new Map<string, Role[]>();
  readonly log: Array<RoleChange & { tenantId: string; projectKey: string }> = [];
  private k(t: string, p: string, a: string) {
    return [t, p, a].join('#');
  }
  async get(t: string, p: string, a: string) {
    return [...(this.rows.get(this.k(t, p, a)) ?? [])];
  }
  async list(t: string, p: string) {
    const prefix = `${t}#${p}#`;
    return [...this.rows.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, roles]) => ({ accountId: k.slice(prefix.length), roles: [...roles] }));
  }
  async set(t: string, p: string, a: string, roles: Role[], changedBy: string, at: string) {
    if (roles.length === 0) this.rows.delete(this.k(t, p, a));
    else this.rows.set(this.k(t, p, a), [...roles]);
    this.log.push({ tenantId: t, projectKey: p, accountId: a, roles: [...roles], changedBy, at });
  }
  async history(t: string, p: string, limit: number) {
    return this.log.filter((l) => l.tenantId === t && l.projectKey === p).slice(-limit).map(({ accountId, roles, changedBy, at }) => ({ accountId, roles, changedBy, at }));
  }
  /** Test convenience. */
  assign(t: string, p: string, a: string, roles: Role[]) {
    this.rows.set(this.k(t, p, a), [...roles]);
  }
}

// In-memory stand-ins with the same contracts as the Forge adapters. Used by tests.

export class MemoryLinkIndex implements LinkIndex {
  readonly rows = new Set<string>();
  /** Test hook: simulate eventual consistency / a lost write by hiding rows from reads. */
  hidden = new Set<string>();

  private k(t: string, linked: string, ci: string, c: string) {
    return [t, linked, ci, c].join('#');
  }
  /** Test hook: counts write calls so tests can assert a healthy index is not rewritten. */
  adds = 0;
  async add(t: string, linked: string, ci: string, c: string) {
    this.adds++;
    this.rows.add(this.k(t, linked, ci, c));
  }
  async remove(t: string, linked: string, ci: string, c: string) {
    this.rows.delete(this.k(t, linked, ci, c));
  }
  async contractsFor(t: string, linked: string) {
    const prefix = `${t}#${linked}#`;
    return [...this.rows]
      .filter((r) => r.startsWith(prefix) && !this.hidden.has(r))
      .map((r) => {
        const [, , contractIssueId, contractId] = r.split('#');
        return { contractIssueId: contractIssueId!, contractId: contractId! };
      });
  }
}

export class MemoryInbox implements EventInbox {
  readonly seen = new Set<string>();
  claims = 0;
  async claim(key: string) {
    this.claims++;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

export class MemorySweepState implements SweepState {
  readonly map = new Map<string, string | undefined>();
  async get(t: string) {
    return this.map.get(t);
  }
  async set(t: string, afterKey: string | undefined) {
    this.map.set(t, afterKey);
  }
}
