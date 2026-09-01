# 技术方案可视化路由

## 1. 先判断图是否有必要

只有关系、顺序、分支、状态、层级或部署映射用短文/表格难以快速理解，且图能降低评审成本时才画图。以下是触发信号，不是机械门槛：

- 正确性依赖异步回调、重试、补偿、锁、事务或发布顺序；
- 存在多个受约束状态和非法转换；
- 系统边界、父子层级、所有权或部署故障域容易误解；
- 现状与目标状态的结构性差异是方案核心；
- 评审争议反复集中在同一关系或流程。

以下情况不画：

- 只是把文件、CHG 或开发步骤换成节点；
- 图与正文逐句重复；
- 精确字段、配置、方案比较或追踪用表格更清楚；
- 为满足模板而画无关的全系统架构；
- 没有可维护图源；
- 方案尚未收敛，图会制造已确定的错觉。

## 2. 按评审问题选择图型

| 需要回答的问题 | 首选表达 | 不画图时的替代 |
|---|---|---|
| 系统边界和职责 | 上下文图 / 简化 C4 / flowchart | 短边界表 |
| 静态组件依赖 | 组件关系图 | 依赖表 |
| 请求、事件、重试、补偿顺序 | `sequenceDiagram` | 编号步骤 |
| 条件分支、合并和终止 | `flowchart` | 条件表或列表 |
| 合法和非法状态转换 | `stateDiagram-v2` | 状态转换表 |
| 实体基数和所有权 | `erDiagram` | schema diff/字段表 |
| 部署节点、网络和故障域 | 部署图 | 节点映射表 |
| 现状分阶段切到目标 | 迁移阶段图 / 前后对照图 | 阶段表 |
| 候选方案比较 | 决策表 | 不使用雷达图等主观视觉权重 |
| AC/DEC/CHG 精确映射 | 追踪矩阵 | 不使用关系图替代精确表格 |

一张图只回答一个主问题，不混合静态结构、动态时序和部署视角。

## 3. 格式选择

优先级：

```text
短文/表格足够 → 不画图
需要中小型关系、时序、状态或 ER 图 → GitHub 兼容 Mermaid 稳定子集
Mermaid 因复杂布局明显失真 → 保留可编辑源的 draw.io PNG/SVG
仓库已有 Structurizr/C4/PlantUML 工具链 → 沿用现有工具链
```

- Mermaid 默认只使用目标渲染器已支持的稳定语法；新图型必须实际渲染验证。
- 非文本图必须提交可编辑源，允许使用含源的 `.drawio.png` / `.drawio.svg`。
- 不因当前仓库没有图表工具链而引入 Java、Node、Docker或远程渲染依赖。

## 4. 每张图的质量契约

1. 图前说明它要回答的问题和范围。
2. 节点、状态和术语与正文权威名称一致。
3. 一张图只保留一个主视角；过密、交叉线多或依赖缩小标签时拆图或提升抽象层级。
4. 需要标记变更时统一使用 `[新增]`、`[修改]`、`[删除]`、`[保持不变]`；颜色只辅助，不能作为唯一语义。
5. 图后解释关键决策、不变量、失败分支和容易误读之处，不逐箭头复述。
6. 关键失败语义、兼容约束、数值门槛和决策理由必须同时存在于正文或表格。
7. 图源与方案同库维护；正文变化导致图失真时同一修订更新。
8. 图中不得包含密钥、token、生产 IP、用户数据或不应进入方案的内部凭据。

## 5. 验证与 reviewer 检查

- 已有渲染工具时执行实际渲染；没有工具时使用稳定子集并明确“未渲染验证”。
- reviewer 检查必要性、正确性、单一视角、图文一致性、可编辑源和渲染兼容性。
- 缺少必要视图或存在误导图可以形成 finding；不能仅因方案无图判定失败。
- 复杂图若无法通过文本 diff 评审，必须同时提供图后关键语义说明。

## 6. 实践来源

本规则综合参考 [GitHub Mermaid 支持](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams)、[Kubernetes KEP 模板](https://github.com/kubernetes/enhancements/blob/master/keps/NNNN-kep-template/README.md?plain=1)、[CNCF Design Proposal](https://github.com/cncf/project-template/blob/main/DESIGN-PROPOSALS.md)、[arc42](https://github.com/arc42/arc42-template)、[Structurizr as code](https://github.com/structurizr/structurizr.github.io/blob/main/as-code.md)和 [draw.io 可编辑图](https://github.com/jgraph/drawio/wiki/Embed-Diagrams)。

维护或重新评估本规则时再读 `design-basis/diagram-practices-assessment.md`；生成普通业务方案时不要加载该长文。
