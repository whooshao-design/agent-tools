# 第 3 轮审核结论

codex 核对第 2 轮遗留与新项：A 1 关闭 + 1 部分 + 新 High 1；B 1 引入新问题；C 5 关闭 + 1 引入回归；D 2 关闭 + 3 部分 + 1 引入新问题 + 新 High 1；E 1 关闭 + 4 部分 + 新 Medium 1。全部采纳并已改：

| ID | 处理 |
|---|---|
| A-03 | 共享契约 `direct-record-v1` 明确独立验证的 `B` 为可确认的比较基线，实现前快照无法恢复记 `pre_change_snapshot: unknown` |
| A-3-01（High） | `repo-snapshot-v1` 增加暂存区指纹（`git diff --cached HEAD`）；`dev-finish-branch` 要求暂存区与已验证内容一致才判可交付，提交前核对 `git diff --cached` |
| B-3-01 | 模板读者测试行改回统一比对报告 `agent-v<N>.md`（含两种读者） |
| C-3-01 | `pick_agent.py` 宿主折叠只作用于"同一模型的双通道"，不同模型（claude-vps/codex-vps）照常轮换；测试补需求评审两轮不同后端 |
| D-02 | 判"关键词不存在"再加 `completed=true`、`errorCode` 为空 |
| D-05 | `registryTruncated` 贯穿报告模型，`--service` 反查阶段通过 ctx 传递 |
| D-2-01 | `requestJson` 拒绝跨源重定向，凭据不出站 |
| D-3-01（High） | `truthy`/`in` 断言在路径缺失时失败；新增 `tests/test_dubbo_scenario.py` |
| E-02 | `plan` 缺权限时直接输出带 `--roles` 的 `grantCommand`；正文补权命令与成功条件改为"本次需要的角色" |
| E-07 | SQL 校验改为顺序扫描器：字符串里的 `--`/`/*` 不算注释、可执行注释递归处理；补 4 条用例 |
| E-10 | `APP_NOT_FOUND` 详情带 `appSearchTruncated`/`unreadableApps`；navtree 读不到的应用标 unreadable 并输出 |
| E-14 | `code`/`retcode`/`errcode`/`status` 全部核对，空对象 `{}` 视为失败 |
| E-3-01 | 只给 `--hippo-site=stable` 时默认 env 改为 stable（fql_pre） |
| E-01 | 维持（codex 同意） |

验证：`tests` 116、`hooks/tests` 17、lexin node:test 全绿；`hippo_query.js self-test` passed。
