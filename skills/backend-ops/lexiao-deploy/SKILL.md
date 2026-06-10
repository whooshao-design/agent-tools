---
name: lexiao-deploy
description: 乐效中部署和验收应用的流程技能。Use when Codex needs to open a Lexiao demand/version page, integrate branches, build an application, create or reuse a pre-release/gray publish order, deploy a project-environment artifact, or deploy exactly one pre-release/gray target with VM/KVM priority, then verify publish status, pipeline/artifact health, publish logs, target-server logs, and triage errors with next-step choices. Supports 项目环境/prj、预发布单机、显式灰度单目标 deployment; reserve OA、线上 rollout paths for future extension.
version: 1.0.0
---

# Lexiao Deploy

## 工具优先级

已注册 `lexiao` MCP 时，优先使用其工具完成本 skill 的查询与操作；MCP 不可用或未注册时，再按下文的脚本/HTTP 方式兜底。两者底层能力一致。


## Scope

Use this skill to deploy applications from Lexiao demand/version pages and verify the rollout. Supported flows:

- `项目环境` / `PROJECT` / `prj` deployment.
- `预发布` single-machine deployment when the user asks to deploy one machine or specifically mentions pre-release machines. Prefer virtual-machine/KVM targets; only deploy a container target when no VM/KVM target exists or the user explicitly asks for container.
- Full pre-release redeploy after code changes: branch integration, build, wait for artifact, create the correct publish order, deploy one VM/KVM, verify page/API and server logs, then triage errors and offer next-step choices.
- `灰度` deployment when explicitly requested by the user: skip branch integration and build, then otherwise follow the same publish-order, one-target-per-app, log-first verification, and sequential error gate used for pre-release.

When the user names multiple applications, build all target applications together after branch integration; build does not need to follow the Lexiao `发布顺序`. After triggering builds, check every target application's build and artifact result before opening any publish order. Only the publish/deploy/log-verification phase is sorted by `发布顺序` and operated in publish-order batches from the smallest value to the largest. Applications with the same `发布顺序` may be deployed and verified in parallel, for example by assigning one application per subagent or running independent status/log checks concurrently. For each application, deploy exactly one target by default, verify logs, and report the result. Do not deploy all machines of one app unless the user explicitly asks for all machines.

Sequential publish gate: do not start a later publish-order batch until every application in the current publish-order batch has completed log-first verification. If any application in the current batch fails, becomes ambiguous, or produces new deployment-window ERROR/Exception logs, first evaluate the error evidence and classify it as blocking, non-blocking, or unrelated. Continue to later publish-order apps only when the entire current batch is healthy or the user explicitly accepts the assessed risk.

Do not apply the project-environment or pre-release single-machine flow to `OA` or `线上`. For those environments, read the page and stop before deploy, then ask for the environment-specific publish procedure, approval constraints, rollout strategy, log targets, and rollback criteria.

## Inputs

Extract and report these fields before deployment:

- Lexiao URL, version ID, demand ID, demand name, online date when visible.
- Target app name and project name. Match exact row text; do not rely on button order alone.
- Environment IP, `GROUP`/SET, branch, developer, branch status, pipeline status, artifact status, deploy status, CR status.
- For pre-release: publish order ID, app ID, version tag, deployment type, selected machine IP, machine publish status, machine run status, and whether VM/KVM or container was selected.

If multiple app rows match or the target app is not explicit, ask for the app name before clicking anything.

## Click Safety

Lexiao pages often repeat the same buttons (`构建`, `部署详情`, `发布单`, `流水线详情`, `部署`) for every app and machine row.

- Use generic text click helpers only for unique page-level controls.
- For repeated row buttons, use Playwright/DOM logic scoped to the row containing the exact app name, machine IP, publish order, or container deployment ID.
- Before clicking deployment controls, capture the target row text and button states.
- Never click `批量部署`, `批量回滚`, `确认执行灰度发布`, or any higher-environment control unless the user explicitly asked for that exact action and the corresponding flow is supported.
- If the page says `当前环境：线上` but the version tabs include `预发布/灰度/OA/线上`, use the selected publish tab/API `env` as the deployment environment. Do not infer target environment from the global header alone.

## Full Pre-Release Redeploy Flow

Use this sequence when the user says code changed and asks for a more complete pre-release redeploy:

