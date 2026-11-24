# P2 evidence log (2026-11-03)

Only items marked VERIFIED were executed in this session. Nothing in P2 has been deployed or run live yet.

## Built (all under `app/`)
| Layer | Files | Notes |
|---|---|---|
| Pure domain | `src/domain/contract.ts`, `lifecycle.ts`, `time.ts` | `linkedWork[]` (defaults to `[]`, so P1 records still validate), commands `LINK_WORK`, `UNLINK_WORK`, system-only `OBSERVE_LINKED_WORK`, role `SYSTEM`. |
| Services | `src/service/linked-work-sync.ts`, `contract-service.ts`, `ports.ts`, `memory-stores.ts` | Event handling, bounded reconciliation sweep, user refresh, per-viewer redaction. |
| Adapters | `src/adapters/kvs-link-stores.ts`, `keys.ts`, `forge-jira.ts` (`ForgeJiraApp`), `kvs-contract-repository.ts` (`listPage`) | Plain KVS (no new entity declarations), create-only inbox. |
| Entry points | `src/events/handlers.ts`, `tenant.ts`, `wiring.ts`, `src/index.ts`, resolver `refreshLinkedWork` | Built per invocation, no module-level state. |
| Manifest | `manifest.yml` | `trigger` on `avi:jira:updated:issue` (`ignoreSelf`), `scheduledTrigger` hourly, 2 new functions. **No new scopes, no new entities.** |
| UI | `src/frontend/index.jsx` | Link/unlink, linked-work list labelled "progress only, not proof", hidden-link note, Refresh. |

## VERIFIED locally
- `npm test`: **234/234 pass** across 8 files (P1 had 116). New: domain linked-work (63), sync/service (38), storage adapters (17).
- `tsc --strict`, ESLint: clean. `forge lint`: **No issues found**, with no scope-modification approval item (confirms no new scopes are needed).
- Mutation checks (guard broken on purpose, tests must fail, originals restored byte-identical): domain D1-D7, service/sync/adapters S1-S12, plus the index-heal pair. All caught. One mutation (S12, tenant key-prefix filter) first SURVIVED because my test did not exercise it; the test was strengthened and the mutation is now caught.
- What the tests prove: observing linked work never changes lifecycle, evidence, acknowledgement, or fulfilment, in every lifecycle state, and a Done task never makes a promise fulfillable; only the SYSTEM role can observe and SYSTEM can run nothing else; users cannot reach OBSERVE; duplicate events are processed once; out-of-order observations never overwrite newer ones; an unlinked issue costs one index read (no inbox write, no Jira call); events for another tenant touch nothing; unreadable issues leave the snapshot alone (unknown, never "deleted/done"); a revision conflict is retried once then deferred (no loop); the sweep recovers a missed event AND a lost index row; the sweep is bounded (<= 50 contracts and <= 50 issue reads per run) and cannot starve later contracts; a healthy index is not rewritten; linking requires the user to read the issue and stores a server-observed snapshot (client-supplied status/ids ignored); users who cannot read a linked issue do not see its key or status.

## Facts taken from docs this session (not yet seen live)
- Trigger events can take up to 3 minutes to arrive; events over 200 kB are not delivered; trigger `filter` supports `ignoreSelf`, `appIsLicensed`, `expression`.
- Trigger context exposes `installContext` (an ARI), **not** `cloudId`. Tenant is derived from the ARI UUID and compared lowercase; if it cannot be derived, the event is ignored.
- `kvs.set(..., {keyPolicy: 'FAIL_IF_EXISTS', ttl})` fails if the key exists; TTL max one year; expired data deletion can lag up to 48 h.
- Scheduled triggers: intervals fiveMinute/hour/day/week, max 5 per app, start ~5 min after deploy, errors are not retried, any change resets all of them.
- `GET /rest/api/3/search/jql` needs `read:jira-work` (already held).

