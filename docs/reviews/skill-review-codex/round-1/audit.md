# 第 1 轮审核结论（Claude 对 codex-vps 61 条 finding 的逐条核对）

核对方法：每条都回到被引用的文件行与脚本源码验证；脚本类问题按 codex 给的离线输入自行复算。结论三类：采纳 / 部分采纳（只改措辞或范围）/ 拒绝（给证据）。

## A 生产者链路（9 条，全部采纳，A-05 部分）

| ID | 结论 | 处理 |
|---|---|---|
| A-01 | 采纳 | Claude 读者命令加 `--strict-mcp-config`；Codex 读者命令把 `--ignore-user-config` 改为必加；派发前核验工具面，做不到隔离就不做读者测试 |
| A-02 | 采纳 | `dev-auto-loop` §8：`R`/`B` 变化即绑定旧值的审批全部失效（精确绑定），影响分析只决定修订与复审范围 |
| A-03 | 采纳 | `dev-verify-change` 增加独立验证入口：无 `G` 时按 `dev-build-change` 的 direct 规则构造最小记录，报告写明证据边界，不补造历史；DEV 状态核对限定于存在 `change_revision` 时 |
| A-04 | 采纳 | `dev-design-solution`：用户要方案时默认落盘到产物目录，明确只讨论/不保存才用对话模式；两处措辞统一 |
| A-05 | 部分采纳 | "差不多/你看着办不算确认"限定于影响范围、核心行为或外部后果的关键歧义；低风险可逆且用户授权自行判断的事项声明假设后继续（与全局规则一致） |
| A-06 | 采纳 | 选模命令改绝对路径并补 `--task <id>`，注明只预览 |
| A-07 | 采纳 | `check_mermaid.js` 先扫块、无块直接退出，再加载 Playwright |
| A-08 | 采纳 | 派发未启动即失败时追加"取消预占"checkpoint，恢复以最后一条计数为准 |
| A-09 | 采纳 | 与 B-09 合并：写作原则限定于叙事正文；追踪矩阵、清单表、findings 表与评审报告绑定表按阶段模板 |

## B 评审门禁链路（9 条，全部采纳）

| ID | 结论 | 处理 |
|---|---|---|
| B-01 | 采纳 | 定点复审语义范围加入"引用或依赖被改章节的章节"，依赖不能确认则完整复审 |
| B-02 | 采纳 | 测试清单复核模板授权表拆为"原授权绑定 / 本轮复核绑定 `(R,S,C,B)`" |
| B-03 | 采纳 | hook 在枚举判断前校验 `conclusion` 为字符串（列表/对象此前触发 TypeError 被 fail-open）；补两条测试 |
| B-04 | 采纳 | `ocr delegate preview` 无 `--output`，改 stdout 重定向 |
| B-05 | 采纳 | 续行符后的注释移到独立行 |
| B-06 | 采纳 | 三处统一引用读者协议 §5 判定（全文七问、截断前五问、探针） |
| B-07 | 采纳 | Codex 默认提示先分流建议审查/正式准入 |
| B-08 | 采纳 | 需求评审严重度补一句判级依据 |
| B-09 | 采纳 | 同 A-09 |

## C common / dev-quality / cicd（11 条：9 采纳、2 部分）

| ID | 结论 | 处理 |
|---|---|---|
| C-01 | 部分采纳 | 默认权限（Claude 跳过权限提示、Codex workspace-write）是用户裁定的固定值，行为不改；删除"与主会话子 agent 相同"的错误承诺，改为如实描述并提示受限会话用 `--readonly` |
| C-02 | 采纳 | `--resume` 沿用上一作业的 `readonly`；放宽权限需新起作业；补测试 |
| C-03 | 采纳 | 超时写出 `exit_code: "timeout"` 的 meta.json 与已有输出；`--status` 能区分 |
| C-04 | 采纳 | 措辞改为：候选表两条通道都有时按宿主选；只登记 `claude-*` 的五个环节 Codex 宿主也按表派发 |
| C-05 | 部分采纳 | 答案键没有位置字段，机械命中改称"候选命中"，文档明确人工核对位置后才是有效分；不改脚本 |
| C-06 | 采纳 | `json_ok` 的定义改为与实现一致（"能提取一个可解析 JSON 对象"），不再当作"恰好一个代码块"的证据 |
| C-07 | 采纳 | 两个专项的"不适合"限定为代码阶段；方案阶段以方案与现有基线为输入 |
| C-08 | 采纳 | expand→backfill→contract 限定于新旧版本并存且保留存量数据的场景 |
| C-09 | 采纳 | 用户问门禁时先调 `get_sonarqube_quality_gate_status` |
| C-10 | 采纳 | `skill-authoring` 验证步骤引用仓库单测、路由评测、case 文件与版本必升规则 |
| C-11 | 采纳 | `env-access` 改为 `lexin` 分类的 `query-*`；从 lint 豁免集合移除 |

## D lexin 观测诊断（17 条，全部采纳）

