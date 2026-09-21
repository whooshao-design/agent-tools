# archify 能否提升技术方案画图与可读性：实测评估

评估日期：2026-09-21。对象：tt-a1i/archify v2.17.0-dev.1（commit `29f1ff5`）。方法：用本地真实业务方案《策略节点版本化路由改造》（`archive/remove-strategy-node-equality-check/solution-design/solution.md`）里的两张图，分别用现有 mermaid 链路（`check_mermaid.js`）和 archify 各做一遍，对比产出、修复轮次、可交付形态与阅读效果。产物放在 `/home/joney/docs/agent-tools/archify-pilot/`，两份 HTML 可直接用浏览器打开体验交互。

## 结论

archify 不应替代 mermaid 成为技术方案的画图主线；可以作为"评审会演示"这一种场景的可选补充，不写入 `dev-design-solution` 默认流程。原因不是它画得差（它画得比 mermaid 好看、且能机器校验布局），而是它与本地方案文档的三个硬约束冲突：飞书交付、只读 reviewer 读文本、按图型自动布局的低成本作图。

## 实测过程

| 图 | mermaid 现有链路 | archify |
|---|---|---|
| 目标路由时序图（6 参与者、13 条消息、含 loop 与 alt 三分支） | 26 行文本，自动布局，`check_mermaid.js` 一次通过（mermaid 8.13 与 11 双版本），出 SVG/PNG | 233 行 JSON，手写每条消息的 y 坐标、激活条区间、分段区间和 viewBox；`validate` 3 轮才过（消息间距 <28px、桌面可读性 7px 字号缩放后不足 6px），`deliver` 通过后 `visual-check` 仍报 4 种视口纵向溢出（页面高 1189 > 900），按 skill 要求还需第 5 轮去掉说明卡或压缩布局 |
| edition 隔离运行模型（8 节点、8 条边、1 条禁止边） | 9 行文本，一次通过 | 145 行 JSON，`validate` 4 轮才过：`boundaries.kind` 只有 `region`/`security-group`，没有普通分组，只能删掉 E0/E1 两个分组；网格布局必须显式写 `layout.mode=grid`；`禁止混用` 标签压到节点上要手调 `labelDy`。`visual-check` 通过 |

每轮 validate/deliver 本身不到 1 秒，成本全在 agent 的反复修改上。每次作图要加载 SKILL.md（约 2300 词）加一份 schema、common schema 和一个示例（约 13 KB），遇到几何问题再读 authoring-contract（约 2000 词）；mermaid 只需 `visualization-routing.md` 第 4 节几条规则。

## 表达力对比

- 时序图：mermaid 原生有 `loop`/`alt`/`else` 框，三种互斥分支一眼可见；archify 只有按 y 区间的横向分段和消息变体，我只能用"[节点不存在]"这类标签前缀表达分支，互斥关系变弱。这对本地方案最常用的 `mechanism-architecture` 型时序图是实质损失。
- 架构图：archify 的语义类型（frontend/backend/database/security/messagebus/external）、图例、激活条和路径高亮确实比 mermaid 的方框清楚；但边界只支持云环境语义（region、security-group），业务上常见的"线上/灰度分组""应用边界"无法表达，只能靠布局暗示。
- 前后对照：archify `compare` 需要两份完整 JSON IR；本地做法是一张 `flowchart` 两个 subgraph，成本低一个量级。

## 交付形态

- 本地方案交付面是 Markdown 上传飞书，图用文本绘图小组件贴 mermaid 或插 PNG。archify 产物是 812 KB 自包含 HTML，飞书不能嵌入交互；从 HTML 抽出的内联 SVG 依赖页面 CSS class，单独打开无样式。要得到 PNG 只能用 Chrome 对整页截图（本机 `~/tools/lexiao-browser` 的 Chrome 加 `runtime-libs` 库路径可行，与 `check_mermaid.js` 同一套），截图带工具栏和网格底纹，还得裁剪。
- 只读 reviewer 读的是 `solution.md` 文本。mermaid 文本本身可读；archify JSON 里坐标和几何字段占了一半，reviewer 要在 200 多行 JSON 里找语义。
- 自带更新检查会访问作者站点，需 `ARCHIFY_UPDATE_CHECK_DISABLED=1` 关闭；仓库处于 dev 版本，workflow schema 已从 v1 迁到 v2，跟随成本存在。

## archify 确实更强的地方

- 确定性校验：标签遮挡、连线穿节点、走廊歧义、路由节奏、桌面可读性都由脚本判定并给出修复旋钮，mermaid 只校验语法不校验布局；本地 `check_mermaid.js` 也只做解析和渲染。
- 阅读体验：聚焦、上下游可达、路径高亮、章节演示、深浅主题，对人在评审会上讲解复杂机制有帮助。
- 仓库证据模式：节点可绑定 commit 加行号（GitLab 用 `link_mode: local-only`），和本地"现状要有可复核来源"的原则同向。

## 建议

1. 不引入 archify 到 `dev-design-solution` 主线，也不装进 agent-tools 仓库。`visualization-routing.md` 的"mermaid 稳定子集 + 等宽文本块 + 一张主图"保持不变。
2. 可选场景只有一个：`mechanism-architecture` 型方案进人评审会前，用户明确要演示图时，临时用 `npx skills use tt-a1i/archify@archify --agent codex` 按 `solution.md` 的 mermaid 主图生成一份 HTML 放到 `solution-design/diagrams/`，主图仍以 mermaid 为准，不进 reviewer 输入。
3. 值得借鉴而不必引入工具的两点：把 archify 的"标签不得遮挡节点、连线不得穿过无关节点"写进 `visualization-routing.md` 第 5 节的自检；把"一条主路径、主节点不超过 12 个"的措辞对齐现有"节点不超过 15 个"的规则。已于 2026-09-21 写入 `visualization-routing.md` §4 与 §5 第 6 条（agent-tools 提交 `dev-design-solution: diagram self-check rules from archify assessment`）。

## 附：本次产物

- `archify-pilot/route.sequence.html`、`runtime.architecture.html`：可交互成品；同名 `.json` 为源。
- `archify-pilot/*.visual-check.1440x900.light.png`：archify 浏览器截图。
- `archify-pilot/mermaid-D6-sequence.png`、`mermaid-D1-flowchart.png`：同一内容的 mermaid 渲染，供并排对比。
