# P0 evidence log (2026-11-01)

Only items marked **VERIFIED** were executed or read from a tool response in this session.

## Prerequisites
| Item | Result | Evidence |
|---|---|---|
| Node | VERIFIED v22.19.0 (Forge guide: 22.x/24.x supported) | `node --version` |
| npm / git | VERIFIED 10.9.3 / 2.51.0 | CLI |
| Forge CLI | VERIFIED 14.2.0 installed; 15.0.0 available (CLI warns outdated; 6-month support window per guide) | `forge --version` |
| Forge login | VERIFIED logged in (account email recorded in CLI output; not repeated here) | `forge whoami` |
| Developer Space | RESOLVED 2026-11-01: operator created `promisetwin-dev` (earlier blocker: `forge developer-spaces list` showed no space; `forge create --personal -y` failed in non-TTY at the space prompt) | CLI output; `forge developer-spaces list` shows promisetwin-dev |
| App registered / scaffolded | VERIFIED: registered by operator via interactive `forge create`; `app/` present, manifest inspected, scopes added via `forge lint --fix` | operator terminal output; `forge lint` → No issues found |
| Local checks | VERIFIED: vitest 13/13 (7 domain + 6 resolver-security), tsc strict clean, eslint clean | `npm test`, `npm run typecheck`, `npm run lint` |
| Deploy / install / live JSM read | VERIFIED 2026-11-01 (see sections below) | forge deploy/install output, panel screenshot, forge logs |

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

## Competitive gap (SUPERSEDED: see docs/P0-COMPETITOR-GAP.md; coverage still thin)
Earlier note: two web searches returned no evidence of a first-party Atlassian "customer promise / evidence-gated fulfillment" feature, but results were generic (SLA legal pages, roadmap snippets). **Absence of results is not proof of absence.** Needs a deliberate pass over JSM release notes, Marketplace listings (SLA/commitment apps), Rovo agent library, and Codegeist 2026 rules have since been read (deadline 22 Dec 2026 12:00 PT). Go/no-go is still the operator's.

## Not yet verified
Rovo/Graph/MCP entitlement; operator's Codegeist 2026 eligibility; installation-link feasibility for this app type.

## Deploy / install (2026-11-01)
- VERIFIED: `forge deploy --non-interactive -e development` -> v2.0.0 deployed (first attempt failed: noEmit in tsconfig; fixed).
- VERIFIED: `forge install --demo-site` initially failed 'No demo site found'; `forge site provision` created one (CLI reported timeout but job completed in background); install of dev env into Jira on one-atlas-vebc.atlassian.net completed with scopes read:jira-work, read:servicedesk-request.

## Live read (2026-11-01, built-in browser, operator-signed-in session)
- Demo site has ~10 `service_desk` projects (read-only `/rest/api/3/project/search`, 200). Used ITS-6264 (IT Support, status Closed; seeded demo data).
- VERIFIED: PromiseTwin panel (DEV badge) rendered on ITS-6264 showing: issue key + summary, `Issue status: Closed`, `Engineering done`, `Promise fulfillment: UNKNOWN`, `JSM request (type 171, portal status Closed)`.
- VERIFIED: `forge logs -e development --since 30m` -> `snapshot: issue=200 jsm=200` (status codes only, no bodies logged).
- Demonstrates invariant on real data: closed/done issue != fulfilled.
- NOT TESTED: non-JSM issue (expect jsm 404 -> not-a-jsm-request), user without access, remote-link write, customer-portal modules, Rovo/Graph/MCP.
- Note: onboarding screen on the demo site was answered by the operator, not by me.
