# 第 4 轮审核结论

B 批 codex 判"可收敛"。其余：A 1 关闭 + 1 引入新问题；C 1 关闭 + 1 引入回归 + 2 Low；D 5 关闭 + 1 漏报 High；E 3 关闭 + 2 部分 + 1 漏报 High。全部采纳并已改：

| ID | 处理 |
|---|---|
| A-4-01 | 暂存一致性只在"用户要求提交 / 交付对象是暂存内容"时要求；只交接工作区时快照（已含暂存区指纹）匹配即可 |
| C-4-01 | `pick_agent.py` 解析失败的占位串不参与按模型折叠（各自单独成组）；补"两份配置都缺 model 仍轮换"测试 |
| C-4-02 / C-4-03 | `--host` 帮助文本、作业目录格式说明同步 |
| D-4-01（High） | `register_metrics.js` 拒绝跨源重定向；两个 Healthy 脚本导出 `requestJson` 并各加 `tests/redirect_guard.test.js`（跨源不发第二次请求、同源仍跟随、告警链接域名与 env 冲突拒绝） |
| E-07 | `--` 只有后跟空白/控制字符或行尾才算注释（`1--1` 是表达式）；补用例 |
| E-14 | 成功还要求结果容器 `data`（或 `rows`/`result`），`{message:'denied'}` 之类 2xx 判失败 |
| E-4-01（High） | `hive_query.js` 改用 `query-mysql-data` 导出的顺序扫描器（字符串内 `--`/`/*` 不算注释）；补 3 条用例 |
| E-01 | 维持（codex 同意）；E-02 codex 撤销保留意见 |

验证：`tests` 117、`hooks/tests` 17、lexin node:test（含新增 4 个测试文件）全绿。
