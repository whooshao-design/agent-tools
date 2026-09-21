#!/usr/bin/env python3
"""Skill trigger / routing eval for agent-tools (deterministic, no network).

Checks, over every `skills/<category>/<name>/SKILL.md` description and the case
files in `evals/cases/<skill>.json`:

- every case file names a real skill and its `skill_name` matches the file name;
- every positive prompt ranks its skill within `top_k` (default 3) when scored
  against all descriptions; the rank-1 rate is reported and can be enforced with
  `--min-rank1`;
- every negative prompt does not rank the skill first, and when `owner` is set
  the owner outranks it (a real pairwise routing test);
- no two descriptions are near-duplicates (cosine similarity: warn >= 0.50,
  error >= 0.75);
- skills under `--require-cases` categories (default: dev-workflow) must have a
  case file with at least 3 positive and 2 negative prompts.

Scoring is a lexical approximation of how an agent routes on descriptions:
TF-IDF over ASCII words plus Chinese character bigrams (single characters as
half-weight helpers, conversational fillers stripped), so mixed Chinese/English
descriptions work. It cannot judge semantics; a failure usually
means the description lacks the vocabulary users actually say, and the fix is
the description, not the prompt.

Usage:
  python3 bin/skill_routing_eval.py [--json] [--min-rank1 PCT] [--probe TEXT ...]
Exit code 1 on any error-level failure.
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS_DIR = ROOT / "skills"
CASES_DIR = ROOT / "evals" / "cases"

COLLISION_WARN = 0.50
COLLISION_ERROR = 0.75
MIN_POSITIVE = 3
MIN_NEGATIVE = 2
DEFAULT_TOP_K = 3
CJK_CHAR_WEIGHT = 0.5
DEFAULT_REQUIRE_CASES = ("dev-workflow",)

STOP_ASCII = {
    "use", "when", "the", "and", "for", "with", "this", "that", "from", "into",
    "are", "you", "your", "need", "needs", "want", "help",
}
# 中文虚词与在 description 里到处出现、不承载路由信息的二字组。
STOP_CJK = {
    "用于", "需要", "或者", "的时", "时候", "并且", "以及", "可以", "支持", "适用",
    "用户", "要求", "明确", "帮我", "一下", "这个", "看看", "是否", "需求", "或明",
    "确要", "求用", "户要", "要求", "求在", "在用", "用户", "户明", "确授", "包括",
    "例如", "或者", "以便", "然后", "再决", "决定", "进入", "还是", "已经", "基本",
}
# 单字里的虚词：不进入单字特征，避免“的/了/一下”把无关 skill 拉高。
STOP_CJK_CHAR = set("的了是在和与或及等把让对由从并为有要这那一下个我你请看做用时不再先就都还也已可能会以及其中")
# 口语填充语：不承载路由信息，分词前整体剔除（等价于英文里的 stop phrase）。
FILLER_PHRASES = ("看看有没有问题", "有没有问题", "帮我看看", "帮我", "看一下", "查一下", "跑一下", "一下", "看看", "请")
CJK_RE = re.compile(r"[一-鿿]+")
ASCII_RE = re.compile(r"[a-z0-9][a-z0-9_\-]{1,}")
FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---", re.S)
DESC_RE = re.compile(r"^description:\s*(.*?)(?=^\w[\w-]*:|\Z)", re.S | re.M)


def tokenize(text: str) -> list[str]:
    """ASCII words (>=2 chars) plus Chinese character bigrams and non-function single characters, minus stop words."""
    text = text.lower()
    for phrase in FILLER_PHRASES:
        # “查一下/跑一下”保留动词本身，只去掉“一下”这类填充。
        text = text.replace(phrase, phrase[0] if phrase in ("看一下", "查一下", "跑一下") else " ")
    out = [w for w in ASCII_RE.findall(text) if w not in STOP_ASCII]
    for run in CJK_RE.findall(text):
        # 二字组捕捉“评审/清单”这类词，单字捕捉“跑/查/写”这类动词；
        # 单字里的虚词剔除，常见字靠 idf 自然降权。
        out.extend(run[i:i + 2] for i in range(len(run) - 1))
        out.extend(ch for ch in run if ch not in STOP_CJK_CHAR)
    return [t for t in out if t not in STOP_CJK]


def read_description(skill_md: Path) -> str:
    text = skill_md.read_text(encoding="utf-8")
    fm = FRONTMATTER_RE.match(text)
    if not fm:
        return ""
    m = DESC_RE.search(fm.group(1))
    if not m:
        return ""
    desc = m.group(1).strip()
    if desc.startswith(">") or desc.startswith("|"):
        desc = desc[1:]
    return " ".join(line.strip() for line in desc.splitlines()).strip().strip('"').strip("'")


def discover_skills(skills_dir: Path = SKILLS_DIR) -> dict[str, dict]:
    skills: dict[str, dict] = {}
    for skill_md in sorted(skills_dir.glob("*/*/SKILL.md")):
        name = skill_md.parent.name
        skills[name] = {
            "name": name,
            "category": skill_md.parent.parent.name,
            "path": skill_md,
            "description": read_description(skill_md),
        }
    return skills


class Index:
    def __init__(self, skills: dict[str, dict]):
        self.skills = skills
        docs = {}
        for name, s in skills.items():
            docs[name] = tokenize(s["description"]) + tokenize(name.replace("-", " "))
        self.n = len(docs)
        self.df: dict[str, int] = {}
        for toks in docs.values():
            for t in set(toks):
                self.df[t] = self.df.get(t, 0) + 1
        self.vectors = {name: self.vector(toks) for name, toks in docs.items()}

    def vector(self, tokens: list[str]) -> dict[str, float]:
        tf: dict[str, int] = {}
        for t in tokens:
            tf[t] = tf.get(t, 0) + 1
        # 单个汉字只作辅助特征（权重减半），避免长句里的常用字盖过二字词。
        return {t: c * (CJK_CHAR_WEIGHT if len(t) == 1 else 1.0) * math.log((self.n + 1) / (self.df.get(t, 0) + 1))
                for t, c in tf.items()}

    @staticmethod
    def cosine(a: dict[str, float], b: dict[str, float]) -> float:
        num = sum(v * b[t] for t, v in a.items() if t in b)
        da = math.sqrt(sum(v * v for v in a.values()))
        db = math.sqrt(sum(v * v for v in b.values()))
        return num / (da * db) if da and db else 0.0

    def rank(self, prompt: str) -> list[tuple[str, float]]:
        pv = self.vector(tokenize(prompt))
        scored = [(name, self.cosine(pv, vec)) for name, vec in self.vectors.items()]
        scored.sort(key=lambda x: (-x[1], x[0]))
        return scored

    def collisions(self) -> list[tuple[float, str, str]]:
        pairs = []
        for a, b in itertools.combinations(sorted(self.vectors), 2):
            pairs.append((self.cosine(self.vectors[a], self.vectors[b]), a, b))
        pairs.sort(reverse=True)
        return pairs


def load_cases(cases_dir: Path = CASES_DIR) -> dict[str, dict]:
    cases = {}
    if not cases_dir.exists():
        return cases
    for path in sorted(cases_dir.glob("*.json")):
        with path.open(encoding="utf-8") as fh:
            cases[path.stem] = json.load(fh)
    return cases


def run(skills_dir: Path = SKILLS_DIR, cases_dir: Path = CASES_DIR,
        require_cases: tuple[str, ...] = DEFAULT_REQUIRE_CASES) -> dict:
    skills = discover_skills(skills_dir)
    index = Index(skills)
    cases = load_cases(cases_dir)
    errors: list[str] = []
    warnings: list[str] = []
    positives_total = 0
    positives_rank1 = 0
    prompt_results = []

    for cat in require_cases:
        for name, s in skills.items():
            if s["category"] == cat and name not in cases:
                errors.append(f"{name}: missing evals/cases/{name}.json")

    for file_name, case in cases.items():
        skill = case.get("skill_name")
        if skill != file_name:
            errors.append(f"{file_name}.json: skill_name {skill!r} does not match file name")
            continue
        if skill not in skills:
            errors.append(f"{file_name}.json: unknown skill {skill!r}")
            continue
        trigger = case.get("trigger") or {}
        positives = trigger.get("positive") or []
        negatives = trigger.get("negative") or []
        if len(positives) < MIN_POSITIVE:
            errors.append(f"{skill}: needs >= {MIN_POSITIVE} positive prompts, has {len(positives)}")
        if len(negatives) < MIN_NEGATIVE:
            errors.append(f"{skill}: needs >= {MIN_NEGATIVE} negative prompts, has {len(negatives)}")
        for item in positives:
            prompt = item.get("prompt", "")
            top_k = int(item.get("top_k", DEFAULT_TOP_K))
            ranking = index.rank(prompt)
            names = [n for n, _ in ranking]
            pos = names.index(skill) + 1 if skill in names else None
            positives_total += 1
            ok = pos is not None and pos <= top_k
            if pos == 1:
                positives_rank1 += 1
            top3 = ", ".join(f"{n}({s:.2f})" for n, s in ranking[:3])
            prompt_results.append({"skill": skill, "kind": "positive", "prompt": prompt,
                                   "rank": pos, "top_k": top_k, "ok": ok, "top3": top3})
            if not ok:
                errors.append(f"{skill}: positive prompt ranked #{pos} (top_k={top_k}): {prompt!r} -> {top3}")
        for item in negatives:
            prompt = item.get("prompt", "")
            owner = item.get("owner")
            ranking = index.rank(prompt)
            names = [n for n, _ in ranking]
            top3 = ", ".join(f"{n}({s:.2f})" for n, s in ranking[:3])
            ok = names[0] != skill
            if owner:
                if owner not in skills:
                    errors.append(f"{skill}: negative prompt names unknown owner {owner!r}")
                    continue
                ok = ok and names.index(owner) < names.index(skill)
            prompt_results.append({"skill": skill, "kind": "negative", "prompt": prompt,
                                   "owner": owner, "ok": ok, "top3": top3})
            if not ok:
                errors.append(f"{skill}: negative prompt not outranked by {owner or 'another skill'}: {prompt!r} -> {top3}")

    collisions = index.collisions()
    for score, a, b in collisions:
        if score >= COLLISION_ERROR:
            errors.append(f"description collision {score:.2f}: {a} ~ {b}")
        elif score >= COLLISION_WARN:
            warnings.append(f"description similarity {score:.2f}: {a} ~ {b}")

    rank1_rate = (positives_rank1 / positives_total * 100) if positives_total else 0.0
    return {
        "skills": len(skills),
        "cases": len(cases),
        "positives": positives_total,
        "positives_rank1": positives_rank1,
        "rank1_rate": rank1_rate,
        "errors": errors,
        "warnings": warnings,
        "top_similar": [{"score": round(s, 3), "a": a, "b": b} for s, a, b in collisions[:10]],
        "prompts": prompt_results,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--json", action="store_true", help="print the full report as JSON")
    parser.add_argument("--min-rank1", type=float, default=None, help="fail when rank-1 rate is below this percent")
    parser.add_argument("--probe", nargs="*", default=None, help="rank these ad-hoc prompts and exit")
    args = parser.parse_args(argv)

    if args.probe is not None:
        index = Index(discover_skills())
        for prompt in args.probe:
            top = index.rank(prompt)[:3]
            print(f"{prompt!r} -> " + ", ".join(f"{n}({s:.2f})" for n, s in top))
        return 0

    report = run()
    if args.min_rank1 is not None and report["rank1_rate"] < args.min_rank1:
        report["errors"].append(f"rank-1 rate {report['rank1_rate']:.0f}% below floor {args.min_rank1:.0f}%")
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"{report['skills']} skills, {report['cases']} case files, {report['positives']} positive prompts")
        for w in report["warnings"]:
            print(f"  warn  {w}")
        for e in report["errors"]:
            print(f"  ERROR {e}")
        print(f"trigger rank-1 rate: {report['rank1_rate']:.0f}% ({report['positives_rank1']}/{report['positives']})")
        print("top description similarity: " + ", ".join(f"{p['a']}~{p['b']} {p['score']:.2f}" for p in report["top_similar"][:3]))
        print("PASSED" if not report["errors"] else "FAILED")
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
