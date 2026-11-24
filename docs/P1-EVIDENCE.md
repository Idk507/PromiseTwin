# P1 evidence log (2026-11-02)

Only items marked **VERIFIED** were executed in this session. Everything else is stated as unverified.

## Built (all under `app/`)
| Layer | Files | Notes |
|---|---|---|
| Pure domain | `src/domain/contract.ts`, `lifecycle.ts`, `verification.ts` | Zod schemas, state machine, deterministic verifier. No Forge imports. |
| Service | `src/service/contract-service.ts`, `roles.ts`, `ports.ts`, `memory-repository.ts` | Identity from Forge context only; ports for Jira and storage. |
| Forge adapters | `src/adapters/kvs-contract-repository.ts`, `forge-jira.ts` | Custom Entity Store (`contract`, `audit-event`), Jira via `asUser` only. |
| Resolvers / UI | `src/resolvers/index.ts`, `src/frontend/index.jsx` | `listContracts`, `createContract`, `applyCommand`; P0 `getRequestSnapshot` kept. |
| Manifest | `manifest.yml` | Adds `storage.entities` (2 entities, 3 attributes each, no custom indexes) and scope `storage:app`. |

## VERIFIED locally
- `npm test`: **116/116 pass** (was 111; +5 for idempotent create) across 5 files (domain lifecycle/verification, service, KVS adapter with mocked `@forge/kvs`, P0 snapshot, resolver security).
- `npm run typecheck` (tsc strict): clean. `npm run lint` (ESLint on frontend): clean.
- `forge lint`: no errors/warnings; one **approval** item (`MAJOR_VERSION_RULE`, scope modification) which blocks `forge deploy` until `--approve`.
- Mutation checks (guard deliberately broken, tests must fail, originals restored byte-identical): PENDING-counts-as-valid, skipped customer binding, skipped duplicate-event check, skipped role check, skipped version check, dropped issue scoping, dropped revision condition in KVS save, always-accessible source checks, skipped tenant re-check on read, `#` allowed in key segments. Every one was caught (1+ failing test each).
- Gate evidence: unit tests prove **Done != Fulfilled** (an issue/contract with no valid evidence cannot be fulfilled), **missing/unknown/expired/stale/wrong-customer/unauthorized proof fails closed**, illegal lifecycle skips are refused, unauthorized actors are refused, duplicate events are no-ops, stale revisions conflict.

## Storage facts taken from current Forge docs (not tested live)
- Plain KVS transactions have `set`/`delete` only, no conditions. Conditional writes (compare-and-swap) exist only in Custom Entity Store transactions via `Filter` conditions on declared attributes. => version check = condition `revision == expected`.
- Single-key writes are atomic; default conflict policy is last-write-wins; entity `get` is strongly consistent, `query` eventually consistent; entity integers are 32-bit; entity/attribute declarations cannot be deleted once deployed; custom indexes are irreversible once in staging/production (avoided).

## Superseded section below: items that were unverified before the live run are marked here
See 'Live results' for which of these were later verified.

## NOT verified before the live run
- That a failed condition actually rejects the transaction as assumed (adapter re-reads and compares revisions instead of relying on an error code).
- That `any`-typed attributes accept the nested contract object, and that `by-key` `beginsWith` queries behave as assumed.
- That the UI Kit panel renders and the buttons work (`Strong`, `Box`, `Inline alignBlock`, `crypto.randomUUID` fallback).
- Real two-user flow through Jira permissions (`mypermissions` mapping).
- Forge logs for the new resolvers.

## Known limitations (honest)
- **Interim roles (ADR-010):** any user with Jira EDIT_ISSUES gets AGENT+REVIEWER+ACKNOWLEDGER; APPROVER needs ADMINISTER_PROJECTS. Domain separation of duties (no self-review, no self-acknowledge) means two editors can still complete the whole flow. Real app-level role admin is not built.
- Only Jira issues can be re-verified as evidence sources; other source types always fail closed.
- `customerReference` is visible to anyone who can read the issue and hold a role; the "access-restricted" requirement in the data contract is not met yet.
- Per-issue contract cap (20) is approximate because listing is eventually consistent.
- No AI, no events/reconciliation, no external messages (later phases).

## Live results (2026-11-02, development v3.0.0 then v3.1.0, demo site one-atlas-vebc.atlassian.net, request ITS-6264, operator-signed-in browser pane)
VERIFIED live:
- Deploy v3.0.0 (`--approve MAJOR_VERSION_RULE`), upgrade-install granting `storage:app`; both entities' `by-key` indexes ACTIVE; later code-only deploy v3.1.0, install stays Up-to-date.
- Panel renders; `listContracts` on empty storage returns "No customer promises recorded" (entity-store query works).
- `createContract`: draft appears with CREATED audit event; stored through the conditional-capable transaction path.
- `applyCommand` CONFIRM (rev 1->2), START (->3), ADD_EVIDENCE (->4): revision increments each time, so the `revision == expected` conditional write succeeded live; audit trail lists every event.
- ADD_EVIDENCE bound the proof to Jira's `updated` timestamp of ITS-6263 (`2026-03-09T12:07:06`); evidence starts PENDING and proof status stays **missing** (unknown evidence does not count).
- **Negative path, live:** reviewing my own evidence was refused with `UNAUTHORIZED_ACTOR: SELF_REVIEW`; revision stayed 4, evidence stayed PENDING.
- `forge logs -e development`: `listContracts ok`, `createContract ok`, `applyCommand ok` x3, `applyCommand refused UNAUTHORIZED_ACTOR`; outcome codes only, no payload data.
- v3.1.0 idempotent-create path: one submission produced one contract, form cleared, one `createContract: ok` log line.

