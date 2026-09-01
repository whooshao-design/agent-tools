# 技术方案图表实践调研与 `dev-design-solution` 借鉴评估

> 状态：Draft<br>
> 评估日期：2026-08-31<br>
> 评估对象：`dev-design-solution`、技术方案核心模板及四类 profile<br>
> 关联方案：`template-system-optimization.md`

## 0. 结论摘要

GitHub 上较成熟的技术提案与架构文档并没有把“必须画几张图”写成质量标准。共同做法是：**正文负责决策和语义，图只用于解释文字难以快速表达的关系；图的类型由要回答的问题决定；图源与文档一起版本化。**

建议把图表能力纳入 `dev-design-solution`，但不要增加新的完整模板，也不要规定每份方案必须画架构图、流程图和时序图。最合适的改造是：

1. 在 skill 中增加“是否需要可视化”的判断门槛；
2. 增加一份按问题选择图型和格式的 `visualization-routing.md`；
3. 默认优先使用 GitHub 原生 Mermaid 的稳定语法；
4. 复杂布局允许使用含可编辑源的 draw.io PNG/SVG；
5. C4/Structurizr/PlantUML 只在仓库已有相应架构建模工具链时复用，不由 skill 默认引入；
6. reviewer 检查“图是否必要、是否正确、是否与正文一致”，而不是检查“有没有图”；
7. Mermaid 校验采用“已有工具则渲染校验、无工具则使用稳定子集并明确未渲染”的渐进策略，不给每次方案生成强加浏览器或 Node 依赖。

现有模板中的“调整后的核心流程只在跨多个组件、状态或并发时序时放一张主图”方向基本正确，但仍有五个缺口：只覆盖了流程图，没有覆盖边界、层级、状态、数据和部署问题；没有说明 Mermaid 与 draw.io 如何选择；没有图文契约；没有兼容性和可访问性约束；没有 reviewer 与自动化验证闭环。

## 1. 调研范围与评价标准

### 1.1 调研对象

本次优先核对 GitHub 上的官方或成熟工程资料：

- GitHub Markdown 的原生图表能力与已知限制；
- Kubernetes Enhancement Proposal（KEP）的模板和真实提案；
- CNCF 的 Design Proposal 模板；
- arc42 的架构文档视图和图源管理方式；
- Structurizr/C4 的 models-as-code 实践；
- draw.io 的可编辑图片存储方式；
- Mermaid CLI 的本地/CI 校验能力；
- 第三方“设计文档 + Mermaid”skill 中可借鉴的路由和验证思想。

这不是按 GitHub Star 数量做工具排名。Star 只能说明关注度，不能证明某种方法适合当前的 Markdown 技术方案生成链路。

### 1.2 评价维度

| 维度 | 核心问题 |
|---|---|
| 表达有效性 | 是否明显降低理解组件关系、运行时序或状态变化的成本 |
| 设计严谨性 | 是否能表达边界、不变量、失败分支和版本窗口，而不只是展示框和箭头 |
| 可维护性 | 图源能否与方案一起修改、审查和回滚 |
| Git 评审体验 | diff 是否可读，reviewer 能否定位一次图表变更的语义 |
| 渲染兼容性 | GitHub 和本地 Markdown 环境能否稳定渲染 |
| 工具成本 | 是否需要额外编辑器、浏览器、Node、Java、Docker或远程服务 |
| 可访问性 | 关键信息能否被屏幕阅读器或纯文本阅读者理解 |
| AI 适配性 | agent 能否可靠生成、修改和验证图源 |

## 2. GitHub 实践中的共性

### 2.1 成熟模板是“文本主导，图按需出现”

