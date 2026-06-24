# MarkItDown MCP

本目录封装 Microsoft MarkItDown MCP server，用于把文档和网页内容转换为 Markdown。

来源：

- GitHub: `https://github.com/microsoft/markitdown`
- PyPI package: `markitdown-mcp`

## 启动

```bash
/home/joney/projects/ai/agent-tools/mcp/third-party-mcp/markitdown/bin/markitdown-mcp
```

launcher 优先使用 PATH 中已有的 `markitdown-mcp`；如果不存在，会在运行时缓存目录创建 venv，
并安装 `markitdown-mcp==0.0.1a4` 后启动 stdio server。

可覆盖缓存位置：

```bash
export AGENT_TOOLS_MCP_CACHE="$HOME/.local/share/agent-tools/mcp-cache"
```

## 工具

- `convert_to_markdown(uri)`: 支持 `http:`, `https:`, `file:`, `data:` URI。

## 安全边界

MarkItDown MCP 以当前用户权限运行。`file:` URI 可以读取当前用户有权限访问的文件；
只应在本机可信 agent 中使用，不要把 HTTP/SSE 模式绑定到非 localhost 地址。
