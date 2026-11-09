#!/usr/bin/env python3
"""Claude Code Stop hook: remind to record a decision-diagnosis case once per turn.

When the current turn investigated a flow-engine / Hawk decision execution
(loaded `diagnose-decision-execution`, or queried the Hawk node / rule decision
water tables) and nothing in the session wrote to that skill's
`references/cases.md`, block the stop once with a reminder. The model may then
append a case or state in its reply that this turn has nothing to record
(`本轮无沉淀`), after which the hook lets the turn end.

Fail-open: any unexpected input lets the turn end silently.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence


OWNER = "agent-tools-decision-case-reminder-v1"
SKILL_NAME = "diagnose-decision-execution"
CASES_PATH_MARKER = f"{SKILL_NAME}/references/cases.md"
INVESTIGATION_MARKERS = (
    "t_strategy_node_decision_water",
    "t_rule_decision_water",
)
NO_CASE_PHRASES = ("本轮无沉淀", "无沉淀价值", "无需沉淀", "不沉淀")
MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024

REASON = (
    f"本轮做了流程/乐包决策执行排查，但 {SKILL_NAME} 的 references/cases.md 没有新增案例。"
    "请按其模板追加一条（入口、查询路径、结论、沉淀），只记录可复用的拼接关系、结果语义、调用方行为和坑；"
    "若确实没有可复用内容，在回复里写明“本轮无沉淀”再结束。"
)


def _iter_records(path: Path):
    if not path.is_file() or path.stat().st_size > MAX_TRANSCRIPT_BYTES:
        return
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict):
                yield record


def _is_user_prompt(record: dict[str, Any]) -> bool:
    if record.get("type") != "user":
        return False
    message = record.get("message")
    if not isinstance(message, dict) or message.get("role") != "user":
        return False
    content = message.get("content")
    if isinstance(content, str):
        return True
    if isinstance(content, list):
        return any(isinstance(block, dict) and block.get("type") == "text" for block in content)
    return False


def _tool_uses(record: dict[str, Any]):
    if record.get("type") != "assistant":
        return
    message = record.get("message")
    if not isinstance(message, dict):
        return
    content = message.get("content")
    if not isinstance(content, list):
        return
    for block in content:
        if isinstance(block, dict) and block.get("type") == "tool_use":
            yield block.get("name"), block.get("input")


def _assistant_text(record: dict[str, Any]) -> str:
    if record.get("type") != "assistant":
        return ""
    message = record.get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        block.get("text", "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    )


def _investigates(name: Any, tool_input: Any) -> bool:
    if name == "Skill" and isinstance(tool_input, dict) and tool_input.get("skill") == SKILL_NAME:
        return True
    try:
        payload = json.dumps(tool_input, ensure_ascii=False)
    except (TypeError, ValueError):
        return False
    return any(marker in payload for marker in INVESTIGATION_MARKERS)


def _records_case(name: Any, tool_input: Any) -> bool:
    if name not in {"Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"}:
        return False
    try:
        payload = json.dumps(tool_input, ensure_ascii=False)
    except (TypeError, ValueError):
        return False
    return CASES_PATH_MARKER in payload


def evaluate_transcript(path: Path, last_assistant_message: str | None = None) -> dict[str, Any]:
    """Return {} to allow the stop, or a block decision with a reason."""
    investigated_this_turn = False
    recorded_in_session = False
    last_text = ""
    for record in _iter_records(path):
        if _is_user_prompt(record):
            investigated_this_turn = False
            last_text = ""
            continue
        for name, tool_input in _tool_uses(record):
            if _investigates(name, tool_input):
                investigated_this_turn = True
            if _records_case(name, tool_input):
                recorded_in_session = True
        text = _assistant_text(record)
        if text:
            last_text = text
    final_text = last_assistant_message if isinstance(last_assistant_message, str) else last_text
    if not investigated_this_turn or recorded_in_session:
        return {}
    if any(phrase in final_text for phrase in NO_CASE_PHRASES):
        return {}
    return {"decision": "block", "reason": REASON}


def handle_event(event: Any) -> dict[str, Any]:
    if not isinstance(event, dict):
        return {}
    if event.get("hook_event_name") not in (None, "Stop"):
        return {}
    if event.get("stop_hook_active") is not False:
        return {}
    transcript = event.get("transcript_path")
    if not isinstance(transcript, str) or not transcript:
        return {}
    return evaluate_transcript(Path(transcript).expanduser(), event.get("last_assistant_message"))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner", choices=(OWNER,), required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    _parser().parse_args(argv)
    try:
        output = handle_event(json.load(sys.stdin))
    except Exception:
        output = {}
    json.dump(output, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
