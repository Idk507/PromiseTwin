# Architecture decision log

ADR-001: Forge-hosted TypeScript first, avoiding external infrastructure. Rationale: fewer deployment dependencies and reduced tenant data egress. Validate platform limits before finalizing persistence choice.

ADR-002: Separate engineering delivery from customer fulfillment. Critical invariant.

ADR-003: AI extraction is advisory and needs confirmation. Verification and authorization remain deterministic.

ADR-004: Store minimum necessary evidence metadata; source content remains inside Atlassian wherever possible.

ADR-005: Teamwork Graph and MCP are opt-in enhancements with feature flags, not MVP dependencies.

ADR-006 (2026-11-01, P0, proposed): Spike surface = `jira:issuePanel` (agent view, UI Kit) reading via `requestJira` `.asUser()` with scopes `read:jira-work` + `read:servicedesk-request` (+ `write:jira-work` only when remote-link write is tested). Alternatives: `jiraServiceManagement:portalRequestDetail` (customer-visible; defer, has unlicensed access implications). Evidence: Forge MCP scope lookups, see docs/P0-EVIDENCE.md. Impact: least scopes, user-permission enforcement. Rollback: remove module/scopes, redeploy. Status: not yet implemented or verified live.

ADR-007 (2026-11-01, P0): App registration blocked by missing Developer Space; operator chose personal app/demo site. Personal-app status may need migration to a Developer Space before Marketplace/Codegeist submission — unverified; confirm against Codegeist rules.

Add one entry per substantive choice with decision date, alternatives, evidence, impact and rollback.
