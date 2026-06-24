# Context7 MCP

本目录封装第三方 Context7 MCP server，用于获取最新、版本相关的库/API 文档。

来源：

- GitHub: `https://github.com/upstash/context7`
- npm package: `@upstash/context7-mcp`

## 启动

```bash
/home/joney/projects/ai/agent-tools/mcp/third-party-mcp/context7/bin/context7-mcp
```

launcher 固定调用 `@upstash/context7-mcp@3.1.0`，默认使用 stdio transport。
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
