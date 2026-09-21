# lexin 平台与数据访问（前缀 E）评审报告

## 1. 总体判断

整体已有较好的范围控制和回读校验，但授权例外、相互矛盾的执行指令及接口契约缺口仍会导致越界或错误结论。
共发现 15 项问题：8 项 High、7 项 Medium。
已逐项阅读 12 个 skill 正文、references、附加配置，并核对 scripts 的参数、输出、路径及相关 MCP 接口；包含 ClickHouse 当前未提交内容。
执行了 6 个离线测试文件，均通过；另用纯函数复现了发布默认值、`noop`、SQL 校验及错误分类问题，未访问业务平台、未执行 SQL、未修改文件。
最值得先做的三件事：恢复明确授权边界；统一部署顺序与操作范围；修正只读查询的输入和结果判定。

## 2. Findings

位置相对于 `/home/joney/projects/ai/agent-tools/skills/lexin/`；证据中的 `scripts/` 属于该行 skill。

| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
|---|---|---|---|---|---|---|---|---|
| E-01 | configure-hippo | [SKILL.md:14](/home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/SKILL.md:14) | High | 安全与合规 | 将“测试环境不走平台审批”当成用户发布授权。用户只要求修改 stable 配置，也会立即发布。 | 原文：“自动按 key 发布目标项，不需要……授权参数”；第59行称“这是站点规则而不是授权动作”。`scripts/hippo_draft_config.js:649` 的 `publishOptions` 在无参数时确实返回 `enabled=true`。 | stable 同样根据当前任务是否已授权发布决定动作；未授权时默认草稿，同步脚本默认值及附加配置。 | 确认 |
| E-02 | configure-hippo | [SKILL.md:78](/home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/SKILL.md:78) | High | 安全与合规 | 修改配置会扩展成给固定账号授修改权和所有环境的发布权；固定账号也不必然是当前登录者。 | 原文：“默认名单……自动执行，不要再问用户”；第80行：“自动跑一次 namespace-grant 自助补权限”。`scripts/hippo_draft_config.js:872` 无授权参数返回固定名单，`:841` 默认同时授两种角色。 | 只有当前任务已明确授权名单和角色时才授予；普通配置修改遇到权限不足应报告，不能自动扩大权限。 | 确认 |
| E-03 | lexiao-deploy | [references/flows.md:101](/home/joney/projects/ai/agent-tools/skills/lexin/lexiao-deploy/references/flows.md:101) | High | 正确性与自洽 | 灰度引用流程允许 VM 和容器同时部署，绕过正文要求的 VM 验证门禁。 | 引用文件：“VM/KVM lane and container lane may run concurrently”；正文 `SKILL.md:31`：“Deploy every VM/KVM target … before touching its container targets”“Do not run … concurrently”。 | 删除引用文件中的并发许可，统一为 VM 全部验证后才开始容器。 | 确认 |
| E-04 | lexiao-deploy | [SKILL.md:74](/home/joney/projects/ai/agent-tools/skills/lexin/lexiao-deploy/SKILL.md:74) | High | 触发与边界 | 单应用部署流程直接要求批量集成分支，没有核对批量集合是否超出用户指定应用。版本包含其他项目时存在扩大集成范围的风险。 | 原文：“If 批量集成分支 is enabled, click it, confirm”；`scripts/lexiao_pre_release.js:378` 的 `branchIntegrate(page, url)` 没有目标应用参数，直接点击批量按钮。 | 点击前核对实际集成集合；集合超出授权范围时使用单项目入口，无法收窄才请求扩大范围。 | 确认 |
| E-05 | handle-stable-hawk-approval | [SKILL.md:125](/home/joney/projects/ai/agent-tools/skills/lexin/handle-stable-hawk-approval/SKILL.md:125) | High | 安全与合规 | 地区化查询仍允许回退到无地区的回调地址，可能查询墨西哥记录却向国内实例发送审批。 | 原文：“没有再回退到顶层裸 `<target_key>`”；同句承认“回调可能打到错误地区”。`scripts/stable_approval_cli.py:765` 确实使用裸 key 回退；`references/legacy-approval-scripts.md:25` 又写“不允许裸 key”。 | 执行审批时必须取得匹配 scope 的目标；缺失即停止，移除执行路径的裸 key 回退。 | 确认 |
| E-06 | configure-hippo | [SKILL.md:155](/home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/SKILL.md:155) | High | 正确性与自洽 | 草稿已等于目标值、active 仍是旧值时，`noop` 分支会跳过用户要求的发布。 | 原文：“若 operation=noop……直接运行 verify”。`scripts/hippo_draft_config.js:690` 仅按草稿判断 `noop`；离线构造草稿 `new`、active `old`，得到 `operation=noop` 且 `targetHasUnpublishedDraft=true`。 | 将“不必保存草稿”与“不必发布”分开；已有发布授权且 active 不一致时仍执行发布并验证 active。 | 确认 |
| E-07 | query-mysql-data | [scripts/mysql_readonly.js:83](/home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js:83) | High | 接口契约／安全 | 宣称只读的 SQL 输入检查实际接受写操作形式，首关键字检查不能兑现只读边界。 | `SKILL.md:25`：“不要执行 INSERT/UPDATE/DELETE/DDL”；脚本第90行允许 `with`、`select`。离线校验实际放行 `WITH c AS (SELECT 1) DELETE FROM demo WHERE id = 1` 和 `SELECT 1 INTO OUTFILE '/tmp/example'`。 | 校验 WITH 的最终语句和 SELECT 写文件子句；无法可靠判断时拒绝。服务端是否另有保护未验证，不能依赖它代替本地契约。 | 确认 |
| E-08 | redis-query | [SKILL.md:90](/home/joney/projects/ai/agent-tools/skills/lexin/redis-query/SKILL.md:90) | High | 接口契约／环境路由 | 兜底模板固定使用 `--env auto`，会丢失用户明确指定的环境。 | 第77行要求“用户明确指定时按上表归一”；模板却是“`--env auto`”。被调用的 `test-dubbo-api/scripts/dubbo_request.py:137` 在 auto 下只按 key 推断；明确查 stable、key 含 `prod` 时会选 pre 线路。 | 模板传入已经确定的 `stable` 或 `pre`；仅在用户未指定环境且确需按 key 推断时使用 auto。 | 确认 |
| E-09 | start-local-frontend | [SKILL.md:12](/home/joney/projects/ai/agent-tools/skills/lexin/start-local-frontend/SKILL.md:12) | Medium | 引用有效性／时效性 | 文档及启动脚本仍引用迁移前目录，启动会使用不存在的工作目录，已有实例归属判断也会失效。 | 原文：“`/home/joney/projects/web/web_mihawk_oa`”；`scripts/frontend_env.js:26` 同样硬编码该路径。已核对旧目录不存在且不是符号链接，新目录 `/home/joney/projects/frontend/web_mihawk_oa` 存在。 | 同步修改正文第12、24、63行及脚本 `PROJECT_DIR`、来源注释。 | 确认 |
| E-10 | query-hippo-config | [SKILL.md:71](/home/joney/projects/ai/agent-tools/skills/lexin/query-hippo-config/SKILL.md:71) | Medium | 输出契约／完整性 | 文档承诺扫描全部 namespace，但脚本只读第一页；输出不足以证明搜索完整，容易把漏扫当未配置。 | 原文：“一次扫完该应用所有 namespace”；`scripts/hippo_query.js:283` 固定 `page/0/size/100`。第392行的 `appsTruncated` 也只反映候选应用二次裁剪，不覆盖应用搜索第一页截断。 | 未实现完整分页前，删除“全部”承诺；输出各层截断状态，满页或存在 `unreadableNamespaces` 时禁止作全量不存在结论。 | 确认 |
| E-11 | query-hippo-config | [SKILL.md:126](/home/joney/projects/ai/agent-tools/skills/lexin/query-hippo-config/SKILL.md:126) | Medium | 可执行性 | 鼓励多次 `get` 并行，却未区分同一 profile 不能被多个 Chromium 同时打开。 | 原文：“多个独立 namespace……多次 get 并行发起”；`scripts/hippo_query.js:22` 共用 healthy profile，`:109` 每次启动 persistent context，`:117` 将冲突报为 `PROFILE_IN_USE`。 | 同一 profile 的独立命令串行执行；只有已经指定独立 profile 时才允许并行。 | 确认 |
| E-12 | query-hippo-config | [scripts/hippo_query.js:139](/home/joney/projects/ai/agent-tools/skills/lexin/query-hippo-config/scripts/hippo_query.js:139) | Medium | 接口契约／异常处理 | 404 和 500 都被输出为登录失效，与正文要求先核对 env/cluster 的恢复路径冲突。 | `SKILL.md:69`：“返回 404/500，先查 navtree”；脚本第143行将 `HIPPO_GET_FAILED` 统一转成 `LOGIN_REQUIRED`。离线输入 404、500 均复现该分类。 | 保留 HTTP 状态分类；401/登录重定向才提示登录，404 核对目标，5xx 报上游错误。 | 确认 |
| E-13 | query-mysql-data | [scripts/mysql_readonly.js:174](/home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js:174) | Medium | 接口契约／身份解析 | 文档承诺优先使用 token 中 OA 账号，但解析遗漏本批审批 skill 明确使用的 `sub`，可回退为错误的本机账号。 | `SKILL.md:59`：“token 中的 OA 用户字段 → … → 当前系统用户”；脚本的字段列表没有 `sub`，第265行已有 token 时直接返回；第284行最终回退系统用户名。离线 `{sub:"oa_example"}` 返回空账号。 | 在已确认的 lxcloud token 口径中识别 `sub`；无法识别时按文档完成页面账号回退或要求显式账号。 | 确认 |
| E-14 | query-mysql-data | [scripts/mysql_readonly.js:348](/home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js:348) | Medium | 输出契约／异常处理 | 请求失败仍可正常退出，正文没有规定如何判定 HTTP、业务查询成功，agent 容易把命令成功或空数据当查询成功。 | 脚本第349行只输出“`statusCode: response.statusCode, body: response.body`”，随后正常返回；`SKILL.md:158` 的流程未给成功响应判定规则。 | 明确并校验 HTTP 与业务成功条件；错误响应返回失败，只有成功响应里的空结果才解释为零行。 | 确认 |
| E-15 | manage-feishu-doc | [references/docx-block-operations.md:68](/home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/references/docx-block-operations.md:68) | Medium | 时效性／自洽 | 同一段同时宣称 descendant 经 MCP 必定失败、又已修复，会把 agent 引向不必要的 REST 绕行。 | 第70行：“通过 lark-mcp 调用必定返回……”；第72行：“已由……patches/apply.mjs 修复”。已核对 wrapper 第57行起会应用补丁，失败则拒绝启动。 | 将“必定失败”限定为未打补丁的上游版本；当前仓库 wrapper 按已修复路径描述。 | 确认 |

