# GitHub MCP

本目录封装官方 GitHub MCP server，用于读取 GitHub 仓库、Issue、PR、Actions 和安全告警上下文。

来源：

- GitHub: `https://github.com/github/github-mcp-server`
- Docker image: `ghcr.io/github/github-mcp-server`

## 启动

```bash
/home/joney/projects/ai/agent-tools/mcp/third-party-mcp/github/bin/github-mcp
```

默认行为：

- 默认只读：设置 `GITHUB_READ_ONLY=1`，避免 issue、PR、workflow 等写操作。
- 默认 toolsets：`context,repos,issues,pull_requests,actions,code_security,dependabot`。
- 优先使用 `GITHUB_MCP_BIN` 或 PATH 中的 `github-mcp-server`；否则使用官方 Docker image。

必需环境变量：

```bash
export GITHUB_PERSONAL_ACCESS_TOKEN=...
```

也兼容 `GITHUB_TOKEN`，wrapper 会在本地映射为 `GITHUB_PERSONAL_ACCESS_TOKEN`。

可选覆盖：

```bash
export GITHUB_MCP_TOOLSETS="context,repos,issues,pull_requests"
export GITHUB_MCP_READ_ONLY=1
export GITHUB_HOST="https://github.example.com"
export GITHUB_MCP_IMAGE="ghcr.io/github/github-mcp-server:latest"
```

## 设计取舍

GitHub MCP 工具面很大，默认只开放研发常用的只读上下文能力，减少误操作和工具选择噪音。
需要写 issue、创建 PR 或触发 workflow 时，应显式放宽 `GITHUB_MCP_READ_ONLY` 或单独注册写能力。
