# lexin 平台与数据访问 第 2 轮报告

## 1. 总体判断

本批次不可收敛：MySQL 只读校验、查询成功判定和 Hippo 搜索完整性仍有缺口，并新增一项 Medium 回归。
15 项旧 finding 中，10 项已关闭、2 项部分关闭、2 项未关闭、1 项改动引入新问题。
已核对工作树 diff、12 个 skill 正文及引用文件、脚本接口；按要求忽略 ClickHouse 未跟踪文件，其新增 HTTP 实现不在验证结论内。
6 个离线测试文件、2 个 Hippo 自检及范围内 `diff --check` 均通过；另用内存模拟复现剩余问题，未访问业务平台或执行数据库 SQL。
做得好、不要动：Hippo 逐 key 发布及非目标保护、乐效登记的差集与回读校验、飞书结构化表格校验应继续保留。

## 2. 旧 finding 处置核对

以下相对路径均以 `/home/joney/projects/ai/agent-tools/skills/lexin/` 为根；“未关闭”表示原行为仍存在，是否接受该行为另见第 3 节。

| ID | 状态 | 证据（文件:行号 + 一句话） |
|---|---|---|
| E-01 | 未关闭 | `configure-hippo/SKILL.md:14` 仍规定 stable“自动按 key 发布”；`scripts/hippo_draft_config.js:651` 仍以 `site === 'stable'` 自动启用发布，本轮未修改该行为。 |
| E-02 | 未关闭 | `configure-hippo/SKILL.md:80` 仍要求权限不足时“自动跑一次 namespace-grant”；`scripts/hippo_draft_config.js:842` 默认角色仍是 `modify,release`，普通草稿修改仍会附带授予发布权。 |
| E-03 | 已关闭 | `lexiao-deploy/references/flows.md:101` 已改为“start container targets only when every VM/KVM target … is published and verified”，与正文顺序一致。 |
| E-04 | 已关闭 | `lexiao-deploy/SKILL.md:74` 已要求记录待集成项目集合，包含未授权项目时“do not click”；在本轮 skill 执行标准下，该前置约束足以关闭原指令缺口。 |
| E-05 | 已关闭 | `handle-stable-hawk-approval/scripts/stable_approval_cli.py:766` 仅取 `targets.get(scoped_key)`，缺失即报错；`SKILL.md:125` 同步明确不回退裸 key。 |
| E-06 | 已关闭 | `configure-hippo/SKILL.md:155` 已要求存在未发布草稿且本次要发布时仍运行 `upsert`；脚本 `hippo_draft_config.js:2595` 的 noop 分支确实调用发布及 active 回读。 |
| E-07 | 改动引入新问题 | `query-mysql-data/scripts/mysql_readonly.js:96` 已拦截原例中的 WITH DELETE 和直接 OUTFILE，但 `:85` 仍删除全部块注释，离线校验放行 `SELECT 1 /*!50000 INTO OUTFILE '/tmp/round2-example' */`；新增正则还误拒绝只读 `REPLACE()`，见 E-2-01。 |
| E-08 | 已关闭 | `redis-query/SKILL.md:90` 模板已传已确定的 stable/pre，`:99` 明确只有未指定环境时才使用 auto，用户指定环境不再被模板覆盖。 |
| E-09 | 已关闭 | `start-local-frontend/scripts/frontend_env.js:26` 的 `PROJECT_DIR` 与 `SKILL.md:12` 均改为 `/home/joney/projects/frontend/web_mihawk_oa`；已确认目录及其 `AGENTS.md` 存在。 |
| E-10 | 部分关闭 | `query-hippo-config/scripts/hippo_query.js:293` 已增加 namespace 满页标记，但 `:271` 应用搜索仍固定第一页，`:403` 的 `appsTruncated` 仍只比较过滤后的候选数量；模拟第一页 60 个应用、过滤剩 1 个时返回 `appsTruncated=false`，后续页遗漏仍不可见。正文 `SKILL.md:64`、`:89` 也仍保留“全部 namespace”承诺。 |
| E-11 | 已关闭 | `query-hippo-config/SKILL.md:126` 已明确多次 `get` 串行执行，并说明共用 profile 并行会报 `PROFILE_IN_USE`。 |
| E-12 | 已关闭 | `query-hippo-config/scripts/hippo_query.js:144`、`:147` 分别映射 404 与 5xx；离线验证 404→`NOT_FOUND`、500/503→`HIPPO_UPSTREAM_ERROR`，不再要求重登。 |
| E-13 | 已关闭 | `query-mysql-data/scripts/mysql_readonly.js:182` 的身份字段包含 `sub`；离线构造 `{sub:"oa_example"}` 已解析为 `oa_example`。 |
| E-14 | 部分关闭 | `query-mysql-data/scripts/mysql_readonly.js:371` 仅拒绝 HTTP ≥400，且 `:368` 只检查顶层业务码；内存模拟 HTTP 302、HTTP 200 登录 HTML 均仍正常退出，未兑现 `SKILL.md:162` 的“HTTP 2xx”成功条件，也未要求合法查询结果结构。 |
| E-15 | 已关闭 | `manage-feishu-doc/references/docx-block-operations.md:70` 已限定为“未打补丁的上游”，`:72` 明确当前 wrapper 可直接调用；已核对 `mcp/third-party-mcp/lark/bin/lark-mcp:59` 的补丁失败退出路径。 |