## NOT verified (needs a deploy, which needs operator approval)
1. That the tenant derived from `installContext` equals the `cloudId` the resolvers stored (case and format). If they differ, events would be ignored silently (fail closed); the log line `tenantParsed=true/false` shows parsing only, so live equality must be checked by an actual event changing a snapshot.
2. What error a refused `FAIL_IF_EXISTS` write raises (the adapter re-reads and does not depend on it).
3. That `avi:jira:updated:issue` arrives for a linked issue and that the payload shape matches what the handler reads (`issue.id`, `issue.fields.updated`).
4. That the asApp JQL batch read returns the fields expected, and how `updated` is formatted.
5. That the hourly trigger runs and the sweep works on real storage (`listPage` with `greaterThan`).
6. UI rendering of the new section and the Refresh button.
7. Event volume/cost on a busy site: every update to every issue invokes the trigger function. Filters cannot consult my storage, so this cost remains; the cheap path is one plain-KVS read.

## Live results (2026-11-03, development v3.2.0, demo site one-atlas-vebc.atlassian.net, pane signed in as B = account B, identity checked read-only first)
Deploy: `forge deploy --non-interactive -e development` -> v3.2.0, lint clean, **no scope/approval prompt**, install stayed Up-to-date (no `--upgrade` needed).
VERIFIED live:
- **UI + backward compatibility:** the new "Linked work (progress only, not proof)" section renders; a contract stored under P1 (rev 10, no `linkedWork`) loaded fine with the field defaulted.
- **Link:** `LINK_WORK` of ITS-6262 by B -> rev 11; snapshot read from Jira (`Resolved`, seen `2025-12-16T19:26`); audit entry present.
- **Refresh:** `refreshLinkedWork: ok` with no change (no new audit event). Exercises the asApp JQL batch read and the plain-KVS index query on real storage.
- **Event path, end to end:** the operator (as A, in their own browser) moved ITS-6262 from Resolved to In Progress at 14:17:33Z. At 14:17:36Z the log shows `issueUpdated: processed tenantParsed=true contracts=1 applied=1 unchanged=0 deferred=0 unreadable=0`, i.e. delivery took about 3 s (docs allow up to 3 min).
- **Tenant equality (ADR-016) confirmed:** `applied=1` means the contract was found using the tenant parsed from `installContext`, so it matches the `cloudId` the resolvers store.
- **Panel after the event:** contract rev 12, lifecycle still `IN_PROGRESS`, evidence unchanged, proof status unchanged (`stale` from the P1 test), new badge **AT RISK** (linked work regressed from done), linked item shows `In Progress`, audit has `OBSERVE_LINKED_WORK` at 14:17:36. Observation did not advance or fulfil anything.
- **Hourly sweep ran:** `reconcile: done tenantParsed=true contracts=4 issues=1 applied=0 unchanged=1` at 14:18:56Z (first run ~5 min after deploy, as documented). It scanned all 4 contracts via `listPage`, read 1 linked issue, found it already current. Confirms `listPage` (`beginsWith`) and the scheduled trigger work on real storage.
- **Logs** contain outcome codes and counts only.

NOT verified live:
- **Duplicate delivery:** none occurred, so the refused `FAIL_IF_EXISTS` write (and its error shape) was never exercised; only the first-delivery create-only write (`claim` -> true) succeeded. Duplicate handling is unit-tested only.
- **Missed-event recovery live:** the sweep ran but had nothing to repair (the event had already applied); recovery of a genuinely lost event is unit-tested only.
- **Per-viewer redaction live:** all current users can read ITS-6262, so no link was hidden. Unit-tested only.
- **`ignoreSelf`**, out-of-order delivery, a revision conflict, `listPage` resuming past 50 contracts, flood behaviour, and event volume/cost on a busy site.
- FSRT on P2 code.

Test data added on the demo site: ITS-6262 now has status In Progress (changed by the operator; it was Resolved), and the first SYNTHETIC-ACME promise links to it.

## Known limitations
- Link is app-owned (no Jira issue-link written); linked work is never evidence (by design).
- A snapshot is only as fresh as the last event/sweep/refresh; a lost event is repaired by the hourly sweep (or Refresh), not instantly.
- Linked-issue visibility is checked per viewer with extra Jira reads (<= 10 links x 20 contracts, memoized per request).
- Refresh has no per-user throttle (each call is bounded to the contract's <= 10 linked issues).
- Interim role model (ADR-010) and dependency advisory re-acceptance are still open from P1.