Default deploy semantics: when the user says `部署`, treat it as "deploy the latest code". Even if an app row currently shows `已发布`, still run branch integration first, then trigger a fresh build, wait for the new artifact, create a new publish order when Lexiao prompts, and deploy from that new artifact. Only skip rebuild/redeploy when the user explicitly asks to check status only, verify only, or not rebuild.

For multiple apps, split the work into two phases: branch integration and build for all target apps first, then ordered deployment. Branch integration runs once. Build all target apps without waiting for earlier publish-order apps; then check all target build results and artifacts together. If any target build fails or remains ambiguous, stop before publish/deploy and diagnose that build. After every target build is `执行成功 / 制作成功`, process publish-order batches; apps with the same `发布顺序` can be deployed and verified concurrently when practical. Pause before the next publish-order batch when deployment fails, evidence is ambiguous, or new ERROR/Exception logs appear in the current batch.

1. Load the Lexiao version page and locate the exact target app row. For multiple apps, extract all target rows and record their `发布顺序`; sorting applies to deployment after the build phase, not to build triggering.
2. Branch integration:
   - Click `分支集成详情` / `分支集成` before build. Do not skip this step.
   - Capture the target project row: project name, branch, last commit, branch status, integration pipeline status, merge status, and CR status.
   - If `批量集成分支` is enabled, click it, confirm, and wait until the target project row is `已合并`, integration pipeline is `执行成功`, and merge status is `合入release成功` or `补丁合入release成功`.
   - If `批量集成分支` is disabled and the target row already shows the success statuses above, report it as "already integrated" and continue.
   - If the target row is not integrated but the button is disabled or missing, stop before build and report the blocker.
3. Build:
   - For one app, click only the target app row's `构建` button and confirm the build dialog.
   - For multiple apps, click each target app row's `构建` button first, without waiting for previous target apps to finish. Then poll the build API for all target apps together.
   - Do this even when the app row currently shows `已发布`, unless the user explicitly says not to rebuild.
   - Build is usually slow; poll `ci_pipeline_status_batch` about every 30 seconds, not high-frequency. Continue until every target `project_id` / `app_id` has `pipeline_status_desc=执行成功` and the pre-release artifact has `artifact_status_desc=制作成功`.
   - Record each target's Jenkins job URL and artifact status. If any build fails, use `jenkins-pipeline-fix` when appropriate, then stop before publish unless the user asked to auto-fix and rebuild.
4. Publish order:
   - Click only the target app row's `部署详情`.
   - If a dialog says `存在新制品，是否要创建新的发布单?`, choose `创建新发布单` after a fresh build unless the user explicitly asks to use the old order.
   - After creating a new order, re-query deployment details and use the new `publish_order_id`; do not keep polling or deploying a stale failed order.
   - Verify the publish order's `version_tag` matches the current target app row before clicking any machine deploy button.
5. Deploy exactly one pre-release target:
   - Prefer one VM/KVM row. Only choose a container target when no VM/KVM exists or the user explicitly asks for container.
   - Click only the selected machine row's `部署` button. Do not click `批量部署`.
   - After this one target is verified, stop and ask whether to continue to the next app or next machine. Do not continue automatically across apps.
6. Verification:
   - Poll Lexiao page/API for the selected machine while checking target-server diagnostics through `java-server-diagnostics`.
   - Treat Lexiao page/API publish status as auxiliary progress only. The deployment health conclusion must come primarily from target-server or container-instance logs observed during the deployment window.
   - Run version-local `stdout.log` checks and shared `error.log` checks in parallel.
7. Error triage and next choices:
   - If deployment or logs show blocking errors, identify the shortest causal chain and propose a concrete fix.
   - If deployment succeeds but deployment-time ERROR/Exception entries remain, classify them as blocking, non-blocking residual, or unrelated based on startup markers, machine run state, and log timing.
   - For multi-app sequences, do not start the next publish-order batch until this classification is complete for every app in the current batch and the batch is judged safe to proceed, or the user confirms continuing despite the residual risk.
   - End with explicit next-step choices when there is actionable code work:
     - `修复问题不提交`: modify code locally and verify, but do not commit/push.
     - `修复问题提交并重新部署`: modify code, verify, commit/push if requested/allowed, then repeat branch integration, build, publish-order creation, deploy, and log checks.
     - `不用下一步`: stop after reporting the current deployment and log evidence.

