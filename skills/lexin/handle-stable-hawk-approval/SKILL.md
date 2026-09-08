---
name: handle-stable-hawk-approval
description: 安全查询和处理 stable/测试环境米霍克与流程引擎审批。Use when 用户要求查看 stable 待审批、审批某个乐包的测试环境发布、自动通过测试审批、处理米霍克 t_hawk_approval、处理流程引擎 t_approval、按乐包 ID/发布计划 ID/序号选择审批记录并调用回调、处理墨西哥或印尼测试环境审批、优化 /home/joney/tools/hawk 下旧审批脚本流程；只适用于 stable/测试环境，线上/生产审批不使用。
metadata:
  version: 1.2.0
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
- 凭据由脚本在进程内解析（env → 本地浏览器会话快照），不打印明文、不写入回复；细节见下一节。
- 回调目标 IP:Port 必须由用户当次提供，或来自本地不入库配置 `~/.config/hawk-stable-approval/targets.json`。
- 执行后必须复查审批状态；如果无法复查，最终回复要明确说明。

## 凭据获取

脚本自己解析凭据，正常不需要手工导出：

1. 环境变量 `LXCLOUD_BEARER_TOKEN`、`BIANQUE_COOKIE`（可选 `LXCLOUD_COOKIE`、`LXCLOUD_MID`）。
2. 缺失时读本地快照 `~/.local/state/agent-tools/session-snapshots/stable-lxcloud.json`（0600，由 `get-browser-session` 生成）。
3. 快照不存在、或其中 token 已按 JWT `exp` 判定过期时，才对 `https://stable-lxcloud.oa.fenqile.com/` 调一次 `--export-session` 刷新。

两个容易踩的点：

- **stable 与线上是两个 origin**：`~/.local/state/agent-tools/session-snapshots/main.json` 里只有 `lxcloud.oa.fenqile.com` 的 token，对 stable 无效，必须对 stable-lxcloud 单独 export。
- **Cookie 是 profile 级的**：同一次 export 会顺带带出 `stable-bianque.lexinfintech.com` 的 `JSESSIONID`，回调不用再单独取。

`user_name` 默认取 token 里的 `sub`（OA 账号）而不是本机用户名，避免本机账号与 OA 账号不一致时被误判无实例权限；`--user-name` 或 `LXCLOUD_USER_NAME` 可覆盖。`--no-browser-session`（或 `LXCLOUD_DISABLE_BROWSER_SESSION=1`）强制只用环境变量。

## 审批来源

| scope | source | db_type | table |
|---|---|---|---|
| `domestic` | `hawk` | `HawkDecisionDB` | `hawkeye_decision_engine_db.t_hawk_approval` |
| `domestic` | `process` | `ProcessmanageDB` | `process_engine_db.t_approval` |
| `mexico` | `hawk` | `MxgHawkDecisionDB` | `hawkeye_decision_engine_db.t_hawk_approval` |
| `mexico` | `process` | `MxgProcessmanageDB` | `process_engine_db.t_approval` |
| `indonesia` | `hawk` | `YnHawkDecisionDB` | `hawkeye_decision_engine_db.t_hawk_approval` |
| `indonesia` | `process` | `YnProcessmanageDB` | `process_engine_db.t_approval` |

海外每个地区是独立应用、独立库、独立实例，不能混用。`--scope overseas` 保留为 `mexico` 的别名。

查询待处理记录时固定筛选 `Fapproval_state = 10`。默认只查当天 `Fmodify_time >= CURDATE()`；需要处理历史待审批时才加 `--all-dates`。

lxcloud 单次查询最多返回 100 行且是**静默截断**，所以按乐包或计划筛选必须用 `--package-id` / `--plan-id`（SQL 端下推到 `t_edition_publish_plan` 上），不要拉全量回来再肉眼找。这两个参数只对 `--source hawk` 有效，`t_approval` 没有发布计划可 join。

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

1. 明确范围：`domestic`、`mexico` 还是 `indonesia`，`hawk`、`process` 还是 `all`。用户说“海外”而没指明国家时要问清楚，不要默认墨西哥。
2. 查询待审批并 dry-run。用户给的通常是乐包 ID，直接用 `--package-id` 定位，不要让用户提供 `logic_id`：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/handle-stable-hawk-approval/scripts/stable_approval_cli.py \
  list --scope mexico --source hawk --package-id <package_id> --print-sql
