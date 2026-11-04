import { kvs, WhereConditions } from '@forge/kvs';
import { seg } from './keys';
import type { EventInbox, LinkIndex, SweepState } from '../service/ports';

// Plain Key-Value Store (no entity declarations, so nothing permanent is added to the manifest).
// Per-installation isolation is provided by Forge; tenantId is also in every key (defence in depth).

const INBOX_TTL = { unit: 'DAYS', value: 7 } as const;
const MAX_PAGES = 3;

export class KvsLinkIndex implements LinkIndex {
  private key(t: string, linked: string, ci: string, c: string) {
    return ['link', seg(t), seg(linked), seg(ci), seg(c)].join('#');
  }

  async add(t: string, linked: string, ci: string, c: string) {
    await kvs.set(this.key(t, linked, ci, c), 1);
  }

  async remove(t: string, linked: string, ci: string, c: string) {
    await kvs.delete(this.key(t, linked, ci, c));
  }

  async contractsFor(t: string, linked: string) {
    const prefix = ['link', seg(t), seg(linked), ''].join('#');
    const out: Array<{ contractIssueId: string; contractId: string }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
      if (cursor) q = q.cursor(cursor);
      const res = await q.getMany();
      for (const r of res.results) {
        const parts = r.key.split('#'); // link, tenant, linked, contractIssueId, contractId
        if (parts.length === 5 && parts[0] === 'link' && parts[1] === t && parts[2] === linked) {
          out.push({ contractIssueId: parts[3]!, contractId: parts[4]! });
        }
      }
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return out;
  }
}

export class KvsEventInbox implements EventInbox {
  /**
   * Atomic first-writer-wins using `keyPolicy: 'FAIL_IF_EXISTS'`. The exact error a refused write
   * raises is not relied on: after ANY failure we re-read, and only treat the event as a duplicate
   * if the key really exists; otherwise the error is real and is rethrown (Forge retries).
   */
  async claim(key: string): Promise<boolean> {
    try {
      await kvs.set(key, 1, { keyPolicy: 'FAIL_IF_EXISTS', ttl: INBOX_TTL });
      return true;
    } catch (err) {
      const existing = await kvs.get(key);
      if (existing !== undefined) return false;
      throw err;
    }
  }
}

export class KvsSweepState implements SweepState {
  private key(t: string) {
    return ['sweep', seg(t)].join('#');
  }
  async get(t: string) {
    const v = await kvs.get<string>(this.key(t));
    return typeof v === 'string' ? v : undefined;
  }
  async set(t: string, afterKey: string | undefined) {
    if (afterKey === undefined) await kvs.delete(this.key(t));
    else await kvs.set(this.key(t), afterKey);
  }
}
