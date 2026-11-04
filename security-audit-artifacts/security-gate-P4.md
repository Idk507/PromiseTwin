# Security gate — P4 (2026-11-03): manual review of changed boundaries

Scope: `ContractService.portfolio` (new cross-issue read), resolver `getPortfolio` + `projectIdentity`, `manifest.yml` (+ `jira:projectPage`), `portfolio.jsx`, `index.jsx` redesign, `shared/messages.js`. Method: manual white-box review, targeted tests, mutation checks. **Not run:** FSRT/Semgrep/gitleaks; any live test; `npm audit` re-run.

## Execution map (new)
Project page -> `getPortfolio` (tenant, account, project key from Forge context; payload = opaque cursor only) -> `ContractService.portfolio` -> `ContractRepository.listPage` (tenant prefix) -> per project row: `getIssueMeta` as the acting user on the SOURCE issue (memoized, budgeted) -> row of stored facts. No new scopes, egress, entities, or app-level reads.

## Controls checked (each test-covered and mutation-checked)
- **Identity:** project key only from verified context, fail closed when absent; payload project/tenant/account ignored (M9).
- **Per-viewer authorization:** a promise is listed only if the viewer can read its source issue as that user; otherwise counted, never described; the payload contains no key/customer/text of hidden promises (M2).
- **Tenant isolation:** repository prefix plus an in-service check (M3, tested with a leaking repository); the cursor must start with the caller's tenant prefix and match a strict pattern (M6).
- **Project scoping:** only `<PROJECT>-n` source issues of the context project; other projects are not counted (M1).
- **Bounds:** 25 rows, 100 scanned, 50 Jira reads per request, resumable cursor, no silent drops (M4, M5, M8). Cost per request is bounded; a per-user request rate is not limited (platform concurrency applies).
- **Data minimization:** rows hold stored facts only: no evidence keys, no Jira content, no account ids.
- **Review-required** is derived for FULFILLED promises only; reads that cannot be afforded yield `unchecked` (never a guess); the portfolio changes no state (M10).
- **Messages:** unknown or hostile detail strings are dropped, never echoed; text never includes customer-supplied free text.
- **UI:** read-only page; links are relative `/browse/<KEY>` built from server-validated issue keys; the panel still sends commands the server re-checks.

## Confirmed exploitable findings
None identified in code reviewed. Live behaviour unverified.

## Concerns
1. **Assumption:** `extension.project.key` exists for `jira:projectPage` (documented for the settings page). Fails closed if not; verify live.
2. **Existence side channel:** the hidden count tells a viewer that N more promises exist in the project on requests they cannot open. Chosen for honesty; removing the count is a one-line change if it is considered sensitive.
3. **Customer and promise text is shown to anyone who can read the source issue** (same rule as the issue panel); a project-wide list makes that exposure easier to scan. Acceptable under the stated rule; flagged for the operator.
4. No per-user rate limit on `getPortfolio`; each call is bounded but repeatable.
5. FSRT not run; dependency advisories still not re-accepted.
