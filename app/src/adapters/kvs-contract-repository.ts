import { kvs, Filter, FilterConditions, WhereConditions } from '@forge/kvs';
import { contractSchema, type AuditEvent, type Contract } from '../domain/contract';
import type { ContractRepository, SaveResult } from '../service/ports';
import { seg } from './keys';

// Forge Custom Entity Store adapter. Declared entities: `contract` and `audit-event` (manifest.yml).
// Storage is already per-installation; tenantId is ALSO in every key and re-checked on read as
// defence in depth. Queries use the built-in `by-key` index (no custom indexes).
//
// Consistency (Forge docs): entity `get` is strongly consistent, `query` is eventually consistent,
// so a list right after a create may briefly omit it. Writes use a conditional transaction.

const CONTRACT = 'contract';
const AUDIT = 'audit-event';
const MAX_PAGES = 5;


interface StoredContract {
  tenantId: string;
  revision: number;
  doc: Contract;
}
interface StoredAudit {
  tenantId: string;
  contractId: string;
  doc: AuditEvent;
}

const contractKey = (tenantId: string, issueId: string, contractId: string) =>
  [seg(tenantId), seg(issueId), seg(contractId)].join('#');
const auditKey = (e: AuditEvent) => [seg(e.tenantId), seg(e.contractId), seg(e.at), seg(e.id)].join('#');

function toStored(c: Contract): StoredContract {
  return { tenantId: c.tenantId, revision: c.revision, doc: c };
}
function toStoredAudit(e: AuditEvent): StoredAudit {
  return { tenantId: e.tenantId, contractId: e.contractId, doc: e };
}

/** Validates stored data and refuses anything that belongs to another tenant. */
function readContract(row: StoredContract | undefined, tenantId: string): Contract | undefined {
  if (!row) return undefined;
  const parsed = contractSchema.safeParse(row.doc);
  if (!parsed.success || parsed.data.tenantId !== tenantId || row.tenantId !== tenantId) return undefined;
  return parsed.data;
}

async function queryPrefix<T>(entity: string, prefix: string): Promise<Array<{ key: string; value: T }>> {
  const out: Array<{ key: string; value: T }> = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = kvs.entity<T>(entity).query().index('by-key').where(WhereConditions.beginsWith(prefix)).limit(100);
    if (cursor) q = q.cursor(cursor);
    const res = await q.getMany();
    out.push(...res.results.map((r) => ({ key: r.key, value: r.value })));
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return out;
}

export class KvsContractRepository implements ContractRepository {
  async get(tenantId: string, issueId: string, contractId: string) {
    const row = await kvs.entity<StoredContract>(CONTRACT).get(contractKey(tenantId, issueId, contractId));
    return readContract(row, tenantId);
  }

  async listByIssue(tenantId: string, issueId: string) {
    const rows = await queryPrefix<StoredContract>(CONTRACT, `${seg(tenantId)}#${seg(issueId)}#`);
    return rows.map((r) => readContract(r.value, tenantId)).filter((c): c is Contract => c !== undefined);
  }

  async create(contract: Contract, event: AuditEvent) {
    // The id is a random UUID, so a collision is not a realistic race; check anyway (fail closed).
    const key = contractKey(contract.tenantId, contract.source.issueId, contract.id);
    if (await kvs.entity<StoredContract>(CONTRACT).get(key)) throw new Error('contract already exists');
    await kvs
      .transact()
      .set(key, toStored(contract), { entityName: CONTRACT })
      .set(auditKey(event), toStoredAudit(event), { entityName: AUDIT })
      .execute();
  }

  async save(next: Contract, event: AuditEvent, expectedRevision: number, issueId: string): Promise<SaveResult> {
    const key = contractKey(next.tenantId, issueId, next.id);
    try {
      // Contract and audit event commit together or not at all (Forge-internal atomicity only;
      // this says nothing about atomicity with Jira).
      await kvs
        .transact()
        .set(key, toStored(next), {
          entityName: CONTRACT,
          conditions: new Filter<StoredContract>().and('revision', FilterConditions.equalTo(expectedRevision)),
        })
        .set(auditKey(event), toStoredAudit(event), { entityName: AUDIT })
        .execute();
      return 'OK';
    } catch (err) {
      // The exact error code for a failed condition is not relied on. Re-read: if the stored
      // revision differs from what the caller expected, it was a conflict; otherwise rethrow.
      const current = await kvs.entity<StoredContract>(CONTRACT).get(key);
      if (!current || current.revision !== expectedRevision) return 'CONFLICT';
      throw err;
    }
  }

  /**
   * Stable-order page of a tenant's contracts strictly after `afterKey` (a key WE stored, not an
   * opaque Forge cursor, because Forge cursors are documented as unstable across invocations).
   */
  async listPage(tenantId: string, afterKey: string | undefined, limit: number) {
    const prefix = `${seg(tenantId)}#`;
    let q = kvs.entity<StoredContract>(CONTRACT).query().index('by-key');
    q = afterKey === undefined
      ? q.where(WhereConditions.beginsWith(prefix))
      : q.where(WhereConditions.greaterThan(afterKey));
    const res = await q.limit(Math.min(Math.max(limit, 1), 100)).getMany();
    const out: Array<{ key: string; contract: Contract }> = [];
    for (const r of res.results) {
      if (!r.key.startsWith(prefix)) continue; // greaterThan can run past the tenant's key range
      const contract = readContract(r.value, tenantId);
      if (contract) out.push({ key: r.key, contract });
    }
    return out;
  }

  async listAudit(tenantId: string, contractId: string, limit: number) {
    const rows = await queryPrefix<StoredAudit>(AUDIT, `${seg(tenantId)}#${seg(contractId)}#`);
    return rows
      .map((r) => r.value)
      .filter((v) => v.tenantId === tenantId && v.contractId === contractId)
      .map((v) => v.doc)
      .slice(-limit);
  }
}
