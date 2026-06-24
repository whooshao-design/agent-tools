# third-party-mcp

第三方通用 MCP server 的本地 wrapper。这里不 vendoring 第三方源码，也不提交运行时依赖缓存；
仓库只保存稳定的启动入口、版本约束和注册说明。

| MCP | Wrapper | 用途 |
|---|---|---|
| `context7` | `context7/bin/context7-mcp` | 查询最新、版本相关的库/API 文档 |
| `github` | `github/bin/github-mcp` | 只读读取 GitHub 仓库、Issue、PR、Actions 和安全告警上下文 |
| `markitdown` | `markitdown/bin/markitdown-mcp` | 将 PDF、Office、HTML、图片、CSV/JSON/XML 等转换为 Markdown |
| `sonatype` | `sonatype/bin/sonatype-mcp` | 查询依赖版本、安全漏洞、许可证与升级建议；Codex 优先用 remote 配置 |

## Codex 注册

无凭据即可启动的通用 MCP：

```bash
codex mcp add context7 -- /home/joney/projects/ai/agent-tools/mcp/third-party-mcp/context7/bin/context7-mcp
codex mcp add markitdown -- /home/joney/projects/ai/agent-tools/mcp/third-party-mcp/markitdown/bin/markitdown-mcp
```

GitHub 和 Sonatype 需要 token；不要在未设置 token 时默认注册，否则 Codex 启动会报 MCP startup failed。
需要时先导出环境变量，再注册：

```bash
export GITHUB_PERSONAL_ACCESS_TOKEN=...
codex mcp add github -- /home/joney/projects/ai/agent-tools/mcp/third-party-mcp/github/bin/github-mcp

export SONATYPE_GUIDE_MCP_TOKEN=...
codex mcp add sonatype --url https://mcp.guide.sonatype.com/mcp --bearer-token-env-var SONATYPE_GUIDE_MCP_TOKEN
```

不要把 token 写入 Codex 配置。Context7 API key 是可选项，需要更高限流时在启动 Codex 前导出：

```bash
export CONTEXT7_API_KEY=...
```

## Claude Code 注册

```bash
claude mcp add --scope user context7 -- /home/joney/projects/ai/agent-tools/mcp/third-party-mcp/context7/bin/context7-mcp
claude mcp add --scope user markitdown -- /home/joney/projects/ai/agent-tools/mcp/third-party-mcp/markitdown/bin/markitdown-mcp
```

有 token 后再按需注册：

```bash
export GITHUB_PERSONAL_ACCESS_TOKEN=...
claude mcp add --scope user github -- /home/joney/projects/ai/agent-tools/mcp/third-party-mcp/github/bin/github-mcp

export SONATYPE_GUIDE_MCP_TOKEN=...
claude mcp add --scope user sonatype -- /home/joney/projects/ai/agent-tools/mcp/third-party-mcp/sonatype/bin/sonatype-mcp
```

## 运行时缓存

wrapper 默认使用 `/tmp/agent-tools-mcp-cache` 放 npm/pip/venv 缓存，避免写入 `.codex` 或仓库。
如需持久化到用户目录，可在启动 agent 前设置：

```bash
export AGENT_TOOLS_MCP_CACHE="$HOME/.local/share/agent-tools/mcp-cache"
```
