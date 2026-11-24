# Security gate: P6 (scanner run + manual sweep), 2026-11-04

Scope: whole `app/` (manifest, src, tests excluded from scanning). Not deployed; no code changed by this slice. Independent third-party review: none.

## Scanner (FSRT) - what ran and what it can and cannot tell us
- Tool: `fsrt 0.1.0`, from `fsrt-tkallady-release-workflow-x86_64-pc-windows-msvc.zip` (4,433,280 bytes, SHA-256 `970c9195...cd83`, matched GitHub's published digest) at `github.com/atlassian-labs/FSRT` release tag `forge-security-review-test` (prerelease uploaded by one individual, 2026-06-01). The binary is **unsigned** (Authenticode NotSigned). Downloaded on operator approval into an empty scratch folder, run only against copies/`app/`, then deleted. Provenance is therefore weak: treat its output as one more signal, not as certification.
- Result on `app/` as-is: `{"vulns":[],"errors":false}`. **Not meaningful by itself**: positive controls showed the scanner does not follow our layout (`index.ts` re-exports `./resolvers`) and analysed nothing.
- Fix for coverage: scanned a COPY whose manifest handlers point directly at the defining files (`resolvers/index.handler`, `events/handlers.*`, `rovo/handlers.*`). Result: `{"vulns":[],"errors":false}` (saved: `fsrt-p6-scancopy-output.json`).
- Positive controls on that copy (never on the real code): injecting an `api.asApp().requestJira(... req.payload ...)` into a resolver, and into a Rovo handler, were each reported as High "Authorization bypass via asApp()". So the scan has demonstrated detection for the **resolver and Rovo-action entry points**; not demonstrated for trigger/scheduled handlers.
- Limits: FSRT checks a narrow set (mainly asApp authorization paths); it does not test tenant isolation, business logic, prompt injection or dependencies. `--check-permissions` (downloads swagger data) was not run. No Semgrep, gitleaks or Snyk were available.

## Manual white-box sweep (against docs/04-SECURITY.md themes and the Forge review rule headings)
| Area | Result |
|---|---|
| Entry points | UI resolvers (identity from Forge context only), 1 trigger (`avi:jira:updated:issue`, `ignoreSelf`), 1 hourly scheduled trigger, 3 Rovo GET actions. **No web triggers, no remotes, no `permissions.external`, no `fetch`, no egress.** |
| asUser vs asApp | Exactly one `asApp()` call in `src` (`adapters/forge-jira.ts`: batch JQL read for linked issues; ids re-validated as digits before JQL; only issues a user linked; result stored minimally and redacted per viewer). Everything user-facing uses `asUser`. |
| Tenant | Resolvers: `context.cloudId`; Rovo: platform `payload.context.cloudId` cross-checked with `installContext`; events: UUID parsed from `installContext`, fail closed. **Observation (low, unconfirmed):** the three paths normalise the tenant differently (events lowercase the UUID; the others use the value as given). Live data shows all three reach the same records, so no bug is known; a single `normalizeTenantId` would remove the doubt. Not changed here (altering stored keys is riskier than the doubt). |
| Secrets/egress | Grep for key/secret/password/bearer/private-key patterns in `src`: none. No secrets stored; no outbound calls. Scopes unchanged: `read:jira-work`, `read:servicedesk-request`, `storage:app`. |
| Injection | No `eval`/`new Function`/`innerHTML`/`dangerouslySetInnerHTML`; JQL built only from digit-validated ids; all client input parsed with Zod; storage keys built from validated ids/tenant. |
| Rovo | Read-only GET only, identity from platform context, per-viewer reads, untrusted-text labelling (see security-gate-P5.md; live scoping proof for A vs C). |
| Logging | Outcome codes/counts only; no payload, account or promise text (structured logs with correlation ids are slice 4). |
| Dependencies | See ADR-027 (accepted): 14 production advisories inherited from the Forge SDK; not called by our code; reachability inside Atlassian's renderer unproven. |

## Verdict
No critical or high finding from the scanner or the manual sweep. One low observation (tenant-id normalisation). Evidence gaps: scanner provenance, detection untested for triggers, no secret scanner, no independent reviewer, UI-Kit renderer behaviour with user text unverified. This supports "no known critical/high issue", not "secure".

## Addendum 2026-11-05: changes since the review above (logging, parallel reads, staging)
- **Logging (ADR-028):** reviewed `observability/log.ts` and every call site: fixed whitelist, no free-text field, errors reduced to a class name, tenant reduced to a short hash; tests scan live-shaped log output for planted sensitive strings and 6 mutations are caught. Grep of `src` after the change: remaining `console` lines carry static text or a status integer only.
- **Parallel reads (ADR-029):** still `asUser` for every user-facing read (the single `asApp` call in the batch issue-state reader is unchanged); concurrency capped at 6 per request; the order of checks that decides "issue unreadable" is preserved by capturing, not dropping, errors from the parallel permission and role reads (tests: unreadable issue refused even if its permission read throws; readable issue with failing permission read still throws). Redaction of evidence links, linked work and audit reports is covered by tests that were made non-vacuous.
- **Staging install:** the staging environment requests the same three scopes; no web triggers, no egress, no new modules since the review. Separate storage per environment (observed: staging started with no roles and no promises).
- **Re-check of dependencies (2026-11-05):** `npm audit` prod-only 9 high + 5 moderate (unchanged since ADR-027); all five Forge SDK packages are at their latest releases.
- **Live Rovo isolation re-confirmed in P6:** a user who cannot open an issue was refused by the action and saw no content (P5 evidence), and as A and C the actions ran as the invoking user. New residual items from this phase: none that change the verdict; the open items in the verdict section still apply.
