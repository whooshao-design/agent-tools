# lexin 平台与数据访问 第 3 轮报告

## 1. 总体判断

本批次不可收敛：E-02、E-07、E-10、E-14 的修复仍有执行缺口，另发现 1 项 Medium。
以第 2 轮报告和审核结论为基准；E-2-01 已关闭，E-01 保留已记录的授权裁定。
已核对本批次正文、引用文件、脚本接口与工作树 diff；按要求忽略 ClickHouse 未跟踪文件，其 HTTP 实现不在结论内。
6 个离线测试文件、2 个 Hippo 自检及范围内 `diff --check` 均通过；以下反例通过纯函数或内存模拟验证，未访问业务平台、执行 SQL 或修改文件。
做得好、不要动：Hippo 逐 key 发布与非目标保护、乐效登记差集与回读校验、飞书结构化表格校验。

## 2. 旧 finding 处置核对

以下路径均相对于 `/home/joney/projects/ai/agent-tools/skills/lexin/`。

| ID | 状态 | 证据（文件:行号 + 一句话） |
|---|---|---|
| E-01 | 未关闭 | `configure-hippo/scripts/hippo_draft_config.js:651` 仍为 `autoPublish = site === 'stable'`；行为按长期授权裁定保留，不作为阻塞。 |
| E-02 | 部分关闭 | `configure-hippo/scripts/hippo_draft_config.js:1389` 已为草稿权限错误生成 `--roles=modify`；但 `SKILL.md:181` 仍给出不带角色的补权命令，`:182` 仍要求“覆盖两个角色”；脚本 `:2558` 的 `plan` 直接返回且不含 `grantCommand`，按 plan 进入旧流程仍会落到 `:842` 的默认 `modify,release`。 |
| E-07 | 部分关闭 | `query-mysql-data/scripts/mysql_readonly.js:86` 已检查可执行注释，但 `:88` 的 `.replace(/--.*$/gm, ' ')` 不识别字符串边界；离线校验仍放行 `SELECT '-- ' INTO OUTFILE '/tmp/r3-example'`，字符串后的导出子句被误删。 |
| E-10 | 部分关闭 | `query-hippo-config/scripts/hippo_query.js:408` 已输出 `appSearchTruncated`，但 `:387` 在候选为空时提前抛 `APP_NOT_FOUND`，错误详情不含截断状态；模拟第一页满 60 条、环境过滤后为空即复现。`:282` 还把 navtree 请求异常转换为空环境，隐藏不可读应用。 |
| E-14 | 部分关闭 | `query-mysql-data/scripts/mysql_readonly.js:375` 已拒绝 3xx/HTML，但 `:371` 用 `code ?? retcode ?? errcode` 只检查首个字段，`:374` 只要求对象类型；模拟 HTTP 200 的 `{}` 和 `{"code":200,"retcode":403,"message":"denied"}` 均退出 0，仍未证明查询成功。 |
| E-2-01 | 已关闭 | `query-mysql-data/scripts/mysql_readonly.js:99` 已排除后接 `(` 的函数名；离线验证 `SELECT REPLACE('abc','a','x') AS cleaned` 正常通过，`:tests/mysql_readonly.test.js:18` 已覆盖该类输入。 |

## 3. 对拒绝 / 部分采纳项的表态

| ID | 同意/不同意 | 理由（不同意时给具体失败场景） |
|---|---|---|
| E-01 | 同意 | 延续第 2 轮判断：依据审核记录所述的用户长期授权，同意保留 stable 自动发布；本轮未独立取得原始裁定记录，不把“平台免审批”本身当作授权依据。 |
| E-02 | 不同意 | 不同意“只需修改权却新增发布权场景已消除”。agent 处理标准站点 pre 草稿修改，`plan` 返回无修改权时拿不到 `grantCommand`；按 `SKILL.md:181` 执行无 `--roles` 的命令仍会补两种权限。即使先触发 upsert 错误并只补 modify，`:182` 的“两角色”成功条件仍会诱导继续补 release。应同步 plan 路径、补权模板与成功条件，仅检查本次所需角色。 |
| E-04 | 同意 | `lexiao-deploy/SKILL.md:74` 已要求调用批量集成前记录实际项目集合，包含未授权项目时“do not click”；在本轮 agent 指令评审口径下足以维持关闭，不要求额外改造脚本。 |

## 4. 新 findings

| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
|---|---|---|---|---|---|---|---|---|
| E-3-01 | query-hippo-config | [scripts/hippo_query.js:78](/home/joney/projects/ai/agent-tools/skills/lexin/query-hippo-config/scripts/hippo_query.js:78) | Medium | 默认参数／自洽 | 单独指定 stable 站点时仍默认查询 `fql_prod`，与正文的 stable 默认 `fql_pre` 不一致；agent 按站点参数查询测试配置会访问错误环境并进入无谓排障。 | `SKILL.md:69`：“stable…env 默认用 `fql_pre`”；脚本 `:78` 在解析站点前填入 `DEFAULT_ENV`。纯函数验证 `{'app-id':'demo','hippo-site':'stable'}` 返回 stable 域名和 `fql_prod`，而 `env=stable` 返回 `fql_pre`。 | 未传 env 时按解析后的站点选默认值，stable 使用 pre；保留显式 env。 | 确认 |

## 5. 收敛判断

不可收敛：E-02、E-07、E-10、E-14、E-3-01。

E-02 阻塞的是已采纳的“按需补角色”未贯穿执行流程，不是重新争论默认账号自助授权政策。E-07 需修正字符串与注释识别；E-10 需在空候选和请求失败分支保留完整性信息；E-14 需校验实际成功结构及所有适用业务错误字段。

## 6. JSON

```json
{
  "batch": "E",
  "closed": ["E-2-01"],
  "partial": ["E-02", "E-07", "E-10", "E-14"],
  "open": ["E-01"],
  "regressions": [],
  "disagree": ["E-02"],
  "new_findings": [
    {
      "id": "E-3-01",
      "skill": "query-hippo-config",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/query-hippo-config/scripts/hippo_query.js:78",
      "severity": "Medium",
      "summary": "只传 --hippo-site=stable 时默认查询 fql_prod，与正文规定的 stable 默认 fql_pre 不一致。",
      "fix": "未传 env 时按解析后的站点选择默认值，stable 使用 pre，保留显式 env。"
    }
  ],
  "converged": false
}
```
