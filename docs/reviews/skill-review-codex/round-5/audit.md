# 第 5 轮审核结论

A、C 批 codex 判"可收敛"（连同第 4 轮的 B，共 3/5 收敛）。D：D-4-01 关闭，新报 1 条漏报 High；E：E-07、E-14 关闭，E-4-01 修复引入 1 条回归，另 1 条漏报 High。全部采纳并已改：

| ID | 处理 |
|---|---|
| D-5-01（High） | `hawk_field_ref.py`、`dubbo_request.py` 加 `SameOriginRedirectHandler`（带 Cookie 的 urllib 请求不跟随跨源重定向）；新增 `tests/test_lexin_http_guards.py` |
| E-5-01（High） | `hive_query.js` 只读入口拒绝 `EXPLAIN ANALYZE`（Presto 会真正执行语句），普通 `EXPLAIN` 保留；正文同步 |
| E-5-02 | 扫描器加 `dashCommentNeedsSpace` 选项：MySQL 保持"`--` 后需空白"，Presto/Spark 的 `--` 到行尾都是注释；Hive 测试预期改正 |
| E-01 | 维持（codex 同意） |

验证：`tests` 119、`hooks/tests` 17、lexin node:test 全绿。
