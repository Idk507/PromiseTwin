# Security gate: P5 (Rovo, read-only), 2026-11-04

Scope reviewed: `app/src/rovo/{actions,explain,handlers}.ts`, `manifest.yml` (rovo:agent, 3 actions, 3 functions), `src/index.ts`, the service paths they call (`list`, `portfolio`, `identify`, `view`). Manual review by me against docs/04-SECURITY.md headings; **no automated Forge security scanner (FSRT) was run**, and nothing was deployed. Independent review by another person or tool has NOT happened.

## Verdict
No critical or high finding remains in the reviewed code. One low-severity information disclosure was found and fixed during this review. Residual risks below are unverified live. This is a code review plus local tests, not proof of security.

## Checks
| Area | Finding | Evidence |
|---|---|---|
| Tenant separation | Tenant = `payload.context.cloudId` (shape-checked) that must be a suffix of the runtime `context.installContext`; storage keys use it. Spoofing the tenant would need both fields to be forged. | rovo-actions tests: wrong install context, malformed shapes refused |
| Identity | Account = runtime `context.principal.accountId`, must equal `payload.context.accountId`. Model-supplied top-level keys (`accountId`, `cloudId`, `tenantId`, `issueKey`) are ignored for identity. Live v3.9.0 probe confirmed principal = payload account for one invocation (as C). | tests + docs/P5-EVIDENCE.md |
| asUser vs asApp | Every Jira read in `list`/`portfolio` goes through `adapters/forge-jira.ts` `asUser`. No `asApp` on the Rovo path. If a call has no user token the read fails and the action refuses. | grep: asApp only in sync/event code |
| Trust in inputs | Inputs are selectors only, regex-validated, optional; platform context wins; authorization is always the service's per-viewer read of the source issue. | manifest test (no identity-named input), actions tests |
| Writes | None. All three actions are `GET`; the handler type is `Pick<ContractService,'list'|'portfolio'>`; no path to `apply`, `create`, `setRoles`. `list` and `portfolio` do not write. | manifest test, factory test |
| Prompt injection | User text (promise, customer, criteria) only inside `untrustedText`, flattened/truncated; reason sentences are deterministic and name criteria by id; the model has no write tool, so a fooled model can at most mis-narrate. | explain tests (hostile text) |
| Data minimisation | Citations only to source issue and evidence the viewer can read; hidden evidence/links are counts only; no audit events, accounts, or Jira content beyond stored promise fields already shown in the panel. | explain/actions tests |
| Logging | Outcome codes and error class names only. | `guarded()` |
| Scopes / egress | No scope change (`forge lint`: no approvals); no outbound calls. | manifest test + lint |
| Auditable mutations | N/A: no mutations. | |

## Finding fixed in this review
**L1 (low): hidden-count disclosure through a model-chosen project.** `list_at_risk` accepted a project key from the model; the portfolio's hidden count would tell a user that promises exist in a project they cannot read. Fix: the hidden count is returned only when the project comes from platform context; a model-chosen project returns rows the viewer can read (Jira enforces) and no count. Test added; mutation (always report the count) caught.

## Residual risks (not verified)
1. **Who is the principal when an agent runs from automation or another non-user trigger?** Docs say agents can run from automation rules. If there is no user principal, `rovoIdentity` refuses (fail closed) and `asUser` would fail; not tested live.
2. **Per-user scoping of `asUser` inside actions is unproven live** (needs an issue only one account can read): planned in slice 4. Until then, rely on the code path and the fact the same adapter serves the panel.
3. **`payload.context` provenance:** it is platform-injected alongside model inputs. The account cross-check against the runtime principal and the tenant cross-check against `installContext` mean a forged `payload.context` alone cannot pass. I have not seen Atlassian documentation guaranteeing this, only the observed live shape.
4. **Model faithfulness:** the model may narrate wrongly from correct facts. Controls are the facts and citations, not the prose.
5. **Availability/cost:** each call is bounded (20 promises per issue, 50 Jira reads per portfolio) but there is no per-user rate limit beyond platform limits.
6. Carry-overs: dependency advisories (ADR-008, `@forge/kvs`) still not re-accepted; FSRT not run on P2–P5 code; Rovo agents may be safety-screened or suspended by Atlassian.

## Required before any deploy
Operator approval of the exact deploy command; this document and the evidence file updated after the live slice-4 checks.
