# P3 evidence log (2026-11-03/04)

Only items marked VERIFIED were executed in this session. **Nothing in P3 has been deployed or run live yet.**

## Built (all under `app/`)
| Area | Files | What changed |
|---|---|---|
| Checkable criteria | `src/domain/contract.ts`, `verification.ts` | `criterion.predicates[]` (closed set: `STATUS_CATEGORY_IS`, `RESOLUTION_SET`, `HAS_LABEL`, `CUSTOMER_LABEL`, `LINKED_TO_SOURCE`; defaults to `[]`), new criterion status `unmet` with per-predicate reasons, facts read in the same Jira call, unknown facts fail every predicate. |
| Customer binding | `contract-service.ts` | Evidence customer is set server-side from the contract; the client can no longer declare it. `CUSTOMER_LABEL` derives the required Jira label (`customer-<normalized name>`) from the contract. |
| Decision record | `lifecycle.ts`, `verification.ts` | VERIFY, ACKNOWLEDGE and FULFILL audit events carry a bounded, content-free `report` (criterion statuses, evidence keys, observed revisions, per-predicate booleans). Redacted per viewer. |
| Review required | `verification.ts`, view | Derived `reviewRequired` (+ reasons) for FULFILLED promises whose proof no longer holds. Changes nothing. |
| App-level roles | `roles.ts`, `kvs-role-store.ts`, `contract-service.ts`, resolvers `getRoles`/`setRoles` | Per-project assignments (AGENT, CONTRIBUTOR, REVIEWER, ACKNOWLEDGER) managed by Jira project admins; default deny; APPROVER derived from Jira admin; SYSTEM never assignable. Replaces ADR-010. |
| UI | `src/frontend/index.jsx` | Predicate checkboxes on create, per-criterion failure reasons in plain language, review-required banner, decision summary in the audit list, roles panel (UserPicker). |
| Evaluation | `tests/evaluation.test.ts`, `docs/P3-EVALUATION.md` | 30 labelled scenarios through the real command path; matrix and misfulfilment count computed by the run. |
Manifest unchanged (no new modules, scopes, or entity declarations).

