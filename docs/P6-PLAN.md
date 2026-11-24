# P6 plan (draft for operator approval, 2026-11-04): hardening and clean-install reproduction

Gate (plans/P6-HARDEN.md): "Documented test run, zero known critical failures, all core acceptance tests green; clean-install reproduction."
Status: NOT STARTED. Nothing below is implemented. P5 is signed off; **P4 is not** (see "Decisions"). Facts marked (run) were observed today with the command shown; (code) are from this repo; (docs) from this repo's own docs.

## Starting facts that shape the plan
- (run) `npm audit` today: **13 high, 9 moderate, 0 critical** (22 total). The earlier accepted figure (ADR-008) was 9 high + 5 moderate, so the exposure grew and the old acceptance is stale. Most are transitive through `@forge/*`; I have not yet analysed which are reachable in the Forge runtime.
- (run) `app/package.json` pins three **prerelease** packages: `@forge/react 12.4.0-next.3`, `@forge/bridge 7.2.1-next.13`, `@forge/resolver 2.0.2-next.0`. `npm view` shows **stable** releases exist: 12.4.0, 7.2.1, 2.0.2. Shipping prerelease builds to judges is an avoidable risk; moving to stable is the first thing to try (needs a full re-test and a dev redeploy).
- (code) `npm run lint` only covers `src/frontend/**`; `tsc` and ESLint on `src` are run by hand. There is no single `check` command a reviewer can run.
- (run) `.gitignore` lacks `app/.vitest/`; **nothing is committed to git** (the repo has 2 old commits and large uncommitted work). A fresh clone today would not contain the app.
- (docs) docs/STATUS.md says FSRT (Forge security scanner) has **never been run** on P2–P5 code; dependency advisories are not re-accepted; STATUS.md is one very long line.
- (docs) docs/07 asks for structured logs `{correlationId, tenantHash, contractId, eventType, result, durationMs}`, counters, and measured performance. Today's logs are outcome codes only (deliberate: no customer data), with no correlation id or duration.
- Live gaps carried forward (from P1–P5 evidence): owner self-acknowledge refusal live; forbidden-viewer on the panel live; hidden-count live; duplicate event delivery and flood live; Rovo as B; a non-empty at-risk list; a JSM portal/request-page invocation; an automation-rule invocation of the agent (principal unknown, code fails closed); P4 solo test and unfamiliar-user gate.

## Slices (each ends green before the next; cut line after slice 4)
0. **Clean-room baseline (local, no approval needed).** Copy the working tree to a new empty temp folder (excluding `node_modules`, `.forge`), then `npm ci`, `tsc --noEmit`, ESLint on all of `src`, `vitest run`, `forge lint`. Record exact versions and the first failure. Outcome: the real "does it build from scratch" answer, and a `check` script (`npm run check` = typecheck + lint-all + test) so anyone can repeat it. Cost: about half a day.
1. **Dependencies and toolchain.** (a) Move the three prerelease pins to stable (12.4.0 / 7.2.1 / 2.0.2), re-run everything; **dev redeploy needs your approval**. (b) Triage the 22 advisories: for each high, list package, path, whether it ships in the deployed bundle or is dev-only, and whether an upgrade removes it; apply only safe, tested upgrades; give you a short table to re-accept the remainder (ADR-008 update). I will not claim "no vulnerabilities". Cost: 1 day.
2. **Security scan and sweep.** Run the official Forge scanner (FSRT) on the whole app (the earlier download attempt left `%TEMP%\claude-fsrt-dl`; I will verify the tool source from official docs before running it, and run it inside its own empty folder). Fix or document each finding. Then a manual sweep against docs/04-SECURITY.md for the P2–P5 surface (event trigger, scheduled sweep, resolvers, Rovo actions) and a final `/security-gate` for P6. Cost: 1–1.5 days.
3. **Negative, race and replay suite.** Map every negative case in docs/07 to a named test and fill the gaps; at minimum: duplicate and out-of-order events, concurrent commands on one promise (two writers, one wins, no double transition), reconcile vs event race, stale evidence after label change, Done-without-proof, wrong customer, hostile text through every user-text field, oversized/garbage payloads to every resolver and action, storage limit behaviour at the existing caps. Add an invariant test that no sequence of random commands + events reaches FULFILLED without a satisfied verifier decision (extend the P3 differential fuzz to the full command/event machine). Report test counts as measured, not as a quality claim. Cost: 1.5–2 days.
4. **Observability and cost (measured, not guessed).** Add a tiny structured-log helper (correlation id from the invocation, tenant as a short hash, event/outcome, duration) to resolvers, the trigger, the sweep and the Rovo actions, with a test that no promise text, account id or token can appear in a log line. Then measure on the dev site: invocation durations and counts from `forge logs`, storage entries per promise, Jira reads per portfolio page; write the real numbers (with the date and data size) into docs/P6-EVIDENCE.md. If a number cannot be measured, say so. Cost: 1–1.5 days.
5. **Close live gaps (needs your sign-ins and approval to change dev data).** Run the missing live checks above as A/B/C, including: self-acknowledge refusal, hidden count, duplicate delivery (re-fire an issue update twice), the agent as B, an at-risk promise (link a task, change its status), and the agent from a portal request page. The automation-rule invocation is best-effort: if I cannot create such a rule safely I will say so and keep "fails closed (unverified)". Cost: 1 day plus your sign-ins.
6. **Clean-install reproduction.** Prove a stranger can install and use it. Two options (see Decisions): (a) a second Atlassian site if you have or can create one; (b) a Forge **staging** environment installed on the existing demo site after removing nothing from development: deploy `-e staging`, install, follow docs/P4-JUDGE-GUIDE.md literally from a clean browser profile, record every friction. Either way I will follow only the guide, not my own knowledge, and log where it fails. **Production deploy and Sharing links are P7 and are not done here.** Cost: 1 day plus your sign-ins.
7. **Close-out.** Rewrite docs/STATUS.md as a readable table (history moved to docs/HISTORY.md), update DECISIONS (ADR-008 re-acceptance, stable pins, logging), write docs/P6-EVIDENCE.md, list cleanup items, and a git plan. Cost: half a day.

