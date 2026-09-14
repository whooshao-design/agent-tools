#!/usr/bin/env python3
"""预览环节选模；实际参与后用 --record BACKEND 登记，预览不写历史。

同一 task 的每种 artifact 只对应一份产物，调用方串行完成选择、调用和登记。
生成角色的登记也用于补录既有产物的生成者。
"""
from __future__ import annotations
import argparse
import datetime
import json
import os
import random
import shlex
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ROUTING = ROOT / "model-routing.json"
STATE = Path(os.environ.get("AGENT_ROUTING_HOME",
                            Path.home() / ".local/state/agent-routing"))


def load_routing() -> dict:
    return json.loads(ROUTING.read_text(encoding="utf-8"))


def record_path(task: str) -> Path:
    if not task or task in (".", "..") or any(
        not (c.isalnum() or c in "-_.") for c in task
    ):
        raise ValueError("任务 ID 只能包含 Unicode 字母数字与 -_.，且不能为 . 或 ..")
    return STATE / f"{task}.jsonl"


def read_record(task: str) -> list[dict]:
    p = record_path(task)
    if not p.exists():
        return []
    out = []
    for number, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if line:
            try:
                entry = json.loads(line)
                valid = (isinstance(entry, dict) and entry.get("task") == task
                         and entry.get("role") in ("generate", "review", "execute")
                         and isinstance(entry.get("backend"), str)
                         and isinstance(entry.get("artifact"), str)
                         and isinstance(entry.get("stage"), str)
                         and isinstance(entry.get("ts"), str)
                         and isinstance(entry.get("model", ""), str)
                         and type(entry.get("round")) is int
                         and entry["round"] > 0)
            except json.JSONDecodeError:
                valid = False
            if not valid:
                raise ValueError(f"记录 {p} 第 {number} 行损坏或任务不匹配；"
                                 "请保留文件并核对来源，不能跳过或清空生成者历史")
            out.append(entry)
    return out


def append_record(task: str, entry: dict) -> Path:
    p = record_path(task)
    p.parent.mkdir(parents=True, exist_ok=True)
    # 手工补录的最后一行可能没有换行符，不能把下一条 JSON 拼到同一行。
    separator = "\n" if p.exists() and p.stat().st_size and not p.read_bytes().endswith(b"\n") else ""
    with p.open("a", encoding="utf-8") as f:
        f.write(separator + json.dumps(entry, ensure_ascii=False) + "\n")
    return p


def resolve_model(backend: str, spec: dict) -> str:
    """读取配置模型名；不把它当作本次运行时模型证明。"""
    if "model" in spec:
        return spec["model"]
    src = spec.get("model_source", "")
    if not src.startswith("dynamic:"):
        return "(未知)"
    path_part, _, key = src[len("dynamic:"):].partition("#")
    path = Path(os.path.expanduser(path_part))
    if not path.exists():
        return f"(读不到 {path})"
    try:
        text = path.read_text(encoding="utf-8")
        config = json.loads(text) if path.suffix == ".json" else tomllib.loads(text)
        value = config.get(key) if isinstance(config, dict) else None
        return value if isinstance(value, str) and value.strip() else f"(缺 {key})"
    except (OSError, ValueError):
        return "(模型配置读取或解析失败)"


def build_command(backend: str, invocation: dict, role: str, material: str | None) -> str:
    """仅生成模板；所有调用参数保持为字面值，不在本脚本执行 shell。"""
    family = "codex" if backend == "codex-vps" else "claude"
    action = "review" if role == "review" else "generate"
    return invocation[f"{family}_{action}"].format(
        backend=shlex.quote(backend), material=shlex.quote(material or "<材料目录>"))


def select_backend(stage, history, backends, manual, replacement):
    producers = [h for h in history if h["role"] == "generate"]
    reviews = [h for h in history if h["role"] == "review"]
    excluded = set(manual)
    if stage["role"] == "review":
        excluded.update(h["backend"] for h in producers)
        models = {h["model"] for h in producers
                  if isinstance(h.get("model"), str) and not h["model"].startswith("(")}
        excluded.update(b for b in stage["candidates"]
                        if resolve_model(b, backends[b]) in models)
    pool = [b for b in stage["candidates"] if b not in excluded]
    if not pool:
        raise ValueError(f"无可用后端：候选 {stage['candidates']}，已排除 {sorted(excluded)}")
    notes = []
    if stage["role"] == "generate" and producers:
        # 换人后以最近的生成者为修订责任人；全部历史生成者仍不可参与评审。
        current = producers[-1]["backend"]
        if not replacement:
            if current not in pool:
                raise ValueError("原生成者已被排除或移出候选；确认换人条件后提供 "
                                 "--replace-producer 原因")
            return current, None, excluded, ["沿用当前生成者修订同一产物"]
        notes.append(f"已声明换人原因：{replacement}")
        pool = [b for b in pool if b != current]
        if not pool:
            raise ValueError("无可接替当前生成者的后端")
    if stage["role"] == "review":
        last_used = {h["backend"]: h["round"] for h in reviews}
        unused = [b for b in pool if b not in last_used]
        if not unused:
            chosen = min(pool, key=lambda b: last_used[b])
            return chosen, last_used[chosen], excluded, ["候选已用完，复用最久未使用的评审者"]
        pool = unused
        excluded.update(last_used)
    return random.choice(pool), None, excluded, notes


