# 00 — Windows onboarding and first Claude Code session

## Preconditions
Use PowerShell and Node.js 22+; confirm `node --version`, `npm --version`, `git --version`, `python --version`, `claude --version`, `forge --version`. If missing, follow the official installer; never guess package versions. You need an Atlassian account, a development site with Jira and Jira Service Management, and suitable admin permissions. Availability of Rovo and Graph depends on your tenant and permissions.

## Installation
```powershell
npm install -g @forge/cli
forge login
forge site provision
```
`forge site provision` may require eligible accounts; if it fails, use an ordinary existing development site with admin permission. Open https://developer.atlassian.com/platform/forge/ai-development-toolkit/forge-ai-plugin/ and follow its current Claude Code plugin setup. The current official guide shows `/plugin install forge-skills@atlassian-forge-skills`; if marketplace not registered, follow its installation page, do not guess a marketplace alias. Verify by asking Claude Code `List Forge templates.`

In Claude Code, open this project directory, read `CLAUDE.md`, then invoke `/phase-runner` and ask for **P0 only**. Run `forge create` interactively following official Forge app-builder skill; scaffold inside `app/`, not at repository root. Have Claude inspect generated manifest before editing it. Avoid fake manifests with unverified modules or OAuth scopes. Test deploy/install before implementing AI.

## First prompts
```
Read CLAUDE.md, docs/00-START-HERE.md and plans/P0-FEASIBILITY.md. Run only P0. Use the official forge-app-builder skill and Forge MCP to validate the current CLI and modules. First produce an evidence table of prerequisites; then implement the smallest real JSM/Jira access spike. Stop at acceptance gate; write docs/DECISIONS.md and docs/STATUS.md with verified facts, limitations and next action. Do not deploy to production.
```

## Safety
Never paste API tokens, personal customer information or tenant secrets into LLM prompts, commits or log output. Create only synthetic demo records. Install external plugins only after reviewing scopes and publisher. All deployments, scope expansions and sharing links require operator confirmation.
