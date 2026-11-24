# Production release runbook (DRAFT 2026-11-06; nothing here has been run)

Purpose: the exact steps for P7 slice 2 so that each outward-facing action is shown to the operator before it runs. **No step below is started without the operator's explicit "yes" at that moment.** Nothing has been deployed to production yet (`forge environments list` shows production created on 2026-11-01 with no deployment; the console says "Last deployed to production: App not yet deployed").

## Preconditions (all must be true)
- [ ] Operator has named the tester and the tester has a fresh developer site (JSM, two accounts, neither an app contributor). Contributors page shows only the owner (checked 2026-11-06: 1 contributor).
- [ ] Console app details filled: support contact, privacy policy URL, terms URL; "Stores personal data?" answered by the operator (currently "No"; suggested "Yes").
- [ ] Billing Console checked by the operator (usage page shows $0 and tiny usage as of 2026-11-06).
- [ ] Code frozen at tag `rc1` (or a later tag created after a live-verified bug fix). Working tree clean; `npm run check` and `forge lint` pass in a fresh clone.
- [ ] `npm audit` prod-only re-checked (accepted baseline: 9 high + 5 moderate, ADR-027) and `@forge/*` versions re-checked.

## Step A: production deploy (approval needed; outward-facing)
Show the operator, then run from a fresh clone of the tag:
```
git clone --branch rc1 <local repo> %TEMP%\pt-prod && cd %TEMP%\pt-prod\app && npm ci
forge lint
forge deploy --non-interactive -e production
forge install list
```
Expected effect: production gets version 1.x of the app code with the same three scopes; nothing is installed anywhere yet (an install needs `forge install -e production` or the sharing link). Check the CLI output for any scope or egress warning (there should be none beyond the three scopes). Rollback: there is no "undeploy"; fix forward by deploying a corrected build, and set Distribution to "Not sharing" to stop new installs.

## Step B: Sharing (operator's own click; irreversible parts)
Developer console > Distribution > Distribution controls > Edit: choose **Sharing** (not "within organization"), confirm the app details, choose **Jira** only under "Install this app onto", Save, copy the link. Do not click "Generate new link" unless the old link must die (it cannot be undone). Record the link in the evidence file only; it goes public later, with the Devpost form.

## Step C: install test by the tester (no deployment by me)
The tester opens the link in a private window as admin of the fresh site, installs on **Jira**, reads the consent screen (expect exactly `read:jira-work`, `read:servicedesk-request`, `storage:app`), and follows `submission/JUDGES-INSTALL.md` with the second account. I observe and log friction, fix docs, and repeat once if needed.

## Step D: freeze and monitoring
After a successful test: no production deploy except to fix a break. Note that installed copies can be updated by bulk upgrades or rolling releases after a production deploy (Forge docs), so every later deploy reaches judges. Monitor read-only: `forge logs -e production --since 1h` and the console's invocation metrics.

## Reversal options
- Stop new installs: Distribution > Edit > **Not sharing** (existing installs keep working "in general").
- Roll back code: deploy the previous good tag to production (only with operator approval).
- Remove a test installation: `forge uninstall` on that site (data deletion behaviour not verified).