def pick(args) -> int:
    routing = load_routing()
    stages, backends = routing["stages"], routing["backends"]

    if args.stage not in stages:
        print(f"未知环节 {args.stage!r}。可选：{', '.join(stages)}", file=sys.stderr)
        return 2

    stage = stages[args.stage]
    role, artifact = stage["role"], stage["artifact"]
    candidates = list(stage["candidates"])
    history = [h for h in read_record(args.task) if h.get("artifact") == artifact]

    manual = [x.strip() for x in (args.exclude or "").split(",") if x.strip()]
    if set(manual) - backends.keys():
        raise ValueError(f"未知排除后端：{sorted(set(manual) - backends.keys())}")
    if args.replace_producer is not None and (role != "generate" or not args.replace_producer.strip()):
        raise ValueError("--replace-producer 仅用于生成角色，且必须提供换人原因")
    if args.record:
        # 登记是调用方提供的参与事实：不重新随机，也接受候选表外的既有生成者补录。
        chosen = args.record
        if chosen not in backends:
            raise ValueError(f"未知登记后端：{chosen}")
        if role == "review" and any(h["backend"] == chosen for h in history if h["role"] == "generate"):
            raise ValueError(f"{chosen} 是该产物的生成者，不能登记为评审者")
        reused = [h["round"] for h in history if h["role"] == "review" and h["backend"] == chosen]
        reuse_of = reused[-1] if role == "review" and reused else None
        excluded, notes = set(), []
    else:
        chosen, reuse_of, excluded, notes = select_backend(
            stage, history, backends, manual, args.replace_producer)
        if role == "review" and not any(h["role"] == "generate" for h in history):
            notes.append("该产物还没有生成者记录；若由模型生成，先按生成环节 --record 补录")

    spec = backends[chosen]
    entry = {
        "ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "task": args.task, "artifact": artifact, "stage": args.stage,
        "role": role, "backend": chosen,
        "model": args.actual_model or resolve_model(chosen, spec),
        "model_basis": "runtime" if args.actual_model else "configured",
        "round": max((h["round"] for h in history if h["role"] == role), default=0) + 1,
        "candidates": candidates,
        "excluded": sorted(excluded),
        "reuse_of_round": reuse_of,
        "replacement_reason": args.replace_producer,
        "event": "participation" if args.record else "preview",
    }
    rec = append_record(args.task, entry) if args.record else record_path(args.task)
    cmd = None if args.record else build_command(chosen, routing["invocation"], role, args.material)
    tested_model = spec.get("review_test_model")
    if tested_model and entry["model"] != tested_model:
        notes.append(f"评审分数是在 {tested_model} 上测的，当前模型不同")

    if args.json:
        print(json.dumps({**entry, "command": cmd, "record": str(rec),
                          "notes": notes}, ensure_ascii=False, indent=2))
        return 0

    print(f"{'登记' if args.record else '预览'}   {args.stage}  ({role}, artifact={artifact}, 第 {entry['round']} 轮)")
    basis = "运行值" if entry["model_basis"] == "runtime" else "配置值"
    print(f"选中   {chosen}   模型 {entry['model']}（{basis}）")
    if entry["excluded"]:
        print(f"已排除 {', '.join(entry['excluded'])}")
    for n in notes:
        print(f"注意   {n}")
    if spec.get("warn"):
        print(f"提醒   {spec['warn']}")
    if role == "review" and spec.get("readonly_requires"):
        print(f"只读   {spec['readonly_requires']}")
    print(f"记录   {rec}{'' if args.record else '（未写入）'}")
    if cmd:
        print(f"\n调用模板（填入 prompt 和材料目录后使用；不要直接 eval 输出）：\n{cmd}")
    return 0


def show(args) -> int:
    for h in read_record(args.task):
        ru = f"  (复用第 {h['reuse_of_round']} 轮)" if h.get("reuse_of_round") else ""
        print(f"{h['ts']}  {h['stage']:<20} {h['role']:<9} {h['backend']:<17} "
              f"{h.get('model', '(未知)'):<18} 第{h['round']}轮{ru}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="预览选模；实际参与后用 --record BACKEND 登记")
    ap.add_argument("stage", nargs="?", help="环节名，省略时配合 --show-record")
    ap.add_argument("--task", required=True, help="任务 ID，用于隔离记录")
    ap.add_argument("--material", help="评审材料目录（用于调用模板中的 cd）")
    ap.add_argument("--exclude", help="额外排除的后端，逗号分隔")
    ap.add_argument("--replace-producer", metavar="原因", help="确认无法继续修订后，显式选择接替者")
    ap.add_argument("--actual-model", help="登记时填本次运行返回的模型 ID")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    action = ap.add_mutually_exclusive_group()
    action.add_argument("--record", metavar="BACKEND", help="登记实际生成/修订、完成的评审或验证；也可补录既有生成者")
    action.add_argument("--show-record", action="store_true", help="查看该任务的参与历史")
    args = ap.parse_args()
    if args.actual_model is not None and (not args.record or not args.actual_model.strip()):
        ap.error("--actual-model 仅用于 --record，且不能为空")
    if args.record and args.exclude:
        ap.error("--record 登记实际事实，不接受 --exclude；排除用于预览")
    if not args.stage and not args.show_record:
        ap.error("需要指定环节名，或使用 --show-record")
    try:
        return show(args) if args.show_record else pick(args)
    except (ValueError, OSError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