## Browser Session

Use `get-browser-session` as the session layer. Prefer the existing Lexiao browser tool:

```bash
node /home/joney/projects/ai/agent-tools/skills/backend-ops/get-browser-session/scripts/browser_session.js \
  --url=<lexiao-url> \
  --success-text=<target-app-name> \
  --login-pattern='Work Happy|QR Code|Use MOA|Account|登录|扫码|账号|密码|SSO|OAuth'
```

If the default profile under `~/.cache` cannot be locked or written, use a writable profile such as `/home/joney/.codex/lexiao-browser-profile`. If login is required, open a headed browser and ask the user to complete SSO/MOA in the browser; never ask for passwords, OTPs, cookies, or private keys in chat.

## Reusable Scripts

Use the bundled scripts for repeated Lexiao operations. Do not recreate temporary Playwright scripts for common tasks; if a new operation needs custom automation, add it to these scripts after the run.

Common commands:

```bash
node /home/joney/projects/ai/agent-tools/skills/backend-ops/lexiao-deploy/scripts/lexiao_project_env.js \
  --action=status \
  --url=<lexiao-related-demand-url> \
  --app=<app-name>

node /home/joney/projects/ai/agent-tools/skills/backend-ops/lexiao-deploy/scripts/lexiao_project_env.js \
  --action=deploy \
  --url=<lexiao-related-demand-url> \
  --app=<app-name>

node /home/joney/projects/ai/agent-tools/skills/backend-ops/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=list-apps \
  --url=<lexiao-url>

node /home/joney/projects/ai/agent-tools/skills/backend-ops/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=branch-integrate \
  --url=<lexiao-url>

node /home/joney/projects/ai/agent-tools/skills/backend-ops/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=build \
  --url=<lexiao-url> \
  --app=<app-name> \
  --app-id=<app-id> \
  --project-id=<project-id>

node /home/joney/projects/ai/agent-tools/skills/backend-ops/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=build-many \
  --url=<lexiao-url> \
  --apps=<app-name-1>,<app-name-2>

node /home/joney/projects/ai/agent-tools/skills/backend-ops/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=wait-build-many \
  --url=<lexiao-url> \
  --apps=<app-name-1>,<app-name-2> \
  --poll-ms=30000

node /home/joney/projects/ai/agent-tools/skills/backend-ops/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=open-order \
  --url=<lexiao-url> \
  --app=<app-name>

node /home/joney/projects/ai/agent-tools/skills/backend-ops/lexiao-deploy/scripts/lexiao_pre_release.js \
  --action=deploy-one \
  --url=<lexiao-url> \
  --app=<app-name> \
  --order-id=<publish-order-id> \
  --target-type=auto
```

For gray deployment, add `--env=gray`; gray skips branch integration and build, but still uses `list-apps`, `open-order`, `deploy-one`, and log verification.

For container instance logs, use the fixed webshell helper instead of writing a new script:

```bash
node /home/joney/projects/ai/agent-tools/skills/backend-ops/lexiao-deploy/scripts/webshell_log_check.js \
  --url=<login_pod_addr> \
  --app=<log-app-name>
```

`lexiao_pre_release.js --action=deploy-one` deploys one target only. It chooses VM/KVM first when `--target-type=auto`; use `--target-ip=<ip>` to pin a VM or `--target-type=container --deployment-id=<id>` for a container target.

## Project Environment Deploy

Prefer the fixed project-environment script over ad hoc Playwright snippets:

```bash
node /home/joney/projects/ai/agent-tools/skills/backend-ops/lexiao-deploy/scripts/lexiao_project_env.js \
  --action=status \
  --url=<lexiao-related-demand-url> \
  --app=<app-name> \
  --profile=/home/joney/.codex/lexiao-browser-profile

node /home/joney/projects/ai/agent-tools/skills/backend-ops/lexiao-deploy/scripts/lexiao_project_env.js \
  --action=deploy \
  --url=<lexiao-related-demand-url> \
  --app=<app-name> \
  --profile=/home/joney/.codex/lexiao-browser-profile \
  --build-timeout=1200000 \
  --deploy-timeout=1200000
```

