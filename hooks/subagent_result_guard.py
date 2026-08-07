#!/usr/bin/env python3
"""Validate reviewer results when a delegated subagent stops."""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any, Sequence


SCHEMA = "delegation-result-v1"
OWNER = "agent-tools-subagent-result-v1"
MAX_SCAN_BYTES = 16 * 1024
REQUIRED_FIELDS = frozenset(
    {
        "schema",
        "task_id",
        "role",
        "status",
        "input_fingerprints",
        "conclusion",
        "changed_files",
        "unresolved",
    }
)
ALLOWED_ROLES = frozenset(
    {
        "agent-tools-requirements-reviewer",
        "agent-tools-solution-reviewer",
        "agent-tools-test-design-reviewer",
        "agent-tools-change-reviewer",
    }
)
ALLOWED_STATUSES = frozenset({"complete", "blocked"})
ALLOWED_CONCLUSIONS = {
    "agent-tools-requirements-reviewer": frozenset(
        {"通过", "有条件通过", "不通过", "材料不足"}
    ),
    "agent-tools-solution-reviewer": frozenset(
        {"通过", "有条件通过", "修改后复审", "退回重设计", "材料不足"}
    ),
    "agent-tools-test-design-reviewer": frozenset(
        {"通过", "修改后复审", "方案缺口", "材料不足"}
    ),
    "agent-tools-change-reviewer": frozenset(
        {"可继续推进", "修复后再评", "带风险接受", "证据不足"}
    ),
}
ALLOWED_CLIENTS = ("claude", "codex")

_JSON_FENCE_OPEN = re.compile(r"^```json[ \t]*\r?$", re.MULTILINE)
_FINAL_JSON_BLOCK = re.compile(
    r"\A```json[ \t]*\r?\n(?P<body>.*?)\r?\n```[ \t]*\s*\Z",
    re.DOTALL,
)


class ContractError(ValueError):
    """The final assistant message does not match delegation-result-v1."""


def _tail(message: str) -> str:
    encoded = message.encode("utf-8")
    return encoded[-MAX_SCAN_BYTES:].decode("utf-8", errors="ignore")


def _is_nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _validate_fields(result: dict[str, Any]) -> None:
    fields = set(result)
    if fields != REQUIRED_FIELDS:
        missing = sorted(REQUIRED_FIELDS - fields)
        unknown = sorted(fields - REQUIRED_FIELDS)
        details = []
        if missing:
            details.append(f"缺少字段: {', '.join(missing)}")
        if unknown:
            details.append(f"未知字段: {', '.join(unknown)}")
        raise ContractError("；".join(details))

    if result["schema"] != SCHEMA:
        raise ContractError(f"schema 必须为 {SCHEMA}")
    if not isinstance(result["role"], str) or result["role"] not in ALLOWED_ROLES:
        raise ContractError("role 不是允许的 reviewer 角色")
    if (
        not isinstance(result["status"], str)
        or result["status"] not in ALLOWED_STATUSES
    ):
        raise ContractError("status 必须为 complete 或 blocked")

    task_id = result["task_id"]
    if result["status"] == "complete":
        if not _is_nonempty_string(task_id):
            raise ContractError("complete 结果的 task_id 必须为非空字符串")
    elif task_id is not None and not _is_nonempty_string(task_id):
        raise ContractError("blocked 结果的 task_id 必须为 null 或非空字符串")

    fingerprints = result["input_fingerprints"]
    if not isinstance(fingerprints, dict):
        raise ContractError("input_fingerprints 必须为对象")
    if result["status"] == "complete" and not fingerprints:
        raise ContractError("complete 结果的 input_fingerprints 必须为非空对象")
    if not all(
        _is_nonempty_string(key) and _is_nonempty_string(value)
        for key, value in fingerprints.items()
    ):
        raise ContractError("input_fingerprints 的键和值必须为非空字符串")

    conclusion = result["conclusion"]
    if result["status"] == "complete":
        if conclusion not in ALLOWED_CONCLUSIONS[result["role"]]:
            raise ContractError("conclusion 不属于当前 reviewer 的允许结论")
    elif conclusion is not None:
        raise ContractError("blocked 结果的 conclusion 必须为 null")

    if result["changed_files"] != []:
        raise ContractError("reviewer 的 changed_files 必须严格为 []")

    unresolved = result["unresolved"]
    if not isinstance(unresolved, list) or not all(
        _is_nonempty_string(item) for item in unresolved
    ):
        raise ContractError("unresolved 必须为字符串数组")
    if result["status"] == "blocked" and not unresolved:
        raise ContractError("blocked 结果必须在 unresolved 中说明原因")


def parse_result(message: str) -> dict[str, Any]:
    """Parse and validate the last terminal JSON block in the final 16 KiB."""
    if not isinstance(message, str):
        raise ContractError("last_assistant_message 必须为字符串")

    tail = _tail(message)
    openings = list(_JSON_FENCE_OPEN.finditer(tail))
    if not openings:
        raise ContractError("末尾 16 KiB 内缺少 json fenced block")

    block = tail[openings[-1].start() :]
    match = _FINAL_JSON_BLOCK.fullmatch(block)
    if match is None:
        raise ContractError("json fenced block 必须位于最终消息末尾")

    try:
        result = json.loads(match.group("body"))
    except json.JSONDecodeError as error:
        raise ContractError("json fenced block 不是合法 JSON") from error
    if not isinstance(result, dict):
        raise ContractError("delegation result 必须为 JSON 对象")

    _validate_fields(result)
    return result


def _fail_open(message: str) -> dict[str, str]:
    return {"systemMessage": message}


def handle_event(event: Any, client: str) -> dict[str, Any]:
    """Return a client-specific SubagentStop response without side effects."""
    if client not in ALLOWED_CLIENTS:
        raise ValueError(f"unsupported client: {client}")
    if not isinstance(event, dict):
        return _fail_open("子代理结果校验器收到异常输入，已放行以避免阻塞。")
    if event.get("hook_event_name") != "SubagentStop":
        return _fail_open("子代理结果校验器收到非 SubagentStop 事件，已放行。")

    message = event.get("last_assistant_message")
    if not isinstance(message, str):
        return _fail_open("缺少可校验的子代理最终消息，已放行以避免阻塞。")

    agent_type = event.get("agent_type")
    if not isinstance(agent_type, str) or agent_type not in ALLOWED_ROLES:
        return _fail_open("缺少可信的子代理 agent_type，已放行以避免阻塞。")

    try:
        result = parse_result(message)
        if result["role"] != agent_type:
            raise ContractError(
                f"result.role 必须与 event.agent_type ({agent_type}) 一致"
            )
    except ContractError as error:
        if event.get("stop_hook_active") is not False:
            return _fail_open("子代理结果契约仍无效，已放行以避免重复阻塞。")

        reason = (
            f"子代理结果不符合 {SCHEMA}：{error}。"
            "请只修正最终 json fenced block，不要继续原任务；代码块后不得追加内容。"
        )
        return {"decision": "block", "reason": reason}

    return {}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client", choices=ALLOWED_CLIENTS, required=True)
    parser.add_argument("--owner", choices=(OWNER,), required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        event = json.load(sys.stdin)
        output = handle_event(event, args.client)
    except Exception:
        output = _fail_open("子代理结果校验器输入异常，已放行以避免阻塞。")
    json.dump(output, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
