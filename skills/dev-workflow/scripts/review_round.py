#!/usr/bin/env python3
"""Orchestrator helper for one formal review round (dev-review-* skills).

Implements the mechanical parts of delegation-contract.md and artifact-identity.md
so the orchestrator does not hand-write them per round:

  freeze    fingerprint the artifacts (versions read from the files), snapshot code
            repositories as repo-snapshot-v1, run mechanical checks
  envelope  write delegation-envelope.json from the frozen inputs (+ prior round)
  snapshot  workspace content snapshot before / after the reviewer runs
  task      write the prompt for an external reviewer run through spawn-model-agent
  persist   save the reviewer report and delegation-result-v1, run the structure
            check and write runtime-record + approval-record-v1 (--spawn-job for an
            external reviewer, --slot secondary for the second reviewer of a dual review);
            also appends the reviewer ledger
  ledger    append an already persisted round to the reviewer ledger

Round directory: <req-dir>/<stage>/rounds/round-<N>/ (evidence in evidence/).
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

GIT_DIFF = ["--binary", "--full-index", "--find-renames=50%", "--no-ext-diff", "--no-textconv", "--no-color",
            "--src-prefix=a/", "--dst-prefix=b/", "--submodule=short", "--ignore-submodules=none"]
VERSION_RE = re.compile(r"版本[：:]\s*(v?\d+(?:\.\d+)*)|^\s*version:\s*(v?\d+(?:\.\d+)*)"
                        r"|^\|\s*[^|\n]*版本\s*\|\s*(v?\d+(?:\.\d+)*)\s*\|", re.M)
CONCLUSIONS = {
    "agent-tools-requirements-reviewer": ["通过", "有条件通过", "不通过", "材料不足"],
    "agent-tools-solution-reviewer": ["通过", "有条件通过", "修改后复审", "退回重设计", "材料不足"],
    "agent-tools-test-design-reviewer": ["通过", "修改后复审", "方案缺口", "材料不足"],
    "agent-tools-change-reviewer": ["可继续推进", "修复后再评", "带风险接受", "证据不足"],
}
PASSING = {"通过", "有条件通过", "可继续推进", "带风险接受"}
ALLOWED_TOOLS = {"Read", "Grep", "Glob", "SubagentHandback"}
EXTERNAL_TOOLS = {"Read", "Grep", "Glob"}
TOOLS_ROOT = Path(__file__).resolve().parents[3]
CLASSES = {"成立需修", "接受取舍", "契约误读", "噪音"}
VALID_CLASSES = {"成立需修", "接受取舍"}
LEDGER = Path(os.environ.get("AGENT_TOOLS_REVIEWER_LEDGER", "~/.local/state/agent-tools/reviewer-ledger.jsonl")).expanduser()


def sha(data: bytes) -> str:
    return "sha256-v1:" + hashlib.sha256(data).hexdigest()


def fp(path) -> str:
    return sha(Path(path).read_bytes())


def ref(path) -> dict:
    return {"ref": str(path), "fingerprint": fp(path)}


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")


def git(repo, *args) -> bytes:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, check=True).stdout


def round_dir(args) -> Path:
    return Path(args.req_dir) / args.stage / "rounds" / f"round-{args.round}"


# ---------- identities ----------

def read_version(path: Path) -> str:
    m = VERSION_RE.search(path.read_text(errors="replace"))
    return next(g for g in m.groups() if g) if m else "unversioned"


def artifact_identity(base: Path, spec: str) -> tuple[str, dict]:
    """spec: NAME=subdir:file1,file2  (version read from the first file)."""
    name, rest = spec.split("=", 1)
    sub, names = rest.split(":", 1)
    ref_dir = base / sub
    files = [{"path": n, "fingerprint": fp(ref_dir / n)} for n in sorted(names.split(","))]
    manifest = "".join(f"{f['path']}\0{f['fingerprint']}\n" for f in files).encode()
    first = ref_dir / names.split(",")[0]
    ident = {"ref": str(ref_dir), "version": read_version(first), "files": files, "fingerprint": sha(manifest)}
    return name, ident


def repo_snapshot(repo: str) -> dict:
    untracked = sorted(n for n in git(repo, "ls-files", "--others", "--exclude-standard", "-z").split(b"\0") if n)
    manifest = b""
    for n in untracked:
        p = Path(repo) / os.fsdecode(n)
        kind = b"link" if p.is_symlink() else b"file"
        data = os.fsencode(os.readlink(p)) if p.is_symlink() else p.read_bytes()
        manifest += b"\0".join([n, kind, oct(p.lstat().st_mode & 0o7777).encode(), hashlib.sha256(data).hexdigest().encode()]) + b"\0"
    return {"schema": "repo-snapshot-v1", "repo": repo,
            "branch": git(repo, "branch", "--show-current").decode().strip(),
            "head_commit": git(repo, "rev-parse", "HEAD").decode().strip(),
            "head_tree": git(repo, "rev-parse", "HEAD^{tree}").decode().strip(),
            "tracked_patch_fingerprint": sha(git(repo, "diff", "HEAD", *GIT_DIFF, "--")),
            "staged_patch_fingerprint": sha(git(repo, "diff", "--cached", "HEAD", *GIT_DIFF, "--")),
            "untracked_manifest_fingerprint": sha(manifest), "untracked_file_count": len(untracked),
            "exclusions": ["Git ignored files", ".git/"]}


def solution_checks(base: Path) -> dict | None:
    sol_p, tr_p, req_p = base / "solution-design/solution.md", base / "solution-design/traceability.md", base / "requirements/summary.md"
    if not (sol_p.exists() and tr_p.exists()):
        return None
    sol, tr = sol_p.read_text(), tr_p.read_text()
    req = req_p.read_text() if req_p.exists() else ""
    headings = set(re.findall(r"^#{2,4} (\d+(?:\.\d+)*)", sol, re.M))
    chg = sorted(set(re.findall(r"^\| (CHG-\d+) \|", tr, re.M)))
    unchanged = sorted(set(re.findall(r"^\| (CHG-\d+) \| 保持不变 \|", tr, re.M)))
    refs = set()
    for row in re.findall(r"^\| (?:AC|CHG)-\d+ \|.*$", tr, re.M):
        refs.update(re.findall(r"(?<![\d.\w-])(\d+(?:\.\d+)*)(?=、|\s*\||（| 章|$)", row))
        refs.update(re.findall(r"第 (\d+) 章", row))
    refs = sorted(r for r in refs if 1 <= int(r.split(".")[0]) <= 9)
    ov = re.search(r"### 2\.4 [^\n]*\n(.*?)(?=\n#{2,3} )", sol, re.S)
    ov_chg = sorted(set(re.findall(r"CHG-\d+", ov.group(1)))) if ov else []
    cited = sorted(set(re.findall(r"\[E-(\d+)\]", sol)), key=int)
    defined = set(re.findall(r"^\| E-(\d+) \|", tr, re.M))
    ac_req, ac_tr = sorted(set(re.findall(r"AC-\d+", req))), sorted(set(re.findall(r"^\| (AC-\d+) \|", tr, re.M)))
    return {"AC_ids_in_requirements": ac_req, "AC_ids_in_traceability": ac_tr, "AC_sets_equal": ac_req == ac_tr,
            "CHG_ids": chg, "CHG_count": len(chg), "CHG_unchanged": unchanged,
            "CHG_in_change_overview": ov_chg, "has_change_overview": ov is not None,
            "changed_CHG_missing_from_overview": [c for c in chg if ov and c not in ov_chg and c not in unchanged],
            "section_refs_in_traceability": refs,
            "section_refs_missing_in_solution": [r for r in refs if r not in headings],
            "evidence_cited_in_solution": ["E-" + e for e in cited],
            "evidence_cited_but_undefined": ["E-" + e for e in cited if e not in defined]}


def expand_ids(text: str) -> set:
    """IDs in text, with ranges such as TC-016～TC-024 expanded."""
    ids = set(re.findall(r"\b(?:AC|CHG|TC)-\d+", text))
    for pre, a, b in re.findall(r"\b(AC|CHG|TC)-(\d+)\s*[～~]\s*(?:\1-)?(\d+)", text):
        ids.update(f"{pre}-{i:0{len(a)}d}" for i in range(int(a), int(b) + 1))
    return ids


def test_case_checks(base: Path) -> dict | None:
    """Closure of AC/CHG denominators over the checklist items, computed before dispatch."""
    tc_p, tr_p, req_p = base / "test-cases/test-cases.md", base / "solution-design/traceability.md", base / "requirements/summary.md"
    if not (tc_p.exists() and tr_p.exists() and req_p.exists()):
        return None
    tc, tr, req = tc_p.read_text(), tr_p.read_text(), req_p.read_text()
    ac = sorted(set(re.findall(r"AC-\d+", req)))
    chg = sorted(set(re.findall(r"^\| (CHG-\d+) \|", tr, re.M)))
    rows = {m.group(1): m.group(0) for m in re.finditer(r"^\| (TC-\d+) \|.*$", tc, re.M)}
    refs = {t: expand_ids(row.split("|", 2)[2]) for t, row in rows.items()}
    covered = set().union(*refs.values()) if refs else set()
    trace = re.search(r"^## 3\..*?(?=^## 4\.)", tc, re.S | re.M)
    # only mapping rows (| AC-... |); the closure summary table restates TC-001～TC-N and would mask omissions
    trace_rows = "\n".join(re.findall(r"^\| AC-.*$", trace.group(0), re.M)) if trace else ""
    in_trace = sorted(i for i in expand_ids(trace_rows) if i.startswith("TC-"))
    # row-level CHG agreement: trace row | AC | CHG / 章节 | TC 列表 | vs item row | TC | AC | CHG / 章节 |
    trace_chg = {}
    for row in trace_rows.splitlines():
        cells = row.split("|")
        if len(cells) > 3:
            for t in (i for i in expand_ids(cells[3]) if i.startswith("TC-")):
                trace_chg.setdefault(t, set()).update(i for i in expand_ids(cells[2]) if i.startswith("CHG-"))
    item_chg = {t: {i for i in expand_ids(row.split("|")[3]) if i.startswith("CHG-")} for t, row in rows.items() if row.count("|") > 3}
    chg_mismatch = {t: {"trace_table": sorted(trace_chg[t]), "item": sorted(item_chg[t])}
                    for t in sorted(trace_chg) if t in item_chg and trace_chg[t] != item_chg[t]}
    return {"AC": ac, "AC_count": len(ac), "CHG": chg, "CHG_count": len(chg), "TC_count": len(rows),
            "AC_unmapped": [a for a in ac if a not in covered], "CHG_unmapped": [c for c in chg if c not in covered],
            "TC_without_AC": sorted(t for t, r in refs.items() if not any(i.startswith("AC-") for i in r)),
            "TC_without_CHG": sorted(t for t, r in refs.items() if not any(i.startswith("CHG-") for i in r)),
            "TC_refs_outside_denominator": sorted(i for i in covered if i.startswith(("AC-", "CHG-")) and i not in ac + chg),
            "TC_defined_not_in_trace_table": sorted(t for t in rows if t not in in_trace),
            "TC_in_trace_table_not_defined": [t for t in in_trace if t not in rows],
            "TC_CHG_mismatch_trace_vs_item": chg_mismatch}


def cmd_freeze(args) -> None:
    base, rd = Path(args.req_dir), round_dir(args)
    ev = rd / "evidence"
    out = dict(artifact_identity(base, spec) for spec in args.artifact)
    write_json(ev / "code-baseline.json", {"schema": "repo-snapshot-set-v1", "repositories": [repo_snapshot(r) for r in args.repo]})
    out["B"] = ref(ev / "code-baseline.json")
    checks = {"solution-review": solution_checks, "test-cases-review": test_case_checks}.get(args.stage, lambda b: None)(base)
    if checks is not None:
        write_json(rd / "mechanical-checks.json", checks)
        out["mechanical_checks"] = ref(rd / "mechanical-checks.json")
    write_json(ev / "frozen-inputs.json", {"req_dir": str(base), "stage": args.stage, "round": args.round, "repos": args.repo, "inputs": out})
    print(json.dumps({k: {"version": v.get("version"), "fingerprint": v["fingerprint"]} for k, v in out.items()}, ensure_ascii=False, indent=2))
    if checks:
        bad = {k: v for k, v in checks.items() if (k in ("changed_CHG_missing_from_overview", "section_refs_missing_in_solution",
               "evidence_cited_but_undefined") or k.startswith(("AC_unmapped", "CHG_unmapped", "TC_"))) and isinstance(v, list) and v}
        if checks.get("AC_sets_equal") is False:
            bad["AC_sets_equal"] = False
        if bad:
            print("mechanical check failures: " + json.dumps(bad, ensure_ascii=False), file=sys.stderr)


# ---------- envelope ----------

def prior_material(args, frozen) -> tuple[dict, dict]:
    """Inputs and fingerprints carried from the prior round for a targeted re-review."""
    base, rd = Path(args.req_dir), round_dir(args)
    prd = Path(args.req_dir) / args.stage / "rounds" / f"round-{args.prior_round}"
    prior_env = json.loads((prd / "delegation-envelope.json").read_text())
    inputs, fps = {}, {}
    for key, name in [("prior_report", "report.md"), ("prior_findings", "findings.json"),
                      ("prior_approval_record", "approval-record.json"), ("resolution", "resolution.md")]:
        p = prd / name
        if not p.exists():
            sys.exit(f"targeted re-review needs {p}")
        inputs[key], fps[key] = str(p), fp(p)
    # the approval record carries orchestrator corrections, so prefer its version label over the envelope's
    key = {"test-cases-review": "C", "requirements-review": "R"}.get(args.stage, "S")
    prior_rec = json.loads((prd / "approval-record.json").read_text())
    prior_version = (prior_rec.get("bound_inputs", {}).get(key) or prior_env["inputs"][key]).get("version")
    inputs[f"prior_{key}"] = {"version": prior_version, "fingerprint": prior_env["input_fingerprints"][key]}
    fps[f"prior_{key}"] = prior_env["input_fingerprints"][key]
    if key == "C":  # archived as test-cases/versions/test-cases-v<N>.md
        pairs = [(base / "test-cases/versions" / f"test-cases-{prior_version}.md", Path(frozen["C"]["ref"]) / f["path"]) for f in frozen["C"]["files"]]
    else:  # archived as solution-design/versions/<v>/ or requirements/versions/<v>/
        old_dir = base / {"R": "requirements", "S": "solution-design"}[key] / "versions" / str(prior_version)
        pairs = [(old_dir / f["path"], Path(frozen[key]["ref"]) / f["path"]) for f in frozen[key]["files"]]
    if all(old.exists() for old, _ in pairs):
        diff = b"".join(subprocess.run(["diff", "-u", str(old), str(new)], capture_output=True).stdout for old, new in pairs)
        (rd / "evidence").mkdir(parents=True, exist_ok=True)
        dp = rd / "evidence" / "prior-diff.diff"
        dp.write_bytes(diff)
        inputs["diff"], fps["diff"] = str(dp), fp(dp)
    else:
        print(f"warning: prior {key} {prior_version} archive not found, no diff generated; archive the prior version before re-review", file=sys.stderr)
    return inputs, fps


def cmd_envelope(args) -> None:
    rd = round_dir(args)
    frozen = json.loads((rd / "evidence/frozen-inputs.json").read_text())["inputs"]
    fps, inputs = {}, {}
    for name, ident in frozen.items():
        fps[name] = ident["fingerprint"]
        files = ident.get("files", [])
        if len(files) > 1:
            for f in files:
                fps[f"{name}/{f['path']}"] = f["fingerprint"]
        inputs[name] = dict(ident)
        if name in ("R", "S", "C"):
            inputs[name]["producer_agent_refs"] = args.producer
    if args.prior_round:
        extra_inputs, extra_fps = prior_material(args, frozen)
        inputs.update(extra_inputs)
        fps.update(extra_fps)
    inputs.update({"review_mode": "targeted" if args.prior_round else "full", "scope": args.scope,
                   "necessary_evidence": args.evidence, "review_instructions": args.instruction or [
                       "按对应 dev-review skill 的模板输出中文评审正文，最后只输出 delegation-result-v1 JSON 代码块。",
                       "只用 Read/Glob/Grep；不写文件、不运行代码、不委派；不要自报 reviewer_agent_ref。"]})
    env = {"task_id": args.task_id, "role": args.role, "producer_agent_refs": args.producer, "input_fingerprints": fps, "inputs": inputs,
           "runtime_requirements": {"tools": ["Read", "Grep", "Glob"], "mcp_servers": [], "nested_delegation": False, "write_workspace": False}}
    write_json(rd / "delegation-envelope.json", env)
    print(rd / "delegation-envelope.json")


# ---------- snapshot ----------

def workspace_snapshot(args) -> dict:
    base, rd = Path(args.req_dir), round_dir(args)
    repos = json.loads((rd / "evidence/frozen-inputs.json").read_text())["repos"]
    paths = set()
    for repo in repos:
        paths.update(Path(repo) / os.fsdecode(n) for n in git(repo, "ls-files", "--cached", "--others", "--exclude-standard", "-z").split(b"\0") if n)
    paths.update(p for p in base.rglob("*") if p.is_file() and rd not in p.parents)
    entries = {}
    for p in sorted(paths):
        if not (p.exists() or p.is_symlink()):
            entries[str(p)] = "deleted-in-worktree"
            continue
        data = os.fsencode(os.readlink(p)) if p.is_symlink() else p.read_bytes()
        entries[str(p)] = hashlib.sha256(data).hexdigest()
    blob = json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()
    return {"scope": {"repos": repos, "artifact_dir": str(base), "excluded": [str(rd), "git-ignored files", ".git/"]},
            "fingerprint": sha(blob), "file_count": len(entries), "entries": entries}


def cmd_snapshot(args) -> None:
    snap = workspace_snapshot(args)
    write_json(round_dir(args) / "evidence" / f"snapshot-{args.phase}.json", snap)
    print(args.phase, snap["fingerprint"], snap["file_count"])


# ---------- persist ----------

def extract_report(transcript: Path) -> tuple[str, set]:
    """Last SubagentHandback text, else the last assistant text block, from a Claude Code JSONL transcript."""
    handback, last_text, tools = None, None, set()
    for line in transcript.read_text(errors="replace").splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        content = (e.get("message") or {}).get("content")
        if not isinstance(content, list) or (e.get("message") or {}).get("role") != "assistant":
            continue
        for b in content:
            if b.get("type") == "tool_use":
                tools.add(b.get("name"))
                if "Handback" in (b.get("name") or ""):
                    handback = next((v for v in (b.get("input") or {}).values() if isinstance(v, str) and "delegation-result-v1" in v), handback)
            elif b.get("type") == "text" and "delegation-result-v1" in b.get("text", ""):
                last_text = b["text"]
    text = handback or last_text
    if not text:
        sys.exit(f"no delegation-result-v1 report found in {transcript}")
    return text, tools


def reviewer_run(args, env, out: Path, evdir: Path) -> dict:
    """Save one reviewer's report/result under out/ (checks under evdir/) and check structure + runtime surface."""
    evdir.mkdir(parents=True, exist_ok=True)
    if args.spawn_job:
        job = Path(args.spawn_job)
        meta = json.loads((job / "meta.json").read_text())
        text, tools = (job / "result.md").read_text(), set(meta.get("tools_used") or [])
        reviewer_ref = f"spawn:{meta.get('backend')}:{meta.get('session_id')}"
        surface = {"effective_tools": meta.get("effective_tools"), "mcp_servers": meta.get("mcp_servers"),
                   "readonly": meta.get("readonly"), "exit_code": meta.get("exit_code"), "command": meta.get("command"),
                   "wall_s": meta.get("wall_s"), "input_tokens": meta.get("input_tokens"), "output_tokens": meta.get("output_tokens")}
        surface_ok = bool(meta.get("session_id")) and meta.get("readonly") is True and meta.get("exit_code") == 0 \
            and meta.get("mcp_servers") == [] and bool(meta.get("effective_tools")) \
            and set(meta["effective_tools"]) <= EXTERNAL_TOOLS
        kind, model, ref_source = "spawn-model-agent", meta.get("model") or "unknown", \
            f"spawn-model-agent meta.json session_id from the {meta.get('backend')} CLI runtime ({job})"
    else:
        if args.report_file:
            text, tools = Path(args.report_file).read_text(), set(args.tools_used or [])
        else:
            text, tools = extract_report(Path(args.transcript))
        reviewer_ref, surface, surface_ok = args.reviewer_ref, {"method": "reviewer agent tool allowlist"}, True
        kind, model, ref_source = "claude-subagent", args.model, args.ref_source
    (out / "report.md").write_text(text.rstrip() + "\n")
    blocks = re.findall(r"```json\n(.*?)\n```", text, re.S)
    res = json.loads(blocks[-1]) if blocks else {}
    write_json(out / "delegation-result.json", res)
    structure = {"schema_ok": res.get("schema") == "delegation-result-v1", "role_ok": res.get("role") == env["role"],
                 "status": res.get("status"), "task_id_ok": res.get("task_id") == env["task_id"],
                 "conclusion_in_enum": res.get("conclusion") in CONCLUSIONS.get(env["role"], []),
                 "changed_files_empty": res.get("changed_files") == [],
                 "fingerprints_echo_exact": res.get("input_fingerprints") == env["input_fingerprints"],
                 "nothing_after_json_block": text.rstrip().endswith("```")}
    write_json(evdir / "structure-check.json", structure)
    unexpected = sorted(t for t in tools if t not in ALLOWED_TOOLS)
    runtime = {"reviewer_agent_ref": reviewer_ref, "ref_source": ref_source, "reviewer_kind": kind, "role": env["role"],
               "model": model, "selected_by": args.selected_by, "tool_calls_observed": sorted(tools), "unexpected_tools": unexpected,
               "runtime_surface": surface, "runtime_surface_ok": surface_ok, "producer_refs": env["producer_agent_refs"],
               "trust_limits": args.trust_limit}
    independent = reviewer_ref not in env["producer_agent_refs"]
    ok = surface_ok and not unexpected and independent and res.get("status") == "complete" \
        and all(v for k, v in structure.items() if k != "status")
    return {"out": out, "res": res, "text": text, "structure": structure, "runtime": runtime, "ok": ok,
            "independent": independent, "unexpected": unexpected, "reviewer_ref": reviewer_ref}


