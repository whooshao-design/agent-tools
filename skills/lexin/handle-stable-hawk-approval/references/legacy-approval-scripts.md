# 旧审批脚本对照（approval.py / approval-overseas.py）

`/home/joney/tools/hawk/approval.py` 与 `/home/joney/tools/hawk/approval-overseas.py` 是本 skill 的前身。
两者都是"常驻轮询 + 自动通过所有待审批"的脚本，能力已被 `stable_approval_cli.py` 覆盖。
**不要直接运行它们**：内嵌凭据早已失效，且带下面几个会导致误操作的缺陷。

## 能力对照

| 能力 | 旧脚本 | `stable_approval_cli.py` |
|---|---|---|
| 查询待审批 | 固定 SQL，凭据硬编码 | `list`，凭据 env → 浏览器会话快照 |
| 地区 | 两个脚本各写死一套库和 IP | `--scope domestic/mexico/indonesia` |
| `Foper_type=1` 路由 | 只有 `approval.py` 有 | 两地区统一按 `route_for()` 分流 |
| 按乐包定位 | 无，全量通过 | `--package-id` / `--plan-id` SQL 下推 |
| dry-run | 无 | 默认 dry-run，`--confirm` 才发回调 |
| 批量保护 | 无，一轮全通过 | `--allow-bulk` + `--max-approve` |
| 成功判定 | 只看 HTTP 状态码 | 解析 `errcode` / `result.result` |
| 回调后复查 | 无 | 自动回查审批状态是否离开 `10` |
| 常驻轮询 | `run_with_schedule()` 分时段变频 | **不实现**，与"默认 dry-run"的安全边界冲突；需要周期性执行用 `/loop` 按需驱动 |

## 已知缺陷

1. **凭据硬编码且已过期**。两个脚本内嵌的 Bearer token 解出来 `sub=doveliu`、`exp=2025-01-17`，现在必然鉴权失败；Cookie 同样是当年某次会话的 `JSESSIONID`。

2. **库与回调跨地区错配**。`approval.py` 的米霍克查询用国内 `HawkDecisionDB`，流程引擎查询却用墨西哥 `MxgProcessmanageDB`；`approval-overseas.py` 反过来，查墨西哥 `MxgProcessmanageDB`，回调却打国内流程引擎实例。查一个地区、改另一个地区，是最危险的一类错误——这也是 skill 里坚持 `targets.json` 按 scope 分层、不允许裸 key 的原因。

3. **`approval-overseas.py` 的查询会静默漏单**。它的 SQL 是 `where 1=1 order by fmodify_time desc`，既不带 `Fapproval_state = 10` 也不带 `limit`，靠 Python 端过滤状态。lxcloud 单次最多返回 100 行且静默截断，返回的前 100 条可能全是已完成记录，真正待审批的被截在外面，表现为"明明有待审批却查不到"。

4. **无 dry-run、无上限、无复查**。`run_with_schedule()` 是死循环，命中时段就把所有 `Fapproval_state=10` 的记录全部置为通过，没有确认、没有条数上限，回调发出后也不回查状态。测试环境里这会把别人正在准备的发布一起放过去。

## 迁移映射

| 旧脚本入口 | 现在的等价命令 |
|---|---|
| `fetch_hawk_approval_data()` | `list --scope <scope> --source hawk` |
| `fetch_process_approval_data()` | `list --scope <scope> --source process` |
| `send_hawk_approval_callback()` | `approve --source hawk --logic-id <id> --confirm`（`route=hawk_manage`） |
| `send_process_approval_callback_for_hawk()` | 同上，`Foper_type=1` 时自动走 `hawk_process_publish` |
| `send_process_approval_callback()` | `approve --source process --logic-id <id> --confirm` |
| `run_with_schedule()` | 不提供等价物；按需执行，或用 `/loop` 驱动 `list` 后人工确认 |