Found live and fixed: creating had no idempotency key. The three duplicate contracts seen came from three separate submissions (three `createContract` log lines) during slow-rendering form input, but a retry or double click could duplicate. Fix: `requestId` becomes the contract id; replay returns the existing contract; another user reusing the id gets VERSION_CONFLICT; UI reuses one id per form until success. 5 new tests plus two mutation checks (both caught). The replay path itself is unit-tested only; not exercised live.

NOT verified live (single account only):
- VERIFY, ACKNOWLEDGE, FULFILL, REOPEN, AMEND_CRITERIA, and a VERSION_CONFLICT from two tabs. Reaching VERIFIED needs a second reviewer; ACKNOWLEDGE needs a third person who is not the owner.
- That a failed condition rejects the transaction on a real stale write (conflict mapping is mocked-tested only).
- Real two-user permission mapping (`mypermissions`), forbidden-viewer behaviour, flood behaviour.
- `crypto.randomUUID` availability in the UI Kit runtime (a fallback exists; which path ran is unknown).

Test data left in the demo site's app storage (no delete command exists by design): 4 synthetic contracts on ITS-6264 (3 x SYNTHETIC-ACME, 1 x SYNTHETIC-GLOBEX). The first ACME contract is at IN_PROGRESS with one PENDING evidence item (ITS-6263).

## Live results, second user (2026-11-02, pane signed in as B = account B, "Dhanush Kumar")
Identity verified first via read-only `/rest/api/3/myself` + `mypermissions` on ITS-6264: B has BROWSE and EDIT_ISSUES, **no** ADMINISTER_PROJECTS (role Service Desk Team in IT Support). The pane had initially still been A; the check caught it and the run waited for the switch.
VERIFIED live as B on contract ACME #1 (created and advanced to IN_PROGRESS by A):
- Cross-user storage: B sees A's contract (rev 4) and is offered Valid/Invalid (roles resolved from B's own Jira permissions).
- REVIEW_EVIDENCE VALID by B (not the adder) allowed: rev 5, proof status **satisfied**, only blocker ACK_MISSING (source re-read as B matched the stored revision).
- MARK_DELIVERED -> DELIVERED, VERIFY -> VERIFIED: rev 7. Audit trail lists REVIEW_EVIDENCE, MARK_DELIVERED, VERIFY with timestamps.
- Logs: `applyCommand: ok` for both B commands; no payload data.
Observed (confirms ADR-010 limitation live): B, an ordinary editor, is also offered Acknowledge for this contract (B is not the owner), so with only two editors one can drive the whole flow. Acknowledgement by a distinct third user (C) is still planned.

## Live results, third user: full flow to FULFILLED (2026-11-02, pane signed in as C = account C)
Identity verified first (read-only): C = `account C`, BROWSE + EDIT_ISSUES, no ADMINISTER_PROJECTS. (An earlier attempt found the pane on a login chooser listing only A; no action was taken until the switch was confirmed.)
VERIFIED live on contract SYNTHETIC-ACME #1 (ITS-6264), by three distinct accounts:
- A (owner): CREATE, CONFIRM, START, ADD_EVIDENCE (ITS-6263); A's own review attempt refused (SELF_REVIEW).
- B (reviewer): REVIEW_EVIDENCE VALID, MARK_DELIVERED, VERIFY (rev 5 -> 7).
- C (acknowledger): ACKNOWLEDGE accept (VERIFIED -> ACKNOWLEDGED, rev 8, panel: "All gates satisfied"), FULFILL (-> FULFILLED, rev 9).
- Audit trail lists every step with timestamps; revision incremented once per mutation (conditional write held across three users); ITS-6264's Jira status was already Closed/Done long before: fulfilment came only from evidence + independent acknowledgement.
This demonstrates the P1 gate live: typed lifecycle, evidence re-verified at decision time, audited review, distinct-actor separation of duties.

## Stale proof and reopen, live (2026-11-02, pane as C)
- My scripted Jira REST PUT to edit ITS-6263 was denied by the permission classifier; not retried or worked around. The operator added the label `promisetwin-test` to ITS-6263 themselves, as C (screenshot supplied; also confirmed by a read-only API read: labels VIP + promisetwin-test, `updated` moved from `2026-03-09T12:07:06` to `2026-11-02T11:47:33`).
- **Stale proof VERIFIED live:** the FULFILLED contract now shows Proof status `stale` and `Blocked: CRITERION_stale:c1`; the record stays FULFILLED (history intact), the evidence item still reads VALID, but fulfilment no longer holds. Detected by re-reading the source as the acting user, not by any event.
- **REOPEN VERIFIED live (as C, with reason):** FULFILLED -> IN_PROGRESS, rev 9 -> 10, `applyCommand: ok` in logs, audit keeps the earlier FULFIL event and adds REOPEN, acknowledgement voided (`ACK_MISSING` blocker returns alongside the stale proof). UI took ~15 s to reflect it (slow render; the command had already applied).
- Pane tooling note: a page-opened popup tab paused scripting until the operator closed it.

## Still not verified live
- AMEND_CRITERIA (needs the APPROVER role = project admin, i.e. account A), a real two-tab VERSION_CONFLICT, forbidden-viewer (user without issue access), SELF_ACKNOWLEDGE refusal (unit-tested only), flood behaviour, FSRT on P1 code.
- A refused FULFIL on stale proof was not exercised live (the stale check was shown on the already-fulfilled record and on VERIFY/ACK gating in unit tests).
