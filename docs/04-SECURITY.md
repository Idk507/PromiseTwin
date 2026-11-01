# Security architecture and test cases

Threat actors: malicious issue author, unauthorized colleague, compromised agent input, lost credentials, careless admin, cross-tenant caller. Assets: contract content, customer reference, evidence, approval, mutation functions.

## Enforcement
Require server-side tenant-scoped authorization for every operation and list query. Derive installation/account context from verified Forge context, never request body. Use access checks against underlying JSM/Jira resources and app-specific roles; verify each source link is accessible to requester. Avoid app-context access being confused with permission of the user. For elevated app-context functions, independently check user resource privileges and product support. Do not create customer portal without account model verification.

Data: minimize source bodies, use platform encryption, no tokens in records, no PII in trace logs; keep secrets in managed encrypted variables if needed. AI input must be quoted as untrusted and only used for candidate claims; source text must not set policies or invoke write operations. External model disabled by default; opt-in only after data residency/evaluation review.

Protect every mutation with Zod validation, CSRF/platform context expectations, authorization, expected version and idempotency key. Record append-only logical audit events and never claim tamper-proof immutable ledger without evidence. Sensitive admin settings restricted. Rate-limit expensive queries and dedupe events. Avoid prompt leaking private customer info in Rovo responses; use source-permission filtering before generation.

## Security tests
Cross-tenant read and write; forbidden JSM request view; object-ID enumeration; malicious instruction in ticket; agent invents evidence; wrong customer deployment; role bypass; outdated approval; replay duplicate; malformed payload; flood; secret scan. Every failed security test is a release blocker. Use official `forge-security-review` skill and manual adversarial tests; model review alone cannot establish safety.