## 3. 对拒绝 / 部分采纳项的表态

| ID | 同意/不同意 | 理由（不同意时给具体失败场景） |
|---|---|---|
| E-01 | 同意 | 依据审核记录补充的“用户明确裁定 stable 自动发布”这一长期授权前提，同意保留默认行为，无需每次重复确认。该结论依赖审核记录所述授权，不能仅由“平台不走审批”推出；本轮未独立取得原始裁定记录。 |
| E-02 | 不同意 | 即使登录者和默认名单都是仓库所有者，用户仅要求修改标准站点 pre 草稿、当前只有修改权缺失时，agent 仍会运行默认 `namespace-grant`，额外授予覆盖该 namespace 所有环境的发布权（`SKILL.md:82`）。账号属于本人、不删除别人权限及非目标用户校验，都没有覆盖“本次只需修改权却新增发布权”的场景。 |
| E-04 | 同意 | 评审对象是加载 skill 的 agent；新增规则已要求先检查集合并在越界时停止，不必为此强制改造脚本。调用仍会直接批量集成，因此该检查必须发生在调用 MCP/脚本之前，不能把调用本身当作预检。 |

## 4. 新 findings

| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
|---|---|---|---|---|---|---|---|---|
| E-2-01 | query-mysql-data | [scripts/mysql_readonly.js:96](/home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js:96) | Medium | 改动回归／输入契约 | 新增写关键字扫描把合法只读函数当成写操作；用户要求用 `REPLACE()` 清洗查询字段时，agent 无法执行原 SQL，被迫改写或报告错误限制。 | 新正则包含 `\b…replace…\b`，`:100` 对整条去字符串后的 SELECT 匹配；离线执行校验器，`SELECT REPLACE('abc','a','x') AS cleaned` 被报为“非只读 SQL（replace）”。 | 区分语句动作与函数调用，允许 SELECT 表达式中的 `REPLACE(...)`；保留对实际写语句的拒绝，并补该输入的回归检查。 | 确认 |

## 5. 收敛判断

不可收敛：E-07、E-10、E-14、E-2-01。

E-07 的原始直接写入形式虽已拦截，可执行注释仍绕过本地校验；需要拒绝该形式或正确解析后检查。服务端是否另有保护，本轮未验证。E-10 需要传播应用搜索第一页截断及不可读状态；E-14 需要严格检查 2xx、合法 JSON 和实际查询成功结构。

E-01、E-02 的保留意见和分歧已记录，按用户指定的收敛口径，不将它们单独列为本轮阻止收敛项。

## 6. JSON

```json
{
  "batch": "E",
  "closed": [
    "E-03",
    "E-04",
    "E-05",
    "E-06",
    "E-08",
    "E-09",
    "E-11",
    "E-12",
    "E-13",
    "E-15"
  ],
  "partial": ["E-10", "E-14"],
  "open": ["E-01", "E-02"],
  "regressions": ["E-07"],
  "disagree": ["E-02"],
  "new_findings": [
    {
      "id": "E-2-01",
      "skill": "query-mysql-data",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js:96",
      "severity": "Medium",
      "summary": "新增写关键字扫描误拒绝 SELECT 中合法的 REPLACE() 函数。",
      "fix": "区分语句动作与函数调用，允许只读 REPLACE() 表达式并补回归检查，同时保留实际写语句拦截。"
    }
  ],
  "converged": false
}
```
