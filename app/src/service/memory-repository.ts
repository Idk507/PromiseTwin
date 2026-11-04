import type { AuditEvent, Contract } from '../domain/contract';
import type { ContractRepository, SaveResult } from './ports';

/** In-memory repository with the SAME CAS semantics as the Forge adapter. Used by tests. */
export class MemoryContractRepository implements ContractRepository {
  readonly contracts = new Map<string, { issueId: string; contract: Contract }>();
  readonly audit: AuditEvent[] = [];

  private key(tenantId: string, contractId: string) {
    return `${tenantId}#${contractId}`;
  }

  async get(tenantId: string, issueId: string, contractId: string) {
    const row = this.contracts.get(this.key(tenantId, contractId));
    // Scoped by issue too: a contractId from another issue is simply not found.
    return row && row.issueId === issueId ? structuredClone(row.contract) : undefined;
  }

  async listByIssue(tenantId: string, issueId: string) {
    return [...this.contracts.values()]
      .filter((r) => r.contract.tenantId === tenantId && r.issueId === issueId)
      .map((r) => structuredClone(r.contract));
  }

  async create(contract: Contract, event: AuditEvent) {
    const k = this.key(contract.tenantId, contract.id);
    if (this.contracts.has(k)) throw new Error('contract already exists');
    this.contracts.set(k, { issueId: contract.source.issueId, contract: structuredClone(contract) });
    this.audit.push(structuredClone(event));
  }

  async save(next: Contract, event: AuditEvent, expectedRevision: number, issueId: string): Promise<SaveResult> {
    const k = this.key(next.tenantId, next.id);
    const row = this.contracts.get(k);
    if (!row || row.issueId !== issueId || row.contract.revision !== expectedRevision) return 'CONFLICT';
    this.contracts.set(k, { issueId, contract: structuredClone(next) });
    this.audit.push(structuredClone(event));
    return 'OK';
  }

  async listPage(tenantId: string, afterKey: string | undefined, limit: number) {
    return [...this.contracts.entries()]
      .filter(([k, r]) => r.contract.tenantId === tenantId && (afterKey === undefined || k > afterKey))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, limit)
      .map(([key, r]) => ({ key, contract: structuredClone(r.contract) }));
  }

  async listAudit(tenantId: string, contractId: string, limit: number) {
    return this.audit
      .filter((e) => e.tenantId === tenantId && e.contractId === contractId)
      .slice(-limit)
      .map((e) => structuredClone(e));
  }
}
