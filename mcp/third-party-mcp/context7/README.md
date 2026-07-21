# Context7 MCP

本目录封装第三方 Context7 MCP server，用于获取最新、版本相关的库/API 文档。

来源：

- GitHub: `https://github.com/upstash/context7`
- npm package: `@upstash/context7-mcp`

## 启动

```bash
/home/joney/projects/ai/agent-tools/mcp/third-party-mcp/context7/bin/context7-mcp
```

launcher 固定安装并调用 `@upstash/context7-mcp@3.1.0`，默认使用 stdio transport。
首次启动会把依赖安装到 `$HOME/.local/share/agent-tools/mcp-cache/context7`，后续直接执行本地
`node_modules/.bin/context7-mcp`，避免每次启动都通过 `npx` 拉起和复用易损的 `/tmp` 缓存。
`CONTEXT7_API_KEY` 可选；不设置时仍可用，但会使用较低限流。

```bash
export CONTEXT7_API_KEY=...
```

## 工具

- `resolve-library-id`: 把库名解析为 Context7 library ID。
- `query-docs`: 按 library ID 查询相关文档。

## 设计取舍

Context7 也提供远程 HTTP MCP：`https://mcp.context7.com/mcp`。这里优先使用本地 npm stdio wrapper，
原因是 Codex/Claude Code 的 stdio 配置更统一，且 API key 可以通过本地环境变量传入，不需要在配置文件里写请求头。

## 运行时缓存

- `CONTEXT7_MCP_PACKAGE`：覆盖 npm 包规格，默认 `@upstash/context7-mcp@3.1.0`。
- `CONTEXT7_MCP_HOME`：覆盖安装目录，默认 `$HOME/.local/share/agent-tools/mcp-cache/context7`。
- `CONTEXT7_MCP_BIN`：完全跳过安装逻辑，直接执行指定的 `context7-mcp` bin。
- `AGENT_TOOLS_MCP_CACHE`：覆盖共享缓存根目录；Context7 会在其中使用 `context7/` 和 `npm/` 子目录。
