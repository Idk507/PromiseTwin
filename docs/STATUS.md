# Project status

Status: **P0 IN PROGRESS — BLOCKED on Forge Developer Space. No app scaffolded, nothing deployed.**
Active phase: P0. Gate NOT met (needs working dev app with real request read, scopes, repro commands, competitor one-pager, go/no-go).

Verified (2026-11-01, see docs/P0-EVIDENCE.md): Node 22.19, Forge CLI 14.2.0 (15.0.0 available), CLI logged in, Forge MCP docs tools reachable, module keys and three candidate scopes confirmed from docs.
Not done: `forge create`, deploy, install, live JSM/Jira read, remote-link write, Rovo/Graph/MCP checks, competitive gap, Codegeist 2026 rules.

Blocker: account is in no Developer Space; `forge create` (even `--personal`) needs one and its prompt can't run non-interactively.
Operator decisions so far: register app as personal app under `app/`; use `forge install --demo-site` later (separately approved).

Next minimal action (operator): run in your own terminal `forge developer-spaces list`, and if empty run `forge create` once interactively from a scratch directory (or create a space at https://developer.atlassian.com/console), then tell me the space ID. I then run `forge create -t jira-issue-panel-ui-kit -d app -s <id> -y`, add the read spike, tests, `forge lint`, and ask approval before `forge deploy`/`install`.
