---
name: manage-tqm-test-cases
description: 在乐信质量管理平台（TQM，tqm.oa.fenqile.com）给乐效流程的需求版本查看模块与用例，按确认后的清单批量创建核心用例（每批不超过 10 条，同名跳过），并在项目环境/预发布/线上验证阶段填写用例执行结果；先 dry-run 再写入，写后回读校验，复用 get-browser-session 浏览器登录态。Use when 用户给出 TQM 版本页链接，要求把需求的核心用例录入质量管理平台、在 TQM 给需求版本建用例、点“执行”填写用例执行情况、查看版本下已有用例或找用例所属模块；不负责编写本地用例清单，也不编辑、删除、导入导出、评审平台用例或推进测试阶段。
metadata:
  version: 1.1.0
---

# manage-tqm-test-cases

## 定位

- 治理：在 TQM 上为一个需求版本查看版本信息、模块树和现有用例，把已确认的核心用例（≤10 条）创建到指定模块，并在测试阶段（项目环境测试/预发布环境测试/线上验证）为用例填写执行结果和实际结果。
- 不治理：用例编辑、删除、批量编辑、导入导出、用例评审、点“测试完成”或“下一步”推进阶段、STEP（步骤描述）模式用例的逐步结果；这些脚本不调用，让用户在页面上操作。
- 相邻 skill：
  - `dev-derive-test-cases` 产出本地测试清单（`/home/joney/docs/requirements-development/<需求名>/test-cases/test-cases.md`），是本 skill 提炼用例的来源之一；本 skill 不写也不改本地清单。
  - `dev-verify-change` 产出验证结论与实际测试数据；本 skill 只引用其中验证过的数据，不做验证。
  - `get-browser-session` 是登录态层；本 skill 只复用 `main` profile，不处理登录。

## 脚本

```bash
S=/home/joney/projects/ai/agent-tools/skills/lexin/manage-tqm-test-cases/scripts/tqm_cases.js
node $S version --url='<TQM 版本页链接>'
node $S modules --url='<链接>' --match=<关键字> [--sample]
node $S list    --url='<链接>'
node $S create  --url='<链接>' --file=<cases.json> [--node-id=<模块id>] [--maintainer=<OA用户名>] [--dry-run]
node $S plan-cases --url='<链接>' [--stage=project_test|pre_test|product_test]
node $S execute --url='<链接>' --file=<results.json> [--stage=...] [--overwrite] [--dry-run]
```

- 链接形如 `https://tqm.oa.fenqile.com/#/testActive/testTracking/noTestVersionDetail?versionName=...&versionId=<uuid>&projectId=<uuid>`；路由名会随版本状态变化，脚本只按 hash 里的 `versionId`、`projectId` 解析。链接含 `&`，命令行里要加单引号。
- 所有接口都在已登录的 TQM 页面里用 `fetch(credentials: 'include')` 调用（`https://fql_api.oa.fenqile.com/oa/test_track/web/...`），Cookie 不出浏览器、不落盘、不输出。浏览器经 `launchLockedContext` 启动，强制直连不走代理。
- `main` profile 有跨进程锁，同一时间只跑一个脚本；不要并行起多个命令。

| 子命令 | 作用 | 写平台 |
|---|---|---|
| `version` | 版本名、versionId、projectId、tapd_id、当前阶段（如 `case_design`） | 否 |
| `modules` | 在项目模块树里按关键字列出节点：id、is_case_node、case_num、完整路径；`--sample` 再给最多 3 个叶子模块各 2 条现有用例的 node_path、等级、标记、maintainer | 否 |
| `list` | 版本下现有用例：编号、等级、标记（异常/线上验收）、模块、名称 | 否 |
| `create` | 校验并创建用例；`--dry-run` 只打印将提交的摘要 | 是（不带 `--dry-run` 时） |
| `plan-cases` | 某测试阶段的用例：编号、执行结果、执行人、等级、名称；不传 `--stage` 时取版本当前阶段 | 否 |
| `execute` | 按 results.json 填写执行结果与实际结果，等同页面“执行”→“保存”；`--dry-run` 只打印变化 | 是（不带 `--dry-run` 时） |

