---
name: locate-frontend-page
description: 从后端反查线上前端页面地址：Dubbo 接口（可带 method）、OA 网关 URL 或 MySQL 表，经 OA 网关规则和 rc_fd 前端工程 product 分支里的调用代码，得到可直接在浏览器打开的线上页面地址。Use when 用户问“这个接口/表/网关 URL 在哪个页面用”“对应前端页面地址”“前端哪个目录调用了这个接口”“想在浏览器里看这个功能的页面”等只读反查；前端 URL 查后端实现用 query-oa-gateway-interface。
metadata:
  version: 1.0.0
---

# locate-frontend-page

## 定位

只读反查：后端入口 → OA 网关规则 → 前端调用代码 → 线上页面地址。默认只出线上地址，以 rc_fd 前端工程的 `product` 分支为准。正向查询（前端 URL → 后端实现、VO、SQL）属于 `query-oa-gateway-interface`，不要在这里重复做。

## 用法

```bash
S=/home/joney/projects/ai/agent-tools/skills/lexin/locate-frontend-page/scripts/locate_frontend_page.js
node $S --interface=com.fenqile.rc.mock.service.UserWhitelistCgiService [--method=page]
node $S --url=/rc_oa_gateway/rc_mock/user_whitelist_page        # 也接受带域名的完整 URL
node $S --table=rc_credit_ms_db.t_user_whitelist               # 库名前缀可省
```

三个入口只能给一个。可选参数：`--verify`（用登录态 GET 页面、核对 `<title>`）、`--refresh-projects`（刷新 rc_fd 工程清单缓存）、`--frontend-root`（默认 `/home/joney/projects/frontend`）、`--backend-root`（默认 `/home/joney/projects/backend`）、`--profile`。

输出 JSON 第一段 `summary` 每条线上规则一行：后端方法、前端接口、`pageUrls`、调用位置 `工程@分支:文件:行`。其余字段是证据：`tableTrace`、`nonProdRules`（被排除的非线上规则）、`repos`（clone/fetch 情况与提交号）、`results[].pages[]`（模块、HTML、路由、`notes`）。

## 流程与口径

1. **入口**：
   - 接口：按 `interface_name` 查网关，`--method` 在结果里精确过滤。
   - 网关 URL：先剥掉域名和 query，依次试原样、带前导斜杠、加或去 `rc_oa_gateway/` 前缀，只保留路径完全相同的规则。
   - 表：在本地后端代码里找引用该表的 mapper XML / Java，沿类名引用向上追最多 6 层，取实现了 `dubbo:service` 接口的类。这是名字级启发式：可能多出共用 DAO 的接口，也可能漏掉经 MQ、定时任务或反射调用的链路。结果要按 `tableTrace` 复核，不能当作完整调用方清单。
2. **网关**：只读 POST `query_page_list.json`，带 `Origin`/`Referer`；按 `total_page` 翻页。域名带 `pre`/`stable`/`test`/`dev`/`gray`/`uat` 段的规则放进 `nonProdRules`，不出地址。
3. **前端工程**：
   - 网关域名的首段（如 `hawkeye`）匹配工程名（去掉 `web`、`oa` 和分隔符后比较），精确匹配优先。工程清单来自 GitLab `rc_fd` 组页面，缓存 7 天，位置 `~/.cache/agent-tools/locate-frontend-page/rc_fd-projects.json`。
   - 本地已有的工程只 `git fetch origin product`，不切换分支、不改工作区。
   - 本地没有的工程 `git clone -b product` 到 `/home/joney/projects/frontend/`，单次最多 clone 3 个。没有 `product` 分支时按默认分支 clone，并在 `note` 里写明。
4. **调用代码**：在 `origin/product` 上 `git grep` 网关路径。前端拦截器会统一补 `rc_oa_gateway/` 前缀，所以搜索时去掉它；`.json` 后缀有无两种都搜。命中 `user_whitelist_page_v2` 这类前缀扩展的行会被排除。
5. **页面地址**：
   - 模块：从命中文件往上找最近的 `main.js` 所在目录作为模块。`src/modules/A/B` 对应 `a/b.html`，各段转 kebab-case；`Index` 对应站点根。
   - 路由：命中的若是子组件，沿 import 往上找，直到某个文件被路由文件引用（最多 8 层），取同一路由对象里的 `path`，默认 hash 路由。
   - HTML 命名规则来自共享构建包 `@rc/toss-config`，本地没有它的源码，是按已发布产物（`help.html`、`order-query/index.html`、`interest-free-whitelist-list.html`）核对出来的约定。

## 结果判读

- 回复时把 `summary` 的页面地址放在最前，给出调用位置和分支提交号。网关规则是 `check_auth=1` 时，附上 `resource_sn`，说明打开页面需要该权限。
- `notes` 非空时照实转述：没找到路由时地址只到 HTML；嵌套路由只给了叶子 `path`，要按父路由拼接。
- 默认不访问页面。用户反馈打不开或内容不对时，再加 `--verify` 重跑：`status=200` 且 `titleMatchesTemplate=true` 才说明 HTML 存在；标题对不上通常是落到了站点默认页，说明命名推断错了。仍有疑问再用无头浏览器打开截图。
- 页面有地址，不代表 OA 菜单里有入口；本 skill 查不到菜单挂载位置。
- `results[].note` 写“候选工程里都没搜到”时，说明调用不在已匹配的工程里，或者前端用了拼接 URL。先人工看候选工程，再考虑放宽工程匹配；不要据此断言前端没人调用。

## 失败处理

| 现象 | 处理 |
|---|---|
| `LOGIN_REQUIRED`（网关 16051006） | `node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js --ensure --url=https://gateway.oa.fenqile.com/ --success-text=none` 后重跑 |
| GitLab 工程列表不是 JSON | 同上，把 `--url` 换成 `http://gitlab.fenqile.com/` 登录 GitLab |
| `PROFILE_IN_USE` / 锁超时 | 等其他浏览器脚本结束，不并行跑多个本脚本 |
| `fetch-failed` / `clone-failed` | 报告 `note` 里的 git 错误；内网波动可稍后重试，不要改用其他分支凑结果 |
| 表入口 `unresolved` | 表可能只在其他工作区或其他语言的代码里使用；说明搜索范围是 `--backend-root` |

## 安全边界

- 网关只调查询接口，GitLab 只读组页面；不调用业务接口，也不修改网关规则。
- 浏览器 Cookie 只在 Playwright 进程里使用，不导出、不打印。
- 不对已有前端工作区执行 checkout、reset、pull。
