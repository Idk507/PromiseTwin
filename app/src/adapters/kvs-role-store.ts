import { kvs, WhereConditions } from '@forge/kvs';
import { ASSIGNABLE_ROLES, roleSchema, type Role } from '../domain/contract';
import type { RoleChange, RoleStore } from '../service/ports';
import { seg } from './keys';

// Plain Key-Value Store (no entity declarations). Storage is per installation; tenant and project
// are also in every key. Values are re-validated on read: anything that is not an assignable role
// is dropped, so tampered or corrupted data can never grant APPROVER/SYSTEM.

const MAX_ASSIGNMENTS = 200;
/** Largest list-query page Forge accepts in practice (200 was rejected live; 100 is used elsewhere). */
const QUERY_LIMIT = 100;
const assignable = (r: unknown): r is Role =>
  roleSchema.safeParse(r).success && (ASSIGNABLE_ROLES as readonly string[]).includes(r as string);

const cleanRoles = (v: unknown): Role[] => {
  const roles = (v as { roles?: unknown } | undefined)?.roles;
  return Array.isArray(roles) ? [...new Set(roles.filter(assignable))] : [];
};

export class KvsRoleStore implements RoleStore {
  private key(t: string, p: string, a: string) {
    return ['roles', seg(t), seg(p), seg(a)].join('#');
  }

  async get(t: string, p: string, a: string): Promise<Role[]> {
    return cleanRoles(await kvs.get(this.key(t, p, a)));
  }

  async list(t: string, p: string) {
    const prefix = ['roles', seg(t), seg(p), ''].join('#');
    // Forge rejects list queries above its per-request limit (LIST_QUERY_LIMIT_EXCEEDED, seen live
    // at 200), so page in chunks of QUERY_LIMIT until the assignment cap is reached.
    const rows: Array<{ key: string; value: unknown }> = [];
    let cursor: string | undefined;
    while (rows.length < MAX_ASSIGNMENTS) {
      let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(QUERY_LIMIT);
      if (cursor) q = q.cursor(cursor);
      const res = await q.getMany();
      rows.push(...res.results.map((r) => ({ key: r.key, value: r.value })));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return rows
      .slice(0, MAX_ASSIGNMENTS)
      .map((r) => ({ accountId: r.key.slice(prefix.length), roles: cleanRoles(r.value) }))
      .filter((r) => r.roles.length > 0 && /^[A-Za-z0-9:_-]{1,128}$/.test(r.accountId));
  }

  async set(t: string, p: string, a: string, roles: Role[], changedBy: string, at: string): Promise<void> {
    const clean = [...new Set(roles.filter(assignable))];
    if (clean.length === 0) await kvs.delete(this.key(t, p, a));
    else await kvs.set(this.key(t, p, a), { roles: clean });
    // Append-only change log; key is time-ordered and made unique with a random suffix.
    const id = `${at.replace(/[^0-9A-Za-z]/g, '')}-${Math.random().toString(36).slice(2, 8)}`;
    await kvs.set(['rolelog', seg(t), seg(p), seg(id)].join('#'), { accountId: a, roles: clean, changedBy, at });
  }

  async history(t: string, p: string, limit: number): Promise<RoleChange[]> {
    const prefix = ['rolelog', seg(t), seg(p), ''].join('#');
    const res = await kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(QUERY_LIMIT).getMany();
    return res.results
      .map((r) => r.value as Partial<RoleChange> | undefined)
      .filter((v): v is RoleChange => !!v && typeof v.accountId === 'string' && typeof v.changedBy === 'string' && typeof v.at === 'string' && Array.isArray(v.roles))
      .map((v) => ({ accountId: v.accountId, roles: cleanRoles({ roles: v.roles }), changedBy: v.changedBy, at: v.at }))
      .slice(-limit);
  }
}
