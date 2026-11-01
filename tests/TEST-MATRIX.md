# Mandatory acceptance matrix

T01 Confirm promise from JSM -> CONFIRMED. T02 Jira Done alone -> not FULFILLED. T03 all correct fresh proofs + authorized acknowledgement -> FULFILLED. T04 wrong-customer evidence -> rejected. T05 stale proof -> rejected. T06 evidence without source authorization -> rejected. T07 duplicate event -> no duplicate state. T08 out-of-order event -> reconciliation correct. T09 cross-tenant user -> no access. T10 user without source permission -> no data disclosed. T11 prompt-injection in JSM description -> no action authorized. T12 revoked role -> cannot acknowledge. T13 unavailable Jira API -> pending not success. T14 requirement version changes -> old proof invalidated or requires review. T15 resume after process crash -> no duplicate mutation. T16 clean judge install -> documented fixture works.

Store actual execution date/environment and PASS/FAIL/SKIP evidence in docs/STATUS.md; no hypothetical PASS.