def check_findings(findings) -> list:
    """Orchestrator classification (delegation-contract.md 3.2): every finding classified; noise/misread need evidence."""
    errors = []
    for f in findings:
        c = f.get("classification")
        if c not in CLASSES:
            errors.append(f"{f.get('id')}: classification must be one of {sorted(CLASSES)}")
        elif c not in VALID_CLASSES and not str(f.get("evidence") or "").strip():
            errors.append(f"{f.get('id')}: {c} needs source evidence")
    return errors


def prior_finding_ids(rd: Path) -> set:
    """Finding IDs already raised in earlier rounds of the same stage; re-listed in this round they score nothing."""
    cur, ids = int(rd.name.split("-")[1]), set()
    for p in rd.parent.glob("round-*/findings.json"):
        if int(p.parent.name.split("-")[1]) < cur:
            ids |= {f.get("id") for f in json.loads(p.read_text())}
    return ids


def invalid_cause(rec: dict, rd: Path):
    """None for a valid round. 'environment' when the reviewer itself passed every check and only the write-set
    snapshot moved (a read-only reviewer cannot write, so another writer changed the monitored scope); else 'reviewer'."""
    if rec["review_execution"]["execution_status"] == "valid":
        return None
    checks = rec["checks"]
    structure = json.loads((rd / "evidence/structure-check.json").read_text())
    reviewer_ok = (all(checks[k]["passed"] for k in ("independence", "read_only", "tool_surface"))
                   and all(v for k, v in structure.items() if k != "status"))
    return "environment" if reviewer_ok and not checks["write_set_empty"]["passed"] else "reviewer"


