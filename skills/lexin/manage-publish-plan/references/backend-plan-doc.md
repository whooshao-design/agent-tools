# 后端发布方案文档

TQM 发布计划评审（`https://tqm.oa.fenqile.com/#/qualityActivity/review/releasePlanAdd?id=<评审ID>`）的“发布方案（后台）”tab 挂的是一份飞书文档。本文件说明怎么找到这份文档、写什么、怎么写。2026-10-21 在需求 1426731（评审 2026102117000660）上按用户逐条意见定稿。

## 找到文档

- 评审应用模板“【风控】发布checklist”时，平台会给“发布方案（后台）”tab 复制一份独立的飞书 wiki 文档（2026-10-21 实测；前端 tab 未核对）。文档标题仍是模板名“发布计划方案（新）.docx”，但它属于这次评审，直接在里面写。可以用 wiki 节点的 `node_create_time` 核对：它应该等于应用模板的时间。
- 定位文档 token：在已登录的评审页里调 `oa/review_platform/web/template/find_plan_by_id.json`，参数 `{"id":<后台 tab 的 templateMenuId>}`（切到该 tab 时页面自己会发这个请求，可从网络请求里取 id，例如 1125984），返回的 `feishu_node_token` 就是 wiki token。再用 `oa/review_platform/feishu/wikiConvert.json` 换成 docx 链接；也可以直接把 wiki 链接交给 `manage-feishu-doc`。
- 读写都用 `manage-feishu-doc`（`read`、`edit --op=replace-section`），先 `--dry-run` 核对 `removedPreview`。`replace-section` 会保留节标题本身，片段里不要再写一级标题。

## 写作规则

- 只写后端应用发布。前端应用、前端发布单、前后端发布先后都不写。
- 每句话都要能被代码、配置或验证记录证实。没核对过的说法（例如“prod 文案与默认值相同”）不写。
- 不写发布分支、提交号、release 合回 master 这类发布单或系统自动处理的事项。
- 表格只放结构化字段；环境要求、依赖原因等特殊情况写在表格下方的“补充：”段落里。

## 各节内容

模板有五节，按下面填写：

1. 发布顺序
   - 应用发布顺序：表格列为“序号 / 应用名 / 负责人”，一个应用一行，只写应用名，不写环境和机器。应用名取运行资源 `app.properties` 的 `application.name`。某个环境有特殊要求时写在表下补充里，并说明原因，例如 OA 环境必须与线上同批或先于线上。
   - 配置发布顺序：表格列为“序号 / 配置类型 / 应用名 / namespace / 配置名 / 配置说明 / 负责人”，一项配置一行。配置说明写这项配置控制什么、值的格式。表下补充写清：这项配置是否是应用发布的前置依赖；应用发布后补发是否可行；配置发布前系统按什么默认值运行、会有什么可见差异；哪些环境已经发布并验证。默认值以代码为准，例如 `@HippoConfigProperty` 的 `defaultValue`。
2. 回退方案及应急预案：按发布逆序回滚到上一版本；写明有无 DB 变更、是否需要数据回滚、回滚后已产生的业务数据如何处理，以及配置是否需要回滚和原因。
3. 灰度计划：有业务灰度放量就写放量节奏；没有就写“不涉及业务灰度放量”，再写应用发布节奏（先灰度环境、确认后逐台发布线上）。
4. 发布观察：模板自带示例图片，发布完成后由用户回填，发布前不改这一节。
5. 其他：DB 变更情况、预发布验证结论（用具体的业务对象和结果）。不写 release 合回 master，发布系统会自动处理。

## 示例（需求 1426731 第一节定稿）

```markdown
## 1、应用发布顺序

| 序号 | 应用名 | 负责人 |
|-|-|-|
| 1 | server_hawk_decision_manage | joneyshao |

补充：server_hawk_decision_manage 的 OA 环境必须与线上同批或先于线上发布。主站乐包复制的审批回调由 OA 环境处理，OA 仍是旧代码时，含实时查询字段的乐包审批通过后会复制失败。

## 2、配置发布顺序

| 序号 | 配置类型 | 应用名 | namespace | 配置名 | 配置说明 | 负责人 |
|-|-|-|-|-|-|-|
| 1 | Hippo | server_hawk_decision_manage | application | package_copy_real_time_query_confirm | 复制含实时查询字段的乐包时的确认提醒：提醒文案、流程文档名称和链接（JSON） | joneyshao |

补充：该配置不是应用发布的前置依赖，建议在应用发布前完成，应用发布后补发也可以。未发布 prod 配置期间，确认提醒使用代码内置的默认文案，流程文档链接为空，复制功能本身不受影响；配置生效后提醒中显示流程文档链接。stable、pre 环境已发布并验证。
```

反例：表格里写“server_hawk_decision_manage（OA 环境：10.x.x.x）”“server_hawk_decision_manage（灰度 → 线上）”拆成两行；配置名一栏写成“Hippo（server_hawk_decision_manage，application 命名空间，prod）package_copy_real_time_query_confirm”这种一长串；正文写“发布分支 release（含提交 9ed4ac71c）”。
