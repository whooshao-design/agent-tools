# 第 2 轮审核结论

codex 对第 1 轮 61 条的核对：A 8 关闭 + 1 部分；B 8 关闭 + 1 部分；C 7 关闭 + 3 部分 + 1 引入新问题；D 14 关闭 + 2 部分 + 1 引入新问题；E 10 关闭 + 2 部分 + 2 未关闭（拒绝项）+ 1 引入新问题。新 finding 7 条（A-2-01、C-2-01 High、C-2-02、D-2-01 High、D-2-02、D-2-03、E-2-01）。全部处置如下。

| ID | 结论 | 处理 |
|---|---|---|
| A-03 | 采纳 | 独立验证入口贯穿：`B` 取改动所基于的基线并标 `standalone_verification: true`；DEV 映射与写集归属改为归属到用户指定的改动范围；`通过` 后交付即停止，不进正式收口 |
| A-2-01 | 采纳 | `dev-design-solution` 正文与 `readability-and-writing.md` 自检表统一为协议 §5 判定 |
| B-06 | 采纳 | `dev-review-solution/references/review-template.md` 读者测试行改为按 §5 判定（保留契约测试锚点） |
| C-01 | 采纳 | 定位段与脚本 docstring 的"同等权限"承诺全部删除；默认值裁定不变 |
| C-04 | 采纳 | `pick_agent.py` 加 `--host`（默认按 `CLAUDECODE`/`CODEX_*` 检测），候选里有同宿主通道时只用同宿主；修订沿用原生成者不换通道；补测试 |
| C-06 | 采纳 | 指标表拆成"JSON 可提取（脚本）"与"格式遵从（人工抽查）"，判定规则同步 |
| C-07 / C-2-02 | 采纳 | 两个专项的前置条件限定为正式准入；建议审查有 diff 即可做并披露验证缺口 |
| C-2-01 | 采纳 | 作业目录改 `tempfile.mkdtemp(prefix=<时间>-<后端>-)`，同秒启动不再撞目录；文档同步 |
| D-02 | 采纳 | 判"关键词不存在"再加 `truncated=false` 条件 |
| D-05 | 采纳 | 拓扑脚本读取注册中心 `completeness.truncated`，报告加 `registry_truncated` 并打印提示 |
| D-17 / D-2-01 / D-2-02 | 采纳 | 告警链接只接受两个已知站点（其它域名报错，凭据不会发出）；输出 `env` 由最终站点推导并附 `baseUrl` |
| D-2-03 | 采纳 | 参数表改为 `--app` 与 `--service` 可同时传 |
| E-02 | 部分采纳（codex 不同意原拒绝） | 自助补权限的默认值不变，但 `grantCommand` 现在带 `--roles`：存草稿只补 modify，要发布才连 release；正文同步。codex 指出的"只需修改权却新增发布权"场景由此消除 |
| E-07 / E-2-01 | 采纳 | `/*!50000 ... */` 可执行注释保留内容再校验；`INSERT()/REPLACE()/TRUNCATE()` 后跟 `(` 视为函数放行；补 5 条回归用例 |
| E-10 | 采纳 | 应用关键字搜索满页输出 `appSearchTruncated`，正文删除"全部 namespace" |
| E-14 | 采纳 | 成功判定改为 2xx + JSON 对象 + 无业务错误，3xx/HTML 均以退出码 2 结束 |
| E-01 | 维持拒绝 | codex 同意（依据用户裁定的长期授权） |
| E-04 | 维持部分采纳 | codex 同意（检查必须发生在调用脚本之前，正文已如此写） |

验证：`python3 -m unittest discover -s tests`（113）、`hooks/tests`（17）、lexin 各 skill node:test 全部通过；行为压力评测 dev-verify-change 1、dev-review-solution 1/2 均 4/4。