## VERIFIED locally
- `npm test`: **364/364 pass** across 12 files (P2 ended at 234).
- `tsc --strict`, ESLint: clean. `forge lint`: **No issues found**, no approval item (no scope change).
- **Evaluation (computed, docs/P3-EVALUATION.md):** 30 scenarios: expected FULFILLED 4 -> predicted FULFILLED 4; expected BLOCKED 26 -> predicted BLOCKED 26; **misfulfilment 0**; mean 0.76 ms per scenario in memory. Covers the PRD list (missing deployment, stale test, incorrect customer, unrelated issue, duplicate events, contradictory evidence, permitted completion) plus forged evidence, self-review, owner acknowledgement, denied acknowledgement, unknown facts and hostile text. The verifier is deterministic, so agreement with labels is expected; this is coverage and regression protection, not a performance claim. No AI is evaluated.
- **Mutation checks** (guard broken, tests must fail, originals restored byte-identical): verifier V1-V10, roles/authorization R1-R13, all CAUGHT. Survivors found and fixed along the way: R6 (contributor review) survived because my test used evidence the contributor had added himself (self-review masked the role check); R2 pattern mismatch re-run; both now caught.
- **Independent differential check (added after the operator asked to review first):** `tests/verifier-fuzz.test.ts` compares the real verifier with a separately written naive oracle on **30,000 seeded random contracts** (random criteria, predicates, evidence, freshness, reviews, customers, facts, acknowledgements) and checks the real `FULFILL` command on **20,000 more**: **0 disagreements, and the verifier never fulfils a case the oracle rejects**. The generator exercises both outcomes (the test asserts enough fulfillable and enough blocked cases). Six further subtle verifier mutations (ignore terms version, ignore expiry, ignore INVALID review, skip acknowledgement version, tolerate one failing predicate, tolerate a missing source check) were each caught by the fuzz test on its own. Total tests: **366/366**.
- **Minimum-proof policy (ADR-024, after the operator's "enforce then deploy"):** new or amended promises are refused unless every required criterion has `CUSTOMER_LABEL` and `LINKED_TO_SOURCE` (detail names exactly what is missing; nothing stored); type cannot dodge it; optional criteria exempt; amendments cannot weaken; legacy stored criteria still evaluate. Tests now **378/378** (13 files); `forge lint` clean; policy mutations Q1-Q5 and create/amend caught; evaluation report regenerated (30 scenarios, misfulfilment 0). UI: customer label and request link are now mandatory text, "Done with a resolution" is the one optional checkbox.
- **Bugs found by my own tests and fixed:** (1) rollup reporting hid the actionable failed predicate behind an old superseded `stale` item (now `unmet` is reported over `stale`; satisfaction logic unchanged); (2) decision reports leaked evidence issue keys and per-check results to viewers who cannot read those issues (now redacted per viewer).
- Backward compatibility: all 234 pre-P3 tests passed unchanged against the rewritten verifier; stored P1/P2 contracts default `predicates: []`.

## LIVE results (development v3.3.x, demo site, 2026-11-03; observed in the browser pane, accounts A/B identified via /rest/api/3/myself)
- VERIFIED live: roles panel renders; default deny before assignment ("Your roles in ITS: APPROVER" only for admin A); `setRoles` saved B=REVIEWER, C=REVIEWER+ACKNOWLEDGER, A=AGENT; role log shows the changes; the earlier `LIST_QUERY_LIMIT_EXCEEDED` bug is fixed by the hotfix (paging at 100).
- VERIFIED live, as A (AGENT): create promise (customer SYNTHETIC-DELTA, mandatory label + link checks plus Done/resolution), confirm, start, add evidence ITS-6262 (In Progress, no label, no link), mark delivered.
- VERIFIED live, as B (roles: REVIEWER only): reviewer sees Valid/Invalid; marking the evidence VALID did NOT make proof pass. Proof status `unmet` with plain reasons: no customer label (`customer-synthetic-delta`), not linked to this request, not Done, no resolution. VERIFY was refused: `PRECONDITION_FAILED: CRITERION_unmet:c1, PREDICATE_FAILED:c1:CUSTOMER_LABEL, ...:LINKED_TO_SOURCE, ...:STATUS_CATEGORY_IS, ...:RESOLUTION_SET`; state unchanged (DELIVERED, rev 6).
- VERIFIED live, after the operator set ITS-6262 to Resolved/Done, linked it to ITS-6264 and added label `customer-synthetic-delta` (confirmed by read-only REST as B): the earlier VALID review became `stale` ("evidence changed or expired since review"), because the issue's `updated` revision moved. As B, fresh evidence (revision 11:34:33) was added as PENDING. B reviewing its own evidence: `UNAUTHORIZED_ACTOR: SELF_REVIEW`. B (REVIEWER only) creating a promise: `UNAUTHORIZED_ACTOR`, nothing stored.
- VERIFIED live, as C (roles REVIEWER + ACKNOWLEDGER, identity checked via /myself): reviewed the fresh evidence VALID (independent of B who added it) -> proof `satisfied` (only ACK_MISSING left) -> VERIFY (rev 9, audit "decision: c1=satisfied") -> ACKNOWLEDGE (rev 10) -> FULFILL (rev 11, "decision: c1=satisfied (all gates held)"). First live FULFILLED where proof rested on observed Jira facts (Done + resolution, customer label, link) plus independent review and acknowledgement, with decision reports in the audit trail. The pane noted a page script wrote to the clipboard on a click; not used.
- VERIFIED live, review-required: after the operator removed the label from ITS-6262 (read-only REST confirmed `labels: []`), the FULFILLED promise (rev 11, unchanged) showed "Review required: this promise is marked fulfilled, but its proof no longer holds" with reason `CRITERION_stale:c1` and "The fulfilment stays on record. Reopen the promise (with a reason) to re-verify it." Lifecycle and audit trail were not altered automatically. Note: the reason shown is `stale` (the evidence issue's revision moved after review), not the more specific failed-label predicate, because per-evidence freshness is checked before predicates; the safe outcome is the same, the explanation is less specific than it could be.
- NOT run live: owner A acknowledging (unit-tested SELF_ACKNOWLEDGE only), forbidden viewer, duplicate delivery, flood/cost, FSRT on P2/P3 code.

## Facts taken from live reads / docs this session
- Live (read-only, demo site): `labels` is a string array, `resolution` is an object or null, `issuelinks` entries are `{type, inwardIssue|outwardIssue:{key,...}}`; link types include `Deployments` and `Relates`; the three sampled issues (ITS-6262/6263/6264) have no links.
- Docs: UI Kit `Checkbox` (`label`, `isChecked`, `onChange(e)`), `UserPicker` (`label`, `name`, `onChange(user)` with `user.id`), `User` (`accountId`).

## NOT verified (needs a deploy, which needs operator approval)
1. Real Jira `issuelinks`/`labels`/`resolution` parsing against live issues (shapes match docs and a live read; behaviour in the app is unseen).
2. The roles panel: `UserPicker`, `Checkbox`, `User`, `Tag` rendering, and that `onChange` yields `user.id` as documented.
3. Default-deny flow on the real site: after deploy, B and C lose their implicit roles until a project admin (A, who has ADMINISTER_PROJECTS) assigns them. A also needs AGENT assigned to create promises.
4. Plain-KVS `list`/`history` queries for roles on real storage; the append-only role log.
5. Predicate results on real evidence (done + labelled + linked), and review-required on real storage.
6. Event/sweep behaviour is unchanged by P3 and was not re-tested.
7. Slice 5 (evidence-source observation by the sweep) was CUT as planned; review-required is derived on read only.

## Known limitations
- Predicates are only as strong as the Jira data editors can set (labels, links). Observable and auditable facts, not cryptographic proof; the control is facts + independent review + independent acknowledgement.
- Labels are case-sensitive; the customer label is `customer-` + lowercase letters/digits separated by dashes.
- Evidence entries (issue key and revision) still appear in the evidence list to anyone who can view the promise (unchanged from P1); only decision reports and linked work are redacted per viewer.
- A viewer who cannot read an evidence issue may see `review required` with an `unauthorized` reason (their view, not a defect in the proof).
- Role changes are logged append-only in storage but are not tamper-proof.
- Assigning roles to an account id the app cannot verify is possible (UserPicker supplies real ids; the server only validates the format).
- Interim ADR-010 model is replaced; unresolved: dependency advisories (ADR-008 + `@forge/kvs`) still need operator re-acceptance.