def ledger_rows(rd: Path, req_dir: Path) -> list:
    """One reviewer-ledger row per reviewer of a persisted round (primary, and secondary for dual review).
    finding_counts only covers findings first raised in this round; carried-over IDs go to carried_findings."""
    rec = json.loads((rd / "approval-record.json").read_text())
    findings = json.loads((rd / "findings.json").read_text())
    env = json.loads((rd / "delegation-envelope.json").read_text())
    prior = prior_finding_ids(rd)
    rows = []
    for slot, rt_path in (("primary", rd / "evidence/runtime-record.json"), ("secondary", rd / "secondary/runtime-record.json")):
        if not rt_path.exists():
            continue
        rt = json.loads(rt_path.read_text())
        found = [f for f in findings if slot in (f.get("found_by") or ["primary"])]
        mine = [f for f in found if f.get("id") not in prior]
        counts = {}
        for f in mine:
            key = f"{f.get('classification')}/{f.get('severity')}"
            counts[key] = counts.get(key, 0) + 1
        surface = rt.get("runtime_surface") or {}
        backend = (rt["reviewer_agent_ref"].split(":")[1] if rt["reviewer_agent_ref"].startswith("spawn:") else "claude-subagent")
        rows.append({"at": rec["created_at"], "requirement": req_dir.name, "stage": rec["stage"], "round": rec["round"],
                     "approval_id": rec["approval_id"], "slot": slot, "backend": backend, "model": rt.get("model"),
                     "reviewer_agent_ref": rt["reviewer_agent_ref"], "selected_by": rt.get("selected_by"),
                     "review_mode": env["inputs"].get("review_mode"), "execution_valid": rec["review_execution"]["execution_status"] == "valid"
                     if slot == "primary" else rt.get("valid"), "conclusion": rec["conclusion"] if slot == "primary" else None,
                     "invalid_cause": invalid_cause(rec, rd) if slot == "primary" else (None if rt.get("valid") else "reviewer"),
                     "finding_counts": counts, "carried_findings": len(found) - len(mine),
                     "spot_check": [{"id": f.get("id"), "classification": f.get("classification"), "evidence": f.get("evidence")}
                                    for f in mine if f.get("classification") not in VALID_CLASSES],
                     "escaped_from": sorted({f["escaped_from"] for f in findings if f.get("escaped_from")})
                     if slot == "primary" else [], "exit_code": surface.get("exit_code"),
                     "wall_s": surface.get("wall_s"), "input_tokens": surface.get("input_tokens"), "output_tokens": surface.get("output_tokens")})
    return rows


