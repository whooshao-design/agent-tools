---
name: server-log
version: 3.0.0
description: "通过堡垒机 MCP 工具在目标服务器上只读排查应用日志和部署状态。支持多环境多应用。"
---

# server-log

## 适用场景

用户要求查看服务器日志、线上日志、error 日志、按 traceId/关键字排查应用日志、检查部署状态时使用。

## 核心约束

- **必须使用 MCP 函数工具调用**，不是 Bash 命令。使用 `mcp__bastion__*` 前缀的函数工具
- 优先使用堡垒机 MCP 工具；只有当本机命令本身已封装跳板机链路时，才可使用该只读命令
- 默认日志目录：`/home/product/logs/<app_name>_logs/`
- 部署目录通常为 `/home/product/<app_name>/`
- 只执行只读命令，不修改、不删除、不重启服务
- 不要直连目标业务服务器，不要猜测账号、密码或密钥

## 命令白名单与禁止项

允许：`cd grep egrep ls ll cat head tail find echo pwd whoami hostname zcat awk sort wc uniq ps`

禁止：`rm mv cp sed chmod chown vi vim nano tee touch truncate kill restart > >> &` 等写操作和交互编辑。

## 环境与服务器

> 以下为 hawk 项目常用服务器，其他项目需根据实际情况调整。

| 环境 | 目标 IP | 应用名 |
|------|---------|--------|
| Stable | `10.9.112.216` | `server_hawk_decision_manage` |
| 预发布 | `10.16.26.219` | `server_hawk_decision_manage` |

其他应用/环境由用户指定 IP 和应用名。

## 日志文件

默认日志目录：`/home/product/logs/<app_name>_logs/`

常见日志文件：
- `debug.log` — 主日志（当前）
- `error.log` — 错误日志
- `startup.log` — 启动日志
- `debug.log.*` / `error.log.*` — 历史日志（按日期轮转，可能有 `.gz` 压缩）

## 默认参数

用户未明确指定时，按以下规则推导：

- 说"error 日志" → 优先查 `error.log`
- 说"错误/异常"但未指定文件 → 先查 `error.log`，必要时再查 `debug.log` 中的 `ERROR|Exception|Throwable|Caused by`
- 说"启动" → 查 `startup.log`
- 未指定行数时，返回最近 50 行以内的高价值结果
- 未指定时间范围时，查当前日志文件（非历史）

## 工作流程

### 步骤 1：确认连接能力

#### 环境判断

如果目标是测试环境、stable、项目环境或 prj 机器，固定走 dev 堡垒机 `dev.ssh.jumpserver.fenqile.cn`。不要先尝试生产堡垒机。

#### 有堡垒机 MCP 工具时

1. 调用 `mcp__bastion__connection_status`（无参数）检查状态。
2. 未连接 → 调用 `mcp__bastion__connect_bastion`。
3. 如果返回 `目标登录节点...为线下环境,请使用堡垒机dev.ssh.jumpserver.fenqile.cn` → 当前 MCP 堡垒机路径不支持该测试/项目环境机器。不要反复重试；记录被 dev 堡垒机路径阻断，只有工具或用户环境明确提供 dev 堡垒机能力后再继续。
4. MCP 工具不可用或报 Pending approval → **停止并提示用户**：需要先在 Claude Code 中批准 bastion MCP 连接（`claude mcp approve bastion` 或重启会话时批准）。

#### 无堡垒机 MCP 工具时

1. 检查是否存在已封装跳板机链路的只读命令。
2. 无法确认跳板链路时停止执行，明确说明"当前环境没有可用堡垒机/跳板机能力"。

### 步骤 2：确认目标服务器可达

调用 `mcp__bastion__execute_command`：
- `ip`: 目标服务器 IP
- `command`: `hostname && whoami && pwd`

不可达时提示用户确认 IP 是否正确。

### 步骤 3A：排查部署状态

> 当用户要求检查部署情况、发布状态、应用是否正常时执行。

#### 3A.1 检查应用进程

```
command: ps -ef | grep <app_name> | grep -v grep
```

无进程 → 应用未启动，继续检查启动日志。

#### 3A.2 检查部署目录

```
command: ls -ll /home/product/<app_name>/
```

#### 3A.3 检查启动日志

```
command: tail -100 /home/product/logs/<app_name>_logs/startup.log
```

#### 3A.4 检查最近错误

```
command: tail -100 /home/product/logs/<app_name>_logs/error.log
```

#### 3A.5 汇总部署状态

综合以上信息，结构化输出：
- 应用是否在运行（进程状态）
- 部署目录是否存在及内容
- 启动是否成功（耗时、有无异常）
- 是否有明显错误

### 步骤 3B：搜索日志

> 当用户要求搜索特定关键字、traceId、异常、时间范围时执行。

#### 当前日志关键字搜索

```
command: grep -i '<关键字>' /home/product/logs/<app_name>_logs/error.log | tail -50
```

#### 限定时间范围

```
command: grep -i '<关键字>' /home/product/logs/<app_name>_logs/error.log | grep 'YYYY-MM-DD' | tail -50
```

#### 异常堆栈（扩大上下文）

```
command: grep -n -i 'Exception\|ERROR\|Caused by' /home/product/logs/<app_name>_logs/error.log | tail -50
```

#### 跨文件搜索

```
command: grep -rn '<关键字>' /home/product/logs/<app_name>_logs/ --include='*.log' | tail -50
```

#### 历史压缩日志

```
command: zcat /home/product/logs/<app_name>_logs/error.log.YYYY-MM-DD.gz | grep -i '<关键字>' | tail -50
```

### 步骤 4：汇总结论

**不要贴大量原始日志。** 优先结构化说明：

1. 查询的 IP、应用、日志文件和时间范围
2. 是否发现 ERROR/Exception
3. 关键异常类型、traceId、业务字段、出现次数和最近时间
4. 与用户当前问题相关的判断
5. 如果没查到，说明已查范围和下一步建议
