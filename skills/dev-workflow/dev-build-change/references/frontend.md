# 前端开发细则

写集含 `.vue`、`.js`、`.jsx`、`.ts`、`.tsx`、`.scss`、`.less`、`.css`、`.html` 模板，或文件位于前端仓库时读取本文件。阶段流程、DEV 清单和简洁性要求仍以主文件为准；本文只补前端特有的做法。示例取自米霍克 OA 前端 `/home/joney/projects/frontend/web_mihawk_oa`（Vue 2 + Element UI 2.15 + 自研 `@rc/toss-vui`），规则同样适用于其他 Vue 2/3 或 React 仓库。

## 1. 编码前必读

- 读目标仓库及沿途的 `AGENTS.md`，再读仓库的编码规范文件：`CLAUDE.md`、`.cursor/rules`、`.eslintrc*`、`.prettierrc*`、`.editorconfig`、`tsconfig.json` 中实际存在的那些。`AGENTS.md` 说明某个文件是写法规范时（如 web_mihawk_oa 的 `CLAUDE.md`），按规范执行，不能只当背景资料。
- 从 `package.json` 和锁文件记下框架、组件库、内部组件库的版本，例如 `vue@2`、`element-ui@2.15.14`、`@rc/toss-vui`。查组件 API 时按这个版本查，不套用 Vue 3、Element Plus 或新版 React 的写法。
- 确认仓库实际有哪些检查入口（`lint`、`test`、`type-check` 脚本），以及本地怎样启动。没有的脚本不要臆造；web_mihawk_oa 没有 lint/test 脚本，本地启动用 `start-local-frontend`。
- 编码前判断 agent 能否拿到页面所需的登录态和后端环境。拿不到时在开发清单里提前写明哪些检查要交给用户验收，不要等到验证阶段才发现。

## 2. 组件惯例普查

要做弹窗、确认框、表单、表格、提示、下拉、分页等 UI 时，先统计仓库里同类 UI 的现有实现和使用次数，再决定写法：

```bash
rg -l "CustomMessageBox|\$confirm|el-dialog|Modal" src | wc -l    # 各写法分别计数
rg -n "import .*CustomMessageBox" src                              # 找具体用例，读一两个
```

选型优先级如下：

1. 项目自己封装的组件，如 `src/modules/_layout/*`、`src/components/*`、内部组件库 `@rc/toss-vui`
2. 组件库组件的模板用法，如 `<el-dialog>`
3. 组件库的命令式 API，如 `this.$confirm`、`this.$message`，仅用于仓库同类场景已经这样用的简单提示

不手写 render 函数、`$createElement`/`h()` 拼 VNode，除非仓库同类代码已经这样写，或模板确实无法实现。同一组件存在多个版本并存时（如 `components/Modal/1.0.0` 与 `1.0.2`），跟随所在文件已用的版本。

把选型理由写进开发记录，例如“复用 `_layout/CustomMessageBox.vue`，仓库 13 处在用；未用 `$confirm` + VNode”。

反例：需求 packageCopySupportRealTimeQuery 中，确认弹窗最初用 `$createElement` 拼 VNode 再调 `this.$confirm`，而仓库已有十余处使用 `CustomMessageBox`，后来只能重构成模板写法。根因是编码前只读了要改的文件，没有普查同类 UI。

## 3. 写法

- 模板优先。弹窗、提示等内容的显隐和文案状态放在 `data`/`computed`，不在方法里临时拼 DOM。
- 方法职责单一。按团队规范写注释，例如规范要求 JSDoc 时，新增方法写 JSDoc。
- Options API 的 `methods` 和生命周期钩子不用箭头函数，否则会丢失组件实例 `this`；防抖或节流函数在 `created` 里按实例创建，不在 `methods` 定义处直接包装，否则多个实例会共用同一个计时器。
- import 顺序和 alias 跟随规范（如第三方 → `@/` → 相对路径 → 样式）。与同文件现有风格冲突时以同文件为准，避免同一文件出现两种风格，并在开发记录里说明原因。
- 接口调用放进仓库约定的 api 层（如 `src/modules/Index/api/<域>/index.js`），不在组件里新写散落的 URL。
- 文案、后端返回值和外部配置按纯文本插值渲染（`{{ }}`、`textContent`）。不用 `v-html`、`innerHTML`、`dangerouslySetInnerHTML` 渲染不可信内容；确需渲染富文本时，复用仓库已有的净化方式（如 `dompurify`）；`:href`/`:src` 不绑定未校验的外部 URL，防止 `javascript:` 链接。
- 删除、覆盖、发布等破坏性操作要有确认步骤；提交按钮在请求进行中禁用或显示 loading，防止重复提交；失败提示说明下一步怎么做，不只显示“失败”。

## 4. 版式与样式

B 端后台的版式目标是“和仓库里同类界面一样、和组件库默认值一致”，不追求独特视觉。下面的数值来自组件库源码，写样式前先查目标仓库实际用的组件和版本。