def append_ledger(rd: Path, req_dir: Path) -> list:
    done = set()
    if LEDGER.exists():
        done = {(r.get("approval_id"), r.get("slot")) for r in map(json.loads, LEDGER.read_text().splitlines()) if r}
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    rows = ledger_rows(rd, req_dir)
    with LEDGER.open("a") as out:
        for row in rows:
            if (row["approval_id"], row["slot"]) not in done:
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"ledger: {LEDGER}")
    return rows


def scorecard(rows: list) -> str:
    """Terminal scorecard for one round (delegation-contract.md 3.2): the orchestrator shows it to the user as is."""
    sys.path.insert(0, str(TOOLS_ROOT / "skills/common/spawn-model-agent/scripts"))
    try:
        import spawn_model_agent as sma
    finally:
        sys.path.pop(0)
    stats = sma.ledger_stats(str(LEDGER))
    head = rows[0]
    lines = [f"## 评审打分：{head['requirement']} / {head['stage']} / round {head['round']}", "",
             "| reviewer | 模型 | 选择方式 | 执行 | 本轮新提出 | 往轮带入（不计分） |", "|---|---|---|---|---|---|"]
    for r in rows:
        status = "有效" if r["execution_valid"] else {"environment": "作废（环境原因，不计 reviewer）"}.get(r["invalid_cause"], "无效（reviewer 原因）")
        found = "、".join(f"{k.replace('/', ' ')}×{v}" for k, v in sorted(r["finding_counts"].items())) or "无"
        lines.append(f"| {r['slot']} {r['backend']} | {r['model']} | {r['selected_by'] or '—'} | {status} | {found} | {r['carried_findings']} |")
    checks = [c for r in rows for c in r["spot_check"]]
    lines += ["", "需抽查（噪音 / 契约误读）：" + ("；".join(f"{c['id']} {c['classification']}（{c['evidence']}）" for c in checks) if checks else "无")]
    lines += [f"累计实战 {b}：{sma.format_stats(stats.get(b))}" for b in dict.fromkeys(r["backend"] for r in rows)]
    return "\n".join(lines)


