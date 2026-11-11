---
name: manage-oa-gateway-rule
description: 在 OA 网关控制台（国内 gateway.oa.fenqile.com、墨西哥 fk-gateway.oa.wowcredito.com、印尼 fk-gateway.oa.kredito.id）按一条已有规则做模板，为新的前端 URL 新增路由规则（url → FSOF 接口方法），支持线上与国内项目环境（项目环境把控制台域名映射到本地配置的内网地址），先 dry-run 再写入，写后回读并对运行时网关探活。Use when 新增了米霍克等 OA 页面要调用的 Dubbo/FSOF 网关接口，需要在线上或项目环境网关加路由规则、确认规则是否已生效，或页面请求返回“url 未配置路由规则”（16051005）；只查规则映射和代码链路用 query-oa-gateway-interface。
metadata:
  version: 1.1.0
---

# manage-oa-gateway-rule

## 定位

给新接口加 OA 网关路由规则，并证明它真的生效。只新增，不修改、不删除、不停用已有规则，也不点“同步”（同步按整个系统覆盖 stable，影响面过大）。
查规则映射、追后端实现用 `query-oa-gateway-interface`；反查前端页面用 `locate-frontend-page`。

| 环境 | 控制台怎么访问 | 新增后 |
|---|---|---|
| `prod`（默认） | 直连 `gateway.oa.fenqile.com` | 可能触发审批（`need_approval`）；系统负责人新增时 2026-11-02 实测直接保存 |
| `prj` | 浏览器把 `gateway.oa.fenqile.com` 解析到 `env/credentials.env` 的 `OA_GATEWAY_PRJ_CONSOLE_IP`（`--console-ip` 可覆盖，都没有时报错；用 `bin/with-env` 运行才会载入） | 直接保存；项目环境运行时网关立即可用（2026-11-02 实测） |

同一个系统在两个环境的 `system_id` 不同（米霍克：线上 76、项目环境 72），所以规则一律从同环境的模板规则复制，不手填 `system_id`。

### 站点（`--site`，默认 `cn`）

| `--site` | 别名 | 控制台 | 探活默认域名（米霍克） | 环境 |
|---|---|---|---|---|
| `cn` | `国内`、`china` | `https://gateway.oa.fenqile.com` | `mihawk.oa.fenqile.com` | `prod`、`prj` |
| `mx` | `墨西哥`、`mexico`、`wowcredito` | `https://fk-gateway.oa.wowcredito.com` | `mihawk.oa.wowcredito.com` | 只有 `prod` |
| `id` | `印尼`、`indonesia`、`idn`、`kredito` | `https://fk-gateway.oa.kredito.id` | `mihawk.oa.kredito.id` | 只有 `prod` |

- 三个站点的控制台是各自独立的规则库，接口路径和字段相同；一条规则要在哪个国家生效就在哪个站点新增，模板规则也必须取自同一站点。国内新增不会同步到海外，反之亦然。
- 海外站点没有项目环境，`--site mx|id` 加 `--env prj` 直接报错。
- 用户说“墨西哥/印尼的网关规则”时必须带 `--site`；没说国家时按 `cn`，不要猜。
- 探活默认域名是该站点米霍克规则的 `domain`；其他系统的规则用 `--domain` 传 `query` 结果里的 `domain` 字段。
- 2026-11-11 实测：两个海外控制台用 main profile 的 OA 登录态可以查询（登录 Cookie `rog_session` 分别种在 `.wowcredito.com`、`.kredito.id`）；米霍克 `EditionDiffGatewayService` 在墨西哥、印尼各有 14 条规则，`system_id` 都是 76。墨西哥首次查询出现过一次 `16051032 请求跨域了`，重跑即正常。海外站点的 `add --apply`（真实写入与审批流）没有实测过，首次使用先 dry-run，并把结果告诉用户。

## 用法

脚本：`scripts/oa_gateway_rule.js`（复用 `get-browser-session` 的 main profile，请求在已登录的控制台页面内发出，Cookie 不导出）。

