# lexin 平台与数据访问 第 6 轮报告

## 1. 总体判断

本批次不可收敛：本轮确认新增 1 项 Medium（E-6-01），合法 Presto 查询仍存在误拦截。
E-4-01、E-5-01、E-5-02 的原始反例均已修复；E-01 延续已记录的授权裁定，不作为阻塞。
已核对范围内正文、references、脚本接口与工作树 diff；按要求忽略 ClickHouse 未跟踪文件，其 HTTP 实现不在结论内。
6 个离线测试文件、2 个 Hippo 自检及范围内 `diff --check` 通过；未访问业务平台、执行数据库 SQL 或修改文件。
做得好、不要动：Hippo 逐 key 发布与非目标保护、乐效登记差集与回读校验、飞书结构化表格校验。

## 2. 旧 finding 处置核对

以下相对路径以 `/home/joney/projects/ai/agent-tools/skills/lexin/` 为根。

| ID | 状态 | 证据（文件:行号 + 一句话） |
|---|---|---|
| E-01 | 未关闭 | `configure-hippo/scripts/hippo_draft_config.js:651` 仍为 `autoPublish = site === 'stable'`；行为保留，按既有授权裁定不阻塞。 |
| E-4-01 | 已关闭 | `query-hive-data/scripts/hive_query.js:79` 使用顺序扫描器，`:98` 检查写关键字；离线确认原反例 `WITH c AS (SELECT '--' AS x) INSERT INTO demo.t SELECT x FROM c` 被拒绝，剩余兼容问题单列 E-6-01。 |
| E-5-01 | 已关闭 | `query-hive-data/scripts/hive_query.js:93` 明确匹配并拒绝 `EXPLAIN ANALYZE`；`:94` 提示改用普通 EXPLAIN，原插入反例被拒绝，普通 `EXPLAIN SELECT 1` 保留。 |
| E-5-02 | 已关闭 | `query-hive-data/scripts/hive_query.js:79` 传入 `dashCommentNeedsSpace: false`，MySQL 扫描器 `:87` 默认仍要求空白；原无空格注释反例通过，`tests/hive_query.test.js:24` 的错误预期也已修正。 |

## 3. 对拒绝 / 部分采纳项的表态

第 5 轮审核没有新增拒绝或部分采纳项；以下复核保留的授权裁定。

| ID | 同意/不同意 | 理由（不同意时给具体失败场景） |
|---|---|---|
| E-01 | 同意 | 延续审核记录所述的用户长期授权，同意保留 stable 自动发布。本轮未独立取得原始授权记录；“平台免审批”本身仍不能替代用户授权。 |

## 4. 新 findings

| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
|---|---|---|---|---|---|---|---|---|
| E-6-01 | query-hive-data | [hive_query.js:79](/home/joney/projects/ai/agent-tools/skills/lexin/query-hive-data/scripts/hive_query.js:79)、[mysql_readonly.js:97](/home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js:97) | Medium | 改动回归／方言兼容 | 共享扫描器仍无条件把反斜杠当转义符；agent 执行带反斜杠字符串的 Presto 查询时，字符串边界错位，注释内容可能被误判为写操作。 | Hive 只覆盖行注释选项；扫描器原文为 `if (src[j] === '\\') { j += 2; continue; }`。离线对比同一输入 `SELECT '\' AS separator -- 'delete' is only a comment`：HEAD 放行，工作树报 `write keyword ... DELETE`。[Presto 官方 STRING 词法规则](https://github.com/prestodb/presto/blob/master/presto-parser/src/main/antlr4/com/facebook/presto/sql/parser/SqlBase.g4#L974) 用连续单引号转义，反斜杠不会转义结束引号。 | 将字符串转义规则按引擎区分，Presto 不启用反斜杠转义；保留其他调用方的既有行为，并补该反例。 | 确认 |

## 5. 收敛判断

不可收敛：E-6-01。

第 5 轮两项新 finding 均已关闭，但仍有新的 Medium；E-01 已记录授权裁定，不列入阻塞。

## 6. JSON

```json
{
  "batch": "E",
  "closed": ["E-4-01", "E-5-01", "E-5-02"],
  "partial": [],
  "open": ["E-01"],
  "regressions": [],
  "disagree": [],
  "new_findings": [
    {
      "id": "E-6-01",
      "skill": "query-hive-data",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/query-hive-data/scripts/hive_query.js:79; /home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js:97",
      "severity": "Medium",
      "summary": "共享扫描器把反斜杠无条件视为转义符，导致合法 Presto 查询的字符串边界错位，将注释中的 DELETE 误判为写操作；已离线确认 HEAD 放行、工作树拒绝。",
      "fix": "按引擎区分字符串转义规则，Presto 禁用反斜杠转义，保留其他调用方行为并补回归用例。"
    }
  ],
  "converged": false
}
```