def cmd_ledger(args) -> None:
    print(scorecard(append_ledger(round_dir(args), Path(args.req_dir))))


def cmd_persist(args) -> None:
    rd = round_dir(args)
    ev = rd / "evidence"
    env = json.loads((rd / "delegation-envelope.json").read_text())
    if args.slot == "secondary":
        run = reviewer_run(args, env, rd / "secondary", rd / "secondary")
        run["runtime"]["valid"] = run["ok"]
        write_json(rd / "secondary/runtime-record.json", run["runtime"])
        print(json.dumps({"slot": "secondary", "valid": run["ok"], "conclusion": run["res"].get("conclusion"),
                          "reviewer": run["reviewer_ref"], "unexpected_tools": run["unexpected"],
                          "runtime_surface_ok": run["runtime"]["runtime_surface_ok"]}, ensure_ascii=False))
        if not run["ok"]:
            sys.exit(1)
        return
    findings = json.loads(Path(args.findings).read_text())
    errors = check_findings(findings)
    if errors:
        sys.exit("findings not classified:\n" + "\n".join(errors))
    run = reviewer_run(args, env, rd, ev)
    res, structure = run["res"], run["structure"]
    write_json(rd / "findings.json", findings)
    before, after = (json.loads((ev / f"snapshot-{p}.json").read_text()) for p in ("before", "after"))
    equal = before["fingerprint"] == after["fingerprint"]
    runtime = dict(run["runtime"], write_set_proof={
        "method": "same-scope before/after content snapshots", "before": fp(ev / "snapshot-before.json"),
        "after": fp(ev / "snapshot-after.json"), "equal": equal, "monitored_file_count": after["file_count"]})
    write_json(ev / "runtime-record.json", runtime)
    conclusion, secondary = res.get("conclusion"), None
    valid = equal and run["ok"]
    sec_dir = rd / "secondary"
    if (sec_dir / "runtime-record.json").exists():
        sec_rt = json.loads((sec_dir / "runtime-record.json").read_text())
        sec_res = json.loads((sec_dir / "delegation-result.json").read_text())
        sec_ok = sec_rt.get("valid") is True and sec_rt["reviewer_agent_ref"] != run["reviewer_ref"]
        valid = valid and sec_ok
        # dual review: the stricter conclusion wins; both reviewers must be valid
        if conclusion in PASSING and sec_res.get("conclusion") not in PASSING:
            conclusion = sec_res.get("conclusion")
        secondary = {"reviewer_agent_ref": sec_rt["reviewer_agent_ref"], "model": sec_rt.get("model"), "valid": sec_ok,
                     "conclusion": sec_res.get("conclusion"), "report": ref(sec_dir / "report.md"),
                     "delegation_result": ref(sec_dir / "delegation-result.json"), "runtime_record": ref(sec_dir / "runtime-record.json")}
    unexpected = run["unexpected"]
    opens = [f for f in findings if f.get("status") == "Open"]
    counts = {k: sum(1 for f in opens if f.get("severity") == k) for k in ("Blocker", "High", "Medium", "Low")}
    surface = runtime["runtime_surface"]
    rec = {"schema": "approval-record-v1", "approval_id": env["task_id"] + "-approval", "stage": args.stage, "round": args.round,
           "bound_inputs": {k: env["inputs"][k] for k in ("R", "S", "C", "B") if k in env["inputs"]},
           "conclusion": conclusion if valid else None, "producer_agent_refs": env["producer_agent_refs"],
           "reviewer_agent_ref": run["reviewer_ref"],
           "reviewer": {"kind": runtime["reviewer_kind"], "model": runtime["model"], "selected_by": args.selected_by},
           "secondary_reviewer": secondary,
           "checks": {"independence": {"passed": run["independent"], "evidence": ref(ev / "runtime-record.json")},
                      "read_only": {"passed": not unexpected and runtime["runtime_surface_ok"],
                                    "method": "spawn --readonly --tools Read,Grep,Glob; init-event tool surface; observed tool calls"
                                    if args.spawn_job else "reviewer tool allowlist; observed tool calls",
                                    "evidence": ref(ev / "runtime-record.json")},
                      "write_set_empty": {"passed": equal, "before": ref(ev / "snapshot-before.json"), "after": ref(ev / "snapshot-after.json"), "equal": equal},
                      "tool_surface": {"passed": not unexpected and runtime["runtime_surface_ok"],
                                       "tools": surface.get("effective_tools") or ["Read", "Grep", "Glob"],
                                       "mcp_servers": surface.get("mcp_servers") or [], "nested_delegation": False}},
           "review_execution": {"task_id": env["task_id"], "execution_status": "valid" if valid else "invalid", "status": res.get("status"),
                                "input_fingerprints": res.get("input_fingerprints"), "structure_check": ref(ev / "structure-check.json"),
                                "runtime_record": ref(ev / "runtime-record.json"), "delegation_envelope": ref(rd / "delegation-envelope.json")},
           "report": ref(rd / "report.md"), "delegation_result": ref(rd / "delegation-result.json"), "findings": ref(rd / "findings.json"),
           "open_finding_ids": [f["id"] for f in opens], "open_counts": counts,
           "material_gaps": [g for g in res.get("unresolved", []) if str(g).startswith("MG-")],
           "can_enter_next_stage": valid and conclusion in PASSING, "production_release_approved": False,
           "created_at": datetime.datetime.now().astimezone().isoformat()}
    write_json(rd / "approval-record.json", rec)
    rows = append_ledger(rd, Path(args.req_dir))
    print(json.dumps({"valid": valid, "conclusion": rec["conclusion"], "reviewer": rec["reviewer"], "secondary": bool(secondary),
                      "open": counts, "material_gaps": rec["material_gaps"], "unexpected_tools": unexpected, "write_set_equal": equal,
                      "runtime_surface_ok": runtime["runtime_surface_ok"],
                      "structure_failures": [k for k, v in structure.items() if k != "status" and not v]}, ensure_ascii=False))
    print(scorecard(rows))
    if not valid:
        sys.exit(1)


