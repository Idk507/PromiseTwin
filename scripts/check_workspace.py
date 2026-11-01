"""Check presence of the planning artifacts; no Forge operations performed."""
from pathlib import Path
import sys

def main() -> int:
    """Return nonzero when required project files are missing."""
    root = Path(__file__).resolve().parents[1]
    required = ["CLAUDE.md", "docs/STATUS.md", "plans/P0-FEASIBILITY.md", ".claude/settings.json", "submission/JUDGES-INSTALL.md"]
    missing = [name for name in required if not (root / name).is_file()]
    if missing:
        print("Missing:", ", ".join(missing))
        return 1
    print("Planning workspace structure: OK; Forge app not yet verified")
    return 0

if __name__ == "__main__":
    sys.exit(main())
