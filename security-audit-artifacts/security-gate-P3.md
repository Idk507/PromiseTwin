# Security gate — P3 (2026-11-04): manual review of changed boundaries

Scope: `verification.ts` (predicates, decision report), `lifecycle.ts` (reports, CONTRIBUTOR), `contract.ts` (predicate schema, roles), `contract-service.ts` (identify/roles/redaction/evidence binding), `roles.ts`, `kvs-role-store.ts`, `forge-jira.ts` (extra fields), resolvers `getRoles`/`setRoles`, frontend. Method: manual white-box review, targeted tests, mutation checks, `npm audit`. **Not run:** FSRT/Semgrep/gitleaks on P3 code; any live test.

## Execution map (new)
Panel -> `getRoles` / `setRoles` -> `ContractService.roleAdmin/setRoles` -> `KvsRoleStore` (plain KVS). Evidence decisions: `applyCommand` (VERIFY/ACKNOWLEDGE/FULFILL) with facts from `ForgeJira.getIssueMeta` (asUser, one call, extra fields `labels,issuelinks,resolution`). No new modules, scopes, egress, or entities.

## Controls checked (each covered by tests; mutation-checked unless noted)
- **Predicates:** closed Zod discriminated union; no expressions or scripting; label values restricted to `[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}` (no spaces/quotes, never put into JQL/URLs); max 5 per criterion; unknown or unreadable facts fail every predicate (fail closed); only reviewed VALID, current, authorized evidence can be `satisfied`.
- **Customer binding:** evidence customer is set server-side from the contract; `CUSTOMER_LABEL` derives the label from the contract; an unusable customer name can never match a generic label.
- **Facts provenance:** read as the acting user (never asApp) in the same issue call used for authorization and freshness; malformed link/label shapes degrade to "none" so predicates fail rather than pass.
- **Roles:** default deny; effective roles = assigned (assignable set only) + APPROVER from the caller's own Jira project-admin permission; role assignment only by project admins checked server-side as that user, even for users holding every app role; APPROVER and SYSTEM unassignable at the API, dropped on read, and never persisted; per project and per tenant; account id pattern-validated; 200-assignment cap; every change appended to a log (`changedBy`, time); non-admins see only their own roles (no assignment list or history).
- **CONTRIBUTOR:** may add evidence only; cannot review (role check proven on evidence it did not add).
- **Separation of duties** unchanged and still enforced in the domain (no self-review, owner cannot acknowledge).
- **Decision reports:** bounded (<= 5 evidence per criterion, <= 30 blockers); content-free (whitelisted fields only; no summaries, promise text, or customer name); **redacted per viewer** for evidence issues the viewer cannot read.
- **Review required:** derived on read; never mutates, never reopens; fulfilment stays on record.
- **Key safety:** every new storage key segment validated (no `#` escape); roles/log values re-validated on read.
- **Logging:** `setRoles`/`getRoles` log outcome codes only (no account ids, no roles).

## Confirmed exploitable findings
None identified in code reviewed. Live behaviour is unverified.

Found and fixed during review: (1) decision reports exposed evidence keys/results to viewers without access to the evidence issues (now redacted per viewer, test + mutation); (2) a rollup reporting flaw hid the real failed check behind an old stale item (reporting only; satisfaction logic was never affected).

## Concerns (need decision / validation)
1. **Predicates rely on Jira data any editor can set** (labels, links). Observable and auditable, not tamper-proof. The product and demo should say so; defence is independent review + acknowledgement.
2. **Evidence list still shows evidence issue keys and revisions** to anyone who can view the promise (P1 behaviour; only reports and linked work are redacted). Low sensitivity, flagged.
3. **Roles bootstrap:** after deploy nobody but Jira project admins (ADMINISTER_PROJECTS) can act until roles are assigned. Intended (default deny), but the demo needs an assignment step. A project admin can assign themselves AGENT/REVIEWER/ACKNOWLEDGER; the domain still prevents self-review and self-acknowledgement.
4. **Role-change log and audit trail are not tamper-proof** (ordinary storage rows).
5. **No FSRT/automated scan** of P3 code; dependency advisories unchanged (ADR-008 + `@forge/kvs`, 9 high / 5 moderate transitive, no fix available) and still not re-accepted by the operator after P1.
7. **RESOLVED (ADR-024, operator-approved): minimum-proof policy now enforced at the service boundary** for new and amended promises (customer label + request link on every required criterion, any type); 12 tests + 6 mutations. Residual: the domain functions themselves stay lenient for legacy records, so new entry points must use the service schemas. Original finding: **Policy gap found in the final review: proof strictness is chosen by whoever creates the promise.** The API accepts a criterion with NO predicates (review-only, as in P1), so a Support owner can create a promise whose evidence needs no customer label, no link and no Done check; only the independent reviewer and acknowledger then stand between that and FULFILLED. The UI defaults all three checks on, but the server does not require them. Options: (a) leave as is and state it; (b) require `CUSTOMER_LABEL` (and `LINKED_TO_SOURCE`) on every new or amended criterion of type `LINKED_WORK`/`ARTIFACT` (rejected at the boundary; stored P1/P2 criteria stay valid); (c) a per-project minimum-proof policy set by project admins. Recommendation: (b), a small change with test updates, before the live run. Not implemented without your decision.
6. Unverified: `UserPicker` yields the documented `user.id`; if it yields something else the UI would send a bad id and the server would refuse it (INVALID_INPUT), failing closed.

## Evidence gaps
No live run; no flood test; event/sweep not re-tested after P3 changes; role admin UI never rendered.

## Verdict
**Conditional.** No release-blocking finding from review. Not signed until a deployed run shows default deny, admin-only role assignment, a real positive scenario, and real negative scenarios, and the operator accepts concerns 1-5.
