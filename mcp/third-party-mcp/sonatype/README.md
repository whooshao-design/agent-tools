# Sonatype Dependency Management MCP

本目录记录 Sonatype 官方 Dependency Management MCP 的接入方式，用于依赖版本、安全漏洞、许可证与升级建议查询。

来源：

- GitHub: `https://github.com/sonatype/dependency-management-mcp-server`
- Remote MCP: `https://mcp.guide.sonatype.com/mcp`

## Codex 注册

Codex 支持远程 MCP，优先使用原生 remote 配置，token 只从环境变量读取：

```toml
[mcp_servers.sonatype]
url = "https://mcp.guide.sonatype.com/mcp"
bearer_token_env_var = "SONATYPE_GUIDE_MCP_TOKEN"
```

必需环境变量：

```bash
export SONATYPE_GUIDE_MCP_TOKEN=...
```

## stdio fallback

对只支持 stdio MCP 的客户端，可以使用本目录 wrapper：

```bash
/home/joney/projects/ai/agent-tools/mcp/third-party-mcp/sonatype/bin/sonatype-mcp
```

wrapper 使用 `mcp-remote@0.1.38` 连接 Sonatype 远程 MCP。注意：stdio fallback 会把 bearer header 传给
本机 `mcp-remote` 子进程；在 Codex 中优先使用上面的原生 remote 配置。

## 工具

官方当前提供三个依赖情报工具：

- `getComponentVersion`: 查询指定组件版本的信息。
- `getLatestComponentVersion`: 查询组件最新版本的信息。
- `getRecommendedComponentVersions`: 基于当前版本获取推荐升级版本。

## 设计取舍

Sonatype 是独立的依赖情报底层能力，不并入 SonarQube。SonarQube 负责代码质量/质量门禁；
Sonatype 负责依赖版本、安全与许可证风险，两者可以在上层 skill 中组合使用。
