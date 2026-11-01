"""Conservative Claude Code guard hooks; reads JSON event from stdin.

Blocks a few explicitly destructive patterns but is not a complete shell sandbox.
Works on Windows/Python and does not make model calls. Human confirmation remains mandatory.
"""
import json
import re
import sys

BLOCKED = [
    r"(?i)\bforge\s+deploy\b.*(?:-e|--environment)\s+production\b",
    r"(?i)\bforge\s+uninstall\b",
    r"(?i)\bgit\s+push\s+--force\b",
    r"(?i)\bgit\s+reset\s+--hard\b",
    r"(?i)\b(?:rm\s+-rf|del\s+/s|Remove-Item\s+.*-Recurse)\b",
]

def main() -> int:
    """Read hook event, deny known risky commands, otherwise exit safely."""
    try:
        event = json.load(sys.stdin)
        mode = sys.argv[1] if len(sys.argv) > 1 else ""
        if mode == "pre":
            raw = event.get("tool_input") or {}
            command = raw.get("command", "") if isinstance(raw, dict) else ""
            if any(re.search(pattern, command) for pattern in BLOCKED):
                print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "Protected command: explicit human approval and manual execution required."}}))
                return 0
        elif mode == "session":
            print(json.dumps({"systemMessage": "PromiseTwin: read docs/STATUS.md and active phase; don't assume tasks completed."}))
        return 0
    except (ValueError, OSError, TypeError) as exc:
        print(f"Hook parsing failed: {exc}", file=sys.stderr)
        return 2

if __name__ == "__main__":
    raise SystemExit(main())
