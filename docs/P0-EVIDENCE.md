# P0 evidence log (2026-11-01)

Only items marked **VERIFIED** were executed or read from a tool response in this session.

## Prerequisites
| Item | Result | Evidence |
|---|---|---|
| Node | VERIFIED v22.19.0 (Forge guide: 22.x/24.x supported) | `node --version` |
| npm / git | VERIFIED 10.9.3 / 2.51.0 | CLI |
| Forge CLI | VERIFIED 14.2.0 installed; 15.0.0 available (CLI warns outdated; 6-month support window per guide) | `forge --version` |
| Forge login | VERIFIED logged in (account email recorded in CLI output; not repeated here) | `forge whoami` |
| Developer Space | **BLOCKER**: `forge developer-spaces list` → not a member of any space. `forge create --personal -y` still demands a space and fails in non-TTY ("Name your Developer Space" prompt). | CLI output |
| App registered / scaffolded | **NOT DONE** (blocked above). `app/` does not exist. | `ls app` |
| Deploy / install / live JSM read | **NOT DONE** — no app, no operator approval requested yet | — |

## Forge capability facts (from Forge MCP docs tools, current as of tool date 2026-08)
- JSM modules exist: `jiraServiceManagement:portalRequestDetail`, `portalRequestDetailPanel`, `portalRequestViewAction`, `queuePage` (agent-side Apps nav), etc. Portal modules expose `request.key`, `portal.id`, `request.typeId` in extension context; support `unlicensedAccess: [customer]`.
- Jira agent-side: `jira:issuePanel`, `jira:issueContext`, `jira:issueActivity`, `jira:globalPage`, `jira:projectPage`.
- Rovo: `rovo:agent`, `rovo:mcp` (Preview), `action`. Teamwork Graph: `graph:connector`, `graph:smartLink`. Platform: `trigger`, `scheduledTrigger`, `sql` (Preview), KVS, `llm`.
- Scopes (via `get-api-required-scopes`, classic recommended):
  - `GET /rest/api/3/issue/{key}` → `read:jira-work`
  - `GET /rest/servicedeskapi/request/{key}` → `read:servicedesk-request`
  - `POST /rest/api/3/issue/{key}/remotelink` → `write:jira-work`
- JSM permissions are not overridden by scopes (Atlassian JSM scopes doc). `.asUser()` preferred; `.asApp()` requires own authorization checks (matches PromiseTwin invariant "tenant access enforced server-side").
- Scope changes in manifest block `forge deploy` until `--approve MAJOR_VERSION_RULE`, then `forge install --upgrade`.
- `forge lint` needs a registered app.

## Competitive gap (INCOMPLETE)
Two web searches returned no evidence of a first-party Atlassian "customer promise / evidence-gated fulfillment" feature, but results were generic (SLA legal pages, roadmap snippets). **Absence of results is not proof of absence.** Needs a deliberate pass over JSM release notes, Marketplace listings (SLA/commitment apps), Rovo agent library, and Codegeist 2026 official rules/deadline (not found; only 2025 pages surfaced). No go/no-go can be signed yet.

## Not yet verified
Rovo/Graph/MCP entitlement; JSM project on target site; Codegeist 2026 eligibility; demo-site availability (`--demo-site` chosen by operator, unattempted).