| ID | 结论 | 处理 |
|---|---|---|
| D-01 | 采纳 | `dubbo_request.py` 按部署环境（stable/pre/gray/prod）查 `targets.json`，线路仍归一到 stable/pre；prod/gray 无对应条目时要求显式 `--ip/--port`，不借用 pre 地址 |
| D-02 | 采纳 | 正文与脚本提示改为用 `fileCount`/错误码判断文件是否扫到，`matchedFiles` 只表示命中文件 |
| D-03 | 采纳 | 正文说明 k8s 路径快检读的是容器 stdout；脚本 quick 分支也输出 limitation |
| D-04 | 采纳 | 多提供方时不再取第一个，列出候选并要求 `--app` |
| D-05 | 采纳 | 注册中心按 `total` 翻页；输出 `total` 与 `truncated` |
| D-06 | 采纳 | 响应先校验成功状态与结构，错误响应非零退出 |
| D-07 | 采纳 | 删除"手动复制 Cookie 到会话"段落，统一走浏览器重登 |
| D-08 | 采纳 | 改为只判断当前存在性与 TTL，区分未写入/过期需写入日志或历史证据 |
| D-09 | 采纳 | JVM 看板从 `backupDir/before.json` 取数；正文同步 |
| D-10 | 采纳 | 三个入口改为精确读 `access_token` |
| D-11 | 采纳 | 未注册指标仍查 Prometheus，`registered` 作为独立字段 |
| D-12 | 采纳 | 显式给了 `app` 与 `desc` 时不强制解析后缀 |
| D-13 | 采纳 | 容器示例传 `--profile .../browser-profiles/main` |
| D-14 | 采纳 | 示例路径改为 `/home/joney/projects/backend/hawk/...` |
| D-15 | 采纳 | description 收窄为"修改已有大盘"，正文说明无创建入口 |
| D-16 | 采纳 | 说明 dry-run 对依赖前序提取值的步骤需 `--var` 提供预览值 |
| D-17 | 采纳 | 从告警 URL 主机推导站点，与显式 `--env` 冲突时报错 |
| 跨文件 | 采纳 | 告警 skill 的日志交接改指 `query-app-logs`；`dubbo_test` MCP / `healthy.healthy_read_board` 改为实际工具名 |

## E lexin 平台数据（15 条：12 采纳、1 部分、2 拒绝）

| ID | 结论 | 处理 |
|---|---|---|
| E-01 | 拒绝 | stable 自动发布是用户明确裁定的站点规则：stable 是测试环境，Hippo 前端在 stable 发布本就不走审批；正文五处、脚本注释和 `agents/openai.yaml` 一致，`--no-publish` 可退回草稿。改成默认草稿会让每次 stable 改配置多一轮无意义确认。保留，请用户知悉 |
| E-02 | 拒绝 | 默认名单 `joneyshao` 是仓库所有者本人的 OA 账号（git user 同名），"自助补权限"只给自己加角色、不删任何人、必须验证 `nonTargetRoleUsersUnchanged`；这是单人工具的自助设计，不是越权。保留 |
| E-03 | 采纳 | `flows.md` 删除"两 lane 可并发"，与正文 VM 先行一致 |
| E-04 | 部分采纳 | 脚本不改；正文加规则：点"批量集成分支"前记录将被集成的项目集合，含目标外项目且用户未授权时不点、报告阻塞 |
| E-05 | 采纳 | `approve --confirm` 发送回调时只接受 `<scope>.<key>`，去掉裸 key 回退；正文与旧脚本说明同步 |
| E-06 | 采纳（文档） | 脚本的 noop 路径本就会在 `publish.enabled` 时发布；问题在正文步骤 5 让 agent 跳过 upsert。改为"noop 只说明草稿不必改，要发布仍运行 upsert" |
| E-07 | 采纳 | `assertReadOnlySql` 增加去字符串后的写关键字与 `INTO OUTFILE/DUMPFILE`、`FOR UPDATE` 拒绝；补测试 |
| E-08 | 采纳 | Redis 模板 `--env` 改为已归一的 stable/pre |
| E-09 | 采纳 | 前端路径改为 `/home/joney/projects/frontend/web_mihawk_oa`（正文三处 + 脚本两处） |
| E-10 | 采纳 | `find` 输出 `namespacesTruncated`（满页 100）；正文删除"全部"承诺，满页或有 `unreadableNamespaces` 时禁止下"未配置"结论 |
| E-11 | 采纳 | 同一 profile 的多次 `get` 串行 |
| E-12 | 采纳 | 404 → `NOT_FOUND`（核对 navtree），5xx → `HIPPO_UPSTREAM_ERROR`，其余仍 `LOGIN_REQUIRED` |
| E-13 | 采纳 | token 解析字段末尾加 `sub` |
| E-14 | 采纳 | HTTP ≥400 或业务错误码时非零退出；正文给成功判定规则 |
| E-15 | 采纳 | "必定失败"限定为未打补丁的上游版本 |
| 跨文件 | 采纳 | `lexiao-deploy:97`、`get-browser-session:70` 的容器日志归属改指 `query-app-logs` |
