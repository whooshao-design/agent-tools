#!/usr/bin/env python3
"""按 model-routing.json 的规则为某个环节选后端，并记录实际选择。

规则由数据驱动，不在代码里硬编码候选集：
  - 生成者终身排除：同一 artifact 上做过 generate 的后端，不能再评审该 artifact
  - 评审者每轮轮换：优先选该 artifact 上还没当过评审者的
  - 候选耗尽可复用：标记 reuse=true 并说明复用了哪一轮
  - 修订由原生成者做：generate 角色若该 artifact 已有生成者，直接沿用

用法：
  pick_agent.py <stage> --task <task-id> [--material <dir>] [--exclude a,b] [--json]
  pick_agent.py --show-record --task <task-id>
"""
from __future__ import annotations
import argparse, json, os, random, sys, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ROUTING = ROOT / "model-routing.json"
STATE = Path(os.environ.get("AGENT_ROUTING_HOME",
                            Path.home() / ".local/state/agent-routing"))


def load_routing() -> dict:
    return json.loads(ROUTING.read_text(encoding="utf-8"))


def record_path(task: str) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in task)
    return STATE / f"{safe}.jsonl"


def read_record(task: str) -> list[dict]:
    p = record_path(task)
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def append_record(task: str, entry: dict) -> Path:
    p = record_path(task)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return p


def resolve_model(backend: str, spec: dict) -> str:
    """把 dynamic:<路径>#<键> 解析成实际模型名；固定模型直接返回。"""
    if "model" in spec:
        return spec["model"]
    src = spec.get("model_source", "")
    if not src.startswith("dynamic:"):
        return "(未知)"
    path_part, _, key = src[len("dynamic:"):].partition("#")
    path = Path(os.path.expanduser(path_part))
    if not path.exists():
        return f"(读不到 {path})"
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".json":
        try:
            return str(json.loads(text).get(key, "(缺 %s)" % key))
        except Exception:
            return "(JSON 解析失败)"
    # TOML：只取第一个 section 之前的顶层键
    for line in text.splitlines():
        if line.lstrip().startswith("["):
            break
        s = line.strip()
        if s.startswith(f"{key}") and "=" in s:
            v = s.split("=", 1)[1].strip()
            return v.strip('"').strip("'")
    return f"(缺 {key})"


def build_command(backend: str, spec: dict, role: str, material: str | None) -> str:
    needs_ro = role == "review"
    if backend == "codex-vps":
        if needs_ro:
            d = material or "<材料目录>"
            return f'cd {d} && codex-reviewer "<prompt>" </dev/null'
        return 'codex-vps exec --skip-git-repo-check "<prompt>" </dev/null'
    base = f'{backend} -p --strict-mcp-config'
    if needs_ro:
        d = material or "<材料根>"
        base += f' --allowedTools "Read Grep Glob" --add-dir {d}'
    return base + ' "<prompt>"'


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

    producers = [h["backend"] for h in history if h["role"] == "generate"]
    reviewers = [h["backend"] for h in history if h["role"] == "review"]
    manual = [x for x in (args.exclude or "").split(",") if x]

    reuse_of = None
    notes = []

    if role == "generate" and producers:
        # 修订由原生成者做
        chosen = producers[0]
        notes.append(f"沿用原生成者（修订规则）；该产物已有 {len(producers)} 次生成")
    else:
        excluded = set(manual)
        if role in ("review", "execute"):
            excluded |= set(producers)          # 生成者终身排除
        if role == "review":
            excluded |= set(reviewers)          # 每轮轮换
        pool = [c for c in candidates if c not in excluded]

        if not pool and role == "review":
            # 候选耗尽：放宽轮换，仅保留生成者排除
            relaxed = [c for c in candidates if c not in set(manual) | set(producers)]
            if relaxed:
                # 规则：复用最早那一轮的评审者，而不是再随机一次
                review_hist = [h for h in history if h["role"] == "review"]
                order = {h["backend"]: i + 1 for i, h in reversed(list(enumerate(review_hist)))}
                chosen = min(relaxed, key=lambda c: order.get(c, len(order) + 1))
                reuse_of = order.get(chosen)
                notes.append(f"候选耗尽，复用第 {reuse_of} 轮评审者" if reuse_of
                             else "候选耗尽，放宽轮换后仍有未用过的后端")
            else:
                print(f"无可用后端：{args.stage} 候选 {candidates}，"
                      f"已排除生成者 {producers} 与手动排除 {manual}", file=sys.stderr)
                return 1
        elif not pool:
            print(f"无可用后端：{args.stage} 候选 {candidates}，已排除 {sorted(excluded)}",
                  file=sys.stderr)
            return 1
        else:
            chosen = random.choice(pool)

    spec = backends[chosen]
    entry = {
        "ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "task": args.task, "artifact": artifact, "stage": args.stage,
        "role": role, "backend": chosen,
        "model": resolve_model(chosen, spec),
        "round": len([h for h in history if h["role"] == role]) + 1,
        "candidates": candidates,
        "excluded": sorted(set(manual) | (set(producers) if role != "generate" else set())
                           | (set(reviewers) if role == "review" and reuse_of is None else set())),
        "reuse_of_round": reuse_of,
    }
    rec = append_record(args.task, entry)
    cmd = build_command(chosen, spec, role, args.material)

    if args.json:
        print(json.dumps({**entry, "command": cmd, "record": str(rec),
                          "notes": notes}, ensure_ascii=False, indent=2))
        return 0

    print(f"环节   {args.stage}  ({role}, artifact={artifact}, 第 {entry['round']} 轮)")
    print(f"选中   {chosen}   模型 {entry['model']}")
    if entry["excluded"]:
        print(f"已排除 {', '.join(entry['excluded'])}")
    for n in notes:
        print(f"注意   {n}")
    if spec.get("warn"):
        print(f"提醒   {spec['warn']}")
    if role == "review" and spec.get("readonly_requires"):
        print(f"只读   {spec['readonly_requires']}")
    print(f"记录   {rec}")
    print(f"\n{cmd}")
    return 0


def show(args) -> int:
    for h in read_record(args.task):
        ru = f"  (复用第 {h['reuse_of_round']} 轮)" if h.get("reuse_of_round") else ""
        print(f"{h['ts']}  {h['stage']:<20} {h['role']:<9} {h['backend']:<17} "
              f"{h['model']:<18} 第{h['round']}轮{ru}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="按 model-routing.json 选后端并记录")
    ap.add_argument("stage", nargs="?", help="环节名，省略时配合 --show-record")
    ap.add_argument("--task", required=True, help="任务 ID，用于隔离记录")
    ap.add_argument("--material", help="评审材料目录（评审角色用于拼 --add-dir / cd）")
    ap.add_argument("--exclude", help="额外排除的后端，逗号分隔")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--show-record", action="store_true", help="查看该任务的选择历史")
    args = ap.parse_args()
    if args.show_record:
        return show(args)
    if not args.stage:
        ap.error("需要指定环节名，或使用 --show-record")
    return pick(args)


if __name__ == "__main__":
    sys.exit(main())