- 间距用组件库已有的值，不另起刻度。Element UI 2.15 的默认值（`packages/theme-chalk/src/`）：`el-dialog` 的 header `20px 20px 10px`、body `30px 20px`、footer `10px 20px 20px`；`el-message-box` 的 header `15px 15px 10px`、content `10px 15px`、按钮区 `5px 15px 0`；相邻按钮 `.el-button + .el-button { margin-left: 10px }`。自研组件以其源码为准，例如 `@rc/toss-vui` 的 `components/Modal/1.0.0/style.css` 中 `.modal-body`、`.modal-footer` 都是 `padding: 15px`。新写的容器内边距不小于这些默认值；Ant Design 一类按 8px 基数（8、16、24）取值的库照它的刻度。
- 按钮区：右对齐，取消在左、主操作在右；一个按钮区只放一个主按钮（`btn-primary` / `el-button--primary`）；按钮文案写出动作和对象，如“确认复制”，不用笼统的“确定”；同一行按钮等高。
- 图标与标题并排：父元素用 `display: flex; align-items: flex-start`，图标的 `margin-top` 取 `(标题行高 - 图标高度) / 2`，图标与文字间距 12px 左右；正文与标题左边线对齐。不要靠栅格列宽（如 `col-2` / `col-22`）碰运气对齐。
- 状态齐全：加载中（按钮显示 loading 并保留原文案）、空列表（说明为什么空、下一步做什么）、失败（说明原因和怎么处理）、长文本（换行或截断，截断时能看到全文）。
- 样式泄漏：改动所在组件或其父组件有 `/deep/`、`>>>`、`::v-deep` 的全局覆盖（尤其带 `!important`）时，它会命中渲染在这个组件 DOM 内的所有子组件，包括新嵌进去的弹窗。新增嵌套弹窗前先 `rg -n "/deep/|>>>|::v-deep" <组件文件及其 @import 的样式>`，确认覆盖范围；处理方式按仓库已有做法选一种：把弹窗挂到 `body`（Element 的 `append-to-body`），把父级覆盖收窄到父级自己的类名，或给子弹窗加类名后恢复组件默认值。
  - 反例：需求 packageCopySupportRealTimeQuery 中，`appEditor.vue` 引入的 `modal.scss` 有 `/deep/ .modal-body { padding: 4px 0 0 0 !important }`，把嵌在里面的“乐包复制提醒”弹窗的内边距也清成 0，两个按钮贴着弹窗边框，直到发到 pre 才被用户发现。修复是给提醒弹窗加 `copy-confirm-modal` 类并恢复 `padding: 15px`。
- 不改公共组件或全局样式去修一个页面的问题；修改范围限定在本页面的类名下。

参考来源（经改写并入）：Element UI 2.15 主题源码 <https://github.com/ElemeFE/element/tree/dev/packages/theme-chalk/src>；Ant Design 设计价值观与间距规范 <https://ant.design/docs/spec/values-cn>；pbakaus/impeccable 的 polish 分类与 `cramped-padding` 规则 <https://github.com/pbakaus/impeccable>；Leonxlnx/taste-skill 的“截图 + DOM 测量”自检 <https://github.com/Leonxlnx/taste-skill>。

## 5. 可读性自查

编码后在主文件的简化回看之外，再检查：

- 模板里是否有多重三元、长条件或链式调用，能否抽成 `computed`
- 方法里是否有可以由 `computed`/`watch` 声明式表达的状态同步
- 是否引入了仓库里没有的新模式、新依赖或新的组件版本；若有，理由是否已写进开发记录
- 是否破坏了组件分层约定（如 Page 负责路由和请求、Component 只做呈现）

## 6. 验证

- 最低要求：改动的 `.vue` 能通过模板编译（如 `vue-template-compiler` 的 `compile` 无错误），脚本能通过语法检查；仓库有 lint/type-check/test 脚本时一并执行。
- 资源允许时必须启动本地 dev server（以启动工具的资源门禁为准，例如 `start-local-frontend doctor` 全绿），确认 webpack/vite 编译通过且无新增报错。web_mihawk_oa 使用 `start-local-frontend`：先 `doctor` 过资源门禁，再 `start`，等 webpack 明确报告编译完成。
- 改动了页面上可见的界面（弹窗、表单、表格、按钮区、提示）时，交付前必须跑 `verify-browser-qa` 的 `ui_check.js`：用模拟接口在本地渲染出改动的界面，`status` 不能是 `fail`，`warn` 逐条判断并在开发记录里说明保留理由；然后打开 `target-*.png` 截图看一遍，看过才算完成。米霍克用 `start-local-frontend` 的 `references/ui-check/` 基础场景，不需要登录。把截图路径和 `ui_check` 结论写进开发结果。
- 能在浏览器里复现的交互，用浏览器自动化截图留证，做法参考 `verify-browser-qa`。
- 需要真实后端或登录态的交互，如果 agent 拿不到环境登录态（例如项目环境 OA 网关不认自动化浏览器 profile），不要转发 Cookie 绕过。在开发结果里把它列为用户验收项，写清入口 URL、操作步骤和预期结果。
- 验证阶段的路由见 `dev-verify-change` 的 `references/test-execution-routing.md`“前端验证”小节。

## 7. 前后端契约与发布

- 写清字段命名映射，例如网关或接口层做驼峰与下划线转换、前端统一用 snake_case；新增或改名字段时前后端两侧要一致。
- 评估新旧前后端组合：新前端 + 旧后端、旧前端 + 新后端是否都能工作，并给出发布顺序及风险，写进开发结果和发布计划作为提醒（发布顺序靠发布安排保证，不靠改代码）。
- 前后端产物各写各的：前端发布计划、配置和验收项只写前端内容，后端配置（如 Hippo）写在后端产物里。

## 参考来源

以下条目经改写后并入本文，未整包引入：

- 箭头函数与按实例创建防抖：vuejs-ai/skills 的 `vue-options-api-best-practices`，<https://github.com/vuejs-ai/skills>
- 破坏性操作确认、提交中状态、错误提示给出下一步：Vercel Web Interface Guidelines，<https://github.com/vercel-labs/web-interface-guidelines>
- `v-html` 与 URL 绑定的注入风险：Vue 2 官方安全指南，<https://v2.vuejs.org/v2/guide/security.html>