## 3. 跨 skill / 跨文件问题

- Hippo 授权口径分裂：`configure-hippo/SKILL.md:12` 写“只有用户……明确授权发布”，第59行又为 stable 取消该要求；`agents/openai.yaml:4` 的明确授权描述与正文默认账号自动授权也不一致，对应 E-01、E-02。
- 查询遗漏会传导到写操作：`configure-hippo/SKILL.md:151` 要求通过 `find` 确认唯一目标，而 `query-hippo-config/scripts/hippo_query.js:283` 只取 namespace 第一页；因此 E-10 不仅影响查询，也影响写入前定位。
- profile 使用规则不统一：`get-browser-session/SKILL.md:111` 明确其他脚本不受其锁保护，但 `query-hippo-config/SKILL.md:126` 仍建议并行；其 `references/hippo-api.md:203` 又推荐复制 profile，与正文第118行的关闭占用路径不同。
- 容器日志归属引用已过时：`lexiao-deploy/SKILL.md:97`、`get-browser-session/SKILL.md:70` 仍指向 `java-server-diagnostics`，而范围外的 `java-server-diagnostics/SKILL.md:96` 已明确由 `query-app-logs` 承接。

## 4. 做得好、不要动

- `configure-hippo/SKILL.md:58` 的逐 key 删除授权、计划 token、实例数复核及非目标保护有实际作用，应保留；修复自动发布和提权例外不需要推翻这套机制。
- `lexiao-hippo-publish-authorize/SKILL.md:69` 的先查差集、写后集合比对、满 200 条停止，能避免重复登记与把不完整响应当空集合。
- `get-browser-session/SKILL.md:107` 的凭据状态外置、快照权限要求，以及第164行的有限重试，边界清楚；飞书文档交给独立 skill 的分工也应保留。
- `query-mysql-data/SKILL.md:35` 的运行时数据源定位，以及 Hive、ClickHouse 不擅自添加业务过滤条件的约束，能有效减少“查到了错误库或错误口径”的问题。
- `manage-feishu-doc/SKILL.md:54` 的结构化表格校验、第106行的先建并验证新章节再删旧章节，以及 `lexiao-deploy/SKILL.md:83` 的构建号跃迁验证，都针对真实误判场景，无需为了精简删掉。