`create` 的行为：

- 文件超过 10 条直接拒绝，不做部分写入；文件内重名、等级非法、模块不在本项目树里或不是叶子（`is_case_node=1`）时整体拒绝。
- 创建前读取版本下现有用例，同名（去首尾空格后完全相同）跳过并提示，可安全重跑。
- 写入前打印目标版本名、tapd_id、文件条数、跳过条数、待创建条数和 maintainer。
- 逐条调用 `add.json`，某条失败即停止后续写入；结束后回读 `list`，输出本文件相关用例的编号表，并报告回读缺失。
- maintainer 默认取当前登录用户（OA session 的 `min`），取不到时必须显式传 `--maintainer`。

`execute` 的行为：

- 阶段默认取版本当前阶段，必须是 `project_test`/`pre_test`/`product_test` 之一；当前在“测试用例设计”等阶段时报错，需用户先在页面推进或显式传 `--stage`。
- 按 `num`（用例编号）或完全相同的 `name` 匹配阶段用例；找不到、重复、单次超过 30 条、缺少实际结果、STEP 模式用例都整体拒绝。
- 用例已有不同的执行结果（非“未开始”）时默认跳过并提示，需要用户确认改判后再加 `--overwrite`；结果相同的会更新实际结果。
- 写入调用 `test_plan_case/edit.json`，载荷 `{id, case_id, status, results:"[]", project_id, name, actual_result}`；某条失败即停止，结束后回读阶段用例并核对状态。
- 只填结果，不点“测试完成”、不推进阶段。

## 工作流

1. 解析版本：对用户给的链接跑 `version`，向用户复述版本名和 tapd_id，确认是这次需求的版本。
2. 选模块：按需求所属页面或功能跑 `modules --match=<关键字> --sample`。只取 `is_case_node=1` 的叶子；候选不唯一时列出路径让用户选，不要自己猜。
3. 提炼用例：从需求文档、本地测试清单（`dev-derive-test-cases` 的 test-cases.md）、验证报告中提炼核心用例，不超过 10 条：
   - 覆盖主流程、关键异常/边界、兼容或回归保护；不要把本地清单逐条照搬。
   - 用例写业务行为（页面操作与可观察结果），不写类名、方法名；引用实际验证过的测试数据（乐包 ID、版本号、配置 key 等），没验证过的不写成事实。
   - 先 `list` 看版本下已有用例，避免语义重复（脚本只按名称去重）。
4. 写 cases.json 并预览：放在任务临时目录（如 `/tmp/agent-work/<日期>-<任务>/cases.json`），跑 `create --dry-run`，把“编号/等级/标记/模块/名称”清单给用户确认。
5. 用户确认后去掉 `--dry-run` 正式创建，汇报脚本输出的回读编号表；有跳过或缺失要单独说明。

填写执行结果（测试阶段）：

1. `plan-cases` 查看当前阶段用例和现有结果；阶段不对时让用户在页面推进，不替用户点“下一步”。
2. 按 `dev-verify-change` 的验证报告逐条整理结果：实际结果写在哪个环境、用了哪些数据（乐包 ID、任务号等）、观察到什么；只验证了一部分的写明未覆盖部分。
3. 部分验证的用例标“通过”还是“阻塞/跳过”，属于用户决定：先列出这些用例和未覆盖内容让用户选，再写 results.json。
4. 跑 `execute --dry-run` 给用户看“编号 当前结果 -> 新结果”，确认后正式写入，汇报回读表。

## cases.json 字段

