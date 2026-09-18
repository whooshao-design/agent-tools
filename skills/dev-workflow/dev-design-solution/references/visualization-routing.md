# 技术方案可视化路由

图的目的是让评审者在读细节之前看到全貌。规则是可判定的触发条件：满足就画，不画要在该处写一句豁免理由。

## 1. 触发条件

| 内容形态 | 触发条件 | 首选图型 | 不满足时用 |
|---|---|---|---|
| 多参与者交互 | 3 个以上参与者，且顺序依赖 4 步以上 | `sequenceDiagram` | 编号步骤 |
| 状态与转换 | 3 个以上状态，且存在非显然或非法转换 | `stateDiagram` | 状态转换表 |
| 结构变化 | 调用、依赖或部署关系前后不同 | 前后对照的 `flowchart`，节点标 `[新增]` `[删除]` `[保持不变]` | 对照表 |
| 分支逻辑 | 3 个以上分支或分支再分支 | `flowchart` | 条件表 |
| 分阶段切换 | 3 个以上阶段且跨系统并存 | 阶段图 | 阶段表，多数情况表更清楚 |
| 数据模型 | 实体关系变化 | `erDiagram` | 字段表 |
| 线性 3 到 4 步 | 不画：重述编号列表的图只是装饰 | — | 编号列表 |

一张图只回答一个问题。回答两个问题的图拆成两张。

## 2. 主图

每份正式方案在 2.1 放一张主图，展示全貌而不是细节。主图要能让人读出三件事：接口属于哪个应用、数据落在什么介质、数据往哪里流。按 profile 的默认图型：

| 主 profile | 默认主图 |
|---|---|
| mechanism-architecture | 参与者时序图，或调用关系的前后对照 |
| migration-remediation | 现状与目标的前后对照，或阶段图 |
| contract-evolution | 新旧交互时序，配版本窗口表 |
| data-state-consistency | 状态图，或模型前后对照 |

豁免条件：方案只有单一参与者、单一阶段、没有分支和结构变化。豁免时在 2.1 写"本方案无多参与者交互、状态或结构变化，不画主图"。

## 3. 按评审问题选图型

| 需要回答的问题 | 首选表达 | 不画图时的替代 |
|---|---|---|
| 系统边界和职责 | 上下文图 / 简化 C4 / flowchart | 短边界表 |
| 静态组件依赖 | 组件关系图 | 依赖表 |
| 请求、事件、重试、补偿顺序 | `sequenceDiagram` | 编号步骤 |
| 条件分支、合并和终止 | `flowchart` | 条件表或列表 |
| 合法和非法状态转换 | `stateDiagram` | 状态转换表 |
| 实体基数和所有权 | `erDiagram` | schema diff / 字段表 |
| 部署节点、网络和故障域 | 部署图 | 节点映射表 |
| 现状分阶段切到目标 | 迁移阶段图 / 前后对照图 | 阶段表 |
| 候选方案比较 | 决策表 | 不使用雷达图等主观视觉权重 |
| AC/DEC/CHG 精确映射 | 追踪矩阵（`traceability.md`） | 不使用关系图替代精确表格 |

## 4. 格式

- mermaid 只用稳定子集：`flowchart` / `graph`、`sequenceDiagram`、`stateDiagram`、`erDiagram`、`classDiagram`。不用 beta 图型、`%%{init}%%` 指令和主题配置。`stateDiagram-v2` 在飞书渲染确认前不用。
- 节点文本避免全角冒号和箭头符号，旧版引擎会报词法错误；用逗号或空格分隔。
- 一张图节点不超过 15 个、消息不超过 12 条；超过就拆图或提升抽象层级。
- 等宽文本块画的时序、调用树、时间线与 mermaid 同为正式形式，设计方可以直接选用；它在本地、GitLab 和飞书三端表现一致，飞书导入时保留为代码块。
- 非文本图（draw.io、图片）只在 mermaid 明显失真时使用，且必须提交可编辑源；不因此引入新的渲染依赖。
- 图中不得包含密钥、token、生产 IP、用户数据。

## 5. 每张图的写法

1. 图前一句说明它回答什么问题和范围。
2. 节点、状态和术语与正文权威名称一致。
3. 图后两三句说明关键决策、不变量、失败分支和容易误读之处，不逐箭头复述。
4. 关键失败语义、兼容约束、数值门槛和决策理由同时存在于正文或表格，不只在图里。
5. 正文变化导致图失真时同一修订更新。

## 6. 校验与交付

交付前运行一次：

```bash
node /home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-design-solution/scripts/check_mermaid.js \
  solution-design/solution.md solution-design/diagrams
```

脚本抽取全部 mermaid 块，默认用 mermaid 8.13.0 和 11 两个版本做 `parse`，再渲染 SVG 和 PNG 到 `diagrams/`，并写 `diagrams/results.md`。它复用 `get-browser-session` 已装好的 Chrome 与 Playwright，不需要新装软件，需要联网加载 mermaid。有图未通过就改到通过，改不好就换等宽文本块；结果表随方案一起提交。

上传飞书时：飞书导入 `.md` 不渲染 mermaid 代码块，只有"文本绘图小组件"渲染。把 `diagrams/D<n>.mmd` 的内容粘进小组件，或直接插入同名 PNG；等宽文本块不需要处理。

## 7. reviewer 检查

- 主图是否存在，或豁免理由是否成立；
- 图是否只回答一个问题，与正文名称是否一致；
- `diagrams/results.md` 是否存在且全部通过；
- 关键语义是否同时在正文里。

缺少必要视图或图与正文矛盾可以形成 finding；不能仅因方案图少判定失败。

## 8. 实践来源

触发条件综合参考 [riekelt/technical-writer 的 diagramming-processes skill](https://github.com/riekelt/technical-writer)（"重述编号列表的图是装饰""一图一问题"）、[SpillwaveSolutions/design-doc-mermaid](https://github.com/SpillwaveSolutions/design-doc-mermaid) 的图型路由、[arc42](https://github.com/arc42/arc42-template) 对运行时视图"选代表性场景而非穷举"的要求、[Kubernetes KEP](https://github.com/kubernetes/enhancements/blob/master/keps/NNNN-kep-template/README.md?plain=1)，以及阿里技术方案写作指引中"大纲图要看到全貌、时序图优于步骤罗列"的做法。飞书行为来自其帮助中心《使用文本绘图小组件》FAQ（2026-02）。

维护或重新评估本规则时再读 `design-basis/diagram-practices-assessment.md`；生成普通业务方案时不要加载该长文。