Use `status` first to verify the script selected the exact app row. If the row is already `执行成功 / 制作成功 / 已发布` and the deploy button is disabled, report that there is no pending deployable artifact instead of clicking build or deploy. If the row is `执行中` or `制作中`, wait; if the deploy button becomes clickable with a red dot, `deploy` clicks only that row's `部署` button and confirms the one-click deployment dialog.

1. Load the Lexiao page and locate the exact target app row.
2. Treat a clickable `部署` button as a pending deployable artifact. Treat a disabled `部署` button as no deployable artifact unless the user explicitly says otherwise.
3. Before clicking, capture the row text and button states.
4. Click only the target row's `部署` button.
5. Confirm only if the dialog clearly asks for one-click deployment, e.g. `请确认是否进行一键部署操作?`.
6. Capture the immediate page/message feedback, such as `发布正在执行中...`.
7. Poll page state and Lexiao publish-status responses until one of these outcomes:
   - Success: target row is `已发布`, deploy button is disabled, red dot is gone, and API status is `PUBLISHED` or `need_show_deploy_red_dot=false`.
   - Failure: page/API reports failure, timeout, or rollback requirement.
   - Ambiguous: no stable status within the expected deploy window; report what was observed and keep checking only if requested.

Record `publish_order_id`, `version_publish_detail_id`, `publish_status_desc`, `publish_status`, and `publish_msg`.

## Pre-Release Single-Machine Deploy

Use this flow only for `预发布` and only for one machine unless the user explicitly asks otherwise. If the user says "部署机器" without choosing VM or container, prefer VM/KVM.

1. Load the Lexiao version page and locate the exact target app row.
2. Confirm build/artifact readiness from the row and `ci_pipeline_status_batch`:
   - pipeline status should be `执行成功`;
   - pre-release artifact status should be `制作成功`;
   - app row should show a deployable status such as `已打包`, `待推送`, or a recoverable `发布失败`.
3. Open only the target app row's `部署详情`.
4. If Lexiao prompts `存在新制品，是否要创建新的发布单?`, choose the correct order path:
   - after a fresh build, choose `创建新发布单` by default;
   - only choose `使用旧发布单` when the user explicitly requests it or no new artifact should be deployed;
   - after choosing, re-query deployment details and use the active/new `publish_order_id`.
5. Capture `publish_order_id`, `version_publish_detail_id`, `app_id`, `version_tag`, deployment type, and all visible deployment targets.
6. Select exactly one target:
   - If the user specified an IP, match that IP exactly.
   - Otherwise choose one VM/KVM row first, usually a row with `待推送`, `发布失败`, or another deployable status.
   - Only if no VM/KVM row exists, choose one container target.
   - For mixed deployment apps, do not deploy container nodes just because the page warns `预发布环境存在容器节点请请勿遗漏` when the user asked to deploy only one machine.
   - For multi-app requests, this one target completes the current app's default deployment scope. Verify it before marking that app done. Apps in the same publish-order batch can run in parallel; later publish-order batches must wait for current-batch log verification.
7. Click only the selected machine row's `部署` button. Do not click `批量部署`.
8. Confirm only if the visible dialog clearly confirms deployment for the selected pre-release target. Record the confirmation text.
9. Immediately start two checks in parallel:
   - Poll Lexiao page/API status for the selected machine as auxiliary progress.
   - Inspect the selected server through `java-server-diagnostics` read-only commands. Within log inspection, query version-local `logs/stdout.log` and shared `/home/product/logs/<app_name>_logs/error.log` in parallel; do not wait for one before checking the other.
   - For container deployments, use the page/API `login_pod_addr` or the visible `登录实例` entry to open the pod shell, then run read-only `ls`/`tail`/`grep` checks inside the instance. Do not conclude from container page status alone.

Useful Lexiao APIs observed on pre-release pages:

```text
GET /oa/publish/devops/deploymentOrder/getPublishDetails.json?version_id=<version_id>&order_id=<publish_order_id>&env=pre&app_type=java
GET /oa/publish/devops/deploymentOrder/getKVMPublishProgress.json?order_id=<publish_order_id>&env=pre
GET /oa/publish/devops/deploymentOrder/getPublishProgress.json?order_id=<publish_order_id>&env=pre
POST /oa/lexiao/get_version_publish_status.json
```

For VM/KVM, record from the selected machine row/API:

