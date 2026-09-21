# lexin 平台与数据访问 第 5 轮报告

## 1. 总体判断

本批次不可收敛：新增 1 项 High（E-5-01）和 1 项 Medium 回归（E-5-02）。  
E-07、E-14 已关闭；E-4-01 的原反例已修复，但修复引入方言兼容问题；E-01 延续已记录的授权裁定。  
已核对范围内工作树 diff、正文、references 与脚本接口；按要求忽略 ClickHouse 未跟踪文件，其 HTTP 实现不在结论内。  
6 个离线测试文件、2 个 Hippo 自检及范围内 `diff --check` 通过；反例仅做纯函数或内存模拟，未执行数据库 SQL、访问业务平台或修改文件。  
做得好、不要动：Hippo 逐 key 发布及非目标保护、乐效登记差集与回读校验、飞书结构化表格校验。

## 2. 旧 finding 处置核对

以下相对路径以 `/home/joney/projects/ai/agent-tools/skills/lexin/` 为根。

| ID | 状态 | 证据（文件:行号 + 一句话） |
|---|---|---|
| E-01 | 未关闭 | `configure-hippo/scripts/hippo_draft_config.js:651` 仍为 `autoPublish = site === 'stable'`；按既有长期授权裁定保留，不作为阻塞。 |
| E-07 | 已关闭 | `query-mysql-data/scripts/mysql_readonly.js:104` 已要求 `--` 后为空白、控制字符或输入结束；离线验证 `SELECT 1--1 INTO OUTFILE '/tmp/r4'` 被拒绝，字符串及可执行注释的既有反例也有测试覆盖。 |
| E-14 | 已关闭 | `query-mysql-data/scripts/mysql_readonly.js:415` 新增 `hasResult`，`:416` 将缺少结果容器纳入失败条件；模拟 `{message:'denied'}`、`{}`、冲突业务码和 HTTP 302 均退出 2，合法空结果仍退出 0。 |
| E-4-01 | 改动引入新问题 | `query-hive-data/scripts/hive_query.js:75` 改用顺序扫描器，原 `WITH c AS (SELECT '--' AS x) INSERT ...` 已拒绝；但同时引入 MySQL 专有的 `--` 空白条件，误拒合法 Presto 查询，见 E-5-02。 |

## 3. 对拒绝 / 部分采纳项的表态

第 4 轮审核没有新增拒绝或部分采纳项；以下复核保留的授权裁定。

| ID | 同意/不同意 | 理由（不同意时给具体失败场景） |
|---|---|---|
| E-01 | 同意 | 延续审核记录所述的用户长期授权，同意保留 stable 自动发布。本轮未独立取得原始授权记录；“平台免审批”本身仍不能替代用户授权。 |

## 4. 新 findings

| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
|---|---|---|---|---|---|---|---|---|
| E-5-01 | query-hive-data | [scripts/hive_query.js:91](/home/joney/projects/ai/agent-tools/skills/lexin/query-hive-data/scripts/hive_query.js:91) | High | 只读门禁／首轮漏报 | 将所有 EXPLAIN 当作不会写入；agent 为分析写语句性能提交 `EXPLAIN ANALYZE INSERT INTO demo.t SELECT 1` 时，本地门禁放行，在具备写权限且门户接受该语句时会执行插入。 | 注释称“EXPLAIN never write”，`:92` 只检查 SELECT/WITH；纯函数确认该反例被原样放行，`:316` 原样提交。[Presto 官方文档](https://prestodb.github.io/docs/current/sql/explain-analyze.html) 明确 EXPLAIN ANALYZE 会执行语句，不能用普通 EXPLAIN 的语义解释它；未验证门户是否另行拦截。 | 在只读入口明确拒绝 EXPLAIN ANALYZE，保留普通 EXPLAIN；同步说明并补该反例。 | 确认 |
| E-5-02 | query-hive-data | [scripts/hive_query.js:75](/home/joney/projects/ai/agent-tools/skills/lexin/query-hive-data/scripts/hive_query.js:75) | Medium | 改动回归／方言兼容 | 复用 MySQL 扫描器后，合法 Presto 注释被当成 SQL；agent 执行用户提供的带注释查询会被误判为写操作，被迫改写 SQL。 | 被调用的 `query-mysql-data/scripts/mysql_readonly.js:104` 要求 `--` 后有空白；离线验证 `SELECT 1 --delete is only a comment` 报 `write keyword ... DELETE`。而 [Presto 词法规则](https://github.com/prestodb/presto/blob/master/presto-parser/src/main/antlr4/com/facebook/presto/sql/parser/SqlBase.g4#L1040) 的 `SIMPLE_COMMENT` 无此空白要求；原 Hive 实现会忽略该注释。 | Hive 按目标引擎识别行注释，保留 MySQL 的现有条件；补无空格注释用例，修正将 `SELECT 1--1 INSERT ...` 当作 Hive 写语句的测试预期。 | 确认 |

## 5. 收敛判断

不可收敛：E-5-01、E-5-02。

E-4-01 的原漏洞已修复，其回归由 E-5-02 跟踪；E-01 已记录授权裁定，不阻止收敛。

## 6. JSON

```json
{
  "batch": "E",
  "closed": ["E-07", "E-14"],
  "partial": [],
  "open": ["E-01"],
  "regressions": ["E-4-01"],
  "disagree": [],
  "new_findings": [
    {
      "id": "E-5-01",
      "skill": "query-hive-data",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/query-hive-data/scripts/hive_query.js:91",
      "severity": "High",
      "summary": "EXPLAIN 被无条件视为只读，EXPLAIN ANALYZE INSERT 可通过本地门禁并原样提交，而 Presto 会实际执行该语句。",
      "fix": "只读入口拒绝 EXPLAIN ANALYZE，保留普通 EXPLAIN，同步说明并补反例。"
    },
    {
      "id": "E-5-02",
      "skill": "query-hive-data",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/query-hive-data/scripts/hive_query.js:75",
      "severity": "Medium",
      "summary": "复用 MySQL 扫描器引入专有的双横线空白条件，合法 Presto 注释中的写关键字被误判为写操作。",
      "fix": "Hive 按目标引擎识别行注释，保留 MySQL 规则；补无空格注释用例并修正错误测试预期。"
    }
  ],
  "converged": false
}
```
