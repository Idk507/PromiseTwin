# Deploy, release and judges installation

Create dev/staging/production environments per current Forge CLI capabilities; never assume deployment target. Local workflow: `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `forge lint`, `forge deploy` to dev after operator confirmation, then `forge install` on dev site; check current CLI flags using `forge --help`. Deploy production only after explicit approval, scope review and fresh-site test.

Judges require an installation link: production deployment -> developer console -> Distribution -> Sharing -> choose compatible Atlassian products -> copy installation link. Note installing admins need sites with required products; multi-product apps need correct installation on each. App with Marketplace submission/licensing may have installation-link restrictions; verify beforehand. See https://developer.atlassian.com/platform/forge/distribute-your-apps/ .

Do not expose personal dev tenant data. Supply `submission/JUDGES-INSTALL.md` with installation prerequisites, minimal test data, expected user roles, feature flags, reset and troubleshooting. Clean-room test on a second site/tenant if accessible. Verify share link as someone other than contributor if possible.
