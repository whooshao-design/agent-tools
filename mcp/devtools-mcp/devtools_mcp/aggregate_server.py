"""Single MCP server exposing every devtools_mcp tool from one process.

Each *_server module used to be registered separately, so one CLI session
started 16 Python processes. The MCP SDK alone costs ~45MB per interpreter
(a bare interpreter is ~9MB), which meant ~700MB per session for tools that
are mostly idle. Importing the modules into one process keeps the tools and
their names unchanged while paying the SDK cost once.
"""

from __future__ import annotations

import functools
import importlib
from typing import Any

import anyio.to_thread
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.tools.base import Tool

# Module basenames only; the tool names themselves stay as each module defines
# them, so only the MCP server prefix changes (mcp__healthy__x -> mcp__devtools__x).
SERVER_MODULES = (
    "artifact_repo",
    "browser_session",
    "config_registry",
    "cross_repo_search",
    "dubbo_test",
    "gitlab",
    "healthy",
    "java_app_diag",
    "jenkins",
    "k8s_readonly",
    "lexiao",
    "mq_readonly",
    "mysql_readonly",
    "observability",
    "redis_query",
    "sonarqube",
)

mcp = FastMCP("Devtools")


def _threaded(tool: Tool) -> Tool:
    """Run a blocking tool in a worker thread.

    FastMCP calls a sync tool straight from the event loop
    (func_metadata.call_fn_with_arg_validation), so in one process a slow tool
    would block every other tool call of the same session. That did not matter
    while each server had its own process; it does now.
    """
    fn = tool.fn

    @functools.wraps(fn)
    async def run_in_thread(*args: Any, **kwargs: Any) -> Any:
        return await anyio.to_thread.run_sync(functools.partial(fn, *args, **kwargs))

    return tool.model_copy(update={"fn": run_in_thread, "is_async": True})


def _load() -> None:
    for name in SERVER_MODULES:
        module = importlib.import_module(f"devtools_mcp.{name}_server")
        for tool_name, tool in module.mcp._tool_manager._tools.items():
            if tool_name in mcp._tool_manager._tools:
                raise RuntimeError(f"duplicate tool name {tool_name!r} from {name}_server")
            # Async tools already yield to the loop; java_app_diag additionally
            # serialises its single SSH connection with its own lock.
            mcp._tool_manager._tools[tool_name] = tool if tool.is_async else _threaded(tool)


_load()


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
