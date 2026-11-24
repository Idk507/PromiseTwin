# PromiseTwin: project status

Updated 2026-11-06 (P7 in progress). Older entries, written phase by phase, are in [HISTORY.md](HISTORY.md). Every claim below is backed by an evidence file; "not verified" means exactly that.

## Where we are
**P6 is SIGNED OFF (2026-11-05). P4 is still not signed off.** P7 (production deploy, Sharing link, install test, submission texts, video) is **in progress**: production v2.0.0 is deployed, the install link exists, and the guide was followed on a fresh site by the builder. Deadline: Codegeist submission **22 Dec 2026 12:00 PT** (target submit 18 Dec; dry run 15 Dec).

| Phase | State | Evidence |
|---|---|---|
| P0 feasibility | Closed (operator GO 2026-11-02) | P0-EVIDENCE.md |
| P1 domain + audited commands | Signed off 2026-11-02 | P1-EVIDENCE.md |
| P2 linked work + events + sweep | Signed off 2026-11-03 | P2-EVIDENCE.md |
| P3 evidence verifier + app roles | Signed off 2026-11-03 | P3-EVIDENCE.md, P3-EVALUATION.md |
| P4 product UI (panel, portfolio, judge guide) | Built, deployed, live-verified; **not signed off** (no unfamiliar-user run) | P4-EVIDENCE.md, P4-JUDGE-GUIDE.md |
| P5 Rovo (read-only agent) | Signed off 2026-11-04 | P5-EVIDENCE.md |
| P6 hardening + clean install | Signed off 2026-11-05 | P6-EVIDENCE.md, security-audit-artifacts/security-gate-P6.md |
| P7 submission | In progress: production deployed, Sharing link created, install from link verified on a fresh site, scenario steps 1-7, 9, 10 verified live; video, Devpost form, tester run, critic rerun pending | docs/P7-EVIDENCE.md, docs/P7-PLAN.md |

## What exists
- Forge app (UI Kit panel + project page, resolvers, issue trigger, hourly sweep, three read-only Rovo actions + one Rovo agent), Node 24 runtime, scopes `read:jira-work`, `read:servicedesk-request`, `storage:app` only.
- Code: `app/`. Branch `p5-rovo-read-only` (local, **not pushed**; the public GitHub repo already contains two email addresses, so do not push as is). Tag `rc1` = the deployed code. Everything since is docs/submission only.
- Checks last run 2026-11-05 (tag `rc1`): `npm run check` = strict `tsc` + frontend ESLint + **489/489 tests**; `forge lint` clean. No code changed since.
- Installs (`forge install list` 2026-11-06): production v2 on **promisetwin-judge-test.atlassian.net** (fresh site, installed from the sharing link); production, staging and development all on **one-atlas-vebc.atlassian.net** (demo site; production added 2026-11-06 for the Rovo check).
- Console: distribution "Sharing with anyone", Jira; details and privacy/terms URLs (hosted gist) saved; stores personal data = Yes. The install link is not stored in the repo.

## Verified live on the production install (fresh site, builder-run, two of the builder's accounts)
Install from link (took several minutes), consent screen = the three scopes, default deny, role assignment, draft to fulfilled with the evidence refusal, "evidence changed" after fixing the issue, Review required after removing the label, Promises page filters. Setup used a few REST calls (issues, label, link, transition). Not run: owner self-acknowledge refusal (step 8). See P7-EVIDENCE.md.

## Findings from the install test
- Fresh JSM site has no Jira resolutions: added "Done" on the test site; guide step added.
- Install from link is slow and a second click is refused as a conflicting task (guide updated).
- Rovo chat is unavailable on the fresh site; the production agent did not appear on the demo site (only staging answered). Best Agents claim is worded as staging/dev-verified only.
- Personal data: the app stores account IDs but does not use the personal data reporting API (ADR-031, accepted gap, stated in Devpost and privacy text).

## Measured (small samples; one site; see P6-EVIDENCE.md for limits)
- Issue panel load (function time): median 2233 ms before, 980 ms after parallel Jira reads (n=3 each). Portfolio about 0.9-1.1 s. Rovo action about 1.6-2.5 s.
- Hourly sweep: 12 clean runs in 12 h, about 2 s each, 7 contracts.
- Test generators: 19,049 random commands with 0 invariant violations; 8,000 hostile inputs with 0 throws or leaks (computed in tests, not live).

## Open items (honest list)
1. **P4 gate:** nobody except the author has followed the guide; needs a person who did not write the code.
2. **Rovo on production** unverified (above).
3. **Not run live:** owner self-acknowledge refusal, duplicate event delivery, phone, keyboard and screen-reader use.
4. **Dependencies:** `npm audit` prod-only 9 high + 5 moderate, inherited from `@forge/*` (ADR-027); re-check before submission.
5. **Security review** is manual plus one unsigned FSRT build; no independent reviewer.
6. **Operator-only:** send the Devpost clarification email (submission/CLARIFICATION-REQUEST.md); decide the AI-assistance statement, licence, repo link/privacy, team line; check the Billing Console; record and upload the video; submit on Devpost.
7. **Demo site** now has three environments installed; decide what to uninstall before recording.

## Decisions waiting for you
- How to close P4 (a real stranger, or accept as is).
- Whether to push the branch (needs the public-repo emails dealt with first: make private, scrub, or leave).
- Whether to uninstall production/staging/development on the demo site.

## Accounts used for tests
A = Dhanushkumar R (app owner); B = Dhanush Kumar (account B; Reviewer + Acknowledger on the fresh site); C = serpentidk (site admin and Support owner on the fresh site). The pane keeps one login at a time; the operator signs in on request. No credentials are ever entered by the agent.

## Next minimal action
Read the critic's rerun on the submission texts, fix what it finds, then the operator's own steps (item 6). Production stays frozen except for fixes to a break.
