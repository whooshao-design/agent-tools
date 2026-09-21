"""Structural lint for skills (borrowed from addyosmani/agent-skills' skill-lint):

- frontmatter name matches the directory; description exists, contains "Use when"
  and stays within 1024 characters;
- backticked skill-style references point at real skills (or a curated allowlist
  of non-skill identifiers);
- absolute references into this repository resolve to existing paths;
- a SKILL.md whose content changed against HEAD carries a bumped metadata.version.
"""

import re
import subprocess
from pathlib import Path
import unittest

REPO = Path(__file__).parents[1]
SKILLS = sorted(REPO.glob("skills/*/*/SKILL.md"))
FRONTMATTER = re.compile(r"\A---\s*\n(.*?)\n---", re.S)
DESC = re.compile(r"^description:\s*(.*?)(?=^\w[\w-]*:|\Z)", re.S | re.M)
VERSION = re.compile(r"^\s+version:\s*\"?([0-9][\w.\-]*)\"?", re.M)
REF = re.compile(r"`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`")
ABS_PATH = re.compile(r"/home/joney/projects/ai/agent-tools/[\w./\-]+")

# Identifiers that look like skill names but are gate names, categories, tools or
# schema names. Extend deliberately; do not silence a real dead reference here.
NOT_SKILLS = {
    "dev-workflow", "dev-quality", "solution-review", "test-design-review",
    "change-review", "requirements-review-round", "redis-cli", "query-range-batch",
    "java-backend-mcp", "verify-execute", "read-only", "write-set", "agent-tools",
    "direct-record-v1", "waiver-record-v1", "approval-record-v1", "repo-snapshot-v1",
    "delegation-result-v1", "producer-stage-result-v1", "auto-loop-run-v1",
}
SKILL_PREFIXES = ("dev-", "query-", "review-", "verify-", "lang-", "inspect-", "configure-",
                  "register-", "lexiao-", "handle-", "diagnose-", "java-", "jenkins-", "fix-",
                  "start-", "test-", "redis-", "spawn-", "build-", "debug-", "skill-",
                  "convert-", "manage-", "healthy-", "requirements-")


def frontmatter(text: str) -> str:
    m = FRONTMATTER.match(text)
    return m.group(1) if m else ""


def description(text: str) -> str:
    m = DESC.search(frontmatter(text))
    if not m:
        return ""
    return " ".join(line.strip() for line in m.group(1).strip().splitlines()).strip().strip('"').strip("'")


def git_show_head(path: Path) -> str | None:
    rel = path.relative_to(REPO).as_posix()
    proc = subprocess.run(["git", "show", f"HEAD:{rel}"], cwd=REPO, capture_output=True, text=True)
    return proc.stdout if proc.returncode == 0 else None


class SkillLintTest(unittest.TestCase):
    def test_frontmatter_name_and_description(self):
        problems = []
        for path in SKILLS:
            text = path.read_text(encoding="utf-8")
            fm = frontmatter(text)
            name = re.search(r"^name:\s*(\S+)", fm, re.M)
            if not name or name.group(1) != path.parent.name:
                problems.append(f"{path.parent.name}: frontmatter name missing or != directory")
            desc = description(text)
            if not desc:
                problems.append(f"{path.parent.name}: description missing")
            elif "Use when" not in desc:
                problems.append(f"{path.parent.name}: description lacks 'Use when' trigger")
            if len(desc) > 1024:
                problems.append(f"{path.parent.name}: description is {len(desc)} chars (> 1024)")
        self.assertEqual([], problems, "\n".join(problems))

    def test_backticked_skill_references_exist(self):
        known = {p.parent.name for p in SKILLS} | {"get-browser-session", "tapd-download", "gstack"}
        files = SKILLS + sorted(REPO.glob("skills/**/references/**/*.md")) + sorted(REPO.glob("agents/*/*")) + [REPO / "AGENTS.md"]
        problems = []
        for path in files:
            text = path.read_text(encoding="utf-8", errors="ignore")
            for ref in set(REF.findall(text)):
                if ref in known or ref in NOT_SKILLS or not ref.startswith(SKILL_PREFIXES):
                    continue
                problems.append(f"{path.relative_to(REPO)}: `{ref}` is not a skill (add to NOT_SKILLS if it is a tool or gate name)")
        self.assertEqual([], problems, "\n".join(problems))

    def test_absolute_repo_paths_exist(self):
        files = SKILLS + sorted(REPO.glob("skills/**/references/**/*.md")) + sorted(REPO.glob("agents/*/*")) + [REPO / "AGENTS.md", REPO / "README.md"]
        problems = []
        for path in files:
            text = path.read_text(encoding="utf-8", errors="ignore")
            for ref in set(ABS_PATH.findall(text)):
                ref = ref.rstrip(".,;:)")
                if "<" in ref or "*" in ref:
                    continue
                if not Path(ref).exists():
                    problems.append(f"{path.relative_to(REPO)}: {ref} does not exist")
        self.assertEqual([], problems, "\n".join(problems))

    def test_changed_skill_bumps_version(self):
        problems = []
        for path in SKILLS:
            head = git_show_head(path)
            if head is None:
                continue  # new, untracked skill
            current = path.read_text(encoding="utf-8")
            if current == head:
                continue
            old = VERSION.search(frontmatter(head))
            new = VERSION.search(frontmatter(current))
            if old and new and old.group(1) == new.group(1):
                problems.append(f"{path.parent.name}: content changed since HEAD but metadata.version is still {new.group(1)}")
        self.assertEqual([], problems, "\n".join(problems))


if __name__ == "__main__":
    unittest.main()