ROLE_SKILL = {"agent-tools-requirements-reviewer": "requirements-review", "agent-tools-solution-reviewer": "dev-review-solution",
              "agent-tools-test-design-reviewer": "dev-review-test-cases", "agent-tools-change-reviewer": "dev-review-change"}


def cmd_task(args) -> None:
    """Write the task text for an external (spawn-model-agent) reviewer: role prompt + skill + envelope."""
    rd = round_dir(args)
    env = json.loads((rd / "delegation-envelope.json").read_text())
    role = env["role"]
    body = (TOOLS_ROOT / "agents/claude" / f"{role}.md").read_text().split("---", 2)[2].strip()
    skill = TOOLS_ROOT / "skills/dev-workflow" / ROLE_SKILL[role]
    text = f"""{body}

## 外部评审进程补充

你运行在独立进程中，没有预加载 skill。开始评审前先完整读取：

- 评审 skill：`{skill}/SKILL.md`，以及它引用的报告模板（`{skill}/references/`）
- 委派契约：`{TOOLS_ROOT}/skills/dev-workflow/references/delegation-contract.md`
- 派发信封：`{rd}/delegation-envelope.json`（冻结输入、范围、上一轮材料都在这里）

只读取信封列出的冻结输入和必要代码证据。用中文写评审正文；最后一段只输出 `delegation-result-v1` JSON 代码块，
其中 `task_id` 为 `{env['task_id']}`、`role` 为 `{role}`、`input_fingerprints` 逐项原样回显信封中的映射，之后不得再输出任何文字。
"""
    path = rd / "evidence" / f"external-task-{args.slot}.md"
    path.write_text(text)
    print(path)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--req-dir", required=True, help="requirement product dir, e.g. /home/joney/docs/requirements-development/<name>")
    ap.add_argument("--stage", default="solution-review", help="review directory name under req-dir")
    ap.add_argument("--round", type=int, required=True)
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("freeze")
    f.add_argument("--artifact", action="append", required=True, help="NAME=subdir:file1,file2 (e.g. S=solution-design:solution.md,traceability.md)")
    f.add_argument("--repo", action="append", default=[], help="code repository for B (repeatable)")
    e = sub.add_parser("envelope")
    e.add_argument("--task-id", required=True)
    e.add_argument("--role", default="agent-tools-solution-reviewer")
    e.add_argument("--producer", action="append", default=None)
    e.add_argument("--scope", required=True)
    e.add_argument("--evidence", action="append", default=[])
    e.add_argument("--instruction", action="append")
    e.add_argument("--prior-round", type=int)
    s = sub.add_parser("snapshot")
    s.add_argument("phase", choices=["before", "after"])
    t = sub.add_parser("task", help="write the prompt for an external spawn-model-agent reviewer")
    t.add_argument("--slot", choices=["primary", "secondary"], default="primary")
    sub.add_parser("ledger", help="append an already persisted round to the reviewer ledger (backfill)")
    p = sub.add_parser("persist")
    p.add_argument("--spawn-job", help="spawn-model-agent job dir (external reviewer); replaces --transcript/--reviewer-ref")
    p.add_argument("--slot", choices=["primary", "secondary"], default="primary",
                   help="secondary: dual review, persist before the primary; the primary record then requires both")
    p.add_argument("--selected-by", choices=["user", "default-unattended", "carried-over"], default="user",
                   help="how the reviewer model was chosen (delegation-contract.md 3.1)")
    p.add_argument("--transcript", help="Claude Code subagent JSONL transcript")
    p.add_argument("--report-file", help="reviewer output text when no transcript is available")
    p.add_argument("--tools-used", action="append", help="observed tool names, with --report-file")
    p.add_argument("--findings", help="orchestrator-classified findings JSON list (primary slot)")
    p.add_argument("--reviewer-ref", help="runtime instance id returned by the Agent tool (subagent reviewer)")
    p.add_argument("--ref-source", default="Agent tool spawn return value (platform runtime)")
    p.add_argument("--model", default="unknown")
    p.add_argument("--trust-limit", action="append", default=[])
    args = ap.parse_args(argv)
    if args.cmd == "envelope" and not args.producer:
        args.producer = ["/root"]
    if args.cmd == "persist":
        if not (args.spawn_job or ((args.transcript or args.report_file) and args.reviewer_ref)):
            ap.error("persist needs --spawn-job, or --transcript/--report-file with --reviewer-ref")
        if args.slot == "primary" and not args.findings:
            ap.error("persist --slot primary needs --findings")
    {"freeze": cmd_freeze, "envelope": cmd_envelope, "snapshot": cmd_snapshot, "task": cmd_task,
     "ledger": cmd_ledger, "persist": cmd_persist}[args.cmd](args)


if __name__ == "__main__":
    main()
