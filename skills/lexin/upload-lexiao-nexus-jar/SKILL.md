---
name: upload-lexiao-nexus-jar
description: 在乐效「包管理」把需求分支的 jar 发布到 Nexus：查包、新建上传单、点上传并轮询到上传成功，复用浏览器登录态。Use when 修改了被其他应用按 Maven 坐标依赖的模块（如控制台 service/common、引擎 core/app），需要先把 SNAPSHOT jar 上传到 Nexus 再构建下游应用；用户说“打包”“上传 jar”“新建上传单”“发 jar 到 nexus”；或乐效构建因找不到新版本依赖失败。
metadata:
  version: 1.1.0
---

# upload-lexiao-nexus-jar

## 定位

乐效「包管理 → 包信息管理 → 新建上传单」的命令行版本：给已登记的 jar 包建上传单，触发 `nexus-jar-upload-pipeline-*` 把指定分支的 jar 发到 Nexus，并回读状态。

不做的事：

- 不构建、不部署应用 → `lexiao-deploy`。应用构建（`integration-pipeline-*` / `feature-pipeline-*`）**不会**发布 jar，下游应用在 jar 上传前构建会拿到旧 jar 或因缺版本而失败。
- 不新建包信息、不改包的负责人与关注人（页面「新建包」「修改」）。
- 不发起或处理代码 CR（上传详情页的「CR邀请」）。

## 何时需要上传

修改的模块被其他仓库按 Maven 坐标引用时（例：引擎依赖控制台 `process-engine-console-service`，壳工程依赖引擎 `process-app`），先上传 jar，再构建下游应用。版本号由服务端从分支的 pom 读取，不在上传单里填；改版本号要改 pom 后推送。

## 多个 jar：按依赖分层，层内并行

上传流水线本身也要编译。上游 jar 还不在 Nexus 时，下游上传单会编译失败；更糟的是 Nexus 里已有同版本旧 jar 时会“成功”编进旧代码。所以：

1. **确定依赖：** 下游仓库的 pom 是否按坐标引用上游 artifactId；拿不准时在下游仓库在线执行 `mvn dependency:tree -Dincludes=<groupId:artifactId>`（不要加 `-o`）。
2. **分层：** 同一层内互不依赖；下一层只依赖前面已上传的层。例：第 1 层控制台，第 2 层引擎。
3. **层内并行：** 先对本层每个 jar 依次 `create --apply`，再依次 `upload --no-wait`（点完上传立即释放浏览器 profile），最后 `status --deploy-id=<本层全部ID> --wait` 一次轮询到结束。
4. **层间串行：** 本层全部“上传成功”后才处理下一层；有一个失败就停下，修复后为失败的 jar 新建上传单重传，再继续。
5. 所有 jar 上传完再触发应用构建；应用构建之间不用按 jar 的层次排队。

不加 `--no-wait` 的 `upload` 会在轮询期间（默认最长 1200 秒）一直占用 profile 锁，同一 profile 上的其他命令只能等它结束。

一个仓库通常只登记了根 pom 一个包（例：`process-engine-console-java` id 2418、`process-engine` id 2416），上传根 pom 会发布全部子模块。只有当前账号是包关注人时才能建上传单，否则页面行上只有「权限申请」。

## 用法

脚本：`/home/joney/projects/ai/agent-tools/skills/lexin/upload-lexiao-nexus-jar/scripts/lexiao_nexus_upload.js`

```bash
S=/home/joney/projects/ai/agent-tools/skills/lexin/upload-lexiao-nexus-jar/scripts/lexiao_nexus_upload.js

# 1. 查包，拿 jar_id（按名称模糊匹配，自动翻页）
node $S list --name-like=process-engine-console

# 2. 看这个包以往怎么填（分支、需求 ID、版本、状态）
node $S history --jar-id=2418

# 3. 预览上传单：核对分支存在、分支所属需求、请求体；不提交
node $S create --jar-id=2418 --name-like=process-engine-console \
  --branch=rel_processOwnerAlert_1426731 --demand-id=1426731 --remark='流程决策异常告警按流程通知全部负责人'

# 4. 确认后提交，返回 deployId 并回读校验
node $S create ...同上... --apply

# 5. 点「上传」并轮询到结束（默认最多 1200 秒，--timeout=秒）
node $S upload --deploy-id=133177 --jar-id=2418

# 并行：只点上传、不等待；再一次轮询多张单到结束（有一张不成功则退出码非 0）
node $S upload --deploy-id=133177 --jar-id=2418 --no-wait
node $S status --deploy-id=133177,133180 --wait

# 随时查状态（可多个）
node $S status --deploy-id=133177
```

参数：`--version-type` 默认 `snapshot`（可选 `release`）；`--profile` 默认 `/home/joney/.local/state/agent-tools/browser-profiles/main`；`history` 可加 `--creator=<OA 账号>`。

字段口径：

- `--demand-id` 填乐效需求/版本使用的 7 位 ID（与分支名后缀一致）。预览里的 `demandOfBranch` 是乐效按分支查到的需求，`demandIdMatches=false` 时先核对再提交。
- `--remark` 写本次改动的需求标题，与页面“上传包描述”相同。

## 接口

基址 `https://lexiao-api.oa.fenqile.com/oa`，均在页面上下文内带登录态调用：

| 动作 | 方法 | 端点 | 说明 |
|---|---|---|---|
| 查包 | POST | `/publish/nexus_info_list.json` | `{nameLike, username:'', limit:10, page, ...}`；`username` 留空才能查到别人负责的包 |
| 上传记录 | POST | `/publish/nexus_deploy_list.json` | `{page, limit, jar_id, creator, ...}` |
| 分支列表 | POST | `/publish/gitlab_list_branch_by_jar.json` | `{jar_id}` |
| 分支所属需求 | POST | `/lexiao/get_demand_detail.json` | `{branch_name}` |
| 新建上传单 | POST | `/publish/nexus_deploy_add.json` | 请求体见 `buildAddBody`，返回 `result_rows:[deployId]` |
| 上传单详情 | GET | `/publish/nexus_deploy_get_detail.json?deployId=` | `deploy_status`：`DEPLOY_INIT` 待上传、`DEPLOYING` 上传中、`DEPLOYED` 上传成功 |

「上传」按钮背后的接口未抓取验证，脚本打开 `#/upload-jar/<deployId>/<jarId>` 详情页点按钮。

## 强制约束

- **不经手原始 Cookie。** 用户贴来的 curl 只取端点和请求体结构，不把 `oa_token_id`、`oa_session` 等写进命令、脚本或聊天。
- **先预览再 `--apply`。** 新建上传单会在乐效留下记录；预览确认 jar、分支、需求 ID 后再提交。
- **只点一次上传。** 状态不是 `DEPLOY_INIT` 时脚本拒绝点击；上传中用 `status` 轮询，不要重复点。
- **响应异常不当空集合。** 非 200、`retcode≠0` 或结构异常时脚本直接报错。
- 上传成功后再构建下游应用；构建失败先看是否仍缺上游 jar。

## 失败处理

- 上传状态不是成功：查上传详情页的 jenkins 日志（流水线名见 `pipeline` 字段），常见原因是上游 jar 未上传或分支编译失败。修复后推送并**新建**上传单，不复用失败的单。
- `仓库里没有分支`：先推送分支；Sonar 推送门禁拦截时按门禁结果修复。
- 返回登录页或鉴权错误：用 `get-browser-session` 检查同一 profile 的登录态。
