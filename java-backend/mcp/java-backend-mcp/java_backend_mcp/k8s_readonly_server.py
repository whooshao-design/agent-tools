"""Read-only Kubernetes MCP server backed by kubectl."""

from __future__ import annotations

import shutil

from mcp.server.fastmcp import FastMCP

from java_backend_mcp.common import bounded_int, command_result_text, error_text, run_command

mcp = FastMCP("Kubernetes Readonly")


def _kubectl_base(context: str = "", namespace: str = "") -> list[str]:
    args = ["kubectl"]
    if context:
        args.extend(["--context", context])
    if namespace:
        args.extend(["--namespace", namespace])
    return args


def _run(args: list[str], timeout: int = 60, max_chars: int = 50000) -> str:
    if not shutil.which("kubectl"):
        return error_text("kubectl is not installed or not in PATH")
    return command_result_text(run_command(args, timeout=timeout), max_chars=max_chars)


@mcp.tool()
def k8s_doctor() -> str:
    """检查 kubectl 是否可用。"""
    if not shutil.which("kubectl"):
        return error_text("kubectl is not installed or not in PATH")
    return _run(["kubectl", "version", "--client=true", "--output=yaml"], timeout=30)


@mcp.tool()
def k8s_contexts() -> str:
    """列出本机 kubeconfig contexts。"""
    return _run(["kubectl", "config", "get-contexts"], timeout=30, max_chars=20000)


@mcp.tool()
def k8s_get(resource: str, namespace: str = "", name: str = "", context: str = "", output: str = "wide", selector: str = "", max_chars: int = 50000) -> str:
    """执行 kubectl get。只支持 get，不支持写操作。"""
    if not resource:
        return error_text("resource is required")
    output = output if output in {"wide", "yaml", "json", "name"} else "wide"
    args = _kubectl_base(context, namespace)
    args.extend(["get", resource])
    if name:
        args.append(name)
    if selector:
        args.extend(["--selector", selector])
    args.extend(["--output", output])
    return _run(args, timeout=60, max_chars=bounded_int(max_chars, 50000, 1000, 100000))


@mcp.tool()
def k8s_describe(resource: str, name: str, namespace: str = "", context: str = "", max_chars: int = 50000) -> str:
    """执行 kubectl describe。"""
    if not resource or not name:
        return error_text("resource and name are required")
    args = _kubectl_base(context, namespace)
    args.extend(["describe", resource, name])
    return _run(args, timeout=60, max_chars=bounded_int(max_chars, 50000, 1000, 100000))


@mcp.tool()
def k8s_logs(pod: str, namespace: str = "", context: str = "", container: str = "", tail: int = 200, since: str = "", previous: bool = False, max_chars: int = 50000) -> str:
    """读取 pod 日志。默认 tail=200。"""
    if not pod:
        return error_text("pod is required")
    args = _kubectl_base(context, namespace)
    args.extend(["logs", pod, "--tail", str(bounded_int(tail, 200, 1, 5000))])
    if container:
        args.extend(["--container", container])
    if since:
        args.extend(["--since", since])
    if previous:
        args.append("--previous")
    return _run(args, timeout=90, max_chars=bounded_int(max_chars, 50000, 1000, 100000))


@mcp.tool()
def k8s_events(namespace: str = "", context: str = "", field_selector: str = "", max_chars: int = 50000) -> str:
    """读取 Kubernetes events，按时间排序。"""
    args = _kubectl_base(context, namespace)
    args.extend(["get", "events", "--sort-by=.lastTimestamp"])
    if field_selector:
        args.extend(["--field-selector", field_selector])
    return _run(args, timeout=60, max_chars=bounded_int(max_chars, 50000, 1000, 100000))


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
