"""Read-only MQ MCP server for Kafka/RocketMQ and MQ consoles."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from mcp.server.fastmcp import FastMCP

from devtools_mcp.common import (
    DEFAULT_INTERNAL_ALLOWED_HOSTS,
    bounded_int,
    command_result_text,
    env_value,
    error_text,
    internal_http_get,
    json_text,
    parse_json_object,
    run_command,
)

mcp = FastMCP("MQ Readonly")


def _allowed_hosts() -> str:
    return env_value("MQ_ALLOWED_HOSTS", DEFAULT_INTERNAL_ALLOWED_HOSTS)


def _headers(headers_json: str) -> dict[str, str] | str:
    headers = parse_json_object(headers_json, {})
    if not isinstance(headers, dict):
        return "headers_json must be a JSON object"
    return {str(k): str(v) for k, v in headers.items()}


def _script(name: str) -> str:
    direct = shutil.which(name)
    if direct:
        return direct
    for candidate in (
        f"/usr/local/bin/{name}",
        f"/opt/kafka/bin/{name}",
        str(Path.home() / "tools" / "kafka" / "bin" / name),
        str(Path.home() / "tools" / "rocketmq" / "bin" / name),
    ):
        if shutil.which(candidate) or os.path.exists(candidate):
            return candidate
    return ""


@mcp.tool()
def mq_doctor() -> str:
    """检查本机 Kafka/RocketMQ 只读 CLI 是否可用。"""
    return json_text({
        "kafka_topics": bool(_script("kafka-topics.sh")),
        "kafka_consumer_groups": bool(_script("kafka-consumer-groups.sh")),
        "mqadmin": bool(_script("mqadmin")),
    })


@mcp.tool()
def kafka_list_topics(bootstrap_server: str, command_config: str = "", timeout_seconds: int = 60, max_chars: int = 50000) -> str:
    """Kafka topic 列表：kafka-topics.sh --list。"""
    script = _script("kafka-topics.sh")
    if not script:
        return error_text("kafka-topics.sh is not installed or not in PATH")
    if not bootstrap_server:
        return error_text("bootstrap_server is required")
    args = [script, "--bootstrap-server", bootstrap_server, "--list"]
    if command_config:
        args.extend(["--command-config", command_config])
    return command_result_text(run_command(args, timeout=bounded_int(timeout_seconds, 60, 5, 300)), max_chars=bounded_int(max_chars, 50000, 1000, 100000))


@mcp.tool()
def kafka_describe_topic(bootstrap_server: str, topic: str, command_config: str = "", timeout_seconds: int = 60, max_chars: int = 50000) -> str:
    """Kafka topic 描述：kafka-topics.sh --describe。"""
    script = _script("kafka-topics.sh")
    if not script:
        return error_text("kafka-topics.sh is not installed or not in PATH")
    if not bootstrap_server or not topic:
        return error_text("bootstrap_server and topic are required")
    args = [script, "--bootstrap-server", bootstrap_server, "--describe", "--topic", topic]
    if command_config:
        args.extend(["--command-config", command_config])
    return command_result_text(run_command(args, timeout=bounded_int(timeout_seconds, 60, 5, 300)), max_chars=bounded_int(max_chars, 50000, 1000, 100000))


@mcp.tool()
def kafka_consumer_groups(bootstrap_server: str, group: str = "", command_config: str = "", timeout_seconds: int = 60, max_chars: int = 50000) -> str:
    """Kafka consumer group 列表或指定 group lag 描述。"""
    script = _script("kafka-consumer-groups.sh")
    if not script:
        return error_text("kafka-consumer-groups.sh is not installed or not in PATH")
    if not bootstrap_server:
        return error_text("bootstrap_server is required")
    args = [script, "--bootstrap-server", bootstrap_server]
    if group:
        args.extend(["--describe", "--group", group])
    else:
        args.append("--list")
    if command_config:
        args.extend(["--command-config", command_config])
    return command_result_text(run_command(args, timeout=bounded_int(timeout_seconds, 60, 5, 300)), max_chars=bounded_int(max_chars, 50000, 1000, 100000))


@mcp.tool()
def rocketmq_admin(namesrv_addr: str, action: str = "clusterList", topic: str = "", group: str = "", timeout_seconds: int = 60, max_chars: int = 50000) -> str:
    """RocketMQ mqadmin 只读操作：clusterList/topicList/topicStatus/consumerProgress。"""
    script = _script("mqadmin")
    if not script:
        return error_text("mqadmin is not installed or not in PATH")
    if not namesrv_addr:
        return error_text("namesrv_addr is required")
    if action not in {"clusterList", "topicList", "topicStatus", "consumerProgress"}:
        return error_text("unsupported action", allowed="clusterList,topicList,topicStatus,consumerProgress")
    args = [script, action, "-n", namesrv_addr]
    if topic:
        args.extend(["-t", topic])
    if group:
        args.extend(["-g", group])
    return command_result_text(run_command(args, timeout=bounded_int(timeout_seconds, 60, 5, 300)), max_chars=bounded_int(max_chars, 50000, 1000, 100000))


@mcp.tool()
def mq_console_get(url: str, use_browser_session: bool = True, profile: str = "", headers_json: str = "{}", max_chars: int = 30000) -> str:
    """MQ 控制台只读 GET，适用于内部 Kafka/RocketMQ 管理页面/API。"""
    if not url:
        return error_text("url is required")
    headers = _headers(headers_json)
    if isinstance(headers, str):
        return error_text(headers)
    return json_text(internal_http_get(
        url,
        headers=headers,
        use_browser_session=use_browser_session,
        profile=profile,
        max_chars=bounded_int(max_chars, 30000, 1000, 100000),
        allowed_hosts=_allowed_hosts(),
    ))


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