```bash
S=scripts/oa_gateway_rule.js

# 1. 查：按 url（精确匹配）或接口 + 方法
$AGENT_TOOLS_ROOT/bin/with-env node $S query --env prj --url hawk_decision/manage/diff/diff_strategy_rule_text.json
node $S query --env prod --interface com.fenqile.rc_comm.hawk.decision.manage.service.gateway.diff.EditionDiffGatewayService

# 2. 新增：默认 dry-run，只打印模板和将提交的 payload
node $S add --env prod \
  --template-url hawk_decision/manage/diff/diff_strategy_node.json \
  --url hawk_decision/manage/diff/diff_strategy_rule_text.json --method diffStrategyRuleText \
  --timeout 15000 --url-manager joneyshao --func-desc "节点版本比对-规则代码差异对比"
#    确认后加 --apply；线上需要审批时再加 --apply-reason "<理由>"
#    海外站点：加 --site，模板规则取自同一站点
node $S query --site mx --url hawk_decision/manage/diff/diff_strategy_node.json
node $S add --site id --template-url hawk_decision/manage/diff/diff_strategy_node.json \
  --url hawk_decision/manage/diff/diff_strategy_rule_text.json --method diffStrategyRuleText --url-manager <min>
# 3. 运行时探活：prod 走真实域名，prj 要给项目环境网关机 IP；海外加 --site
node $S probe --env prod --url hawk_decision/manage/diff/diff_strategy_rule_text.json
node $S probe --env prj --probe-ip <项目环境网关机IP> --url hawk_decision/manage/diff/diff_strategy_rule_text.json
node $S probe --site mx --url hawk_decision/manage/diff/diff_strategy_node.json
```

`add` 参数：`--template-url`（同环境已存在且唯一的规则）、`--url`、`--method`、`--url-manager` 必填；`--interface` 换接口时用（与模板不同时必须同时给 `--lsf-app` 提供方应用名），默认沿用模板；`--timeout`（毫秒）、`--check-auth 0|1` 默认沿用模板；`--func-desc` 写接口用途。url 可写 `hawk/x.json`、`/rc_oa_gateway/hawk/x.json` 或完整地址，统一规范为 `/rc_oa_gateway/...`。

## 执行要求

1. 写入前先 dry-run，把 `payload`（重点：`url`、`interface_name`、`method`、`interface_version`、`lsf_app_name`、`method_time_out`、`check_auth`）给用户确认；用户已明确给出这些值并授权写入时可直接 `--apply`。
2. 线上新增属于线上配置变更：只在用户明确要求线上新增时执行。规则在接口上线前生效没有调用方，但会把该 URL 路由到线上尚不存在的方法，前端上线前不要让页面调用它。
3. `add` 的结果 `outcome`：
   - `dry-run`：未写入。
   - `exists`：同 url 已有规则，未写入；需要改值时到控制台页面人工修改。
   - `saved`：已直接保存并回读到；`saved-not-found` 表示接口成功但回读不到，停下来到控制台核对，不要重跑。
   - `approval-required`：控制台要求审批且需要理由，未保存；补 `--apply-reason` 重跑。
   - `approval-submitted`：已提交审批（`approvalProcess` 是审批流），审批通过后再 `query` 确认。
4. 写入后必须 `probe`：`routed: true`（如未登录的 `16051006`；印尼运行时网关未登录返回的是 `16510008`）说明运行时网关已识别该 URL；`routed: false`（`16051005` url 未配置路由规则，三个站点相同）说明未生效。

## 已知行为（2026-11-02 实测）

- 控制台新增接口是 `url_interface_rule/add_with_approval.json`（JSON 体）。返回 `result_rows` 为空或 `need_approval=false` 即已保存；`need_approval=true` 时什么都没保存，控制台会再带 `apply_reason`、`out_net_reason` 调用同一接口提交审批，脚本照此实现。
- 项目环境控制台的查询免登录，写入要登录；main profile 的 OA 登录态打开控制台首页后即可写入。
- WSL 里的 `ALL_PROXY` 会让到项目环境控制台地址的 TLS 握手失败（curl exit 35）；脚本经 `get-browser-session` 的网络层去掉全部代理变量。
- 控制台登录 Cookie `rog_session` 约每天过期，脚本每次先打开控制台首页让 SSO 续期；仍报 `LOGIN_REQUIRED` 时执行 `node $AGENT_TOOLS_ROOT/skills/lexin/get-browser-session/scripts/browser_session.js --ensure --url=https://gateway.oa.fenqile.com/ --success-text=none`（海外站点把 url 换成该站点的控制台地址，三个站点的登录 Cookie 互不通用）。
- profile 被占用（`profile is busy`）时等其他浏览器脚本结束，不并行运行。

## 输出

报告站点、环境、模板规则、新规则的关键字段、`outcome`、回读结果和探活结果（`via`、`retcode`）；审批场景附审批流。不输出 Cookie、token 或登录跳转票据。