```

3. 需要执行时，优先用交互选择，让用户按 `no` 列选择记录：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/handle-stable-hawk-approval/scripts/stable_approval_cli.py \
  approve --scope domestic --source hawk --select \
  --target domestic.hawk_manage=<ip>:<port> \
  --target domestic.hawk_process_publish=<ip>:<port> \
  --confirm
```

4. `--logic-id`、`--package-id`、`--plan-id` 都算显式收窄，可直接单条执行；命中多条时仍必须显式加 `--allow-bulk`，并保留默认 `--max-approve 20` 或设置更小上限。
5. 执行后检查脚本 `Verification` 区域，确认状态不再是 `10`；失败项逐条说明原因。回调失败或 `errcode != 0` 时先怀疑目标实例地址漂移，用 `query-app-instances` 复核后用 `--target` 覆盖。

Bianque 即使 Dubbo 调用失败也返回 HTTP 200，脚本按响应体里的 `errcode` 和 `result.result` 判定成功，不要只看 HTTP 状态码。

## 本地目标配置

可选本地文件：

```text
~/.config/hawk-stable-approval/targets.json
```

格式按 scope 分层，每个地区有自己的实例：

```json
{
  "domestic": {
    "hawk_manage": {"ip": "<ip>", "port": "<port>", "group": "stable", "version": "1.0.0"},
    "hawk_process_publish": {"ip": "<ip>", "port": "<port>", "group": "stable", "version": "1.0.0"},
    "process_engine": {"ip": "<ip>", "port": "<port>", "group": "stable", "version": "1.0.0"}
  },
  "mexico": {
    "hawk_manage": {"ip": "<ip>", "port": "<port>", "group": "stable", "version": "1.0.0"}
  },
  "indonesia": {
    "hawk_manage": {"ip": "<ip>", "port": "<port>", "group": "stable", "version": "1.0.0"}
  }
}
```

取地址时先查 `<scope>.<target_key>`，没有再回退到顶层裸 `<target_key>`；`--target mexico.hawk_manage=<ip>:<port>` 覆盖文件配置。不分 scope 只写裸 key 时，国内和海外会互相覆盖，回调可能打到错误地区的实例。

对应的 stable 管理端应用：

| scope | 应用名 |
|---|---|
| `domestic` | `server_hawk_decision_manage` |
| `mexico` | `server-hawk-decision-manage-mexyw` |
| `indonesia` | `server-hawk-decision-manage-ynyw` |

该文件必须只保存在本地，不提交到仓库。用 `query-app-instances` 按上表应用名查 stable 实例地址，或取 Bianque 服务模拟器当前可用提供者。

## 常用命令

只 dry-run 单条，不发回调：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/handle-stable-hawk-approval/scripts/stable_approval_cli.py \
  approve --scope domestic --source hawk --logic-id <logic_id>
```

按乐包 ID 定位单条，默认仍是 dry-run：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/handle-stable-hawk-approval/scripts/stable_approval_cli.py \
  approve --scope mexico --source hawk --package-id <package_id>
```

按业务字段列表选择，默认仍是 dry-run：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/handle-stable-hawk-approval/scripts/stable_approval_cli.py \
  approve --scope domestic --source hawk --select
```

海外米霍克待审批（按国家分别查）：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/handle-stable-hawk-approval/scripts/stable_approval_cli.py \
  list --scope mexico --source hawk

python3 /home/joney/projects/ai/agent-tools/skills/lexin/handle-stable-hawk-approval/scripts/stable_approval_cli.py \
  list --scope indonesia --source hawk
```

流程引擎单条执行：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/handle-stable-hawk-approval/scripts/stable_approval_cli.py \
  approve --scope domestic --source process --logic-id <logic_id> \
  --target domestic.process_engine=<ip>:<port> \
  --confirm
```

## 输出要求

最终回复按这个顺序：

1. `查询结果`：列出业务类型、乐包 ID/名称、发布计划 ID、申请人、审批人、状态、回调路由；`logic_id` 作为技术字段保留。
2. `执行情况`：说明是 dry-run 还是已确认执行；已执行时列成功/失败。
3. `复查结果`：给出审批状态是否已离开 `10`。
4. `使用命令`：只展示脱敏命令，不包含 Cookie、token 或真实 IP。

## 参考

`/home/joney/tools/hawk/approval.py`、`approval-overseas.py` 是本 skill 的前身。它们的行为对照和已知缺陷记录在 `references/legacy-approval-scripts.md`；再遇到有人翻出旧脚本时先看那份说明，不要直接跑。
