---
name: verify-browser-qa
description: Use when 需要对页面、浏览器交互或部署结果做专项验收，并收集可视化证据，但这类检查不是本次验证的日常主入口。
metadata:
  version: 1.2.0
---

# verify-browser-qa

## 定位

用于作为 `dev-verify-change` 的浏览器 / 页面专项增强，承接低频但明确存在的验收场景。

它只在浏览器、页面或部署验收时显式调用，重点是页面验证、交互检查、截图与证据收集，不替代日常代码验证主流程。

默认不作为通用主入口；仅在 `dev-verify-change` 判断需要页面专项验收，或用户明确点名浏览器 QA 时使用。

## When to Use

适合以下场景：
- 代码改动已经完成，需要确认页面是否真的按预期展示或交互
- 需要验证部署结果，确认线上、预发或本地页面是否可打开、可操作、无明显报错
- 需要检查按钮、表单、弹窗、跳转、登录后页面等真实浏览器行为
- 需要补充截图、页面状态、控制台报错、网络失败等可交付证据
- `dev-verify-change` 已判断需要页面专项验收，或用户明确要求做浏览器 QA

不适合以下场景：
- 只是做日常主验证，此时优先使用 `dev-verify-change`
- 当前仍在理解需求、设计方案或修改代码
- 只需要单元测试、接口测试、构建检查或覆盖率验证
- 想把它当成通用测试手册或所有验证任务的默认入口

## 专项职责

该 skill 只关注浏览器 / 页面侧的专项确认，例如：
- 页面是否成功加载，关键区域是否可见
- 关键交互是否可点、可填、可提交、可关闭、可跳转
- 部署后是否出现白屏、明显样式错乱、资源失败或前端报错
- 变更是否真实反映到用户可见行为上
- 是否拿到了足以支持结论的截图或页面证据

## 使用边界

使用时保持以下边界：
- 仅在浏览器、页面或部署验收时显式调用
- 只做页面专项增强，不承担主验证编排职责
- 先围绕本次改动相关页面验证，不默认扩展成整站巡检
- 重点给出是否通过、失败点在哪、证据是什么
- 不把正文写成大而全的浏览器测试手册

## 与 `dev-verify-change` 的关系

两者关系必须明确：
- `dev-verify-change` 是验证阶段主入口，先决定本次变更需要哪些最小验证
- `verify-browser-qa` 只在需要浏览器 / 页面专项确认时补充介入
- 它增强的是页面验收能力，不替代主验证阶段的范围判断与结论收敛
- 若页面专项已完成，验证结论仍应回收到 `dev-verify-change` 的整体结果中

## 本地执行入口

- 本地或公开页面可用 Microsoft `playwright-cli`，先读 `playwright-cli --help` 与 `playwright-cli --help open`。
  使用独立命名会话 `-s=<task>`；结束时只关闭该会话，不调用影响其他任务的 `close-all` / `kill-all`。
- 公司内网登录页继续使用 `get-browser-session` 的 profile、直连策略与凭据保护；不要把登录态复制到通用 CLI 或复用正在占用的 profile。
- CLI 可执行任意页面操作，不代表只读或已获业务写权限。提交、发布、删除等仍以本次用户授权为界。
- 已有项目 Playwright 测试优先复用；CLI 用于探索与复现，不能把一次点击成功当成完整端到端回归。

## 视觉自检：ui_check.js

页面改动（弹窗、表单、表格、按钮区）在交付前用 `ui_check.js` 量一遍，再看截图。它用一个全新的无头 Chromium（不读已保存的登录 profile，强制直连），按场景文件把接口请求改写到本地 dev server 或返回模拟 JSON，执行步骤打开要检查的界面，然后在每个视口测量目标元素并截图：

```bash
node /home/joney/projects/ai/agent-tools/skills/dev-quality/verify-browser-qa/scripts/ui_check.js \
  --scenario=<scenario.json> [--out=<截图目录>]
```

- 场景文件字段：`url`、`target`（要测量的元素选择器）、`steps`（`wait` / `waitFor` / `click` / `fill` / `css` / `eval`）、`rewrite`、`mocks`、`passthrough`、`defaultMock`、`cookies`、`sessionStorage`、`localStorage`、`viewports`（默认 1366x768 和 1920x1080）、`check`（`minPadding` 默认 12、`maxLeftEdges` 默认 3、`alignTolerance` 默认 2、`ignore` 选择器、`align` 图标与文字配对）。`extends` 指向基础场景，本场景的数组排在基础场景之前，所以同一个接口以本场景的 mock 为准。
- 请求的处理顺序：`rewrite` → `mocks` → `passthrough` → `defaultMock`，都不匹配就拦截。输出里的 `unmatchedRequests` 列出被 `defaultMock` 兜底的接口；页面显示不对时先给这些接口补 mock。
- 检查项与级别：`fail` 有 `cramped`（按钮或文字块离目标元素边框小于 `minPadding`）、`overlap`（按钮、文字块互相重叠）、`clipped`（`overflow: hidden/clip` 的元素里有内容被裁掉）；`warn` 有 `button-height`（同一行按钮高度差超过 2px）、`primary-count`（主按钮多于 1 个）、`left-edges`（文字块的左边线多于 `maxLeftEdges` 条）、`align`（图标中心与配对文字首行中心相差超过 `alignTolerance`）。有 `fail` 时退出码为 1，无法运行时为 2。
- 截图写到 `--out`；不传时写到 `<系统临时目录>/agent-tools-ui-check/<场景文件名>/`，每次覆盖。量完必须打开 `target-*.png` 看一遍：测量只覆盖上面这些项，配色、层级、文案仍要靠看图判断。
- 米霍克 OA 的基础场景和示例在 `start-local-frontend` 的 `references/ui-check/`。其他项目照同样字段写自己的基础场景。
- 用 `css` 步骤可以把怀疑的样式注入回去，确认检查会失败，用来证明一次修复确实被检查覆盖。

## 关注证据

输出应偏证据化，优先保留：
- 页面是否加载成功的直接证据
- 关键交互前后的页面状态
- 控制台错误、请求失败或异常提示
- 截图、页面文本、可见性检查等能支撑结论的材料

## 调用提示

调用时应保持轻量收敛：
- 先锁定本次改动最相关的页面或交互，再开始检查
- 先拿到能支撑结论的关键证据，再决定是否补更多页面
- 若问题已超出页面专项范围，及时回交主验证或开发阶段

## 结果要求

一次合格的浏览器 QA 结果应满足：
- 明确说明验证了哪个页面、哪段交互或哪个部署结果
- 明确说明通过、失败或仍有风险的点
- 结论建立在页面证据之上，而不是主观描述
- 结果保持轻量，不展开成长篇测试文档

## 交接建议

- 页面专项通过后，把结论回交 `dev-verify-change` 统一收口
- 若发现问题在实现本身，回到 `dev-build-change` 修正
- 若只是主验证尚未做，不要跳过 `dev-verify-change` 直接把它当主入口