示例：`/home/joney/projects/ai/agent-tools/skills/lexin/manage-tqm-test-cases/references/cases.example.json`（TAPD 1426731 乐包复制支持实时查询乐包的 7 条用例）。

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 用例名，≤255 字；版本内唯一，也是幂等去重键 |
| `priority` | 是 | `P0`/`P1`/`P2`/`P3`；P0、P1 已实测，P2/P3 未实测 |
| `steps` | 是 | 文本数组，脚本转成 `<p>1. …</p>` 并做 HTML 转义 |
| `expected` | 是 | 文本数组，转换规则同上 |
| `prerequisite` | 否 | 文本或数组，转成 `<p>` 段落 |
| `remark` | 否 | 文本或数组 |
| `is_abnormal` | 否 | 0/1，默认 0，异常场景标 1 |
| `is_user_case` | 否 | 0/1，默认 0，页面上叫“线上验收” |
| `is_regress`、`is_auto_case` | 否 | 0/1，默认 0 |
| `node_id` | 否 | 所属模块 id；不填时用 `--node-id`，两者都没有则拒绝 |

脚本固定补齐：`versionId`、`projectId`、`nodePath`（按模块树名称逐级用 `/` 拼接、无前导斜杠）、`step_model=TEXT`、`steps="[]"`、`status=Prepare`、`type=functional`、`maintainer`。

取值口径：

- P0：需求的主流程和最核心的结果校验，上线后必须验证，通常 1～3 条；其余主要场景、异常和回归保护用 P1。
- 线上验收（`is_user_case=1`）：上线后能在生产页面安全验证、且直接证明需求生效的用例，通常是 P0 主流程和“普通场景不受影响”的兼容用例；需要造数据、改配置或会产生副作用的不标。
- 异常（`is_abnormal=1`）：取消、拦截、失败、非法输入等非正常路径。

## results.json 字段

示例：`/home/joney/projects/ai/agent-tools/skills/lexin/manage-tqm-test-cases/references/results.example.json`（同一需求项目环境阶段的 7 条结果）。

| 字段 | 必填 | 说明 |
|---|---|---|
| `num` 或 `name` | 是 | 用例编号（列表里的 ID，如 121686）或完全相同的用例名 |
| `status` | 是 | `Pass`/`Failure`/`Blocking`/`Skip`，或中文 `通过`/`失败`/`阻塞`/`跳过` |
| `actual` | 是 | 实际结果，文本或数组，转成 `<p>` 段落并做 HTML 转义 |

阶段计划 id 来自 `plan_list_detail.json` 的 `list[].id`（`stage` 为 `project_test` 等），阶段用例来自 `test_plan_case/get_test_plan_cases.json`。

## 登录态与已知坑

- 脚本报 `TQM login required` 或 `non-JSON response ... session may have expired` 时，按 `get-browser-session` 的登录态排查顺序处理；需要重新登录时 MCP 优先用 `browser_session.ensure_session`，脚本兜底：
  `node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js --ensure --url=https://tqm.oa.fenqile.com/ --success-text=none`。不要在聊天中索取密码、OTP 或 Cookie。
- 打开 TQM 页面必须用 `waitUntil: 'domcontentloaded'` 再等几秒；`networkidle` 会一直挂住，因为页面有常驻请求。
- 模块树名称和用例 `node_path` 可能不同：树里叫“决策支撑”，旧用例的 node_path 显示“/决策平台/…”。按树里的名称和 id 选模块，`nodePath` 由脚本按树拼接。
- 单次最多 10 条；更多用例说明平台录入的不是“核心用例”，回到第 3 步收敛。
- 用例表格的“执行”链接在固定列里有两份，自动化点击要选可见的那一个；脚本直接调接口，不点页面。
- 接口 `retcode` 非 0 时脚本直接报错并带 `retmsg`；不要换参数反复重试写接口。

## 未覆盖

前端还有以下接口，未实测，脚本不调用：`delete_test_case_to_gc`、`delete_test_case_bath`、`edit_test_case_batch`、`export_test_case`、`test_case_import`、`test_case/edit.json`（编辑需带 id，须先读后写）、评审 `test_case_review/save_test_case_review.json`、阶段用例批量编辑 `test_plan_case/batch_edit.json` 与删除 `test_plan_case/delete.json`。需要改或删已有用例、推进阶段时，让用户在页面上操作。