- `machine_ip`, `set`, `machine_status`
- `publish_status`, `publish_status_desc`, `publish_msg`, `publish_time`
- `pushed_num`, `published_num`, `roll_backed_num`, `total_replicas`

Pre-release outcome rules:

- Success: selected machine is published (`PUBLISHED`/`已发布` or equivalent), machine is running when the page exposes run state, and logs show startup success without new blocking errors.
- Failure: page/API reports `PUBLISH_FAIL`/`发布失败`, machine remains `STOP`, `publish_msg` reports timeout/failure, or version logs show Spring/Dubbo startup failure.
- Ambiguous: page/API is still running but logs show progress; report the latest page status and log evidence, then continue only if requested.
- Do not classify a publish as failed only because the publish log contains an old-stop message such as `ERROR: The <app> does not started!`; if the same publish log later shows `项目启动成功`, `Dubbo run OK!`, final `<version> has publish`, and the machine is `RUNNING/已发布`, treat the deploy itself as successful and report the old-stop line as non-blocking publish noise.

## Publish Log Verification

Parse the Lexiao `publish_msg` for deploy evidence:

- Version/path mode, entered app directory, current version, restart action.
- Old PID stopped and new PID started.
- Port read from `app_params.json`.
- Health check result and elapsed time.
- `Dubbo run OK!` or equivalent service-ready marker.
- Final publish marker such as `<branch> has publish`.

If publish logs show `项目启动成功` and `Dubbo run OK!`, this is strong deployment evidence, but still perform target-server log verification when access is available.

## Startup Time Reporting

For every successful deployment in any environment, the result must show the service startup time.

- Prefer target-server or container-instance startup logs, such as `init finished, cost=4759ms`, `init for ... duration=4760`, Spring/Dubbo startup elapsed time, or equivalent app-level startup markers.
- Use the Lexiao publish log health-check elapsed time, such as `项目启动成功,result:3,耗时 17 秒`, as fallback or cross-check evidence.
- If both server logs and publish logs expose startup time, report both and label the target-server value as primary.
- If startup time cannot be found after the available log checks, explicitly report `启动耗时：未在发布日志或服务器日志中找到` instead of omitting it.

## Unit Test And Artifact Verification

Open the target row's `流水线详情` and capture the latest task for the target `project_id` / `app_id`.

Required evidence:

- `ci_pipeline_status_batch`: `pipeline_status_desc=执行成功` and artifact status `制作成功`.
- `get_pipeline_task_list_by_version_demand_id`: latest `task_status_desc=执行成功`, `pipeline_task_id`, `job_url`, and unit-test metrics.

Default unit-test acceptance:

- 单测用例通过率 must be 100% unless the Lexiao redline says otherwise.
- 单测增量代码覆盖率 must be at least 90% unless the Lexiao redline says otherwise.
- Report all key metrics: all-line coverage, change-line coverage, change-branch coverage, change-method coverage, change-class coverage.

Do not call unit tests "达标" if the latest pipeline task is not successful, metrics are missing, or the observed metrics are below the applicable redline.

## Target Server Log Verification

Use `java-server-diagnostics` constraints: only inspect the target server through an approved bastion/jump path, and only run read-only diagnostic commands.

Default shared log directory:

```text
/home/product/logs/<app_name>_logs/
```

For VM/KVM deployment, inspect both log locations in parallel:

```text
/home/publish_product/server_java/<app_name>/<version_tag>/logs/
/home/product/logs/<app_name>_logs/error.log
```

For Java apps, startup failures may appear only in the version-local `stdout.log` while `/home/product/logs/<app_name>_logs/error.log` has no new entries. Treat version-local startup logs as primary startup evidence, but always check shared `error.log` concurrently for runtime/application errors.

For container deployment, inspect logs by logging into the instance. Prefer `/home/product/logs/<app_name>_logs/error.log`, `debug.log`, `info.log`, and any available startup/stdout log under the container. Container publish status in Lexiao is not sufficient evidence by itself; use it only to find the active pod, image/version, restart count, and login URL.

For project-environment, stable, test, or prj machines, always use the dev bastion path `dev.ssh.jumpserver.fenqile.cn` for target-server diagnostics. Do not try production bastion first. If the available tool cannot use the dev bastion path, record the server-diagnostics blocker and continue only with non-server evidence; never request the password in chat.