Total about 7–9 working days of effort; elapsed time depends on your sign-in availability. With ~48 days to the deadline this leaves roughly 35 days for P7 (video, Devpost, production deploy/Sharing, mock judging) and slack.

## Manifest, scopes, storage
No new modules, scopes or entities planned. Slice 1 changes only dependency versions. Slice 4 adds log lines only. Any change that touches the manifest or scopes comes to you first.

## Security constraints
Same invariants as CLAUDE.md. No secrets in logs or evidence (screenshots and logs are sanitised); FSRT output is kept in the repo only if it holds no tenant data; no deploy beyond development (and staging if you choose option (b)) without approval; each deploy command is shown before running.

## Acceptance for the gate (what I will report, with evidence)
- Clean-room `npm run check` and `forge lint` pass from an empty folder; versions recorded.
- Zero known critical failures; every high finding fixed or explicitly accepted by you in writing in ADR-008.
- FSRT run, findings listed with disposition.
- All docs/07 negative cases mapped to passing tests; invariant fuzz result (iterations, 0 violations) reported as measured.
- Measured numbers in P6-EVIDENCE.md with their limits.
- Live gaps either closed (evidence) or listed as unverified with why.
- A clean-install reproduction log from a non-author path, with every friction item fixed or listed.

## Decisions needed from you
1. Approve this plan (and the cut line after slice 4: slices 5–6 are what I would protect if time shrinks, because the submission depends on them).
2. **Git:** may I `git add` and commit the work in logical commits on a new branch (not pushing)? A fresh clone of the repo is empty of the app today. Recommended: yes, before slice 0.
3. **P4 sign-off:** P4's open items are the operator solo test and the "unfamiliar user" gate. Options: (a) you run the solo test script from earlier and report; (b) accept P4 on the evidence with its stated gaps, as you did for P5; (c) fold the clean-install run in slice 6 into P4's unfamiliar-user gate (honest only if a person other than me follows the guide). Recommended: (c) plus (a).
4. **Clean-install target:** second site (best proof, needs you to create or provide a free site and to be its admin) or staging on the demo site (weaker proof, no new site needed). Recommended: second site if you can, otherwise staging.
5. **Dependency move** to stable `@forge/*` releases (slice 1a): approve the plan to try it; the dev redeploy gets its own approval.
6. Re-acceptance of the remaining advisories happens after the slice 1 table; not before.

## Risks
- Upgrading `@forge/*` could change UI Kit behaviour; the tests and a live panel check guard it, and I can revert the pins.
- FSRT may be unavailable or need an account; fallback is a documented manual review (weaker, and I will say so).
- A second site may be impossible on your plan; staging is the fallback and proves less.
- Rovo availability on a fresh site is not guaranteed (assumption confirmed only on the demo site); the plan records it instead of assuming it.
- Time: sign-ins as A/B/C are the bottleneck for slices 5–6.
