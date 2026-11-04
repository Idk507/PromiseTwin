# Security gate — P0 spike (2026-11-01)

Scope: `app/` (manifest.yml, src/resolvers/index.ts, src/domain/request-snapshot.ts, src/frontend/index.jsx). Method: manual white-box review per docs/04-SECURITY.md and the forge-security-review global baseline; targeted tests; `npm audit`. **FSRT:** run after operator approval (see below). **Not run:** Semgrep/gitleaks (not installed), live forbidden-user test.

## Execution map
Jira issue panel (UI Kit) → `invoke('getRequestSnapshot')` → resolver → `api.asUser().requestJira` ×2 (`/rest/api/3/issue/{key}`, `/rest/servicedeskapi/request/{key}`). No web triggers, scheduled triggers, events, storage, remotes, egress, or Rovo modules. No `permissions.external`. Scopes: `read:jira-work`, `read:servicedesk-request` (both confirmed required by `forge lint` and the scope lookup; no write scopes).

## Checks
| Area | Result | Evidence |
|---|---|---|
| asUser vs asApp | PASS: only `asUser`; Jira enforces viewer permissions | code; test "uses asUser only" |
| Trust in request fields / IDOR | PASS: issue key from Forge `req.context.extension`, client payload ignored | test "ignores a client-supplied issue key" |
| Missing context | PASS: throws, no Jira call | test "rejects when no issue key" |
| Forbidden viewer (simulated) | PASS: Jira 403 → throws, JSM not queried | mocked test only; live forbidden-user test NOT done |
| Error/log leakage | PASS: only status codes logged/thrown, no bodies | code; test "does not leak the response body" |
| Input validation | PASS: Zod on Jira/JSM responses; malformed → rejected/`unreadable` | tests in request-snapshot + resolver-security |
| Tenant isolation | N/A for P0: no storage, no module-level state, single-tenant install | code |
| Injection | No sinks (no SQL/eval/shell); `route` tag encodes the key | code |
| XSS | UI Kit `Text`/`Lozenge` only; no HTML rendering | code |
| Secrets | None in source/config; no env vars | grep of app/src, manifest |
| Egress / CSP | None declared | manifest |
| Scopes least-privilege | PASS for P0 | manifest |
| Mutations / audit | None in P0 | code |

Tests: `npm test` → 13/13 pass (7 domain + 6 resolver-security).

## Confirmed exploitable findings
None in application code.

## Security concerns (needs validation / operator decision)
1. **Dependency advisories — 9 high, 4 moderate (prod), 13 high (incl. dev), 0 critical.** `npm audit --omit=dev`: high in `@forge/react`, `@forge/bridge`, `@atlaskit/*` (adf-schema, adf-utils, editor-prosemirror, forge-react-types), `markdown-it` (quadratic-time DoS: GHSA-r7fv-28h4-cvq7, GHSA-vfgh-jcmw-g37q, GHSA-gfr2-rv44-r23c, GHSA-253c-mchw-3w2r), `prosemirror-view`. The app pins template `-next` builds; a scratch install of the latest stable `@forge/react@12.4.0`, `@forge/bridge@7.2.1`, `@forge/resolver@2.0.2` gives the **same 9 high** → no upgrade path today. Exploitability not demonstrated: the app never passes attacker-controlled markdown/ADF to these libraries (renders plain `Text` only) and they are platform-supplied UI Kit dependencies. Dev-only highs (brace-expansion, flatted, js-yaml, minimatch) are not shipped. Artifacts: `npm-audit-prod.json`, `npm-audit-all.json`.
2. Template pins `-next` prerelease `@forge/*` versions; consider stable (same advisories) for reproducibility.
3. Customer-visible surface (`unlicensedAccess`, portal modules) not used; re-run gate before adding.

## FSRT static analysis (operator-approved download)
Source: atlassian-labs/FSRT release `forge-security-review-test`, asset `fsrt-tkallady-release-workflow-x86_64-pc-windows-msvc.zip` (4,433,280 bytes, SHA-256 970C91957DF7DDBE23CC45716F16A88C10E8E080EFDC7B0DF2C3BDF726FFCD83; hash recorded, publisher signature not verified). The plugin's own `run_static_analysis.ps1` failed (`param` after `Set-StrictMode`: "$ForgeProjectRootDirectory cannot be retrieved"), so the same asset was downloaded and run manually from a scratch dir (%TEMP%\claude-fsrt-dl, still present, operator to delete). Result (`fsrt-output.txt`): `vulns: []`, `errors: false`, duration ~1 ms, **`scanned: [""]`**. Zero findings, but the empty scanned list means coverage of the `.ts` sources is NOT confirmed; weak evidence, not a clean bill.

## Evidence gaps
FSRT coverage unconfirmed; no live test as a user without access to an issue; no flood/rate test (P0 has no expensive query); no cross-tenant test (single install).

## Verdict
**Conditional.** Operator accepted the dependency-advisory risk for P0 on 2026-11-01 (ADR-008); FSRT coverage and live forbidden-user test remain open. No critical or confirmed-exploitable high risk in P0 code. Unresolved: high-severity transitive advisories without a fix (needs operator risk acceptance), FSRT result of doubtful coverage, and a live forbidden-user test (recommended before P0 sign-off).