Minimum log checks:

```bash
ls /home/publish_product/server_java/<app_name>/<version_tag>/logs/
tail -240 /home/publish_product/server_java/<app_name>/<version_tag>/logs/stdout.log
grep -n -i 'WARNING\|ERROR\|Exception\|Throwable\|Caused by\|NoSuchBeanDefinitionException\|Dubbo run OK\|项目启动\|has publish' /home/publish_product/server_java/<app_name>/<version_tag>/logs/stdout.log | tail -120
ls /home/product/logs/<app_name>_logs/
tail -200 /home/product/logs/<app_name>_logs/error.log
grep -n -i 'Exception\|ERROR\|Throwable\|Caused by' /home/product/logs/<app_name>_logs/error.log | tail -50
tail -50 /home/product/logs/<app_name>_logs/debug.log
grep -n -i 'Started\|Dubbo\|<app_name>\|ERROR\|Exception\|Throwable\|Caused by' /home/product/logs/<app_name>_logs/debug.log | tail -80
```

Prefer a deployment-time window when possible. Deployment is healthy when the current log continues to refresh after deployment and there is no startup failure, crash loop, Dubbo startup failure, or sustained new exception. Page/API `已发布` is weaker than target-server evidence: if logs show a blocking startup/runtime failure, report the deployment as unhealthy even if the page says `已发布`. Report residual warnings explicitly instead of hiding them; recurring config warnings are not automatically deployment failures unless they block startup or the user task.

For ordered multi-app releases, treat any new deployment-window ERROR/Exception as a sequencing gate. Before continuing to the next app, compare with earlier/historical errors when possible, summarize why it is blocking or non-blocking, and state the proceed/stop decision explicitly.

When using tools that support parallel execution, run the version-local `stdout.log` commands and the shared `error.log` commands at the same time. If the results disagree, trust blocking startup evidence from `stdout.log` for deploy health, and report whether shared `error.log` had deployment-time entries.

When startup fails, summarize the shortest causal chain instead of pasting the whole stack. Example evidence to report:

```text
Spring context initialization failed:
beanA -> beanB
NoSuchBeanDefinitionException: ExampleService
```

When deployment succeeds but `error.log` contains deployment-time errors, classify and summarize them:

- Blocking: Spring context failure, process exit, Dubbo startup failure, health check timeout, crash loop, or the same error prevents the page from reaching `已发布`.
- Non-blocking residual: service starts and keeps running, publish log has ready markers, debug/main logs continue after deployment, and the error is a fallback/provider/config warning not preventing startup.
- Unknown: evidence conflicts or logs stop refreshing. State what is known and what additional check is needed.

For each blocking or unknown issue, provide a concise root-cause hypothesis, suggested code/config fix, and the next-step choices from `Full Pre-Release Redeploy Flow`.

## Final Report

Keep the final report short and evidence-based:

- What was deployed: app, branch, environment IP/GROUP, publish order.
- Single-machine scope when applicable: state that only one machine was deployed, and whether it was VM/KVM or container.
- Deployment result: page status, publish log markers, PID/port/health check if available.
- Startup time: mandatory for every successful deployment; include publish health-check elapsed time and app initialization duration when available.
- Unit-test result: latest pipeline ID/job URL, pass rate, key coverage metrics, whether it达标.
- Server-log result: checked version-local logs, shared `error.log`, container instance logs when applicable, time window, ERROR/Exception summary, and any residual warnings. Make this the primary health evidence; page status is secondary.
- Error triage: whether errors are blocking or non-blocking, shortest causal chain, and recommended fix when actionable.
- Proceed gate for multi-app deploys: whether it is safe to continue to the next publish-order app, and what evidence supports that decision.
- Next choices when actionable: `修复问题不提交`, `修复问题提交并重新部署`, or `不用下一步`.
- Any blocked checks and the exact reason, especially bastion or login constraints.

## Future Environment Extensions

Add separate sections before operating on higher environments:

- `灰度`: include batch/canary strategy, traffic validation, monitoring windows, and rollback criteria.
- `OA`: include approval gates, OA-specific health checks, and rollback criteria.
- `线上`: include release approval, blast-radius controls, monitoring dashboards, customer-impact checks, and rollback/stop conditions.

Do not infer these flows from project-environment behavior.