CNCF 的 Design Proposal 模板把数据流图、时序图与 API 规格、代码片段并列为 Design Details 中“可能包含”的材料，而不是固定章节或强制交付物；它更强调实现可理解性、兼容性和设计理由。[CNCF Design Proposal Template](https://github.com/cncf/project-template/blob/main/DESIGN-PROPOSALS.md)

Kubernetes KEP 模板同样以 Summary、Motivation、Goals/Non-Goals、Proposal、Risks、Design Details、Test Plan、Upgrade/Downgrade、Alternatives 为主体，没有要求所有 KEP 画固定数量的图。[Kubernetes KEP Template](https://github.com/kubernetes/enhancements/blob/master/keps/NNNN-kep-template/README.md?plain=1)

这说明技术方案质量不能等同于图表数量。缺少图有时是问题，图很多也可能只是把清单换成了框和箭头。

### 2.2 先确定“视角”，再决定是否画图

arc42 把架构信息分为上下文、构建块、运行时和部署等视角，并明确建议只展开重要、意外、高风险、复杂或易变的部分，优先相关性而非完整性。运行时视图也只选具有架构意义的代表性场景，并要求在图后解释交互中的显著事项；部署视图则主要用于分布式系统或基础设施确实影响设计时。[arc42 Markdown 示例中的视图规则](https://github.com/NetworkedAssets/arc42-in-markdown-template/blob/master/2.%20Single%20File%2FArc42%20Template%20in%20Markdown.md)

可借鉴的不是把 arc42 全部章节搬入当前模板，而是两条约束：

- 图必须属于一个明确视角，不能把组件结构、请求时序、部署节点和开发任务混在一张图中；
- 只画对当前决策重要的视角，不追求把系统画全。

### 2.3 真实 KEP 用图回答具体问题

Kubernetes 的 `CompositePodGroup` KEP 使用 Mermaid flowchart 表达三层运行时对象与模板之间的层级关系。文字先说明新 API 为什么形成树，再由图展示父子结构；它没有用流程图替代后续 API、生命周期、校验和兼容性论证。[KEP-6012 CompositePodGroup](https://github.com/kubernetes/enhancements/blob/master/keps/sig-scheduling/6012-composite-podgroup-api/README.md)

`Ensure Secret Pulled Images` KEP 使用两张时序图分别描述“需要重新拉取”和“镜像已存在且可复用凭证记录”的关键场景。图中包含参与者、分支、失败与状态写入，图后继续解释缓存查询的特殊语义和失败安全策略。[KEP-2535 Ensure Secret Pulled Images](https://github.com/kubernetes/enhancements/blob/master/keps/sig-node/2535-ensure-secret-pulled-images/README.md)

这两个例子体现了可复用的图文模式：

1. 先用一段文字定义场景和图要回答的问题；
2. 一张图只表达一个结构或运行时问题；
3. 图后说明关键决策、不变量或容易误读的分支；
4. API 契约、失败语义、风险和验证仍保留文本权威位置。

### 2.4 图源应进入版本控制

GitHub 可以在 Markdown、Issue、Discussion、PR 和 Wiki 中原生渲染 Mermaid fenced code block，也支持直接渲染 `.mmd`/`.mermaid` 文件；GitHub 官方同时建议检查当前使用的 Mermaid 版本，以避免使用不受支持的语法。[GitHub Creating diagrams](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) · [GitHub Mermaid files](https://docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files#displaying-mermaid-files-on-github)

Structurizr 将 C4 模型、视图和文档保存为文本，适合 Git diff、PR 协作和多视图复用；其官方说明也客观承认 diagrams-as-code 的初始学习成本高于拖拽工具。[Structurizr: Why as code](https://github.com/structurizr/structurizr.github.io/blob/main/as-code.md)

arc42 和 draw.io 采用另一种折中：将可编辑图源嵌入 PNG，使用 `.drawio.png` 表明图片既能直接显示，也能重新打开编辑；draw.io 同样支持可编辑 PNG/SVG。[arc42 diagram storage](https://github.com/arc42/arc42-template#diagrams) · [draw.io Embed Diagrams](https://github.com/jgraph/drawio/wiki/Embed-Diagrams)

因此，“图源是否和方案一起保存”应成为硬要求；“是否必须使用文本图”不应成为硬要求。

### 2.5 Mermaid 有真实边界，不能被当作零成本格式

GitHub 官方列出的已知问题包括某些时序图的额外留白、部分交互行为不符合预期，以及并非所有图都满足无障碍要求。[GitHub Mermaid known issues](https://docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files#known-issues)

Mermaid 新语法也有版本边界。例如原生 `architecture-beta` 架构图语法标明需要 Mermaid 11.1.0+；如果 GitHub 当前版本较旧，方案在本地能渲染并不代表 GitHub 能渲染。[Mermaid Architecture Diagrams](https://github.com/mermaid-js/mermaid/blob/develop/docs/syntax/architecture.md)

因此，skill 默认不应追逐 Mermaid 最新图型、图标包和复杂主题。稳定的 `flowchart`、`sequenceDiagram`、`stateDiagram-v2`、`erDiagram` 更适合当前场景，且生成后仍需校验。

### 2.6 第三方 diagram skill 可借鉴“路由和校验”，不宜整体照搬

`design-doc-mermaid` 将不同图型的说明拆成按需加载的参考资料，并提供验证脚本，这是适合 skill 的信息架构：主 skill 保持短小，只在需要特定图时读取相应规则。[design-doc-mermaid](https://github.com/SpillwaveSolutions/design-doc-mermaid)

但其多套完整文档模板、较重的样式规范和更广的工具链不适合直接并入当前 `dev-design-solution`：当前核心问题是防止方案清单化和模板膨胀，不应因为引入图表再形成另一套模板森林。

## 3. 图型应按“评审问题”选择

| 评审者需要回答的问题 | 首选表达 | 何时不应画图 |
|---|---|---|
| 系统边界在哪里，谁负责什么 | 上下文图 / 简化 C4 Context / flowchart | 只有一个调用方和一个被调方时，用两三句话即可 |
| 哪些组件、服务或模块存在静态依赖 | 容器/组件关系图 | 需要精确列出字段、文件或配置映射时改用表格 |
| 请求、事件、重试、补偿按什么顺序发生 | sequence diagram | 单线程且少于几个直线步骤时用编号列表更清楚 |
| 流程在哪些条件下分叉、合并或终止 | flowchart / activity diagram | 只是罗列任务顺序时，不应把开发清单画成流程图 |
| 对象如何在状态间迁移，哪些转换非法 | state diagram | 状态只是展示字段枚举、没有转换规则时用表格 |
| 实体之间的基数和所有权是什么 | ER diagram | 只改少数字段或索引时用 schema diff/表格 |
| 软件部署到哪些节点，网络/故障域如何影响设计 | deployment diagram | 部署拓扑未变化且不影响方案正确性时不画 |
| 现状如何逐步切换到目标状态 | 迁移阶段图 / 前后对照图 | 每个对象的精确处置仍应使用追踪表，而非塞进图中 |
| 多个方案如何比较 | 决策表 | 不使用雷达图、饼图等视觉形式掩盖主观权重 |
| AC、DEC、CHG 如何精确映射 | 追踪矩阵 | 不用关系图替代表格中的一对多精确追踪 |

这里的关键分界是：

- **图擅长关系、顺序、分支、状态、层级和布局；**
- **表格擅长精确映射、比较、责任、参数和追踪；**
- **正文擅长理由、语义、不变量、限制、风险和证据。**

三者互补，不能互相替代。

## 4. 图表格式的客观对比

| 格式 | 主要优势 | 主要缺点 | 对当前 skill 的建议 |
|---|---|---|---|
| Mermaid fenced block | GitHub 原生渲染；文本 diff；agent 易生成与修改；可紧贴正文 | 自动布局可控性有限；复杂图易拥挤；语法和 GitHub 版本存在兼容风险；无障碍并不完整 | **默认选择**，限稳定子集，用于中小型流程、时序、状态、ER 和关系图 |
| 独立 `.mmd` 文件 | 可复用、可单独渲染和校验；正文更短 | 阅读方案时需跨文件；小图拆文件反而增加成本 | 只有图较长、被多处引用或需要 CI 渲染时使用 |
| draw.io 可编辑 PNG/SVG | 手工布局强；适合复杂拓扑、分组和视觉叙事；图片能直接显示并保留编辑源 | 二进制/XML diff 较差；agent 修改和 merge 成本高；容易偏向装饰 | **受控兜底**；只有 Mermaid 明显无法清晰表达时使用，必须保留可编辑源 |
| Structurizr DSL / C4 | 同一模型可生成多视图；抽象层级清晰；文本可审查；适合长期架构模型 | 学习和工具成本较高；对单次局部方案可能过重；GitHub 不直接原生渲染 DSL | 仅当仓库已有 C4/Structurizr 模型时复用，不由方案 skill 默认新建 |
| C4-PlantUML / PlantUML | 架构表达成熟；文本 diff；动态和部署视图较强 | 需要 Java/渲染器或远程 include；GitHub Markdown 不原生渲染；版本和 include 管理有成本 | 仓库既有工具链时复用，否则不作为默认格式。[C4-PlantUML](https://github.com/plantuml-stdlib/C4-PlantUML) |
| 普通 PNG/SVG | 所有 Markdown 阅读器都能显示；布局自由 | 若无源文件不可维护；图片与设计容易漂移；diff 几乎无语义 | 只接受有本地可编辑源且能追踪来源的图片 |
| ASCII 图 | 零渲染依赖；纯文本可读 | 复杂关系扩展性差；中英文宽度和字体可能错位 | 仅用于很小的目录、层级或局部结构 |

### 4.1 推荐的格式优先级

```text
简单关系 → 正文或表格
关系/顺序/状态确实需要图 → Mermaid 稳定子集
Mermaid 因复杂布局而明显失真 → draw.io 可编辑 PNG/SVG
仓库已有架构模型工具链 → 沿用 Structurizr/C4/PlantUML
```

不是所有团队都在 GitHub 阅读方案，所以最终仍应遵循目标仓库已经采用的文档工具链。GitHub 原生能力是默认值，不是覆盖现有约定的理由。

## 5. 建议加入 skill 的“可视化门槛”

### 5.1 应画图的信号

满足任一项，且图能明显降低理解成本时，考虑加入图：

- 一个设计结论同时影响三个及以上参与者、分支或下游；
- 正确性依赖调用顺序、异步回调、重试、补偿、锁或事务边界；
- 存在多个状态和受约束的状态转换；
- 系统边界、父子层级、数据所有权或部署映射仅靠文字容易误解；
- 现状与目标状态的结构性差异是方案核心；
- 评审争议集中在同一关系或流程，文字已反复解释仍难以形成共同模型。

这些是触发信号，不是机械计数门槛。三个参与者的直线调用可能无需画图，两个参与者的复杂重试协议反而非常需要时序图。

### 5.2 不应画图的信号

- 图只是把文件清单、CHG 清单或开发步骤换成节点；
- 图和正文逐句重复，没有新增关系信息；
- 精确字段、配置、差异或追踪关系用表格更清楚；
- 为了满足模板而画与本次设计无关的全系统架构；
- 需要大量颜色、图标和图例才能解释基本语义；
- 图无法保持可编辑源，后续只能重新截图；
- 方案尚未收敛，却用精美图制造“设计已确定”的错觉。

### 5.3 复杂度控制

不建议给节点数设置绝对硬上限，因为节点类型和关系密度差异很大。出现以下任一现象时，应拆图或提升抽象层级：

- 标签必须明显缩小才能放下；
- 多条线交叉，必须沿线追踪才能确认来源；
- 一张图同时出现静态结构、动态时序和部署信息；
- 图例超过主要业务内容；
- reviewer 需要先理解所有实现文件才能看懂图。

拆图时应按问题拆，而不是按页面空间机械切割。例如“正常请求”和“失败补偿”可以是两张时序图；“总体边界”和“组件内部”可以是两个抽象层级。

## 6. 每张图的质量契约

技术方案中的每张图至少满足以下规则：

1. **有明确问题**：标题或前置句说明“这张图用于回答什么”。
2. **单一视角**：一张图只表达边界、静态结构、运行时序、状态、数据关系、部署或迁移中的一种主视角。
3. **术语一致**：节点名与正文、接口、配置和代码中的权威名称一致，不随意使用同义词。
4. **变更可辨识**：需要表达改造范围时，统一使用 `[新增]`、`[修改]`、`[删除]`、`[保持不变]`；颜色只能辅助，不能成为唯一标识。
5. **有相邻解释**：图前定义范围，图后解释关键决策、不变量、失败分支和容易误读之处，不逐箭头复述。
6. **无图也能获知关键语义**：关键失败语义、兼容约束、数值门槛、风险和决策理由必须在正文或表格中出现，不能只藏在图里。
7. **源文件可维护**：Mermaid 源与正文同库；非文本图必须提交可编辑源或使用嵌入源的 `.drawio.png`/`.drawio.svg`。
8. **版本可兼容**：优先 GitHub 当前版本支持的稳定 Mermaid 语法；新图型或实验语法必须实际渲染验证。
9. **可访问**：Mermaid 在目标渲染器支持时添加 `accTitle`/`accDescr`，但由于 GitHub 并非所有图都满足无障碍要求，正文仍需提供等价的关键说明。[Mermaid accessibility support](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/docs/community/new-diagram-jison.md)
10. **无敏感信息**：不把真实密钥、token、生产 IP、用户数据或不应进入方案的内部凭据画入图中。
11. **图文同步**：设计正文、DEC 或 CHG 变化导致图失真时，图必须在同一修订中更新。

建议把 `DEC-*`、`AC-*`、`CHG-*` 当作正文和追踪矩阵的稳定锚点。只在少量关键节点或箭头旁引用这些 ID，不要把完整追踪矩阵塞进图中。

## 7. 与四类技术方案 profile 的映射

| Profile | 首选图型 | 图主要回答什么 | 仍应使用表格/正文的内容 |
|---|---|---|---|
| 机制/架构型 | 上下文/组件关系图、主流程图、关键场景时序图 | 参与者职责、控制/数据流、关键时序、失败恢复 | 接口字段、异常语义、不变量、性能依据、CHG 追踪 |
| 迁移/整改型 | 现状/目标对照图、迁移阶段或切换流程图 | 结构如何改变、阶段如何推进、旧机制何时退出 | 对象盘点、逐项处置、兼容矩阵、扫描结果、回滚清单 |
| 契约演进型 | 生产方/消费方时序图、双版本窗口流程图 | 新旧版本如何共存、发布顺序和失败响应 | schema/API diff、错误码、版本兼容矩阵、废弃条件 |
| 数据/状态型 | 状态图、ER 图、读写/回填时序图 | 合法状态转换、实体关系、事务与迁移路径 | DDL/字段、索引、基数依据、对账规则、容量估算 |

### 7.1 机制/架构型

- 系统边界发生变化时，先考虑一张上下文或组件关系图；边界不变时不要重复画全系统。
- 正确性依赖调用顺序时，时序图通常比“架构框图 + 箭头”更有价值。
- 正常路径和失败补偿差异很大时，可分成两张代表性场景图；不要求穷举所有场景。

### 7.2 迁移/整改型

- 主图应表达“源状态 → 迁移阶段 → 目标状态”，不能把几十个仓库或配置 key 全画入图中。
- 多对象的分类、处置和完成状态继续放在 CHG/对象追踪表。
- 若迁移只是批量替换且运行机制不变，表格可能已经足够，不必为了 profile 强制画图。

### 7.3 契约演进型

- 用时序图表达调用方、旧提供方、新提供方和兼容层在版本窗口中的互动。
- 字段变化、默认值、错误码和向前/向后兼容继续使用契约 diff 与矩阵。
- 只有契约同时改变数据实体关系时才使用 ER 图，不能把 ER 图当 API schema 图。

### 7.4 数据/状态型

- 状态图只画有业务意义的状态与合法转换，不展开成代码分支图。
- ER 图只放影响当前决策的实体、关系和关键属性；Mermaid 官方也建议属性不必穷举。[Mermaid ER Diagram](https://github.com/mermaid-js/mermaid/blob/develop/docs/syntax/entityRelationshipDiagram.md)
- 并发写、双写、回填和失败恢复若是关键风险，另用时序图或文字论证，ER 图不能证明一致性。

## 8. 对 `dev-design-solution` 的具体改造建议

### 8.1 文件结构

在既有“核心模板 + profile + 横切维度”方案上增加一份参考文件，不新增第五类 profile：

```text
skills/dev-workflow/dev-design-solution/
├── SKILL.md
├── agents/openai.yaml
└── references/
    ├── solution-template.md
    ├── template-routing.md
    ├── design-dimensions.md
    ├── visualization-routing.md       # 新增
    └── profiles/
        ├── mechanism-architecture.md
        ├── migration-remediation.md
        ├── contract-evolution.md
        └── data-state-consistency.md
```

不建议把 flowchart、sequence、state、ER 分别做成四份默认加载的大文档。`visualization-routing.md` 先提供短路由和共同质量契约；只有未来确实出现大量稳定语法规则时，再按需拆分参考资料。

### 8.2 `SKILL.md`

在“先给结论，再展开详细设计”中加入：

```markdown
在写图前先判断它要回答的评审问题。仅当关系、顺序、分支、状态、层级或部署映射
用文字/表格难以快速理解时使用图；不得为满足模板固定画图。默认使用 GitHub 兼容的
Mermaid 稳定语法，复杂布局才使用保留可编辑源的图片。图前定义范围和问题，图后解释
关键决策、不变量与失败分支；关键语义不得只存在于图中。
```

结果要求增加：

- 需要图时，图型与问题匹配且可维护；
- 不需要图时，不因缺图降低方案完整性；
- 图、正文、DEC、CHG 和接口术语一致；
- 图表渲染校验结果或未校验原因可见。

### 8.3 核心模板

将固定的“3.5 调整后的核心流程”改为更中性的可选节：

```markdown
### 3.4 推荐方案视图（仅在图能明显降低理解成本时保留）

说明本图要回答的问题和边界。按问题选择上下文、关系、流程、时序、状态、ER、部署
或迁移视图；一张图只保留一个主视角。图后解释关键决策和容易误读之处，不逐箭头复述。
```

同时删除机制轴中“一律放一张改造前后对比图”的要求，改为 profile 按需建议。否则简单机制仍会被强制配图，并产生图文重复。

### 8.4 各 profile

每个 profile 增加三项短说明：

- 优先考虑的图型；
- 不适合用图承载的内容；
- 代表性反例。

这些是生成提示，不复制 Mermaid 语法，也不复制共同质量契约。

### 8.5 `openai.yaml`

入口提示只需要加入“图表按需、按评审问题选择”，不要列所有图型，更不要写“必须包含架构图/流程图/时序图”。入口提示过长会再次把 agent 推向逐项填模板。

### 8.6 `dev-review-solution`

reviewer 增加以下检查：

1. 复杂关系是否因缺少合适视图而难以评审；
2. 已有图是否回答明确问题，而非装饰或开发清单可视化；
3. 图型是否与结构、时序、状态、数据或部署问题匹配；
4. 图与正文、接口、DEC/CHG 是否矛盾；
5. 是否存在只在图中定义的关键语义；
6. 非文本图是否保留可编辑源；
7. Mermaid 是否经过目标环境或兼容版本校验；
8. 颜色是否成为区分变更或状态的唯一方式。

不得仅因“没有图”判定方案不通过。只有当缺图导致关键机制、边界或时序无法可靠评审时，才形成 finding，并明确需要回答的问题，而不是笼统要求“补架构图”。

### 8.7 校验策略

Mermaid 官方 CLI 可以把 `.mmd` 或含 Mermaid fenced block 的 Markdown 转为 SVG/PNG/PDF，适合已有 Node/Docker 工具链的本地或 CI 校验。[mermaid-cli](https://github.com/mermaid-js/mermaid-cli)

建议分两级：

| 级别 | 适用条件 | 校验要求 |
|---|---|---|
| 基础级 | 环境没有 Mermaid 渲染器 | 只使用稳定子集；人工检查 fenced block、图型、节点引用和图文一致性；标记“未做实际渲染” |
| 渲染级 | 仓库已有 `mmdc`、文档构建或容器工具链 | 使用仓库锁定版本渲染所有 Mermaid block；渲染失败阻断方案交付 |

不建议 skill 每次临时执行 `npx` 下载最新版 Mermaid CLI：这会引入网络、依赖、浏览器和版本漂移。更稳妥的做法是复用仓库已有工具，或在后续实施阶段为 `agent-tools` 增加锁定版本的可选验证入口。

## 9. 自动化验收建议

### 9.1 静态契约测试

1. `SKILL.md` 明确“按需使用图”，不存在“每份方案必须包含 N 张图”。
2. 核心模板只有一个可选“推荐方案视图”，不固定要求架构图、流程图和时序图同时出现。
3. 四类 profile 均引用同一 `visualization-routing.md`，不复制共同规则。
4. reviewer 同时检查“缺少必要图”和“存在无效图”，但不把“无图”直接当失败。
5. 规则明确非文本图必须有可编辑源。
6. 规则明确关键语义不得只存在于图中。
7. `openai.yaml` 不包含强制图表数量或新 Mermaid 实验语法。

### 9.2 场景验收

| 场景 | 预期表达 | 反向检查 |
|---|---|---|
| 单文件空指针修复 | 无图，直接进入 DEV 或轻量说明 | 不生成无意义流程图 |
| MQ 重试与补偿机制 | 一张关键时序图，必要时分正常/失败场景 | 幂等与失败语义仍在正文 |
| 跨 8 仓凭证迁移 | 一张迁移阶段或目标机制图 + 对象追踪表 | 不把 59 个位置画成节点 |
| HTTP API v1/v2 演进 | 版本窗口时序图 + 兼容矩阵 | 不用图替代 schema diff |
| 订单状态机改造 | 状态图 + 状态不变量正文 | 不把每个代码 if 分支画成状态 |
| 只新增两个字段和一个索引 | schema diff/表格，无 ER 图 | 不为“数据类 profile”机械画 ER |
| 多区域部署和故障域调整 | 部署图 + 故障/回滚说明 | 不在同图混入请求级详细时序 |

### 9.3 人工评审问题

- 去掉这张图后，哪一项关系会明显更难理解？答不出来，图可能不必要。
- 只看图能否误解关键语义？能，需补相邻文字或调整图。
- 只看正文能否知道决策、失败语义和约束？不能，说明图承担了不应独占的权威事实。
- 本次修改是否能在 Git diff 中看出图的语义变化？不能，需确认非文本图的源与说明是否充分。

## 10. 明确不建议采纳的做法

1. **每份技术方案固定三张图**：会把可视化变成新的填表任务。
2. **强制完整 C4 四层视图**：大多数局部需求不需要 Code/Component 等全套层级。
3. **默认改用 draw.io**：复杂布局更强，但 Git diff、agent 修改和 merge 成本不适合作为默认值。
4. **追求统一云厂商图标和配色**：视觉一致不等于设计正确，并增加渲染和图标依赖。
5. **使用 Mermaid 最新 beta 图型作为默认语法**：GitHub 渲染版本不一定同步。
6. **自动从代码生成目标架构图并直接当设计结论**：代码只能较可靠地辅助还原部分现状，目标架构仍需要设计决策；自动图容易产生虚假的权威感。
7. **把 AC/DEC/CHG 全画成关系网**：精确追踪更适合矩阵，关系网在条目增多后难以审查。
8. **用图替代失败语义和正确性论证**：图能展示路径，不能独立证明幂等、一致性、安全或容量结论。

## 11. 对现有优化方案的增量调整

该结论已作为 `template-system-optimization.md` 的设计决策并落实到 `../visualization-routing.md`：

| DEC | 决策 | 核心依据 | 不采用路径 |
|---|---|---|---|
| DEC-TPL-008 | 可视化按评审问题路由，Mermaid 稳定子集为默认、可编辑 draw.io 为兜底 | 图应提升理解而非增加模板负担；图源需版本化 | 固定图表清单；统一只用 Mermaid；统一只用 draw.io |

并在实施范围中增加：

- 新增 `dev-design-solution/references/visualization-routing.md`；
- 核心模板把“调整后的核心流程”改为可选“推荐方案视图”；
- 四类 profile 增加图型建议与反例；
- reviewer 增加必要性、正确性、图文一致性、源文件和兼容性检查；
- workflow 契约测试增加按需图表规则；
- 如果后续确定 `agent-tools` 需要统一渲染，再单独评估锁定版本的 Mermaid 校验脚本，不在第一阶段强行引入运行时依赖。

## 12. 最终判断

图表能力值得纳入 `dev-design-solution`，但它应是**设计表达路由**，不是第五类模板，也不是新的交付清单。

推荐采用的核心规则是：

> 先确定评审者需要理解的关系，再决定是否画图和画什么图；默认选择可版本化、可审查的最轻格式；图解释关系，正文定义语义，表格承担精确映射。

这套规则既能提升复杂技术方案的直观性，也不会让简单方案变重，更不会把当前的“开发清单化”问题改造成“图表清单化”问题。
