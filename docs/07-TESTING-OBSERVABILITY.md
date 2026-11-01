# Test and operations strategy

Unit tests: pure state machine transitions, criteria evaluation, same-customer binding, stale evidence and role decisions. Adapter contract tests: mocked Jira/JSM HTTP payloads must be based on captured sanitized responses from live dev site, not imagined fixtures. Integration: disposable dev site, actual JSM request and Jira issue, event -> reconciliation -> contract refresh. E2E: Playwright if reliable, otherwise documented supervised manual click script.

Negative tests: Done without deployment, wrong customer, stale evidence, invalid acknowledgement actor, duplicate/out-of-order event, access denied, broken API, concurrent update. Ensure failure never moves contract to FULFILLED.

Operational logs must be structured `{correlationId,tenantHash,contractId,eventType,result,durationMs}` and avoid raw secrets/customer data. Counters: event_success, event_retry, policy_denial, verification_pending, verified, erroneous_fulfill (target zero in test suite). Error budget provisional until measured. Capture actual performance via test run. Use Forge logs/console and cost optimizer; inspect invocation and storage quotas in official docs.
