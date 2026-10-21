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

## 4. 可读性自查

编码后在主文件的简化回看之外，再检查：

- 模板里是否有多重三元、长条件或链式调用，能否抽成 `computed`
- 方法里是否有可以由 `computed`/`watch` 声明式表达的状态同步
- 是否引入了仓库里没有的新模式、新依赖或新的组件版本；若有，理由是否已写进开发记录
- 是否破坏了组件分层约定（如 Page 负责路由和请求、Component 只做呈现）

## 5. 验证

- 最低要求：改动的 `.vue` 能通过模板编译（如 `vue-template-compiler` 的 `compile` 无错误），脚本能通过语法检查；仓库有 lint/type-check/test 脚本时一并执行。
- 资源允许时必须启动本地 dev server（以启动工具的资源门禁为准，例如 `start-local-frontend doctor` 全绿），确认 webpack/vite 编译通过且无新增报错。web_mihawk_oa 使用 `start-local-frontend`：先 `doctor` 过资源门禁，再 `start`，等 webpack 明确报告编译完成。
- 能在浏览器里复现的交互，用浏览器自动化截图留证，做法参考 `verify-browser-qa`。
- 需要真实后端或登录态的交互，如果 agent 拿不到环境登录态（例如项目环境 OA 网关不认自动化浏览器 profile），不要转发 Cookie 绕过。在开发结果里把它列为用户验收项，写清入口 URL、操作步骤和预期结果。
- 验证阶段的路由见 `dev-verify-change` 的 `references/test-execution-routing.md`“前端验证”小节。

## 6. 前后端契约与发布

- 写清字段命名映射，例如网关或接口层做驼峰与下划线转换、前端统一用 snake_case；新增或改名字段时前后端两侧要一致。
- 评估新旧前后端组合：新前端 + 旧后端、旧前端 + 新后端是否都能工作，并给出发布顺序及风险，写进开发结果和发布计划作为提醒（发布顺序靠发布安排保证，不靠改代码）。
- 前后端产物各写各的：前端发布计划、配置和验收项只写前端内容，后端配置（如 Hippo）写在后端产物里。

## 参考来源

以下条目经改写后并入本文，未整包引入：

- 箭头函数与按实例创建防抖：vuejs-ai/skills 的 `vue-options-api-best-practices`，<https://github.com/vuejs-ai/skills>
- 破坏性操作确认、提交中状态、错误提示给出下一步：Vercel Web Interface Guidelines，<https://github.com/vercel-labs/web-interface-guidelines>
- `v-html` 与 URL 绑定的注入风险：Vue 2 官方安全指南，<https://v2.vuejs.org/v2/guide/security.html>
