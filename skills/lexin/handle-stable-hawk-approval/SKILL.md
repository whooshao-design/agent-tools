---
name: handle-stable-hawk-approval
description: 安全查询和处理 stable/测试环境米霍克与流程引擎审批。Use when 用户要求查看 stable 待审批、自动通过测试审批、处理米霍克 t_hawk_approval、处理流程引擎 t_approval、按业务字段或序号选择审批记录并调用回调、优化 /home/joney/tools/hawk 下旧审批脚本流程；只适用于 stable/测试环境，线上/生产审批不使用。
metadata:
  version: 1.1.1
---

# handle-stable-hawk-approval

## 定位

只处理 stable/测试环境的米霍克审批和流程引擎审批：先查询待审批记录，再 dry-run 展示将调用的回调，用户明确确认后才通过 Bianque 服务模拟器调用 Dubbo 回调，最后复查审批状态。

MCP 优先、脚本兜底。只读查询优先复用 `query-mysql-data` / `mysql_readonly` 能力；Dubbo 回调优先复用 `test-dubbo-api` / `dubbo_test` 能力。需要批量编排或本地固定流程时，使用脚本 `/home/joney/projects/ai/agent-tools/skills/lexin/handle-stable-hawk-approval/scripts/stable_approval_cli.py`。

## 安全边界

- 只允许 stable/测试环境。用户要求线上、生产、prod、pre 灰度审批时，拒绝使用本 skill。
- 默认只查询或 dry-run。没有用户明确要求执行，且没有 `approve --confirm`，不要发送审批回调。
- 确认执行时优先使用 `--select` 让用户按序号选择，或使用 `--logic-id` 单条处理；多条处理必须显式使用 `--allow-bulk`。
- 不在 skill、脚本、命令示例或回复中写入 Bearer token、Cookie、JSESSIONID、真实 IP 清单。
- 凭据只从本地环境变量读取：`LXCLOUD_BEARER_TOKEN`、可选 `LXCLOUD_COOKIE`、`BIANQUE_COOKIE`。
- 回调目标 IP:Port 必须由用户当次提供，或来自本地不入库配置 `~/.config/hawk-stable-approval/targets.json`。
- 执行后必须复查审批状态；如果无法复查，最终回复要明确说明。

## 审批来源

| scope | source | db_type | table |
|---|---|---|---|
| `domestic` | `hawk` | `HawkDecisionDB` | `hawkeye_decision_engine_db.t_hawk_approval` |
| `domestic` | `process` | `MxgProcessmanageDB` | `process_engine_db.t_approval` |
| `overseas` | `hawk` | `MxgHawkDecisionDB` | `hawkeye_decision_engine_db.t_hawk_approval` |
| `overseas` | `process` | `MxgProcessmanageDB` | `process_engine_db.t_approval` |

查询待处理记录时固定筛选 `Fapproval_state = 10`。默认只查当天 `Fmodify_time >= CURDATE()`；需要处理历史待审批时才加 `--all-dates`。

列表默认展示业务字段：`biz`、`package_id`、`package_name`、`plan_id`、`applicant`、`approval_operator`、`publish_type`、`publish_mode`、`summary`、回调 `route/target`。用户无需提前知道 `logic_id`；它只是回调接口需要的唯一标识。

## 回调路由

| 条件 | Dubbo service | target key |
|---|---|---|
| 米霍克普通审批 | `com.fenqile.rc_comm.hawk.decision.manage.service.ApprovalCallBackService` | `hawk_manage` |
| 米霍克 `Foper_type = 1` | `com.fenqile.rc_comm.hawk.decision.manage.service.approval.ProcessApprovalCallbackService` | `hawk_process_publish` |
| 流程引擎审批 | `com.fenqile.process.engine.console.service.approval.ApprovalCallBackService` | `process_engine` |

回调参数固定为：

```json
[{"code": 60, "logic_id": "<logic_id>"}]
```

## 推荐流程

1. 明确范围：`domestic` 还是 `overseas`，`hawk`、`process` 还是 `all`，是否指定 `logic_id`。
2. 查询待审批并 dry-run：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/handle-stable-hawk-approval/scripts/stable_approval_cli.py \
  list --scope domestic --source hawk --print-sql
```

3. 需要执行时，优先用交互选择，让用户按 `no` 列选择记录：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/handle-stable-hawk-approval/scripts/stable_approval_cli.py \
  approve --scope domestic --source hawk --select \
  --target hawk_manage=<ip>:<port> \
  --target hawk_process_publish=<ip>:<port> \
  --confirm
```

4. 已知 `logic_id` 时也可以直接单条执行；如果确实要批量处理，必须显式加 `--allow-bulk`，并保留默认 `--max-approve 20` 或设置更小上限。
5. 执行后检查脚本 `Verification` 区域，确认状态不再是 `10`；失败项逐条说明原因。

## 本地目标配置

可选本地文件：

```text
~/.config/hawk-stable-approval/targets.json
```

格式：

```json
{
  "hawk_manage": {"ip": "<ip>", "port": "<port>", "group": "stable", "version": "1.0.0"},
  "hawk_process_publish": {"ip": "<ip>", "port": "<port>", "group": "stable", "version": "1.0.0"},
  "process_engine": {"ip": "<ip>", "port": "<port>", "group": "stable", "version": "1.0.0"}
}
```

该文件必须只保存在本地，不提交到仓库。目标来自 Bianque 服务模拟器或 `test-dubbo-api` 的当前可用提供者。

## 常用命令

只 dry-run 单条，不发回调：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/handle-stable-hawk-approval/scripts/stable_approval_cli.py \
  approve --scope domestic --source hawk --logic-id <logic_id>
```

按业务字段列表选择，默认仍是 dry-run：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/handle-stable-hawk-approval/scripts/stable_approval_cli.py \
  approve --scope domestic --source hawk --select
```

海外米霍克待审批：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/handle-stable-hawk-approval/scripts/stable_approval_cli.py \
  list --scope overseas --source hawk
```

流程引擎单条执行：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/handle-stable-hawk-approval/scripts/stable_approval_cli.py \
  approve --scope domestic --source process --logic-id <logic_id> \
  --target process_engine=<ip>:<port> \
  --confirm
```

## 输出要求

最终回复按这个顺序：

1. `查询结果`：列出业务类型、乐包 ID/名称、发布计划 ID、申请人、审批人、状态、回调路由；`logic_id` 作为技术字段保留。
2. `执行情况`：说明是 dry-run 还是已确认执行；已执行时列成功/失败。
3. `复查结果`：给出审批状态是否已离开 `10`。
4. `使用命令`：只展示脱敏命令，不包含 Cookie、token 或真实 IP。
