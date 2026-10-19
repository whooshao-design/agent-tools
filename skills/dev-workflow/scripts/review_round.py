#!/usr/bin/env python3
"""Orchestrator helper for one formal review round (dev-review-* skills).

Implements the mechanical parts of delegation-contract.md and artifact-identity.md
so the orchestrator does not hand-write them per round:

  freeze    fingerprint the artifacts (versions read from the files), snapshot code
            repositories as repo-snapshot-v1, run mechanical checks
  envelope  write delegation-envelope.json from the frozen inputs (+ prior round)
  snapshot  workspace content snapshot before / after the reviewer runs
  persist   save the reviewer report and delegation-result-v1, run the structure
            check and write runtime-record + approval-record-v1

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
VERSION_RE = re.compile(r"版本[：:]\s*(v?\d+(?:\.\d+)*)|^\s*version:\s*(v?\d+(?:\.\d+)*)", re.M)
CONCLUSIONS = {
    "agent-tools-requirements-reviewer": ["通过", "有条件通过", "不通过", "材料不足"],
    "agent-tools-solution-reviewer": ["通过", "有条件通过", "修改后复审", "退回重设计", "材料不足"],
    "agent-tools-test-design-reviewer": ["通过", "修改后复审", "方案缺口", "材料不足"],
    "agent-tools-change-reviewer": ["可继续推进", "修复后再评", "带风险接受", "证据不足"],
}
PASSING = {"通过", "有条件通过", "可继续推进", "带风险接受"}
ALLOWED_TOOLS = {"Read", "Grep", "Glob", "SubagentHandback"}


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
    return (m.group(1) or m.group(2)) if m else "unversioned"


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


def cmd_freeze(args) -> None:
    base, rd = Path(args.req_dir), round_dir(args)
    ev = rd / "evidence"
    out = dict(artifact_identity(base, spec) for spec in args.artifact)
    write_json(ev / "code-baseline.json", {"schema": "repo-snapshot-set-v1", "repositories": [repo_snapshot(r) for r in args.repo]})
    out["B"] = ref(ev / "code-baseline.json")
    checks = solution_checks(base) if args.stage == "solution-review" else None
    if checks is not None:
        write_json(rd / "mechanical-checks.json", checks)
        out["mechanical_checks"] = ref(rd / "mechanical-checks.json")
    write_json(ev / "frozen-inputs.json", {"req_dir": str(base), "stage": args.stage, "round": args.round, "repos": args.repo, "inputs": out})
    print(json.dumps({k: {"version": v.get("version"), "fingerprint": v["fingerprint"]} for k, v in out.items()}, ensure_ascii=False, indent=2))
    if checks:
        bad = {k: v for k, v in checks.items() if k in ("changed_CHG_missing_from_overview", "section_refs_missing_in_solution", "evidence_cited_but_undefined") and v}
        if not checks["AC_sets_equal"]:
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
    prior_rec = json.loads((prd / "approval-record.json").read_text())
    prior_version = (prior_rec.get("bound_inputs", {}).get("S") or prior_env["inputs"]["S"]).get("version")
    inputs["prior_S"] = {"version": prior_version, "fingerprint": prior_env["input_fingerprints"]["S"]}
    fps["prior_S"] = prior_env["input_fingerprints"]["S"]
    old_dir = base / "solution-design/versions" / str(prior_version)
    if old_dir.is_dir():
        diff = b""
        for f in frozen["S"]["files"]:
            diff += subprocess.run(["diff", "-u", str(old_dir / f["path"]), str(Path(frozen["S"]["ref"]) / f["path"])], capture_output=True).stdout
        (rd / "evidence").mkdir(parents=True, exist_ok=True)
        dp = rd / "evidence" / "prior-diff.diff"
        dp.write_bytes(diff)
        inputs["diff"], fps["diff"] = str(dp), fp(dp)
    else:
        print(f"warning: {old_dir} not found, no diff generated; archive the prior version before re-review", file=sys.stderr)
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


def cmd_persist(args) -> None:
    rd = round_dir(args)
    ev = rd / "evidence"
    env = json.loads((rd / "delegation-envelope.json").read_text())
    if args.report_file:
        text, tools = Path(args.report_file).read_text(), set(args.tools_used or [])
    else:
        text, tools = extract_report(Path(args.transcript))
    (rd / "report.md").write_text(text.rstrip() + "\n")
    blocks = re.findall(r"```json\n(.*?)\n```", text, re.S)
    res = json.loads(blocks[-1])
    write_json(rd / "delegation-result.json", res)
    findings = json.loads(Path(args.findings).read_text())
    write_json(rd / "findings.json", findings)

    structure = {"schema_ok": res.get("schema") == "delegation-result-v1", "role_ok": res.get("role") == env["role"],
                 "status": res.get("status"), "task_id_ok": res.get("task_id") == env["task_id"],
                 "conclusion_in_enum": res.get("conclusion") in CONCLUSIONS.get(env["role"], []),
                 "changed_files_empty": res.get("changed_files") == [],
                 "fingerprints_echo_exact": res.get("input_fingerprints") == env["input_fingerprints"],
                 "nothing_after_json_block": text.rstrip().endswith("```")}
    write_json(ev / "structure-check.json", structure)
    before, after = (json.loads((ev / f"snapshot-{p}.json").read_text()) for p in ("before", "after"))
    equal = before["fingerprint"] == after["fingerprint"]
    unexpected = sorted(t for t in tools if t not in ALLOWED_TOOLS)
    runtime = {"reviewer_agent_ref": args.reviewer_ref, "ref_source": args.ref_source, "role": env["role"],
               "model": args.model, "tool_calls_observed": sorted(tools), "unexpected_tools": unexpected,
               "producer_refs": env["producer_agent_refs"],
               "write_set_proof": {"method": "same-scope before/after content snapshots", "before": fp(ev / "snapshot-before.json"),
                                   "after": fp(ev / "snapshot-after.json"), "equal": equal, "monitored_file_count": after["file_count"]},
               "trust_limits": args.trust_limit}
    write_json(ev / "runtime-record.json", runtime)
    valid = equal and not unexpected and all(v for k, v in structure.items() if k != "status") and res.get("status") == "complete" \
        and args.reviewer_ref not in env["producer_agent_refs"]
    opens = [f for f in findings if f.get("status") == "Open"]
    counts = {k: sum(1 for f in opens if f.get("severity") == k) for k in ("Blocker", "High", "Medium", "Low")}
    rec = {"schema": "approval-record-v1", "approval_id": env["task_id"] + "-approval", "stage": args.stage, "round": args.round,
           "bound_inputs": {k: env["inputs"][k] for k in ("R", "S", "C", "B") if k in env["inputs"]},
           "conclusion": res.get("conclusion") if valid else None, "producer_agent_refs": env["producer_agent_refs"],
           "reviewer_agent_ref": args.reviewer_ref,
           "checks": {"independence": {"passed": args.reviewer_ref not in env["producer_agent_refs"], "evidence": ref(ev / "runtime-record.json")},
                      "read_only": {"passed": not unexpected, "method": "reviewer tool allowlist; observed tool calls", "evidence": ref(ev / "runtime-record.json")},
                      "write_set_empty": {"passed": equal, "before": ref(ev / "snapshot-before.json"), "after": ref(ev / "snapshot-after.json"), "equal": equal},
                      "tool_surface": {"passed": not unexpected, "tools": ["Read", "Grep", "Glob"], "mcp_servers": [], "nested_delegation": False}},
           "review_execution": {"task_id": env["task_id"], "execution_status": "valid" if valid else "invalid", "status": res.get("status"),
                                "input_fingerprints": res.get("input_fingerprints"), "structure_check": ref(ev / "structure-check.json"),
                                "runtime_record": ref(ev / "runtime-record.json"), "delegation_envelope": ref(rd / "delegation-envelope.json")},
           "report": ref(rd / "report.md"), "delegation_result": ref(rd / "delegation-result.json"), "findings": ref(rd / "findings.json"),
           "open_finding_ids": [f["id"] for f in opens], "open_counts": counts,
           "material_gaps": [g for g in res.get("unresolved", []) if str(g).startswith("MG-")],
           "can_enter_next_stage": valid and res.get("conclusion") in PASSING, "production_release_approved": False,
           "created_at": datetime.datetime.now().astimezone().isoformat()}
    write_json(rd / "approval-record.json", rec)
    print(json.dumps({"valid": valid, "conclusion": rec["conclusion"], "open": counts, "material_gaps": rec["material_gaps"],
                      "unexpected_tools": unexpected, "write_set_equal": equal,
                      "structure_failures": [k for k, v in structure.items() if k != "status" and not v]}, ensure_ascii=False))
    if not valid:
        sys.exit(1)


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
    p = sub.add_parser("persist")
    p.add_argument("--transcript", help="Claude Code subagent JSONL transcript")
    p.add_argument("--report-file", help="reviewer output text when no transcript is available")
    p.add_argument("--tools-used", action="append", help="observed tool names, with --report-file")
    p.add_argument("--findings", required=True, help="orchestrator-classified findings JSON list")
    p.add_argument("--reviewer-ref", required=True, help="runtime instance id returned by the spawn tool")
    p.add_argument("--ref-source", default="Agent tool spawn return value (platform runtime)")
    p.add_argument("--model", default="unknown")
    p.add_argument("--trust-limit", action="append", default=[])
    args = ap.parse_args(argv)
    if args.cmd == "envelope" and not args.producer:
        args.producer = ["/root"]
    if args.cmd == "persist" and not (args.transcript or args.report_file):
        ap.error("persist needs --transcript or --report-file")
    {"freeze": cmd_freeze, "envelope": cmd_envelope, "snapshot": cmd_snapshot, "persist": cmd_persist}[args.cmd](args)


if __name__ == "__main__":
    main()