## 5. 优先级 Top 10

1. E-03：统一灰度 VM/容器顺序，删除一条危险的相反指令。
2. E-08：让 Redis 模板保留已确定环境，避免查询错误线路。
3. E-09：修正前端迁移路径，恢复启动与实例识别。
4. E-06：修正 `noop` 分支，避免漏掉已授权发布。
5. E-01：取消 stable 未授权自动发布，同步默认参数。
6. E-02：取消普通配置任务附带的默认账号自动提权。
7. E-05：审批执行强制使用带地区的目标地址。
8. E-07：补齐 MySQL 只读 SQL 输入限制。
9. E-04：批量集成前核对授权项目集合。
10. E-10：标明 Hippo 扫描截断和不可读范围，阻止错误的不存在结论。

## 6. JSON

```json
{
  "batch": "E",
  "findings": [
    {
      "id": "E-01",
      "skill": "configure-hippo",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/SKILL.md:14",
      "severity": "High",
      "category": "安全与合规",
      "summary": "stable 修改默认自动发布，把平台免审批误当作用户发布授权。",
      "fix": "stable 未获发布授权时默认只保存草稿，同步脚本和附加配置。",
      "confidence": "确认"
    },
    {
      "id": "E-02",
      "skill": "configure-hippo",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/SKILL.md:78",
      "severity": "High",
      "category": "安全与合规",
      "summary": "普通配置修改或 namespace 创建会自动给固定账号授修改权和发布权。",
      "fix": "授权名单和角色必须被当前任务明确覆盖，权限不足不自动提权。",
      "confidence": "确认"
    },
    {
      "id": "E-03",
      "skill": "lexiao-deploy",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/lexiao-deploy/references/flows.md:101",
      "severity": "High",
      "category": "正确性与自洽",
      "summary": "引用流程允许 VM 与容器并发，正文要求 VM 全部验证后才部署容器。",
      "fix": "删除引用流程中的并发许可，统一部署顺序。",
      "confidence": "确认"
    },
    {
      "id": "E-04",
      "skill": "lexiao-deploy",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/lexiao-deploy/SKILL.md:74",
      "severity": "High",
      "category": "触发与边界",
      "summary": "单应用部署直接触发批量集成，未核对批量项目集合是否越界。",
      "fix": "执行前核对集成集合，优先收窄至已授权项目。",
      "confidence": "确认"
    },
    {
      "id": "E-05",
      "skill": "handle-stable-hawk-approval",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/handle-stable-hawk-approval/SKILL.md:125",
      "severity": "High",
      "category": "安全与合规",
      "summary": "审批回调允许回退到无地区目标，可能跨地区发送回调。",
      "fix": "执行时必须匹配 scope 和 target_key，移除裸 key 回退。",
      "confidence": "确认"
    },
    {
      "id": "E-06",
      "skill": "configure-hippo",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/SKILL.md:155",
      "severity": "High",
      "category": "正确性与自洽",
      "summary": "草稿相等产生 noop 后直接 verify，可能跳过已授权且仍需要的发布。",
      "fix": "分别判断草稿保存和 active 发布是否需要执行。",
      "confidence": "确认"
    },
    {
      "id": "E-07",
      "skill": "query-mysql-data",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js:83",
      "severity": "High",
      "category": "接口契约／安全",
      "summary": "只读输入检查放行 WITH DELETE 和 SELECT INTO OUTFILE。",
      "fix": "校验 WITH 最终语句及 SELECT 写文件子句，无法确认只读时拒绝。",
      "confidence": "确认"
    },
    {
      "id": "E-08",
      "skill": "redis-query",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/redis-query/SKILL.md:90",
      "severity": "High",
      "category": "接口契约／环境路由",
      "summary": "脚本模板固定 env auto，可能覆盖用户明确指定的环境。",
      "fix": "模板传入已确定的 stable 或 pre，仅确需推断时使用 auto。",
      "confidence": "确认"
    },
    {
      "id": "E-09",
      "skill": "start-local-frontend",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/start-local-frontend/SKILL.md:12",
      "severity": "Medium",
      "category": "引用有效性／时效性",
      "summary": "正文和脚本仍使用不存在的迁移前前端目录。",
      "fix": "统一改为 /home/joney/projects/frontend/web_mihawk_oa。",
      "confidence": "确认"
    },
    {
      "id": "E-10",
      "skill": "query-hippo-config",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/query-hippo-config/SKILL.md:71",
      "severity": "Medium",
      "category": "输出契约／完整性",
      "summary": "find 承诺全部扫描，实际只取第一页且截断状态不完整。",
      "fix": "补全分页或显式报告扫描不完整，禁止据此认定全量不存在。",
      "confidence": "确认"
    },
    {
      "id": "E-11",
      "skill": "query-hippo-config",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/query-hippo-config/SKILL.md:126",
      "severity": "Medium",
      "category": "可执行性",
      "summary": "建议并行执行 get，但默认共用不能同时打开的 Chromium profile。",
      "fix": "同一 profile 串行执行，仅显式独立 profile 时允许并行。",
      "confidence": "确认"
    },
    {
      "id": "E-12",
      "skill": "query-hippo-config",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/query-hippo-config/scripts/hippo_query.js:139",
      "severity": "Medium",
      "category": "接口契约／异常处理",
      "summary": "404 和 500 被输出为 LOGIN_REQUIRED，引导错误恢复路径。",
      "fix": "区分登录、目标不存在和上游错误，保留 HTTP 状态语义。",
      "confidence": "确认"
    },
    {
      "id": "E-13",
      "skill": "query-mysql-data",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js:174",
      "severity": "Medium",
      "category": "接口契约／身份解析",
      "summary": "OA 账号解析遗漏 JWT sub，已有 token 时可能直接回退系统用户名。",
      "fix": "识别已确认的 sub 口径，并落实无法识别时的页面账号回退。",
      "confidence": "确认"
    },
    {
      "id": "E-14",
      "skill": "query-mysql-data",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js:348",
      "severity": "Medium",
      "category": "输出契约／异常处理",
      "summary": "错误响应可正常退出，文档缺少 HTTP 和业务成功判定。",
      "fix": "校验成功响应契约，错误返回失败，区分错误与成功空结果。",
      "confidence": "确认"
    },
    {
      "id": "E-15",
      "skill": "manage-feishu-doc",
      "location": "/home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/references/docx-block-operations.md:68",
      "severity": "Medium",
      "category": "时效性／自洽",
      "summary": "已应用补丁的 descendant MCP 路径仍被描述为必定失败。",
      "fix": "将失败结论限定为未打补丁版本，说明当前 wrapper 已修复。",
      "confidence": "确认"
    }
  ]
}
```
