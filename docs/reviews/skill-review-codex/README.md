# codex-vps 全量 skill 评审与对齐迭代

日期：2026-09-21。对象：agent-tools 全部 48 个 skill（SKILL.md、references、agents/、hooks/；脚本只核对接口）。评审者：`/home/joney/bin/codex-reviewer`（bwrap 只读 + codex-vps，主配置模型 `gpt-6-astra`，xhigh）。审核与修改：Claude（本会话）。

## 流程

1. `prompts/rubric.md` 是共用评审规范；`prompts/<批次>.md` = 范围清单 + 规范。五批：A 生产者链路、B 评审门禁链路、C common/dev-quality/cicd、D lexin 观测诊断、E lexin 平台数据。
2. `run_batch.sh round-N prompts/<批次>.md` 在仓库根目录跑一批，stdout 落 `round-N/<批次>.md`，stderr 落 `.log`，退出码与耗时落 `.status`。
3. 每轮结束后 Claude 逐条审核（`round-N/audit.md`）：采纳 / 部分采纳 / 拒绝，拒绝必须给证据；采纳项改仓库并跑 `python3 -m unittest discover -s tests` 与路由评测。
4. 下一轮把变更清单 + 逐条回应交回 codex：核对旧问题是否关闭、对拒绝项表态、找新问题。
5. 收敛条件：codex 无新的 High/Medium finding，对全部拒绝项表示认可或双方分歧已记录并由用户裁决；Low 项按价值决定是否做。

## 审核原则

- 采纳标准与 rubric 一致：finding 必须对应执行中的 agent 会做错/犹豫/越界的场景。
- 评审者以"证据未附"质疑已验证事实时，补证据而不是削弱结论（见 memory cross-model-orchestration）。
- 不为改而改：codex 列的"做得好、不要动"部分默认保留。

## 进度

- 第 1 轮（2026-09-21）：五批 5–11 分钟各自完成，共 61 条 finding（A9/B9/C11/D17/E15）。审核结论见 `round-1/audit.md`：拒绝 2 条（E-01 stable 自动发布、E-02 默认名单自助补权限，均为用户裁定的站点/单人工具规则），部分采纳 4 条（A-05、C-01、C-05、E-04），其余采纳。改动 69 个文件；`python3 -m unittest discover -s tests`（110）、`hooks/tests`（17）、lexin 各 skill 的 node:test 全部通过。
- 第 2 轮：核对处置 + 对拒绝项表态 + 找剩余问题，提示见 `prompts/r2-*.md`。
- 第 2 轮：codex 判 47 关闭、9 部分/引入新问题、2 未关闭（拒绝项），新报 7 条（2 High：spawn 作业目录同秒碰撞、告警链接任意域名带凭据）。全部处置见 `round-2/audit.md`；E-02 由拒绝改为部分采纳（自助补权限只补本次需要的角色）。测试 113 + 17 + node:test 全绿；行为评测 3/3。
- 第 3 轮：只核对第 2 轮未关闭项与新 finding，提示 `prompts/r3-*.md`。
- 第 3 轮：新报 2 High（快照未绑暂存区；truthy 断言放过缺失字段）+ 若干部分关闭项，全部处置见 `round-3/audit.md`。
- 第 4 轮：B 批收敛；其余新报 2 High（指标注册跨源重定向带凭据；Hive 只读校验被字符串内注释绕过）+ 3 处修复回归，全部处置见 `round-4/audit.md`。
- 第 5 轮：A、C 收敛；D 新报 1 High（Python 脚本带 Cookie 跟随跨源重定向）、E 新报 1 High（EXPLAIN ANALYZE）+ 1 回归，全部处置见 `round-5/audit.md`。
- 第 6 轮：D 收敛（4/5）；E 新报 1 Medium（Presto 反斜杠不是转义符），已改，见 `round-6/audit.md`。
- 第 7 轮：E 收敛。**五批全部收敛**。累计 codex finding 84 条（第 1 轮 61 + 后续新报 23，其中 High 17），采纳 81、部分采纳 2（A-05、E-04）、维持拒绝 1（E-01，codex 同意保留）；修复中被 codex 抓到的回归 8 处，全部再修。改动 80 个文件，新增 4 个测试文件；`tests` 119、`hooks/tests` 17、skill 自带 node:test 全绿，路由评测通过，行为压力评测 3/3。所有改动仍在工作树、未提交。
