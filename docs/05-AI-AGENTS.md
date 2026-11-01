# Product AI architecture (distinct from Claude Code developer agents)

Phase 1 is manual contract entry, enabling deterministic demo without model dependencies. Phase 3 adds candidate extraction with structured output: promise statement, requested outcome, due date (if explicit), acceptance criteria, exact source citation, uncertainty and `humanReviewRequired=true`. Use a narrow JSON schema; reject invalid output and show user editable suggestions. No hallucinated due dates or acceptance tests.

Rovo Commitment Analyst receives only authorized contract summaries and permitted source links via read-only actions (`get_commitment`, `explain_missing_evidence`, `list_at_risk`). Keep global agent prompt short; use Rovo skills for workflow-specific explanations. Rovo action manifest must use currently documented keys; verify live docs and permissions. Optional Forge `rovo:mcp` can expose existing read-only actions to compatible clients; feature-flag separately.

Eval: create 30-50 synthetic JSM narratives with explicit/ambiguous/no promise; manually label fields; measure field precision/recall and unsupported inference. Include hostile instructions in narratives. Treat AI as optional advisory enhancement, never mutation approver. Record model/version, sanitized inputs hash, output schema success and evaluator run id; no raw PII logs.
