# lexin 平台与数据访问 第 4 轮报告

## 1. 总体判断

本批次不可收敛：E-07、E-14 仍部分关闭，另发现首轮漏报的 High：E-4-01。  
E-02、E-10、E-3-01 已关闭；E-01 延续已记录的长期授权裁定，不作为阻塞。  
已核对本批次工作树 diff、正文、references 与脚本接口；按要求忽略 ClickHouse 未跟踪文件，其新增 HTTP 实现不在结论内。  
6 个离线测试文件、2 个 Hippo 自检及范围内 `diff --check` 均通过；反例仅通过纯函数和内存模拟验证，未执行数据库 SQL、访问业务平台或修改文件。  
做得好、不要动：Hippo 逐 key 发布与非目标保护、乐效登记差集及回读校验、飞书结构化表格校验。

## 2. 旧 finding 处置核对

以下路径相对于 `/home/joney/projects/ai/agent-tools/skills/lexin/`。

| ID | 状态 | 证据（文件:行号 + 一句话） |
|---|---|---|
| E-01 | 未关闭 | `configure-hippo/scripts/hippo_draft_config.js:651` 仍为 `autoPublish = site === 'stable'`；原行为保留，按已有授权裁定不阻塞。 |
| E-02 | 已关闭 | `configure-hippo/scripts/hippo_draft_config.js:2562` 在普通草稿 plan 缺修改权时生成 `roles='modify'`；`SKILL.md:181` 的兜底命令显式指定所需角色，`:182` 明确“不要……再补一次 release”，原来的额外发布权路径已消除。 |
| E-07 | 部分关闭 | `query-mysql-data/scripts/mysql_readonly.js:103` 仍把任意连续 `--` 当注释。原字符串反例已拒绝，但离线校验仍放行 `SELECT 1--1 INTO OUTFILE '/tmp/r4'`，导出子句被错误删除；应只在第二个 `-` 后满足 MySQL 空白/控制字符条件时识别注释。[MySQL 注释规则](https://dev.mysql.com/doc/refman/8.4/en/comments.html) |
| E-10 | 已关闭 | `query-hippo-config/scripts/hippo_query.js:285` 标记不可读应用，`:395` 的 `APP_NOT_FOUND` 详情保留截断与不可读状态；模拟满页但环境过滤后为空、navtree 请求失败，两条路径均正确输出完整性信息。`SKILL.md:127` 同步禁止据不完整扫描判断“未配置”。 |
| E-14 | 部分关闭 | `query-mysql-data/scripts/mysql_readonly.js:407` 已逐项检查四种顶层业务码，`:411` 已拒绝 `{}`；但仍未要求查询结果结构，模拟 HTTP 200、`{"message":"denied"}` 仍退出 0。仅有非空对象不足以证明查询成功，应验证已确认的结果结构，缺失时报告异常响应。 |
| E-3-01 | 已关闭 | `query-hippo-config/scripts/hippo_query.js:80` 已按 stable 站点选择默认环境；离线验证仅传 `--hippo-site=stable` 得到 `fql_pre`，显式 `pdwl_pre` 仍原样保留。 |

## 3. 对拒绝 / 部分采纳项的表态

第 3 轮审核没有新增拒绝或部分采纳项；以下复核此前保留的裁定与分歧。

| ID | 同意/不同意 | 理由（不同意时给具体失败场景） |
|---|---|---|
| E-01 | 同意 | 延续审核记录所述的用户长期授权裁定，同意保留 stable 自动发布；本轮未独立取得原始授权记录，不将“平台免审批”本身视为用户授权。 |
| E-02 | 同意 | 此前不同意的是普通草稿补权附带新增 release；当前 plan、错误命令和正文成功条件已共同消除该路径，撤销此前保留意见。 |
| E-04 | 同意 | `lexiao-deploy/SKILL.md:74` 仍要求调用批量集成前核对实际项目集合，包含未授权项目时停止；维持已关闭，不要求额外改造脚本。 |

## 4. 新 findings

| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
|---|---|---|---|---|---|---|---|---|
| E-4-01 | query-hive-data | [scripts/hive_query.js:73](/home/joney/projects/ai/agent-tools/skills/lexin/query-hive-data/scripts/hive_query.js:73) | High | 接口契约／只读门禁 | 字符串内的注释标记会隐藏后续写语句；agent 通过该入口执行包含此形式的 Spark SQL 时，本地只读门禁失效。 | `:76` 使用 `.replace(/--[^\n]*/g, ' ')`，不识别字符串边界。离线验证 `WITH c AS (SELECT '--' AS x) INSERT INTO demo.t SELECT x FROM c` 被放行并原样返回；`:314` 将完整 SQL 提交执行。`SKILL.md:42` 承诺拒绝 WITH 中的 INSERT，`:43` 明确页面允许写操作。 | 在识别字符串边界后处理注释并检查写语句；无法确认只读时拒绝，补此反例。不要直接复用尚有 E-07 缺口的 MySQL 扫描器。 | 确认 |

## 5. 收敛判断

不可收敛：E-07、E-14、E-4-01。

E-07、E-14 虽被审核标为“采纳并已改”，仍未完全消除只读校验和查询成功判定风险；E-4-01 是本轮确认的独立 High。E-01 已记录授权裁定，不列入阻塞。

## 6. JSON

```json
{
  "batch": "E",
  "closed": ["E-02", "E-10", "E-3-01"],
  "partial": ["E-07", "E-14"],
  "open": ["E-01"],
  "regressions": [],
  "disagree": [],
  "new_findings": [
    {
      "id": "E-4-01",
      "skill": "query-hive-data",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/query-hive-data/scripts/hive_query.js:73",
      "severity": "High",
      "summary": "注释剥离不识别字符串边界，含字符串 '--' 的 WITH INSERT 被只读校验放行，完整写语句仍被提交。",
      "fix": "识别字符串边界后处理注释并检查写语句；无法确认只读时拒绝，补充 WITH 字符串加 INSERT 的反例。"
    }
  ],
  "converged": false
}
```
