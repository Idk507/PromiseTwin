# Security gate — P2 (2026-11-03): manual review of changed boundaries

Scope: `src/events/*`, `src/service/linked-work-sync.ts`, `contract-service.ts` (link/unlink/refresh/redaction), `src/adapters/kvs-link-stores.ts`, `forge-jira.ts` (`ForgeJiraApp`), `kvs-contract-repository.ts` (`listPage`), domain (`SYSTEM` role, `OBSERVE_LINKED_WORK`), manifest (`trigger`, `scheduledTrigger`). Method: manual white-box review, targeted tests, mutation checks. **Not run:** FSRT/Semgrep/gitleaks on P2 code, any live test.

## Execution map (new)
Jira event (`avi:jira:updated:issue`, platform-signed, no user) -> `onIssueUpdated(event, context)` -> tenant from `context.installContext` -> `LinkedWorkSync.handleIssueUpdated` -> index read -> create-only inbox write -> `asApp()` read of the linked issue by numeric id -> `OBSERVE_LINKED_WORK` (role SYSTEM) -> revision-checked save. Hourly `reconcileSweep` -> same service, enumerating contracts. UI `refreshLinkedWork` resolver -> same service for one contract. No web triggers, remotes, egress, or new scopes.

## Controls checked (each covered by tests and mutation checks unless noted)
- **Privilege boundary:** `SYSTEM` is unreachable from users (`resolveRoles` never returns it; client command schema has no OBSERVE; domain role table lists SYSTEM for exactly one command; users with every role are refused). SYSTEM cannot run any user command.
- **No lifecycle/proof effect:** OBSERVE cannot change lifecycle, evidence, acknowledgement, criteria or fulfilment in any state; Done linked work cannot satisfy a criterion.
- **Untrusted event input:** payload is only a hint; tenant from Forge context (fails closed if unparseable); issue id must be digits before any read; authoritative state re-read; schema-validated responses; malformed items ignored.
- **Injection:** JQL is built only from digit-validated ids; issue keys regex-validated; storage key segments strictly validated (no `#` escape) in every new key builder.
- **Authorization:** linking requires the user to read the issue now and the snapshot is server-observed (client values ignored); role check happens before any Jira read; linked issues a viewer cannot read are removed from that viewer's copy (key and status never leave); refresh requires an issue-scoped contract and a role.
- **Idempotency / ordering:** create-only inbox (FAIL_IF_EXISTS + TTL), deterministic event ids, domain-level monotonic ordering, replay and stale observations are no-ops.
- **Abuse limits:** <= 10 links/contract, <= 20 contracts/issue, sweep <= 50 contracts and <= 50 issue reads per run with a cursor that cannot starve, one retry then defer on conflicts (no tight loops), unlinked issues cost one read.
- **Logging:** outcome codes and counts only (no ids, keys, statuses, summaries).
- **Multi-tenant:** per-installation storage plus tenant in every key; event for another tenant touches nothing; stored tenant re-checked on every read.

## Confirmed exploitable findings
None identified in code reviewed. Live behaviour is unverified.

## Concerns (need validation / operator decision)
1. **Tenant derivation from `installContext` is unverified** (ARI shape/case). Failure mode is fail-closed (events ignored), but then P2's event path would silently do nothing until fixed; the reconcile sweep and Refresh use the same derivation for the sweep, while Refresh uses the resolver's `cloudId` and is unaffected. Must be confirmed by a live event.
2. **asApp reads of linked issues.** The app reads any issue a user linked, regardless of that issue's permissions, then stores only status name/category and `updated`. Display is redacted per viewer, but the stored snapshot exists. The linker had read access at link time; later loss of the linker's access does not purge the snapshot (it is visible only to users who can read the issue). Accepted design, flagged for operator awareness.
3. **Cost / invocation volume:** every issue update on the site invokes the trigger function (cannot be narrowed using my storage). Possible mitigation: `filter.expression` by project once the target project is fixed (not applied; would hide links to other projects).
4. **Refresh has no throttle** (bounded per call, not per user per time).
5. **Interim roles (ADR-010)** still allow any two editors to complete a flow; unchanged by P2.
6. **Dependencies:** no new packages in P2; advisory position from P1 (ADR-008 + `@forge/kvs`) unchanged and not re-accepted by the operator.
7. Logical audit trail is not tamper-proof (unchanged).

## Evidence gaps
No live run; FSRT not run on P2; no flood test; event payload shape and tenant equality unverified.

## Addendum after live run (2026-11-03)
- Concern 1 RESOLVED: a real event changed the snapshot (`applied=1`, `tenantParsed=true`), so the tenant derived from `installContext` matches the stored `cloudId`.
- Live: observation recorded linked-work progress and set AT RISK without touching lifecycle or evidence; hourly sweep and Refresh ran with codes/counts-only logs.
- Still unverified live: duplicate delivery (refused create-only write), live redaction for a user without access to the linked issue, `ignoreSelf`, flood/volume, and FSRT on P2 code. Concerns 2-4 (asApp read scope, trigger volume/cost, no refresh throttle) still need operator acceptance.

## Verdict
**Conditional.** No release-blocking finding from review or from the live run; not signed until the operator accepts concerns 2-4 and the remaining live gaps are either closed or accepted.
