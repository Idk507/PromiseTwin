# Security gate — P1 (2026-11-02), manual review of changed boundaries

Scope: resolvers, `contract-service.ts`, `kvs-contract-repository.ts`, `forge-jira.ts`, domain, manifest, frontend. Method: manual white-box review + targeted tests + mutation checks + `npm audit`. **Not run:** FSRT/Semgrep/gitleaks on P1 code; any live test.

## Execution map
UI Kit panel -> `invoke(listContracts|createContract|applyCommand)` -> resolver (identity from `req.context`: cloudId, accountId, extension.issue.key) -> `ContractService` -> `ForgeJira` (asUser only) + `KvsContractRepository` (entity store). No web triggers, events, schedules, remotes or egress. New scope: `storage:app` only.

## Findings
**Confirmed exploitable: none identified** in code reviewed; live behaviour is unverified.

Fixed during review:
1. Amplification: no cap on contracts per issue and up to 20 Jira reads per contract per list. Fixed: `MAX_CONTRACTS_PER_ISSUE = 20` (create refused, list truncated) and per-request memoization of source reads. Tests added.

Controls verified by test (and mutation-checked): identity never from payload; zod validation on every client payload; roles resolved server-side; separation of duties; tenant + issue scoping on every read (contractId from another issue/tenant is NOT FOUND); key-segment validation blocks prefix escape via `#`; stored data re-validated and tenant re-checked on read; revision CAS + audit written in one transaction; idempotent event replay; logs contain outcome codes only.

## Concerns (needs decision / validation)
1. **Interim role model (ADR-010):** any Jira editor holds AGENT+REVIEWER+ACKNOWLEDGER. Two colluding editors can drive a contract to FULFILLED on evidence they control. Mitigated only by separation-of-duties checks. Needs app-level roles before any real use. Severity: design limitation, not a code bug.
2. **`customerReference` confidentiality:** readable by anyone with issue access and a role. Data-contract requirement "access-restricted" unmet.
3. **Entity schema is permanent once deployed** (docs): wrong attribute choices cannot be undone. Kept to 3 attributes per entity.
4. **Dependencies:** `npm audit --omit=dev`: 9 high (unchanged, accepted for P0 in ADR-008), 5 moderate (was 4; `@forge/kvs` inherits the existing `@forge/api` advisory). npm's suggested "fix" is a downgrade to `@forge/kvs` 1.0.5, rejected. Re-acceptance by operator needed for P1 since a new package was added.
5. **Audit trail is logical, not tamper-proof:** records are ordinary entity rows; anyone with app storage access could alter them. Not claimed immutable.
6. Eventual consistency of `query` can briefly hide a just-created contract in lists and make the cap approximate.

## Evidence gaps
No live two-user test; no flood test; no FSRT run on P1; Forge KVS condition-failure behaviour unverified; UI not rendered.

## Verdict
**Conditional.** No release-blocking finding from review; cannot be signed until a deployed two-user negative-path test passes and the operator re-accepts the dependency position.

## Addendum after live run (2026-11-02)
- Live: SELF_REVIEW refusal confirmed on a real deployment; logs show outcome codes only.
- Found and fixed: non-idempotent create (see ADR-013). Mutation-checked.
- Still unverified live: forbidden-viewer, second-user flow, stale-write conflict, flood. FSRT not run on P1.
- Verdict unchanged: **Conditional.**
