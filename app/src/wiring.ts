import { randomUUID } from 'node:crypto';
import { ContractService } from './service/contract-service';
import { LinkedWorkSync } from './service/linked-work-sync';
import { KvsContractRepository } from './adapters/kvs-contract-repository';
import { KvsEventInbox, KvsLinkIndex, KvsSweepState } from './adapters/kvs-link-stores';
import { ForgeJira, ForgeJiraApp } from './adapters/forge-jira';
import { KvsRoleStore } from './adapters/kvs-role-store';

// Composition root: the only place Forge adapters are bound to ports. Built per invocation, so no
// module-level state can leak between tenants or requests.

const clock = { now: () => new Date().toISOString() };

export function buildSync(): LinkedWorkSync {
  return new LinkedWorkSync({
    repo: new KvsContractRepository(),
    index: new KvsLinkIndex(),
    inbox: new KvsEventInbox(),
    jiraApp: new ForgeJiraApp(),
    sweep: new KvsSweepState(),
    clock,
  });
}

export function buildService(): ContractService {
  return new ContractService({
    repo: new KvsContractRepository(),
    jira: new ForgeJira(),
    clock,
    ids: { uuid: () => randomUUID() },
    index: new KvsLinkIndex(),
    sync: buildSync(),
    roles: new KvsRoleStore(),
  });
}
